/**
 * src/check-parse.ts
 *
 * Verifies Phase 5 STAGE 5 (parseUpload, the bounded static CSV parser) and the
 * full stage-4→stage-5 pipeline against the live database + Storage.
 * Run with: npm run check:parse
 *
 * Proves, with an injected service-role client and injected limits:
 *   1. CSV HAPPY PATH — drainQueue routes 'upload/scanned' → parseUpload:
 *      extracted_json populated (correct columns/rows, parser:"static-mvp"),
 *      status → 'completed', upload.parsed audit row exists.
 *   2. FULL CHAIN — enqueue 'upload/finalized' → one drainQueue runs
 *      scan(clean) → handoff → parse → 'completed'. Stage-4→5 end to end.
 *   3. TRUNCATION — a CSV exceeding a tiny injected maxRows → truncated:true,
 *      row count clipped, still 'completed'.
 *   4. CSV CORRECTNESS — quoted fields, embedded commas, embedded newline, and
 *      doubled-quote escaping parse correctly (not a naive split).
 *   5. PDF DEFERRAL — a clean PDF → outcome 'deferred_pdf', status STAYS
 *      'processing', extracted_json STAYS null, parse.deferred audit exists.
 *   6. IDEMPOTENCY — a second parseUpload → 'skipped', no double-audit,
 *      extracted_json unchanged.
 *
 * Loads .env.local explicitly and injects { db: service }. resetQueue()
 * isolates each case.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createUploadSlot, finalizeUpload, INBOUND_BUCKET } from "./lib/uploads";
import { parseUpload, type ParseLimits } from "./lib/parse-upload";
import { enqueue, drainQueue, resetQueue } from "./lib/queue";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "..", ".env.local"), quiet: true });

let failures = 0;
const pass = (m: string) => console.log(`  ✓ ${m}`);
const fail = (m: string) => {
  failures += 1;
  console.error(`  ✗ ${m}`);
};
const check = (cond: boolean, label: string) => (cond ? pass(label) : fail(label));
const section = (t: string) => console.log(`\n${t}`);
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing service-role env in .env.local. Run `npm run db:check` first.");
  process.exit(1);
}

const service: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const createdPaths: string[] = [];
const createdPayloadIds: string[] = [];

async function makeFreeOrg(tag: string): Promise<string> {
  const { data, error } = await service
    .from("organizations")
    .insert({ name: `__parse_test_${tag}_${Date.now()}` })
    .select("id")
    .single();
  if (error || !data) throw new Error(`makeFreeOrg(${tag}) failed: ${error?.message}`);
  return data.id;
}

/** slot → raw PUT → finalize, leaving a real 'processing'/'pending' upload row
 *  (scan not yet run). Returns its id + storage path. */
async function setupFinalizedUpload(
  orgId: string,
  filename: string,
  body: string,
  contentType = "text/csv"
): Promise<{ payloadId: string; path: string }> {
  const slot = await createUploadSlot(
    { orgId, filename, contentType, declaredSize: body.length },
    { db: service }
  );
  if (!slot.ok) throw new Error(`slot failed for ${filename}: ${slot.code} ${slot.message}`);
  createdPaths.push(slot.path);
  createdPayloadIds.push(slot.payloadId);

  const put = await fetch(slot.signedUrl, {
    method: "PUT",
    headers: { "content-type": contentType, "x-upsert": "true" },
    body,
  });
  if (put.status !== 200) throw new Error(`raw PUT failed (${put.status}) for ${filename}`);

  const fin = await finalizeUpload({ orgId, payloadId: slot.payloadId }, { db: service });
  if (!fin.ok) throw new Error(`finalize failed for ${filename}: ${fin.code}`);
  return { payloadId: slot.payloadId, path: slot.path };
}

/** Test shortcut: stamp a finalized upload as scan-clean so it is parse-eligible,
 *  without routing through the scanner (the parse-focused cases want to isolate
 *  parseUpload). Cases 1 and 2 exercise the real scan→parse handoff instead. */
async function markClean(payloadId: string, orgId: string): Promise<void> {
  await service
    .from("inbound_payloads")
    .update({ scan_status: "clean" })
    .eq("id", payloadId)
    .eq("org_id", orgId);
}

async function rowOf(payloadId: string, orgId: string) {
  const { data } = await service
    .from("inbound_payloads")
    .select("status, scan_status, extracted_json")
    .eq("id", payloadId)
    .eq("org_id", orgId)
    .single();
  return data;
}

async function auditRows(payloadId: string, orgId: string, action: string) {
  const { data } = await service
    .from("system_audit_logs")
    .select("action, log_meta")
    .eq("org_id", orgId)
    .eq("action", action)
    .filter("log_meta->>payloadId", "eq", payloadId);
  return data ?? [];
}

async function main(): Promise<void> {
  console.log("U-I-OS stage-5 parse check\n==========================");

  const orgA = await makeFreeOrg("A");
  pass(`Free-tier test org A=${orgA.slice(0, 8)}.`);

  try {
    // ── 1. CSV HAPPY PATH (via drainQueue routing 'upload/scanned') ──────────
    section("1. CSV HAPPY — drainQueue routes 'upload/scanned' → parseUpload");
    {
      const { payloadId } = await setupFinalizedUpload(orgA, "happy.csv", "a,b\n1,2\n3,4\n");
      await markClean(payloadId, orgA);
      resetQueue();
      enqueue({ name: "upload/scanned", data: { orgId: orgA, payloadId } });
      await drainQueue({ db: service });

      const row = await rowOf(payloadId, orgA);
      check(row?.status === "completed", `status → 'completed' (got ${row?.status})`);
      const ej = row?.extracted_json as Record<string, unknown> | null;
      check(eq(ej?.columns, ["a", "b"]), `columns parsed = ["a","b"] (got ${JSON.stringify(ej?.columns)})`);
      check(eq(ej?.rows, [["1", "2"], ["3", "4"]]), `rows parsed (got ${JSON.stringify(ej?.rows)})`);
      check(ej?.rowCount === 2, `rowCount = 2 (got ${ej?.rowCount})`);
      check(ej?.parser === "static-mvp", `parser marker = 'static-mvp' (got ${ej?.parser})`);
      const audits = await auditRows(payloadId, orgA, "upload.parsed");
      check(audits.length === 1, "upload.parsed audit row exists");
    }

    // ── 2. FULL CHAIN ('upload/finalized' → scan → parse) ────────────────────
    section("2. FULL CHAIN — scan → handoff → parse in one drain");
    {
      const { payloadId } = await setupFinalizedUpload(orgA, "chain.csv", "x,y\n9,8\n");
      resetQueue();
      enqueue({ name: "upload/finalized", data: { orgId: orgA, payloadId } });
      await drainQueue({ db: service });

      const row = await rowOf(payloadId, orgA);
      check(row?.scan_status === "clean", `scanned clean (got ${row?.scan_status})`);
      check(row?.status === "completed", `parsed → 'completed' (got ${row?.status})`);
      const ej = row?.extracted_json as Record<string, unknown> | null;
      check(eq(ej?.columns, ["x", "y"]) && ej?.rowCount === 1, "extracted_json populated by the chain");
      const scanAudit = await auditRows(payloadId, orgA, "upload.scan_clean");
      const parseAudit = await auditRows(payloadId, orgA, "upload.parsed");
      check(scanAudit.length === 1 && parseAudit.length === 1, "both scan_clean + parsed audit rows present");
    }

    // ── 3. TRUNCATION (tiny injected maxRows) ────────────────────────────────
    section("3. TRUNCATION — exceeds injected maxRows → truncated, still completes");
    {
      const { payloadId } = await setupFinalizedUpload(
        orgA,
        "big.csv",
        "h1,h2\n1,1\n2,2\n3,3\n4,4\n5,5\n"
      );
      await markClean(payloadId, orgA);
      const tinyLimits: ParseLimits = { maxRows: 2, maxCols: 512, maxFieldLen: 10_000, maxCells: 500_000 };
      const r = await parseUpload({ orgId: orgA, payloadId }, { db: service, limits: tinyLimits });
      check(r.ok && r.outcome === "parsed", `parsed (got ${JSON.stringify(r)})`);

      const row = await rowOf(payloadId, orgA);
      check(row?.status === "completed", `status → 'completed' (got ${row?.status})`);
      const ej = row?.extracted_json as Record<string, unknown> | null;
      check(ej?.truncated === true, `truncated = true (got ${ej?.truncated})`);
      check(ej?.rowCount === 1, `rowCount clipped to 1 of 5 (got ${ej?.rowCount})`);
    }

    // ── 4. CSV CORRECTNESS (quotes, embedded comma + newline, escaped quote) ─
    section("4. CSV CORRECTNESS — quoted/embedded/escaped fields");
    {
      const body = 'name,note\n"Smith, John","She said ""hi"""\n"multi\nline","ok"\n';
      const { payloadId } = await setupFinalizedUpload(orgA, "tricky.csv", body);
      await markClean(payloadId, orgA);
      const r = await parseUpload({ orgId: orgA, payloadId }, { db: service });
      check(r.ok && r.outcome === "parsed", `parsed (got ${JSON.stringify(r)})`);

      const ej = (await rowOf(payloadId, orgA))?.extracted_json as Record<string, unknown> | null;
      check(eq(ej?.columns, ["name", "note"]), `header = ["name","note"] (got ${JSON.stringify(ej?.columns)})`);
      check(
        eq(ej?.rows, [["Smith, John", 'She said "hi"'], ["multi\nline", "ok"]]),
        `embedded comma/newline + escaped quote parsed (got ${JSON.stringify(ej?.rows)})`
      );
      check(ej?.rowCount === 2, `rowCount = 2 (got ${ej?.rowCount})`);
    }

    // ── 5. PDF DEFERRAL ──────────────────────────────────────────────────────
    section("5. PDF DEFERRAL — held, not parsed in-process");
    {
      const { payloadId } = await setupFinalizedUpload(
        orgA,
        "doc.pdf",
        "%PDF-1.4 not really a pdf",
        "application/pdf"
      );
      await markClean(payloadId, orgA);
      const r = await parseUpload({ orgId: orgA, payloadId }, { db: service });
      check(r.ok && r.outcome === "deferred_pdf", `outcome 'deferred_pdf' (got ${JSON.stringify(r)})`);

      const row = await rowOf(payloadId, orgA);
      check(row?.status === "processing", `status STAYS 'processing' (got ${row?.status})`);
      check(row?.extracted_json === null, `extracted_json STAYS null (got ${JSON.stringify(row?.extracted_json)})`);
      const audits = await auditRows(payloadId, orgA, "parse.deferred");
      const reasonOk =
        audits.length === 1 &&
        (audits[0].log_meta as { reason?: string } | null)?.reason === "pdf_parsing_requires_sandbox";
      check(reasonOk, "parse.deferred audit row with reason 'pdf_parsing_requires_sandbox'");
    }

    // ── 6. IDEMPOTENCY ───────────────────────────────────────────────────────
    section("6. IDEMPOTENCY — second parse is a no-op");
    {
      const { payloadId } = await setupFinalizedUpload(orgA, "idem.csv", "k,v\n7,7\n");
      await markClean(payloadId, orgA);
      const first = await parseUpload({ orgId: orgA, payloadId }, { db: service });
      check(first.ok && first.outcome === "parsed", `first parse → parsed (got ${JSON.stringify(first)})`);
      const ejAfterFirst = (await rowOf(payloadId, orgA))?.extracted_json;

      const second = await parseUpload({ orgId: orgA, payloadId }, { db: service });
      check(second.ok && second.outcome === "skipped", `second parse → skipped (got ${JSON.stringify(second)})`);

      const audits = await auditRows(payloadId, orgA, "upload.parsed");
      check(audits.length === 1, `single upload.parsed audit row (no double-parse, got ${audits.length})`);
      const ejAfterSecond = (await rowOf(payloadId, orgA))?.extracted_json;
      check(eq(ejAfterFirst, ejAfterSecond), "extracted_json unchanged by the second call");
    }
  } finally {
    section("7. Cleanup");
    if (createdPaths.length > 0) {
      const { error } = await service.storage.from(INBOUND_BUCKET).remove(createdPaths);
      if (error) fail(`storage cleanup error: ${error.message}`);
      else pass(`removed ${createdPaths.length} storage object(s)`);
    }
    if (createdPayloadIds.length > 0) {
      const { error } = await service.from("inbound_payloads").delete().in("id", createdPayloadIds);
      if (error) fail(`row cleanup error: ${error.message}`);
      else pass(`deleted ${createdPayloadIds.length} payload row(s)`);
    }
    resetQueue();
    console.log("  ℹ Test orgs + their audit rows remain by design (audit immutability).");
  }

  console.log("\n==========================");
  if (failures === 0) {
    console.log("RESULT: PASS — stage-5 parse: CSV extraction, truncation, correctness, PDF deferral, idempotency, full chain. ✓");
    process.exit(0);
  } else {
    console.error(`RESULT: FAIL — ${failures} check(s) failed (see above).`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nUnexpected error:");
  console.error(err);
  process.exit(1);
});
