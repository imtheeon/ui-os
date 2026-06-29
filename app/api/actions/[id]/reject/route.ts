/**
 * POST /api/actions/[id]/reject — authed; org_id from the session. Flips a
 * pending proposal to 'rejected'. No executor, no record written.
 */
import { supabaseServer } from "../../../../../src/lib/supabaseServer";
import { resolveOrgFromSession } from "../../../../../src/lib/resolveOrgFromSession";
import { supabase as serviceClient } from "../../../../../src/db";
import { rejectAction } from "../../../../../src/lib/actions-service";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const supabase = await supabaseServer();
  const { data: { session } } = await supabase.auth.getSession();
  const orgId = await resolveOrgFromSession(session);
  if (!orgId) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { data: { user } } = await supabase.auth.getUser();
  const decidedBy = user?.id ?? "";

  const { id } = await ctx.params;
  const result = await rejectAction(orgId, id, decidedBy, { db: serviceClient });
  if (!result.ok) {
    const status = result.code === "NOT_FOUND" ? 404 : 500;
    return Response.json({ error: result.code }, { status });
  }
  return Response.json({ ok: true }, { status: 200 });
}
