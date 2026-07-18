/**
 * GET /api/payloads/[id]
 * Returns the status of a specific payload (polling endpoint).
 * Scoped to the authenticated org — other orgs' payloads return 404.
 *
 * Response 200: { id, status, scan_status, source, created_at, size_bytes, original_filename }
 * Response 401: { error: "Unauthorized" }
 * Response 404: { error: "Not found" }
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

  // 2. Fetch (ORG-SCOPED — other orgs' rows return null → 404)
  const { supabase: db } = await import("@/src/db");
  const { data, error } = await db
    .from("inbound_payloads")
    .select("id, status, scan_status, source, created_at, size_bytes, original_filename")
    .eq("id", payloadId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) {
    Sentry.captureException(error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(data, { status: 200 });
}
