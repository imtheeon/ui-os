/**
 * src/lib/agent-actions.ts — the typed action registry shared by the executor
 * and the agent handler. Defines WHICH action kinds exist and validates a
 * model-proposed payload for each. Validation is a SECURITY boundary: the LLM
 * supplies content; code decides whether it is a legal, bounded action of a
 * known kind before any row is ever written. Unknown kind / bad shape → reject.
 */
export const ACTION_KINDS = ["record_ledger_entry", "store_report", "flag_anomaly", "categorize_items"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

const MAX_STR = 2_000; // clamp every string field (DoS + bounded storage)
const MAX_AMOUNT_CENTS = 1_000_000_000_00; // $1B sanity ceiling

type Ok = { ok: true; kind: ActionKind; payload: Record<string, unknown> };
type Err = { ok: false; reason: string };

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, MAX_STR) : null;
}

export function validateProposal(kind: string, payload: unknown): Ok | Err {
  if (!(ACTION_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: `unknown_kind:${kind}` };
  }
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "payload_not_object" };
  }
  const p = payload as Record<string, unknown>;

  if (kind === "record_ledger_entry") {
    const description = str(p.description);
    const amount = typeof p.amount_cents === "number" ? Math.round(p.amount_cents) : NaN;
    const direction = p.direction === "debit" || p.direction === "credit" ? p.direction : null;
    if (!description) return { ok: false, reason: "missing_description" };
    if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT_CENTS) {
      return { ok: false, reason: "bad_amount_cents" };
    }
    if (!direction) return { ok: false, reason: "bad_direction" };
    const occurred_on = str(p.occurred_on); // optional ISO date string; stored as-is, validated by DB date cast
    return {
      ok: true,
      kind: "record_ledger_entry",
      payload: { description, amount_cents: amount, direction, occurred_on },
    };
  }

  if (kind === "flag_anomaly") {
    const description = str(p.description);
    const severity = p.severity === "low" || p.severity === "medium" || p.severity === "high" ? p.severity : null;
    const row_reference = str(p.row_reference);
    if (!description) return { ok: false, reason: "missing_description" };
    if (!severity) return { ok: false, reason: "bad_severity" };
    if (!row_reference) return { ok: false, reason: "missing_row_reference" };
    return { ok: true, kind: "flag_anomaly", payload: { description, severity, row_reference } };
  }

  if (kind === "categorize_items") {
    const scheme = str(p.scheme);
    if (!scheme) return { ok: false, reason: "missing_scheme" };
    if (!Array.isArray(p.assignments)) return { ok: false, reason: "assignments_not_array" };
    const MAX_ASSIGNMENTS = 50;
    const raw = (p.assignments as unknown[]).slice(0, MAX_ASSIGNMENTS);
    const assignments: { row_reference: string; category: string }[] = [];
    for (const a of raw) {
      if (typeof a !== "object" || a === null) continue;
      const rr = str((a as Record<string, unknown>).row_reference);
      const cat = str((a as Record<string, unknown>).category);
      if (rr && cat) assignments.push({ row_reference: rr, category: cat });
    }
    return { ok: true, kind: "categorize_items", payload: { scheme, assignments } };
  }

  // store_report
  const title = str(p.title);
  const body = str(p.body);
  if (!title) return { ok: false, reason: "missing_title" };
  if (!body) return { ok: false, reason: "missing_body" };
  return { ok: true, kind: "store_report", payload: { title, body } };
}
