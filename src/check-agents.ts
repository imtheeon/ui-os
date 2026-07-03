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
  ok("financial routes to [data_quality, compliance_agent, onboarding_agent, clarification_agent, multi_period, audit_summarizer, sql_analyst, anomaly_detector, categorizer, data_cleaner, unit_normalizer, duplicate_detector, reconciler, invoice_matcher, cash_flow_agent, tax_categorizer, budget_analyst, saas_metrics_agent, burn_rate_agent, cohort_agent, ar_aging_agent, ap_agent, bank_recon_agent, ratio_analysis_agent, profitability_agent, working_capital_agent, break_even_agent, cogs_analysis_agent, revenue_recognition_agent, churn_risk_agent, customer_segmentation_agent, sales_pipeline_agent, vendor_risk, trend_detector, period_comparator, health_scorer, email_drafter, recommender, pattern_memory, accountant, forecaster, report_generator, exec_summarizer, alert_agent, client_reporter, narrator, meeting_prepper, board_deck_builder, viz_recommender, chart_config_agent, kpi_card_agent, dashboard_spec_agent, validator, analyst]", route.ok && JSON.stringify(route.plan) === JSON.stringify(["data_quality", "compliance_agent", "onboarding_agent", "clarification_agent", "multi_period", "audit_summarizer", "sql_analyst", "anomaly_detector", "categorizer", "data_cleaner", "unit_normalizer", "duplicate_detector", "reconciler", "invoice_matcher", "cash_flow_agent", "tax_categorizer", "budget_analyst", "saas_metrics_agent", "burn_rate_agent", "cohort_agent", "ar_aging_agent", "ap_agent", "bank_recon_agent", "ratio_analysis_agent", "profitability_agent", "working_capital_agent", "break_even_agent", "cogs_analysis_agent", "revenue_recognition_agent", "churn_risk_agent", "customer_segmentation_agent", "sales_pipeline_agent", "vendor_risk", "trend_detector", "period_comparator", "health_scorer", "email_drafter", "recommender", "pattern_memory", "accountant", "forecaster", "report_generator", "exec_summarizer", "alert_agent", "client_reporter", "narrator", "meeting_prepper", "board_deck_builder", "viz_recommender", "chart_config_agent", "kpi_card_agent", "dashboard_spec_agent", "validator", "analyst"]));
  ok("fiftyfour agent/run events enqueued", enq.length === 54 && enq.every((e) => e.name === "agent/run"));

  // non-financial → analyst only
  const { data: plainPayload } = await db.from("inbound_payloads").insert({
    org_id: orgD, source: "upload", storage_path: `${orgD}/y/z.csv`, original_filename: "z.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const enq2: UiEvent[] = [];
  const route2 = await routePayload({ orgId: orgD, payloadId: plainPayload!.id }, { db, enqueue: (e) => enq2.push(e) });
  ok("non-financial routes to [data_quality, compliance_agent, onboarding_agent, clarification_agent, multi_period, audit_summarizer, sql_analyst, anomaly_detector, categorizer, data_cleaner, unit_normalizer, duplicate_detector, inventory_tracker, reorder_flagger, supplier_analyst, po_agent, code_reviewer, code_tester, customer_segmentation_agent, vendor_risk, trend_detector, period_comparator, health_scorer, email_drafter, recommender, pattern_memory, data_merger, report_generator, exec_summarizer, alert_agent, client_reporter, narrator, meeting_prepper, board_deck_builder, viz_recommender, chart_config_agent, kpi_card_agent, dashboard_spec_agent, validator, analyst]", route2.ok && JSON.stringify(route2.plan) === JSON.stringify(["data_quality", "compliance_agent", "onboarding_agent", "clarification_agent", "multi_period", "audit_summarizer", "sql_analyst", "anomaly_detector", "categorizer", "data_cleaner", "unit_normalizer", "duplicate_detector", "inventory_tracker", "reorder_flagger", "supplier_analyst", "po_agent", "code_reviewer", "code_tester", "customer_segmentation_agent", "vendor_risk", "trend_detector", "period_comparator", "health_scorer", "email_drafter", "recommender", "pattern_memory", "data_merger", "report_generator", "exec_summarizer", "alert_agent", "client_reporter", "narrator", "meeting_prepper", "board_deck_builder", "viz_recommender", "chart_config_agent", "kpi_card_agent", "dashboard_spec_agent", "validator", "analyst"]));

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
  ok("manager enqueued data_quality+compliance_agent+onboarding_agent+clarification_agent+multi_period+audit_summarizer+sql_analyst+anomaly_detector+categorizer+data_cleaner+unit_normalizer+duplicate_detector+reconciler+invoice_matcher+cash_flow_agent+tax_categorizer+budget_analyst+saas_metrics_agent+burn_rate_agent+cohort_agent+ar_aging_agent+ap_agent+bank_recon_agent+ratio_analysis_agent+profitability_agent+working_capital_agent+break_even_agent+cogs_analysis_agent+revenue_recognition_agent+churn_risk_agent+customer_segmentation_agent+sales_pipeline_agent+vendor_risk+trend_detector+period_comparator+health_scorer+email_drafter+recommender+pattern_memory+accountant+forecaster+report_generator+exec_summarizer+alert_agent+client_reporter+narrator+meeting_prepper+board_deck_builder+viz_recommender+chart_config_agent+kpi_card_agent+dashboard_spec_agent+validator+analyst", captured.length === 54);
  for (const e of captured) {
    if (e.name === "agent/run") await runAgent2(e.data, { db, brain: sb2 });
  }
  const { data: chainProps } = await db.from("proposed_actions").select("kind").eq("org_id", orgE);
  ok("chain produced 54 proposals (data quality + compliance + onboarding + clarification + multi period + audit summary + sql analysis + anomaly + categorization + cleanup + normalization + duplicate flag + reconciliation + invoice match + cash flow + tax categorization + budget comparison + saas metrics + burn rate + cohort analysis + ar aging + ap analysis + bank reconciliation + ratio analysis + profitability analysis + working capital analysis + break even analysis + cogs analysis + revenue recognition analysis + churn risk analysis + customer segmentation + sales pipeline + vendor risk + trend + period comparison + health score + email draft + recommendations + pattern extraction + forecast + report + exec summary + alerts + client report + narrative + meeting prep + board deck + viz recommendations + chart configs + kpi cards + dashboard spec + validation + ledger + analyst report)", chainProps?.length === 54);
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

  console.log("== exec summarizer ==");
  ok("generate_exec_summary accepts good", validateProposal("generate_exec_summary", {
    headline: "Dataset processed.", key_findings: ["finding 1"], recommended_actions: ["action 1"], risk_flags: [], confidence: "medium",
  }).ok);
  ok("generate_exec_summary rejects empty headline", !validateProposal("generate_exec_summary", {
    headline: "", key_findings: [], recommended_actions: [], risk_flags: [], confidence: "low",
  }).ok);
  ok("generate_exec_summary rejects bad confidence", !validateProposal("generate_exec_summary", {
    headline: "x", key_findings: [], recommended_actions: [], risk_flags: [], confidence: "certain",
  }).ok);
  ok("exec_summarizer → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("exec_summarizer") === "claude-sonnet-4-6");

  const { runAgent: runAgentEs } = await import("./lib/run-agent");
  const { stubBrain: sbEs } = await import("./lib/agent-brain");
  const { approveAction: approveEs, listPending: listEs } = await import("./lib/actions-service");
  const orgEs = await makeOrg("pro");
  const payloadEs = await makePayload(orgEs);
  const rEs = await runAgentEs({ orgId: orgEs, payloadId: payloadEs, role: "exec_summarizer" }, { db, brain: sbEs });
  ok("exec_summarizer run produced a summary", rEs.ok && rEs.proposalCount === 1);
  const pendEs = await listEs(orgEs, { db });
  const apprEs = await approveEs(orgEs, pendEs[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes exec_summaries", apprEs.ok && apprEs.recordTable === "exec_summaries", JSON.stringify(apprEs));
  const { data: esRows } = await db.from("exec_summaries").select("org_id,confidence").eq("org_id", orgEs);
  ok("exec summary record org-stamped", esRows?.length === 1 && esRows[0].org_id === orgEs);
  const { data: esAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgEs);
  ok("approveAction writes agent_accuracy for exec_summarizer",
    esAccRows?.length === 1 && esAccRows[0].agent_role === "exec_summarizer" && esAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgEs);

  console.log("== forecaster ==");
  ok("generate_forecast accepts good", validateProposal("generate_forecast", {
    horizon: "90_days", methodology: "linear extrapolation", confidence: "low", assumptions: "assumes trend continues",
    forecasts: [{ metric: "Revenue", current_value: 100000, projected_value: 115000, change_pct: 15.0, basis: "trend" }],
  }).ok);
  ok("generate_forecast rejects bad horizon", !validateProposal("generate_forecast", {
    horizon: "5_years", methodology: "x", confidence: "low", assumptions: "x",
    forecasts: [],
  }).ok);
  ok("generate_forecast rejects bad confidence", !validateProposal("generate_forecast", {
    horizon: "90_days", methodology: "x", confidence: "certain", assumptions: "x",
    forecasts: [],
  }).ok);
  ok("forecaster → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("forecaster") === "claude-sonnet-4-6");

  const { runAgent: runAgentFc } = await import("./lib/run-agent");
  const { stubBrain: sbFc } = await import("./lib/agent-brain");
  const { approveAction: approveFc, listPending: listFc } = await import("./lib/actions-service");
  const orgFc = await makeOrg("pro");
  const payloadFc = await makePayload(orgFc);
  const rFc = await runAgentFc({ orgId: orgFc, payloadId: payloadFc, role: "forecaster" }, { db, brain: sbFc });
  ok("forecaster run produced a forecast", rFc.ok && rFc.proposalCount === 1);
  const pendFc = await listFc(orgFc, { db });
  const apprFc = await approveFc(orgFc, pendFc[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes forecast_runs", apprFc.ok && apprFc.recordTable === "forecast_runs", JSON.stringify(apprFc));
  const { data: fcRows } = await db.from("forecast_runs").select("org_id,horizon").eq("org_id", orgFc);
  ok("forecast record org-stamped", fcRows?.length === 1 && fcRows[0].org_id === orgFc);
  const { data: fcAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgFc);
  ok("approveAction writes agent_accuracy for forecaster",
    fcAccRows?.length === 1 && fcAccRows[0].agent_role === "forecaster" && fcAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgFc);

  console.log("== report generator ==");
  ok("generate_report accepts good", validateProposal("generate_report", {
    report_type: "general", title: "Stub: Data Analysis Report", word_count: 5,
    sections: [{ heading: "Overview", content: "Stub: dataset processed." }],
  }).ok);
  ok("generate_report rejects bad report_type", !validateProposal("generate_report", {
    report_type: "legal", title: "x", word_count: 0, sections: [],
  }).ok);
  ok("generate_report rejects empty title", !validateProposal("generate_report", {
    report_type: "general", title: "", word_count: 0, sections: [],
  }).ok);
  ok("report_generator → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("report_generator") === "claude-sonnet-4-6");

  const { runAgent: runAgentRg } = await import("./lib/run-agent");
  const { stubBrain: sbRg } = await import("./lib/agent-brain");
  const { approveAction: approveRg, listPending: listRg } = await import("./lib/actions-service");
  const orgRg = await makeOrg("pro");
  const payloadRg = await makePayload(orgRg);
  const rRg = await runAgentRg({ orgId: orgRg, payloadId: payloadRg, role: "report_generator" }, { db, brain: sbRg });
  ok("report_generator run produced a report", rRg.ok && rRg.proposalCount === 1);
  const pendRg = await listRg(orgRg, { db });
  const apprRg = await approveRg(orgRg, pendRg[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes generated_reports", apprRg.ok && apprRg.recordTable === "generated_reports", JSON.stringify(apprRg));
  const { data: rgRows } = await db.from("generated_reports").select("org_id,report_type").eq("org_id", orgRg);
  ok("generated report record org-stamped", rgRows?.length === 1 && rgRows[0].org_id === orgRg);
  const { data: rgAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgRg);
  ok("approveAction writes agent_accuracy for report_generator",
    rgAccRows?.length === 1 && rgAccRows[0].agent_role === "report_generator" && rgAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgRg);

  console.log("== data quality ==");
  ok("assess_data_quality accepts good", validateProposal("assess_data_quality", {
    quality_score: 85, overall_grade: "B",
    issues: [{ column: "amount", issue_type: "missing_values", affected_rows: 2, severity: "medium" }],
  }).ok);
  ok("assess_data_quality rejects quality_score out of range", !validateProposal("assess_data_quality", {
    quality_score: 150, overall_grade: "A", issues: [],
  }).ok);
  ok("assess_data_quality rejects bad overall_grade", !validateProposal("assess_data_quality", {
    quality_score: 50, overall_grade: "Z", issues: [],
  }).ok);
  ok("data_quality → haiku model",
    (await import("./lib/agent-brain")).modelForRole("data_quality") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentDq } = await import("./lib/run-agent");
  const { stubBrain: sbDq } = await import("./lib/agent-brain");
  const { approveAction: approveDq, listPending: listDq } = await import("./lib/actions-service");
  const orgDq = await makeOrg("pro");
  const payloadDq = await makePayload(orgDq);
  const rDq = await runAgentDq({ orgId: orgDq, payloadId: payloadDq, role: "data_quality" }, { db, brain: sbDq });
  ok("data_quality run produced an assessment", rDq.ok && rDq.proposalCount === 1);
  const pendDq = await listDq(orgDq, { db });
  const apprDq = await approveDq(orgDq, pendDq[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes data_quality_assessments", apprDq.ok && apprDq.recordTable === "data_quality_assessments", JSON.stringify(apprDq));
  const { data: dqRows } = await db.from("data_quality_assessments").select("org_id,overall_grade").eq("org_id", orgDq);
  ok("data quality record org-stamped", dqRows?.length === 1 && dqRows[0].org_id === orgDq);
  const { data: dqAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgDq);
  ok("approveAction writes agent_accuracy for data_quality",
    dqAccRows?.length === 1 && dqAccRows[0].agent_role === "data_quality" && dqAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgDq);

  console.log("== compliance agent ==");
  ok("flag_compliance_issues accepts good", validateProposal("flag_compliance_issues", {
    pii_detected: true, risk_level: "medium",
    flags: [{ column: "email", row_reference: "row 1", issue_type: "pii_detected", description: "email detected", severity: "medium" }],
  }).ok);
  ok("flag_compliance_issues rejects bad risk_level", !validateProposal("flag_compliance_issues", {
    pii_detected: false, risk_level: "severe", flags: [],
  }).ok);
  ok("flag_compliance_issues filters out bad issue_type", (() => {
    const r = validateProposal("flag_compliance_issues", {
      pii_detected: false, risk_level: "low",
      flags: [{ column: "x", row_reference: "row 1", issue_type: "unknown_type", description: "x", severity: "low" }],
    });
    return r.ok && (r.payload.flags as unknown[]).length === 0;
  })());
  ok("compliance_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("compliance_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentCa } = await import("./lib/run-agent");
  const { stubBrain: sbCa } = await import("./lib/agent-brain");
  const { approveAction: approveCa, listPending: listCa } = await import("./lib/actions-service");
  const orgCa = await makeOrg("pro");
  const payloadCa = await makePayload(orgCa);
  const rCa = await runAgentCa({ orgId: orgCa, payloadId: payloadCa, role: "compliance_agent" }, { db, brain: sbCa });
  ok("compliance_agent run produced a flag", rCa.ok && rCa.proposalCount === 1);
  const pendCa = await listCa(orgCa, { db });
  const apprCa = await approveCa(orgCa, pendCa[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes compliance_flags", apprCa.ok && apprCa.recordTable === "compliance_flags", JSON.stringify(apprCa));
  const { data: caRows } = await db.from("compliance_flags").select("org_id,pii_detected").eq("org_id", orgCa);
  ok("compliance flag record org-stamped", caRows?.length === 1 && caRows[0].org_id === orgCa);
  const { data: caAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgCa);
  ok("approveAction writes agent_accuracy for compliance_agent",
    caAccRows?.length === 1 && caAccRows[0].agent_role === "compliance_agent" && caAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgCa);

  console.log("== vendor risk ==");
  ok("assess_vendor_risk accepts good", validateProposal("assess_vendor_risk", {
    total_vendors: 1, high_risk_count: 1, concentration_risk: "critical",
    vendors: [{ vendor_name: "Stub Vendor", spend_pct: 75.0, risk_level: "high", risk_factors: ["single_source"], single_source: true }],
  }).ok);
  ok("assess_vendor_risk filters out spend_pct > 100", (() => {
    const r = validateProposal("assess_vendor_risk", {
      total_vendors: 0, high_risk_count: 0, concentration_risk: "low",
      vendors: [{ vendor_name: "Bad Vendor", spend_pct: 150.0, risk_level: "high", risk_factors: [], single_source: false }],
    });
    return r.ok && (r.payload.vendors as unknown[]).length === 0;
  })());
  ok("assess_vendor_risk rejects bad concentration_risk", !validateProposal("assess_vendor_risk", {
    total_vendors: 0, high_risk_count: 0, concentration_risk: "extreme", vendors: [],
  }).ok);
  ok("vendor_risk → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("vendor_risk") === "claude-sonnet-4-6");

  const { runAgent: runAgentVr } = await import("./lib/run-agent");
  const { stubBrain: sbVr } = await import("./lib/agent-brain");
  const { approveAction: approveVr, listPending: listVr } = await import("./lib/actions-service");
  const orgVr = await makeOrg("pro");
  const payloadVr = await makePayload(orgVr);
  const rVr = await runAgentVr({ orgId: orgVr, payloadId: payloadVr, role: "vendor_risk" }, { db, brain: sbVr });
  ok("vendor_risk run produced an assessment", rVr.ok && rVr.proposalCount === 1);
  const pendVr = await listVr(orgVr, { db });
  const apprVr = await approveVr(orgVr, pendVr[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes vendor_risk_assessments", apprVr.ok && apprVr.recordTable === "vendor_risk_assessments", JSON.stringify(apprVr));
  const { data: vrRows } = await db.from("vendor_risk_assessments").select("org_id,concentration_risk").eq("org_id", orgVr);
  ok("vendor risk record org-stamped", vrRows?.length === 1 && vrRows[0].org_id === orgVr);
  const { data: vrAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgVr);
  ok("approveAction writes agent_accuracy for vendor_risk",
    vrAccRows?.length === 1 && vrAccRows[0].agent_role === "vendor_risk" && vrAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgVr);

  console.log("== onboarding agent ==");
  ok("generate_onboarding_guidance accepts good", validateProposal("generate_onboarding_guidance", {
    data_type_detected: "general tabular data",
    guidance_steps: ["step 1"],
    next_upload_suggestion: "try a financial CSV",
    confidence: "medium",
  }).ok);
  ok("generate_onboarding_guidance filters out empty guidance_steps item", (() => {
    const r = validateProposal("generate_onboarding_guidance", {
      data_type_detected: "x", guidance_steps: ["", "real step"], next_upload_suggestion: "x", confidence: "low",
    });
    return r.ok && (r.payload.guidance_steps as unknown[]).length === 1;
  })());
  ok("generate_onboarding_guidance rejects bad confidence", !validateProposal("generate_onboarding_guidance", {
    data_type_detected: "x", guidance_steps: [], next_upload_suggestion: "x", confidence: "certain",
  }).ok);
  ok("onboarding_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("onboarding_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentOb } = await import("./lib/run-agent");
  const { stubBrain: sbOb } = await import("./lib/agent-brain");
  const { approveAction: approveOb, listPending: listOb } = await import("./lib/actions-service");
  const orgOb = await makeOrg("pro");
  const payloadOb = await makePayload(orgOb);
  const rOb = await runAgentOb({ orgId: orgOb, payloadId: payloadOb, role: "onboarding_agent" }, { db, brain: sbOb });
  ok("onboarding_agent run produced guidance", rOb.ok && rOb.proposalCount === 1);
  const pendOb = await listOb(orgOb, { db });
  const apprOb = await approveOb(orgOb, pendOb[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes onboarding_guidance_runs", apprOb.ok && apprOb.recordTable === "onboarding_guidance_runs", JSON.stringify(apprOb));
  const { data: obRows } = await db.from("onboarding_guidance_runs").select("org_id,confidence").eq("org_id", orgOb);
  ok("onboarding guidance record org-stamped", obRows?.length === 1 && obRows[0].org_id === orgOb);
  const { data: obAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgOb);
  ok("approveAction writes agent_accuracy for onboarding_agent",
    obAccRows?.length === 1 && obAccRows[0].agent_role === "onboarding_agent" && obAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgOb);

  console.log("== clarification agent ==");
  ok("request_clarification accepts good", validateProposal("request_clarification", {
    context: "currency ambiguity detected", urgency: "medium",
    questions: [{ question: "what currency is this data in?", reason: "currency column is ambiguous", options: ["USD", "EUR", "GBP"] }],
  }).ok);
  ok("request_clarification rejects empty questions array", !validateProposal("request_clarification", {
    context: "x", urgency: "low", questions: [],
  }).ok);
  ok("request_clarification rejects bad urgency", !validateProposal("request_clarification", {
    context: "x", urgency: "extreme",
    questions: [{ question: "q", reason: "r" }],
  }).ok);
  ok("clarification_agent → opus model",
    (await import("./lib/agent-brain")).modelForRole("clarification_agent") === "claude-opus-4-8");

  const { runAgent: runAgentCl } = await import("./lib/run-agent");
  const { stubBrain: sbCl } = await import("./lib/agent-brain");
  const { approveAction: approveCl, listPending: listCl } = await import("./lib/actions-service");
  const orgCl = await makeOrg("pro");
  const payloadCl = await makePayload(orgCl);
  const rCl = await runAgentCl({ orgId: orgCl, payloadId: payloadCl, role: "clarification_agent" }, { db, brain: sbCl });
  ok("clarification_agent run produced a request", rCl.ok && rCl.proposalCount === 1);
  const pendCl = await listCl(orgCl, { db });
  const apprCl = await approveCl(orgCl, pendCl[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes clarification_requests", apprCl.ok && apprCl.recordTable === "clarification_requests", JSON.stringify(apprCl));
  const { data: clRows } = await db.from("clarification_requests").select("org_id,urgency").eq("org_id", orgCl);
  ok("clarification request record org-stamped", clRows?.length === 1 && clRows[0].org_id === orgCl);
  const { data: clAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgCl);
  ok("approveAction writes agent_accuracy for clarification_agent",
    clAccRows?.length === 1 && clAccRows[0].agent_role === "clarification_agent" && clAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgCl);

  console.log("== multi period ==");
  ok("analyze_multi_period accepts good", validateProposal("analyze_multi_period", {
    periods_detected: 3, period_labels: ["Q1", "Q2", "Q3"], dominant_pattern: "growth",
    cross_period_insights: [{ insight: "consistent growth", affected_periods: ["Q1", "Q2", "Q3"], significance: "medium" }],
  }).ok);
  ok("analyze_multi_period rejects bad dominant_pattern", !validateProposal("analyze_multi_period", {
    periods_detected: 0, period_labels: [], dominant_pattern: "chaotic", cross_period_insights: [],
  }).ok);
  ok("analyze_multi_period filters out bad cross_period insight significance", (() => {
    const r = validateProposal("analyze_multi_period", {
      periods_detected: 2, period_labels: ["Q1", "Q2"], dominant_pattern: "stable",
      cross_period_insights: [{ insight: "x", affected_periods: ["Q1"], significance: "extreme" }],
    });
    return r.ok && (r.payload.cross_period_insights as unknown[]).length === 0;
  })());
  ok("multi_period → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("multi_period") === "claude-sonnet-4-6");

  const { runAgent: runAgentMp } = await import("./lib/run-agent");
  const { stubBrain: sbMp } = await import("./lib/agent-brain");
  const { approveAction: approveMp, listPending: listMp } = await import("./lib/actions-service");
  const orgMp = await makeOrg("pro");
  const payloadMp = await makePayload(orgMp);
  const rMp = await runAgentMp({ orgId: orgMp, payloadId: payloadMp, role: "multi_period" }, { db, brain: sbMp });
  ok("multi_period run produced an analysis", rMp.ok && rMp.proposalCount === 1);
  const pendMp = await listMp(orgMp, { db });
  const apprMp = await approveMp(orgMp, pendMp[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes multi_period_analyses", apprMp.ok && apprMp.recordTable === "multi_period_analyses", JSON.stringify(apprMp));
  const { data: mpRows } = await db.from("multi_period_analyses").select("org_id,dominant_pattern").eq("org_id", orgMp);
  ok("multi period record org-stamped", mpRows?.length === 1 && mpRows[0].org_id === orgMp);
  const { data: mpAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgMp);
  ok("approveAction writes agent_accuracy for multi_period",
    mpAccRows?.length === 1 && mpAccRows[0].agent_role === "multi_period" && mpAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgMp);

  console.log("== audit summarizer ==");
  ok("summarize_audit_trail accepts good", validateProposal("summarize_audit_trail", {
    events_summarized: 10,
    summary_paragraphs: ["10 audit events processed."],
    key_actions: ["org created", "file uploaded"],
    anomalies_noted: [],
  }).ok);
  ok("summarize_audit_trail filters out empty summary_paragraphs item", (() => {
    const r = validateProposal("summarize_audit_trail", {
      events_summarized: 1, summary_paragraphs: ["", "real paragraph"], key_actions: [], anomalies_noted: [],
    });
    return r.ok && (r.payload.summary_paragraphs as unknown[]).length === 1;
  })());
  ok("summarize_audit_trail rejects negative events_summarized", !validateProposal("summarize_audit_trail", {
    events_summarized: -5, summary_paragraphs: [], key_actions: [], anomalies_noted: [],
  }).ok);
  ok("audit_summarizer → haiku model",
    (await import("./lib/agent-brain")).modelForRole("audit_summarizer") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentAs } = await import("./lib/run-agent");
  const { stubBrain: sbAs } = await import("./lib/agent-brain");
  const { approveAction: approveAs, listPending: listAs } = await import("./lib/actions-service");
  const orgAs = await makeOrg("pro");
  const payloadAs = await makePayload(orgAs);
  const rAs = await runAgentAs({ orgId: orgAs, payloadId: payloadAs, role: "audit_summarizer" }, { db, brain: sbAs });
  ok("audit_summarizer run produced a summary", rAs.ok && rAs.proposalCount === 1);
  const pendAs = await listAs(orgAs, { db });
  const apprAs = await approveAs(orgAs, pendAs[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes audit_summaries", apprAs.ok && apprAs.recordTable === "audit_summaries", JSON.stringify(apprAs));
  const { data: asRows } = await db.from("audit_summaries").select("org_id,events_summarized").eq("org_id", orgAs);
  ok("audit summary record org-stamped", asRows?.length === 1 && asRows[0].org_id === orgAs);
  const { data: asAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgAs);
  ok("approveAction writes agent_accuracy for audit_summarizer",
    asAccRows?.length === 1 && asAccRows[0].agent_role === "audit_summarizer" && asAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgAs);

  console.log("== code reviewer ==");
  ok("review_code accepts good", validateProposal("review_code", {
    findings: [{ location: "row 1", issue_type: "security", severity: "medium", description: "SQL injection risk" }],
    language_detected: "sql", overall_risk: "medium", total_issues: 1,
  }).ok);
  ok("review_code rejects bad overall_risk", !validateProposal("review_code", {
    findings: [], language_detected: "sql", overall_risk: "catastrophic", total_issues: 0,
  }).ok);
  ok("review_code filters out finding with bad issue_type", (() => {
    const r = validateProposal("review_code", {
      findings: [
        { location: "row 1", issue_type: "not_a_type", severity: "low", description: "bad" },
        { location: "row 2", issue_type: "bug", severity: "low", description: "good" },
      ],
      language_detected: "python", overall_risk: "low", total_issues: 2,
    });
    return r.ok && (r.payload.findings as unknown[]).length === 1;
  })());
  ok("code_reviewer → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("code_reviewer") === "claude-sonnet-4-6");

  const { runAgent: runAgentCr } = await import("./lib/run-agent");
  const { stubBrain: sbCr } = await import("./lib/agent-brain");
  const { approveAction: approveCr, listPending: listCr } = await import("./lib/actions-service");
  const orgCr = await makeOrg("pro");
  const payloadCr = await makePayload(orgCr);
  const rCr = await runAgentCr({ orgId: orgCr, payloadId: payloadCr, role: "code_reviewer" }, { db, brain: sbCr });
  ok("code_reviewer run produced a review", rCr.ok && rCr.proposalCount === 1);
  const pendCr = await listCr(orgCr, { db });
  const apprCr = await approveCr(orgCr, pendCr[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes code_review_runs", apprCr.ok && apprCr.recordTable === "code_review_runs", JSON.stringify(apprCr));
  const { data: crRows } = await db.from("code_review_runs").select("org_id,overall_risk").eq("org_id", orgCr);
  ok("code review record org-stamped", crRows?.length === 1 && crRows[0].org_id === orgCr);
  const { data: crAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgCr);
  ok("approveAction writes agent_accuracy for code_reviewer",
    crAccRows?.length === 1 && crAccRows[0].agent_role === "code_reviewer" && crAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgCr);

  console.log("== code tester ==");
  ok("generate_tests accepts good", validateProposal("generate_tests", {
    test_cases: [{ name: "t1", description: "d1", test_type: "unit", pseudocode: "assert(1==1)" }],
    language_detected: "javascript", framework_suggested: "jest", coverage_estimate: 60,
  }).ok);
  ok("generate_tests rejects coverage_estimate > 100", !validateProposal("generate_tests", {
    test_cases: [], language_detected: "javascript", framework_suggested: "jest", coverage_estimate: 150,
  }).ok);
  ok("generate_tests filters out test case with bad test_type", (() => {
    const r = validateProposal("generate_tests", {
      test_cases: [
        { name: "t1", description: "d1", test_type: "fuzzing", pseudocode: "x" },
        { name: "t2", description: "d2", test_type: "unit", pseudocode: "y" },
      ],
      language_detected: "python", framework_suggested: "pytest", coverage_estimate: 40,
    });
    return r.ok && (r.payload.test_cases as unknown[]).length === 1;
  })());
  ok("code_tester → opus model",
    (await import("./lib/agent-brain")).modelForRole("code_tester") === "claude-opus-4-8");

  const { runAgent: runAgentCt } = await import("./lib/run-agent");
  const { stubBrain: sbCt } = await import("./lib/agent-brain");
  const { approveAction: approveCt, listPending: listCt } = await import("./lib/actions-service");
  const orgCt = await makeOrg("pro");
  const payloadCt = await makePayload(orgCt);
  const rCt = await runAgentCt({ orgId: orgCt, payloadId: payloadCt, role: "code_tester" }, { db, brain: sbCt });
  ok("code_tester run produced tests", rCt.ok && rCt.proposalCount === 1);
  const pendCt = await listCt(orgCt, { db });
  const apprCt = await approveCt(orgCt, pendCt[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes test_generation_runs", apprCt.ok && apprCt.recordTable === "test_generation_runs", JSON.stringify(apprCt));
  const { data: ctRows } = await db.from("test_generation_runs").select("org_id,coverage_estimate").eq("org_id", orgCt);
  ok("test generation record org-stamped", ctRows?.length === 1 && ctRows[0].org_id === orgCt);
  const { data: ctAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgCt);
  ok("approveAction writes agent_accuracy for code_tester",
    ctAccRows?.length === 1 && ctAccRows[0].agent_role === "code_tester" && ctAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgCt);

  console.log("== sql analyst ==");
  ok("analyze_sql accepts good", validateProposal("analyze_sql", {
    queries_found: 1,
    issues: [{ query_reference: "row 1", issue_type: "injection_risk", severity: "high", description: "unparameterized" }],
    optimizations: [{ query_reference: "row 1", suggestion: "use parameterized queries" }],
    risk_level: "high",
  }).ok);
  ok("analyze_sql rejects bad risk_level", !validateProposal("analyze_sql", {
    queries_found: 0, issues: [], optimizations: [], risk_level: "catastrophic",
  }).ok);
  ok("analyze_sql filters out issue with bad issue_type", (() => {
    const r = validateProposal("analyze_sql", {
      queries_found: 2,
      issues: [
        { query_reference: "row 1", issue_type: "sorcery", severity: "low", description: "bad" },
        { query_reference: "row 2", issue_type: "performance", severity: "low", description: "good" },
      ],
      optimizations: [], risk_level: "low",
    });
    return r.ok && (r.payload.issues as unknown[]).length === 1;
  })());
  ok("sql_analyst → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("sql_analyst") === "claude-sonnet-4-6");

  const { runAgent: runAgentSq } = await import("./lib/run-agent");
  const { stubBrain: sbSq } = await import("./lib/agent-brain");
  const { approveAction: approveSq, listPending: listSq } = await import("./lib/actions-service");
  const orgSq = await makeOrg("pro");
  const payloadSq = await makePayload(orgSq);
  const rSq = await runAgentSq({ orgId: orgSq, payloadId: payloadSq, role: "sql_analyst" }, { db, brain: sbSq });
  ok("sql_analyst run produced an analysis", rSq.ok && rSq.proposalCount === 1);
  const pendSq = await listSq(orgSq, { db });
  const apprSq = await approveSq(orgSq, pendSq[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes sql_analysis_runs", apprSq.ok && apprSq.recordTable === "sql_analysis_runs", JSON.stringify(apprSq));
  const { data: sqRows } = await db.from("sql_analysis_runs").select("org_id,risk_level").eq("org_id", orgSq);
  ok("sql analysis record org-stamped", sqRows?.length === 1 && sqRows[0].org_id === orgSq);
  const { data: sqAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgSq);
  ok("approveAction writes agent_accuracy for sql_analyst",
    sqAccRows?.length === 1 && sqAccRows[0].agent_role === "sql_analyst" && sqAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgSq);

  console.log("== validator ==");
  ok("validate_analysis accepts good", validateProposal("validate_analysis", {
    concerns: [{ area: "data completeness", concern: "sample may be small", severity: "low" }],
    data_interpretability: "clear", confidence_in_swarm: "high", recommendation: "proceed",
  }).ok);
  ok("validate_analysis rejects bad recommendation", !validateProposal("validate_analysis", {
    concerns: [], data_interpretability: "clear", confidence_in_swarm: "high", recommendation: "escalate",
  }).ok);
  ok("validate_analysis rejects bad confidence_in_swarm", !validateProposal("validate_analysis", {
    concerns: [], data_interpretability: "clear", confidence_in_swarm: "nonexistent", recommendation: "proceed",
  }).ok);
  ok("validator → opus model",
    (await import("./lib/agent-brain")).modelForRole("validator") === "claude-opus-4-8");

  const { runAgent: runAgentVl } = await import("./lib/run-agent");
  const { stubBrain: sbVl } = await import("./lib/agent-brain");
  const { approveAction: approveVl, listPending: listVl } = await import("./lib/actions-service");
  const orgVl = await makeOrg("pro");
  const payloadVl = await makePayload(orgVl);
  const rVl = await runAgentVl({ orgId: orgVl, payloadId: payloadVl, role: "validator" }, { db, brain: sbVl });
  ok("validator run produced a report", rVl.ok && rVl.proposalCount === 1);
  const pendVl = await listVl(orgVl, { db });
  const apprVl = await approveVl(orgVl, pendVl[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes validation_reports", apprVl.ok && apprVl.recordTable === "validation_reports", JSON.stringify(apprVl));
  const { data: vlRows } = await db.from("validation_reports").select("org_id,recommendation").eq("org_id", orgVl);
  ok("validation report record org-stamped", vlRows?.length === 1 && vlRows[0].org_id === orgVl);
  const { data: vlAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgVl);
  ok("approveAction writes agent_accuracy for validator",
    vlAccRows?.length === 1 && vlAccRows[0].agent_role === "validator" && vlAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgVl);

  console.log("== health scorer ==");
  ok("generate_health_score accepts good", validateProposal("generate_health_score", {
    overall_score: 80, grade: "B",
    dimensions: [{ dimension: "data_quality", score: 80, notes: "looks clean" }],
    summary: "Business health score of 80/100.",
  }).ok);
  ok("generate_health_score rejects overall_score > 100", !validateProposal("generate_health_score", {
    overall_score: 150, grade: "A", dimensions: [], summary: "x",
  }).ok);
  ok("generate_health_score rejects bad grade", !validateProposal("generate_health_score", {
    overall_score: 80, grade: "Z", dimensions: [], summary: "x",
  }).ok);
  ok("health_scorer → haiku model",
    (await import("./lib/agent-brain")).modelForRole("health_scorer") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentHs } = await import("./lib/run-agent");
  const { stubBrain: sbHs } = await import("./lib/agent-brain");
  const { approveAction: approveHs, listPending: listHs } = await import("./lib/actions-service");
  const orgHs = await makeOrg("pro");
  const payloadHs = await makePayload(orgHs);
  const rHs = await runAgentHs({ orgId: orgHs, payloadId: payloadHs, role: "health_scorer" }, { db, brain: sbHs });
  ok("health_scorer run produced a score", rHs.ok && rHs.proposalCount === 1);
  const pendHs = await listHs(orgHs, { db });
  const apprHs = await approveHs(orgHs, pendHs[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes health_score_runs", apprHs.ok && apprHs.recordTable === "health_score_runs", JSON.stringify(apprHs));
  const { data: hsRows } = await db.from("health_score_runs").select("org_id,overall_score").eq("org_id", orgHs);
  ok("health score record org-stamped", hsRows?.length === 1 && hsRows[0].org_id === orgHs);
  const { data: hsAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgHs);
  ok("approveAction writes agent_accuracy for health_scorer",
    hsAccRows?.length === 1 && hsAccRows[0].agent_role === "health_scorer" && hsAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgHs);

  console.log("== email drafter ==");
  ok("draft_email accepts good", validateProposal("draft_email", {
    subject: "Summary", body: "Here is a summary.", recipient_type: "internal", tone: "professional",
    key_points: ["point one"],
  }).ok);
  ok("draft_email rejects bad recipient_type", !validateProposal("draft_email", {
    subject: "S", body: "B", recipient_type: "everyone", tone: "professional", key_points: [],
  }).ok);
  ok("draft_email rejects empty subject", !validateProposal("draft_email", {
    subject: "", body: "B", recipient_type: "internal", tone: "professional", key_points: [],
  }).ok);
  ok("email_drafter → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("email_drafter") === "claude-sonnet-4-6");

  const { runAgent: runAgentEd } = await import("./lib/run-agent");
  const { stubBrain: sbEd } = await import("./lib/agent-brain");
  const { approveAction: approveEd, listPending: listEd } = await import("./lib/actions-service");
  const orgEd = await makeOrg("pro");
  const payloadEd = await makePayload(orgEd);
  const rEd = await runAgentEd({ orgId: orgEd, payloadId: payloadEd, role: "email_drafter" }, { db, brain: sbEd });
  ok("email_drafter run produced a draft", rEd.ok && rEd.proposalCount === 1);
  const pendEd = await listEd(orgEd, { db });
  const apprEd = await approveEd(orgEd, pendEd[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes email_drafts", apprEd.ok && apprEd.recordTable === "email_drafts", JSON.stringify(apprEd));
  const { data: edRows } = await db.from("email_drafts").select("org_id,subject").eq("org_id", orgEd);
  ok("email draft record org-stamped", edRows?.length === 1 && edRows[0].org_id === orgEd);
  const { data: edAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgEd);
  ok("approveAction writes agent_accuracy for email_drafter",
    edAccRows?.length === 1 && edAccRows[0].agent_role === "email_drafter" && edAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgEd);

  console.log("== recommender ==");
  ok("generate_recommendations accepts good", validateProposal("generate_recommendations", {
    recommendations: [{ action: "review anomalies", reason: "anomalies detected", impact: "medium", effort: "low" }],
    next_upload_type: "financial CSV with monthly totals", priority: "medium",
  }).ok);
  ok("generate_recommendations filters out recommendation with bad impact", (() => {
    const r = validateProposal("generate_recommendations", {
      recommendations: [
        { action: "a1", reason: "r1", impact: "extreme", effort: "low" },
        { action: "a2", reason: "r2", impact: "high", effort: "low" },
      ],
      next_upload_type: "x", priority: "medium",
    });
    return r.ok && (r.payload.recommendations as unknown[]).length === 1;
  })());
  ok("generate_recommendations rejects bad priority", !validateProposal("generate_recommendations", {
    recommendations: [], next_upload_type: "x", priority: "someday",
  }).ok);
  ok("recommender → haiku model",
    (await import("./lib/agent-brain")).modelForRole("recommender") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentRm } = await import("./lib/run-agent");
  const { stubBrain: sbRm } = await import("./lib/agent-brain");
  const { approveAction: approveRm, listPending: listRm } = await import("./lib/actions-service");
  const orgRm = await makeOrg("pro");
  const payloadRm = await makePayload(orgRm);
  const rRm = await runAgentRm({ orgId: orgRm, payloadId: payloadRm, role: "recommender" }, { db, brain: sbRm });
  ok("recommender run produced recommendations", rRm.ok && rRm.proposalCount === 1);
  const pendRm = await listRm(orgRm, { db });
  const apprRm = await approveRm(orgRm, pendRm[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes recommendation_runs", apprRm.ok && apprRm.recordTable === "recommendation_runs", JSON.stringify(apprRm));
  const { data: rmRows } = await db.from("recommendation_runs").select("org_id,priority").eq("org_id", orgRm);
  ok("recommendation record org-stamped", rmRows?.length === 1 && rmRows[0].org_id === orgRm);
  const { data: rmAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgRm);
  ok("approveAction writes agent_accuracy for recommender",
    rmAccRows?.length === 1 && rmAccRows[0].agent_role === "recommender" && rmAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgRm);

  console.log("== pattern memory ==");
  ok("extract_patterns accepts good", validateProposal("extract_patterns", {
    patterns: [{ pattern_type: "column_naming", description: "snake_case columns", confidence: 0.9, example_values: ["amount", "created_at"], recurring: true }],
    pattern_count: 1, learnable: true,
  }).ok);
  ok("extract_patterns filters out pattern with confidence out of range", (() => {
    const r = validateProposal("extract_patterns", {
      patterns: [{ pattern_type: "x", description: "y", confidence: 1.5, example_values: [], recurring: false }],
      pattern_count: 1, learnable: false,
    });
    return r.ok && (r.payload.patterns as unknown[]).length === 0;
  })());
  ok("extract_patterns filters out pattern missing pattern_type", (() => {
    const r = validateProposal("extract_patterns", {
      patterns: [
        { description: "no type", confidence: 0.5, example_values: [], recurring: false },
        { pattern_type: "value_range", description: "typical range", confidence: 0.5, example_values: [], recurring: false },
      ],
      pattern_count: 2, learnable: true,
    });
    return r.ok && (r.payload.patterns as unknown[]).length === 1;
  })());
  ok("extract_patterns rejects negative pattern_count", !validateProposal("extract_patterns", {
    patterns: [], pattern_count: -1, learnable: false,
  }).ok);
  ok("pattern_memory → haiku model",
    (await import("./lib/agent-brain")).modelForRole("pattern_memory") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentPm } = await import("./lib/run-agent");
  const { stubBrain: sbPm } = await import("./lib/agent-brain");
  const { approveAction: approvePm, listPending: listPm } = await import("./lib/actions-service");
  const orgPm = await makeOrg("pro");
  const payloadPm = await makePayload(orgPm);
  const rPm = await runAgentPm({ orgId: orgPm, payloadId: payloadPm, role: "pattern_memory" }, { db, brain: sbPm });
  ok("pattern_memory run produced an extraction", rPm.ok && rPm.proposalCount === 1);
  const pendPm = await listPm(orgPm, { db });
  const apprPm = await approvePm(orgPm, pendPm[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes pattern_extractions", apprPm.ok && apprPm.recordTable === "pattern_extractions", JSON.stringify(apprPm));
  const { data: pmRows } = await db.from("pattern_extractions").select("org_id,pattern_count").eq("org_id", orgPm);
  ok("pattern extraction record org-stamped", pmRows?.length === 1 && pmRows[0].org_id === orgPm);
  const { data: pmAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgPm);
  ok("approveAction writes agent_accuracy for pattern_memory",
    pmAccRows?.length === 1 && pmAccRows[0].agent_role === "pattern_memory" && pmAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgPm);

  console.log("== alert agent ==");
  ok("generate_alerts accepts good", validateProposal("generate_alerts", {
    alerts: [{ area: "cash_flow", condition: "low balance", severity: "warning", message: "balance is low", recommended_action: "review payables" }],
    severity_level: "warning", requires_immediate_action: false, summary: "1 warning detected.",
  }).ok);
  ok("generate_alerts rejects bad severity_level", !validateProposal("generate_alerts", {
    alerts: [], severity_level: "catastrophic", requires_immediate_action: false, summary: "x",
  }).ok);
  ok("generate_alerts filters out alert with bad severity", (() => {
    const r = validateProposal("generate_alerts", {
      alerts: [
        { area: "a1", condition: "c1", severity: "apocalyptic", message: "m1", recommended_action: "r1" },
        { area: "a2", condition: "c2", severity: "critical", message: "m2", recommended_action: "r2" },
      ],
      severity_level: "critical", requires_immediate_action: true, summary: "x",
    });
    return r.ok && (r.payload.alerts as unknown[]).length === 1;
  })());
  ok("alert_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("alert_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentAl } = await import("./lib/run-agent");
  const { stubBrain: sbAl } = await import("./lib/agent-brain");
  const { approveAction: approveAl, listPending: listAl } = await import("./lib/actions-service");
  const orgAl = await makeOrg("pro");
  const payloadAl = await makePayload(orgAl);
  const rAl = await runAgentAl({ orgId: orgAl, payloadId: payloadAl, role: "alert_agent" }, { db, brain: sbAl });
  ok("alert_agent run produced an alert set", rAl.ok && rAl.proposalCount === 1);
  const pendAl = await listAl(orgAl, { db });
  const apprAl = await approveAl(orgAl, pendAl[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes alert_runs", apprAl.ok && apprAl.recordTable === "alert_runs", JSON.stringify(apprAl));
  const { data: alRows } = await db.from("alert_runs").select("org_id,severity_level").eq("org_id", orgAl);
  ok("alert run record org-stamped", alRows?.length === 1 && alRows[0].org_id === orgAl);
  const { data: alAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgAl);
  ok("approveAction writes agent_accuracy for alert_agent",
    alAccRows?.length === 1 && alAccRows[0].agent_role === "alert_agent" && alAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgAl);

  console.log("== client reporter ==");
  ok("generate_client_report accepts good", validateProposal("generate_client_report", {
    report_title: "Monthly Report", executive_summary: "Key findings summarized.",
    sections: [{ heading: "Overview", content: "Business data processed." }],
    key_takeaways: ["Data quality is acceptable"], next_steps: ["Review flagged items"],
  }).ok);
  ok("generate_client_report rejects empty report_title", !validateProposal("generate_client_report", {
    report_title: "", executive_summary: "x", sections: [], key_takeaways: [], next_steps: [],
  }).ok);
  ok("generate_client_report filters out section missing heading", (() => {
    const r = validateProposal("generate_client_report", {
      report_title: "R", executive_summary: "S",
      sections: [
        { content: "no heading" },
        { heading: "Overview", content: "has heading" },
      ],
      key_takeaways: [], next_steps: [],
    });
    return r.ok && (r.payload.sections as unknown[]).length === 1;
  })());
  ok("client_reporter → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("client_reporter") === "claude-sonnet-4-6");

  const { runAgent: runAgentCrp } = await import("./lib/run-agent");
  const { stubBrain: sbCrp } = await import("./lib/agent-brain");
  const { approveAction: approveCrp, listPending: listCrp } = await import("./lib/actions-service");
  const orgCrp = await makeOrg("pro");
  const payloadCrp = await makePayload(orgCrp);
  const rCrp = await runAgentCrp({ orgId: orgCrp, payloadId: payloadCrp, role: "client_reporter" }, { db, brain: sbCrp });
  ok("client_reporter run produced a report", rCrp.ok && rCrp.proposalCount === 1);
  const pendCrp = await listCrp(orgCrp, { db });
  const apprCrp = await approveCrp(orgCrp, pendCrp[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes client_report_runs", apprCrp.ok && apprCrp.recordTable === "client_report_runs", JSON.stringify(apprCrp));
  const { data: crpRows } = await db.from("client_report_runs").select("org_id,report_title").eq("org_id", orgCrp);
  ok("client report record org-stamped", crpRows?.length === 1 && crpRows[0].org_id === orgCrp);
  const { data: crpAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgCrp);
  ok("approveAction writes agent_accuracy for client_reporter",
    crpAccRows?.length === 1 && crpAccRows[0].agent_role === "client_reporter" && crpAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgCrp);

  console.log("== narrator ==");
  ok("generate_narrative accepts good", validateProposal("generate_narrative", {
    headline: "Business holds steady", story: "The data shows consistent performance.",
    tone: "neutral", audience: "client", word_count: 6,
  }).ok);
  ok("generate_narrative rejects bad tone", !validateProposal("generate_narrative", {
    headline: "H", story: "S", tone: "dramatic", audience: "client", word_count: 1,
  }).ok);
  ok("generate_narrative rejects empty headline", !validateProposal("generate_narrative", {
    headline: "", story: "S", tone: "neutral", audience: "client", word_count: 1,
  }).ok);
  ok("narrator → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("narrator") === "claude-sonnet-4-6");

  const { runAgent: runAgentNr } = await import("./lib/run-agent");
  const { stubBrain: sbNr } = await import("./lib/agent-brain");
  const { approveAction: approveNr, listPending: listNr } = await import("./lib/actions-service");
  const orgNr = await makeOrg("pro");
  const payloadNr = await makePayload(orgNr);
  const rNr = await runAgentNr({ orgId: orgNr, payloadId: payloadNr, role: "narrator" }, { db, brain: sbNr });
  ok("narrator run produced a narrative", rNr.ok && rNr.proposalCount === 1);
  const pendNr = await listNr(orgNr, { db });
  const apprNr = await approveNr(orgNr, pendNr[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes narrative_runs", apprNr.ok && apprNr.recordTable === "narrative_runs", JSON.stringify(apprNr));
  const { data: nrRows } = await db.from("narrative_runs").select("org_id,headline").eq("org_id", orgNr);
  ok("narrative record org-stamped", nrRows?.length === 1 && nrRows[0].org_id === orgNr);
  const { data: nrAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgNr);
  ok("approveAction writes agent_accuracy for narrator",
    nrAccRows?.length === 1 && nrAccRows[0].agent_role === "narrator" && nrAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgNr);

  console.log("== meeting prepper ==");
  ok("prepare_meeting accepts good", validateProposal("prepare_meeting", {
    meeting_type: "monthly_review",
    agenda_items: [{ item: "Review performance", duration_minutes: 15, priority: "high" }],
    talking_points: ["Discuss key metrics"],
    questions_to_ask: ["What drove the change?"],
    likely_client_questions: [{ question: "How are we doing?", suggested_answer: "Within range." }],
  }).ok);
  ok("prepare_meeting rejects bad meeting_type", !validateProposal("prepare_meeting", {
    meeting_type: "ad_hoc", agenda_items: [], talking_points: [], questions_to_ask: [], likely_client_questions: [],
  }).ok);
  ok("prepare_meeting filters out agenda item with duration_minutes out of range", (() => {
    const r = validateProposal("prepare_meeting", {
      meeting_type: "general",
      agenda_items: [
        { item: "too long", duration_minutes: 120, priority: "low" },
        { item: "fine", duration_minutes: 10, priority: "low" },
      ],
      talking_points: [], questions_to_ask: [], likely_client_questions: [],
    });
    return r.ok && (r.payload.agenda_items as unknown[]).length === 1;
  })());
  ok("meeting_prepper → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("meeting_prepper") === "claude-sonnet-4-6");

  const { runAgent: runAgentMtg } = await import("./lib/run-agent");
  const { stubBrain: sbMtg } = await import("./lib/agent-brain");
  const { approveAction: approveMtg, listPending: listMtg } = await import("./lib/actions-service");
  const orgMtg = await makeOrg("pro");
  const payloadMtg = await makePayload(orgMtg);
  const rMtg = await runAgentMtg({ orgId: orgMtg, payloadId: payloadMtg, role: "meeting_prepper" }, { db, brain: sbMtg });
  ok("meeting_prepper run produced a prep", rMtg.ok && rMtg.proposalCount === 1);
  const pendMtg = await listMtg(orgMtg, { db });
  const apprMtg = await approveMtg(orgMtg, pendMtg[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes meeting_prep_runs", apprMtg.ok && apprMtg.recordTable === "meeting_prep_runs", JSON.stringify(apprMtg));
  const { data: mtgRows } = await db.from("meeting_prep_runs").select("org_id,meeting_type").eq("org_id", orgMtg);
  ok("meeting prep record org-stamped", mtgRows?.length === 1 && mtgRows[0].org_id === orgMtg);
  const { data: mtgAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgMtg);
  ok("approveAction writes agent_accuracy for meeting_prepper",
    mtgAccRows?.length === 1 && mtgAccRows[0].agent_role === "meeting_prepper" && mtgAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgMtg);

  console.log("== board deck builder ==");
  ok("build_board_deck accepts good", validateProposal("build_board_deck", {
    slides: [{ slide_number: 1, title: "Overview", content_type: "title_slide", bullet_points: [], speaker_notes: "Welcome." }],
    key_metrics: [{ metric: "Revenue", value: "$10k", trend: "up" }],
    narrative_thread: "Business performance reviewed.",
  }).ok);
  ok("build_board_deck filters out slide with bad content_type", (() => {
    const r = validateProposal("build_board_deck", {
      slides: [{ slide_number: 1, title: "T", content_type: "video", bullet_points: [], speaker_notes: "n" }],
      key_metrics: [], narrative_thread: "x",
    });
    return r.ok && (r.payload.slides as unknown[]).length === 0;
  })());
  ok("build_board_deck filters out key_metric with bad trend", (() => {
    const r = validateProposal("build_board_deck", {
      slides: [],
      key_metrics: [
        { metric: "Revenue", value: "$10k", trend: "sideways" },
        { metric: "Costs", value: "$5k", trend: "down" },
      ],
      narrative_thread: "x",
    });
    return r.ok && (r.payload.key_metrics as unknown[]).length === 1;
  })());
  ok("board_deck_builder → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("board_deck_builder") === "claude-sonnet-4-6");

  const { runAgent: runAgentBd } = await import("./lib/run-agent");
  const { stubBrain: sbBd } = await import("./lib/agent-brain");
  const { approveAction: approveBd, listPending: listBd } = await import("./lib/actions-service");
  const orgBd = await makeOrg("pro");
  const payloadBd = await makePayload(orgBd);
  const rBd = await runAgentBd({ orgId: orgBd, payloadId: payloadBd, role: "board_deck_builder" }, { db, brain: sbBd });
  ok("board_deck_builder run produced a deck", rBd.ok && rBd.proposalCount === 1);
  const pendBd = await listBd(orgBd, { db });
  const apprBd = await approveBd(orgBd, pendBd[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes board_deck_runs", apprBd.ok && apprBd.recordTable === "board_deck_runs", JSON.stringify(apprBd));
  const { data: bdRows } = await db.from("board_deck_runs").select("org_id,narrative_thread").eq("org_id", orgBd);
  ok("board deck record org-stamped", bdRows?.length === 1 && bdRows[0].org_id === orgBd);
  const { data: bdAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgBd);
  ok("approveAction writes agent_accuracy for board_deck_builder",
    bdAccRows?.length === 1 && bdAccRows[0].agent_role === "board_deck_builder" && bdAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgBd);

  console.log("== viz recommender ==");
  ok("recommend_visualizations accepts good", validateProposal("recommend_visualizations", {
    recommendations: [{ chart_type: "bar", title: "Value by Category", x_axis_field: "category", y_axis_field: "amount", reason: "categorical data", priority: "primary" }],
    data_shape: "categorical", total_recommended: 1,
  }).ok);
  ok("recommend_visualizations rejects bad data_shape", !validateProposal("recommend_visualizations", {
    recommendations: [], data_shape: "unknown_shape", total_recommended: 0,
  }).ok);
  ok("recommend_visualizations filters out recommendation with bad chart_type", (() => {
    const r = validateProposal("recommend_visualizations", {
      recommendations: [
        { chart_type: "gauge", title: "t1", x_axis_field: "x", y_axis_field: "y", reason: "r", priority: "primary" },
        { chart_type: "line", title: "t2", x_axis_field: "x", y_axis_field: "y", reason: "r", priority: "secondary" },
      ],
      data_shape: "time_series", total_recommended: 2,
    });
    return r.ok && (r.payload.recommendations as unknown[]).length === 1;
  })());
  ok("recommend_visualizations rejects bad priority via filtering", (() => {
    const r = validateProposal("recommend_visualizations", {
      recommendations: [{ chart_type: "bar", title: "t", x_axis_field: "x", y_axis_field: "y", reason: "r", priority: "critical" }],
      data_shape: "categorical", total_recommended: 1,
    });
    return r.ok && (r.payload.recommendations as unknown[]).length === 0;
  })());
  ok("viz_recommender → haiku model",
    (await import("./lib/agent-brain")).modelForRole("viz_recommender") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentVz } = await import("./lib/run-agent");
  const { stubBrain: sbVz } = await import("./lib/agent-brain");
  const { approveAction: approveVz, listPending: listVz } = await import("./lib/actions-service");
  const orgVz = await makeOrg("pro");
  const payloadVz = await makePayload(orgVz);
  const rVz = await runAgentVz({ orgId: orgVz, payloadId: payloadVz, role: "viz_recommender" }, { db, brain: sbVz });
  ok("viz_recommender run produced recommendations", rVz.ok && rVz.proposalCount === 1);
  const pendVz = await listVz(orgVz, { db });
  const apprVz = await approveVz(orgVz, pendVz[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes viz_recommendation_runs", apprVz.ok && apprVz.recordTable === "viz_recommendation_runs", JSON.stringify(apprVz));
  const { data: vzRows } = await db.from("viz_recommendation_runs").select("org_id,data_shape").eq("org_id", orgVz);
  ok("viz recommendation record org-stamped", vzRows?.length === 1 && vzRows[0].org_id === orgVz);
  const { data: vzAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgVz);
  ok("approveAction writes agent_accuracy for viz_recommender",
    vzAccRows?.length === 1 && vzAccRows[0].agent_role === "viz_recommender" && vzAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgVz);

  console.log("== chart config agent ==");
  ok("generate_chart_configs accepts good", validateProposal("generate_chart_configs", {
    configs: [{
      chart_id: "revenue-by-month", chart_type: "bar", title: "Revenue by Month",
      x_axis_label: "Month", y_axis_label: "Revenue", data_columns: ["month", "revenue"],
      color_scheme: "blue", aggregation: "sum", notes: "Monthly rollup",
    }],
    total_configs: 1,
  }).ok);
  ok("generate_chart_configs rejects bad total_configs", !validateProposal("generate_chart_configs", {
    configs: [], total_configs: -1,
  }).ok);
  ok("generate_chart_configs filters out config with bad chart_type", (() => {
    const r = validateProposal("generate_chart_configs", {
      configs: [
        { chart_id: "c1", chart_type: "radar", title: "T1", x_axis_label: "x", y_axis_label: "y", data_columns: [], color_scheme: "blue", aggregation: "sum", notes: "n" },
        { chart_id: "c2", chart_type: "line", title: "T2", x_axis_label: "x", y_axis_label: "y", data_columns: [], color_scheme: "green", aggregation: "count", notes: "n" },
      ],
      total_configs: 2,
    });
    return r.ok && (r.payload.configs as unknown[]).length === 1;
  })());
  ok("generate_chart_configs filters out config with bad color_scheme", (() => {
    const r = validateProposal("generate_chart_configs", {
      configs: [{ chart_id: "c1", chart_type: "bar", title: "T1", x_axis_label: "x", y_axis_label: "y", data_columns: [], color_scheme: "rainbow", aggregation: "sum", notes: "n" }],
      total_configs: 1,
    });
    return r.ok && (r.payload.configs as unknown[]).length === 0;
  })());
  ok("generate_chart_configs filters out config with bad aggregation", (() => {
    const r = validateProposal("generate_chart_configs", {
      configs: [{ chart_id: "c1", chart_type: "bar", title: "T1", x_axis_label: "x", y_axis_label: "y", data_columns: [], color_scheme: "blue", aggregation: "median", notes: "n" }],
      total_configs: 1,
    });
    return r.ok && (r.payload.configs as unknown[]).length === 0;
  })());
  ok("chart_config_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("chart_config_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentCc } = await import("./lib/run-agent");
  const { stubBrain: sbCc } = await import("./lib/agent-brain");
  const { approveAction: approveCc, listPending: listCc } = await import("./lib/actions-service");
  const orgCc = await makeOrg("pro");
  const payloadCc = await makePayload(orgCc);
  const rCc = await runAgentCc({ orgId: orgCc, payloadId: payloadCc, role: "chart_config_agent" }, { db, brain: sbCc });
  ok("chart_config_agent run produced configs", rCc.ok && rCc.proposalCount === 1);
  const pendCc = await listCc(orgCc, { db });
  const apprCc = await approveCc(orgCc, pendCc[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes chart_config_runs", apprCc.ok && apprCc.recordTable === "chart_config_runs", JSON.stringify(apprCc));
  const { data: ccRows } = await db.from("chart_config_runs").select("org_id,total_configs").eq("org_id", orgCc);
  ok("chart config record org-stamped", ccRows?.length === 1 && ccRows[0].org_id === orgCc);
  const { data: ccAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgCc);
  ok("approveAction writes agent_accuracy for chart_config_agent",
    ccAccRows?.length === 1 && ccAccRows[0].agent_role === "chart_config_agent" && ccAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgCc);

  console.log("== kpi card agent ==");
  ok("extract_kpi_cards accepts good", validateProposal("extract_kpi_cards", {
    kpi_cards: [{ metric_name: "Total Revenue", value: "$124,500", unit: "$", trend: "up", category: "revenue", is_primary: true }],
    total_kpis: 1,
  }).ok);
  ok("extract_kpi_cards filters out kpi_card with bad trend", (() => {
    const r = validateProposal("extract_kpi_cards", {
      kpi_cards: [
        { metric_name: "M1", value: "V1", unit: "", trend: "sideways", category: "other", is_primary: false },
        { metric_name: "M2", value: "V2", unit: "%", trend: "up", category: "growth", is_primary: true },
      ],
      total_kpis: 2,
    });
    return r.ok && (r.payload.kpi_cards as unknown[]).length === 1;
  })());
  ok("extract_kpi_cards filters out kpi_card with bad category", (() => {
    const r = validateProposal("extract_kpi_cards", {
      kpi_cards: [{ metric_name: "M1", value: "V1", unit: "", trend: "flat", category: "bogus", is_primary: false }],
      total_kpis: 1,
    });
    return r.ok && (r.payload.kpi_cards as unknown[]).length === 0;
  })());
  ok("kpi_card_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("kpi_card_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentKp } = await import("./lib/run-agent");
  const { stubBrain: sbKp } = await import("./lib/agent-brain");
  const { approveAction: approveKp, listPending: listKp } = await import("./lib/actions-service");
  const orgKp = await makeOrg("pro");
  const payloadKp = await makePayload(orgKp);
  const rKp = await runAgentKp({ orgId: orgKp, payloadId: payloadKp, role: "kpi_card_agent" }, { db, brain: sbKp });
  ok("kpi_card_agent run produced kpi cards", rKp.ok && rKp.proposalCount === 1);
  const pendKp = await listKp(orgKp, { db });
  const apprKp = await approveKp(orgKp, pendKp[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes kpi_card_runs", apprKp.ok && apprKp.recordTable === "kpi_card_runs", JSON.stringify(apprKp));
  const { data: kpRows } = await db.from("kpi_card_runs").select("org_id,total_kpis").eq("org_id", orgKp);
  ok("kpi card record org-stamped", kpRows?.length === 1 && kpRows[0].org_id === orgKp);
  const { data: kpAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgKp);
  ok("approveAction writes agent_accuracy for kpi_card_agent",
    kpAccRows?.length === 1 && kpAccRows[0].agent_role === "kpi_card_agent" && kpAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgKp);

  console.log("== dashboard spec agent ==");
  ok("generate_dashboard_spec accepts good", validateProposal("generate_dashboard_spec", {
    dashboard_title: "Business Overview Dashboard", layout: "mixed",
    sections: [{ section_title: "Key Metrics", section_type: "kpi_row", component_ids: ["kpi-total-revenue"], display_order: 1 }],
    recommended_refresh: "on_upload", total_components: 1,
  }).ok);
  ok("generate_dashboard_spec rejects bad layout", !validateProposal("generate_dashboard_spec", {
    dashboard_title: "D", layout: "creative", sections: [], recommended_refresh: "daily", total_components: 0,
  }).ok);
  ok("generate_dashboard_spec filters out section with bad section_type", (() => {
    const r = validateProposal("generate_dashboard_spec", {
      dashboard_title: "D", layout: "executive",
      sections: [
        { section_title: "S1", section_type: "video_section", component_ids: [], display_order: 1 },
        { section_title: "S2", section_type: "chart_section", component_ids: [], display_order: 2 },
      ],
      recommended_refresh: "weekly", total_components: 2,
    });
    return r.ok && (r.payload.sections as unknown[]).length === 1;
  })());
  ok("generate_dashboard_spec rejects bad recommended_refresh", !validateProposal("generate_dashboard_spec", {
    dashboard_title: "D", layout: "operational", sections: [], recommended_refresh: "hourly", total_components: 0,
  }).ok);
  ok("dashboard_spec_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("dashboard_spec_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentDs } = await import("./lib/run-agent");
  const { stubBrain: sbDs } = await import("./lib/agent-brain");
  const { approveAction: approveDs, listPending: listDs } = await import("./lib/actions-service");
  const orgDs = await makeOrg("pro");
  const payloadDs = await makePayload(orgDs);
  const rDs = await runAgentDs({ orgId: orgDs, payloadId: payloadDs, role: "dashboard_spec_agent" }, { db, brain: sbDs });
  ok("dashboard_spec_agent run produced a spec", rDs.ok && rDs.proposalCount === 1);
  const pendDs = await listDs(orgDs, { db });
  const apprDs = await approveDs(orgDs, pendDs[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes dashboard_spec_runs", apprDs.ok && apprDs.recordTable === "dashboard_spec_runs", JSON.stringify(apprDs));
  const { data: dsRows } = await db.from("dashboard_spec_runs").select("org_id,dashboard_title").eq("org_id", orgDs);
  ok("dashboard spec record org-stamped", dsRows?.length === 1 && dsRows[0].org_id === orgDs);
  const { data: dsAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgDs);
  ok("approveAction writes agent_accuracy for dashboard_spec_agent",
    dsAccRows?.length === 1 && dsAccRows[0].agent_role === "dashboard_spec_agent" && dsAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgDs);

  console.log("== saas metrics agent ==");
  ok("calculate_saas_metrics accepts good with all nulls", validateProposal("calculate_saas_metrics", {
    mrr: null, arr: null, churn_rate: null, ltv: null, cac: null, ltv_cac_ratio: null, net_revenue_retention: null,
    metrics_confidence: "low", available_metrics: [], notes: "No metrics calculable from this sample.",
  }).ok);
  ok("calculate_saas_metrics accepts good with all values", validateProposal("calculate_saas_metrics", {
    mrr: 10000, arr: 120000, churn_rate: 0.05, ltv: 5000, cac: 1000, ltv_cac_ratio: 5.0, net_revenue_retention: 1.1,
    metrics_confidence: "high", available_metrics: ["mrr", "arr", "churn_rate", "ltv", "cac"], notes: "All metrics calculated.",
  }).ok);
  ok("calculate_saas_metrics rejects bad metrics_confidence", !validateProposal("calculate_saas_metrics", {
    mrr: null, arr: null, churn_rate: null, ltv: null, cac: null, ltv_cac_ratio: null, net_revenue_retention: null,
    metrics_confidence: "certain", available_metrics: [], notes: "x",
  }).ok);
  ok("calculate_saas_metrics rejects churn_rate > 1.0", !validateProposal("calculate_saas_metrics", {
    mrr: null, arr: null, churn_rate: 1.5, ltv: null, cac: null, ltv_cac_ratio: null, net_revenue_retention: null,
    metrics_confidence: "medium", available_metrics: [], notes: "x",
  }).ok);
  ok("saas_metrics_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("saas_metrics_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentSm } = await import("./lib/run-agent");
  const { stubBrain: sbSm } = await import("./lib/agent-brain");
  const { approveAction: approveSm, listPending: listSm } = await import("./lib/actions-service");
  const orgSm = await makeOrg("pro");
  const payloadSm = await makePayload(orgSm);
  const rSm = await runAgentSm({ orgId: orgSm, payloadId: payloadSm, role: "saas_metrics_agent" }, { db, brain: sbSm });
  ok("saas_metrics_agent run produced metrics", rSm.ok && rSm.proposalCount === 1);
  const pendSm = await listSm(orgSm, { db });
  const apprSm = await approveSm(orgSm, pendSm[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes saas_metrics_runs", apprSm.ok && apprSm.recordTable === "saas_metrics_runs", JSON.stringify(apprSm));
  const { data: smRows } = await db.from("saas_metrics_runs").select("org_id,mrr").eq("org_id", orgSm);
  ok("saas metrics record org-stamped", smRows?.length === 1 && smRows[0].org_id === orgSm);
  const { data: smAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgSm);
  ok("approveAction writes agent_accuracy for saas_metrics_agent",
    smAccRows?.length === 1 && smAccRows[0].agent_role === "saas_metrics_agent" && smAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgSm);

  console.log("== burn rate agent ==");
  ok("calculate_burn_rate accepts good with all nulls", validateProposal("calculate_burn_rate", {
    monthly_burn: null, net_burn: null, cash_balance: null, runway_months: null,
    burn_trend: "unknown", runway_status: "unknown", assumptions: [], confidence: "low",
  }).ok);
  ok("calculate_burn_rate rejects bad burn_trend", !validateProposal("calculate_burn_rate", {
    monthly_burn: 50000, net_burn: 30000, cash_balance: 360000, runway_months: 12,
    burn_trend: "volatile", runway_status: "healthy", assumptions: [], confidence: "medium",
  }).ok);
  ok("calculate_burn_rate rejects bad runway_status", !validateProposal("calculate_burn_rate", {
    monthly_burn: 50000, net_burn: 30000, cash_balance: 360000, runway_months: 12,
    burn_trend: "stable", runway_status: "danger", assumptions: [], confidence: "medium",
  }).ok);
  ok("burn_rate_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("burn_rate_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentBr } = await import("./lib/run-agent");
  const { stubBrain: sbBr } = await import("./lib/agent-brain");
  const { approveAction: approveBr, listPending: listBr } = await import("./lib/actions-service");
  const orgBr = await makeOrg("pro");
  const payloadBr = await makePayload(orgBr);
  const rBr = await runAgentBr({ orgId: orgBr, payloadId: payloadBr, role: "burn_rate_agent" }, { db, brain: sbBr });
  ok("burn_rate_agent run produced a calculation", rBr.ok && rBr.proposalCount === 1);
  const pendBr = await listBr(orgBr, { db });
  const apprBr = await approveBr(orgBr, pendBr[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes burn_rate_runs", apprBr.ok && apprBr.recordTable === "burn_rate_runs", JSON.stringify(apprBr));
  const { data: brRows } = await db.from("burn_rate_runs").select("org_id,runway_status").eq("org_id", orgBr);
  ok("burn rate record org-stamped", brRows?.length === 1 && brRows[0].org_id === orgBr);
  const { data: brAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgBr);
  ok("approveAction writes agent_accuracy for burn_rate_agent",
    brAccRows?.length === 1 && brAccRows[0].agent_role === "burn_rate_agent" && brAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgBr);

  console.log("== cohort agent ==");
  ok("analyze_cohorts accepts good with empty cohorts", validateProposal("analyze_cohorts", {
    cohorts: [], cohort_type: "unknown", avg_retention_m1: null, avg_retention_m3: null,
    trend: "insufficient_data", notes: "No cohort structure detected.",
  }).ok);
  ok("analyze_cohorts rejects bad cohort_type", !validateProposal("analyze_cohorts", {
    cohorts: [], cohort_type: "yearly", avg_retention_m1: null, avg_retention_m3: null,
    trend: "stable", notes: "x",
  }).ok);
  ok("analyze_cohorts rejects bad trend", !validateProposal("analyze_cohorts", {
    cohorts: [], cohort_type: "monthly", avg_retention_m1: null, avg_retention_m3: null,
    trend: "volatile", notes: "x",
  }).ok);
  ok("analyze_cohorts filters out retention_rate > 1.0", (() => {
    const r = validateProposal("analyze_cohorts", {
      cohorts: [{ cohort_period: "2024-01", cohort_size: 100, retention_rates: [1.0, 1.5, 0.6], revenue: null }],
      cohort_type: "monthly", avg_retention_m1: 1.0, avg_retention_m3: 0.6, trend: "stable", notes: "x",
    });
    return r.ok && (r.payload.cohorts as { retention_rates: number[] }[])[0].retention_rates.length === 2;
  })());
  ok("cohort_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("cohort_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentCh } = await import("./lib/run-agent");
  const { stubBrain: sbCh } = await import("./lib/agent-brain");
  const { approveAction: approveCh, listPending: listCh } = await import("./lib/actions-service");
  const orgCh = await makeOrg("pro");
  const payloadCh = await makePayload(orgCh);
  const rCh = await runAgentCh({ orgId: orgCh, payloadId: payloadCh, role: "cohort_agent" }, { db, brain: sbCh });
  ok("cohort_agent run produced an analysis", rCh.ok && rCh.proposalCount === 1);
  const pendCh = await listCh(orgCh, { db });
  const apprCh = await approveCh(orgCh, pendCh[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes cohort_analysis_runs", apprCh.ok && apprCh.recordTable === "cohort_analysis_runs", JSON.stringify(apprCh));
  const { data: chRows } = await db.from("cohort_analysis_runs").select("org_id,trend").eq("org_id", orgCh);
  ok("cohort analysis record org-stamped", chRows?.length === 1 && chRows[0].org_id === orgCh);
  const { data: chAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgCh);
  ok("approveAction writes agent_accuracy for cohort_agent",
    chAccRows?.length === 1 && chAccRows[0].agent_role === "cohort_agent" && chAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgCh);

  console.log("== ar aging agent ==");
  ok("analyze_ar_aging accepts good", validateProposal("analyze_ar_aging", {
    buckets: [{ bucket: "0-30", amount: 80000, invoice_count: 20, percentage: 80.0 }],
    total_ar: 100000, overdue_amount: 20000, overdue_percentage: 20.0,
    collection_priority: ["Follow up on old invoices"], risk_level: "medium",
  }).ok);
  ok("analyze_ar_aging rejects bad bucket value", (() => {
    const r = validateProposal("analyze_ar_aging", {
      buckets: [{ bucket: "150+", amount: 1000, invoice_count: 1, percentage: 10 }],
      total_ar: 10000, overdue_amount: 1000, overdue_percentage: 10.0,
      collection_priority: [], risk_level: "low",
    });
    return r.ok && (r.payload.buckets as unknown[]).length === 0;
  })());
  ok("analyze_ar_aging rejects bad risk_level", !validateProposal("analyze_ar_aging", {
    buckets: [], total_ar: 0, overdue_amount: 0, overdue_percentage: 0,
    collection_priority: [], risk_level: "severe",
  }).ok);
  ok("ar_aging_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("ar_aging_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentAra } = await import("./lib/run-agent");
  const { stubBrain: sbAra } = await import("./lib/agent-brain");
  const { approveAction: approveAra, listPending: listAra } = await import("./lib/actions-service");
  const orgAra = await makeOrg("pro");
  const payloadAra = await makePayload(orgAra);
  const rAra = await runAgentAra({ orgId: orgAra, payloadId: payloadAra, role: "ar_aging_agent" }, { db, brain: sbAra });
  ok("ar_aging_agent run produced an analysis", rAra.ok && rAra.proposalCount === 1);
  const pendAra = await listAra(orgAra, { db });
  const apprAra = await approveAra(orgAra, pendAra[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes ar_aging_runs", apprAra.ok && apprAra.recordTable === "ar_aging_runs", JSON.stringify(apprAra));
  const { data: araRows } = await db.from("ar_aging_runs").select("org_id,risk_level").eq("org_id", orgAra);
  ok("ar aging record org-stamped", araRows?.length === 1 && araRows[0].org_id === orgAra);
  const { data: araAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgAra);
  ok("approveAction writes agent_accuracy for ar_aging_agent",
    araAccRows?.length === 1 && araAccRows[0].agent_role === "ar_aging_agent" && araAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgAra);

  console.log("== ap agent ==");
  ok("analyze_accounts_payable accepts good", validateProposal("analyze_accounts_payable", {
    total_payables: 75000, due_this_week: 12000, due_this_month: 45000, overdue_amount: 5000,
    vendors: [{ vendor_name: "Vendor A", amount_owed: 30000, due_date: "2024-02-15", status: "due_soon" }],
    early_payment_opportunities: ["2/10 net 30"], cash_required_30_days: 45000,
  }).ok);
  ok("analyze_accounts_payable rejects bad vendor status", (() => {
    const r = validateProposal("analyze_accounts_payable", {
      total_payables: 1000, due_this_week: 0, due_this_month: 1000, overdue_amount: 0,
      vendors: [{ vendor_name: "V1", amount_owed: 1000, due_date: "", status: "pending_review" }],
      early_payment_opportunities: [], cash_required_30_days: 1000,
    });
    return r.ok && (r.payload.vendors as unknown[]).length === 0;
  })());
  ok("analyze_accounts_payable filters out vendor with negative amount_owed", (() => {
    const r = validateProposal("analyze_accounts_payable", {
      total_payables: 1000, due_this_week: 0, due_this_month: 1000, overdue_amount: 0,
      vendors: [
        { vendor_name: "V1", amount_owed: -500, due_date: "", status: "current" },
        { vendor_name: "V2", amount_owed: 500, due_date: "", status: "current" },
      ],
      early_payment_opportunities: [], cash_required_30_days: 1000,
    });
    return r.ok && (r.payload.vendors as unknown[]).length === 1;
  })());
  ok("ap_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("ap_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentAp } = await import("./lib/run-agent");
  const { stubBrain: sbAp } = await import("./lib/agent-brain");
  const { approveAction: approveAp, listPending: listAp } = await import("./lib/actions-service");
  const orgAp = await makeOrg("pro");
  const payloadAp = await makePayload(orgAp);
  const rAp = await runAgentAp({ orgId: orgAp, payloadId: payloadAp, role: "ap_agent" }, { db, brain: sbAp });
  ok("ap_agent run produced an analysis", rAp.ok && rAp.proposalCount === 1);
  const pendAp = await listAp(orgAp, { db });
  const apprAp = await approveAp(orgAp, pendAp[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes ap_analysis_runs", apprAp.ok && apprAp.recordTable === "ap_analysis_runs", JSON.stringify(apprAp));
  const { data: apRows } = await db.from("ap_analysis_runs").select("org_id,total_payables").eq("org_id", orgAp);
  ok("ap analysis record org-stamped", apRows?.length === 1 && apRows[0].org_id === orgAp);
  const { data: apAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgAp);
  ok("approveAction writes agent_accuracy for ap_agent",
    apAccRows?.length === 1 && apAccRows[0].agent_role === "ap_agent" && apAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgAp);

  console.log("== bank recon agent ==");
  ok("reconcile_bank accepts good with all nulls", validateProposal("reconcile_bank", {
    book_balance: null, bank_balance: null, variance: null, unmatched_items: [],
    reconciliation_status: "insufficient_data", total_unmatched: 0, notes: "No bank data present.",
  }).ok);
  ok("reconcile_bank rejects bad reconciliation_status", !validateProposal("reconcile_bank", {
    book_balance: 50000, bank_balance: 48500, variance: 1500, unmatched_items: [],
    reconciliation_status: "pending_review", total_unmatched: 0, notes: "x",
  }).ok);
  ok("reconcile_bank filters out unmatched_item with bad item_type", (() => {
    const r = validateProposal("reconcile_bank", {
      book_balance: 50000, bank_balance: 48500, variance: 1500,
      unmatched_items: [
        { description: "d1", amount: 100, item_type: "mystery" },
        { description: "d2", amount: 1500, item_type: "outstanding_check" },
      ],
      reconciliation_status: "balanced", total_unmatched: 2, notes: "x",
    });
    return r.ok && (r.payload.unmatched_items as unknown[]).length === 1;
  })());
  ok("bank_recon_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("bank_recon_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentBk } = await import("./lib/run-agent");
  const { stubBrain: sbBk } = await import("./lib/agent-brain");
  const { approveAction: approveBk, listPending: listBk } = await import("./lib/actions-service");
  const orgBk = await makeOrg("pro");
  const payloadBk = await makePayload(orgBk);
  const rBk = await runAgentBk({ orgId: orgBk, payloadId: payloadBk, role: "bank_recon_agent" }, { db, brain: sbBk });
  ok("bank_recon_agent run produced a reconciliation", rBk.ok && rBk.proposalCount === 1);
  const pendBk = await listBk(orgBk, { db });
  const apprBk = await approveBk(orgBk, pendBk[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes bank_recon_runs", apprBk.ok && apprBk.recordTable === "bank_recon_runs", JSON.stringify(apprBk));
  const { data: bkRows } = await db.from("bank_recon_runs").select("org_id,reconciliation_status").eq("org_id", orgBk);
  ok("bank recon record org-stamped", bkRows?.length === 1 && bkRows[0].org_id === orgBk);
  const { data: bkAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgBk);
  ok("approveAction writes agent_accuracy for bank_recon_agent",
    bkAccRows?.length === 1 && bkAccRows[0].agent_role === "bank_recon_agent" && bkAccRows[0].approved_count === 1);
  await db.from("organizations").delete().eq("id", orgBk);

  console.log("== ratio analysis agent ==");
  ok("analyze_financial_ratios accepts good", validateProposal("analyze_financial_ratios", {
    liquidity_ratios: { current_ratio: 2.1, quick_ratio: 1.4, cash_ratio: 0.9 },
    profitability_ratios: { gross_margin: 45.0, net_margin: 12.5, roe: 18.0, roa: 9.0, ebitda_margin: 22.0 },
    leverage_ratios: { debt_to_equity: 0.8, debt_to_assets: 0.4, interest_coverage: 6.0 },
    efficiency_ratios: { asset_turnover: 1.2, inventory_turnover: 5.0, receivables_turnover: 8.0 },
    overall_health: "healthy",
    notes: "Calculated from full sample data.",
  }).ok);
  ok("analyze_financial_ratios rejects bad overall_health", !validateProposal("analyze_financial_ratios", {
    liquidity_ratios: {}, profitability_ratios: {}, leverage_ratios: {}, efficiency_ratios: {},
    overall_health: "excellent", notes: "x",
  }).ok);
  ok("analyze_financial_ratios silently filters out-of-range nested ratio key", (() => {
    const r = validateProposal("analyze_financial_ratios", {
      liquidity_ratios: { current_ratio: 2.1 },
      profitability_ratios: { gross_margin: 150.0, net_margin: 12.5 },
      leverage_ratios: {}, efficiency_ratios: {},
      overall_health: "watch", notes: "Gross margin looked implausible.",
    });
    return r.ok
      && (r.payload.profitability_ratios as Record<string, unknown>).gross_margin === null
      && (r.payload.profitability_ratios as Record<string, unknown>).net_margin === 12.5;
  })());
  ok("analyze_financial_ratios accepts all-empty ratio objects", validateProposal("analyze_financial_ratios", {
    liquidity_ratios: {}, profitability_ratios: {}, leverage_ratios: {}, efficiency_ratios: {},
    overall_health: "critical", notes: "Insufficient data to calculate any ratio.",
  }).ok);
  ok("ratio_analysis_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("ratio_analysis_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentRa } = await import("./lib/run-agent");
  const { stubBrain: sbRa } = await import("./lib/agent-brain");
  const { approveAction: approveRa, listPending: listRa } = await import("./lib/actions-service");
  const orgRa = await makeOrg("pro");
  const payloadRa = await makePayload(orgRa);
  const rRa = await runAgentRa({ orgId: orgRa, payloadId: payloadRa, role: "ratio_analysis_agent" }, { db, brain: sbRa });
  ok("ratio_analysis_agent run produced an analysis", rRa.ok && rRa.proposalCount === 1);
  const pendRa = await listRa(orgRa, { db });
  ok("stub proposal passes validateProposal", pendRa.length === 1 && pendRa[0].kind === "analyze_financial_ratios");
  const apprRa = await approveRa(orgRa, pendRa[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes ratio_analysis_runs", apprRa.ok && apprRa.recordTable === "ratio_analysis_runs", JSON.stringify(apprRa));
  const { data: raRows } = await db.from("ratio_analysis_runs").select("org_id,overall_health").eq("org_id", orgRa);
  ok("ratio analysis record org-stamped", raRows?.length === 1 && raRows[0].org_id === orgRa);
  const { data: raAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgRa);
  ok("approveAction writes agent_accuracy for ratio_analysis_agent",
    raAccRows?.length === 1 && raAccRows[0].agent_role === "ratio_analysis_agent" && raAccRows[0].approved_count === 1);
  const { routePayload: routeRa } = await import("./lib/manager");
  const routeCheckRa = await routeRa({ orgId: orgRa, payloadId: payloadRa }, { db, enqueue: () => {} });
  ok("ratio_analysis_agent routes on the financial route", routeCheckRa.ok && routeCheckRa.plan.includes("ratio_analysis_agent"));
  await db.from("organizations").delete().eq("id", orgRa);

  console.log("== profitability agent ==");
  ok("analyze_profitability accepts good", validateProposal("analyze_profitability", {
    segments: [{ segment_name: "Product A", revenue: 80000, cost: 45000, gross_profit: 35000, gross_margin: 43.75 }],
    total_revenue: 80000, total_cost: 45000, total_gross_profit: 35000, overall_margin: 43.75,
    most_profitable: "Product A", least_profitable: "Product A",
    recommendations: ["Focus on highest-margin products"],
  }).ok);
  ok("analyze_profitability filters out segment with gross_margin > 100", (() => {
    const r = validateProposal("analyze_profitability", {
      segments: [
        { segment_name: "Good", revenue: 1000, cost: 500, gross_profit: 500, gross_margin: 50 },
        { segment_name: "Bad", revenue: 1000, cost: 500, gross_profit: 500, gross_margin: 150 },
      ],
      total_revenue: 2000, total_cost: 1000, total_gross_profit: 1000, overall_margin: 50,
      most_profitable: "Good", least_profitable: "Bad", recommendations: [],
    });
    return r.ok && (r.payload.segments as unknown[]).length === 1;
  })());
  ok("analyze_profitability rejects empty most_profitable", !validateProposal("analyze_profitability", {
    segments: [], total_revenue: 100, total_cost: 50, total_gross_profit: 50, overall_margin: 50,
    most_profitable: "", least_profitable: "Overall", recommendations: [],
  }).ok);
  ok("analyze_profitability rejects negative total_revenue", !validateProposal("analyze_profitability", {
    segments: [], total_revenue: -100, total_cost: 50, total_gross_profit: -150, overall_margin: -150,
    most_profitable: "Overall", least_profitable: "Overall", recommendations: [],
  }).ok);
  ok("profitability_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("profitability_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentPr } = await import("./lib/run-agent");
  const { stubBrain: sbPr } = await import("./lib/agent-brain");
  const { approveAction: approvePr, listPending: listPr } = await import("./lib/actions-service");
  const orgPr = await makeOrg("pro");
  const payloadPr = await makePayload(orgPr);
  const rPr = await runAgentPr({ orgId: orgPr, payloadId: payloadPr, role: "profitability_agent" }, { db, brain: sbPr });
  ok("profitability_agent run produced an analysis", rPr.ok && rPr.proposalCount === 1);
  const pendPr = await listPr(orgPr, { db });
  ok("stub proposal passes validateProposal", pendPr.length === 1 && pendPr[0].kind === "analyze_profitability");
  const apprPr = await approvePr(orgPr, pendPr[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes profitability_runs", apprPr.ok && apprPr.recordTable === "profitability_runs", JSON.stringify(apprPr));
  const { data: prRows } = await db.from("profitability_runs").select("org_id,most_profitable").eq("org_id", orgPr);
  ok("profitability record org-stamped", prRows?.length === 1 && prRows[0].org_id === orgPr);
  const { data: prAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgPr);
  ok("approveAction writes agent_accuracy for profitability_agent",
    prAccRows?.length === 1 && prAccRows[0].agent_role === "profitability_agent" && prAccRows[0].approved_count === 1);
  const { routePayload: routePr } = await import("./lib/manager");
  const routeCheckPr = await routePr({ orgId: orgPr, payloadId: payloadPr }, { db, enqueue: () => {} });
  ok("profitability_agent routes on the financial route", routeCheckPr.ok && routeCheckPr.plan.includes("profitability_agent"));
  await db.from("organizations").delete().eq("id", orgPr);

  console.log("== working capital agent ==");
  ok("analyze_working_capital accepts good with all fields", validateProposal("analyze_working_capital", {
    current_assets: 150000, current_liabilities: 80000, working_capital: 70000,
    current_ratio: 1.875, quick_ratio: 1.2, days_inventory_outstanding: 45.0,
    days_sales_outstanding: 32.0, days_payable_outstanding: 28.0, cash_conversion_cycle_days: 49.0,
    status: "healthy", recommendations: ["Working capital is healthy"],
  }).ok);
  ok("analyze_working_capital accepts all nullable fields null with valid status", validateProposal("analyze_working_capital", {
    current_assets: null, current_liabilities: null, working_capital: null,
    current_ratio: null, quick_ratio: null, days_inventory_outstanding: null,
    days_sales_outstanding: null, days_payable_outstanding: null, cash_conversion_cycle_days: null,
    status: "unknown", recommendations: [],
  }).ok);
  ok("analyze_working_capital rejects bad status", !validateProposal("analyze_working_capital", {
    current_assets: null, current_liabilities: null, working_capital: null,
    current_ratio: null, quick_ratio: null, days_inventory_outstanding: null,
    days_sales_outstanding: null, days_payable_outstanding: null, cash_conversion_cycle_days: null,
    status: "great", recommendations: [],
  }).ok);
  ok("analyze_working_capital rejects negative days_inventory_outstanding", !validateProposal("analyze_working_capital", {
    current_assets: null, current_liabilities: null, working_capital: null,
    current_ratio: null, quick_ratio: null, days_inventory_outstanding: -5,
    days_sales_outstanding: null, days_payable_outstanding: null, cash_conversion_cycle_days: null,
    status: "unknown", recommendations: [],
  }).ok);
  ok("working_capital_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("working_capital_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentWc } = await import("./lib/run-agent");
  const { stubBrain: sbWc } = await import("./lib/agent-brain");
  const { approveAction: approveWc, listPending: listWc } = await import("./lib/actions-service");
  const orgWc = await makeOrg("pro");
  const payloadWc = await makePayload(orgWc);
  const rWc = await runAgentWc({ orgId: orgWc, payloadId: payloadWc, role: "working_capital_agent" }, { db, brain: sbWc });
  ok("working_capital_agent run produced an analysis", rWc.ok && rWc.proposalCount === 1);
  const pendWc = await listWc(orgWc, { db });
  ok("stub proposal passes validateProposal", pendWc.length === 1 && pendWc[0].kind === "analyze_working_capital");
  const apprWc = await approveWc(orgWc, pendWc[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes working_capital_runs", apprWc.ok && apprWc.recordTable === "working_capital_runs", JSON.stringify(apprWc));
  const { data: wcRows } = await db.from("working_capital_runs").select("org_id,status").eq("org_id", orgWc);
  ok("working capital record org-stamped", wcRows?.length === 1 && wcRows[0].org_id === orgWc);
  const { data: wcAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgWc);
  ok("approveAction writes agent_accuracy for working_capital_agent",
    wcAccRows?.length === 1 && wcAccRows[0].agent_role === "working_capital_agent" && wcAccRows[0].approved_count === 1);
  const { routePayload: routeWc } = await import("./lib/manager");
  const routeCheckWc = await routeWc({ orgId: orgWc, payloadId: payloadWc }, { db, enqueue: () => {} });
  ok("working_capital_agent routes on the financial route", routeCheckWc.ok && routeCheckWc.plan.includes("working_capital_agent"));
  await db.from("organizations").delete().eq("id", orgWc);

  console.log("== break even agent ==");
  ok("calculate_break_even accepts good", validateProposal("calculate_break_even", {
    fixed_costs: 50000, variable_cost_per_unit: 30.0, price_per_unit: 50.0,
    break_even_units: 2500, break_even_revenue: 125000, current_units_or_revenue: 150000,
    margin_of_safety: 25000, margin_of_safety_percentage: 20.0,
    contribution_margin_per_unit: 20.0, contribution_margin_ratio: 0.4,
    status: "above_break_even",
  }).ok);
  ok("calculate_break_even rejects bad status", !validateProposal("calculate_break_even", {
    fixed_costs: 50000, variable_cost_per_unit: 30.0, price_per_unit: 50.0,
    break_even_units: 2500, break_even_revenue: 125000, current_units_or_revenue: 150000,
    margin_of_safety: 25000, margin_of_safety_percentage: 20.0,
    contribution_margin_per_unit: 20.0, contribution_margin_ratio: 0.4,
    status: "profitable",
  }).ok);
  ok("calculate_break_even rejects contribution_margin_ratio > 1", !validateProposal("calculate_break_even", {
    fixed_costs: 50000, variable_cost_per_unit: 30.0, price_per_unit: 50.0,
    break_even_units: 2500, break_even_revenue: 125000, current_units_or_revenue: 150000,
    margin_of_safety: 25000, margin_of_safety_percentage: 20.0,
    contribution_margin_per_unit: 20.0, contribution_margin_ratio: 1.4,
    status: "above_break_even",
  }).ok);
  ok("calculate_break_even accepts all nulls with insufficient_data status", validateProposal("calculate_break_even", {
    fixed_costs: null, variable_cost_per_unit: null, price_per_unit: null,
    break_even_units: null, break_even_revenue: null, current_units_or_revenue: null,
    margin_of_safety: null, margin_of_safety_percentage: null,
    contribution_margin_per_unit: null, contribution_margin_ratio: null,
    status: "insufficient_data",
  }).ok);
  ok("break_even_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("break_even_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentBe } = await import("./lib/run-agent");
  const { stubBrain: sbBe } = await import("./lib/agent-brain");
  const { approveAction: approveBe, listPending: listBe } = await import("./lib/actions-service");
  const orgBe = await makeOrg("pro");
  const payloadBe = await makePayload(orgBe);
  const rBe = await runAgentBe({ orgId: orgBe, payloadId: payloadBe, role: "break_even_agent" }, { db, brain: sbBe });
  ok("break_even_agent run produced a calculation", rBe.ok && rBe.proposalCount === 1);
  const pendBe = await listBe(orgBe, { db });
  ok("stub proposal passes validateProposal", pendBe.length === 1 && pendBe[0].kind === "calculate_break_even");
  const apprBe = await approveBe(orgBe, pendBe[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes break_even_runs", apprBe.ok && apprBe.recordTable === "break_even_runs", JSON.stringify(apprBe));
  const { data: beRows } = await db.from("break_even_runs").select("org_id,status").eq("org_id", orgBe);
  ok("break even record org-stamped", beRows?.length === 1 && beRows[0].org_id === orgBe);
  const { data: beAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgBe);
  ok("approveAction writes agent_accuracy for break_even_agent",
    beAccRows?.length === 1 && beAccRows[0].agent_role === "break_even_agent" && beAccRows[0].approved_count === 1);
  const { routePayload: routeBe } = await import("./lib/manager");
  const routeCheckBe = await routeBe({ orgId: orgBe, payloadId: payloadBe }, { db, enqueue: () => {} });
  ok("break_even_agent routes on the financial route", routeCheckBe.ok && routeCheckBe.plan.includes("break_even_agent"));
  await db.from("organizations").delete().eq("id", orgBe);

  console.log("== cogs analysis agent ==");
  ok("analyze_cogs accepts good", validateProposal("analyze_cogs", {
    total_cogs: 60000, total_revenue: 100000, gross_profit: 40000, gross_margin_percentage: 40.0,
    cogs_components: [
      { component_name: "Materials", amount: 35000, percentage_of_cogs: 58.3 },
      { component_name: "Labor", amount: 25000, percentage_of_cogs: 41.7 },
    ],
    cogs_trend: "stable", cost_drivers: ["Raw material prices"], optimization_opportunities: ["Negotiate volume discounts"],
  }).ok);
  ok("analyze_cogs rejects bad cogs_trend", !validateProposal("analyze_cogs", {
    total_cogs: 60000, total_revenue: 100000, gross_profit: 40000, gross_margin_percentage: 40.0,
    cogs_components: [], cogs_trend: "skyrocketing", cost_drivers: [], optimization_opportunities: [],
  }).ok);
  ok("analyze_cogs filters out component with percentage_of_cogs > 100", (() => {
    const r = validateProposal("analyze_cogs", {
      total_cogs: 60000, total_revenue: 100000, gross_profit: 40000, gross_margin_percentage: 40.0,
      cogs_components: [
        { component_name: "Good", amount: 30000, percentage_of_cogs: 50 },
        { component_name: "Bad", amount: 30000, percentage_of_cogs: 150 },
      ],
      cogs_trend: "stable", cost_drivers: [], optimization_opportunities: [],
    });
    return r.ok && (r.payload.cogs_components as unknown[]).length === 1;
  })());
  ok("analyze_cogs rejects negative total_cogs", !validateProposal("analyze_cogs", {
    total_cogs: -60000, total_revenue: 100000, gross_profit: 40000, gross_margin_percentage: 40.0,
    cogs_components: [], cogs_trend: "stable", cost_drivers: [], optimization_opportunities: [],
  }).ok);
  ok("cogs_analysis_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("cogs_analysis_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentCg } = await import("./lib/run-agent");
  const { stubBrain: sbCg } = await import("./lib/agent-brain");
  const { approveAction: approveCg, listPending: listCg } = await import("./lib/actions-service");
  const orgCg = await makeOrg("pro");
  const payloadCg = await makePayload(orgCg);
  const rCg = await runAgentCg({ orgId: orgCg, payloadId: payloadCg, role: "cogs_analysis_agent" }, { db, brain: sbCg });
  ok("cogs_analysis_agent run produced an analysis", rCg.ok && rCg.proposalCount === 1);
  const pendCg = await listCg(orgCg, { db });
  ok("stub proposal passes validateProposal", pendCg.length === 1 && pendCg[0].kind === "analyze_cogs");
  const apprCg = await approveCg(orgCg, pendCg[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes cogs_analysis_runs", apprCg.ok && apprCg.recordTable === "cogs_analysis_runs", JSON.stringify(apprCg));
  const { data: cgRows } = await db.from("cogs_analysis_runs").select("org_id,cogs_trend").eq("org_id", orgCg);
  ok("cogs analysis record org-stamped", cgRows?.length === 1 && cgRows[0].org_id === orgCg);
  const { data: cgAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgCg);
  ok("approveAction writes agent_accuracy for cogs_analysis_agent",
    cgAccRows?.length === 1 && cgAccRows[0].agent_role === "cogs_analysis_agent" && cgAccRows[0].approved_count === 1);
  const { routePayload: routeCg } = await import("./lib/manager");
  const routeCheckCg = await routeCg({ orgId: orgCg, payloadId: payloadCg }, { db, enqueue: () => {} });
  ok("cogs_analysis_agent routes on the financial route", routeCheckCg.ok && routeCheckCg.plan.includes("cogs_analysis_agent"));
  await db.from("organizations").delete().eq("id", orgCg);

  console.log("== revenue recognition agent ==");
  ok("analyze_revenue_recognition accepts good", validateProposal("analyze_revenue_recognition", {
    recognized_revenue: 85000, deferred_revenue: 15000, recognition_method: "over_time",
    contracts: [{ contract_ref: "C-001", total_value: 100000, recognized: 85000, deferred: 15000, start_date: "2024-01-01", end_date: "2024-12-31" }],
    compliance_flags: [{ flag: "Bundled elements not separated", severity: "medium" }],
    asc_606_notes: "Subscription revenue recognized ratably over contract term.",
  }).ok);
  ok("analyze_revenue_recognition rejects bad recognition_method", !validateProposal("analyze_revenue_recognition", {
    recognized_revenue: 85000, deferred_revenue: 15000, recognition_method: "whenever",
    contracts: [], compliance_flags: [], asc_606_notes: "x",
  }).ok);
  ok("analyze_revenue_recognition filters out compliance_flag with bad severity", (() => {
    const r = validateProposal("analyze_revenue_recognition", {
      recognized_revenue: 85000, deferred_revenue: 15000, recognition_method: "over_time",
      contracts: [],
      compliance_flags: [
        { flag: "Good flag", severity: "high" },
        { flag: "Bad flag", severity: "critical" },
      ],
      asc_606_notes: "x",
    });
    return r.ok && (r.payload.compliance_flags as unknown[]).length === 1;
  })());
  ok("analyze_revenue_recognition rejects empty asc_606_notes", !validateProposal("analyze_revenue_recognition", {
    recognized_revenue: 85000, deferred_revenue: 15000, recognition_method: "over_time",
    contracts: [], compliance_flags: [], asc_606_notes: "",
  }).ok);
  ok("revenue_recognition_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("revenue_recognition_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentRr } = await import("./lib/run-agent");
  const { stubBrain: sbRr } = await import("./lib/agent-brain");
  const { approveAction: approveRr, listPending: listRr } = await import("./lib/actions-service");
  const orgRr = await makeOrg("pro");
  const payloadRr = await makePayload(orgRr);
  const rRr = await runAgentRr({ orgId: orgRr, payloadId: payloadRr, role: "revenue_recognition_agent" }, { db, brain: sbRr });
  ok("revenue_recognition_agent run produced an analysis", rRr.ok && rRr.proposalCount === 1);
  const pendRr = await listRr(orgRr, { db });
  ok("stub proposal passes validateProposal", pendRr.length === 1 && pendRr[0].kind === "analyze_revenue_recognition");
  const apprRr = await approveRr(orgRr, pendRr[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes revenue_recognition_runs", apprRr.ok && apprRr.recordTable === "revenue_recognition_runs", JSON.stringify(apprRr));
  const { data: rrRows } = await db.from("revenue_recognition_runs").select("org_id,recognition_method").eq("org_id", orgRr);
  ok("revenue recognition record org-stamped", rrRows?.length === 1 && rrRows[0].org_id === orgRr);
  const { data: rrAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgRr);
  ok("approveAction writes agent_accuracy for revenue_recognition_agent",
    rrAccRows?.length === 1 && rrAccRows[0].agent_role === "revenue_recognition_agent" && rrAccRows[0].approved_count === 1);
  const { routePayload: routeRr } = await import("./lib/manager");
  const routeCheckRr = await routeRr({ orgId: orgRr, payloadId: payloadRr }, { db, enqueue: () => {} });
  ok("revenue_recognition_agent routes on the financial route", routeCheckRr.ok && routeCheckRr.plan.includes("revenue_recognition_agent"));
  await db.from("organizations").delete().eq("id", orgRr);

  console.log("== churn risk agent ==");
  ok("analyze_churn_risk accepts good", validateProposal("analyze_churn_risk", {
    overall_churn_rate: 8.5, predicted_revenue_loss: 12500,
    at_risk_customers: [{ customer_id: "C001", risk_score: 85, risk_level: "high", last_active: "2024-01-15", revenue_at_risk: 5000 }],
    risk_factors: ["Declining login frequency"], retention_recommendations: ["Proactive outreach"],
    data_period: "Q1 2024",
  }).ok);
  ok("analyze_churn_risk filters out customer with risk_score > 100", (() => {
    const r = validateProposal("analyze_churn_risk", {
      overall_churn_rate: 8.5, predicted_revenue_loss: 12500,
      at_risk_customers: [
        { customer_id: "Good", risk_score: 80, risk_level: "high", last_active: "2024-01-15", revenue_at_risk: 5000 },
        { customer_id: "Bad", risk_score: 150, risk_level: "high", last_active: "2024-01-15", revenue_at_risk: 5000 },
      ],
      risk_factors: [], retention_recommendations: [], data_period: "Q1 2024",
    });
    return r.ok && (r.payload.at_risk_customers as unknown[]).length === 1;
  })());
  ok("analyze_churn_risk filters out customer with bad risk_level", (() => {
    const r = validateProposal("analyze_churn_risk", {
      overall_churn_rate: 8.5, predicted_revenue_loss: 12500,
      at_risk_customers: [
        { customer_id: "Good", risk_score: 80, risk_level: "high", last_active: "2024-01-15", revenue_at_risk: 5000 },
        { customer_id: "Bad", risk_score: 50, risk_level: "critical", last_active: "2024-01-15", revenue_at_risk: 5000 },
      ],
      risk_factors: [], retention_recommendations: [], data_period: "Q1 2024",
    });
    return r.ok && (r.payload.at_risk_customers as unknown[]).length === 1;
  })());
  ok("analyze_churn_risk rejects empty data_period", !validateProposal("analyze_churn_risk", {
    overall_churn_rate: 8.5, predicted_revenue_loss: 12500,
    at_risk_customers: [], risk_factors: [], retention_recommendations: [], data_period: "",
  }).ok);
  ok("churn_risk_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("churn_risk_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentChu } = await import("./lib/run-agent");
  const { stubBrain: sbChu } = await import("./lib/agent-brain");
  const { approveAction: approveChu, listPending: listChu } = await import("./lib/actions-service");
  const orgChu = await makeOrg("pro");
  const payloadChu = await makePayload(orgChu);
  const rChu = await runAgentChu({ orgId: orgChu, payloadId: payloadChu, role: "churn_risk_agent" }, { db, brain: sbChu });
  ok("churn_risk_agent run produced an analysis", rChu.ok && rChu.proposalCount === 1);
  const pendChu = await listChu(orgChu, { db });
  ok("stub proposal passes validateProposal", pendChu.length === 1 && pendChu[0].kind === "analyze_churn_risk");
  const apprChu = await approveChu(orgChu, pendChu[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes churn_risk_runs", apprChu.ok && apprChu.recordTable === "churn_risk_runs", JSON.stringify(apprChu));
  const { data: chuRows } = await db.from("churn_risk_runs").select("org_id,data_period").eq("org_id", orgChu);
  ok("churn risk record org-stamped", chuRows?.length === 1 && chuRows[0].org_id === orgChu);
  const { data: chuAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgChu);
  ok("approveAction writes agent_accuracy for churn_risk_agent",
    chuAccRows?.length === 1 && chuAccRows[0].agent_role === "churn_risk_agent" && chuAccRows[0].approved_count === 1);
  const { routePayload: routeChu } = await import("./lib/manager");
  const routeCheckChu = await routeChu({ orgId: orgChu, payloadId: payloadChu }, { db, enqueue: () => {} });
  ok("churn_risk_agent routes on the financial route", routeCheckChu.ok && routeCheckChu.plan.includes("churn_risk_agent"));
  await db.from("organizations").delete().eq("id", orgChu);

  console.log("== customer segmentation agent ==");
  ok("segment_customers accepts good", validateProposal("segment_customers", {
    segments: [{ segment_name: "Champions", customer_count: 25, percentage_of_total: 20.0, avg_revenue: 8500, characteristics: ["High frequency"] }],
    segmentation_method: "rfm", total_customers: 125, insights: ["Champions generate outsized revenue"],
  }).ok);
  ok("segment_customers rejects bad segmentation_method", !validateProposal("segment_customers", {
    segments: [{ segment_name: "Champions", customer_count: 25, percentage_of_total: 20.0, avg_revenue: 8500, characteristics: [] }],
    segmentation_method: "astrology", total_customers: 125, insights: [],
  }).ok);
  ok("segment_customers filters out segment with percentage_of_total > 100", (() => {
    const r = validateProposal("segment_customers", {
      segments: [
        { segment_name: "Good", customer_count: 25, percentage_of_total: 20.0, avg_revenue: 8500, characteristics: [] },
        { segment_name: "Bad", customer_count: 25, percentage_of_total: 150.0, avg_revenue: 8500, characteristics: [] },
      ],
      segmentation_method: "rfm", total_customers: 125, insights: [],
    });
    return r.ok && (r.payload.segments as unknown[]).length === 1;
  })());
  ok("segment_customers rejects when all segments filtered out (empty result)", !validateProposal("segment_customers", {
    segments: [{ segment_name: "Bad", customer_count: 25, percentage_of_total: 150.0, avg_revenue: 8500, characteristics: [] }],
    segmentation_method: "rfm", total_customers: 125, insights: [],
  }).ok);
  ok("customer_segmentation_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("customer_segmentation_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentCs } = await import("./lib/run-agent");
  const { stubBrain: sbCs } = await import("./lib/agent-brain");
  const { approveAction: approveCs, listPending: listCs } = await import("./lib/actions-service");
  const orgCs = await makeOrg("pro");
  const payloadCs = await makePayload(orgCs);
  const rCs = await runAgentCs({ orgId: orgCs, payloadId: payloadCs, role: "customer_segmentation_agent" }, { db, brain: sbCs });
  ok("customer_segmentation_agent run produced a segmentation", rCs.ok && rCs.proposalCount === 1);
  const pendCs = await listCs(orgCs, { db });
  ok("stub proposal passes validateProposal", pendCs.length === 1 && pendCs[0].kind === "segment_customers");
  const apprCs = await approveCs(orgCs, pendCs[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes customer_segmentation_runs", apprCs.ok && apprCs.recordTable === "customer_segmentation_runs", JSON.stringify(apprCs));
  const { data: csRows } = await db.from("customer_segmentation_runs").select("org_id,segmentation_method").eq("org_id", orgCs);
  ok("customer segmentation record org-stamped", csRows?.length === 1 && csRows[0].org_id === orgCs);
  const { data: csAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgCs);
  ok("approveAction writes agent_accuracy for customer_segmentation_agent",
    csAccRows?.length === 1 && csAccRows[0].agent_role === "customer_segmentation_agent" && csAccRows[0].approved_count === 1);
  const { routePayload: routeCs } = await import("./lib/manager");
  const routeCheckCsFin = await routeCs({ orgId: orgCs, payloadId: payloadCs }, { db, enqueue: () => {} });
  const { data: plainPayloadCs } = await db.from("inbound_payloads").insert({
    org_id: orgCs, source: "upload", storage_path: `${orgCs}/cs/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckCsNonFin = await routeCs({ orgId: orgCs, payloadId: plainPayloadCs!.id }, { db, enqueue: () => {} });
  ok("customer_segmentation_agent routes on BOTH the financial and non-financial route",
    routeCheckCsFin.ok && routeCheckCsFin.plan.includes("customer_segmentation_agent") &&
    routeCheckCsNonFin.ok && routeCheckCsNonFin.plan.includes("customer_segmentation_agent"));
  await db.from("organizations").delete().eq("id", orgCs);

  console.log("== sales pipeline agent ==");
  ok("analyze_sales_pipeline accepts good", validateProposal("analyze_sales_pipeline", {
    total_pipeline_value: 450000, weighted_pipeline_value: 180000,
    deals: [{ deal_name: "Acme Corp", stage: "Proposal", value: 80000, probability: 60, expected_close: "2024-03-31", owner: "Rep A" }],
    stage_summary: [{ stage_name: "Proposal", deal_count: 3, total_value: 180000, avg_probability: 55.0 }],
    avg_deal_size: 45000, avg_sales_cycle_days: 45.0, win_rate: 32.0, forecast_this_period: 120000,
    risks: ["Pipeline concentration in 2 large deals"],
  }).ok);
  ok("analyze_sales_pipeline filters out deal with probability > 100", (() => {
    const r = validateProposal("analyze_sales_pipeline", {
      total_pipeline_value: 450000, weighted_pipeline_value: 180000,
      deals: [
        { deal_name: "Good", stage: "Proposal", value: 80000, probability: 60, expected_close: "2024-03-31", owner: "Rep A" },
        { deal_name: "Bad", stage: "Proposal", value: 80000, probability: 150, expected_close: "2024-03-31", owner: "Rep A" },
      ],
      stage_summary: [], avg_deal_size: null, avg_sales_cycle_days: null, win_rate: null, forecast_this_period: null, risks: [],
    });
    return r.ok && (r.payload.deals as unknown[]).length === 1;
  })());
  ok("analyze_sales_pipeline rejects negative total_pipeline_value", !validateProposal("analyze_sales_pipeline", {
    total_pipeline_value: -450000, weighted_pipeline_value: 180000,
    deals: [], stage_summary: [], avg_deal_size: null, avg_sales_cycle_days: null, win_rate: null, forecast_this_period: null, risks: [],
  }).ok);
  ok("analyze_sales_pipeline filters out stage_summary with avg_probability > 100", (() => {
    const r = validateProposal("analyze_sales_pipeline", {
      total_pipeline_value: 450000, weighted_pipeline_value: 180000,
      deals: [],
      stage_summary: [
        { stage_name: "Good", deal_count: 3, total_value: 180000, avg_probability: 55.0 },
        { stage_name: "Bad", deal_count: 2, total_value: 90000, avg_probability: 150.0 },
      ],
      avg_deal_size: null, avg_sales_cycle_days: null, win_rate: null, forecast_this_period: null, risks: [],
    });
    return r.ok && (r.payload.stage_summary as unknown[]).length === 1;
  })());
  ok("sales_pipeline_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("sales_pipeline_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentSp } = await import("./lib/run-agent");
  const { stubBrain: sbSp } = await import("./lib/agent-brain");
  const { approveAction: approveSp, listPending: listSp } = await import("./lib/actions-service");
  const orgSp = await makeOrg("pro");
  const payloadSp = await makePayload(orgSp);
  const rSp = await runAgentSp({ orgId: orgSp, payloadId: payloadSp, role: "sales_pipeline_agent" }, { db, brain: sbSp });
  ok("sales_pipeline_agent run produced an analysis", rSp.ok && rSp.proposalCount === 1);
  const pendSp = await listSp(orgSp, { db });
  ok("stub proposal passes validateProposal", pendSp.length === 1 && pendSp[0].kind === "analyze_sales_pipeline");
  const apprSp = await approveSp(orgSp, pendSp[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes sales_pipeline_runs", apprSp.ok && apprSp.recordTable === "sales_pipeline_runs", JSON.stringify(apprSp));
  const { data: spRows } = await db.from("sales_pipeline_runs").select("org_id,win_rate").eq("org_id", orgSp);
  ok("sales pipeline record org-stamped", spRows?.length === 1 && spRows[0].org_id === orgSp);
  const { data: spAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgSp);
  ok("approveAction writes agent_accuracy for sales_pipeline_agent",
    spAccRows?.length === 1 && spAccRows[0].agent_role === "sales_pipeline_agent" && spAccRows[0].approved_count === 1);
  const { routePayload: routeSp } = await import("./lib/manager");
  const routeCheckSp = await routeSp({ orgId: orgSp, payloadId: payloadSp }, { db, enqueue: () => {} });
  ok("sales_pipeline_agent routes on the financial route", routeCheckSp.ok && routeCheckSp.plan.includes("sales_pipeline_agent"));
  await db.from("organizations").delete().eq("id", orgSp);

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
