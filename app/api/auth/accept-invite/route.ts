/**
 * POST /api/auth/accept-invite
 *
 * Verifies an invite token, links the current session's user to the
 * inviting org, and marks the invite accepted.
 *
 * Body: { token: string }
 * Auth: session cookie required (user must sign up / log in first, then
 * accept — the invite email points them at /invite?token=..., which prompts
 * login if needed before calling this route).
 */
import { type NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/src/lib/supabaseServer";
import { sha256hex } from "@/src/lib/api-key";

export async function POST(req: NextRequest) {
  const sbClient = await supabaseServer();
  const {
    data: { session },
  } = await sbClient.auth.getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { token?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.token !== "string" || body.token.trim().length === 0) {
    return NextResponse.json({ error: "token required" }, { status: 400 });
  }

  const tokenHash = sha256hex(body.token.trim());
  const { supabase: db } = await import("@/src/db");

  const { data: invite, error: inviteErr } = await db
    .from("org_invites")
    .select("id, org_id, role, expires_at, accepted_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (inviteErr || !invite) {
    return NextResponse.json({ error: "Invalid invite" }, { status: 404 });
  }
  if (invite.accepted_at) {
    return NextResponse.json(
      { error: "Invite already used" },
      { status: 410 }
    );
  }
  if (new Date(invite.expires_at as string).getTime() < Date.now()) {
    return NextResponse.json({ error: "Invite expired" }, { status: 410 });
  }

  const userId = session.user.id;
  const orgId = invite.org_id as string;
  const role = invite.role as string;

  // Upsert so re-accepting (or a user who already has a profile) doesn't
  // error — links this user to the inviting org.
  const { error: profileErr } = await db
    .from("profiles")
    .upsert({ id: userId, org_id: orgId, role }, { onConflict: "id" });
  if (profileErr) {
    return NextResponse.json(
      { error: "Could not link profile" },
      { status: 500 }
    );
  }

  const { error: acceptErr } = await db
    .from("org_invites")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", invite.id)
    .is("accepted_at", null);
  if (acceptErr) {
    return NextResponse.json(
      { error: "Could not mark invite accepted" },
      { status: 500 }
    );
  }

  await db.from("system_audit_logs").insert({
    org_id: orgId,
    action: "invite.accepted",
    log_meta: { inviteId: invite.id, userId },
  });

  const { data: org } = await db
    .from("organizations")
    .select("name")
    .eq("id", orgId)
    .maybeSingle();

  return NextResponse.json(
    { orgId, orgName: org?.name ?? null },
    { status: 200 }
  );
}
