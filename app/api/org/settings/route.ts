/**
 * /api/org/settings
 *
 * GET   → { name, subscription_tier, created_at, members }
 *          members = [{ id, role, created_at }] from `profiles` for this org
 *          (used by both the org settings page and the team page).
 * PATCH → body { name }: rename the org (max 200 chars)
 */
import { type NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/src/lib/supabaseServer";
import { resolveOrgFromSession } from "@/src/lib/resolveOrgFromSession";

async function getAuth(
  req: NextRequest
): Promise<{ orgId: string } | NextResponse> {
  const sbClient = await supabaseServer();
  const {
    data: { session },
  } = await sbClient.auth.getSession();
  const orgId = await resolveOrgFromSession(session);
  if (!orgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return { orgId };
}

export async function GET(req: NextRequest) {
  const auth = await getAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { orgId } = auth;

  const { supabase: db } = await import("@/src/db");
  const [{ data: org, error: orgErr }, { data: members, error: membersErr }] =
    await Promise.all([
      db
        .from("organizations")
        .select("name, subscription_tier, created_at")
        .eq("id", orgId)
        .single(),
      db
        .from("profiles")
        .select("id, role, created_at")
        .eq("org_id", orgId)
        .order("created_at", { ascending: true }),
    ]);

  if (orgErr || !org || membersErr) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  return NextResponse.json(
    {
      name: org.name,
      subscription_tier: org.subscription_tier,
      created_at: org.created_at,
      members: members ?? [],
    },
    { status: 200 }
  );
}

export async function PATCH(req: NextRequest) {
  const auth = await getAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { orgId } = auth;

  let body: { name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    return NextResponse.json(
      { error: "Body must include name (non-empty string)" },
      { status: 400 }
    );
  }
  const name = body.name.trim().slice(0, 200);

  const { supabase: db } = await import("@/src/db");
  const { error } = await db
    .from("organizations")
    .update({ name })
    .eq("id", orgId);

  if (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  await db.from("system_audit_logs").insert({
    org_id: orgId,
    action: "org.renamed",
    log_meta: { name },
  });

  return NextResponse.json({ name }, { status: 200 });
}
