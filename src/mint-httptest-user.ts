/**
 * src/mint-httptest-user.ts  (dev utility — not part of the test suite)
 *
 * Mints a PRE-CONFIRMED auth user via the admin API so we can do a live
 * browser login→dashboard→upload round-trip WITHOUT toggling the project-wide
 * "Confirm email" setting off. Because it INSERTs into auth.users, it fires the
 * real handle_new_user() trigger → real org + profile(owner) + 'org.created'
 * audit, exactly like a true signup.
 *
 * Run with:  npx tsx src/mint-httptest-user.ts
 * Prints the email + password to log in with. The org is named "__httptest_*"
 * so it's identifiable among the other undeletable test orgs.
 */

import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "..", ".env.local"), quiet: true });

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing service-role env in .env.local. Run `npm run db:check` first.");
  process.exit(1);
}

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main(): Promise<void> {
  const stamp = Date.now();
  const email = `httptest_${stamp}@example.com`;
  const password = `Pw_${stamp}_aZ!`;
  const orgName = `__httptest_${stamp}`;

  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // pre-confirmed → can log in immediately
    user_metadata: { org_name: orgName },
  });

  if (error || !data?.user) {
    console.error(`createUser failed: ${error?.message ?? "no user returned"}`);
    process.exit(1);
  }

  // Confirm the trigger provisioned the org + profile.
  const { data: profile } = await service
    .from("profiles")
    .select("org_id, role")
    .eq("id", data.user.id)
    .single();

  console.log("\n=== U-I-OS live HTTP test user (PRE-CONFIRMED) ===");
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
  console.log(`  user_id:  ${data.user.id}`);
  console.log(`  org_id:   ${profile?.org_id ?? "(profile not found — trigger issue?)"}`);
  console.log(`  org_name: ${orgName}  (role=${profile?.role ?? "?"})`);
  console.log("==================================================");
  console.log("Log in at http://localhost:3000/login with the email/password above.\n");
}

main().catch((err) => {
  console.error("\nUnexpected error:");
  console.error(err);
  process.exit(1);
});
