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
import { extractMemory, type MemoryUpsert } from "./memory-extractor";

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

async function upsertMemoryApproved(
  db: SupabaseClient, orgId: string, extracts: MemoryUpsert[]
): Promise<void> {
  for (const mu of extracts) {
    const { data: existing } = await db.from("org_memory")
      .select("id, confidence_score, times_confirmed")
      .eq("org_id", orgId).eq("memory_type", mu.memory_type).eq("memory_key", mu.memory_key)
      .maybeSingle();
    if (existing) {
      await db.from("org_memory").update({
        confidence_score: Math.min(1.0, (existing.confidence_score as number) + 0.1),
        times_confirmed: (existing.times_confirmed as number) + 1,
        last_confirmed_at: new Date().toISOString(),
        memory_value: mu.memory_value,
      }).eq("id", existing.id as string).eq("org_id", orgId);
    } else {
      await db.from("org_memory").insert({
        org_id: orgId,
        memory_type: mu.memory_type,
        memory_key: mu.memory_key,
        memory_value: mu.memory_value,
        confidence_score: 0.6,
        times_confirmed: 1,
        source_agent: mu.source_agent,
        proposed_action_id: mu.proposed_action_id,
      });
    }
  }
}

async function downgradeMemoryRejected(
  db: SupabaseClient, orgId: string, extracts: MemoryUpsert[]
): Promise<void> {
  for (const mu of extracts) {
    const { data: existing } = await db.from("org_memory")
      .select("id, confidence_score, times_rejected")
      .eq("org_id", orgId).eq("memory_type", mu.memory_type).eq("memory_key", mu.memory_key)
      .maybeSingle();
    if (existing) {
      await db.from("org_memory").update({
        confidence_score: Math.max(0.0, (existing.confidence_score as number) - 0.2),
        times_rejected: (existing.times_rejected as number) + 1,
      }).eq("id", existing.id as string).eq("org_id", orgId);
    }
  }
}

async function upsertAccuracy(
  db: SupabaseClient, orgId: string, agentRole: string,
  outcome: "approved" | "rejected"
): Promise<void> {
  const { data: existing } = await db.from("agent_accuracy")
    .select("id, total_proposals, approved_count, rejected_count")
    .eq("org_id", orgId).eq("agent_role", agentRole).maybeSingle();
  if (existing) {
    await db.from("agent_accuracy").update({
      total_proposals: (existing.total_proposals as number) + 1,
      approved_count: outcome === "approved"
        ? (existing.approved_count as number) + 1
        : existing.approved_count as number,
      rejected_count: outcome === "rejected"
        ? (existing.rejected_count as number) + 1
        : existing.rejected_count as number,
      last_updated: new Date().toISOString(),
    }).eq("id", existing.id as string).eq("org_id", orgId);
  } else {
    await db.from("agent_accuracy").insert({
      org_id: orgId,
      agent_role: agentRole,
      total_proposals: 1,
      approved_count: outcome === "approved" ? 1 : 0,
      rejected_count: outcome === "rejected" ? 1 : 0,
    });
  }
}

export async function approveAction(
  orgId: string, actionId: string, decidedBy: string, deps?: { db?: SupabaseClient }
): Promise<{ ok: true; recordTable: string } | { ok: false; code: string }> {
  const db = await getDb(deps);

  // Load the pending action with agent role, ORG-SCOPED.
  const { data: action, error } = await db
    .from("proposed_actions")
    .select("id, org_id, payload_id, kind, action_payload, status, agent_runs(role)")
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
  if (!flipped || flipped.length === 0) return { ok: false, code: "NOT_FOUND" };

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
    org_id: orgId, action: "action.applied",
    log_meta: { actionId, recordTable: applied.recordTable, recordId: applied.recordId },
  });

  // Update memory and accuracy (fire-and-forget on failure — never block the approval).
  try {
    const agentRuns = action.agent_runs as { role?: string } | null;
    const agentRole = agentRuns?.role ?? null;
    const extracts = extractMemory(
      { id: action.id as string, kind: action.kind as string,
        action_payload: action.action_payload as Record<string, unknown> },
      agentRole ?? "unknown"
    );
    await Promise.all([
      upsertMemoryApproved(db, orgId, extracts),
      agentRole ? upsertAccuracy(db, orgId, agentRole, "approved") : Promise.resolve(),
    ]);
  } catch {
    // Memory/accuracy failures must not block the approval.
  }

  return { ok: true, recordTable: applied.recordTable };
}

export async function rejectAction(
  orgId: string, actionId: string, decidedBy: string, deps?: { db?: SupabaseClient }
): Promise<{ ok: true } | { ok: false; code: string }> {
  const db = await getDb(deps);

  // Load the pending action with agent role first (needed for memory/accuracy updates).
  const { data: action, error: loadErr } = await db
    .from("proposed_actions")
    .select("id, kind, action_payload, agent_runs(role)")
    .eq("id", actionId).eq("org_id", orgId).eq("status", "pending").maybeSingle();
  if (loadErr) return { ok: false, code: "DB_ERROR" };
  if (!action) return { ok: false, code: "NOT_FOUND" };

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

  // Downgrade memory and update accuracy.
  try {
    const agentRuns = action.agent_runs as { role?: string } | null;
    const agentRole = agentRuns?.role ?? null;
    const extracts = extractMemory(
      { id: action.id as string, kind: action.kind as string,
        action_payload: action.action_payload as Record<string, unknown> },
      agentRole ?? "unknown"
    );
    await Promise.all([
      downgradeMemoryRejected(db, orgId, extracts),
      agentRole ? upsertAccuracy(db, orgId, agentRole, "rejected") : Promise.resolve(),
    ]);
  } catch {
    // Memory/accuracy failures must not block the rejection.
  }

  return { ok: true };
}
