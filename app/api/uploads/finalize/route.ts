/**
 * POST /api/uploads/finalize
 *
 * Thin wrapper: resolve org_id from the session, then call finalizeUpload,
 * which verifies the actually-stored object (real size) and advances the
 * payload to 'processing'. org_id is NEVER taken from the request body — this
 * is what stops one tenant finalizing another tenant's upload.
 *
 * Body: { payloadId: string }
 * 200:  { payloadId, status: 'processing' }
 * 401:  not signed in / no trusted org
 * 404:  upload not found for THIS org
 * 400:  uploaded file violates policy (e.g. too large)
 */

import { supabaseServer } from "../../../../src/lib/supabaseServer";
import { resolveOrgFromSession } from "../../../../src/lib/resolveOrgFromSession";
import { finalizeUpload } from "../../../../src/lib/uploads";

export async function POST(req: Request): Promise<Response> {
  const supabase = await supabaseServer();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const orgId = await resolveOrgFromSession(session);
  if (!orgId) return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const payloadId = typeof body.payloadId === "string" ? body.payloadId : "";
  if (!payloadId) {
    return Response.json({ error: "payloadId is required" }, { status: 400 });
  }

  const result = await finalizeUpload({ orgId, payloadId });
  if (!result.ok) {
    return Response.json({ code: result.code, message: result.message }, { status: result.httpStatus });
  }
  return Response.json({ payloadId: result.payloadId, status: result.status }, { status: 200 });
}
