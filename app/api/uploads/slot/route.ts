/**
 * POST /api/uploads/slot
 *
 * Thin wrapper: resolve org_id from the session (THE chokepoint), then call
 * createUploadSlot. org_id is NEVER taken from the request body.
 *
 * Body: { filename: string, contentType: string, size: number }
 * 200:  { payloadId, path, token, uploadUrl }  — client uploads via uploadToSignedUrl
 * 401:  not signed in / no trusted org
 * 403:  tier not entitled (generic, no tier info)
 * 400:  invalid upload request
 */

import * as Sentry from "@sentry/nextjs";
import { supabaseServer } from "../../../../src/lib/supabaseServer";
import { resolveOrgFromSession } from "../../../../src/lib/resolveOrgFromSession";
import { createUploadSlot } from "../../../../src/lib/uploads";

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

  const filename = typeof body.filename === "string" ? body.filename : "";
  const contentType = typeof body.contentType === "string" ? body.contentType : "";
  const size = typeof body.size === "number" ? body.size : NaN;
  if (!filename || !contentType) {
    return Response.json({ error: "filename and contentType are required" }, { status: 400 });
  }

  const result = await createUploadSlot({ orgId, filename, contentType, declaredSize: size });
  if (!result.ok) {
    if (result.httpStatus >= 500) {
      Sentry.captureException(new Error(`${result.code}: ${result.message}`));
    }
    return Response.json({ code: result.code, message: result.message }, { status: result.httpStatus });
  }
  return Response.json(
    { payloadId: result.payloadId, path: result.path, token: result.token, uploadUrl: result.signedUrl },
    { status: 200 }
  );
}
