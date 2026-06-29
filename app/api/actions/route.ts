/**
 * GET /api/actions?status=pending — org-scoped list of this org's pending
 * proposed actions for the dashboard. org_id ALWAYS from resolveOrgFromSession.
 * Returns a bounded view (kind, rationale, action_payload, created_at) — never
 * internal status machinery beyond what the UI renders.
 */
import { supabaseServer } from "../../../src/lib/supabaseServer";
import { resolveOrgFromSession } from "../../../src/lib/resolveOrgFromSession";
import { supabase as serviceClient } from "../../../src/db";
import { listPending } from "../../../src/lib/actions-service";

export async function GET(): Promise<Response> {
  const supabase = await supabaseServer();
  const { data: { session } } = await supabase.auth.getSession();
  const orgId = await resolveOrgFromSession(session);
  if (!orgId) return Response.json({ error: "unauthorized" }, { status: 401 });

  const items = await listPending(orgId, { db: serviceClient });
  return Response.json({ items }, { status: 200 });
}
