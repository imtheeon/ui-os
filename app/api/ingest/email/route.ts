/**
 * POST /api/ingest/email
 * Receives Resend inbound-email webhooks. Verifies the Svix signature,
 * extracts the org_id from the recipient address, and queues the email
 * for agent processing.
 *
 * Required env:
 *   RESEND_WEBHOOK_SECRET — signing secret from Resend dashboard
 *   INBOUND_EMAIL_DOMAIN  — e.g. "inbound.uios.app"
 *
 * Response 200: { received: true, payloadId }
 * Response 400: { error: <reason> }
 * Response 401: { error: "Invalid signature" }
 */
import { type NextRequest, NextResponse } from "next/server";
import { createHmac } from "node:crypto";
import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { enqueue } from "@/src/lib/queue";

const TIMESTAMP_TOLERANCE_SECONDS = 300;

function verifyResendSignature(
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
  rawBody: string,
  secret: string
): boolean {
  // 1. Timestamp freshness check
  const ts = parseInt(svixTimestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const ageSec = Math.abs(Date.now() / 1000 - ts);
  if (ageSec > TIMESTAMP_TOLERANCE_SECONDS) return false;

  // 2. Compute expected HMAC
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expectedBytes = createHmac("sha256", secret)
    .update(signedContent, "utf8")
    .digest("base64");

  // 3. svix-signature may be "v1,<b64> v1,<b64>" (space-separated per Svix spec)
  const sigs = svixSignature.split(" ").map((s) => s.trim()).filter(Boolean);
  return sigs.some((sig) => {
    const parts = sig.split(",");
    if (parts[0] !== "v1" || parts.length < 2) return false;
    return parts.slice(1).join(",") === expectedBytes;
  });
}

function extractOrgIdFromTo(
  toAddresses: unknown,
  domain: string
): string | null {
  if (!Array.isArray(toAddresses)) return null;
  for (const addr of toAddresses) {
    if (typeof addr !== "string") continue;
    // strip display name if present: "Name <local@domain>" → "local@domain"
    const match = addr.match(/<([^>]+)>/) ?? [null, addr];
    const email = (match[1] ?? addr).trim().toLowerCase();
    if (email.endsWith("@" + domain.toLowerCase())) {
      const localPart = email.slice(0, email.indexOf("@"));
      // Validate it looks like a UUID (org_id format)
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(localPart)) {
        return localPart;
      }
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  // 1. Read raw body (needed for signature verification)
  const rawBody = await req.text();

  // 2. Svix headers must be present before anything else — a request missing
  //    them can never be verified, regardless of server config.
  const svixId = req.headers.get("svix-id") ?? "";
  const svixTimestamp = req.headers.get("svix-timestamp") ?? "";
  const svixSignature = req.headers.get("svix-signature") ?? "";

  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const domain = process.env.INBOUND_EMAIL_DOMAIN;

  if (!secret || !domain) {
    console.error("[email-ingest] RESEND_WEBHOOK_SECRET or INBOUND_EMAIL_DOMAIN not set");
    Sentry.captureException(new Error("[email-ingest] RESEND_WEBHOOK_SECRET or INBOUND_EMAIL_DOMAIN not set"));
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  // 3. Verify signature
  if (!verifyResendSignature(svixId, svixTimestamp, svixSignature, rawBody, secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // 3. Parse body
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    (body as Record<string, unknown>).type !== "email.received"
  ) {
    // Silently accept other event types (Resend may send other events)
    return NextResponse.json({ received: true }, { status: 200 });
  }

  const data = (body as Record<string, unknown>).data as Record<string, unknown>;
  const emailId = (data?.email_id as string) ?? null;
  const toAddresses = data?.to;

  // 4. Extract org_id from recipient
  const orgId = extractOrgIdFromTo(toAddresses, domain);
  if (!orgId) {
    console.warn("[email-ingest] no matching org address in to:", toAddresses);
    return NextResponse.json(
      { error: "Recipient address does not match any known org" },
      { status: 422 }
    );
  }

  // 5. Verify org exists (code-owned check — orgId came from our own routing,
  //    but we still validate it against the DB before creating a payload row).
  const { supabase: db } = await import("@/src/db");
  const { data: org, error: orgErr } = await db
    .from("organizations")
    .select("id")
    .eq("id", orgId)
    .maybeSingle();

  if (orgErr || !org) {
    console.warn("[email-ingest] org not found:", orgId);
    return NextResponse.json({ error: "Unknown organization" }, { status: 422 });
  }

  // 6. Idempotency: skip if email_id already ingested for this org
  if (emailId) {
    const { data: existing } = await db
      .from("inbound_payloads")
      .select("id")
      .eq("org_id", orgId)
      .eq("email_message_id", emailId)
      .eq("source", "email")
      .maybeSingle();
    if (existing) {
      return NextResponse.json(
        { received: true, payloadId: existing.id, duplicate: true },
        { status: 200 }
      );
    }
  }

  // 7. Persist. email_message_id must be non-null for source='email' (schema
  //    shape constraint) — fall back to a server-minted id if Resend omits one.
  const payloadId = randomUUID();
  const row: Record<string, unknown> = {
    id: payloadId,
    org_id: orgId,
    source: "email",
    status: "completed",
    scan_status: "clean",
    extracted_json: data,
    email_message_id: emailId ?? `no-email-id-${payloadId}`,
  };

  const { error: insErr } = await db.from("inbound_payloads").insert(row);
  if (insErr) {
    console.error("[email-ingest] insert failed:", insErr.message);
    Sentry.captureException(new Error(`[email-ingest] insert failed: ${insErr.message}`));
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  await db.from("system_audit_logs").insert({
    org_id: orgId,
    action: "email.ingested",
    log_meta: { payloadId, emailId, subject: data?.subject ?? null },
  });

  // 8. Queue
  enqueue({ name: "payload/completed", data: { orgId, payloadId } });

  return NextResponse.json({ received: true, payloadId }, { status: 200 });
}
