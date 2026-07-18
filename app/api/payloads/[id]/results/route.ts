/**
 * GET /api/payloads/[id]/results
 * Returns all agent runs and proposed actions for a payload.
 * Scoped to the authenticated org.
 *
 * Response 200: { payloadId, agentRuns: Array, proposedActions: Array }
 * Response 401: { error: "Unauthorized" }
 * Response 404: { error: "Not found" }
 *
 * NOTE ON FIELD MAPPING: agent_runs has no latency_ms column — latency is
 * derived here from finished_at - created_at (null while still running).
 * proposed_actions' payload column is named action_payload in the DB; it is
 * aliased to `payload` in the select so the response shape matches the
 * documented API contract without renaming the underlying column.
 */
import { type NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { supabaseServer } from "@/src/lib/supabaseServer";
import { resolveOrgFromSession } from "@/src/lib/resolveOrgFromSession";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // 1. Auth
  const sbClient = await supabaseServer();
  const {
    data: { session },
  } = await sbClient.auth.getSession();
  const orgId = await resolveOrgFromSession(session);
  if (!orgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: payloadId } = await params;

  // 2. Verify the payload belongs to this org
  const { supabase: db } = await import("@/src/db");
  const { data: payload, error: payloadErr } = await db
    .from("inbound_payloads")
    .select("id")
    .eq("id", payloadId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (payloadErr) {
    Sentry.captureException(payloadErr);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
  if (!payload) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // 3. Fetch agent runs (ORG-SCOPED)
  const { data: agentRuns, error: runsErr } = await db
    .from("agent_runs")
    .select("id, role, status, created_at, finished_at")
    .eq("payload_id", payloadId)
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });

  if (runsErr) {
    Sentry.captureException(runsErr);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  const agentRunsWithLatency = (agentRuns ?? []).map((run) => {
    const { finished_at, ...rest } = run as Record<string, unknown> & {
      created_at: string;
      finished_at: string | null;
    };
    const latencyMs =
      finished_at != null
        ? new Date(finished_at).getTime() - new Date(rest.created_at as string).getTime()
        : null;
    return { ...rest, latency_ms: latencyMs };
  });

  // 4. Fetch proposed actions (ORG-SCOPED). action_payload aliased to `payload`.
  const { data: proposedActions, error: actionsErr } = await db
    .from("proposed_actions")
    .select("id, kind, payload:action_payload, status, agent_run_id, created_at")
    .eq("payload_id", payloadId)
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });

  if (actionsErr) {
    Sentry.captureException(actionsErr);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  return NextResponse.json(
    {
      payloadId,
      agentRuns: agentRunsWithLatency,
      proposedActions: proposedActions ?? [],
    },
    { status: 200 }
  );
}
