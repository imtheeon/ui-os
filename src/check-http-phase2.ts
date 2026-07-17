/**
 * src/check-http-phase2.ts
 *
 * Live HTTP negative tests for Phase 2 routes.
 * Tests that all new routes fail closed when unauthenticated.
 *
 * Requires dev server: npm run dev
 * Run with: npx tsx src/check-http-phase2.ts
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "..", ".env.local"), quiet: true });

const BASE = process.env.HTTP_TEST_BASE ?? "http://localhost:3000";
const FAKE_UUID = "00000000-0000-0000-0000-000000000000";

let failures = 0;
const pass = (m: string) => console.log(`  ✓ ${m}`);
const fail = (m: string) => { failures++; console.error(`  ✗ ${m}`); };
const section = (t: string) => console.log(`\n${t}`);

async function expect(
  label: string,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    expectedStatus: number;
  }
): Promise<void> {
  const { method = "GET", headers = {}, body, expectedStatus } = options;
  const reqHeaders: Record<string, string> = { ...headers };
  if (body !== undefined) reqHeaders["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: reqHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    fail(`${label}: request failed — is dev server up at ${BASE}? (${(e as Error).message})`);
    return;
  }

  const text = await res.text();
  if (res.status === expectedStatus) {
    pass(`${label} → ${expectedStatus} (${text.slice(0, 60)})`);
  } else {
    fail(`${label} → expected ${expectedStatus}, got ${res.status} (${text.slice(0, 120)})`);
  }
}

async function main(): Promise<void> {
  console.log("U-I-OS Phase 2 live HTTP negative check\n========================================");
  console.log(`  base: ${BASE}`);

  section("1. /api/payloads/[id] — auth required");
  await expect("GET no session", `/api/payloads/${FAKE_UUID}`, { expectedStatus: 401 });

  section("2. /api/payloads/[id]/results — auth required");
  await expect("GET no session", `/api/payloads/${FAKE_UUID}/results`, { expectedStatus: 401 });

  section("3. /api/org/api-keys — auth required");
  await expect("GET no session", "/api/org/api-keys", { expectedStatus: 401 });
  await expect("POST no session", "/api/org/api-keys", {
    method: "POST",
    body: { name: "test" },
    expectedStatus: 401,
  });
  await expect("DELETE no session", `/api/org/api-keys?keyId=${FAKE_UUID}`, {
    method: "DELETE",
    expectedStatus: 401,
  });

  section("4. /api/ingest/webhook — API key required");
  await expect("POST no auth header", "/api/ingest/webhook", {
    method: "POST",
    body: { test: true },
    expectedStatus: 401,
  });
  await expect("POST bad bearer key", "/api/ingest/webhook", {
    method: "POST",
    headers: { authorization: "Bearer uios_wh_thisisnotarealkey1234567890abcdefghijklmnopq" },
    body: { test: true },
    expectedStatus: 401,
  });
  await expect("POST non-bearer auth", "/api/ingest/webhook", {
    method: "POST",
    headers: { authorization: "Basic dXNlcjpwYXNz" },
    body: { test: true },
    expectedStatus: 401,
  });

  section("5. /api/ingest/email — signature required");
  await expect("POST no svix headers", "/api/ingest/email", {
    method: "POST",
    body: { type: "email.received", data: {} },
    expectedStatus: 401,
  });

  console.log("\n========================================");
  if (failures === 0) {
    console.log("RESULT: PASS — all Phase 2 routes fail closed when unauthenticated. ✓");
    process.exit(0);
  } else {
    console.error(`RESULT: FAIL — ${failures} check(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nUnexpected error:", err);
  process.exit(1);
});
