/**
 * check:agents — exercises the Ruflo swarm against the real Supabase DB using a
 * throwaway org and the injected stubBrain (zero real tokens). Grows across
 * Phase 6 tasks. Run with `npm run check:agents` (no dev server needed for the
 * function-level cases).
 *
 * Loads .env.local explicitly and builds its own service-role client, then
 * injects it as deps.db into every swarm function — mirrors check-parse.ts, and
 * avoids importing ./db (whose import-time env guard reads .env, not .env.local).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { validateProposal } from "./lib/agent-actions";
import { applyAction } from "./lib/executor";
import { getOrgContext } from "./lib/org-context";
import type { AgentBrain } from "./lib/agent-brain";
import type { UiEvent } from "./lib/queue";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "..", ".env.local"), quiet: true });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing service-role env in .env.local. Run `npm run db:check` first.");
  process.exit(1);
}
const db: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

async function makeOrg(tier: "free" | "pro" = "pro"): Promise<string> {
  const { data, error } = await db
    .from("organizations")
    .insert({ name: `__agents_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, subscription_tier: tier })
    .select("id").single();
  if (error) throw new Error(`makeOrg: ${error.message}`);
  return data.id as string;
}

// A completed upload payload to attach runs/actions to.
async function makePayload(orgId: string): Promise<string> {
  const { data, error } = await db
    .from("inbound_payloads")
    .insert({
      org_id: orgId, source: "upload", storage_path: `${orgId}/x/test.csv`,
      original_filename: "test.csv", mime_type: "text/csv",
      scan_status: "clean", status: "completed",
      extracted_json: { columns: ["amount"], rowCount: 1, rows: [["10"]], truncated: false, parser: "static-mvp" },
    })
    .select("id").single();
  if (error) throw new Error(`makePayload: ${error.message}`);
  return data.id as string;
}

async function makeRun(orgId: string, payloadId: string): Promise<string> {
  const { data, error } = await db
    .from("agent_runs")
    .insert({ org_id: orgId, payload_id: payloadId, role: "accountant", status: "completed", brain: "stub" })
    .select("id").single();
  if (error) throw new Error(`makeRun: ${error.message}`);
  return data.id as string;
}

async function main() {
  console.log("== validateProposal ==");
  ok("rejects unknown kind", !validateProposal("delete_everything", {}).ok);
  ok("rejects bad amount", !validateProposal("record_ledger_entry", { description: "x", amount_cents: -5, direction: "debit" }).ok);
  ok("accepts good ledger entry", validateProposal("record_ledger_entry", { description: "Office supplies", amount_cents: 1299, direction: "debit" }).ok);
  ok("accepts good report", validateProposal("store_report", { title: "Q", body: "B" }).ok);
  ok("clamps oversize string", (() => {
    const r = validateProposal("store_report", { title: "x".repeat(5000), body: "b" });
    return r.ok && (r.payload.title as string).length === 2000;
  })());

  console.log("== executor ==");
  const orgA = await makeOrg("pro");
  const payloadA = await makePayload(orgA);
  const runA = await makeRun(orgA, payloadA);
  const { data: actA } = await db.from("proposed_actions").insert({
    org_id: orgA, payload_id: payloadA, agent_run_id: runA,
    kind: "record_ledger_entry", rationale: "test",
    action_payload: { description: "Office supplies", amount_cents: 1299, direction: "debit" },
  }).select("*").single();

  type ActionRow = { id: string; org_id: string; payload_id: string; kind: string; action_payload: Record<string, unknown> };
  const applied = await applyAction(actA as ActionRow, { db, orgId: orgA });
  ok("applyAction writes ledger_entries", applied.ok && applied.recordTable === "ledger_entries", JSON.stringify(applied));
  if (applied.ok) {
    const { data: row } = await db.from("ledger_entries").select("org_id, amount_cents").eq("id", applied.recordId).single();
    ok("record is org-stamped by code", row?.org_id === orgA && row?.amount_cents === 1299);
  }

  ok("applyAction rejects org mismatch", !(await applyAction({ ...(actA as ActionRow), org_id: randomUUID() }, { db, orgId: orgA })).ok);

  // cleanup (cascades from org delete)
  await db.from("organizations").delete().eq("id", orgA);

  console.log("== model tiers ==");
  const { modelForRole } = await import("./lib/agent-brain");
  ok("accountant → haiku model", modelForRole("accountant") === "claude-haiku-4-5-20251001");
  ok("analyst → sonnet model", modelForRole("analyst") === "claude-sonnet-4-6");

  console.log("== brain (stub) ==");
  const { stubBrain } = await import("./lib/agent-brain");
  const acc = await stubBrain.propose({ role: "accountant", columns: ["amount"], sampleRows: [["10"]], rowCount: 1 });
  ok("stub accountant proposes a ledger entry", acc.proposals[0]?.kind === "record_ledger_entry" && acc.brain === "stub");
  const ana = await stubBrain.propose({ role: "analyst", columns: ["x"], sampleRows: [["y"]], rowCount: 1 });
  ok("stub analyst proposes a report", ana.proposals[0]?.kind === "store_report");

  console.log("== runAgent ==");
  const { runAgent } = await import("./lib/run-agent");
  const { stubBrain: sb } = await import("./lib/agent-brain");

  // proposals land pending + org-stamped
  const orgB = await makeOrg("pro");
  const payloadB = await makePayload(orgB);
  const r1 = await runAgent({ orgId: orgB, payloadId: payloadB, role: "accountant" }, { db, brain: sb });
  ok("runAgent ok", r1.ok && r1.proposalCount === 1, JSON.stringify(r1));
  const { data: pendB } = await db.from("proposed_actions").select("org_id,status,kind").eq("org_id", orgB);
  ok("proposal is pending + org-stamped", pendB?.length === 1 && pendB[0].status === "pending" && pendB[0].org_id === orgB);

  // org scoping: org C cannot see org B's proposals via a scoped read
  const orgC = await makeOrg("pro");
  const { data: seenByC } = await db.from("proposed_actions").select("id").eq("org_id", orgC).eq("payload_id", payloadB);
  ok("org C sees none of org B's proposals", (seenByC?.length ?? 0) === 0);

  // identity integrity: stub brain that injects a foreign org_id in payload
  const evilBrain: AgentBrain = { async propose() { return { brain: "stub", inputTokens: 0, outputTokens: 0,
    proposals: [{ kind: "store_report", action_payload: { title: "t", body: "b", org_id: orgC }, rationale: "r" }] }; } };
  const payloadB2 = await makePayload(orgB);
  await runAgent({ orgId: orgB, payloadId: payloadB2, role: "analyst" }, { db, brain: evilBrain });
  const { data: evilRows } = await db.from("proposed_actions").select("org_id").eq("payload_id", payloadB2);
  ok("model-supplied org_id ignored; row stamped with event org", evilRows?.every((r) => r.org_id === orgB) ?? false);

  // injection smoke: unknown kind → rejected, no row
  const badBrain: AgentBrain = { async propose() { return { brain: "stub", inputTokens: 0, outputTokens: 0,
    proposals: [{ kind: "wire_money", action_payload: { to: "attacker" }, rationale: "x" }] }; } };
  const payloadB3 = await makePayload(orgB);
  const r2 = await runAgent({ orgId: orgB, payloadId: payloadB3, role: "accountant" }, { db, brain: badBrain });
  ok("unknown kind produces zero proposals", r2.ok && r2.proposalCount === 0);

  // tier gate: free org → skipped_tier, no proposals
  const orgFree = await makeOrg("free");
  const payloadF = await makePayload(orgFree);
  const rf = await runAgent({ orgId: orgFree, payloadId: payloadF, role: "accountant" }, { db, brain: sb });
  ok("free tier skipped", rf.ok && rf.skippedTier === true && rf.proposalCount === 0);
  const { data: freeProps } = await db.from("proposed_actions").select("id").eq("org_id", orgFree);
  ok("free tier wrote no proposals", (freeProps?.length ?? 0) === 0);

  for (const o of [orgB, orgC, orgFree]) await db.from("organizations").delete().eq("id", o);

  console.log("== manager ==");
  const { looksFinancial, routePayload } = await import("./lib/manager");
  ok("looksFinancial true on amount", looksFinancial(["name", "Amount"]));
  ok("looksFinancial false on plain", !looksFinancial(["name", "city"]));

  const orgD = await makeOrg("pro");
  const finPayload = await makePayload(orgD); // extracted_json has 'amount' column
  const enq: UiEvent[] = [];
  const route = await routePayload({ orgId: orgD, payloadId: finPayload }, { db, enqueue: (e) => enq.push(e) });
  ok("financial routes to [anomaly_detector, categorizer, data_cleaner, accountant, analyst]", route.ok && JSON.stringify(route.plan) === JSON.stringify(["anomaly_detector", "categorizer", "data_cleaner", "accountant", "analyst"]));
  ok("five agent/run events enqueued", enq.length === 5 && enq.every((e) => e.name === "agent/run"));

  // non-financial → analyst only
  const { data: plainPayload } = await db.from("inbound_payloads").insert({
    org_id: orgD, source: "upload", storage_path: `${orgD}/y/z.csv`, original_filename: "z.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const enq2: UiEvent[] = [];
  const route2 = await routePayload({ orgId: orgD, payloadId: plainPayload!.id }, { db, enqueue: (e) => enq2.push(e) });
  ok("non-financial routes to [anomaly_detector, categorizer, data_cleaner, analyst]", route2.ok && JSON.stringify(route2.plan) === JSON.stringify(["anomaly_detector", "categorizer", "data_cleaner", "analyst"]));

  await db.from("organizations").delete().eq("id", orgD);

  console.log("== full chain (manager → agent/run handoff) ==");
  const { resetQueue } = await import("./lib/queue");
  const { runAgent: runAgent2 } = await import("./lib/run-agent");
  const { stubBrain: sb2 } = await import("./lib/agent-brain");
  const { routePayload: route3 } = await import("./lib/manager");
  resetQueue();
  const orgE = await makeOrg("pro");
  const payloadE = await makePayload(orgE); // financial (amount col)

  // Route via the Manager, capturing the enqueued agent/run events, then run
  // each with the stub brain — proves routing + handoff without real tokens
  // (drainQueue's agent/run case would use the real claudeBrain).
  const captured: UiEvent[] = [];
  await route3({ orgId: orgE, payloadId: payloadE }, { db, enqueue: (e) => captured.push(e) });
  ok("manager enqueued anomaly_detector+categorizer+data_cleaner+accountant+analyst", captured.length === 5);
  for (const e of captured) {
    if (e.name === "agent/run") await runAgent2(e.data, { db, brain: sb2 });
  }
  const { data: chainProps } = await db.from("proposed_actions").select("kind").eq("org_id", orgE);
  ok("chain produced 5 proposals (anomaly + categorization + cleanup + ledger + report)", chainProps?.length === 5);
  await db.from("organizations").delete().eq("id", orgE);
  resetQueue();

  console.log("== approval gate (service level) ==");
  const { approveAction, rejectAction, listPending } = await import("./lib/actions-service");
  const { runAgent: runAgent3 } = await import("./lib/run-agent");
  const { stubBrain: sb3 } = await import("./lib/agent-brain");
  const decider = randomUUID();

  // approve → execute writes a record + flips to applied
  const orgG = await makeOrg("pro");
  const payloadG = await makePayload(orgG);
  await runAgent3({ orgId: orgG, payloadId: payloadG, role: "accountant" }, { db, brain: sb3 });
  const pendingG = await listPending(orgG, { db });
  ok("listPending returns the pending action", pendingG.length === 1);
  const appr = await approveAction(orgG, pendingG[0].id, decider, { db });
  ok("approve writes ledger record", appr.ok && appr.recordTable === "ledger_entries", JSON.stringify(appr));
  const { data: ledgerG } = await db.from("ledger_entries").select("org_id").eq("org_id", orgG);
  ok("record exists, org-stamped", ledgerG?.length === 1 && ledgerG[0].org_id === orgG);
  const { data: actG } = await db.from("proposed_actions").select("status").eq("id", pendingG[0].id).single();
  ok("proposal flipped to applied", actG?.status === "applied");

  // double-approve idempotency → exactly one record
  const appr2 = await approveAction(orgG, pendingG[0].id, decider, { db });
  ok("second approve is no-op", !appr2.ok && appr2.code === "NOT_FOUND");
  const { data: ledgerG2 } = await db.from("ledger_entries").select("id").eq("org_id", orgG);
  ok("still exactly one record", ledgerG2?.length === 1);

  // cross-org approve is a 404 (can't approve another org's action)
  const orgH = await makeOrg("pro");
  const payloadH = await makePayload(orgH);
  await runAgent3({ orgId: orgH, payloadId: payloadH, role: "analyst" }, { db, brain: sb3 });
  const pendingH = await listPending(orgH, { db });
  const crossApprove = await approveAction(orgG, pendingH[0].id, decider, { db });
  ok("cannot approve another org's action", !crossApprove.ok && crossApprove.code === "NOT_FOUND");

  // reject → no record, status rejected
  const rej = await rejectAction(orgH, pendingH[0].id, decider, { db });
  ok("reject ok", rej.ok);
  const { data: reportsH } = await db.from("analyst_reports").select("id").eq("org_id", orgH);
  ok("reject wrote no record", (reportsH?.length ?? 0) === 0);

  for (const o of [orgG, orgH]) await db.from("organizations").delete().eq("id", o);

  console.log("== anomaly detector ==");
  ok("flag_anomaly accepts good", validateProposal("flag_anomaly", { description: "Outlier value 9e9", severity: "high", row_reference: "row 7" }).ok);
  ok("flag_anomaly rejects bad severity", !validateProposal("flag_anomaly", { description: "x", severity: "critical", row_reference: "row 1" }).ok);
  ok("anomaly_detector → haiku model", (await import("./lib/agent-brain")).modelForRole("anomaly_detector") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentAn } = await import("./lib/run-agent");
  const { stubBrain: sbAn } = await import("./lib/agent-brain");
  const { approveAction: approveAn, listPending: listAn } = await import("./lib/actions-service");
  const orgAn = await makeOrg("pro");
  const payloadAn = await makePayload(orgAn);
  const rAn = await runAgentAn({ orgId: orgAn, payloadId: payloadAn, role: "anomaly_detector" }, { db, brain: sbAn });
  ok("anomaly run produced a flag", rAn.ok && rAn.proposalCount === 1);
  const pendAn = await listAn(orgAn, { db });
  const apprAn = await approveAn(orgAn, pendAn[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes flagged_anomalies", apprAn.ok && apprAn.recordTable === "flagged_anomalies", JSON.stringify(apprAn));
  const { data: anRows } = await db.from("flagged_anomalies").select("org_id,severity").eq("org_id", orgAn);
  ok("anomaly record org-stamped", anRows?.length === 1 && anRows[0].org_id === orgAn);
  await db.from("organizations").delete().eq("id", orgAn);

  console.log("== categorizer ==");
  ok("categorize_items accepts good", validateProposal("categorize_items", {
    scheme: "expense_type", assignments: [{ row_reference: "row 1", category: "travel" }],
  }).ok);
  ok("categorize_items rejects missing scheme", !validateProposal("categorize_items", {
    scheme: "", assignments: [],
  }).ok);
  ok("categorize_items accepts empty assignments", validateProposal("categorize_items", {
    scheme: "product_line", assignments: [],
  }).ok);
  ok("categorizer → haiku model",
    (await import("./lib/agent-brain")).modelForRole("categorizer") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentCat } = await import("./lib/run-agent");
  const { stubBrain: sbCat } = await import("./lib/agent-brain");
  const { approveAction: approveCat, listPending: listCat } = await import("./lib/actions-service");
  const orgCat = await makeOrg("pro");
  const payloadCat = await makePayload(orgCat);
  const rCat = await runAgentCat({ orgId: orgCat, payloadId: payloadCat, role: "categorizer" }, { db, brain: sbCat });
  ok("categorizer run produced a categorization", rCat.ok && rCat.proposalCount === 1);
  const pendCat = await listCat(orgCat, { db });
  const apprCat = await approveCat(orgCat, pendCat[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes categorization_runs", apprCat.ok && apprCat.recordTable === "categorization_runs", JSON.stringify(apprCat));
  const { data: catRows } = await db.from("categorization_runs").select("org_id,scheme").eq("org_id", orgCat);
  ok("categorization record org-stamped", catRows?.length === 1 && catRows[0].org_id === orgCat);
  await db.from("organizations").delete().eq("id", orgCat);

  console.log("== data cleaner ==");
  ok("clean_data accepts good", validateProposal("clean_data", {
    issues: [{ row_reference: "row 1", column: "amount", issue_type: "extra_whitespace", original_value: " 10 ", suggested_value: "10" }],
    rows_affected: 1,
  }).ok);
  ok("clean_data rejects missing issues", !validateProposal("clean_data", {
    rows_affected: 1,
  }).ok);
  ok("clean_data rejects bad rows_affected", !validateProposal("clean_data", {
    issues: [], rows_affected: -1,
  }).ok);
  ok("data_cleaner → haiku model",
    (await import("./lib/agent-brain")).modelForRole("data_cleaner") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentDc } = await import("./lib/run-agent");
  const { stubBrain: sbDc } = await import("./lib/agent-brain");
  const { approveAction: approveDc, listPending: listDc } = await import("./lib/actions-service");
  const orgDc = await makeOrg("pro");
  const payloadDc = await makePayload(orgDc);
  const rDc = await runAgentDc({ orgId: orgDc, payloadId: payloadDc, role: "data_cleaner" }, { db, brain: sbDc });
  ok("data_cleaner run produced a cleanup proposal", rDc.ok && rDc.proposalCount === 1);
  const pendDc = await listDc(orgDc, { db });
  const apprDc = await approveDc(orgDc, pendDc[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes cleaned_data_runs", apprDc.ok && apprDc.recordTable === "cleaned_data_runs", JSON.stringify(apprDc));
  const { data: dcRows } = await db.from("cleaned_data_runs").select("org_id,rows_affected").eq("org_id", orgDc);
  ok("cleaned data record org-stamped", dcRows?.length === 1 && dcRows[0].org_id === orgDc);
  const { data: dcAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgDc);
  ok("approveAction writes agent_accuracy for data_cleaner (role check constraint includes it)",
    dcAccRows?.length === 1 && dcAccRows[0].agent_role === "data_cleaner" && dcAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgDc);

  console.log("== org context ==");
  {
    const freshOrg = await db
      .from("organizations").insert({ name: "ctx-test", subscription_tier: "pro" })
      .select("id").single();
    const orgId = freshOrg.data!.id as string;

    const { contextBlock } = await getOrgContext(orgId, { db });
    ok("getOrgContext returns undefined when org has no data", contextBlock === undefined);

    await db.from("org_memory").insert({
      org_id: orgId, memory_type: "vendor_category",
      memory_key: "scheme:test",
      memory_value: { scheme: "test", top_categories: ["a", "b"] },
      confidence_score: 0.7, times_confirmed: 3, source_agent: "categorizer",
    });
    const { contextBlock: cb2 } = await getOrgContext(orgId, { db });
    ok("getOrgContext contextBlock includes memory entry",
      typeof cb2 === "string" && cb2.includes("scheme:test"));

    await db.from("organizations").delete().eq("id", orgId);
  }

  // Task 3: runAgent succeeds with org memory context (no crash, context injected)
  {
    const { runAgent: runAgentCtx } = await import("./lib/run-agent");
    const { stubBrain: sbCtx } = await import("./lib/agent-brain");
    const orgCtx = await makeOrg("pro");
    const payCtx = await makePayload(orgCtx);
    await db.from("org_memory").insert({
      org_id: orgCtx, memory_type: "spend_baseline", memory_key: "ledger:debit",
      memory_value: { description: "past entry", amount_cents: 500, direction: "debit" },
      confidence_score: 0.4, times_confirmed: 2, source_agent: "accountant",
    });
    const rCtx = await runAgentCtx({ orgId: orgCtx, payloadId: payCtx, role: "analyst" }, { db, brain: sbCtx });
    ok("runAgent succeeds when org has memory context", rCtx.ok === true);
    await db.from("organizations").delete().eq("id", orgCtx);
  }

  console.log("== memory extractor ==");
  {
    const { extractMemory } = await import("./lib/memory-extractor");

    const ledgerExtract = extractMemory(
      { id: "id1", kind: "record_ledger_entry",
        action_payload: { description: "Office supplies", amount_cents: 1299, direction: "debit" } },
      "accountant"
    );
    ok("extractMemory ledger → spend_baseline",
      ledgerExtract.length === 1 &&
      ledgerExtract[0].memory_type === "spend_baseline" &&
      ledgerExtract[0].memory_key === "ledger:debit");

    const catExtract = extractMemory(
      { id: "id2", kind: "categorize_items",
        action_payload: { scheme: "vendor", assignments: [
          { row_reference: "r1", category: "Office" },
          { row_reference: "r2", category: "Travel" },
          { row_reference: "r3", category: "Office" },
        ] } },
      "categorizer"
    );
    ok("extractMemory categorize → vendor_category with deduped top_categories",
      catExtract.length === 1 &&
      catExtract[0].memory_type === "vendor_category" &&
      catExtract[0].memory_key === "scheme:vendor" &&
      JSON.stringify((catExtract[0].memory_value as { top_categories: string[] }).top_categories) ===
        JSON.stringify(["Office", "Travel"]));

    const reportExtract = extractMemory(
      { id: "id3", kind: "store_report", action_payload: { title: "Q", body: "B" } },
      "analyst"
    );
    ok("extractMemory store_report → empty", reportExtract.length === 0);
  }

  console.log("== approval policy ==");
  {
    const { shouldAutoApprove } = await import("./lib/approval-policy");
    ok("shouldAutoApprove false below threshold",
      !shouldAutoApprove({ kind: "record_ledger_entry" }, { confidence_score: 0.8, times_confirmed: 15 }));
    ok("shouldAutoApprove true at threshold",
      shouldAutoApprove({ kind: "record_ledger_entry" }, { confidence_score: 0.9, times_confirmed: 10 }));
  }

  console.log("== memory upsert (approve gate) ==");
  {
    const { approveAction } = await import("./lib/actions-service");
    const { stubBrain: sbMem } = await import("./lib/agent-brain");
    const { runAgent: runMem } = await import("./lib/run-agent");

    const orgMem = await makeOrg("pro");
    const payMem = await makePayload(orgMem);
    await runMem({ orgId: orgMem, payloadId: payMem, role: "accountant" }, { db, brain: sbMem });
    const { data: pendMem } = await db.from("proposed_actions").select("id").eq("org_id", orgMem).eq("status", "pending");
    const memActionId = pendMem?.[0]?.id as string;
    await approveAction(orgMem, memActionId, randomUUID(), { db });
    const { data: memRow } = await db.from("org_memory").select("memory_type,confidence_score").eq("org_id", orgMem).maybeSingle();
    ok("approveAction writes org_memory entry",
      memRow?.memory_type === "spend_baseline" && (memRow.confidence_score as number) >= 0.6);
    const { data: accRow } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgMem).maybeSingle();
    ok("approveAction writes agent_accuracy entry",
      accRow?.agent_role === "accountant" && (accRow.approved_count as number) >= 1);
    await db.from("organizations").delete().eq("id", orgMem);
  }

  console.log("== auto-approval ==");
  {
    const { runAgent: runAA } = await import("./lib/run-agent");
    const { stubBrain: sbAA } = await import("./lib/agent-brain");

    // Seed an org with memory at threshold → auto-approval should fire
    const orgAA = await makeOrg("pro");
    const payAA = await makePayload(orgAA);
    // Insert a spend_baseline memory entry at the auto-approve threshold
    await db.from("org_memory").insert({
      org_id: orgAA, memory_type: "spend_baseline", memory_key: "ledger:debit",
      memory_value: { description: "Stub entry", amount_cents: 1000, direction: "debit" },
      confidence_score: 0.9, times_confirmed: 10, source_agent: "accountant",
    });
    const rAA = await runAA({ orgId: orgAA, payloadId: payAA, role: "accountant" }, { db, brain: sbAA });
    ok("runAgent auto-approval: run succeeded", rAA.ok === true);
    // The proposal should have been auto-applied (status = applied, not pending)
    const { data: propsAA } = await db.from("proposed_actions").select("status").eq("org_id", orgAA);
    ok("auto-approved proposal is applied (not pending)", propsAA?.length === 1 && propsAA[0].status === "applied");
    // A ledger entry should exist
    const { data: ledgerAA } = await db.from("ledger_entries").select("id").eq("org_id", orgAA);
    ok("auto-approval wrote ledger entry", (ledgerAA?.length ?? 0) >= 1);
    // Audit log should contain approval.auto_approved
    const { data: auditAA } = await db.from("system_audit_logs")
      .select("action").eq("org_id", orgAA).eq("action", "approval.auto_approved");
    ok("auto-approval wrote audit log entry", (auditAA?.length ?? 0) >= 1);

    // Below threshold → stays pending
    const orgBT = await makeOrg("pro");
    const payBT = await makePayload(orgBT);
    await db.from("org_memory").insert({
      org_id: orgBT, memory_type: "spend_baseline", memory_key: "ledger:debit",
      memory_value: { description: "Stub entry", amount_cents: 1000, direction: "debit" },
      confidence_score: 0.8, times_confirmed: 10, source_agent: "accountant",
    });
    await runAA({ orgId: orgBT, payloadId: payBT, role: "accountant" }, { db, brain: sbAA });
    const { data: propsBT } = await db.from("proposed_actions").select("status").eq("org_id", orgBT);
    ok("below-threshold proposal stays pending", propsBT?.length === 1 && propsBT[0].status === "pending");

    // No memory → stays pending (cold start)
    const orgNM = await makeOrg("pro");
    const payNM = await makePayload(orgNM);
    await runAA({ orgId: orgNM, payloadId: payNM, role: "accountant" }, { db, brain: sbAA });
    const { data: propsNM } = await db.from("proposed_actions").select("status").eq("org_id", orgNM);
    ok("no-memory proposal stays pending", propsNM?.length === 1 && propsNM[0].status === "pending");

    for (const o of [orgAA, orgBT, orgNM]) await db.from("organizations").delete().eq("id", o);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
