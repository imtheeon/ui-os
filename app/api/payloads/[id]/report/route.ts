/**
 * /api/payloads/[id]/report
 *
 * POST — trigger PDF report generation for a completed payload. Runs
 * generateReport() inline (MVP; swap for an Inngest 'report/generate' event
 * later, same call site). If recipientEmail is given, emails the PDF too.
 *
 * GET — return the most recent report for this payload, with a short-lived
 * signed download URL when ready.
 *
 * Both handlers follow the standard trust chain: session -> resolveOrgFromSession
 * (verified) -> trusted org_id -> every query scoped with .eq("org_id", orgId).
 */
import { type NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/src/lib/supabaseServer";
import { resolveOrgFromSession } from "@/src/lib/resolveOrgFromSession";
import { generateReport, REPORTS_BUCKET } from "@/src/lib/report-generator";
import { emailReport } from "@/src/lib/email-report";

const SIGNED_URL_TTL_SECONDS = 300;

export async function POST(
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

  let body: { title?: string; recipientEmail?: string } = {};
  try {
    body = await req.json();
  } catch {
    // no body is fine — defaults apply
  }
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "CFO Analysis Report";
  const recipientEmail = typeof body.recipientEmail === "string" && body.recipientEmail.trim() ? body.recipientEmail.trim() : undefined;

  const { supabase: db } = await import("@/src/db");

  // 2. Verify the payload exists, belongs to this org, and is completed
  const { data: payload, error: payloadErr } = await db
    .from("inbound_payloads")
    .select("id, status")
    .eq("id", payloadId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (payloadErr) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
  if (!payload) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (payload.status !== "completed") {
    return NextResponse.json({ error: "Payload is not completed yet" }, { status: 400 });
  }

  // 3. Create the reports row
  const { data: report, error: insertErr } = await db
    .from("reports")
    .insert({
      org_id: orgId,
      payload_id: payloadId,
      title,
      status: "generating",
      recipient_email: recipientEmail ?? null,
    })
    .select("id")
    .single();

  if (insertErr || !report) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  const reportId = report.id as string;

  // 4. Gather agent runs + proposed actions (ORG-SCOPED, same shape as /results)
  const [{ data: agentRuns, error: runsErr }, { data: proposedActions, error: actionsErr }] =
    await Promise.all([
      db
        .from("agent_runs")
        .select("role, status, created_at")
        .eq("payload_id", payloadId)
        .eq("org_id", orgId)
        .order("created_at", { ascending: true }),
      db
        .from("proposed_actions")
        .select("kind, payload:action_payload, created_at")
        .eq("payload_id", payloadId)
        .eq("org_id", orgId)
        .order("created_at", { ascending: true }),
    ]);

  if (runsErr || actionsErr) {
    await db.from("reports").update({ status: "failed" }).eq("id", reportId).eq("org_id", orgId);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  // 5. Generate (MVP: inline/synchronous)
  const result = await generateReport(
    {
      orgId,
      payloadId,
      reportId,
      title,
      agentRuns: agentRuns ?? [],
      proposedActions: proposedActions ?? [],
    },
    { db }
  );

  // 6. Optional: email the PDF
  if (result.ok && recipientEmail && result.storagePath) {
    const { data: orgRow } = await db.from("organizations").select("name").eq("id", orgId).maybeSingle();
    const { data: pdfBlob, error: downloadErr } = await db.storage
      .from(REPORTS_BUCKET)
      .download(result.storagePath);

    if (!downloadErr && pdfBlob) {
      const pdfBuffer = Buffer.from(await pdfBlob.arrayBuffer());
      const emailResult = await emailReport({
        to: recipientEmail,
        orgName: (orgRow?.name as string | undefined) ?? "your organization",
        reportTitle: title,
        pdfBuffer,
      });
      if (emailResult.ok) {
        await db
          .from("reports")
          .update({ emailed_at: new Date().toISOString() })
          .eq("id", reportId)
          .eq("org_id", orgId);
      }
    }
  }

  return NextResponse.json({ reportId, ok: result.ok, error: result.error }, { status: result.ok ? 200 : 500 });
}

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

  const { supabase: db } = await import("@/src/db");

  // 2. Most recent report for this payload (ORG-SCOPED)
  const { data: report, error } = await db
    .from("reports")
    .select("id, title, status, storage_path, recipient_email, emailed_at, created_at")
    .eq("payload_id", payloadId)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
  if (!report) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let downloadUrl: string | undefined;
  if (report.status === "ready" && report.storage_path) {
    const { data: signed } = await db.storage
      .from(REPORTS_BUCKET)
      .createSignedUrl(report.storage_path as string, SIGNED_URL_TTL_SECONDS);
    downloadUrl = signed?.signedUrl;
  }

  return NextResponse.json({ ...report, downloadUrl }, { status: 200 });
}
