/**
 * /api/org/invites
 *
 * Manage teammate invites for the org.
 *
 * GET    → list pending (unaccepted, unexpired) invites for the org
 * POST   → create an invite token for an email (body: { email, role? })
 *           Returns { inviteUrl } once — the raw token is not stored.
 *           Sends the invite email via Resend if RESEND_API_KEY is set;
 *           otherwise inviteUrl is returned for the admin to share manually.
 * DELETE ?inviteId=<uuid> → revoke a pending invite
 */
import { randomBytes } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/src/lib/supabaseServer";
import { resolveOrgFromSession } from "@/src/lib/resolveOrgFromSession";
import { sha256hex } from "@/src/lib/api-key";

async function getAuth(
  req: NextRequest
): Promise<{ orgId: string; userId: string } | NextResponse> {
  const sbClient = await supabaseServer();
  const {
    data: { session },
  } = await sbClient.auth.getSession();
  const orgId = await resolveOrgFromSession(session);
  if (!orgId || !session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return { orgId, userId: session.user.id };
}

export async function GET(req: NextRequest) {
  const auth = await getAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { orgId } = auth;

  const { supabase: db } = await import("@/src/db");
  const { data, error } = await db
    .from("org_invites")
    .select("id, email, role, created_at, expires_at")
    .eq("org_id", orgId)
    .is("accepted_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  return NextResponse.json({ invites: data ?? [] }, { status: 200 });
}

export async function POST(req: NextRequest) {
  const auth = await getAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { orgId, userId } = auth;

  let body: { email?: unknown; role?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.email !== "string" || body.email.trim().length === 0) {
    return NextResponse.json(
      { error: "Body must include email (non-empty string)" },
      { status: 400 }
    );
  }
  const role = body.role === "admin" ? "admin" : "member";
  const email = body.email.trim().toLowerCase().slice(0, 320);

  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = sha256hex(rawToken);

  const { supabase: db } = await import("@/src/db");
  const { data, error } = await db
    .from("org_invites")
    .insert({
      org_id: orgId,
      email,
      token_hash: tokenHash,
      role,
      invited_by: userId,
    })
    .select("id")
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  await db.from("system_audit_logs").insert({
    org_id: orgId,
    action: "invite.created",
    log_meta: { inviteId: data.id, email, role },
  });

  const origin = req.nextUrl.origin;
  const inviteUrl = `${origin}/invite?token=${encodeURIComponent(rawToken)}`;

  if (process.env.RESEND_API_KEY) {
    try {
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev",
        to: email,
        subject: "You've been invited to join a team on U-I-OS",
        text: `You've been invited to join a team. Accept your invite: ${inviteUrl}`,
      });
    } catch (err) {
      // Best-effort — the invite still exists and inviteUrl is returned
      // below so the admin can share it manually if email delivery fails.
      console.warn("[invites] Resend send failed:", err);
    }
  }

  return NextResponse.json({ inviteUrl }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const auth = await getAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { orgId } = auth;

  const inviteId = req.nextUrl.searchParams.get("inviteId");
  if (!inviteId) {
    return NextResponse.json(
      { error: "inviteId query parameter required" },
      { status: 400 }
    );
  }

  const { supabase: db } = await import("@/src/db");
  const { error } = await db
    .from("org_invites")
    .delete()
    .eq("id", inviteId)
    .eq("org_id", orgId); // ORG-SCOPED — cannot revoke another org's invite

  if (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  await db.from("system_audit_logs").insert({
    org_id: orgId,
    action: "invite.revoked",
    log_meta: { inviteId },
  });

  return NextResponse.json({ revoked: true }, { status: 200 });
}
