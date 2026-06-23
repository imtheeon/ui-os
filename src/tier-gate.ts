/**
 * src/tier-gate.ts
 *
 * The "bouncer": requireTierForAction() — the enforcement point that sits in
 * FRONT of every expensive agent action. It reads the org's subscription tier
 * (service-role, server-trusted), applies the pure policy in tier-policy.ts,
 * and on a block records the rejection and returns a generic 403 result.
 *
 * ────────────────────────────────────────────────────────────────────────
 * SECURITY PROPERTIES
 *
 * 1. CANNOT SPEND. This module imports only a TYPE from @supabase/supabase-js
 *    plus the pure tier-policy. No Anthropic SDK, no E2B SDK, no agent code.
 *    The decision to allow/deny is reached without any capacity to call an
 *    LLM or sandbox — so a blocked request provably fires $0 of external API
 *    calls from the gate itself. The agent (the only thing that spends) runs
 *    only AFTER this returns `{ allowed: true }`, in the caller.
 *
 * 2. orgId COMES FROM THE SESSION. `params.orgId` MUST be derived from the
 *    authenticated server-side session — NEVER from the request body, query
 *    string, or any client-supplied value. Passing client-controlled orgId
 *    here would defeat tenant isolation. The gate trusts its caller on this
 *    single point; everything downstream depends on it.
 *
 * 3. FAILS CLOSED. Missing org, unknown/corrupt tier, or a DB error never
 *    yields `allowed: true`. The only path to allow is an explicit, valid,
 *    sufficient tier (see evaluateTier in tier-policy.ts).
 * ────────────────────────────────────────────────────────────────────────
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type AgentAction,
  type TierDecision,
  type TierRejectionCode,
  type TierResult,
  evaluateTier,
  makeTierRejection,
  minTierForAction,
} from "./tier-policy";

export interface RequireTierParams {
  /**
   * The tenant's organization id.
   *
   * ⚠ MUST be derived from the authenticated session server-side. NEVER pass
   * a value taken from the request body / query / headers / client input.
   */
  orgId: string;

  /** The capability being attempted (gates the expensive agent work). */
  action: AgentAction;

  /**
   * Optional inbound payload this action is processing. If provided AND the
   * org is not entitled, the payload is stamped 'blocked_unauthorized_tier'
   * so there is a durable record of the rejected request.
   */
  payloadId?: string;
}

export interface TierGateDeps {
  /**
   * Service-role Supabase client (bypasses RLS — server-trusted only). The
   * gate looks up org tier and writes audit/payload rows across tenants, so
   * it requires the service role. Defaults to the shared client in db.ts.
   */
  db: SupabaseClient;
}

/**
 * Gate an action behind the org's subscription tier.
 *
 * On allow: returns `{ allowed: true, action, tier }` — caller proceeds to run
 * the agent. On block: records the rejection (see order below) and returns a
 * generic, tier-free `TierRejection` (safe to put in a 403 response body).
 *
 * Block side-effects, in order, for a genuine entitlement block:
 *   1. UPDATE inbound_payloads.status = 'blocked_unauthorized_tier' (if payloadId)
 *   2. INSERT system_audit_logs (action='tier.block') with full internal detail
 *   3. return the public TierRejection
 *
 * For an INDETERMINATE block (missing org / corrupt tier / lookup error), step
 * 1 is skipped — 'blocked_unauthorized_tier' specifically means "tier not
 * entitled", which we cannot assert here. Step 2 still runs (when an org row
 * exists to reference), with code='TIER_INDETERMINATE'.
 */
export async function requireTierForAction(
  params: RequireTierParams,
  deps?: Partial<TierGateDeps>
): Promise<TierResult> {
  const { orgId, action, payloadId } = params;

  // Lazy default keeps tier-gate decoupled from db.ts's import-time env guard,
  // so verification scripts (which inject their own client) don't trip it.
  const db: SupabaseClient = deps?.db ?? (await import("./db")).supabase;

  // ── Look up the org's tier (service-role; trusted path) ──────────────────
  let rawTier: string | null = null;
  let lookupError: string | null = null;
  try {
    const { data, error } = await db
      .from("organizations")
      .select("subscription_tier")
      .eq("id", orgId)
      .maybeSingle();
    if (error) {
      lookupError = error.message;
    } else {
      rawTier = (data?.subscription_tier as string | undefined) ?? null;
    }
  } catch (e) {
    lookupError = e instanceof Error ? e.message : String(e);
  }

  // ── Pure decision (fail-closed). A lookup error => treat tier as unknown. ─
  const decision = evaluateTier(lookupError ? null : rawTier, action);

  if (decision.kind === "allow") {
    return { allowed: true, action: decision.action, tier: decision.tier };
  }

  const code: TierRejectionCode =
    decision.kind === "deny_not_entitled"
      ? "TIER_NOT_ENTITLED"
      : "TIER_INDETERMINATE";

  // (1) Stamp the payload ONLY for a genuine entitlement block.
  if (decision.kind === "deny_not_entitled" && payloadId) {
    await stampPayloadBlocked(db, orgId, payloadId);
  }

  // (2) Append-only audit row carrying the full internal detail.
  await writeTierBlockAudit(db, orgId, code, decision, payloadId, lookupError);

  // (3) Generic, tier-free rejection — never leaks which tier the org is on.
  return makeTierRejection(code, action);
}

// ===========================================================================
// Side-effect helpers — best-effort. A failure here must NEVER flip the gate
// to "allow": the denial is already decided. We log and move on.
// ===========================================================================

/** Mark the payload as rejected-for-tier, scoped to its org for safety. */
async function stampPayloadBlocked(
  db: SupabaseClient,
  orgId: string,
  payloadId: string
): Promise<void> {
  const { error } = await db
    .from("inbound_payloads")
    .update({ status: "blocked_unauthorized_tier" })
    .eq("id", payloadId)
    .eq("org_id", orgId); // never touch another tenant's payload
  if (error) {
    console.error(
      `[tier-gate] failed to stamp payload ${payloadId} blocked: ${error.message}`
    );
  }
}

/**
 * Write the immutable 'tier.block' audit entry. The org's tier detail lives
 * here (internal ledger), NOT in the client response. If the org row doesn't
 * exist (indeterminate / not-found), this insert may fail the FK — that's
 * fine, we log it and still return the denial.
 */
async function writeTierBlockAudit(
  db: SupabaseClient,
  orgId: string,
  code: TierRejectionCode,
  decision: Exclude<TierDecision, { kind: "allow" }>,
  payloadId: string | undefined,
  lookupError: string | null
): Promise<void> {
  const log_meta: Record<string, unknown> = {
    code,
    action: decision.action,
    requiredTier: minTierForAction(decision.action),
    payloadId: payloadId ?? null,
  };

  if (decision.kind === "deny_not_entitled") {
    log_meta.currentTier = decision.currentTier;
  } else {
    log_meta.rawTier = decision.rawTier;
  }
  if (lookupError) log_meta.lookupError = lookupError;

  const { error } = await db.from("system_audit_logs").insert({
    org_id: orgId,
    action: "tier.block",
    log_meta,
  });
  if (error) {
    console.error(
      `[tier-gate] failed to write tier.block audit for org ${orgId}: ${error.message}`
    );
  }
}
