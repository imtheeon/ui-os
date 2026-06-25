/**
 * src/check-http-negative.ts
 *
 * LIVE HTTP test — NEGATIVE half (automatable; no valid session needed).
 *
 * Proves the upload routes fail closed over REAL HTTP + cookies — the layer the
 * check:* scripts skip by injecting a service-role client directly. We hit the
 * running dev server's /api/uploads/* endpoints with:
 *   (a) NO cookie at all, and
 *   (b) a GARBAGE auth cookie under Supabase's real cookie name,
 * and assert both get 401 unauthorized. This exercises:
 *   supabaseServer() → getSession() → resolveOrgFromSession() → 401
 *
 * Requires the dev server running:  npm run dev   (http://localhost:3000)
 * Run with:                         npx tsx src/check-http-negative.ts
 */

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "..", ".env.local"), quiet: true });

const BASE = process.env.HTTP_TEST_BASE ?? "http://localhost:3000";

// Derive Supabase's real cookie name (sb-<project-ref>-auth-token) so the
// garbage-cookie case actually drives the session parser, not a no-op name.
const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ref = publicUrl.replace(/^https?:\/\//, "").split(".")[0] || "unknown";
const AUTH_COOKIE = `sb-${ref}-auth-token`;

let failures = 0;
const pass = (m: string) => console.log(`  ✓ ${m}`);
const fail = (m: string) => {
  failures += 1;
  console.error(`  ✗ ${m}`);
};
const section = (t: string) => console.log(`\n${t}`);

async function expect401(
  label: string,
  path: string,
  cookie: string | null,
  body: unknown
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers["cookie"] = cookie;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    fail(`${label}: request failed — is the dev server up at ${BASE}? (${(e as Error).message})`);
    return;
  }
  const text = await res.text();
  if (res.status === 401) {
    pass(`${label} → 401 (${text.slice(0, 60)})`);
  } else {
    fail(`${label} → expected 401, got ${res.status} (${text.slice(0, 120)})`);
  }
}

async function main(): Promise<void> {
  console.log("U-I-OS live HTTP negative check\n===============================");
  console.log(`  base:        ${BASE}`);
  console.log(`  auth cookie: ${AUTH_COOKIE}`);

  section("1. /api/uploads/slot — no session");
  await expect401("slot, no cookie", "/api/uploads/slot", null, {
    filename: "x.csv",
    contentType: "text/csv",
    size: 10,
  });
  await expect401("slot, garbage cookie", "/api/uploads/slot", `${AUTH_COOKIE}=not-a-real-session`, {
    filename: "x.csv",
    contentType: "text/csv",
    size: 10,
  });

  section("2. /api/uploads/finalize — no session");
  await expect401("finalize, no cookie", "/api/uploads/finalize", null, {
    payloadId: "00000000-0000-0000-0000-000000000000",
  });
  await expect401(
    "finalize, garbage cookie",
    "/api/uploads/finalize",
    `${AUTH_COOKIE}=not-a-real-session`,
    { payloadId: "00000000-0000-0000-0000-000000000000" }
  );

  console.log("\n===============================");
  if (failures === 0) {
    console.log("RESULT: PASS — both routes fail closed (401) over real HTTP without a valid session. ✓");
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
