/**
 * src/lib/agent-actions.ts — the typed action registry shared by the executor
 * and the agent handler. Defines WHICH action kinds exist and validates a
 * model-proposed payload for each. Validation is a SECURITY boundary: the LLM
 * supplies content; code decides whether it is a legal, bounded action of a
 * known kind before any row is ever written. Unknown kind / bad shape → reject.
 */
export const ACTION_KINDS = ["record_ledger_entry", "store_report"] as const;
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

  // store_report
  const title = str(p.title);
  const body = str(p.body);
  if (!title) return { ok: false, reason: "missing_title" };
  if (!body) return { ok: false, reason: "missing_body" };
  return { ok: true, kind: "store_report", payload: { title, body } };
}
