/**
 * src/lib/parse-upload.ts — Phase 5, STAGE 5: extract a finalized+scanned
 * upload into structured `extracted_json` and advance it to 'completed'.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  ⚠️  BOUNDED IN-PROCESS PARSING — NOT TRUE SANDBOX ISOLATION.  ⚠️       ║
 * ║                                                                        ║
 * ║  This parses untrusted file content INSIDE the main Node process. It   ║
 * ║  is made acceptable for the MVP ONLY by being strictly bounded and     ║
 * ║  static: hard caps on rows / columns / field length / total cells, NO  ║
 * ║  formula evaluation, NO type coercion (every value stays a string).    ║
 * ║  This is the `analyze_limited` contract: static text parsing only.     ║
 * ║                                                                        ║
 * ║  It is NOT a real sandbox. True process isolation (E2B or a            ║
 * ║  worker_thread with memory/time limits) is DEFERRED TO PHASE 6+, when  ║
 * ║  the agent swarm / heavier analysis lands. Until then we accept only   ║
 * ║  CSV here; PDF and any richer format are HELD, not parsed in-process   ║
 * ║  (see the deferral path below).                                        ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * TRUST MODEL (mirrors scanUpload): acts only on the orgId that rode inside the
 * trusted 'upload/scanned' event; re-scopes EVERY db read/write with
 * .eq('org_id', orgId). Idempotent: only acts on a row that is
 * scan_status='clean' AND status='processing'; anything else is a safe no-op.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { INBOUND_BUCKET } from "./uploads";

// ── bounded-parse limits (MVP) ───────────────────────────────────────────────
export interface ParseLimits {
  maxRows: number; // total lines parsed (incl. header); excess → truncated
  maxCols: number; // columns kept per row; excess dropped → truncated
  maxFieldLen: number; // chars kept per field; excess clipped → truncated
  maxCells: number; // hard ceiling on total parsed cells (DoS guard)
}

export const DEFAULT_PARSE_LIMITS: ParseLimits = {
  maxRows: 10_000,
  maxCols: 512,
  maxFieldLen: 10_000,
  maxCells: 500_000,
};

export interface ParsedCsv {
  kind: "csv";
  columns: string[];
  rowCount: number;
  rows: string[][];
  truncated: boolean;
  /** Honest marker of WHICH parser produced this — the bounded MVP path. */
  parser: "static-mvp";
}

/**
 * Swappable parser seam (same pattern as Scanner). Swapping in a vetted library
 * later = replace `staticCsvParser` with one whose parse() delegates to it;
 * nothing else in this file changes.
 *
 * TODO (Phase 6+): replace `staticCsvParser` with **papaparse** (RFC-4180
 * compliant, battle-tested) running inside the real sandbox. The hand-rolled
 * reader below exists ONLY because this is strictly-bounded pure-text CSV with
 * caps and no eval — this exception does NOT extend to PDF or any richer format.
 */
export interface CsvParser {
  parse(text: string, limits: ParseLimits): ParsedCsv;
}

/**
 * Hand-rolled, strictly-bounded CSV reader. CUSTOM PARSING — justified only by
 * the constraints above (bounded, pure-text, no eval). RFC-4180-ish: quoted
 * fields, embedded commas/newlines, doubled-quote escaping, CRLF or LF.
 * Enforces every cap and reports `truncated` when any cap clips the input.
 */
export const staticCsvParser: CsvParser = {
  parse(text: string, limits: ParseLimits): ParsedCsv {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    let truncated = false;
    let cellCount = 0;
    let stop = false;

    const appendChar = (ch: string) => {
      if (field.length < limits.maxFieldLen) field += ch;
      else truncated = true; // field clipped
    };
    const endField = () => {
      if (row.length < limits.maxCols) row.push(field);
      else truncated = true; // extra column dropped
      field = "";
      cellCount += 1;
      if (cellCount >= limits.maxCells) {
        truncated = true;
        stop = true;
      }
    };
    const endRow = () => {
      endField();
      if (rows.length < limits.maxRows) rows.push(row);
      else {
        truncated = true;
        stop = true; // hit the row ceiling
      }
      row = [];
    };

    for (let i = 0; i < text.length && !stop; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { appendChar('"'); i++; }
          else inQuotes = false;
        } else appendChar(c);
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        endField();
      } else if (c === "\n") {
        endRow();
      } else if (c === "\r") {
        if (text[i + 1] === "\n") { /* CRLF: let the \n end the row */ }
        else endRow();
      } else {
        appendChar(c);
      }
    }
    // Flush a trailing partial row (file not ending in a newline).
    if (!stop && (field.length > 0 || row.length > 0)) endRow();

    const columns = rows[0] ?? [];
    const dataRows = rows.slice(1);
    return {
      kind: "csv",
      columns,
      rowCount: dataRows.length,
      rows: dataRows,
      truncated,
      parser: "static-mvp",
    };
  },
};

// ── parse handler ────────────────────────────────────────────────────────────

export interface ParseDeps {
  db: SupabaseClient;
  parser: CsvParser;
  limits: ParseLimits;
}

export type ParseResult =
  | { ok: true; outcome: "parsed"; rowCount: number; truncated: boolean }
  | { ok: true; outcome: "deferred_pdf" }
  | { ok: true; outcome: "skipped"; reason: string }
  | { ok: false; code: string; message: string };

async function writeAudit(
  db: SupabaseClient,
  orgId: string,
  action: string,
  meta: Record<string, unknown>
): Promise<void> {
  const { error } = await db
    .from("system_audit_logs")
    .insert({ org_id: orgId, action, log_meta: meta });
  if (error) console.error(`[parse] audit '${action}' failed: ${error.message}`);
}

export function formatOf(mimeType: string | null, filename: string | null): "csv" | "pdf" | "other" {
  const ext = (filename ?? "").slice((filename ?? "").lastIndexOf(".") + 1).toLowerCase();
  if (mimeType === "text/csv" || ext === "csv") return "csv";
  if (mimeType === "application/pdf" || ext === "pdf") return "pdf";
  return "other";
}

export async function parseUpload(
  params: { orgId: string; payloadId: string },
  deps?: Partial<ParseDeps>
): Promise<ParseResult> {
  const { orgId, payloadId } = params;
  const db: SupabaseClient = deps?.db ?? (await import("../db")).supabase;
  const parser: CsvParser = deps?.parser ?? staticCsvParser;
  const limits: ParseLimits = deps?.limits ?? DEFAULT_PARSE_LIMITS;

  // 1. Fetch the row, ORG-SCOPED.
  const { data: row, error: rowErr } = await db
    .from("inbound_payloads")
    .select("status, scan_status, storage_path, mime_type, original_filename")
    .eq("id", payloadId)
    .eq("org_id", orgId)
    .eq("source", "upload")
    .maybeSingle();
  if (rowErr) return { ok: false, code: "DB_ERROR", message: "lookup failed" };
  if (!row || !row.storage_path) return { ok: false, code: "NOT_FOUND", message: "upload not found" };

  // 2. Eligibility / idempotency: only a clean, still-processing upload parses.
  if (row.scan_status !== "clean" || row.status !== "processing") {
    return { ok: true, outcome: "skipped", reason: `status=${row.status}/scan=${row.scan_status}` };
  }

  const storagePath = row.storage_path as string;
  const fmt = formatOf(row.mime_type as string | null, row.original_filename as string | null);

  // 3. Non-CSV is HELD, not parsed in-process. Honest parked state:
  //    status stays 'processing', scan_status stays 'clean', extracted_json NULL,
  //    + an explicit parse.deferred audit row explaining why.
  if (fmt !== "csv") {
    const reason = fmt === "pdf" ? "pdf_parsing_requires_sandbox" : "unsupported_format";
    await writeAudit(db, orgId, "parse.deferred", { payloadId, format: fmt, reason });
    return { ok: true, outcome: "deferred_pdf" };
  }

  // 4. Download the actual bytes and parse them (bounded, static — see banner).
  const { data: blob, error: dlErr } = await db.storage.from(INBOUND_BUCKET).download(storagePath);
  if (dlErr || !blob) return { ok: false, code: "STORAGE_ERROR", message: "could not download object" };
  const text = await blob.text();
  const parsed = parser.parse(text, limits);

  // 5. Persist extracted_json + advance to 'completed'. ORG-SCOPED write.
  const { error: updErr } = await db
    .from("inbound_payloads")
    .update({ extracted_json: parsed, status: "completed" })
    .eq("id", payloadId)
    .eq("org_id", orgId);
  if (updErr) return { ok: false, code: "DB_ERROR", message: "could not store extraction" };

  await writeAudit(db, orgId, "upload.parsed", {
    payloadId,
    parser: parsed.parser,
    rowCount: parsed.rowCount,
    columnCount: parsed.columns.length,
    truncated: parsed.truncated,
  });

  return { ok: true, outcome: "parsed", rowCount: parsed.rowCount, truncated: parsed.truncated };
}
