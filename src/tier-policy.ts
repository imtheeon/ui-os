/**
 * src/tier-policy.ts
 *
 * PURE tier policy for U-I-OS — the entitlement rules for the agent swarm.
 *
 * ────────────────────────────────────────────────────────────────────────
 * SECURITY INVARIANT: this module performs ZERO I/O and imports NOTHING that
 * can touch the network, the database, the filesystem, or any LLM/sandbox
 * SDK. It is a pure function of its inputs.
 *
 * Do NOT add imports of `@supabase/*`, `anthropic`, `openai`, `@e2b/*`,
 * `node:fs`, `node:net`, etc. to this file. The whole point of the gate is
 * that the code which DECIDES entitlement is structurally incapable of
 * spending money or leaking data — so a blocked request cannot possibly fire
 * an external API call from in here. Keep it pure; do the I/O in tier-gate.ts.
 * ────────────────────────────────────────────────────────────────────────
 */

// ===========================================================================
// Tiers (mirror organizations.subscription_tier CHECK in src/schema.sql)
// ===========================================================================
export type SubscriptionTier = "free" | "pro" | "enterprise";

/** Ordered rank — higher tier includes everything below it. */
export const TIER_RANK: Record<SubscriptionTier, number> = {
  free: 1,
  pro: 2,
  enterprise: 3,
};

// ===========================================================================
// Agent actions (capabilities the gate protects)
// ===========================================================================
export type AgentAction =
  | "ingest"
  | "categorize"
  | "reconcile"
  | "analyze_limited"
  | "forecast"
  | "analyze_full";

export interface ActionRule {
  /** Minimum subscription tier entitled to perform this action. */
  minTier: SubscriptionTier;
  /**
   * Internal capability description. Safe for server-side audit logs; NOT for
   * client response bodies (do not leak capability/tier mapping to clients).
   */
  description: string;
}

/**
 * The capability map. Each action requires `minTier` or higher.
 *
 * MVP mapping (loose, will tighten as the swarm lands):
 *   free  / Tier 1 → ingest + categorize        (Manager + Accountant)
 *   pro   / Tier 2 → + reconcile + analyze_limited (Analyst, limited compute)
 *   ent.  / Tier 3 → + forecast + analyze_full   (full Analyst capabilities)
 */
export const ACTION_POLICY: Record<AgentAction, ActionRule> = {
  ingest: {
    minTier: "free",
    description: "Ingest inbound payloads (Manager agent).",
  },
  categorize: {
    minTier: "free",
    description: "Basic categorization of payloads (Accountant agent).",
  },
  reconcile: {
    minTier: "pro",
    description: "Reconcile records against ingested data (Analyst agent).",
  },

  /**
   * analyze_limited — Tier 2 (pro).
   *
   * ⚠ CAPABILITY BOUNDARY — read before wiring an agent to this action:
   * STATIC, TEXT-BASED PARSING ONLY. No data-science compute. Specifically
   * NO Pandas, NO NumPy, and NO E2B sandbox code execution. This is the
   * deliberately cheap, deterministic tier of analysis. If an agent needs to
   * run real computation, it MUST use `analyze_full` instead (enterprise),
   * not smuggle compute in under this action.
   */
  analyze_limited: {
    minTier: "pro",
    description:
      "Static text-based parsing only — NO data science (no Pandas/NumPy), NO E2B sandbox execution.",
  },

  forecast: {
    minTier: "enterprise",
    description: "Financial forecasting (full Analyst capability).",
  },

  /**
   * analyze_full — Tier 3 (enterprise).
   *
   * This is where the real compute lives: full E2B sandboxed execution and
   * data-science libraries (Pandas/NumPy) are permitted here. This action is
   * the expensive one — it is exactly what the gate exists to protect.
   */
  analyze_full: {
    minTier: "enterprise",
    description:
      "Full E2B sandboxed compute / data science (Pandas, NumPy) — the expensive capability.",
  },
};

// ===========================================================================
// Agent → action capability map (documentation + future swarm wiring)
// ===========================================================================
export type AgentName = "manager" | "accountant" | "analyst";

export const AGENT_CAPABILITIES: Record<AgentName, AgentAction[]> = {
  manager: ["ingest"],
  accountant: ["categorize"],
  analyst: ["reconcile", "analyze_limited", "forecast", "analyze_full"],
};

// ===========================================================================
// Pure helpers
// ===========================================================================

/** True iff `value` is one of the three valid subscription tiers. */
export function isValidTier(value: unknown): value is SubscriptionTier {
  return (
    value === "free" || value === "pro" || value === "enterprise"
  );
}

/** Rank for a tier; 0 for anything invalid (used for fail-closed compares). */
export function tierRank(tier: unknown): number {
  return isValidTier(tier) ? TIER_RANK[tier] : 0;
}

/** Minimum tier entitled to `action`. */
export function minTierForAction(action: AgentAction): SubscriptionTier {
  return ACTION_POLICY[action].minTier;
}

/**
 * Pure entitlement check. NOTE: an unknown/invalid tier returns `false`
 * (fail-closed) — callers must treat "can't tell" as "not allowed".
 */
export function isActionAllowedForTier(
  tier: unknown,
  action: AgentAction
): boolean {
  return tierRank(tier) >= tierRank(minTierForAction(action));
}

// ===========================================================================
// Decision (INTERNAL) — carries tier detail for server-side audit only.
// Never serialize a TierDecision into a client response: the `currentTier`
// field would leak which plan the org is on. Convert to a TierRejection
// (below) for anything client-facing.
// ===========================================================================
export type TierDecision =
  | {
      kind: "allow";
      action: AgentAction;
      tier: SubscriptionTier;
      requiredTier: SubscriptionTier;
    }
  | {
      kind: "deny_not_entitled";
      action: AgentAction;
      currentTier: SubscriptionTier;
      requiredTier: SubscriptionTier;
    }
  | {
      kind: "deny_indeterminate";
      action: AgentAction;
      /** The raw, unrecognized tier value we read (or null if missing). */
      rawTier: string | null;
    };

/**
 * Pure decision function. Fails closed:
 *  - missing / unrecognized tier → `deny_indeterminate`
 *  - recognized but too low      → `deny_not_entitled`
 *  - recognized and sufficient   → `allow`
 */
export function evaluateTier(
  rawTier: string | null | undefined,
  action: AgentAction
): TierDecision {
  const requiredTier = minTierForAction(action);

  if (rawTier == null || !isValidTier(rawTier)) {
    return { kind: "deny_indeterminate", action, rawTier: rawTier ?? null };
  }

  if (tierRank(rawTier) >= tierRank(requiredTier)) {
    return { kind: "allow", action, tier: rawTier, requiredTier };
  }

  return { kind: "deny_not_entitled", action, currentTier: rawTier, requiredTier };
}

// ===========================================================================
// Public, client-safe result types
// ===========================================================================

/** Stable error codes — safe for client display / branching. */
export type TierRejectionCode = "TIER_NOT_ENTITLED" | "TIER_INDETERMINATE";

/**
 * Generic, client-safe rejection message. Deliberately reveals NEITHER the
 * org's current tier NOR which tier the feature needs — clients only learn
 * that they need "a higher tier". Tier detail stays in the audit log.
 */
export const TIER_REJECTION_MESSAGE =
  "This feature requires a higher U-I-OS subscription tier.";

/** Returned when the gate allows the action. */
export interface TierGrant {
  allowed: true;
  action: AgentAction;
  /** The org's tier (server-side only — caller decides whether to expose). */
  tier: SubscriptionTier;
}

/** Returned when the gate blocks the action. Safe to send in a 403 body. */
export interface TierRejection {
  allowed: false;
  code: TierRejectionCode;
  httpStatus: 403;
  action: AgentAction;
  /** Generic; see TIER_REJECTION_MESSAGE. Never contains tier info. */
  message: string;
}

export type TierResult = TierGrant | TierRejection;

/** Build a client-safe rejection. Carries no tier information by construction. */
export function makeTierRejection(
  code: TierRejectionCode,
  action: AgentAction
): TierRejection {
  return {
    allowed: false,
    code,
    httpStatus: 403,
    action,
    message: TIER_REJECTION_MESSAGE,
  };
}
