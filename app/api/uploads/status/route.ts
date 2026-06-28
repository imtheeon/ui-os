/**
 * GET /api/uploads/status?ids=<comma-separated payload ids>
 *
 * Org-scoped poll endpoint for the dashboard upload panel. Returns a derived,
 * BOUNDED status per requested payload — NEVER raw extracted_json, only a small
 * summary (columns, rowCount, truncated, first-5-row preview).
 *
 * Security: org_id ALWAYS from resolveOrgFromSession; read scoped
 * .eq('org_id', orgId).in('id', ids). A caller can only see their own org's
 * payloads — unknown / other-tenant ids simply don't come back.
 *
 * "held" disambiguation: status=processing + scan=clean + extracted_json=null is
 * ALSO what a transiently-errored CSV looks like, so we additionally require the
 * format to be non-CSV (only CSV can complete in-process). That keeps a held PDF
 * resolving to 'held' immediately while a stuck CSV stays 'processing' (caught by
 * the client's poll-attempt cap), never mislabeled.
 */
import { supabaseServer } from "../../../../src/lib/supabaseServer";
import { resolveOrgFromSession } from "../../../../src/lib/resolveOrgFromSession";
import { supabase as serviceClient } from "../../../../src/db";
import { formatOf } from "../../../../src/lib/parse-upload";

const MAX_IDS = 50;

type UiState = "completed" | "failed" | "held" | "processing";

interface PayloadRow {
  id: string;
  status: string;
  scan_status: string | null;
  extracted_json: {
    columns?: string[];
    rowCount?: number;
    rows?: string[][];
    truncated?: boolean;
  } | null;
  mime_type: string | null;
  original_filename: string | null;
}

function deriveState(row: PayloadRow): UiState {
  if (row.status === "completed") return "completed";
  if (row.status === "failed") return "failed";
  if (
    row.status === "processing" &&
    row.scan_status === "clean" &&
    row.extracted_json == null &&
    formatOf(row.mime_type, row.original_filename) !== "csv"
  ) {
    return "held";
  }
  return "processing";
}

export async function GET(req: Request): Promise<Response> {
  const supabase = await supabaseServer();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const orgId = await resolveOrgFromSession(session);
  if (!orgId) return Response.json({ error: "unauthorized" }, { status: 401 });

  const ids = (new URL(req.url).searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_IDS);
  if (ids.length === 0) return Response.json({ items: [] }, { status: 200 });

  const { data, error } = await serviceClient
    .from("inbound_payloads")
    .select("id, status, scan_status, extracted_json, mime_type, original_filename")
    .eq("org_id", orgId)
    .in("id", ids);
  if (error) return Response.json({ error: "lookup failed" }, { status: 500 });

  const items = (data ?? []).map((row) => {
    const r = row as PayloadRow;
    const state = deriveState(r);
    const ej = r.extracted_json;
    const summary =
      state === "completed" && ej
        ? {
            columns: ej.columns ?? [],
            rowCount: ej.rowCount ?? 0,
            truncated: ej.truncated ?? false,
            preview: (ej.rows ?? []).slice(0, 5),
          }
        : undefined;
    return { payloadId: r.id, state, summary };
  });

  return Response.json({ items }, { status: 200 });
}
