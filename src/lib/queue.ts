/**
 * src/lib/queue.ts — the async-work SEAM (NOT real Inngest yet).
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS (and is not), read before relying on it:
 *
 * This is a deliberately thin stand-in for a durable background-job runner
 * (Inngest, planned for Phase 6/9). It exists so the upload lifecycle —
 * scan (stage 4) → parse (stage 5) — can be built and verified as callable,
 * testable functions TODAY, without standing up a second local process.
 *
 *   • enqueue(event)        — producer choke point. Records an event and
 *                             returns IMMEDIATELY. It does NOT run handlers.
 *   • drainQueue(deps)      — the "worker". Runs pending events through their
 *                             handlers until the queue is empty. We call this
 *                             explicitly in tests / local flows.
 *
 * HONEST LIMITATION: the pending list is in-memory and PROCESS-LOCAL, and
 * work only advances when drainQueue() runs. In a deployed serverless route
 * nothing drains it, so an upload sits at 'processing' until a real runner
 * exists. That is the accepted "no durable orchestration yet" tradeoff — we
 * verify the logic now and back it with Inngest later.
 *
 * THE INNGEST SWAP (why this shape): when Inngest lands, `enqueue` becomes
 * `inngest.send(event)`, the handlers become registered Inngest functions,
 * and `drainQueue` + the in-memory list are DELETED — Inngest's runtime is
 * the drainer. Call sites (e.g. finalizeUpload) do not change.
 *
 * TRUST MODEL (preserved behind the seam): only trusted server code calls
 * enqueue (finalizeUpload is the sole producer of 'upload/finalized'), and
 * every event carries its orgId. Handlers NEVER re-derive tenant from client
 * input and still re-scope every DB read with .eq('org_id', orgId).
 * ════════════════════════════════════════════════════════════════════════
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** The events that move a payload through its post-finalize lifecycle. */
export type UiEvent =
  | { name: "upload/finalized"; data: { orgId: string; payloadId: string } }
  | { name: "upload/scanned"; data: { orgId: string; payloadId: string } }
  | { name: "payload/completed"; data: { orgId: string; payloadId: string } }
  | { name: "agent/run"; data: { orgId: string; payloadId: string; role: "accountant" | "analyst" } };

export interface DrainDeps {
  /** Service-role client handed to every handler. */
  db: SupabaseClient;
}

// Process-local pending queue. See HONEST LIMITATION above — this is not
// durable and does not survive a process restart or cross serverless invocations.
const pending: UiEvent[] = [];

/**
 * Record an event for asynchronous processing and return immediately.
 * Producer choke point — trusted server code only. Does NOT execute handlers
 * (that is drainQueue's job), so callers like finalizeUpload keep their fast,
 * synchronous contract (finalize → 'processing', nothing downstream runs inline).
 */
export function enqueue(event: UiEvent): void {
  pending.push(event);
}

/** Test/diagnostic helper: how many events are waiting. */
export function pendingCount(): number {
  return pending.length;
}

/** Test helper: drop any queued events (isolate test runs). */
export function resetQueue(): void {
  pending.length = 0;
}

/**
 * Drain the queue: route each pending event to its handler until empty.
 * Handlers may enqueue follow-on events (scan → 'upload/scanned', parse →
 * 'payload/completed', manager → 'agent/run'); those are picked up by later
 * iterations of this same loop, so a single drainQueue() call runs the chain.
 *
 * Handlers are imported lazily to keep this module free of an import-time
 * cycle (scan-upload.ts imports `enqueue` from here).
 */
export async function drainQueue(deps: DrainDeps): Promise<void> {
  while (pending.length > 0) {
    const event = pending.shift()!;
    switch (event.name) {
      case "upload/finalized": {
        const { scanUpload } = await import("./scan-upload");
        await scanUpload(event.data, { db: deps.db });
        break;
      }
      case "upload/scanned": {
        const { parseUpload } = await import("./parse-upload");
        await parseUpload(event.data, { db: deps.db });
        break;
      }
      case "payload/completed": {
        const { routePayload } = await import("./manager");
        await routePayload(event.data, { db: deps.db, enqueue });
        break;
      }
      case "agent/run": {
        const { runAgent } = await import("./run-agent");
        await runAgent(event.data, { db: deps.db });
        break;
      }
    }
  }
}
