/**
 * src/lib/uploads.ts
 *
 * Core logic for the file-upload pipeline (Phase 5, stages 1-3):
 *   createUploadSlot  — gate + validate + presigned direct-to-Storage URL
 *   finalizeUpload    — verify the actually-stored object, advance to processing
 *
 * The API route handlers (app/api/uploads/*) are thin wrappers: they resolve
 * org_id from the session and call these. Keeping the logic here lets
 * check-upload.ts verify it directly with an injected client.
 *
 * ────────────────────────────────────────────────────────────────────────
 * SECURITY NOTES — what is and isn't actually enforced here:
 *  - org_id MUST come from resolveOrgFromSession at the route boundary; these
 *    functions trust the orgId they're given (same contract as tier-gate).
 *  - Storage paths are ORG-SCOPED: `<org_id>/<payload_id>/<filename>`. The
 *    payload_id is server-minted; the caller never chooses the path.
 *  - SIZE is enforced for real at finalize, from the actual stored byte count
 *    (not client-claimed) — see finalizeUpload.
 *  - CONTENT-TYPE validation at the slot is ADVISORY fast-fail only: the stored
 *    mimetype is whatever the client sent on upload and is forgeable. The real
 *    content guarantee comes later from the sandboxed parser (stage 5). Do not
 *    treat a passing content-type check here as proof the bytes are a real
 *    CSV/PDF.
 *  - RATE LIMITING is NOT implemented here. It needs a durable store
 *    (Upstash/Redis); an in-memory limiter is meaningless across serverless
 *    instances. TODO: add as its own slice before public launch.
 * ────────────────────────────────────────────────────────────────────────
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { requireTierForAction } from "../tier-gate";
import { enqueue } from "./queue";

export const INBOUND_BUCKET = "inbound";
export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

const ALLOWED_CONTENT_TYPES = new Set(["text/csv", "application/pdf"]);
const ALLOWED_EXTENSIONS = new Set(["csv", "pdf"]);

export interface UploadDeps {
  /** Service-role client (storage + cross-tenant writes). Lazy db.ts default. */
  db: SupabaseClient;
  /** Max accepted file size in bytes. Injectable for tests. */
  maxBytes: number;
}

export type SlotResult =
  | { ok: true; payloadId: string; path: string; token: string; signedUrl: string }
  | { ok: false; httpStatus: number; code: string; message: string };

export type FinalizeResult =
  | { ok: true; payloadId: string; status: "processing" }
  | { ok: false; httpStatus: number; code: string; message: string };

// ── helpers ────────────────────────────────────────────────────────────────

/** Strip any path components and unsafe chars from a client-supplied name. */
function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_{2,}/g, "_");
  return cleaned.slice(0, 200) || "file";
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Advisory pre-checks. Returns an error string, or null if the request looks ok. */
function validateDeclared(
  filename: string,
  contentType: string,
  declaredSize: number,
  maxBytes: number
): string | null {
  const ext = extensionOf(filename);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return `unsupported file extension ".${ext}" (allowed: csv, pdf)`;
  }
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return `unsupported content-type "${contentType}" (allowed: text/csv, application/pdf)`;
  }
  if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
    return "missing or invalid file size";
  }
  if (declaredSize > maxBytes) {
    return `file too large: ${declaredSize} bytes exceeds limit ${maxBytes}`;
  }
  return null;
}

async function writeAudit(
  db: SupabaseClient,
  orgId: string,
  action: string,
  meta: Record<string, unknown>
): Promise<void> {
  const { error } = await db
    .from("system_audit_logs")
    .insert({ org_id: orgId, action, log_meta: meta });
  if (error) console.error(`[uploads] audit '${action}' failed: ${error.message}`);
}

// ── stage 1: request an upload slot ─────────────────────────────────────────

export async function createUploadSlot(
  params: { orgId: string; filename: string; contentType: string; declaredSize: number },
  deps?: Partial<UploadDeps>
): Promise<SlotResult> {
  const { orgId, filename, contentType, declaredSize } = params;
  const db: SupabaseClient = deps?.db ?? (await import("../db")).supabase;
  const maxBytes = deps?.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  // 1. Gate FIRST — no row, no storage URL if the org can't ingest. The gate
  //    returns a generic, tier-free rejection (never leaks the org's tier).
  const gate = await requireTierForAction({ orgId, action: "ingest" }, { db });
  if (!gate.allowed) {
    return { ok: false, httpStatus: gate.httpStatus, code: gate.code, message: gate.message };
  }

  // 2. Advisory validation of the declared metadata.
  const invalid = validateDeclared(filename, contentType, declaredSize, maxBytes);
  if (invalid) return { ok: false, httpStatus: 400, code: "INVALID_UPLOAD", message: invalid };

  // 3. Server-minted, ORG-SCOPED path. The caller never chooses this.
  const payloadId = randomUUID();
  const cleanName = safeFilename(filename);
  const path = `${orgId}/${payloadId}/${cleanName}`;

  // 4. Presigned upload URL — the browser uploads straight to Storage.
  const { data: signed, error: signErr } = await db.storage
    .from(INBOUND_BUCKET)
    .createSignedUploadUrl(path);
  if (signErr || !signed) {
    return { ok: false, httpStatus: 500, code: "STORAGE_ERROR", message: "could not create upload URL" };
  }

  // 5. Payload row (pending; scan pending). storage_path satisfies the 0003 CHECK.
  const { error: insErr } = await db.from("inbound_payloads").insert({
    id: payloadId,
    org_id: orgId,
    source: "upload",
    status: "pending",
    scan_status: "pending",
    storage_path: path,
    original_filename: cleanName,
    mime_type: contentType,
    size_bytes: declaredSize,
  });
  if (insErr) {
    // Nothing uploaded yet; the orphan signed URL is harmless without a row.
    return { ok: false, httpStatus: 500, code: "DB_ERROR", message: "could not create payload record" };
  }

  await writeAudit(db, orgId, "upload.slot_issued", { payloadId, path, declaredSize, contentType });

  return { ok: true, payloadId, path, token: signed.token, signedUrl: signed.signedUrl };
}

// ── stage 3: finalize after the direct upload ───────────────────────────────

export async function finalizeUpload(
  params: { orgId: string; payloadId: string },
  deps?: Partial<UploadDeps>
): Promise<FinalizeResult> {
  const { orgId, payloadId } = params;
  const db: SupabaseClient = deps?.db ?? (await import("../db")).supabase;
  const maxBytes = deps?.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  // 1. Fetch the row, ORG-SCOPED — cannot finalize another tenant's payload.
  const { data: row, error: rowErr } = await db
    .from("inbound_payloads")
    .select("id, storage_path, status")
    .eq("id", payloadId)
    .eq("org_id", orgId)
    .eq("source", "upload")
    .maybeSingle();
  if (rowErr) return { ok: false, httpStatus: 500, code: "DB_ERROR", message: "lookup failed" };
  if (!row || !row.storage_path) {
    return { ok: false, httpStatus: 404, code: "NOT_FOUND", message: "upload not found" };
  }

  // 2. Inspect the ACTUAL stored object. Size here is real bytes, not claimed.
  const path = row.storage_path as string;
  const slash = path.lastIndexOf("/");
  const folder = path.slice(0, slash);
  const fname = path.slice(slash + 1);

  const { data: list, error: listErr } = await db.storage.from(INBOUND_BUCKET).list(folder);
  if (listErr) return { ok: false, httpStatus: 500, code: "STORAGE_ERROR", message: "could not inspect upload" };
  const obj = (list ?? []).find((o) => o.name === fname);
  if (!obj) return { ok: false, httpStatus: 409, code: "NO_OBJECT", message: "no uploaded file found for this slot" };

  const meta = (obj.metadata ?? null) as { size?: number; mimetype?: string } | null;
  const actualSize = meta?.size ?? 0;
  const actualMime = meta?.mimetype ?? null;

  // 3. Enforce the REAL size limit. On violation: fail the row + delete the object.
  if (actualSize <= 0 || actualSize > maxBytes) {
    await db.from("inbound_payloads")
      .update({ status: "failed", scan_status: "error" })
      .eq("id", payloadId).eq("org_id", orgId);
    await db.storage.from(INBOUND_BUCKET).remove([path]);
    await writeAudit(db, orgId, "upload.rejected", { payloadId, reason: "size", actualSize, maxBytes });
    return { ok: false, httpStatus: 400, code: "FILE_TOO_LARGE", message: "uploaded file exceeds the size limit" };
  }

  // 4. Accept → processing. scan_status stays 'pending' for the (deferred)
  //    malware-scan worker to pick up; it advances things from here.
  const update: Record<string, unknown> = { status: "processing", size_bytes: actualSize };
  if (actualMime) update.mime_type = actualMime;
  const { error: updErr } = await db
    .from("inbound_payloads")
    .update(update)
    .eq("id", payloadId).eq("org_id", orgId);
  if (updErr) return { ok: false, httpStatus: 500, code: "DB_ERROR", message: "could not update payload" };

  await writeAudit(db, orgId, "upload.finalized", { payloadId, actualSize, actualMime });

  // Hand the now-'processing' upload to the async lifecycle (scan → parse).
  // enqueue() only RECORDS the event and returns — it does not run handlers
  // here, so finalize keeps its fast 'processing' contract. The sole producer
  // of 'upload/finalized' is this line; orgId rides inside the trusted event.
  enqueue({ name: "upload/finalized", data: { orgId, payloadId } });

  return { ok: true, payloadId, status: "processing" };
}
