/**
 * src/check-upload.ts
 *
 * Verifies the Phase 5 upload pipeline (stages 1-3) against the live database
 * and Storage. Run with: npm run check:upload
 *
 * Proves, with an injected service-role client:
 *   1. POSITIVE: slot → real direct upload → finalize → row is 'processing',
 *      size recorded from ACTUAL bytes, scan_status still 'pending'.
 *   2. The gate guards the slot: a nonexistent org is blocked, no row created.
 *   3. Content-type/extension validation rejects non-csv/pdf at the slot.
 *   4. Declared oversize is rejected at the slot.
 *   5. Finalize is org-scoped: org B cannot finalize org A's payload.
 *   6. Finalize enforces the REAL size limit (tiny injected maxBytes) and
 *      deletes the offending object.
 *
 * Loads .env.local explicitly and injects { db: service } so the upload
 * functions never touch their lazy db.ts default.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createUploadSlot,
  finalizeUpload,
  INBOUND_BUCKET,
} from "./lib/uploads";

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
    .insert({ name: `__upload_test_${tag}_${Date.now()}` })
    .select("id")
    .single();
  if (error || !data) throw new Error(`makeFreeOrg(${tag}) failed: ${error?.message}`);
  return data.id;
}

async function main(): Promise<void> {
  console.log("U-I-OS upload pipeline check\n============================");

  const orgA = await makeFreeOrg("A");
  const orgB = await makeFreeOrg("B");
  pass(`Free-tier test orgs A=${orgA.slice(0, 8)} B=${orgB.slice(0, 8)}.`);

  try {
    // ── 1. POSITIVE round trip ───────────────────────────────────────────
    section("1. POSITIVE — slot → direct upload → finalize");
    const csv = Buffer.from("col1,col2\n1,2\n3,4\n", "utf8");
    const slot = await createUploadSlot(
      { orgId: orgA, filename: "report.csv", contentType: "text/csv", declaredSize: csv.byteLength },
      { db: service }
    );
    check(slot.ok, "slot issued");
    if (slot.ok) {
      createdPaths.push(slot.path);
      createdPayloadIds.push(slot.payloadId);
      check(slot.path.startsWith(`${orgA}/`), `storage path is org-scoped (${slot.path})`);

      // row exists, pending + scan pending
      const { data: row0 } = await service
        .from("inbound_payloads")
        .select("status, scan_status, source")
        .eq("id", slot.payloadId).eq("org_id", orgA).single();
      check(row0?.status === "pending" && row0?.scan_status === "pending" && row0?.source === "upload",
        `row created pending/pending/upload (got ${row0?.status}/${row0?.scan_status}/${row0?.source})`);

      // real upload via the signed URL
      const { error: upErr } = await service.storage
        .from(INBOUND_BUCKET)
        .uploadToSignedUrl(slot.path, slot.token, csv, { contentType: "text/csv" });
      check(!upErr, `uploaded ${csv.byteLength} bytes to the signed URL`);

      const fin = await finalizeUpload({ orgId: orgA, payloadId: slot.payloadId }, { db: service });
      check(fin.ok && fin.status === "processing", "finalize → processing");

      const { data: row1 } = await service
        .from("inbound_payloads")
        .select("status, size_bytes, scan_status")
        .eq("id", slot.payloadId).eq("org_id", orgA).single();
      check(row1?.status === "processing", `row now processing (got ${row1?.status})`);
      check(row1?.size_bytes === csv.byteLength, `size from ACTUAL bytes (${row1?.size_bytes})`);
      check(row1?.scan_status === "pending", "scan_status still pending (for the deferred scan worker)");
    }

    // ── 2. Gate guards the slot ──────────────────────────────────────────
    section("2. NEGATIVE — gate blocks a nonexistent org, no row created");
    const fakeOrg = randomUUID();
    const blocked = await createUploadSlot(
      { orgId: fakeOrg, filename: "x.csv", contentType: "text/csv", declaredSize: 10 },
      { db: service }
    );
    check(!blocked.ok, "slot refused");
    if (!blocked.ok) check(blocked.httpStatus === 403 && blocked.code === "TIER_INDETERMINATE",
      `403 TIER_INDETERMINATE (got ${blocked.httpStatus} ${blocked.code})`);
    const { count: fakeRows } = await service
      .from("inbound_payloads").select("id", { count: "exact", head: true }).eq("org_id", fakeOrg);
    check((fakeRows ?? 0) === 0, "no payload row created for the blocked org");

    // ── 3. Content-type / extension validation ───────────────────────────
    section("3. NEGATIVE — non-csv/pdf rejected at the slot");
    const badType = await createUploadSlot(
      { orgId: orgA, filename: "malware.exe", contentType: "application/x-msdownload", declaredSize: 10 },
      { db: service }
    );
    check(!badType.ok && badType.code === "INVALID_UPLOAD",
      "rejected .exe / disallowed content-type");

    // ── 4. Declared oversize rejected at the slot ────────────────────────
    section("4. NEGATIVE — declared oversize rejected at the slot");
    const tooBig = await createUploadSlot(
      { orgId: orgA, filename: "big.pdf", contentType: "application/pdf", declaredSize: 26 * 1024 * 1024 },
      { db: service }
    );
    check(!tooBig.ok && tooBig.code === "INVALID_UPLOAD", "rejected declared 26MB > 25MB");

    // ── 5. Finalize is org-scoped ────────────────────────────────────────
    section("5. NEGATIVE — org B cannot finalize org A's payload");
    if (createdPayloadIds.length > 0) {
      const crossTenant = await finalizeUpload(
        { orgId: orgB, payloadId: createdPayloadIds[0] },
        { db: service }
      );
      check(!crossTenant.ok && crossTenant.code === "NOT_FOUND",
        "cross-tenant finalize → NOT_FOUND");
    } else {
      fail("no payload available for cross-tenant test");
    }

    // ── 6. Finalize enforces REAL size (tiny injected maxBytes) ──────────
    section("6. NEGATIVE — finalize rejects actual-oversize + deletes object");
    const csv2 = Buffer.from("a,b,c\n1,2,3\n", "utf8"); // ~12 bytes
    const slot2 = await createUploadSlot(
      { orgId: orgA, filename: "small.csv", contentType: "text/csv", declaredSize: csv2.byteLength },
      { db: service }
    );
    if (slot2.ok) {
      createdPayloadIds.push(slot2.payloadId);
      await service.storage.from(INBOUND_BUCKET).uploadToSignedUrl(slot2.path, slot2.token, csv2, { contentType: "text/csv" });
      // Force a finalize-time size violation by capping maxBytes below the file.
      const rejected = await finalizeUpload(
        { orgId: orgA, payloadId: slot2.payloadId },
        { db: service, maxBytes: 5 }
      );
      check(!rejected.ok && rejected.code === "FILE_TOO_LARGE",
        "actual-size > injected maxBytes → FILE_TOO_LARGE");
      const { data: row2 } = await service
        .from("inbound_payloads").select("status").eq("id", slot2.payloadId).eq("org_id", orgA).single();
      check(row2?.status === "failed", `row marked failed (got ${row2?.status})`);
      const { data: leftover } = await service.storage.from(INBOUND_BUCKET).list(`${orgA}/${slot2.payloadId}`);
      check((leftover ?? []).length === 0, "offending object deleted from Storage");
    } else {
      fail("could not create slot2 for the finalize-size test");
    }
  } finally {
    section("7. Cleanup");
    // Remove any storage objects we left behind.
    if (createdPaths.length > 0) {
      const { error } = await service.storage.from(INBOUND_BUCKET).remove(createdPaths);
      if (error) fail(`storage cleanup error: ${error.message}`);
      else pass(`removed ${createdPaths.length} storage object(s)`);
    }
    // Delete the payload rows (inbound_payloads has no immutability trigger).
    if (createdPayloadIds.length > 0) {
      const { error } = await service.from("inbound_payloads").delete().in("id", createdPayloadIds);
      if (error) fail(`row cleanup error: ${error.message}`);
      else pass(`deleted ${createdPayloadIds.length} payload row(s)`);
    }
    console.log("  ℹ Test orgs + their audit rows remain by design (audit immutability).");
  }

  console.log("\n============================");
  if (failures === 0) {
    console.log("RESULT: PASS — upload slot + finalize enforce tier, org-scoping, and real size. ✓");
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
