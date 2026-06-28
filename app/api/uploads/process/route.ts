/**
 * POST /api/uploads/process
 *
 * MVP RUNNER STAND-IN (temporary). Drains the process-local event queue so a
 * just-finalized upload actually moves through scan → parse. This is the worker
 * that the seam's drainQueue() was built for, invoked from a request.
 *
 * HONEST CAVEATS (see src/lib/queue.ts):
 *  - PROCESS-LOCAL + in-memory: drains only what THIS server process has
 *    pending; does nothing for events on another instance. NOT reliable across
 *    serverless instances.
 *  - Drains the SHARED queue, not just this caller's payload — safe because
 *    every handler re-scopes by the org_id carried inside its own event, so an
 *    event is always processed for its true owner regardless of who drained.
 *  - DELETED when a real runner (Inngest) lands; enqueue() call sites unchanged.
 *
 * Auth: requires a valid session — must not be callable unauthenticated even
 * though it only drains. No body; org_id never comes from the client.
 */
import { supabaseServer } from "../../../../src/lib/supabaseServer";
import { resolveOrgFromSession } from "../../../../src/lib/resolveOrgFromSession";
import { drainQueue } from "../../../../src/lib/queue";
import { supabase as serviceClient } from "../../../../src/db";

export async function POST(): Promise<Response> {
  const supabase = await supabaseServer();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const orgId = await resolveOrgFromSession(session);
  if (!orgId) return Response.json({ error: "unauthorized" }, { status: 401 });

  // Run the worker. Handlers re-scope by the org_id inside each event, so the
  // shared-queue drain is safe; orgId here only gates access.
  await drainQueue({ db: serviceClient });

  return Response.json({ ok: true }, { status: 200 });
}
