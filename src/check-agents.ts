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
  ok("financial routes to [anomaly_detector, categorizer, data_cleaner, unit_normalizer, duplicate_detector, reconciler, invoice_matcher, cash_flow_agent, tax_categorizer, budget_analyst, trend_detector, period_comparator, accountant, analyst]", route.ok && JSON.stringify(route.plan) === JSON.stringify(["anomaly_detector", "categorizer", "data_cleaner", "unit_normalizer", "duplicate_detector", "reconciler", "invoice_matcher", "cash_flow_agent", "tax_categorizer", "budget_analyst", "trend_detector", "period_comparator", "accountant", "analyst"]));
  ok("fourteen agent/run events enqueued", enq.length === 14 && enq.every((e) => e.name === "agent/run"));

  // non-financial → analyst only
  const { data: plainPayload } = await db.from("inbound_payloads").insert({
    org_id: orgD, source: "upload", storage_path: `${orgD}/y/z.csv`, original_filename: "z.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const enq2: UiEvent[] = [];
  const route2 = await routePayload({ orgId: orgD, payloadId: plainPayload!.id }, { db, enqueue: (e) => enq2.push(e) });
  ok("non-financial routes to [anomaly_detector, categorizer, data_cleaner, unit_normalizer, duplicate_detector, inventory_tracker, reorder_flagger, supplier_analyst, po_agent, trend_detector, period_comparator, data_merger, analyst]", route2.ok && JSON.stringify(route2.plan) === JSON.stringify(["anomaly_detector", "categorizer", "data_cleaner", "unit_normalizer", "duplicate_detector", "inventory_tracker", "reorder_flagger", "supplier_analyst", "po_agent", "trend_detector", "period_comparator", "data_merger", "analyst"]));

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
  ok("manager enqueued anomaly_detector+categorizer+data_cleaner+unit_normalizer+duplicate_detector+reconciler+invoice_matcher+cash_flow_agent+tax_categorizer+budget_analyst+trend_detector+period_comparator+accountant+analyst", captured.length === 14);
  for (const e of captured) {
    if (e.name === "agent/run") await runAgent2(e.data, { db, brain: sb2 });
  }
  const { data: chainProps } = await db.from("proposed_actions").select("kind").eq("org_id", orgE);
  ok("chain produced 14 proposals (anomaly + categorization + cleanup + normalization + duplicate flag + reconciliation + invoice match + cash flow + tax categorization + budget comparison + trend + period comparison + ledger + report)", chainProps?.length === 14);
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

  console.log("== data merger ==");
  ok("merge_datasets accepts good", validateProposal("merge_datasets", {
    merge_strategy: "left_join", join_columns: ["id"], related_payload_hint: "customer master table",
  }).ok);
  ok("merge_datasets rejects missing merge_strategy", !validateProposal("merge_datasets", {
    join_columns: ["id"], related_payload_hint: "customer master table",
  }).ok);
  ok("merge_datasets rejects empty join_columns", !validateProposal("merge_datasets", {
    merge_strategy: "union", join_columns: [], related_payload_hint: "customer master table",
  }).ok);
  ok("data_merger → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("data_merger") === "claude-sonnet-4-6");

  const { runAgent: runAgentDm } = await import("./lib/run-agent");
  const { stubBrain: sbDm } = await import("./lib/agent-brain");
  const { approveAction: approveDm, listPending: listDm } = await import("./lib/actions-service");
  const orgDm = await makeOrg("pro");
  const payloadDm = await makePayload(orgDm);
  const rDm = await runAgentDm({ orgId: orgDm, payloadId: payloadDm, role: "data_merger" }, { db, brain: sbDm });
  ok("data_merger run produced a merge proposal", rDm.ok && rDm.proposalCount === 1);
  const pendDm = await listDm(orgDm, { db });
  const apprDm = await approveDm(orgDm, pendDm[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes merged_dataset_runs", apprDm.ok && apprDm.recordTable === "merged_dataset_runs", JSON.stringify(apprDm));
  const { data: dmRows } = await db.from("merged_dataset_runs").select("org_id,merge_strategy").eq("org_id", orgDm);
  ok("merged dataset record org-stamped", dmRows?.length === 1 && dmRows[0].org_id === orgDm);
  const { data: dmAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgDm);
  ok("approveAction writes agent_accuracy for data_merger",
    dmAccRows?.length === 1 && dmAccRows[0].agent_role === "data_merger" && dmAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgDm);

  console.log("== unit normalizer ==");
  ok("normalize_units accepts good", validateProposal("normalize_units", {
    unit_type: "currency", target_unit: "USD", values_affected: 1,
    normalizations: [{ row_reference: "row 1", column: "amount", original_value: "€10", normalized_value: "10.85", unit_type: "currency", target_unit: "USD" }],
  }).ok);
  ok("normalize_units rejects bad unit_type", !validateProposal("normalize_units", {
    unit_type: "kelvin", target_unit: "USD", values_affected: 1, normalizations: [],
  }).ok);
  ok("normalize_units rejects empty target_unit", !validateProposal("normalize_units", {
    unit_type: "currency", target_unit: "", values_affected: 1, normalizations: [],
  }).ok);
  ok("unit_normalizer → haiku model",
    (await import("./lib/agent-brain")).modelForRole("unit_normalizer") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentUn } = await import("./lib/run-agent");
  const { stubBrain: sbUn } = await import("./lib/agent-brain");
  const { approveAction: approveUn, listPending: listUn } = await import("./lib/actions-service");
  const orgUn = await makeOrg("pro");
  const payloadUn = await makePayload(orgUn);
  const rUn = await runAgentUn({ orgId: orgUn, payloadId: payloadUn, role: "unit_normalizer" }, { db, brain: sbUn });
  ok("unit_normalizer run produced a normalization proposal", rUn.ok && rUn.proposalCount === 1);
  const pendUn = await listUn(orgUn, { db });
  const apprUn = await approveUn(orgUn, pendUn[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes normalization_runs", apprUn.ok && apprUn.recordTable === "normalization_runs", JSON.stringify(apprUn));
  const { data: unRows } = await db.from("normalization_runs").select("org_id,unit_type,target_unit").eq("org_id", orgUn);
  ok("normalization record org-stamped", unRows?.length === 1 && unRows[0].org_id === orgUn);
  const { data: unAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgUn);
  ok("approveAction writes agent_accuracy for unit_normalizer",
    unAccRows?.length === 1 && unAccRows[0].agent_role === "unit_normalizer" && unAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgUn);

  console.log("== reconciler ==");
  ok("reconcile_records accepts good", validateProposal("reconcile_records", {
    matched_count: 1, unmatched_count: 0,
    match_details: [{ row_reference: "row 1", match_status: "matched", matched_value: "100.00", confidence: 0.95 }],
  }).ok);
  ok("reconcile_records filters out bad match_status", (() => {
    const r = validateProposal("reconcile_records", {
      matched_count: 0, unmatched_count: 0,
      match_details: [{ row_reference: "row 1", match_status: "verified", matched_value: "100.00", confidence: 0.9 }],
    });
    return r.ok && (r.payload.match_details as unknown[]).length === 0;
  })());
  ok("reconcile_records filters out confidence out of range", (() => {
    const r = validateProposal("reconcile_records", {
      matched_count: 0, unmatched_count: 0,
      match_details: [{ row_reference: "row 1", match_status: "matched", matched_value: "100.00", confidence: 1.5 }],
    });
    return r.ok && (r.payload.match_details as unknown[]).length === 0;
  })());
  ok("reconciler → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("reconciler") === "claude-sonnet-4-6");

  const { runAgent: runAgentRc } = await import("./lib/run-agent");
  const { stubBrain: sbRc } = await import("./lib/agent-brain");
  const { approveAction: approveRc, listPending: listRc } = await import("./lib/actions-service");
  const orgRc = await makeOrg("pro");
  const payloadRc = await makePayload(orgRc);
  const rRc = await runAgentRc({ orgId: orgRc, payloadId: payloadRc, role: "reconciler" }, { db, brain: sbRc });
  ok("reconciler run produced a reconciliation proposal", rRc.ok && rRc.proposalCount === 1);
  const pendRc = await listRc(orgRc, { db });
  const apprRc = await approveRc(orgRc, pendRc[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes reconciliation_runs", apprRc.ok && apprRc.recordTable === "reconciliation_runs", JSON.stringify(apprRc));
  const { data: rcRows } = await db.from("reconciliation_runs").select("org_id,matched_count").eq("org_id", orgRc);
  ok("reconciliation record org-stamped", rcRows?.length === 1 && rcRows[0].org_id === orgRc);
  const { data: rcAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgRc);
  ok("approveAction writes agent_accuracy for reconciler",
    rcAccRows?.length === 1 && rcAccRows[0].agent_role === "reconciler" && rcAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgRc);

  console.log("== invoice matcher ==");
  ok("match_invoices accepts good", validateProposal("match_invoices", {
    total_matched: 1, total_discrepancy_cents: 0,
    matches: [{ invoice_ref: "INV-001", po_ref: "PO-001", amount_cents: 10000, match_status: "matched", discrepancy_cents: 0 }],
  }).ok);
  ok("match_invoices filters out bad match_status", (() => {
    const r = validateProposal("match_invoices", {
      total_matched: 0, total_discrepancy_cents: 0,
      matches: [{ invoice_ref: "INV-002", po_ref: "PO-002", amount_cents: 5000, match_status: "voided", discrepancy_cents: 0 }],
    });
    return r.ok && (r.payload.matches as unknown[]).length === 0;
  })());
  ok("match_invoices filters out negative amount_cents", (() => {
    const r = validateProposal("match_invoices", {
      total_matched: 0, total_discrepancy_cents: 0,
      matches: [{ invoice_ref: "INV-003", po_ref: "PO-003", amount_cents: -100, match_status: "matched", discrepancy_cents: 0 }],
    });
    return r.ok && (r.payload.matches as unknown[]).length === 0;
  })());
  ok("invoice_matcher → haiku model",
    (await import("./lib/agent-brain")).modelForRole("invoice_matcher") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentIm } = await import("./lib/run-agent");
  const { stubBrain: sbIm } = await import("./lib/agent-brain");
  const { approveAction: approveIm, listPending: listIm } = await import("./lib/actions-service");
  const orgIm = await makeOrg("pro");
  const payloadIm = await makePayload(orgIm);
  const rIm = await runAgentIm({ orgId: orgIm, payloadId: payloadIm, role: "invoice_matcher" }, { db, brain: sbIm });
  ok("invoice_matcher run produced a match proposal", rIm.ok && rIm.proposalCount === 1);
  const pendIm = await listIm(orgIm, { db });
  const apprIm = await approveIm(orgIm, pendIm[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes invoice_matches", apprIm.ok && apprIm.recordTable === "invoice_matches", JSON.stringify(apprIm));
  const { data: imRows } = await db.from("invoice_matches").select("org_id,total_matched").eq("org_id", orgIm);
  ok("invoice match record org-stamped", imRows?.length === 1 && imRows[0].org_id === orgIm);
  const { data: imAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgIm);
  ok("approveAction writes agent_accuracy for invoice_matcher",
    imAccRows?.length === 1 && imAccRows[0].agent_role === "invoice_matcher" && imAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgIm);

  console.log("== cash flow agent ==");
  ok("project_cash_flow accepts good", validateProposal("project_cash_flow", {
    projection_period: "30_days", inflow_cents: 500000, outflow_cents: 300000,
    net_cents: 200000, runway_days: 90, risk_level: "low", summary: "Positive cash flow.",
  }).ok);
  ok("project_cash_flow rejects bad risk_level", !validateProposal("project_cash_flow", {
    projection_period: "30_days", inflow_cents: 500000, outflow_cents: 300000,
    net_cents: 200000, risk_level: "catastrophic", summary: "x",
  }).ok);
  ok("project_cash_flow rejects bad projection_period", !validateProposal("project_cash_flow", {
    projection_period: "5_years", inflow_cents: 500000, outflow_cents: 300000,
    net_cents: 200000, risk_level: "low", summary: "x",
  }).ok);
  ok("cash_flow_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("cash_flow_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentCf } = await import("./lib/run-agent");
  const { stubBrain: sbCf } = await import("./lib/agent-brain");
  const { approveAction: approveCf, listPending: listCf } = await import("./lib/actions-service");
  const orgCf = await makeOrg("pro");
  const payloadCf = await makePayload(orgCf);
  const rCf = await runAgentCf({ orgId: orgCf, payloadId: payloadCf, role: "cash_flow_agent" }, { db, brain: sbCf });
  ok("cash_flow_agent run produced a projection", rCf.ok && rCf.proposalCount === 1);
  const pendCf = await listCf(orgCf, { db });
  const apprCf = await approveCf(orgCf, pendCf[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes cash_flow_projections", apprCf.ok && apprCf.recordTable === "cash_flow_projections", JSON.stringify(apprCf));
  const { data: cfRows } = await db.from("cash_flow_projections").select("org_id,risk_level").eq("org_id", orgCf);
  ok("cash flow record org-stamped", cfRows?.length === 1 && cfRows[0].org_id === orgCf);
  const { data: cfAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgCf);
  ok("approveAction writes agent_accuracy for cash_flow_agent",
    cfAccRows?.length === 1 && cfAccRows[0].agent_role === "cash_flow_agent" && cfAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgCf);

  console.log("== tax categorizer ==");
  ok("categorize_tax_items accepts good", validateProposal("categorize_tax_items", {
    total_deductible_cents: 5000, total_non_deductible_cents: 0,
    assignments: [{ row_reference: "row 1", description: "Stub expense", amount_cents: 5000, tax_category: "office_supplies", deductible: true }],
  }).ok);
  ok("categorize_tax_items filters out missing tax_category", (() => {
    const r = validateProposal("categorize_tax_items", {
      total_deductible_cents: 0, total_non_deductible_cents: 0,
      assignments: [{ row_reference: "row 1", description: "x", amount_cents: 1000, deductible: true }],
    });
    return r.ok && (r.payload.assignments as unknown[]).length === 0;
  })());
  ok("categorize_tax_items filters out negative amount_cents", (() => {
    const r = validateProposal("categorize_tax_items", {
      total_deductible_cents: 0, total_non_deductible_cents: 0,
      assignments: [{ row_reference: "row 1", description: "x", amount_cents: -500, tax_category: "travel", deductible: false }],
    });
    return r.ok && (r.payload.assignments as unknown[]).length === 0;
  })());
  ok("tax_categorizer → haiku model",
    (await import("./lib/agent-brain")).modelForRole("tax_categorizer") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentTx } = await import("./lib/run-agent");
  const { stubBrain: sbTx } = await import("./lib/agent-brain");
  const { approveAction: approveTx, listPending: listTx } = await import("./lib/actions-service");
  const orgTx = await makeOrg("pro");
  const payloadTx = await makePayload(orgTx);
  const rTx = await runAgentTx({ orgId: orgTx, payloadId: payloadTx, role: "tax_categorizer" }, { db, brain: sbTx });
  ok("tax_categorizer run produced a categorization", rTx.ok && rTx.proposalCount === 1);
  const pendTx = await listTx(orgTx, { db });
  const apprTx = await approveTx(orgTx, pendTx[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes tax_categorization_runs", apprTx.ok && apprTx.recordTable === "tax_categorization_runs", JSON.stringify(apprTx));
  const { data: txRows } = await db.from("tax_categorization_runs").select("org_id,total_deductible_cents").eq("org_id", orgTx);
  ok("tax categorization record org-stamped", txRows?.length === 1 && txRows[0].org_id === orgTx);
  const { data: txAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgTx);
  ok("approveAction writes agent_accuracy for tax_categorizer",
    txAccRows?.length === 1 && txAccRows[0].agent_role === "tax_categorizer" && txAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgTx);

  console.log("== duplicate detector ==");
  ok("flag_duplicates accepts good", validateProposal("flag_duplicates", {
    duplicate_count: 1,
    duplicates: [{ row_references: ["row 1", "row 2"], similarity_score: 1.0, duplicate_type: "exact", key_columns: ["id"] }],
  }).ok);
  ok("flag_duplicates filters out row_references fewer than 2", (() => {
    const r = validateProposal("flag_duplicates", {
      duplicate_count: 0,
      duplicates: [{ row_references: ["row 1"], similarity_score: 1.0, duplicate_type: "exact", key_columns: ["id"] }],
    });
    return r.ok && (r.payload.duplicates as unknown[]).length === 0;
  })());
  ok("flag_duplicates filters out bad duplicate_type", (() => {
    const r = validateProposal("flag_duplicates", {
      duplicate_count: 0,
      duplicates: [{ row_references: ["row 1", "row 2"], similarity_score: 0.9, duplicate_type: "identical", key_columns: ["id"] }],
    });
    return r.ok && (r.payload.duplicates as unknown[]).length === 0;
  })());
  ok("duplicate_detector → haiku model",
    (await import("./lib/agent-brain")).modelForRole("duplicate_detector") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentDd } = await import("./lib/run-agent");
  const { stubBrain: sbDd } = await import("./lib/agent-brain");
  const { approveAction: approveDd, listPending: listDd } = await import("./lib/actions-service");
  const orgDd = await makeOrg("pro");
  const payloadDd = await makePayload(orgDd);
  const rDd = await runAgentDd({ orgId: orgDd, payloadId: payloadDd, role: "duplicate_detector" }, { db, brain: sbDd });
  ok("duplicate_detector run produced a duplicate flag", rDd.ok && rDd.proposalCount === 1);
  const pendDd = await listDd(orgDd, { db });
  const apprDd = await approveDd(orgDd, pendDd[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes duplicate_flags", apprDd.ok && apprDd.recordTable === "duplicate_flags", JSON.stringify(apprDd));
  const { data: ddRows } = await db.from("duplicate_flags").select("org_id,duplicate_count").eq("org_id", orgDd);
  ok("duplicate flag record org-stamped", ddRows?.length === 1 && ddRows[0].org_id === orgDd);
  const { data: ddAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgDd);
  ok("approveAction writes agent_accuracy for duplicate_detector",
    ddAccRows?.length === 1 && ddAccRows[0].agent_role === "duplicate_detector" && ddAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgDd);

  console.log("== budget analyst ==");
  ok("compare_budget_actual accepts good", validateProposal("compare_budget_actual", {
    overall_status: "under_budget", total_budgeted_cents: 100000, total_actual_cents: 95000, total_variance_cents: 5000,
    comparisons: [{ category: "Operations", budgeted_cents: 100000, actual_cents: 95000, variance_cents: 5000, variance_pct: 5.0, status: "under_budget" }],
  }).ok);
  ok("compare_budget_actual rejects bad overall_status", !validateProposal("compare_budget_actual", {
    overall_status: "unknown_status", total_budgeted_cents: 100000, total_actual_cents: 95000, total_variance_cents: 5000,
    comparisons: [],
  }).ok);
  ok("compare_budget_actual filters out bad comparison status", (() => {
    const r = validateProposal("compare_budget_actual", {
      overall_status: "mixed", total_budgeted_cents: 0, total_actual_cents: 0, total_variance_cents: 0,
      comparisons: [{ category: "Travel", budgeted_cents: 1000, actual_cents: 2000, variance_cents: -1000, variance_pct: -100.0, status: "way_over" }],
    });
    return r.ok && (r.payload.comparisons as unknown[]).length === 0;
  })());
  ok("budget_analyst → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("budget_analyst") === "claude-sonnet-4-6");

  const { runAgent: runAgentBa } = await import("./lib/run-agent");
  const { stubBrain: sbBa } = await import("./lib/agent-brain");
  const { approveAction: approveBa, listPending: listBa } = await import("./lib/actions-service");
  const orgBa = await makeOrg("pro");
  const payloadBa = await makePayload(orgBa);
  const rBa = await runAgentBa({ orgId: orgBa, payloadId: payloadBa, role: "budget_analyst" }, { db, brain: sbBa });
  ok("budget_analyst run produced a comparison", rBa.ok && rBa.proposalCount === 1);
  const pendBa = await listBa(orgBa, { db });
  const apprBa = await approveBa(orgBa, pendBa[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes budget_comparisons", apprBa.ok && apprBa.recordTable === "budget_comparisons", JSON.stringify(apprBa));
  const { data: baRows } = await db.from("budget_comparisons").select("org_id,overall_status").eq("org_id", orgBa);
  ok("budget comparison record org-stamped", baRows?.length === 1 && baRows[0].org_id === orgBa);
  const { data: baAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgBa);
  ok("approveAction writes agent_accuracy for budget_analyst",
    baAccRows?.length === 1 && baAccRows[0].agent_role === "budget_analyst" && baAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgBa);

  console.log("== inventory tracker ==");
  ok("track_inventory accepts good", validateProposal("track_inventory", {
    total_items: 100, total_value_cents: 99900,
    items: [{ sku: "SKU-001", name: "Stub Widget", quantity: 100, unit_value_cents: 999, location: "Warehouse A" }],
  }).ok);
  ok("track_inventory filters out negative quantity", (() => {
    const r = validateProposal("track_inventory", {
      total_items: 0, total_value_cents: 0,
      items: [{ sku: "SKU-002", name: "Bad Item", quantity: -5, unit_value_cents: 100, location: "" }],
    });
    return r.ok && (r.payload.items as unknown[]).length === 0;
  })());
  ok("track_inventory filters out missing sku", (() => {
    const r = validateProposal("track_inventory", {
      total_items: 0, total_value_cents: 0,
      items: [{ name: "No SKU Item", quantity: 10, unit_value_cents: 100, location: "" }],
    });
    return r.ok && (r.payload.items as unknown[]).length === 0;
  })());
  ok("inventory_tracker → haiku model",
    (await import("./lib/agent-brain")).modelForRole("inventory_tracker") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentIt } = await import("./lib/run-agent");
  const { stubBrain: sbIt } = await import("./lib/agent-brain");
  const { approveAction: approveIt, listPending: listIt } = await import("./lib/actions-service");
  const orgIt = await makeOrg("pro");
  const payloadIt = await makePayload(orgIt);
  const rIt = await runAgentIt({ orgId: orgIt, payloadId: payloadIt, role: "inventory_tracker" }, { db, brain: sbIt });
  ok("inventory_tracker run produced a snapshot", rIt.ok && rIt.proposalCount === 1);
  const pendIt = await listIt(orgIt, { db });
  const apprIt = await approveIt(orgIt, pendIt[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes inventory_snapshots", apprIt.ok && apprIt.recordTable === "inventory_snapshots", JSON.stringify(apprIt));
  const { data: itRows } = await db.from("inventory_snapshots").select("org_id,total_items").eq("org_id", orgIt);
  ok("inventory snapshot record org-stamped", itRows?.length === 1 && itRows[0].org_id === orgIt);
  const { data: itAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgIt);
  ok("approveAction writes agent_accuracy for inventory_tracker",
    itAccRows?.length === 1 && itAccRows[0].agent_role === "inventory_tracker" && itAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgIt);

  console.log("== reorder flagger ==");
  ok("flag_reorders accepts good", validateProposal("flag_reorders", {
    critical_count: 0, warning_count: 1,
    flags: [{ sku: "SKU-001", name: "Stub Widget", current_quantity: 5, reorder_point: 20, urgency: "warning", suggested_reorder_qty: 100 }],
  }).ok);
  ok("flag_reorders filters out bad urgency", (() => {
    const r = validateProposal("flag_reorders", {
      critical_count: 0, warning_count: 0,
      flags: [{ sku: "SKU-002", name: "x", current_quantity: 5, reorder_point: 20, urgency: "urgent", suggested_reorder_qty: 50 }],
    });
    return r.ok && (r.payload.flags as unknown[]).length === 0;
  })());
  ok("flag_reorders filters out negative current_quantity", (() => {
    const r = validateProposal("flag_reorders", {
      critical_count: 0, warning_count: 0,
      flags: [{ sku: "SKU-003", name: "x", current_quantity: -1, reorder_point: 20, urgency: "critical", suggested_reorder_qty: 50 }],
    });
    return r.ok && (r.payload.flags as unknown[]).length === 0;
  })());
  ok("reorder_flagger → haiku model",
    (await import("./lib/agent-brain")).modelForRole("reorder_flagger") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentRf } = await import("./lib/run-agent");
  const { stubBrain: sbRf } = await import("./lib/agent-brain");
  const { approveAction: approveRf, listPending: listRf } = await import("./lib/actions-service");
  const orgRf = await makeOrg("pro");
  const payloadRf = await makePayload(orgRf);
  const rRf = await runAgentRf({ orgId: orgRf, payloadId: payloadRf, role: "reorder_flagger" }, { db, brain: sbRf });
  ok("reorder_flagger run produced a flag", rRf.ok && rRf.proposalCount === 1);
  const pendRf = await listRf(orgRf, { db });
  const apprRf = await approveRf(orgRf, pendRf[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes reorder_flags", apprRf.ok && apprRf.recordTable === "reorder_flags", JSON.stringify(apprRf));
  const { data: rfRows } = await db.from("reorder_flags").select("org_id,warning_count").eq("org_id", orgRf);
  ok("reorder flag record org-stamped", rfRows?.length === 1 && rfRows[0].org_id === orgRf);
  const { data: rfAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgRf);
  ok("approveAction writes agent_accuracy for reorder_flagger",
    rfAccRows?.length === 1 && rfAccRows[0].agent_role === "reorder_flagger" && rfAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgRf);

  console.log("== supplier analyst ==");
  ok("analyze_suppliers accepts good", validateProposal("analyze_suppliers", {
    total_suppliers: 1, concentration_risk: "high",
    suppliers: [{ supplier_name: "Stub Supplier Co", total_spend_cents: 500000, order_count: 10, on_time_rate: 0.95, risk_level: "low", notes: "reliable" }],
  }).ok);
  ok("analyze_suppliers rejects bad concentration_risk", !validateProposal("analyze_suppliers", {
    total_suppliers: 1, concentration_risk: "extreme",
    suppliers: [],
  }).ok);
  ok("analyze_suppliers filters out on_time_rate out of range", (() => {
    const r = validateProposal("analyze_suppliers", {
      total_suppliers: 0, concentration_risk: "low",
      suppliers: [{ supplier_name: "Bad Co", total_spend_cents: 1000, order_count: 1, on_time_rate: 1.5, risk_level: "medium", notes: "" }],
    });
    return r.ok && (r.payload.suppliers as unknown[]).length === 0;
  })());
  ok("supplier_analyst → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("supplier_analyst") === "claude-sonnet-4-6");

  const { runAgent: runAgentSa } = await import("./lib/run-agent");
  const { stubBrain: sbSa } = await import("./lib/agent-brain");
  const { approveAction: approveSa, listPending: listSa } = await import("./lib/actions-service");
  const orgSa = await makeOrg("pro");
  const payloadSa = await makePayload(orgSa);
  const rSa = await runAgentSa({ orgId: orgSa, payloadId: payloadSa, role: "supplier_analyst" }, { db, brain: sbSa });
  ok("supplier_analyst run produced an analysis", rSa.ok && rSa.proposalCount === 1);
  const pendSa = await listSa(orgSa, { db });
  const apprSa = await approveSa(orgSa, pendSa[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes supplier_analyses", apprSa.ok && apprSa.recordTable === "supplier_analyses", JSON.stringify(apprSa));
  const { data: saRows } = await db.from("supplier_analyses").select("org_id,concentration_risk").eq("org_id", orgSa);
  ok("supplier analysis record org-stamped", saRows?.length === 1 && saRows[0].org_id === orgSa);
  const { data: saAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgSa);
  ok("approveAction writes agent_accuracy for supplier_analyst",
    saAccRows?.length === 1 && saAccRows[0].agent_role === "supplier_analyst" && saAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgSa);

  console.log("== po agent ==");
  ok("process_purchase_orders accepts good", validateProposal("process_purchase_orders", {
    total_orders: 1, total_value_cents: 75000, pending_count: 1,
    purchase_orders: [{ po_number: "PO-001", vendor: "Stub Vendor", line_items: 3, total_cents: 75000, status: "pending" }],
  }).ok);
  ok("process_purchase_orders filters out bad status", (() => {
    const r = validateProposal("process_purchase_orders", {
      total_orders: 0, total_value_cents: 0, pending_count: 0,
      purchase_orders: [{ po_number: "PO-002", vendor: "x", line_items: 1, total_cents: 100, status: "shipped" }],
    });
    return r.ok && (r.payload.purchase_orders as unknown[]).length === 0;
  })());
  ok("process_purchase_orders filters out negative total_cents", (() => {
    const r = validateProposal("process_purchase_orders", {
      total_orders: 0, total_value_cents: 0, pending_count: 0,
      purchase_orders: [{ po_number: "PO-003", vendor: "x", line_items: 1, total_cents: -100, status: "pending" }],
    });
    return r.ok && (r.payload.purchase_orders as unknown[]).length === 0;
  })());
  ok("po_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("po_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentPo } = await import("./lib/run-agent");
  const { stubBrain: sbPo } = await import("./lib/agent-brain");
  const { approveAction: approvePo, listPending: listPo } = await import("./lib/actions-service");
  const orgPo = await makeOrg("pro");
  const payloadPo = await makePayload(orgPo);
  const rPo = await runAgentPo({ orgId: orgPo, payloadId: payloadPo, role: "po_agent" }, { db, brain: sbPo });
  ok("po_agent run produced a PO batch", rPo.ok && rPo.proposalCount === 1);
  const pendPo = await listPo(orgPo, { db });
  const apprPo = await approvePo(orgPo, pendPo[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes purchase_order_runs", apprPo.ok && apprPo.recordTable === "purchase_order_runs", JSON.stringify(apprPo));
  const { data: poRows } = await db.from("purchase_order_runs").select("org_id,total_orders").eq("org_id", orgPo);
  ok("purchase order record org-stamped", poRows?.length === 1 && poRows[0].org_id === orgPo);
  const { data: poAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgPo);
  ok("approveAction writes agent_accuracy for po_agent",
    poAccRows?.length === 1 && poAccRows[0].agent_role === "po_agent" && poAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgPo);

  console.log("== trend detector ==");
  ok("detect_trends accepts good", validateProposal("detect_trends", {
    trend_count: 1, overall_direction: "up",
    trends: [{ column: "revenue", direction: "up", magnitude: "medium", description: "increasing", data_points: 10 }],
  }).ok);
  ok("detect_trends filters out bad direction", (() => {
    const r = validateProposal("detect_trends", {
      trend_count: 0, overall_direction: "flat",
      trends: [{ column: "cost", direction: "sideways", magnitude: "low", description: "x", data_points: 5 }],
    });
    return r.ok && (r.payload.trends as unknown[]).length === 0;
  })());
  ok("detect_trends rejects bad overall_direction", !validateProposal("detect_trends", {
    trend_count: 0, overall_direction: "chaotic",
    trends: [],
  }).ok);
  ok("trend_detector → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("trend_detector") === "claude-sonnet-4-6");

  const { runAgent: runAgentTd } = await import("./lib/run-agent");
  const { stubBrain: sbTd } = await import("./lib/agent-brain");
  const { approveAction: approveTd, listPending: listTd } = await import("./lib/actions-service");
  const orgTd = await makeOrg("pro");
  const payloadTd = await makePayload(orgTd);
  const rTd = await runAgentTd({ orgId: orgTd, payloadId: payloadTd, role: "trend_detector" }, { db, brain: sbTd });
  ok("trend_detector run produced a detection", rTd.ok && rTd.proposalCount === 1);
  const pendTd = await listTd(orgTd, { db });
  const apprTd = await approveTd(orgTd, pendTd[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes trend_detections", apprTd.ok && apprTd.recordTable === "trend_detections", JSON.stringify(apprTd));
  const { data: tdRows } = await db.from("trend_detections").select("org_id,overall_direction").eq("org_id", orgTd);
  ok("trend detection record org-stamped", tdRows?.length === 1 && tdRows[0].org_id === orgTd);
  const { data: tdAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgTd);
  ok("approveAction writes agent_accuracy for trend_detector",
    tdAccRows?.length === 1 && tdAccRows[0].agent_role === "trend_detector" && tdAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgTd);

  console.log("== period comparator ==");
  ok("compare_periods accepts good", validateProposal("compare_periods", {
    period_a_label: "Period A", period_b_label: "Period B", overall_change_pct: 20.0, summary: "Revenue increased 20%.",
    comparisons: [{ metric: "Revenue", period_a_value: 100000, period_b_value: 120000, change_pct: 20.0, change_direction: "up" }],
  }).ok);
  ok("compare_periods rejects empty period_a_label", !validateProposal("compare_periods", {
    period_a_label: "", period_b_label: "Period B", overall_change_pct: 0, summary: "x",
    comparisons: [],
  }).ok);
  ok("compare_periods filters out bad change_direction", (() => {
    const r = validateProposal("compare_periods", {
      period_a_label: "A", period_b_label: "B", overall_change_pct: 0, summary: "x",
      comparisons: [{ metric: "Cost", period_a_value: 100, period_b_value: 100, change_pct: 0, change_direction: "sideways" }],
    });
    return r.ok && (r.payload.comparisons as unknown[]).length === 0;
  })());
  ok("period_comparator → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("period_comparator") === "claude-sonnet-4-6");

  const { runAgent: runAgentPc } = await import("./lib/run-agent");
  const { stubBrain: sbPc } = await import("./lib/agent-brain");
  const { approveAction: approvePc, listPending: listPc } = await import("./lib/actions-service");
  const orgPc = await makeOrg("pro");
  const payloadPc = await makePayload(orgPc);
  const rPc = await runAgentPc({ orgId: orgPc, payloadId: payloadPc, role: "period_comparator" }, { db, brain: sbPc });
  ok("period_comparator run produced a comparison", rPc.ok && rPc.proposalCount === 1);
  const pendPc = await listPc(orgPc, { db });
  const apprPc = await approvePc(orgPc, pendPc[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes period_comparisons", apprPc.ok && apprPc.recordTable === "period_comparisons", JSON.stringify(apprPc));
  const { data: pcRows } = await db.from("period_comparisons").select("org_id,period_a_label").eq("org_id", orgPc);
  ok("period comparison record org-stamped", pcRows?.length === 1 && pcRows[0].org_id === orgPc);
  const { data: pcAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgPc);
  ok("approveAction writes agent_accuracy for period_comparator",
    pcAccRows?.length === 1 && pcAccRows[0].agent_role === "period_comparator" && pcAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgPc);

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
