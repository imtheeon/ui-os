/**
 * src/check-scan.ts
 *
 * Verifies Phase 5 STAGE 4 (scanUpload, the placeholder malware scan) against
 * the live database + Storage. Run with: npm run check:scan
 *
 * Proves, with an injected service-role client and injected fake scanners:
 *   1. CLEAN  (default placeholder scanner): scan_status → 'clean', an
 *      upload.scan_clean audit row exists WITH stub:true in log_meta, and an
 *      'upload/scanned' handoff event is emitted. PLUS a seam smoke: drainQueue
 *      routes an 'upload/finalized' event to scanUpload for real.
 *   2. INFECTED (injected scanner → 'infected'): scan_status → 'infected',
 *      status → 'failed', the storage object is DELETED, an upload.scan_infected
 *      audit row exists, and NO handoff is emitted.
 *   3. ERROR (injected scanner throws): scan_status → 'error', status →
 *      'failed', no handoff.
 *   4. IDEMPOTENCY: a second scanUpload on the same payload returns skipped:true
 *      and does not re-process or re-emit.
 *
 * Loads .env.local explicitly and injects { db: service } so nothing touches
 * the lazy db.ts default. resetQueue() isolates each case.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createUploadSlot, finalizeUpload, INBOUND_BUCKET } from "./lib/uploads";
import { scanUpload, type Scanner } from "./lib/scan-upload";
import { enqueue, drainQueue, resetQueue, pendingCount, type UiEvent } from "./lib/queue";

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
    .insert({ name: `__scan_test_${tag}_${Date.now()}` })
    .select("id")
    .single();
  if (error || !data) throw new Error(`makeFreeOrg(${tag}) failed: ${error?.message}`);
  return data.id;
}

/** slot → raw PUT → finalize, leaving a real 'processing'/'pending' upload row
 *  with a stored object. Returns its id + storage path. */
async function setupFinalizedUpload(
  orgId: string,
  filename: string,
  body: string
): Promise<{ payloadId: string; path: string }> {
  const slot = await createUploadSlot(
    { orgId, filename, contentType: "text/csv", declaredSize: body.length },
    { db: service }
  );
  if (!slot.ok) throw new Error(`slot failed for ${filename}: ${slot.code} ${slot.message}`);
  createdPaths.push(slot.path);
  createdPayloadIds.push(slot.payloadId);

  const put = await fetch(slot.signedUrl, {
    method: "PUT",
    headers: { "content-type": "text/csv", "x-upsert": "true" },
    body,
  });
  if (put.status !== 200) throw new Error(`raw PUT failed (${put.status}) for ${filename}`);

  const fin = await finalizeUpload({ orgId, payloadId: slot.payloadId }, { db: service });
  if (!fin.ok) throw new Error(`finalize failed for ${filename}: ${fin.code}`);
  return { payloadId: slot.payloadId, path: slot.path };
}

async function rowOf(payloadId: string, orgId: string) {
  const { data } = await service
    .from("inbound_payloads")
    .select("status, scan_status")
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
  console.log("U-I-OS stage-4 scan check\n=========================");

  const orgA = await makeFreeOrg("A");
  const orgB = await makeFreeOrg("B");
  pass(`Free-tier test orgs A=${orgA.slice(0, 8)} B=${orgB.slice(0, 8)}.`);

  try {
    // ── 1. CLEAN path (default placeholder scanner) ──────────────────────────
    section("1. CLEAN — placeholder scanner passes, emits handoff");
    {
      const { payloadId } = await setupFinalizedUpload(orgA, "clean.csv", "a,b\n1,2\n");
      resetQueue();
      const emitted: UiEvent[] = [];
      const spy = (e: UiEvent) => emitted.push(e);

      const r = await scanUpload({ orgId: orgA, payloadId }, { db: service, enqueue: spy });
      check(r.ok && r.verdict === "clean", `scanUpload → clean (got ${JSON.stringify(r)})`);

      const row = await rowOf(payloadId, orgA);
      check(row?.scan_status === "clean", `scan_status → 'clean' (got ${row?.scan_status})`);

      const audits = await auditRows(payloadId, orgA, "upload.scan_clean");
      const stubFlagged =
        audits.length === 1 && (audits[0].log_meta as { stub?: boolean } | null)?.stub === true;
      check(stubFlagged, "exactly one upload.scan_clean audit row, log_meta.stub === true");

      const handoff =
        emitted.length === 1 &&
        emitted[0].name === "upload/scanned" &&
        emitted[0].data.payloadId === payloadId &&
        emitted[0].data.orgId === orgA;
      check(handoff, `emitted exactly one 'upload/scanned' handoff (got ${JSON.stringify(emitted)})`);
    }

    // ── 1b. SEAM smoke — drainQueue routes 'upload/finalized' → scanUpload ────
    section("1b. SEAM — drainQueue routes 'upload/finalized' to scanUpload");
    {
      const { payloadId } = await setupFinalizedUpload(orgA, "seam.csv", "x,y\n3,4\n");
      resetQueue();
      enqueue({ name: "upload/finalized", data: { orgId: orgA, payloadId } });
      await drainQueue({ db: service });

      const row = await rowOf(payloadId, orgA);
      check(row?.scan_status === "clean", `drained → scan_status 'clean' (got ${row?.scan_status})`);
      // scanUpload enqueued 'upload/scanned'; drainQueue consumed+warned it → empty.
      check(pendingCount() === 0, `queue fully drained (pendingCount=${pendingCount()})`);
    }

    // ── 2. INFECTED path (injected scanner → 'infected') ─────────────────────
    section("2. INFECTED — quarantine by removal, no handoff");
    {
      const { payloadId, path } = await setupFinalizedUpload(orgB, "infected.csv", "m,n\n5,6\n");
      resetQueue();
      const emitted: UiEvent[] = [];
      const fakeInfected: Scanner = { async scan() { return "infected"; } };

      const r = await scanUpload(
        { orgId: orgB, payloadId },
        { db: service, scanner: fakeInfected, enqueue: (e) => emitted.push(e) }
      );
      check(r.ok && r.verdict === "infected", `scanUpload → infected (got ${JSON.stringify(r)})`);

      const row = await rowOf(payloadId, orgB);
      check(row?.scan_status === "infected", `scan_status → 'infected' (got ${row?.scan_status})`);
      check(row?.status === "failed", `status → 'failed' (got ${row?.status})`);

      const folder = path.slice(0, path.lastIndexOf("/"));
      const fname = path.slice(path.lastIndexOf("/") + 1);
      const { data: list } = await service.storage.from(INBOUND_BUCKET).list(folder);
      const stillThere = (list ?? []).some((o) => o.name === fname);
      check(!stillThere, "storage object DELETED (quarantine by removal)");

      const audits = await auditRows(payloadId, orgB, "upload.scan_infected");
      check(audits.length === 1, "upload.scan_infected audit row exists");
      check(emitted.length === 0, "NO 'upload/scanned' handoff emitted for infected file");
    }

    // ── 3. ERROR path (injected scanner throws) ──────────────────────────────
    section("3. ERROR — scanner throws → fail closed, no handoff");
    {
      const { payloadId } = await setupFinalizedUpload(orgB, "error.csv", "p,q\n7,8\n");
      resetQueue();
      const emitted: UiEvent[] = [];
      const fakeThrow: Scanner = { async scan() { throw new Error("scanner exploded"); } };

      const r = await scanUpload(
        { orgId: orgB, payloadId },
        { db: service, scanner: fakeThrow, enqueue: (e) => emitted.push(e) }
      );
      check(r.ok && r.verdict === "error", `scanUpload → error (got ${JSON.stringify(r)})`);

      const row = await rowOf(payloadId, orgB);
      check(row?.scan_status === "error", `scan_status → 'error' (got ${row?.scan_status})`);
      check(row?.status === "failed", `status → 'failed' (got ${row?.status})`);
      check(emitted.length === 0, "NO handoff emitted on scanner error");
    }

    // ── 4. IDEMPOTENCY ───────────────────────────────────────────────────────
    section("4. IDEMPOTENCY — second scan is a no-op");
    {
      const { payloadId } = await setupFinalizedUpload(orgA, "idem.csv", "r,s\n9,0\n");
      resetQueue();
      const emitted: UiEvent[] = [];
      const spy = (e: UiEvent) => emitted.push(e);

      const first = await scanUpload({ orgId: orgA, payloadId }, { db: service, enqueue: spy });
      check(first.ok && first.verdict === "clean" && !first.skipped, "first scan → clean (not skipped)");

      const second = await scanUpload({ orgId: orgA, payloadId }, { db: service, enqueue: spy });
      check(second.ok && second.skipped === true, `second scan → skipped:true (got ${JSON.stringify(second)})`);

      check(emitted.length === 1, `handoff emitted ONCE across both calls (got ${emitted.length})`);
      const audits = await auditRows(payloadId, orgA, "upload.scan_clean");
      check(audits.length === 1, `single upload.scan_clean audit row (no double-audit, got ${audits.length})`);
    }
  } finally {
    section("5. Cleanup");
    if (createdPaths.length > 0) {
      // Some objects were deleted by the infected path; remove() of a missing
      // key is a harmless no-op.
      const { error } = await service.storage.from(INBOUND_BUCKET).remove(createdPaths);
      if (error) fail(`storage cleanup error: ${error.message}`);
      else pass(`removed ${createdPaths.length} storage object(s) (missing ones no-op)`);
    }
    if (createdPayloadIds.length > 0) {
      const { error } = await service.from("inbound_payloads").delete().in("id", createdPayloadIds);
      if (error) fail(`row cleanup error: ${error.message}`);
      else pass(`deleted ${createdPayloadIds.length} payload row(s)`);
    }
    resetQueue();
    console.log("  ℹ Test orgs + their audit rows remain by design (audit immutability).");
  }

  console.log("\n=========================");
  if (failures === 0) {
    console.log("RESULT: PASS — stage-4 scan: clean/infected/error verdicts, handoff gating, idempotency. ✓");
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
