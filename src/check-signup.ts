/**
 * src/check-signup.ts
 *
 * Verifies migration 0002 (auth profiles + atomic signup) against the live
 * database. Run with: npm run check:signup
 *
 * What it does:
 *   1. Creates a real test user via the Auth admin API (service role). This
 *      INSERTs into auth.users, which fires the handle_new_user() trigger.
 *   2. Asserts the trigger provisioned, in one atomic step:
 *        - an organizations row named from the signup metadata,
 *        - a profiles row linking user -> org with role 'owner',
 *        - a system_audit_logs 'org.created' entry.
 *   3. Asserts RLS on profiles: an unauthenticated anon client sees 0 rows.
 *   4. Deletes the test user (cascades the profile). The test ORG and its
 *      AUDIT row intentionally remain — the audit-immutability trigger blocks
 *      deleting them via cascade. They are clearly named "__signup_test_*".
 *
 * Loads .env.local explicitly (see src/connection-check.ts for why).
 */

import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "..", ".env.local"), quiet: true });

let failures = 0;
const pass = (m: string) => console.log(`  ✓ ${m}`);
const fail = (m: string) => {
  failures += 1;
  console.error(`  ✗ ${m}`);
};
const section = (t: string) => console.log(`\n${t}`);

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PUBLIC_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !PUBLIC_URL || !ANON_KEY) {
  console.error(
    "Missing env in .env.local. Run `npm run db:check` first to diagnose."
  );
  process.exit(1);
}

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anon = createClient(PUBLIC_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main(): Promise<void> {
  console.log("U-I-OS signup-trigger check\n===========================");

  const stamp = Date.now();
  const email = `signup_test_${stamp}@example.com`;
  const orgName = `__signup_test_${stamp}`;
  let userId: string | null = null;

  section("1. Provision a user via Auth admin API (fires the trigger)");
  const { data: created, error: createErr } = await service.auth.admin.createUser({
    email,
    password: `Pw_${stamp}_aZ!`,
    email_confirm: true,
    user_metadata: { org_name: orgName },
  });

  if (createErr || !created?.user) {
    fail(`createUser failed: ${createErr?.message ?? "no user returned"}`);
    console.error(
      "\nIf this says the trigger errored, the migration may not be applied " +
        "yet. Paste src/migrations/0002_auth_profiles.sql into the Supabase " +
        "SQL editor and re-run."
    );
    process.exit(1);
  }
  userId = created.user.id;
  pass(`Created auth user ${userId} (${email}).`);

  try {
    section("2. Trigger provisioned org + profile + audit (atomic)");

    // profiles row
    const { data: profile, error: profErr } = await service
      .from("profiles")
      .select("id, org_id, role")
      .eq("id", userId)
      .single();

    if (profErr || !profile) {
      fail(`No profile row for the new user: ${profErr?.message ?? "missing"}`);
    } else {
      pass(`profiles row exists (role="${profile.role}").`);
      if (profile.role !== "owner") fail(`Expected role "owner", got "${profile.role}".`);

      // organization row, named from metadata
      const { data: org, error: orgErr } = await service
        .from("organizations")
        .select("id, name")
        .eq("id", profile.org_id)
        .single();

      if (orgErr || !org) {
        fail(`No organization ${profile.org_id}: ${orgErr?.message ?? "missing"}`);
      } else if (org.name !== orgName) {
        fail(`Org name "${org.name}" != signup metadata "${orgName}".`);
      } else {
        pass(`organizations row exists, name matches signup metadata.`);
      }

      // audit entry
      const { data: audits, error: auditErr } = await service
        .from("system_audit_logs")
        .select("action, log_meta")
        .eq("org_id", profile.org_id)
        .eq("action", "org.created");

      if (auditErr) {
        fail(`Audit query failed: ${auditErr.message}`);
      } else if (!audits || audits.length === 0) {
        fail(`No 'org.created' audit row for the new org.`);
      } else {
        pass(`system_audit_logs 'org.created' entry written.`);
      }
    }

    section("3. RLS: unauthenticated anon client cannot read profiles");
    const { data: anonProfiles, error: anonErr } = await anon
      .from("profiles")
      .select("id")
      .eq("id", userId);

    if (anonErr) {
      pass(`Anon blocked at API layer (${anonErr.message}).`);
    } else if (!anonProfiles || anonProfiles.length === 0) {
      pass(`Anon client sees 0 profile rows — RLS enforcing.`);
    } else {
      fail(`RLS LEAK: anon client read ${anonProfiles.length} profile row(s).`);
    }
  } finally {
    section("4. Cleanup");
    const { error: delErr } = await service.auth.admin.deleteUser(userId);
    if (delErr) {
      fail(`Failed to delete test user ${userId}: ${delErr.message}.`);
    } else {
      pass(`Deleted test user ${userId} (profile cascaded).`);
    }
    console.log(
      `  ℹ Test org "${orgName}" and its audit row remain by design ` +
        `(audit ledger is immutable; cascade-delete is blocked).`
    );
  }

  console.log("\n===========================");
  if (failures === 0) {
    console.log("RESULT: PASS — atomic signup works and profiles RLS holds. ✓");
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
