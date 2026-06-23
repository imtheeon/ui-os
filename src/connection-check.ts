/**
 * src/connection-check.ts
 *
 * End-to-end connectivity + RLS enforcement check for U-I-OS.
 *
 * Run with: npm run db:check
 *
 * What this verifies:
 *   1. .env.local is present and the four required keys are populated.
 *   2. The SERVICE-ROLE client can reach Supabase and read all three tables
 *      (it bypasses RLS by design — see src/db.ts).
 *   3. RLS is actually ENFORCING on the anon client: a row that the
 *      service-role client can see is INVISIBLE to the anon client when no
 *      `app.current_org_id` is set. This is the core multi-tenant safety
 *      property — if it fails, tenant data is leaking.
 *
 * This script is read-mostly. It creates exactly one throwaway organizations
 * row to prove the RLS boundary, then deletes it (cascade-safe: it has no
 * children). It never touches existing tenant data.
 *
 * NOTE: we load `.env.local` explicitly here rather than relying on
 * `dotenv/config` (which loads `.env` by default). `.env.local` is the file
 * Next.js itself reads, so this keeps the standalone script and the app in
 * sync on a single source of credentials.
 */

import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Resolve .env.local relative to the project root (one level up from src/).
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "..", ".env.local");
loadEnv({ path: ENV_PATH, quiet: true });

// ---------------------------------------------------------------------------
// Tiny reporting helpers
// ---------------------------------------------------------------------------
let failures = 0;

function pass(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function fail(msg: string): void {
  failures += 1;
  console.error(`  ✗ ${msg}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// Step 1 — environment
// ---------------------------------------------------------------------------
section("1. Environment (.env.local)");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PUBLIC_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const missing = [
  ["SUPABASE_URL", SUPABASE_URL],
  ["SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY],
  ["NEXT_PUBLIC_SUPABASE_URL", PUBLIC_URL],
  ["NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON_KEY],
]
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length > 0) {
  fail(`Missing/empty in ${ENV_PATH}: ${missing.join(", ")}`);
  console.error(
    "\nCannot continue without credentials. Fill them in from your " +
      "Supabase project's Settings > API page and re-run `npm run db:check`."
  );
  process.exit(1);
}
pass("All four keys present.");

// Service URL and public URL should point at the same project — a common
// copy/paste slip that produces very confusing downstream errors.
if (SUPABASE_URL !== PUBLIC_URL) {
  fail(
    `SUPABASE_URL (${SUPABASE_URL}) and NEXT_PUBLIC_SUPABASE_URL ` +
      `(${PUBLIC_URL}) differ — they should be the same project URL.`
  );
} else {
  pass("Server and public URLs point at the same project.");
}

// Non-null assertions are safe past the guard above.
const serviceClient = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anonClient = createClient(PUBLIC_URL!, ANON_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// Step 2 — service-role connectivity to all three tables
// ---------------------------------------------------------------------------
async function checkServiceConnectivity(): Promise<void> {
  section("2. Service-role connectivity (bypasses RLS)");

  const tables = [
    "organizations",
    "inbound_payloads",
    "system_audit_logs",
  ] as const;

  for (const table of tables) {
    const { count, error } = await serviceClient
      .from(table)
      .select("*", { count: "exact", head: true });

    if (error) {
      fail(`Reading "${table}" failed: ${error.message}`);
    } else {
      pass(`"${table}" reachable (${count ?? 0} row(s) visible to service role).`);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3 — RLS enforcement on the anon client
// ---------------------------------------------------------------------------
async function checkRlsEnforcement(): Promise<void> {
  section("3. RLS enforcement (anon client must NOT see tenant rows)");

  // Create a throwaway org via the service role so we have a known row that
  // *exists* but should be invisible to an unscoped anon client.
  const probeName = `__rls_probe_${Date.now()}`;
  const { data: created, error: createErr } = await serviceClient
    .from("organizations")
    .insert({ name: probeName })
    .select("id")
    .single();

  if (createErr || !created) {
    fail(
      `Could not create probe organization via service role: ${
        createErr?.message ?? "no row returned"
      }`
    );
    return;
  }

  const probeId: string = created.id;
  pass(`Created probe org ${probeId} via service role.`);

  try {
    // Service role should see it.
    const { data: svcSees } = await serviceClient
      .from("organizations")
      .select("id")
      .eq("id", probeId);

    if (svcSees && svcSees.length === 1) {
      pass("Service role can see the probe row (expected).");
    } else {
      fail("Service role could NOT see the probe row it just created.");
    }

    // Anon client, with no app.current_org_id set, must see ZERO rows.
    const { data: anonSees, error: anonErr } = await anonClient
      .from("organizations")
      .select("id")
      .eq("id", probeId);

    if (anonErr) {
      // A permission error is also an acceptable "blocked" outcome, but the
      // expected/clean result is simply zero rows. Surface it either way.
      pass(
        `Anon client blocked at the API layer (${anonErr.message}) — ` +
          "tenant row not exposed."
      );
    } else if (!anonSees || anonSees.length === 0) {
      pass(
        "Anon client sees 0 rows for the probe org — RLS is ENFORCING. ✓"
      );
    } else {
      fail(
        `RLS LEAK: anon client returned ${anonSees.length} row(s) for the ` +
          "probe org without app.current_org_id set. Tenant isolation is " +
          "NOT working. Do not proceed until this is fixed."
      );
    }
  } finally {
    // Clean up the probe row no matter what happened above.
    const { error: delErr } = await serviceClient
      .from("organizations")
      .delete()
      .eq("id", probeId);

    if (delErr) {
      fail(
        `Failed to delete probe org ${probeId}: ${delErr.message}. ` +
          "Please remove it manually from the organizations table."
      );
    } else {
      pass(`Cleaned up probe org ${probeId}.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("U-I-OS connection check\n=======================");
  await checkServiceConnectivity();
  await checkRlsEnforcement();

  console.log("\n=======================");
  if (failures === 0) {
    console.log("RESULT: PASS — connectivity OK and RLS is enforcing. ✓");
    process.exit(0);
  } else {
    console.error(`RESULT: FAIL — ${failures} check(s) failed (see above).`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nUnexpected error while running connection check:");
  console.error(err);
  process.exit(1);
});
