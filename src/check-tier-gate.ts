/**
 * src/check-tier-gate.ts
 *
 * Verifies the Phase 3 tier gate against the live database, and proves the
 * core guarantee: a not-entitled request fires $0 of external API calls.
 * Run with: npm run check:tier
 *
 * The "spy" stands in for anything that would call an LLM or E2B sandbox.
 * The realistic handler shape is: gate first, then run the agent ONLY if the
 * gate allows. So spy.calls === 0 after a block means nothing downstream was
 * ever reached — no spend.
 *
 * Loads .env.local explicitly (same pattern as check-signup.ts) and injects
 * its own service-role client into the gate via the deps parameter.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { requireTierForAction } from "./tier-gate";
import type { TierResult } from "./tier-policy";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "..", ".env.local"), quiet: true });

let failures = 0;
const pass = (m: string) => console.log(`  ✓ ${m}`);
const fail = (m: string) => {
  failures += 1;
  console.error(`  ✗ ${m}`);
};
const check = (cond: boolean, label: string) => (cond ? pass(label) : fail(label));
const section = (t: string) => console.log(`\n${t}`);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing service-role env in .env.local. Run `npm run db:check` first.");
  process.exit(1);
}

const service: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Stand-in for any LLM / E2B call. The only thing here that could "spend". */
function makeSpy() {
  return {
    calls: 0,
    run(this: { calls: number }) {
      this.calls += 1;
    },
  };
}

/** Realistic handler: gate first; run the agent (spy) ONLY if allowed. */
async function runGated(
  orgId: string,
  action: Parameters<typeof requireTierForAction>[0]["action"],
  payloadId: string | undefined,
  spy: { calls: number; run: () => void }
): Promise<TierResult> {
  const result = await requireTierForAction({ orgId, action, payloadId }, { db: service });
  if (result.allowed) spy.run();
  return result;
}

async function createPayload(orgId: string, tag: string): Promise<string> {
  const { data, error } = await service
    .from("inbound_payloads")
    .insert({
      org_id: orgId,
      email_message_id: `tier_test_${tag}_${Date.now()}_${randomUUID()}`,
      raw_content: "tier-gate test payload",
      status: "pending",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`createPayload(${tag}) failed: ${error?.message}`);
  return data.id;
}

async function main(): Promise<void> {
  console.log("U-I-OS tier-gate check\n======================");

  const stamp = Date.now();
  // Free-tier org (subscription_tier defaults to 'free' in the schema).
  const { data: org, error: orgErr } = await service
    .from("organizations")
    .insert({ name: `__tier_test_${stamp}` })
    .select("id, subscription_tier")
    .single();
  if (orgErr || !org) {
    console.error(`Could not create test org: ${orgErr?.message}`);
    process.exit(1);
  }
  const orgId: string = org.id;
  check(org.subscription_tier === "free", `Test org created on '${org.subscription_tier}' tier.`);

  const payloadNeg = await createPayload(orgId, "neg");
  const payloadPos = await createPayload(orgId, "pos");
  pass(`Created two pending payloads (neg=${payloadNeg.slice(0, 8)}, pos=${payloadPos.slice(0, 8)}).`);

  try {
    // ── NEGATIVE: enterprise-only action on a free org ───────────────────
    section("1. NEGATIVE — free org attempts 'forecast' (enterprise-only)");
    const spyNeg = makeSpy();
    const neg = await runGated(orgId, "forecast", payloadNeg, spyNeg);

    check(neg.allowed === false, "result.allowed === false");
    if (!neg.allowed) {
      check(neg.code === "TIER_NOT_ENTITLED", `result.code === 'TIER_NOT_ENTITLED' (got '${neg.code}')`);
      check(neg.httpStatus === 403, "result.httpStatus === 403");
      const leak = /\b(free|pro|enterprise)\b|tier\s*[123]/i;
      check(!leak.test(neg.message), `message leaks no tier info ("${neg.message}")`);
    }
    check(spyNeg.calls === 0, `spy.calls === 0  ← $0 external spend (got ${spyNeg.calls})`);

    const { data: pNeg } = await service
      .from("inbound_payloads").select("status").eq("id", payloadNeg).single();
    check(
      pNeg?.status === "blocked_unauthorized_tier",
      `payload stamped 'blocked_unauthorized_tier' (got '${pNeg?.status}')`
    );

    const { data: audits } = await service
      .from("system_audit_logs")
      .select("action, log_meta")
      .eq("org_id", orgId)
      .eq("action", "tier.block");
    const blockRow = (audits ?? []).find(
      (r) => (r.log_meta as Record<string, unknown> | null)?.code === "TIER_NOT_ENTITLED"
    );
    check(!!blockRow, "tier.block audit row exists (code=TIER_NOT_ENTITLED)");
    if (blockRow) {
      const m = blockRow.log_meta as Record<string, unknown>;
      check(m.currentTier === "free", `audit log_meta.currentTier === 'free' (got '${m.currentTier}')`);
      check(m.requiredTier === "enterprise", `audit log_meta.requiredTier === 'enterprise' (got '${m.requiredTier}')`);
    }

    // ── POSITIVE: free-allowed action on the same free org ───────────────
    section("2. POSITIVE — same free org runs 'categorize' (free-allowed)");
    const spyPos = makeSpy();
    const pos = await runGated(orgId, "categorize", payloadPos, spyPos);

    check(pos.allowed === true, "result.allowed === true");
    check(spyPos.calls === 1, `spy ran → spy.calls === 1 (got ${spyPos.calls})`);
    const { data: pPos } = await service
      .from("inbound_payloads").select("status").eq("id", payloadPos).single();
    check(
      pPos?.status !== "blocked_unauthorized_tier",
      `allowed action left payload unstamped (status='${pPos?.status}')`
    );

    // ── INDETERMINATE: unknown org id ────────────────────────────────────
    section("3. INDETERMINATE — gate called with a nonexistent orgId");
    const spyInd = makeSpy();
    const ind = await runGated(randomUUID(), "forecast", undefined, spyInd);
    check(ind.allowed === false, "result.allowed === false");
    if (!ind.allowed) {
      check(ind.code === "TIER_INDETERMINATE", `result.code === 'TIER_INDETERMINATE' (got '${ind.code}')`);
    }
    check(spyInd.calls === 0, `spy.calls === 0 (got ${spyInd.calls})`);
  } finally {
    section("4. Cleanup");
    const { error: dNeg } = await service.from("inbound_payloads").delete().eq("id", payloadNeg);
    const { error: dPos } = await service.from("inbound_payloads").delete().eq("id", payloadPos);
    if (dNeg || dPos) fail(`payload cleanup error: ${dNeg?.message ?? ""} ${dPos?.message ?? ""}`);
    else pass("Deleted both test payloads.");
    console.log(
      `  ℹ Test org "__tier_test_${stamp}" and its tier.block audit row remain by design (audit immutability).`
    );
  }

  console.log("\n======================");
  if (failures === 0) {
    console.log("RESULT: PASS — tier gate blocks unentitled actions with $0 spend, allows entitled ones. ✓");
    process.exit(0);
  } else {
    console.error(`RESULT: FAIL — ${failures} check(s) failed (see above).`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nUnexpected error:");
  console.error(err);
  process.exit(1);
});
