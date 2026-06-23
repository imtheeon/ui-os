/**
 * src/check-login.ts
 *
 * Verifies the identity chokepoint end-to-end against the live database:
 * programmatically sign a real user in, then prove resolveOrgFromSession
 * returns their correct org_id — and returns null on every failure path.
 * Run with: npm run check:login
 *
 * Loads .env.local explicitly and injects its own service-role client into
 * the resolver via deps (same pattern as the other check:* scripts).
 */

import { createClient, type SupabaseClient, type Session } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { resolveOrgFromSession } from "./lib/resolveOrgFromSession";

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
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  console.error("Missing env in .env.local. Run `npm run db:check` first.");
  process.exit(1);
}

const service: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
// Anon client used purely to perform a real password sign-in.
const anon: SupabaseClient = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main(): Promise<void> {
  console.log("U-I-OS login / resolver check\n=============================");

  const stamp = Date.now();
  const email = `login_test_${stamp}@example.com`;
  const password = `Pw_${stamp}_aZ!`;
  const orgName = `__login_test_${stamp}`;
  let userId: string | null = null;

  // Provision a pre-confirmed user (trigger creates org + profile).
  const { data: created, error: createErr } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { org_name: orgName },
  });
  if (createErr || !created?.user) {
    console.error(`createUser failed: ${createErr?.message ?? "no user"}`);
    process.exit(1);
  }
  userId = created.user.id;
  pass(`Created confirmed test user ${userId}.`);

  // The org_id the trigger assigned — the expected resolver output.
  const { data: profile, error: profErr } = await service
    .from("profiles").select("org_id").eq("id", userId).single();
  if (profErr || !profile) {
    console.error(`Could not read expected profile: ${profErr?.message}`);
    await service.auth.admin.deleteUser(userId);
    process.exit(1);
  }
  const expectedOrgId: string = profile.org_id;
  pass(`Expected org_id = ${expectedOrgId}.`);

  try {
    // ── POSITIVE: real sign-in → resolver returns the right org_id ───────
    section("1. POSITIVE — sign in, resolve org from the real session");
    const { data: signIn, error: signErr } = await anon.auth.signInWithPassword({
      email, password,
    });
    check(!signErr && !!signIn.session, "signInWithPassword returned a session");
    const session = signIn.session;
    const resolved = await resolveOrgFromSession(session, { db: service });
    check(resolved === expectedOrgId, `resolver returned expected org_id (got ${resolved})`);

    // ── NEGATIVE 1: null session → null ──────────────────────────────────
    section("2. NEGATIVE — null session");
    const r2 = await resolveOrgFromSession(null, { db: service });
    check(r2 === null, `null session → null (got ${r2})`);

    // ── NEGATIVE 2: garbage access token → null ──────────────────────────
    section("3. NEGATIVE — forged/garbage access token");
    const fake = { access_token: "garbage.not-a-real.jwt" } as unknown as Session;
    const r3 = await resolveOrgFromSession(fake, { db: service });
    check(r3 === null, `garbage token → null (got ${r3})`);

    // ── NEGATIVE 3: valid token, but no profile row → null ───────────────
    section("4. NEGATIVE — valid token but profile row deleted");
    const { error: delProfErr } = await service.from("profiles").delete().eq("id", userId);
    check(!delProfErr, "deleted the profile row (setup for no-profile case)");
    const r4 = await resolveOrgFromSession(session, { db: service });
    check(r4 === null, `verified user with no profile → null (got ${r4})`);
  } finally {
    section("5. Cleanup");
    const { error: delErr } = await service.auth.admin.deleteUser(userId);
    if (delErr) fail(`Failed to delete test user ${userId}: ${delErr.message}`);
    else pass(`Deleted test user ${userId}.`);
    console.log(
      `  ℹ Test org "${orgName}" + its org.created audit row remain by design (audit immutability).`
    );
  }

  console.log("\n=============================");
  if (failures === 0) {
    console.log("RESULT: PASS — resolver maps a verified session → correct org_id, fails closed otherwise. ✓");
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
