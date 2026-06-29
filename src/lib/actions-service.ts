/**
 * src/lib/actions-service.ts — the human approval gate. approveAction performs
 * the ONLY pending→approved transition and is the ONLY caller of the executor.
 * All reads/writes are org-scoped; org_id always comes from the caller (the
 * authed route resolved it from the session), never the request body.
 *
 * Idempotency: the pending→approved flip is a conditional update guarded by
 * .eq('status','pending'); a concurrent double-approve updates 0 rows and does
 * NOT execute a second time.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyAction } from "./executor";

async function getDb(deps?: { db?: SupabaseClient }): Promise<SupabaseClient> {
  return deps?.db ?? (await import("../db")).supabase;
}

export async function listPending(
  orgId: string, deps?: { db?: SupabaseClient }
): Promise<{ id: string; kind: string; rationale: string; action_payload: Record<string, unknown>; created_at: string }[]> {
  const db = await getDb(deps);
  const { data } = await db
    .from("proposed_actions")
    .select("id, kind, rationale, action_payload, created_at")
    .eq("org_id", orgId).eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(100);
  return (data ?? []) as never;
}

export async function approveAction(
  orgId: string, actionId: string, decidedBy: string, deps?: { db?: SupabaseClient }
): Promise<{ ok: true; recordTable: string } | { ok: false; code: string }> {
  const db = await getDb(deps);

  // Load the pending action, ORG-SCOPED. Miss = wrong org / already decided / gone.
  const { data: action, error } = await db
    .from("proposed_actions")
    .select("id, org_id, payload_id, kind, action_payload, status")
    .eq("id", actionId).eq("org_id", orgId).eq("status", "pending").maybeSingle();
  if (error) return { ok: false, code: "DB_ERROR" };
  if (!action) return { ok: false, code: "NOT_FOUND" };

  // Conditional flip pending→approved (optimistic guard against double-approve).
  const { data: flipped, error: flipErr } = await db
    .from("proposed_actions")
    .update({ status: "approved", decided_by: decidedBy, decided_at: new Date().toISOString() })
    .eq("id", actionId).eq("org_id", orgId).eq("status", "pending")
    .select("id");
  if (flipErr) return { ok: false, code: "DB_ERROR" };
  if (!flipped || flipped.length === 0) return { ok: false, code: "NOT_FOUND" }; // lost the race → already decided

  await db.from("system_audit_logs").insert({
    org_id: orgId, action: "action.approved", log_meta: { actionId, decidedBy },
  });

  // Apply via the executor (the ONLY record-writer). org_id is code-owned.
  const applied = await applyAction(
    { id: action.id as string, org_id: action.org_id as string, payload_id: action.payload_id as string,
      kind: action.kind as string, action_payload: action.action_payload as Record<string, unknown> },
    { db, orgId }
  );
  if (!applied.ok) {
    await db.from("proposed_actions").update({ status: "apply_failed" }).eq("id", actionId).eq("org_id", orgId);
    await db.from("system_audit_logs").insert({
      org_id: orgId, action: "action.apply_failed", log_meta: { actionId, code: applied.code },
    });
    return { ok: false, code: applied.code };
  }
  await db.from("proposed_actions").update({ status: "applied", applied_at: new Date().toISOString() })
    .eq("id", actionId).eq("org_id", orgId);
  await db.from("system_audit_logs").insert({
    org_id: orgId, action: "action.applied", log_meta: { actionId, recordTable: applied.recordTable, recordId: applied.recordId },
  });
  return { ok: true, recordTable: applied.recordTable };
}

export async function rejectAction(
  orgId: string, actionId: string, decidedBy: string, deps?: { db?: SupabaseClient }
): Promise<{ ok: true } | { ok: false; code: string }> {
  const db = await getDb(deps);
  const { data: flipped, error } = await db
    .from("proposed_actions")
    .update({ status: "rejected", decided_by: decidedBy, decided_at: new Date().toISOString() })
    .eq("id", actionId).eq("org_id", orgId).eq("status", "pending")
    .select("id");
  if (error) return { ok: false, code: "DB_ERROR" };
  if (!flipped || flipped.length === 0) return { ok: false, code: "NOT_FOUND" };
  await db.from("system_audit_logs").insert({
    org_id: orgId, action: "action.rejected", log_meta: { actionId, decidedBy },
  });
  return { ok: true };
}
