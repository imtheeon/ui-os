/**
 * src/lib/scan-upload.ts — Phase 5, STAGE 4: upload malware scan.
 *
 * Phase 9 wired in a real scanner (see virustotal-scanner.ts): the default
 * Scanner used below is now `virusTotalScanner`, which downloads the stored
 * object and checks it against the VirusTotal API. Without
 * VIRUSTOTAL_API_KEY configured it falls back to "clean" without reading any
 * bytes or making a network call — this preserves dev/test behavior (zero
 * real API calls) without requiring a key locally. `placeholderScanner`
 * remains available below for tests that want an explicit, unconditional
 * "clean" stub regardless of env.
 *
 * TRUST MODEL: scanUpload acts only on the orgId that rode inside the trusted
 * 'upload/finalized' event (emitted solely by finalizeUpload). It re-scopes
 * EVERY db read/write with .eq('org_id', orgId) — defense in depth, never
 * trusting anything client-derived. It is idempotent: it only acts on a row
 * still in scan_status='pending', so a duplicate/redelivered event is a no-op.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { INBOUND_BUCKET } from "./uploads";
import { enqueue as defaultEnqueue, type UiEvent } from "./queue";
import { virusTotalScanner, VT_CONFIGURED } from "./virustotal-scanner";

export type ScanVerdict = "clean" | "infected" | "error";

/** What a scanner is handed. A REAL scanner uses these to fetch + inspect the
 *  stored bytes; the placeholder ignores them entirely. */
export interface ScanTarget {
  db: SupabaseClient;
  bucket: string;
  storagePath: string;
  orgId: string;
  payloadId: string;
}

export interface Scanner {
  scan(target: ScanTarget): Promise<ScanVerdict>;
}

/**
 * !!! STUB SCANNER — ALWAYS "clean", inspects NOTHING. !!!
 * No longer the default (see virustotal-scanner.ts, wired in Phase 9); kept
 * for tests that want an explicit, unconditional "clean" stub. Intentionally
 * takes no action on `target`.
 */
export const placeholderScanner: Scanner = {
  async scan(_target: ScanTarget): Promise<ScanVerdict> {
    // NO bytes read. NO inspection. This is not real scanning — it is a stub
    // that unconditionally passes every file. DO NOT trust this for safety.
    return "clean";
  },
};

export interface ScanDeps {
  /** Service-role client. Lazy db.ts default. */
  db: SupabaseClient;
  /** The scanner to use. Defaults to the ALWAYS-PASSES placeholder (Phase 9 → real). */
  scanner: Scanner;
  /** Emit follow-on events. Defaults to the real queue seam; injectable for tests. */
  enqueue: (event: UiEvent) => void;
}

export type ScanResult =
  | { ok: true; verdict: ScanVerdict; skipped?: boolean }
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
  if (error) console.error(`[scan] audit '${action}' failed: ${error.message}`);
}

export async function scanUpload(
  params: { orgId: string; payloadId: string },
  deps?: Partial<ScanDeps>
): Promise<ScanResult> {
  const { orgId, payloadId } = params;
  const db: SupabaseClient = deps?.db ?? (await import("../db")).supabase;
  const scanner: Scanner = deps?.scanner ?? virusTotalScanner;
  const enqueue = deps?.enqueue ?? defaultEnqueue;

  // 1. Fetch the row, ORG-SCOPED. Cannot touch another tenant's payload even
  //    though orgId came from the trusted event — defense in depth.
  const { data: row, error: rowErr } = await db
    .from("inbound_payloads")
    .select("id, storage_path, status, scan_status")
    .eq("id", payloadId)
    .eq("org_id", orgId)
    .eq("source", "upload")
    .maybeSingle();
  if (rowErr) return { ok: false, code: "DB_ERROR", message: "lookup failed" };
  if (!row || !row.storage_path) {
    return { ok: false, code: "NOT_FOUND", message: "upload not found" };
  }

  // 2. Idempotency guard: only scan a row still pending. A redelivered or
  //    duplicate event is a safe no-op (never re-runs a terminal transition).
  if (row.scan_status !== "pending") {
    return { ok: true, verdict: (row.scan_status as ScanVerdict) ?? "clean", skipped: true };
  }

  const storagePath = row.storage_path as string;

  // 3. Run the scanner (virusTotalScanner by default — see virustotal-scanner.ts;
  //    falls back to "clean" without a network call if no API key is configured).
  let verdict: ScanVerdict;
  try {
    verdict = await scanner.scan({
      db,
      bucket: INBOUND_BUCKET,
      storagePath,
      orgId,
      payloadId,
    });
  } catch (e) {
    verdict = "error";
    console.error(`[scan] scanner threw for payload ${payloadId}: ${(e as Error).message}`);
  }

  // 4. Apply the verdict — every write ORG-SCOPED.
  if (verdict === "clean") {
    const { error: updErr } = await db
      .from("inbound_payloads")
      .update({ scan_status: "clean" })
      .eq("id", payloadId)
      .eq("org_id", orgId);
    if (updErr) return { ok: false, code: "DB_ERROR", message: "could not mark clean" };

    await writeAudit(db, orgId, "upload.scan_clean", {
      payloadId,
      // Honest record of whether this verdict came from a real VT scan or the
      // no-key fallback (identical outcome, but the audit trail shouldn't
      // overclaim a real scan happened when it didn't).
      stub: !VT_CONFIGURED,
      note: VT_CONFIGURED
        ? "VirusTotal scan — no engine flagged the file"
        : "VIRUSTOTAL_API_KEY not configured — no real malware scan performed",
    });

    // Hand off to stage 5 (parser). Only a CLEAN file proceeds.
    enqueue({ name: "upload/scanned", data: { orgId, payloadId } });
    return { ok: true, verdict: "clean" };
  }

  if (verdict === "infected") {
    // Quarantine by removal: fail the row and delete the object. A real scanner
    // reaching this branch means do NOT keep the file around.
    await db
      .from("inbound_payloads")
      .update({ scan_status: "infected", status: "failed" })
      .eq("id", payloadId)
      .eq("org_id", orgId);
    await db.storage.from(INBOUND_BUCKET).remove([storagePath]);
    await writeAudit(db, orgId, "upload.scan_infected", { payloadId, storagePath });
    // Do NOT enqueue 'upload/scanned' — an infected file never reaches the parser.
    return { ok: true, verdict: "infected" };
  }

  // verdict === "error": scanner couldn't produce a verdict. Fail closed —
  // mark the row failed and record it; the file is NOT passed downstream.
  await db
    .from("inbound_payloads")
    .update({ scan_status: "error", status: "failed" })
    .eq("id", payloadId)
    .eq("org_id", orgId);
  await writeAudit(db, orgId, "upload.scan_error", { payloadId });
  return { ok: true, verdict: "error" };
}
