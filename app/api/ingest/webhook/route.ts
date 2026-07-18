/**
 * POST /api/ingest/webhook
 * Receives a structured JSON payload from an external automation tool
 * (Zapier, Make, direct API call) and queues it for agent processing.
 *
 * Auth: Authorization: Bearer <uios_wh_...> API key
 * Optional: X-Webhook-Ref header for idempotency (deduplication)
 *
 * Request body: any JSON object
 * Response 202: { payloadId }
 * Response 401: { error: "Unauthorized" }
 * Response 409: { error: "Duplicate", payloadId } — if webhook_ref already seen
 * Response 4xx: { error: <message> }
 */
import { type NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { extractBearerKey, verifyApiKey } from "@/src/lib/api-key";
import { enqueue } from "@/src/lib/queue";

export async function POST(req: NextRequest) {
  // 1. API key auth
  const rawKey = extractBearerKey(req.headers.get("authorization"));
  if (!rawKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const keyResult = await verifyApiKey(rawKey);
  if (!keyResult) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { orgId } = keyResult;

  // 2. Parse body (must be a JSON object, not a scalar/array)
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Body must be a JSON object" },
      { status: 400 }
    );
  }

  // 3. Optional idempotency key from X-Webhook-Ref header
  const webhookRef = req.headers.get("x-webhook-ref") ?? null;

  // 4. Persist as a completed payload (no upload/scan/parse pipeline needed —
  //    the body IS the structured data).
  const { supabase: db } = await import("@/src/db");
  const payloadId = randomUUID();

  const row: Record<string, unknown> = {
    id: payloadId,
    org_id: orgId,
    source: "webhook",
    status: "completed",
    scan_status: "clean",
    extracted_json: body,
  };
  if (webhookRef) row.webhook_ref = webhookRef;

  const { error: insErr } = await db.from("inbound_payloads").insert(row);
  if (insErr) {
    // Unique constraint violation = duplicate webhook_ref
    if (insErr.code === "23505" && webhookRef) {
      // Look up the existing payload_id for this ref
      const { data: existing } = await db
        .from("inbound_payloads")
        .select("id")
        .eq("org_id", orgId)
        .eq("webhook_ref", webhookRef)
        .eq("source", "webhook")
        .maybeSingle();
      return NextResponse.json(
        { error: "Duplicate", payloadId: existing?.id ?? null },
        { status: 409 }
      );
    }
    console.error("[webhook] insert failed:", insErr.message);
    Sentry.captureException(new Error(`[webhook] insert failed: ${insErr.message}`));
    return NextResponse.json(
      { error: "Internal error" },
      { status: 500 }
    );
  }

  // 5. Audit log
  await db.from("system_audit_logs").insert({
    org_id: orgId,
    action: "webhook.ingested",
    log_meta: { payloadId, hasRef: !!webhookRef },
  });

  // 6. Queue for the Ruflo swarm
  enqueue({ name: "payload/completed", data: { orgId, payloadId } });

  return NextResponse.json({ payloadId }, { status: 202 });
}
