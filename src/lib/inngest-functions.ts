/**
 * src/lib/inngest-functions.ts
 *
 * Inngest function handlers — one per UiEvent type.
 * These replace the switch cases in drainQueue().
 *
 * Each function receives the event, calls the existing handler,
 * and returns. Inngest handles retries, timeouts, and observability.
 */
import { inngest } from "./inngest";

export const handleUploadFinalized = inngest.createFunction(
  { id: "upload-finalized", retries: 3, triggers: { event: "upload/finalized" } },
  async ({ event }) => {
    const { scanUpload } = await import("./scan-upload");
    const { supabase: db } = await import("../db");
    await scanUpload(
      { orgId: event.data.orgId, payloadId: event.data.payloadId },
      { db }
    );
  }
);

export const handleUploadScanned = inngest.createFunction(
  { id: "upload-scanned", retries: 3, triggers: { event: "upload/scanned" } },
  async ({ event }) => {
    const { parseUpload } = await import("./parse-upload");
    const { supabase: db } = await import("../db");
    await parseUpload(
      { orgId: event.data.orgId, payloadId: event.data.payloadId },
      { db }
    );
  }
);

export const handlePayloadCompleted = inngest.createFunction(
  { id: "payload-completed", retries: 3, triggers: { event: "payload/completed" } },
  async ({ event }) => {
    const { routePayload } = await import("./manager");
    const { supabase: db } = await import("../db");
    const { enqueue } = await import("./queue");
    await routePayload(
      { orgId: event.data.orgId, payloadId: event.data.payloadId },
      { db, enqueue }
    );
  }
);

export const handleAgentRun = inngest.createFunction(
  {
    id: "agent-run",
    retries: 2,
    concurrency: { limit: 10 },
    triggers: { event: "agent/run" },
  },
  async ({ event }) => {
    const { runAgent } = await import("./run-agent");
    const { supabase: db } = await import("../db");
    await runAgent(
      {
        orgId: event.data.orgId,
        payloadId: event.data.payloadId,
        role: event.data.role,
      },
      { db }
    );
  }
);
