/**
 * POST /api/auth/complete-signup
 *
 * Fallback org-provisioning path. In the normal signup flow, org + profile
 * are created atomically by the handle_new_user() DB trigger (migration
 * 0002) when the user signs up with org_name in their auth metadata — see
 * app/signup/page.tsx. This route exists for the edge case where a session
 * has no profile yet (e.g. the org name wasn't collected at signup time) and
 * is what /onboarding calls.
 *
 * Body: { orgName: string }
 * Auth: session cookie required
 *
 * NOTE: the real profile table is `profiles` (migration 0002), not
 * `auth_profiles` — there is no `auth_profiles` table in this schema.
 */
import { type NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/src/lib/supabaseServer";
import { resolveOrgFromSession } from "@/src/lib/resolveOrgFromSession";

export async function POST(req: NextRequest) {
  const sbClient = await supabaseServer();
  const {
    data: { session },
  } = await sbClient.auth.getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Already provisioned (the common case — the signup trigger already ran).
  const existingOrgId = await resolveOrgFromSession(session);
  if (existingOrgId) {
    return NextResponse.json({ orgId: existingOrgId, alreadyExists: true });
  }

  let body: { orgName?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.orgName !== "string" || body.orgName.trim().length === 0) {
    return NextResponse.json({ error: "orgName required" }, { status: 400 });
  }

  const { supabase: db } = await import("@/src/db");
  const userId = session.user.id;
  const orgName = body.orgName.trim().slice(0, 200);

  const { data: org, error: orgErr } = await db
    .from("organizations")
    .insert({ name: orgName, subscription_tier: "free" })
    .select("id")
    .single();
  if (orgErr || !org) {
    return NextResponse.json(
      { error: "Could not create organization" },
      { status: 500 }
    );
  }
  const orgId = org.id as string;

  // Creator of a fallback-provisioned org is its owner, matching the
  // handle_new_user() trigger's convention for first-user-of-an-org.
  const { error: profileErr } = await db
    .from("profiles")
    .insert({ id: userId, org_id: orgId, role: "owner" });
  if (profileErr) {
    // Roll back the org so we don't leave an orphaned row.
    await db.from("organizations").delete().eq("id", orgId);
    return NextResponse.json(
      { error: "Could not create profile" },
      { status: 500 }
    );
  }

  await db.from("system_audit_logs").insert({
    org_id: orgId,
    action: "org.created",
    log_meta: { userId, orgName, source: "complete-signup" },
  });

  return NextResponse.json({ orgId }, { status: 201 });
}
