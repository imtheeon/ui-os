/**
 * src/lib/executor.ts — the ONLY code in U-I-OS that writes a record from a
 * proposed action. The agent code path MUST NOT import this module: that hard
 * boundary is what the human approval gate relies on (an agent can only write
 * status='pending'; effects happen here, behind the gate, in a different code
 * path called only by the authed approve route).
 *
 * INTERNAL RECORDS ONLY (Phase 6). External money/records (Stripe/QuickBooks/
 * bank) are deferred to Phase 7+, behind this same registry.
 *
 * org_id is CODE-OWNED: every insert uses deps.orgId (resolved from the
 * session by the caller), never anything from action_payload.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { validateProposal } from "./agent-actions";

type ApplyOk = { ok: true; recordTable: string; recordId: string };
type ApplyErr = { ok: false; code: string; message: string };

export async function applyAction(
  action: { id: string; org_id: string; payload_id: string; kind: string; action_payload: Record<string, unknown> },
  deps: { db: SupabaseClient; orgId: string }
): Promise<ApplyOk | ApplyErr> {
  const { db, orgId } = deps;
  // Defense-in-depth: the caller loaded this row scoped to the session org, so
  // these must already match. Assert anyway — identity is code-owned.
  if (action.org_id !== orgId) {
    return { ok: false, code: "ORG_MISMATCH", message: "action does not belong to caller org" };
  }
  // Re-validate at apply time — never trust a stored payload blindly.
  const v = validateProposal(action.kind, action.action_payload);
  if (!v.ok) return { ok: false, code: "INVALID_ACTION", message: v.reason };

  if (v.kind === "record_ledger_entry") {
    const { data, error } = await db
      .from("ledger_entries")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        description: v.payload.description,
        amount_cents: v.payload.amount_cents,
        direction: v.payload.direction,
        occurred_on: v.payload.occurred_on ?? null,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "ledger_entries", recordId: data.id as string };
  }

  if (v.kind === "flag_anomaly") {
    const { data, error } = await db
      .from("flagged_anomalies")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        description: v.payload.description,
        severity: v.payload.severity,
        row_reference: v.payload.row_reference,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "flagged_anomalies", recordId: data.id as string };
  }

  const { data, error } = await db
    .from("analyst_reports")
    .insert({
      org_id: orgId, // CODE-OWNED
      payload_id: action.payload_id,
      proposed_action_id: action.id,
      title: v.payload.title,
      body: v.payload.body,
    })
    .select("id")
    .single();
  if (error) return { ok: false, code: "DB_ERROR", message: error.message };
  return { ok: true, recordTable: "analyst_reports", recordId: data.id as string };
}
