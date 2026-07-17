/**
 * src/check-live-smoke.ts
 *
 * Smoke test: runs one real Anthropic API call through the agent pipeline.
 * Uses stubBrain=false, real ANTHROPIC_API_KEY, minimal CSV data.
 * Costs < $0.01 per run (Haiku model).
 *
 * Run with: npx tsx src/check-live-smoke.ts (or npm run check:smoke)
 * Skips automatically if ANTHROPIC_API_KEY is not set.
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "..", ".env.local"), quiet: true });

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("SKIP: ANTHROPIC_API_KEY not set — skipping live smoke test.");
  process.exit(0);
}

// Use a known Haiku agent (anomaly_detector is the simplest foundation agent).
const TEST_ORG_ID = process.env.SMOKE_TEST_ORG_ID;
const TEST_PAYLOAD_ID = process.env.SMOKE_TEST_PAYLOAD_ID;

if (!TEST_ORG_ID || !TEST_PAYLOAD_ID) {
  console.log(
    "SKIP: SMOKE_TEST_ORG_ID and SMOKE_TEST_PAYLOAD_ID not set.\n" +
      "Set these in .env.local to a real org and completed payload to run the smoke test."
  );
  process.exit(0);
}

// Import after env is loaded (agent-brain's claudeBrain lazy-imports the SDK too).
const { runAgent } = await import("./lib/run-agent");
const { supabase: db } = await import("./db");
const TEST_ROLE: import("./lib/agent-brain").LLMRole = "anomaly_detector";

console.log(`Running live smoke test: ${TEST_ROLE} on payload ${TEST_PAYLOAD_ID}`);
try {
  const result = await runAgent(
    { orgId: TEST_ORG_ID, payloadId: TEST_PAYLOAD_ID, role: TEST_ROLE },
    { db }
  );
  if (!result.ok) {
    console.error("✗ Smoke test failed:", JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log("✓ Smoke test passed:", JSON.stringify(result, null, 2));
  process.exit(0);
} catch (err) {
  console.error("✗ Smoke test failed:", err);
  process.exit(1);
}
