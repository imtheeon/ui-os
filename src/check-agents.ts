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
  ok("financial routes to [data_quality_agent, schema_detection_agent, document_classifier, schema_evolution_agent, column_profiler, data_dictionary_agent, missing_data_agent, headcount_analytics_agent, productivity_agent, growth_rate_agent, data_privacy_agent, data_quality, compliance_agent, onboarding_agent, clarification_agent, multi_period, audit_summarizer, kpi_extractor, sql_analyst, anomaly_detector, categorizer, data_cleaner, unit_normalizer, duplicate_detector, outlier_explanation_agent, time_series_decomp_agent, failure_risk_agent, run_rate_agent, spend_analysis_agent, investor_memo_agent, okr_tracker_agent, swot_agent, query_builder_agent, esg_reporting_agent, seasonality_agent, benchmark_agent, professional_services_agent, headcount_analysis_agent, competitive_benchmarking_agent, data_reshape_agent, date_normalization_agent, string_normalization_agent, currency_normalization_agent, join_quality_agent, data_validation_rules_agent, distribution_agent, correlation_agent, regression_agent, hypothesis_testing_agent, pareto_agent, clustering_agent, reconciler, invoice_matcher, cash_flow_agent, tax_categorizer, budget_analyst, saas_metrics_agent, burn_rate_agent, cohort_agent, ar_aging_agent, ap_agent, bank_recon_agent, ratio_analysis_agent, profitability_agent, working_capital_agent, break_even_agent, cogs_analysis_agent, revenue_recognition_agent, churn_risk_agent, customer_segmentation_agent, sales_pipeline_agent, pricing_optimization_agent, contract_analysis_agent, marketing_roi_agent, fraud_detection_agent, concentration_risk_agent, scenario_agent, liquidity_risk_agent, covenant_tracking_agent, transaction_classifier, expense_policy_agent, subscription_tracker, commission_calculator, overtime_analysis_agent, unit_economics_agent, valuation_agent, cap_table_agent, lease_analysis_agent, asset_register_agent, price_volume_mix_agent, bridge_analysis_agent, discount_analysis_agent, maverick_spend_agent, collections_priority_agent, bad_debt_provision_agent, credit_scoring_agent, fx_exposure_agent, consolidation_agent, nonprofit_agent, healthcare_agent, legal_billing_agent, hospitality_agent, construction_agent, revenue_quality_agent, cohort_analysis_agent, variance_analysis_agent, cash_flow_forecast_agent, expense_forecast_agent, debt_covenant_agent, tax_provision_agent, collections_agent, board_narrative_agent, investor_update_agent, vendor_risk, trend_detector, period_comparator, health_scorer, email_drafter, recommender, pattern_memory, accountant, forecaster, report_generator, orchestrator_agent, confidence_reviewer_agent, exec_summarizer, insight_synthesis_agent, conflict_detection_agent, alert_agent, client_reporter, narrator, meeting_prepper, board_deck_builder, viz_recommender, chart_config_agent, kpi_card_agent, dashboard_spec_agent, validator, analyst, action_priority_agent]", route.ok && JSON.stringify(route.plan) === JSON.stringify(["data_quality_agent", "schema_detection_agent", "document_classifier", "schema_evolution_agent", "column_profiler", "data_dictionary_agent", "missing_data_agent", "headcount_analytics_agent", "productivity_agent", "growth_rate_agent", "data_privacy_agent", "data_quality", "compliance_agent", "onboarding_agent", "clarification_agent", "multi_period", "audit_summarizer", "kpi_extractor", "sql_analyst", "anomaly_detector", "categorizer", "data_cleaner", "unit_normalizer", "duplicate_detector", "outlier_explanation_agent", "time_series_decomp_agent", "failure_risk_agent", "run_rate_agent", "spend_analysis_agent", "investor_memo_agent", "okr_tracker_agent", "swot_agent", "query_builder_agent", "esg_reporting_agent", "seasonality_agent", "benchmark_agent", "professional_services_agent", "headcount_analysis_agent", "competitive_benchmarking_agent", "data_reshape_agent", "date_normalization_agent", "string_normalization_agent", "currency_normalization_agent", "join_quality_agent", "data_validation_rules_agent", "distribution_agent", "correlation_agent", "regression_agent", "hypothesis_testing_agent", "pareto_agent", "clustering_agent", "reconciler", "invoice_matcher", "cash_flow_agent", "tax_categorizer", "budget_analyst", "saas_metrics_agent", "burn_rate_agent", "cohort_agent", "ar_aging_agent", "ap_agent", "bank_recon_agent", "ratio_analysis_agent", "profitability_agent", "working_capital_agent", "break_even_agent", "cogs_analysis_agent", "revenue_recognition_agent", "churn_risk_agent", "customer_segmentation_agent", "sales_pipeline_agent", "pricing_optimization_agent", "contract_analysis_agent", "marketing_roi_agent", "fraud_detection_agent", "concentration_risk_agent", "scenario_agent", "liquidity_risk_agent", "covenant_tracking_agent", "transaction_classifier", "expense_policy_agent", "subscription_tracker", "commission_calculator", "overtime_analysis_agent", "unit_economics_agent", "valuation_agent", "cap_table_agent", "lease_analysis_agent", "asset_register_agent", "price_volume_mix_agent", "bridge_analysis_agent", "discount_analysis_agent", "maverick_spend_agent", "collections_priority_agent", "bad_debt_provision_agent", "credit_scoring_agent", "fx_exposure_agent", "consolidation_agent", "nonprofit_agent", "healthcare_agent", "legal_billing_agent", "hospitality_agent", "construction_agent", "revenue_quality_agent", "cohort_analysis_agent", "variance_analysis_agent", "cash_flow_forecast_agent", "expense_forecast_agent", "debt_covenant_agent", "tax_provision_agent", "collections_agent", "board_narrative_agent", "investor_update_agent", "vendor_risk", "trend_detector", "period_comparator", "health_scorer", "email_drafter", "recommender", "pattern_memory", "accountant", "forecaster", "report_generator", "orchestrator_agent", "confidence_reviewer_agent", "exec_summarizer", "insight_synthesis_agent", "conflict_detection_agent", "alert_agent", "client_reporter", "narrator", "meeting_prepper", "board_deck_builder", "viz_recommender", "chart_config_agent", "kpi_card_agent", "dashboard_spec_agent", "validator", "analyst", "action_priority_agent"]));
  ok("onehundredforty agent/run events enqueued", enq.length === 140 && enq.every((e) => e.name === "agent/run"));

  // non-financial → analyst only
  const { data: plainPayload } = await db.from("inbound_payloads").insert({
    org_id: orgD, source: "upload", storage_path: `${orgD}/y/z.csv`, original_filename: "z.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const enq2: UiEvent[] = [];
  const route2 = await routePayload({ orgId: orgD, payloadId: plainPayload!.id }, { db, enqueue: (e) => enq2.push(e) });
  ok("non-financial routes to [data_quality_agent, schema_detection_agent, document_classifier, schema_evolution_agent, column_profiler, data_dictionary_agent, missing_data_agent, headcount_analytics_agent, productivity_agent, growth_rate_agent, data_privacy_agent, data_quality, compliance_agent, onboarding_agent, clarification_agent, multi_period, audit_summarizer, kpi_extractor, sql_analyst, anomaly_detector, categorizer, data_cleaner, unit_normalizer, duplicate_detector, outlier_explanation_agent, time_series_decomp_agent, failure_risk_agent, run_rate_agent, spend_analysis_agent, investor_memo_agent, okr_tracker_agent, swot_agent, query_builder_agent, esg_reporting_agent, seasonality_agent, benchmark_agent, professional_services_agent, headcount_analysis_agent, competitive_benchmarking_agent, data_reshape_agent, date_normalization_agent, string_normalization_agent, currency_normalization_agent, join_quality_agent, data_validation_rules_agent, distribution_agent, correlation_agent, regression_agent, hypothesis_testing_agent, pareto_agent, clustering_agent, inventory_tracker, reorder_flagger, supplier_analyst, po_agent, code_reviewer, code_tester, customer_segmentation_agent, contract_analysis_agent, fraud_detection_agent, concentration_risk_agent, scenario_agent, ecommerce_agent, retail_agent, vendor_risk, trend_detector, period_comparator, health_scorer, email_drafter, recommender, pattern_memory, data_merger, report_generator, orchestrator_agent, confidence_reviewer_agent, exec_summarizer, insight_synthesis_agent, conflict_detection_agent, alert_agent, client_reporter, narrator, meeting_prepper, board_deck_builder, viz_recommender, chart_config_agent, kpi_card_agent, dashboard_spec_agent, validator, analyst, action_priority_agent]", route2.ok && JSON.stringify(route2.plan) === JSON.stringify(["data_quality_agent", "schema_detection_agent", "document_classifier", "schema_evolution_agent", "column_profiler", "data_dictionary_agent", "missing_data_agent", "headcount_analytics_agent", "productivity_agent", "growth_rate_agent", "data_privacy_agent", "data_quality", "compliance_agent", "onboarding_agent", "clarification_agent", "multi_period", "audit_summarizer", "kpi_extractor", "sql_analyst", "anomaly_detector", "categorizer", "data_cleaner", "unit_normalizer", "duplicate_detector", "outlier_explanation_agent", "time_series_decomp_agent", "failure_risk_agent", "run_rate_agent", "spend_analysis_agent", "investor_memo_agent", "okr_tracker_agent", "swot_agent", "query_builder_agent", "esg_reporting_agent", "seasonality_agent", "benchmark_agent", "professional_services_agent", "headcount_analysis_agent", "competitive_benchmarking_agent", "data_reshape_agent", "date_normalization_agent", "string_normalization_agent", "currency_normalization_agent", "join_quality_agent", "data_validation_rules_agent", "distribution_agent", "correlation_agent", "regression_agent", "hypothesis_testing_agent", "pareto_agent", "clustering_agent", "inventory_tracker", "reorder_flagger", "supplier_analyst", "po_agent", "code_reviewer", "code_tester", "customer_segmentation_agent", "contract_analysis_agent", "fraud_detection_agent", "concentration_risk_agent", "scenario_agent", "ecommerce_agent", "retail_agent", "vendor_risk", "trend_detector", "period_comparator", "health_scorer", "email_drafter", "recommender", "pattern_memory", "data_merger", "report_generator", "orchestrator_agent", "confidence_reviewer_agent", "exec_summarizer", "insight_synthesis_agent", "conflict_detection_agent", "alert_agent", "client_reporter", "narrator", "meeting_prepper", "board_deck_builder", "viz_recommender", "chart_config_agent", "kpi_card_agent", "dashboard_spec_agent", "validator", "analyst", "action_priority_agent"]));

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
  ok("manager enqueued data_quality_agent+schema_detection_agent+document_classifier+schema_evolution_agent+column_profiler+data_dictionary_agent+missing_data_agent+headcount_analytics_agent+productivity_agent+growth_rate_agent+data_privacy_agent+data_quality+compliance_agent+onboarding_agent+clarification_agent+multi_period+audit_summarizer+kpi_extractor+sql_analyst+anomaly_detector+categorizer+data_cleaner+unit_normalizer+duplicate_detector+outlier_explanation_agent+time_series_decomp_agent+failure_risk_agent+run_rate_agent+spend_analysis_agent+investor_memo_agent+okr_tracker_agent+swot_agent+query_builder_agent+esg_reporting_agent+seasonality_agent+benchmark_agent+professional_services_agent+headcount_analysis_agent+competitive_benchmarking_agent+data_reshape_agent+date_normalization_agent+string_normalization_agent+currency_normalization_agent+join_quality_agent+data_validation_rules_agent+distribution_agent+correlation_agent+regression_agent+hypothesis_testing_agent+pareto_agent+clustering_agent+reconciler+invoice_matcher+cash_flow_agent+tax_categorizer+budget_analyst+saas_metrics_agent+burn_rate_agent+cohort_agent+ar_aging_agent+ap_agent+bank_recon_agent+ratio_analysis_agent+profitability_agent+working_capital_agent+break_even_agent+cogs_analysis_agent+revenue_recognition_agent+churn_risk_agent+customer_segmentation_agent+sales_pipeline_agent+pricing_optimization_agent+contract_analysis_agent+marketing_roi_agent+fraud_detection_agent+concentration_risk_agent+scenario_agent+liquidity_risk_agent+covenant_tracking_agent+transaction_classifier+expense_policy_agent+subscription_tracker+commission_calculator+overtime_analysis_agent+unit_economics_agent+valuation_agent+cap_table_agent+lease_analysis_agent+asset_register_agent+price_volume_mix_agent+bridge_analysis_agent+discount_analysis_agent+maverick_spend_agent+collections_priority_agent+bad_debt_provision_agent+credit_scoring_agent+fx_exposure_agent+consolidation_agent+nonprofit_agent+healthcare_agent+legal_billing_agent+hospitality_agent+construction_agent+revenue_quality_agent+cohort_analysis_agent+variance_analysis_agent+cash_flow_forecast_agent+expense_forecast_agent+debt_covenant_agent+tax_provision_agent+collections_agent+board_narrative_agent+investor_update_agent+vendor_risk+trend_detector+period_comparator+health_scorer+email_drafter+recommender+pattern_memory+accountant+forecaster+report_generator+orchestrator_agent+confidence_reviewer_agent+exec_summarizer+insight_synthesis_agent+conflict_detection_agent+alert_agent+client_reporter+narrator+meeting_prepper+board_deck_builder+viz_recommender+chart_config_agent+kpi_card_agent+dashboard_spec_agent+validator+analyst+action_priority_agent", captured.length === 140);
  for (const e of captured) {
    if (e.name === "agent/run") await runAgent2(e.data, { db, brain: sb2 });
  }
  const { data: chainProps } = await db.from("proposed_actions").select("kind").eq("org_id", orgE);
  ok("chain produced 140 proposals (data quality assessment + schema detection + document classification + schema evolution + column profiling + data dictionary + missing data analysis + headcount analytics + productivity analysis + growth rate calculation + outlier explanation + time series decomposition + failure risk assessment + run rate calculation + spend analysis + investor memo drafting + okr tracking + swot analysis + query building + esg reporting + seasonality analysis + benchmarking + professional services analysis + headcount analysis + competitive benchmarking + data reshape + date normalization + string normalization + currency normalization + join quality assessment + data validation rules + distribution analysis + correlation analysis + regression analysis + hypothesis testing + pareto analysis + clustering + data privacy assessment + data quality + compliance + onboarding + clarification + multi period + audit summary + kpi extraction + sql analysis + anomaly + categorization + cleanup + normalization + duplicate flag + reconciliation + invoice match + cash flow + tax categorization + budget comparison + saas metrics + burn rate + cohort analysis + ar aging + ap analysis + bank reconciliation + ratio analysis + profitability analysis + working capital analysis + break even analysis + cogs analysis + revenue recognition analysis + churn risk analysis + customer segmentation + sales pipeline + pricing optimization + contract analysis + marketing roi + fraud detection + concentration risk + scenario modeling + liquidity risk + covenant tracking + transaction classification + expense policy check + subscription tracking + commission calculation + overtime analysis + unit economics analysis + valuation estimation + cap table analysis + lease analysis + asset register analysis + price volume mix analysis + bridge analysis + discount analysis + maverick spend detection + collections prioritization + bad debt provision + credit scoring + fx exposure analysis + consolidation + nonprofit financial analysis + healthcare financial analysis + legal billing analysis + hospitality financial analysis + construction financial analysis + revenue quality analysis + cohort analysis + variance analysis + cash flow forecast + expense forecast + debt covenant analysis + tax provision analysis + collections management + board narrative drafting + investor update drafting + vendor risk + trend + period comparison + health score + email draft + recommendations + pattern extraction + insight synthesis + conflict detection + forecast + report + orchestration + confidence review + exec summary + alerts + client report + narrative + meeting prep + board deck + viz recommendations + chart configs + kpi cards + dashboard spec + validation + ledger + analyst report + action prioritization)", chainProps?.length === 140);
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

  console.log("== pricing optimization agent ==");
  ok("analyze_pricing accepts good", validateProposal("analyze_pricing", {
    current_pricing: [{ product_service: "Pro Plan", current_price: 2500, unit: "month", cost: 400, margin: 84.0 }],
    price_elasticity: "inelastic", competitive_position: "discount",
    optimization_opportunities: ["Pro Plan priced below market rate"],
    recommended_changes: [{ product_service: "Pro Plan", current_price: 2500, recommended_price: 3200, rationale: "Market benchmarks support increase" }],
    projected_revenue_impact: 84000, confidence: "medium",
  }).ok);
  ok("analyze_pricing rejects bad price_elasticity", !validateProposal("analyze_pricing", {
    current_pricing: [], price_elasticity: "flexible", competitive_position: "discount",
    optimization_opportunities: [], recommended_changes: [], projected_revenue_impact: null, confidence: "medium",
  }).ok);
  ok("analyze_pricing rejects bad competitive_position", !validateProposal("analyze_pricing", {
    current_pricing: [], price_elasticity: "inelastic", competitive_position: "luxury",
    optimization_opportunities: [], recommended_changes: [], projected_revenue_impact: null, confidence: "medium",
  }).ok);
  ok("analyze_pricing rejects bad confidence", !validateProposal("analyze_pricing", {
    current_pricing: [], price_elasticity: "inelastic", competitive_position: "discount",
    optimization_opportunities: [], recommended_changes: [], projected_revenue_impact: null, confidence: "certain",
  }).ok);
  ok("pricing_optimization_agent → opus model",
    (await import("./lib/agent-brain")).modelForRole("pricing_optimization_agent") === "claude-opus-4-8");

  const { runAgent: runAgentPx } = await import("./lib/run-agent");
  const { stubBrain: sbPx } = await import("./lib/agent-brain");
  const { approveAction: approvePx, listPending: listPx } = await import("./lib/actions-service");
  const orgPx = await makeOrg("pro");
  const payloadPx = await makePayload(orgPx);
  const rPx = await runAgentPx({ orgId: orgPx, payloadId: payloadPx, role: "pricing_optimization_agent" }, { db, brain: sbPx });
  ok("pricing_optimization_agent run produced an analysis", rPx.ok && rPx.proposalCount === 1);
  const pendPx = await listPx(orgPx, { db });
  ok("stub proposal passes validateProposal", pendPx.length === 1 && pendPx[0].kind === "analyze_pricing");
  const apprPx = await approvePx(orgPx, pendPx[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes pricing_optimization_runs", apprPx.ok && apprPx.recordTable === "pricing_optimization_runs", JSON.stringify(apprPx));
  const { data: pxRows } = await db.from("pricing_optimization_runs").select("org_id,confidence").eq("org_id", orgPx);
  ok("pricing optimization record org-stamped", pxRows?.length === 1 && pxRows[0].org_id === orgPx);
  const { data: pxAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgPx);
  ok("approveAction writes agent_accuracy for pricing_optimization_agent",
    pxAccRows?.length === 1 && pxAccRows[0].agent_role === "pricing_optimization_agent" && pxAccRows[0].approved_count === 1);
  const { routePayload: routePx } = await import("./lib/manager");
  const routeCheckPx = await routePx({ orgId: orgPx, payloadId: payloadPx }, { db, enqueue: () => {} });
  ok("pricing_optimization_agent routes on the financial route", routeCheckPx.ok && routeCheckPx.plan.includes("pricing_optimization_agent"));
  await db.from("organizations").delete().eq("id", orgPx);

  console.log("== contract analysis agent ==");
  ok("analyze_contracts accepts good", validateProposal("analyze_contracts", {
    contracts: [{
      contract_id: "K001", counterparty: "Acme Corp", contract_type: "customer", total_value: 120000,
      annual_value: 40000, start_date: "2023-01-01", end_date: "2025-12-31", auto_renews: true,
      status: "active", days_until_renewal: 180,
    }],
    total_contract_value: 120000, total_annual_value: 40000,
    renewal_risk_summary: { at_risk_count: 0, at_risk_value: 0, renewals_due_90_days: 0 },
    upcoming_renewals: [{ contract_id: "K001", counterparty: "Acme Corp", renewal_date: "2025-12-31", annual_value: 40000, risk: "low" }],
    red_flags: ["Auto-renewal requires 60-day notice"],
  }).ok);
  ok("analyze_contracts filters out contract with bad contract_type", (() => {
    const r = validateProposal("analyze_contracts", {
      contracts: [
        { contract_id: "Good", counterparty: "Acme", contract_type: "customer", total_value: 1000, annual_value: 500, start_date: "2023-01-01", end_date: "2024-01-01", auto_renews: false, status: "active", days_until_renewal: 30 },
        { contract_id: "Bad", counterparty: "Acme", contract_type: "partner", total_value: 1000, annual_value: 500, start_date: "2023-01-01", end_date: "2024-01-01", auto_renews: false, status: "active", days_until_renewal: 30 },
      ],
      total_contract_value: 2000, total_annual_value: 1000,
      renewal_risk_summary: { at_risk_count: 0, at_risk_value: 0, renewals_due_90_days: 0 },
      upcoming_renewals: [], red_flags: [],
    });
    return r.ok && (r.payload.contracts as unknown[]).length === 1;
  })());
  ok("analyze_contracts filters out contract with bad status", (() => {
    const r = validateProposal("analyze_contracts", {
      contracts: [
        { contract_id: "Good", counterparty: "Acme", contract_type: "customer", total_value: 1000, annual_value: 500, start_date: "2023-01-01", end_date: "2024-01-01", auto_renews: false, status: "active", days_until_renewal: 30 },
        { contract_id: "Bad", counterparty: "Acme", contract_type: "customer", total_value: 1000, annual_value: 500, start_date: "2023-01-01", end_date: "2024-01-01", auto_renews: false, status: "cancelled", days_until_renewal: 30 },
      ],
      total_contract_value: 2000, total_annual_value: 1000,
      renewal_risk_summary: { at_risk_count: 0, at_risk_value: 0, renewals_due_90_days: 0 },
      upcoming_renewals: [], red_flags: [],
    });
    return r.ok && (r.payload.contracts as unknown[]).length === 1;
  })());
  ok("analyze_contracts rejects missing renewal_risk_summary", !validateProposal("analyze_contracts", {
    contracts: [], total_contract_value: 0, total_annual_value: 0,
    renewal_risk_summary: null, upcoming_renewals: [], red_flags: [],
  }).ok);
  ok("contract_analysis_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("contract_analysis_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentCon } = await import("./lib/run-agent");
  const { stubBrain: sbCon } = await import("./lib/agent-brain");
  const { approveAction: approveCon, listPending: listCon } = await import("./lib/actions-service");
  const orgCon = await makeOrg("pro");
  const payloadCon = await makePayload(orgCon);
  const rCon = await runAgentCon({ orgId: orgCon, payloadId: payloadCon, role: "contract_analysis_agent" }, { db, brain: sbCon });
  ok("contract_analysis_agent run produced an analysis", rCon.ok && rCon.proposalCount === 1);
  const pendCon = await listCon(orgCon, { db });
  ok("stub proposal passes validateProposal", pendCon.length === 1 && pendCon[0].kind === "analyze_contracts");
  const apprCon = await approveCon(orgCon, pendCon[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes contract_analysis_runs", apprCon.ok && apprCon.recordTable === "contract_analysis_runs", JSON.stringify(apprCon));
  const { data: conRows } = await db.from("contract_analysis_runs").select("org_id,total_contract_value").eq("org_id", orgCon);
  ok("contract analysis record org-stamped", conRows?.length === 1 && conRows[0].org_id === orgCon);
  const { data: conAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgCon);
  ok("approveAction writes agent_accuracy for contract_analysis_agent",
    conAccRows?.length === 1 && conAccRows[0].agent_role === "contract_analysis_agent" && conAccRows[0].approved_count === 1);
  const { routePayload: routeCon } = await import("./lib/manager");
  const routeCheckConFin = await routeCon({ orgId: orgCon, payloadId: payloadCon }, { db, enqueue: () => {} });
  const { data: plainPayloadCon } = await db.from("inbound_payloads").insert({
    org_id: orgCon, source: "upload", storage_path: `${orgCon}/con/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckConNonFin = await routeCon({ orgId: orgCon, payloadId: plainPayloadCon!.id }, { db, enqueue: () => {} });
  ok("contract_analysis_agent routes on BOTH the financial and non-financial route",
    routeCheckConFin.ok && routeCheckConFin.plan.includes("contract_analysis_agent") &&
    routeCheckConNonFin.ok && routeCheckConNonFin.plan.includes("contract_analysis_agent"));
  await db.from("organizations").delete().eq("id", orgCon);

  console.log("== marketing roi agent ==");
  ok("analyze_marketing_roi accepts good", validateProposal("analyze_marketing_roi", {
    channels: [{ channel_name: "Paid Search", spend: 8000, revenue_attributed: 32000, roi: 300.0, leads_generated: 85, conversions: 12, cac: 666.67 }],
    total_spend: 8000, total_revenue_attributed: 32000, overall_roi: 300.0, customer_acquisition_cost: 666.67,
    best_performing_channel: "Paid Search", worst_performing_channel: "Paid Search", recommendations: ["Increase paid search budget"],
  }).ok);
  ok("analyze_marketing_roi rejects empty best_performing_channel", !validateProposal("analyze_marketing_roi", {
    channels: [{ channel_name: "Paid Search", spend: 8000, revenue_attributed: 32000, roi: 300.0, leads_generated: null, conversions: null, cac: null }],
    total_spend: 8000, total_revenue_attributed: 32000, overall_roi: 300.0, customer_acquisition_cost: null,
    best_performing_channel: "", worst_performing_channel: "Paid Search", recommendations: [],
  }).ok);
  ok("analyze_marketing_roi filters out channel with negative spend", (() => {
    const r = validateProposal("analyze_marketing_roi", {
      channels: [
        { channel_name: "Good", spend: 8000, revenue_attributed: 32000, roi: 300.0, leads_generated: null, conversions: null, cac: null },
        { channel_name: "Bad", spend: -500, revenue_attributed: 1000, roi: 100.0, leads_generated: null, conversions: null, cac: null },
      ],
      total_spend: 8000, total_revenue_attributed: 33000, overall_roi: 300.0, customer_acquisition_cost: null,
      best_performing_channel: "Good", worst_performing_channel: "Bad", recommendations: [],
    });
    return r.ok && (r.payload.channels as unknown[]).length === 1;
  })());
  ok("analyze_marketing_roi rejects when all channels filtered out (empty result)", !validateProposal("analyze_marketing_roi", {
    channels: [{ channel_name: "Bad", spend: -500, revenue_attributed: 1000, roi: 100.0, leads_generated: null, conversions: null, cac: null }],
    total_spend: 8000, total_revenue_attributed: 33000, overall_roi: 300.0, customer_acquisition_cost: null,
    best_performing_channel: "Good", worst_performing_channel: "Bad", recommendations: [],
  }).ok);
  ok("marketing_roi_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("marketing_roi_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentMr } = await import("./lib/run-agent");
  const { stubBrain: sbMr } = await import("./lib/agent-brain");
  const { approveAction: approveMr, listPending: listMr } = await import("./lib/actions-service");
  const orgMr = await makeOrg("pro");
  const payloadMr = await makePayload(orgMr);
  const rMr = await runAgentMr({ orgId: orgMr, payloadId: payloadMr, role: "marketing_roi_agent" }, { db, brain: sbMr });
  ok("marketing_roi_agent run produced an analysis", rMr.ok && rMr.proposalCount === 1);
  const pendMr = await listMr(orgMr, { db });
  ok("stub proposal passes validateProposal", pendMr.length === 1 && pendMr[0].kind === "analyze_marketing_roi");
  const apprMr = await approveMr(orgMr, pendMr[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes marketing_roi_runs", apprMr.ok && apprMr.recordTable === "marketing_roi_runs", JSON.stringify(apprMr));
  const { data: mrRows } = await db.from("marketing_roi_runs").select("org_id,best_performing_channel").eq("org_id", orgMr);
  ok("marketing roi record org-stamped", mrRows?.length === 1 && mrRows[0].org_id === orgMr);
  const { data: mrAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgMr);
  ok("approveAction writes agent_accuracy for marketing_roi_agent",
    mrAccRows?.length === 1 && mrAccRows[0].agent_role === "marketing_roi_agent" && mrAccRows[0].approved_count === 1);
  const { routePayload: routeMr } = await import("./lib/manager");
  const routeCheckMr = await routeMr({ orgId: orgMr, payloadId: payloadMr }, { db, enqueue: () => {} });
  ok("marketing_roi_agent routes on the financial route", routeCheckMr.ok && routeCheckMr.plan.includes("marketing_roi_agent"));
  await db.from("organizations").delete().eq("id", orgMr);

  console.log("== fraud detection agent ==");
  ok("detect_fraud_signals accepts good", validateProposal("detect_fraud_signals", {
    suspicious_items: [{ item_ref: "T001", description: "Round number transaction", amount: 5000, flag_reason: "Suspicious round number pattern", severity: "medium" }],
    risk_level: "medium",
    fraud_patterns: ["Multiple round-number transactions in sequence"],
    benford_analysis: null,
    total_suspicious_amount: 5000,
    recommended_actions: ["Review round-number transactions with approving manager"],
  }).ok);
  ok("detect_fraud_signals filters out item with bad severity", (() => {
    const r = validateProposal("detect_fraud_signals", {
      suspicious_items: [
        { item_ref: "Good", description: "d", amount: 100, flag_reason: "f", severity: "high" },
        { item_ref: "Bad", description: "d", amount: 100, flag_reason: "f", severity: "extreme" },
      ],
      risk_level: "high",
      fraud_patterns: [],
      benford_analysis: null,
      total_suspicious_amount: 200,
      recommended_actions: [],
    });
    return r.ok && (r.payload.suspicious_items as unknown[]).length === 1;
  })());
  ok("detect_fraud_signals rejects bad risk_level", !validateProposal("detect_fraud_signals", {
    suspicious_items: [], risk_level: "extreme", fraud_patterns: [], benford_analysis: null,
    total_suspicious_amount: 0, recommended_actions: [],
  }).ok);
  ok("detect_fraud_signals rejects malformed benford_analysis", !validateProposal("detect_fraud_signals", {
    suspicious_items: [], risk_level: "clean", fraud_patterns: [],
    benford_analysis: { first_digit_distribution: [0.1, 0.2], expected_distribution: [0.3], anomaly_detected: true, anomaly_description: "x" },
    total_suspicious_amount: 0, recommended_actions: [],
  }).ok);
  ok("detect_fraud_signals accepts valid benford_analysis", validateProposal("detect_fraud_signals", {
    suspicious_items: [], risk_level: "clean", fraud_patterns: [],
    benford_analysis: {
      first_digit_distribution: [0.31, 0.19, 0.12, 0.10, 0.08, 0.07, 0.06, 0.05, 0.02],
      expected_distribution: [0.301, 0.176, 0.125, 0.097, 0.079, 0.067, 0.058, 0.051, 0.046],
      anomaly_detected: false, anomaly_description: "No significant deviation from Benford's Law",
    },
    total_suspicious_amount: 0, recommended_actions: [],
  }).ok);
  ok("fraud_detection_agent → opus model",
    (await import("./lib/agent-brain")).modelForRole("fraud_detection_agent") === "claude-opus-4-8");

  const { runAgent: runAgentFr } = await import("./lib/run-agent");
  const { stubBrain: sbFr } = await import("./lib/agent-brain");
  const { approveAction: approveFr, listPending: listFr } = await import("./lib/actions-service");
  const orgFr = await makeOrg("pro");
  const payloadFr = await makePayload(orgFr);
  const rFr = await runAgentFr({ orgId: orgFr, payloadId: payloadFr, role: "fraud_detection_agent" }, { db, brain: sbFr });
  ok("fraud_detection_agent run produced an analysis", rFr.ok && rFr.proposalCount === 1);
  const pendFr = await listFr(orgFr, { db });
  ok("stub proposal passes validateProposal", pendFr.length === 1 && pendFr[0].kind === "detect_fraud_signals");
  const apprFr = await approveFr(orgFr, pendFr[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes fraud_detection_runs", apprFr.ok && apprFr.recordTable === "fraud_detection_runs", JSON.stringify(apprFr));
  const { data: frRows } = await db.from("fraud_detection_runs").select("org_id,risk_level").eq("org_id", orgFr);
  ok("fraud detection record org-stamped", frRows?.length === 1 && frRows[0].org_id === orgFr);
  const { data: frAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgFr);
  ok("approveAction writes agent_accuracy for fraud_detection_agent",
    frAccRows?.length === 1 && frAccRows[0].agent_role === "fraud_detection_agent" && frAccRows[0].approved_count === 1);
  const { routePayload: routeFr } = await import("./lib/manager");
  const routeCheckFrFin = await routeFr({ orgId: orgFr, payloadId: payloadFr }, { db, enqueue: () => {} });
  const { data: plainPayloadFr } = await db.from("inbound_payloads").insert({
    org_id: orgFr, source: "upload", storage_path: `${orgFr}/fr/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckFrNonFin = await routeFr({ orgId: orgFr, payloadId: plainPayloadFr!.id }, { db, enqueue: () => {} });
  ok("fraud_detection_agent routes on BOTH the financial and non-financial route",
    routeCheckFrFin.ok && routeCheckFrFin.plan.includes("fraud_detection_agent") &&
    routeCheckFrNonFin.ok && routeCheckFrNonFin.plan.includes("fraud_detection_agent"));
  await db.from("organizations").delete().eq("id", orgFr);

  console.log("== concentration risk agent ==");
  ok("analyze_concentration_risk accepts good", validateProposal("analyze_concentration_risk", {
    risk_dimensions: [{
      dimension: "customer",
      top_entities: [{ name: "Client Alpha", share: 42.0 }, { name: "Client Beta", share: 28.0 }],
      hhi: 2408, risk_level: "high", notes: "top 2 customers represent 70% of revenue",
    }],
    overall_risk_level: "high", herfindahl_index: 2408, top_3_concentration_percentage: 70.0,
    mitigation_recommendations: ["Diversify customer base"],
  }).ok);
  ok("analyze_concentration_risk filters out dimension with bad risk_level", (() => {
    const r = validateProposal("analyze_concentration_risk", {
      risk_dimensions: [
        { dimension: "customer", top_entities: [], hhi: 1000, risk_level: "medium", notes: "" },
        { dimension: "vendor", top_entities: [], hhi: 1000, risk_level: "extreme", notes: "" },
      ],
      overall_risk_level: "medium", herfindahl_index: 1000, top_3_concentration_percentage: 40,
      mitigation_recommendations: [],
    });
    return r.ok && (r.payload.risk_dimensions as unknown[]).length === 1;
  })());
  ok("analyze_concentration_risk rejects bad overall_risk_level", !validateProposal("analyze_concentration_risk", {
    risk_dimensions: [{ dimension: "customer", top_entities: [], hhi: 1000, risk_level: "medium", notes: "" }],
    overall_risk_level: "extreme", herfindahl_index: 1000, top_3_concentration_percentage: 40,
    mitigation_recommendations: [],
  }).ok);
  ok("analyze_concentration_risk rejects hhi > 10000", !validateProposal("analyze_concentration_risk", {
    risk_dimensions: [{ dimension: "customer", top_entities: [], hhi: 10500, risk_level: "critical", notes: "" }],
    overall_risk_level: "critical", herfindahl_index: 1000, top_3_concentration_percentage: 40,
    mitigation_recommendations: [],
  }).ok);
  ok("concentration_risk_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("concentration_risk_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentCcr } = await import("./lib/run-agent");
  const { stubBrain: sbCcr } = await import("./lib/agent-brain");
  const { approveAction: approveCcr, listPending: listCcr } = await import("./lib/actions-service");
  const orgCcr = await makeOrg("pro");
  const payloadCcr = await makePayload(orgCcr);
  const rCcr = await runAgentCcr({ orgId: orgCcr, payloadId: payloadCcr, role: "concentration_risk_agent" }, { db, brain: sbCcr });
  ok("concentration_risk_agent run produced an analysis", rCcr.ok && rCcr.proposalCount === 1);
  const pendCcr = await listCcr(orgCcr, { db });
  ok("stub proposal passes validateProposal", pendCcr.length === 1 && pendCcr[0].kind === "analyze_concentration_risk");
  const apprCcr = await approveCcr(orgCcr, pendCcr[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes concentration_risk_runs", apprCcr.ok && apprCcr.recordTable === "concentration_risk_runs", JSON.stringify(apprCcr));
  const { data: ccrRows } = await db.from("concentration_risk_runs").select("org_id,overall_risk_level").eq("org_id", orgCcr);
  ok("concentration risk record org-stamped", ccrRows?.length === 1 && ccrRows[0].org_id === orgCcr);
  const { data: ccrAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgCcr);
  ok("approveAction writes agent_accuracy for concentration_risk_agent",
    ccrAccRows?.length === 1 && ccrAccRows[0].agent_role === "concentration_risk_agent" && ccrAccRows[0].approved_count === 1);
  const { routePayload: routeCcr } = await import("./lib/manager");
  const routeCheckCcrFin = await routeCcr({ orgId: orgCcr, payloadId: payloadCcr }, { db, enqueue: () => {} });
  const { data: plainPayloadCcr } = await db.from("inbound_payloads").insert({
    org_id: orgCcr, source: "upload", storage_path: `${orgCcr}/ccr/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckCcrNonFin = await routeCcr({ orgId: orgCcr, payloadId: plainPayloadCcr!.id }, { db, enqueue: () => {} });
  ok("concentration_risk_agent routes on BOTH the financial and non-financial route",
    routeCheckCcrFin.ok && routeCheckCcrFin.plan.includes("concentration_risk_agent") &&
    routeCheckCcrNonFin.ok && routeCheckCcrNonFin.plan.includes("concentration_risk_agent"));
  await db.from("organizations").delete().eq("id", orgCcr);

  console.log("== scenario agent ==");
  ok("model_scenarios accepts good", validateProposal("model_scenarios", {
    base_case: { description: "Current trajectory", revenue: 1200000, costs: 850000, profit: 350000, key_metrics: [{ metric: "gross margin", value: 41.7 }] },
    scenarios: [
      { scenario_name: "Optimistic", type: "optimistic", assumptions: ["20% growth"], revenue: 1440000, costs: 850000, profit: 590000, key_metrics: [], probability: 30, narrative: "Strong pipeline" },
      { scenario_name: "Pessimistic", type: "pessimistic", assumptions: ["Churn +10%"], revenue: 1080000, costs: 977500, profit: 102500, key_metrics: [], probability: 25, narrative: "Macro headwinds" },
    ],
    key_variables: [{ variable: "monthly churn rate", base_value: 2.5, sensitivity: "high" }],
    recommendation: "Plan to base case.",
  }).ok);
  ok("model_scenarios filters out scenario with bad type", (() => {
    const r = validateProposal("model_scenarios", {
      base_case: { description: "Base", revenue: 100, costs: 50, profit: 50, key_metrics: [] },
      scenarios: [
        { scenario_name: "Good1", type: "optimistic", assumptions: [], revenue: 100, costs: 50, profit: 50, key_metrics: [], probability: null, narrative: "n" },
        { scenario_name: "Good2", type: "pessimistic", assumptions: [], revenue: 100, costs: 50, profit: 50, key_metrics: [], probability: null, narrative: "n" },
        { scenario_name: "Bad", type: "unlikely", assumptions: [], revenue: 100, costs: 50, profit: 50, key_metrics: [], probability: null, narrative: "n" },
      ],
      key_variables: [], recommendation: "r",
    });
    return r.ok && (r.payload.scenarios as unknown[]).length === 2;
  })());
  ok("model_scenarios rejects single scenario", !validateProposal("model_scenarios", {
    base_case: { description: "Base", revenue: 100, costs: 50, profit: 50, key_metrics: [] },
    scenarios: [{ scenario_name: "Only", type: "optimistic", assumptions: [], revenue: 100, costs: 50, profit: 50, key_metrics: [], probability: null, narrative: "n" }],
    key_variables: [], recommendation: "r",
  }).ok);
  ok("model_scenarios rejects missing base_case", !validateProposal("model_scenarios", {
    base_case: null,
    scenarios: [
      { scenario_name: "A", type: "optimistic", assumptions: [], revenue: 100, costs: 50, profit: 50, key_metrics: [], probability: null, narrative: "n" },
      { scenario_name: "B", type: "pessimistic", assumptions: [], revenue: 100, costs: 50, profit: 50, key_metrics: [], probability: null, narrative: "n" },
    ],
    key_variables: [], recommendation: "r",
  }).ok);
  ok("scenario_agent → opus model",
    (await import("./lib/agent-brain")).modelForRole("scenario_agent") === "claude-opus-4-8");

  const { runAgent: runAgentSc } = await import("./lib/run-agent");
  const { stubBrain: sbSc } = await import("./lib/agent-brain");
  const { approveAction: approveSc, listPending: listSc } = await import("./lib/actions-service");
  const orgSc = await makeOrg("pro");
  const payloadSc = await makePayload(orgSc);
  const rSc = await runAgentSc({ orgId: orgSc, payloadId: payloadSc, role: "scenario_agent" }, { db, brain: sbSc });
  ok("scenario_agent run produced an analysis", rSc.ok && rSc.proposalCount === 1);
  const pendSc = await listSc(orgSc, { db });
  ok("stub proposal passes validateProposal", pendSc.length === 1 && pendSc[0].kind === "model_scenarios");
  const apprSc = await approveSc(orgSc, pendSc[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes scenario_runs", apprSc.ok && apprSc.recordTable === "scenario_runs", JSON.stringify(apprSc));
  const { data: scRows } = await db.from("scenario_runs").select("org_id,recommendation").eq("org_id", orgSc);
  ok("scenario record org-stamped", scRows?.length === 1 && scRows[0].org_id === orgSc);
  const { data: scAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgSc);
  ok("approveAction writes agent_accuracy for scenario_agent",
    scAccRows?.length === 1 && scAccRows[0].agent_role === "scenario_agent" && scAccRows[0].approved_count === 1);
  const { routePayload: routeSc } = await import("./lib/manager");
  const routeCheckScFin = await routeSc({ orgId: orgSc, payloadId: payloadSc }, { db, enqueue: () => {} });
  const { data: plainPayloadSc } = await db.from("inbound_payloads").insert({
    org_id: orgSc, source: "upload", storage_path: `${orgSc}/sc/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckScNonFin = await routeSc({ orgId: orgSc, payloadId: plainPayloadSc!.id }, { db, enqueue: () => {} });
  ok("scenario_agent routes on BOTH the financial and non-financial route",
    routeCheckScFin.ok && routeCheckScFin.plan.includes("scenario_agent") &&
    routeCheckScNonFin.ok && routeCheckScNonFin.plan.includes("scenario_agent"));
  await db.from("organizations").delete().eq("id", orgSc);

  console.log("== liquidity risk agent ==");
  ok("analyze_liquidity_risk accepts good", validateProposal("analyze_liquidity_risk", {
    cash_and_equivalents: 280000, total_short_term_obligations: 120000,
    liquidity_coverage_ratio: 2.33, months_of_runway: 9.3,
    cash_flow_forecast: [{ period: "Month 1", projected_inflow: 95000, projected_outflow: 65000, net_cash_flow: 30000, cumulative_cash: 310000 }],
    stress_scenarios: [{ scenario_name: "30% Revenue Drop", assumption: "Major customer churns", projected_cash_impact: -85000, months_of_runway_remaining: 5.8 }],
    risk_level: "medium", recommendations: ["Establish revolving credit facility"],
  }).ok);
  ok("analyze_liquidity_risk rejects bad risk_level", !validateProposal("analyze_liquidity_risk", {
    cash_and_equivalents: 280000, total_short_term_obligations: 120000,
    liquidity_coverage_ratio: 2.33, months_of_runway: 9.3,
    cash_flow_forecast: [],
    stress_scenarios: [{ scenario_name: "s", assumption: "a", projected_cash_impact: -1000, months_of_runway_remaining: 3 }],
    risk_level: "extreme", recommendations: [],
  }).ok);
  ok("analyze_liquidity_risk rejects empty stress_scenarios", !validateProposal("analyze_liquidity_risk", {
    cash_and_equivalents: 280000, total_short_term_obligations: 120000,
    liquidity_coverage_ratio: 2.33, months_of_runway: 9.3,
    cash_flow_forecast: [],
    stress_scenarios: [],
    risk_level: "medium", recommendations: [],
  }).ok);
  ok("liquidity_risk_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("liquidity_risk_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentLq } = await import("./lib/run-agent");
  const { stubBrain: sbLq } = await import("./lib/agent-brain");
  const { approveAction: approveLq, listPending: listLq } = await import("./lib/actions-service");
  const orgLq = await makeOrg("pro");
  const payloadLq = await makePayload(orgLq);
  const rLq = await runAgentLq({ orgId: orgLq, payloadId: payloadLq, role: "liquidity_risk_agent" }, { db, brain: sbLq });
  ok("liquidity_risk_agent run produced an analysis", rLq.ok && rLq.proposalCount === 1);
  const pendLq = await listLq(orgLq, { db });
  ok("stub proposal passes validateProposal", pendLq.length === 1 && pendLq[0].kind === "analyze_liquidity_risk");
  const apprLq = await approveLq(orgLq, pendLq[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes liquidity_risk_runs", apprLq.ok && apprLq.recordTable === "liquidity_risk_runs", JSON.stringify(apprLq));
  const { data: lqRows } = await db.from("liquidity_risk_runs").select("org_id,risk_level").eq("org_id", orgLq);
  ok("liquidity risk record org-stamped", lqRows?.length === 1 && lqRows[0].org_id === orgLq);
  const { data: lqAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgLq);
  ok("approveAction writes agent_accuracy for liquidity_risk_agent",
    lqAccRows?.length === 1 && lqAccRows[0].agent_role === "liquidity_risk_agent" && lqAccRows[0].approved_count === 1);
  const { routePayload: routeLq } = await import("./lib/manager");
  const routeCheckLq = await routeLq({ orgId: orgLq, payloadId: payloadLq }, { db, enqueue: () => {} });
  ok("liquidity_risk_agent routes on the financial route", routeCheckLq.ok && routeCheckLq.plan.includes("liquidity_risk_agent"));
  await db.from("organizations").delete().eq("id", orgLq);

  console.log("== covenant tracking agent ==");
  ok("track_covenants accepts good", validateProposal("track_covenants", {
    covenants: [
      { covenant_name: "Debt/EBITDA", covenant_type: "financial", threshold: "<= 3.5x", current_value: "2.8x", status: "compliant", headroom_percentage: 20.0, lender_or_counterparty: "Bank A", notes: "Tested quarterly" },
    ],
    overall_compliance: "compliant", violations_count: 0, at_risk_count: 0,
    next_test_date: "2024-03-31", remediation_actions: [],
  }).ok);
  ok("track_covenants filters out covenant with bad covenant_type", (() => {
    const r = validateProposal("track_covenants", {
      covenants: [
        { covenant_name: "Good", covenant_type: "financial", threshold: "t", current_value: "v", status: "compliant", headroom_percentage: 10, lender_or_counterparty: "L", notes: "" },
        { covenant_name: "Bad", covenant_type: "legal", threshold: "t", current_value: "v", status: "compliant", headroom_percentage: 10, lender_or_counterparty: "L", notes: "" },
      ],
      overall_compliance: "compliant", violations_count: 0, at_risk_count: 0,
      next_test_date: null, remediation_actions: [],
    });
    return r.ok && (r.payload.covenants as unknown[]).length === 1;
  })());
  ok("track_covenants rejects bad overall_compliance", !validateProposal("track_covenants", {
    covenants: [], overall_compliance: "unclear", violations_count: 0, at_risk_count: 0,
    next_test_date: null, remediation_actions: [],
  }).ok);
  ok("covenant_tracking_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("covenant_tracking_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentCv } = await import("./lib/run-agent");
  const { stubBrain: sbCv } = await import("./lib/agent-brain");
  const { approveAction: approveCv, listPending: listCv } = await import("./lib/actions-service");
  const orgCv = await makeOrg("pro");
  const payloadCv = await makePayload(orgCv);
  const rCv = await runAgentCv({ orgId: orgCv, payloadId: payloadCv, role: "covenant_tracking_agent" }, { db, brain: sbCv });
  ok("covenant_tracking_agent run produced an analysis", rCv.ok && rCv.proposalCount === 1);
  const pendCv = await listCv(orgCv, { db });
  ok("stub proposal passes validateProposal", pendCv.length === 1 && pendCv[0].kind === "track_covenants");
  const apprCv = await approveCv(orgCv, pendCv[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes covenant_tracking_runs", apprCv.ok && apprCv.recordTable === "covenant_tracking_runs", JSON.stringify(apprCv));
  const { data: cvRows } = await db.from("covenant_tracking_runs").select("org_id,overall_compliance").eq("org_id", orgCv);
  ok("covenant tracking record org-stamped", cvRows?.length === 1 && cvRows[0].org_id === orgCv);
  const { data: cvAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgCv);
  ok("approveAction writes agent_accuracy for covenant_tracking_agent",
    cvAccRows?.length === 1 && cvAccRows[0].agent_role === "covenant_tracking_agent" && cvAccRows[0].approved_count === 1);
  const { routePayload: routeCv } = await import("./lib/manager");
  const routeCheckCv = await routeCv({ orgId: orgCv, payloadId: payloadCv }, { db, enqueue: () => {} });
  ok("covenant_tracking_agent routes on the financial route", routeCheckCv.ok && routeCheckCv.plan.includes("covenant_tracking_agent"));
  await db.from("organizations").delete().eq("id", orgCv);

  console.log("== document classifier ==");
  ok("classify_document accepts good", validateProposal("classify_document", {
    document_type: "financial_statement", document_subtype: "income_statement", confidence: "high",
    detected_entities: { companies: ["Acme Corp"], dates: ["2024-01-01"], currencies: ["USD"], amounts: [1200000] },
    language: "en", time_period: "FY2024", currency: "USD",
    classification_notes: "Tabular P&L data.",
  }).ok);
  ok("classify_document rejects bad document_type", !validateProposal("classify_document", {
    document_type: "legal_filing", document_subtype: "x", confidence: "high",
    detected_entities: {}, language: "en", time_period: null, currency: null,
    classification_notes: "notes",
  }).ok);
  ok("classify_document rejects bad confidence", !validateProposal("classify_document", {
    document_type: "invoice", document_subtype: "vendor_invoice", confidence: "certain",
    detected_entities: {}, language: "en", time_period: null, currency: null,
    classification_notes: "notes",
  }).ok);
  ok("document_classifier → haiku model",
    (await import("./lib/agent-brain")).modelForRole("document_classifier") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentDoc } = await import("./lib/run-agent");
  const { stubBrain: sbDoc } = await import("./lib/agent-brain");
  const { approveAction: approveDoc, listPending: listDoc } = await import("./lib/actions-service");
  const orgDoc = await makeOrg("pro");
  const payloadDoc = await makePayload(orgDoc);
  const rDoc = await runAgentDoc({ orgId: orgDoc, payloadId: payloadDoc, role: "document_classifier" }, { db, brain: sbDoc });
  ok("document_classifier run produced an analysis", rDoc.ok && rDoc.proposalCount === 1);
  const pendDoc = await listDoc(orgDoc, { db });
  ok("stub proposal passes validateProposal", pendDoc.length === 1 && pendDoc[0].kind === "classify_document");
  const apprDoc = await approveDoc(orgDoc, pendDoc[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes document_classifier_runs", apprDoc.ok && apprDoc.recordTable === "document_classifier_runs", JSON.stringify(apprDoc));
  const { data: docRows } = await db.from("document_classifier_runs").select("org_id,document_type").eq("org_id", orgDoc);
  ok("document classifier record org-stamped", docRows?.length === 1 && docRows[0].org_id === orgDoc);
  const { data: docAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgDoc);
  ok("approveAction writes agent_accuracy for document_classifier",
    docAccRows?.length === 1 && docAccRows[0].agent_role === "document_classifier" && docAccRows[0].approved_count === 1);
  const { routePayload: routeDoc } = await import("./lib/manager");
  const routeCheckDocFin = await routeDoc({ orgId: orgDoc, payloadId: payloadDoc }, { db, enqueue: () => {} });
  const { data: plainPayloadDoc } = await db.from("inbound_payloads").insert({
    org_id: orgDoc, source: "upload", storage_path: `${orgDoc}/doc/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckDocNonFin = await routeDoc({ orgId: orgDoc, payloadId: plainPayloadDoc!.id }, { db, enqueue: () => {} });
  ok("document_classifier routes on BOTH the financial and non-financial route, and is FIRST among non-quality-gate agents in the plan",
    routeCheckDocFin.ok && routeCheckDocFin.plan[2] === "document_classifier" &&
    routeCheckDocNonFin.ok && routeCheckDocNonFin.plan[2] === "document_classifier");
  await db.from("organizations").delete().eq("id", orgDoc);

  console.log("== schema evolution agent ==");
  ok("detect_schema_evolution accepts good", validateProposal("detect_schema_evolution", {
    columns_detected: [{ column_name: "revenue", inferred_type: "number", nullable: false, sample_values: ["100", "200"] }],
    schema_version: "auto-001", breaking_changes: [], added_columns: [], removed_columns: [],
    renamed_columns: [], type_changes: [], compatibility: "compatible",
  }).ok);
  ok("detect_schema_evolution filters out column with bad inferred_type", (() => {
    const r = validateProposal("detect_schema_evolution", {
      columns_detected: [
        { column_name: "Good", inferred_type: "number", nullable: false, sample_values: [] },
        { column_name: "Bad", inferred_type: "object", nullable: false, sample_values: [] },
      ],
      schema_version: "auto-001", breaking_changes: [], added_columns: [], removed_columns: [],
      renamed_columns: [], type_changes: [], compatibility: "compatible",
    });
    return r.ok && (r.payload.columns_detected as unknown[]).length === 1;
  })());
  ok("detect_schema_evolution rejects bad compatibility", !validateProposal("detect_schema_evolution", {
    columns_detected: [], schema_version: "auto-001", breaking_changes: [], added_columns: [], removed_columns: [],
    renamed_columns: [], type_changes: [], compatibility: "sort_of",
  }).ok);
  ok("schema_evolution_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("schema_evolution_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentSe } = await import("./lib/run-agent");
  const { stubBrain: sbSe } = await import("./lib/agent-brain");
  const { approveAction: approveSe, listPending: listSe } = await import("./lib/actions-service");
  const orgSe = await makeOrg("pro");
  const payloadSe = await makePayload(orgSe);
  const rSe = await runAgentSe({ orgId: orgSe, payloadId: payloadSe, role: "schema_evolution_agent" }, { db, brain: sbSe });
  ok("schema_evolution_agent run produced an analysis", rSe.ok && rSe.proposalCount === 1);
  const pendSe = await listSe(orgSe, { db });
  ok("stub proposal passes validateProposal", pendSe.length === 1 && pendSe[0].kind === "detect_schema_evolution");
  const apprSe = await approveSe(orgSe, pendSe[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes schema_evolution_runs", apprSe.ok && apprSe.recordTable === "schema_evolution_runs", JSON.stringify(apprSe));
  const { data: seRows } = await db.from("schema_evolution_runs").select("org_id,compatibility").eq("org_id", orgSe);
  ok("schema evolution record org-stamped", seRows?.length === 1 && seRows[0].org_id === orgSe);
  const { data: seAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgSe);
  ok("approveAction writes agent_accuracy for schema_evolution_agent",
    seAccRows?.length === 1 && seAccRows[0].agent_role === "schema_evolution_agent" && seAccRows[0].approved_count === 1);
  const { routePayload: routeSe } = await import("./lib/manager");
  const routeCheckSeFin = await routeSe({ orgId: orgSe, payloadId: payloadSe }, { db, enqueue: () => {} });
  const { data: plainPayloadSe } = await db.from("inbound_payloads").insert({
    org_id: orgSe, source: "upload", storage_path: `${orgSe}/se/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckSeNonFin = await routeSe({ orgId: orgSe, payloadId: plainPayloadSe!.id }, { db, enqueue: () => {} });
  ok("schema_evolution_agent routes on BOTH the financial and non-financial route, fourth position after data_quality_agent, schema_detection_agent, and document_classifier",
    routeCheckSeFin.ok && routeCheckSeFin.plan[3] === "schema_evolution_agent" &&
    routeCheckSeNonFin.ok && routeCheckSeNonFin.plan[3] === "schema_evolution_agent");
  await db.from("organizations").delete().eq("id", orgSe);

  console.log("== kpi extractor ==");
  ok("extract_kpis accepts good", validateProposal("extract_kpis", {
    kpis: [{ kpi_name: "MRR", value: 95000, unit: "$", category: "financial", period: "2024-02", trend: "improving", benchmark: null, vs_benchmark: null }],
    kpi_count: 1, top_kpis: ["MRR"], data_quality: "medium",
  }).ok);
  ok("extract_kpis filters out kpi with bad category", (() => {
    const r = validateProposal("extract_kpis", {
      kpis: [
        { kpi_name: "Good", value: 1, unit: "$", category: "financial", period: null, trend: "stable", benchmark: null, vs_benchmark: null },
        { kpi_name: "Bad", value: 1, unit: "$", category: "marketing", period: null, trend: "stable", benchmark: null, vs_benchmark: null },
      ],
      kpi_count: 2, top_kpis: [], data_quality: "medium",
    });
    return r.ok && (r.payload.kpis as unknown[]).length === 1;
  })());
  ok("extract_kpis filters out kpi with bad trend", (() => {
    const r = validateProposal("extract_kpis", {
      kpis: [
        { kpi_name: "Good", value: 1, unit: "$", category: "financial", period: null, trend: "stable", benchmark: null, vs_benchmark: null },
        { kpi_name: "Bad", value: 1, unit: "$", category: "financial", period: null, trend: "up", benchmark: null, vs_benchmark: null },
      ],
      kpi_count: 2, top_kpis: [], data_quality: "medium",
    });
    return r.ok && (r.payload.kpis as unknown[]).length === 1;
  })());
  ok("kpi_extractor → haiku model",
    (await import("./lib/agent-brain")).modelForRole("kpi_extractor") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentKe } = await import("./lib/run-agent");
  const { stubBrain: sbKe } = await import("./lib/agent-brain");
  const { approveAction: approveKe, listPending: listKe } = await import("./lib/actions-service");
  const orgKe = await makeOrg("pro");
  const payloadKe = await makePayload(orgKe);
  const rKe = await runAgentKe({ orgId: orgKe, payloadId: payloadKe, role: "kpi_extractor" }, { db, brain: sbKe });
  ok("kpi_extractor run produced an analysis", rKe.ok && rKe.proposalCount === 1);
  const pendKe = await listKe(orgKe, { db });
  ok("stub proposal passes validateProposal", pendKe.length === 1 && pendKe[0].kind === "extract_kpis");
  const apprKe = await approveKe(orgKe, pendKe[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes kpi_extractor_runs", apprKe.ok && apprKe.recordTable === "kpi_extractor_runs", JSON.stringify(apprKe));
  const { data: keRows } = await db.from("kpi_extractor_runs").select("org_id,kpi_count").eq("org_id", orgKe);
  ok("kpi extractor record org-stamped", keRows?.length === 1 && keRows[0].org_id === orgKe);
  const { data: keAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgKe);
  ok("approveAction writes agent_accuracy for kpi_extractor",
    keAccRows?.length === 1 && keAccRows[0].agent_role === "kpi_extractor" && keAccRows[0].approved_count === 1);
  const { routePayload: routeKe } = await import("./lib/manager");
  const routeCheckKeFin = await routeKe({ orgId: orgKe, payloadId: payloadKe }, { db, enqueue: () => {} });
  const { data: plainPayloadKe } = await db.from("inbound_payloads").insert({
    org_id: orgKe, source: "upload", storage_path: `${orgKe}/ke/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckKeNonFin = await routeKe({ orgId: orgKe, payloadId: plainPayloadKe!.id }, { db, enqueue: () => {} });
  ok("kpi_extractor routes on BOTH the financial and non-financial route",
    routeCheckKeFin.ok && routeCheckKeFin.plan.includes("kpi_extractor") &&
    routeCheckKeNonFin.ok && routeCheckKeNonFin.plan.includes("kpi_extractor"));
  await db.from("organizations").delete().eq("id", orgKe);

  console.log("== insight synthesis agent ==");
  ok("synthesize_insights accepts good", validateProposal("synthesize_insights", {
    executive_summary: "The org shows strong revenue momentum.",
    key_insights: [
      { insight: "MRR growing", evidence: "revenue data", impact: "high" },
      { insight: "margin expanding", evidence: "cost data", impact: "medium" },
      { insight: "churn elevated", evidence: "cohort data", impact: "high" },
    ],
    strategic_implications: ["invest in retention"],
    critical_risks: [{ risk: "customer concentration", likelihood: "high", potential_impact: "revenue drop" }],
    opportunities: [{ opportunity: "mid-market expansion", effort: "medium", potential_impact: "3x TAM" }],
    confidence: "medium",
  }).ok);
  ok("synthesize_insights filters out key_insight with bad impact", (() => {
    const r = validateProposal("synthesize_insights", {
      executive_summary: "Summary.",
      key_insights: [
        { insight: "A", evidence: "e", impact: "high" },
        { insight: "B", evidence: "e", impact: "medium" },
        { insight: "C", evidence: "e", impact: "low" },
        { insight: "D", evidence: "e", impact: "extreme" },
      ],
      strategic_implications: [], critical_risks: [], opportunities: [], confidence: "high",
    });
    return r.ok && (r.payload.key_insights as unknown[]).length === 3;
  })());
  ok("synthesize_insights rejects fewer than 3 key_insights", !validateProposal("synthesize_insights", {
    executive_summary: "Summary.",
    key_insights: [{ insight: "A", evidence: "e", impact: "high" }, { insight: "B", evidence: "e", impact: "medium" }],
    strategic_implications: [], critical_risks: [], opportunities: [], confidence: "high",
  }).ok);
  ok("insight_synthesis_agent → opus model",
    (await import("./lib/agent-brain")).modelForRole("insight_synthesis_agent") === "claude-opus-4-8");

  const { runAgent: runAgentIs } = await import("./lib/run-agent");
  const { stubBrain: sbIs } = await import("./lib/agent-brain");
  const { approveAction: approveIs, listPending: listIs } = await import("./lib/actions-service");
  const orgIs = await makeOrg("pro");
  const payloadIs = await makePayload(orgIs);
  const rIs = await runAgentIs({ orgId: orgIs, payloadId: payloadIs, role: "insight_synthesis_agent" }, { db, brain: sbIs });
  ok("insight_synthesis_agent run produced an analysis", rIs.ok && rIs.proposalCount === 1);
  const pendIs = await listIs(orgIs, { db });
  ok("stub proposal passes validateProposal", pendIs.length === 1 && pendIs[0].kind === "synthesize_insights");
  const apprIs = await approveIs(orgIs, pendIs[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes insight_synthesis_runs", apprIs.ok && apprIs.recordTable === "insight_synthesis_runs", JSON.stringify(apprIs));
  const { data: isRows } = await db.from("insight_synthesis_runs").select("org_id,confidence").eq("org_id", orgIs);
  ok("insight synthesis record org-stamped", isRows?.length === 1 && isRows[0].org_id === orgIs);
  const { data: isAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgIs);
  ok("approveAction writes agent_accuracy for insight_synthesis_agent",
    isAccRows?.length === 1 && isAccRows[0].agent_role === "insight_synthesis_agent" && isAccRows[0].approved_count === 1);
  const { routePayload: routeIs } = await import("./lib/manager");
  const routeCheckIsFin = await routeIs({ orgId: orgIs, payloadId: payloadIs }, { db, enqueue: () => {} });
  const { data: plainPayloadIs } = await db.from("inbound_payloads").insert({
    org_id: orgIs, source: "upload", storage_path: `${orgIs}/is/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckIsNonFin = await routeIs({ orgId: orgIs, payloadId: plainPayloadIs!.id }, { db, enqueue: () => {} });
  ok("insight_synthesis_agent routes on BOTH the financial and non-financial route, immediately after exec_summarizer",
    routeCheckIsFin.ok && routeCheckIsFin.plan[routeCheckIsFin.plan.indexOf("exec_summarizer") + 1] === "insight_synthesis_agent" &&
    routeCheckIsNonFin.ok && routeCheckIsNonFin.plan[routeCheckIsNonFin.plan.indexOf("exec_summarizer") + 1] === "insight_synthesis_agent");
  await db.from("organizations").delete().eq("id", orgIs);

  console.log("== conflict detection agent ==");
  ok("detect_conflicts accepts good with no conflicts", validateProposal("detect_conflicts", {
    conflicts: [], conflict_count: 0, severity: "none", resolution_suggestions: [],
  }).ok);
  ok("detect_conflicts filters out conflict with bad type", (() => {
    const r = validateProposal("detect_conflicts", {
      conflicts: [
        { conflict_id: "Good", type: "calculation_error", description: "d", affected_fields: [], severity: "medium", resolution: "r" },
        { conflict_id: "Bad", type: "typo", description: "d", affected_fields: [], severity: "medium", resolution: "r" },
      ],
      conflict_count: 2, severity: "medium", resolution_suggestions: [],
    });
    return r.ok && (r.payload.conflicts as unknown[]).length === 1;
  })());
  ok("detect_conflicts rejects bad severity", !validateProposal("detect_conflicts", {
    conflicts: [], conflict_count: 0, severity: "unclear", resolution_suggestions: [],
  }).ok);
  ok("conflict_detection_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("conflict_detection_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentCd } = await import("./lib/run-agent");
  const { stubBrain: sbCd } = await import("./lib/agent-brain");
  const { approveAction: approveCd, listPending: listCd } = await import("./lib/actions-service");
  const orgCd = await makeOrg("pro");
  const payloadCd = await makePayload(orgCd);
  const rCd = await runAgentCd({ orgId: orgCd, payloadId: payloadCd, role: "conflict_detection_agent" }, { db, brain: sbCd });
  ok("conflict_detection_agent run produced an analysis", rCd.ok && rCd.proposalCount === 1);
  const pendCd = await listCd(orgCd, { db });
  ok("stub proposal passes validateProposal", pendCd.length === 1 && pendCd[0].kind === "detect_conflicts");
  const apprCd = await approveCd(orgCd, pendCd[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes conflict_detection_runs", apprCd.ok && apprCd.recordTable === "conflict_detection_runs", JSON.stringify(apprCd));
  const { data: cdRows } = await db.from("conflict_detection_runs").select("org_id,severity").eq("org_id", orgCd);
  ok("conflict detection record org-stamped", cdRows?.length === 1 && cdRows[0].org_id === orgCd);
  const { data: cdAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgCd);
  ok("approveAction writes agent_accuracy for conflict_detection_agent",
    cdAccRows?.length === 1 && cdAccRows[0].agent_role === "conflict_detection_agent" && cdAccRows[0].approved_count === 1);
  const { routePayload: routeCd } = await import("./lib/manager");
  const routeCheckCdFin = await routeCd({ orgId: orgCd, payloadId: payloadCd }, { db, enqueue: () => {} });
  const { data: plainPayloadCd } = await db.from("inbound_payloads").insert({
    org_id: orgCd, source: "upload", storage_path: `${orgCd}/cd/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckCdNonFin = await routeCd({ orgId: orgCd, payloadId: plainPayloadCd!.id }, { db, enqueue: () => {} });
  ok("conflict_detection_agent routes on BOTH the financial and non-financial route, immediately after insight_synthesis_agent",
    routeCheckCdFin.ok && routeCheckCdFin.plan[routeCheckCdFin.plan.indexOf("insight_synthesis_agent") + 1] === "conflict_detection_agent" &&
    routeCheckCdNonFin.ok && routeCheckCdNonFin.plan[routeCheckCdNonFin.plan.indexOf("insight_synthesis_agent") + 1] === "conflict_detection_agent");
  await db.from("organizations").delete().eq("id", orgCd);

  console.log("== action priority agent ==");
  ok("prioritize_actions accepts good", validateProposal("prioritize_actions", {
    prioritized_actions: [
      { action: "Address concentration risk", priority_rank: 1, impact: "high", effort: "medium", urgency: "this_quarter", owner_role: "CEO", rationale: "top 2 customers = 70% revenue" },
    ],
    top_3_actions: [
      { rank: 1, action: "Address concentration risk", why_now: "existential risk" },
      { rank: 2, action: "Improve liquidity buffer", why_now: "need buffer" },
      { rank: 3, action: "Launch retention program", why_now: "churn accelerating" },
    ],
    total_actions_reviewed: 8, decision_rationale: "prioritized by risk impact.",
  }).ok);
  ok("prioritize_actions filters out action with bad impact", (() => {
    const r = validateProposal("prioritize_actions", {
      prioritized_actions: [
        { action: "Good", priority_rank: 1, impact: "high", effort: "medium", urgency: "this_week", owner_role: "CFO", rationale: "r" },
        { action: "Bad", priority_rank: 2, impact: "extreme", effort: "medium", urgency: "this_week", owner_role: "CFO", rationale: "r" },
      ],
      top_3_actions: [
        { rank: 1, action: "A", why_now: "n" },
        { rank: 2, action: "B", why_now: "n" },
        { rank: 3, action: "C", why_now: "n" },
      ],
      total_actions_reviewed: 2, decision_rationale: "r",
    });
    return r.ok && (r.payload.prioritized_actions as unknown[]).length === 1;
  })());
  ok("prioritize_actions rejects top_3_actions with only 2 items", !validateProposal("prioritize_actions", {
    prioritized_actions: [],
    top_3_actions: [
      { rank: 1, action: "A", why_now: "n" },
      { rank: 2, action: "B", why_now: "n" },
    ],
    total_actions_reviewed: 0, decision_rationale: "r",
  }).ok);
  ok("action_priority_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("action_priority_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentApr } = await import("./lib/run-agent");
  const { stubBrain: sbApr } = await import("./lib/agent-brain");
  const { approveAction: approveApr, listPending: listApr } = await import("./lib/actions-service");
  const orgApr = await makeOrg("pro");
  const payloadApr = await makePayload(orgApr);
  const rApr = await runAgentApr({ orgId: orgApr, payloadId: payloadApr, role: "action_priority_agent" }, { db, brain: sbApr });
  ok("action_priority_agent run produced an analysis", rApr.ok && rApr.proposalCount === 1);
  const pendApr = await listApr(orgApr, { db });
  ok("stub proposal passes validateProposal", pendApr.length === 1 && pendApr[0].kind === "prioritize_actions");
  const apprApr = await approveApr(orgApr, pendApr[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes action_priority_runs", apprApr.ok && apprApr.recordTable === "action_priority_runs", JSON.stringify(apprApr));
  const { data: aprRows } = await db.from("action_priority_runs").select("org_id,total_actions_reviewed").eq("org_id", orgApr);
  ok("action priority record org-stamped", aprRows?.length === 1 && aprRows[0].org_id === orgApr);
  const { data: aprAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgApr);
  ok("approveAction writes agent_accuracy for action_priority_agent",
    aprAccRows?.length === 1 && aprAccRows[0].agent_role === "action_priority_agent" && aprAccRows[0].approved_count === 1);
  const { routePayload: routeApr } = await import("./lib/manager");
  const routeCheckAprFin = await routeApr({ orgId: orgApr, payloadId: payloadApr }, { db, enqueue: () => {} });
  const { data: plainPayloadApr } = await db.from("inbound_payloads").insert({
    org_id: orgApr, source: "upload", storage_path: `${orgApr}/apr/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckAprNonFin = await routeApr({ orgId: orgApr, payloadId: plainPayloadApr!.id }, { db, enqueue: () => {} });
  ok("action_priority_agent routes on BOTH the financial and non-financial route, and is LAST in the plan",
    routeCheckAprFin.ok && routeCheckAprFin.plan[routeCheckAprFin.plan.length - 1] === "action_priority_agent" &&
    routeCheckAprNonFin.ok && routeCheckAprNonFin.plan[routeCheckAprNonFin.plan.length - 1] === "action_priority_agent");
  await db.from("organizations").delete().eq("id", orgApr);

  console.log("== column profiler ==");
  ok("profile_columns accepts good", validateProposal("profile_columns", {
    column_profiles: [{
      column_name: "revenue", data_type: "float", null_count: 0, null_percentage: 0.0,
      unique_count: 12, unique_percentage: 100.0, min_value: "45000", max_value: "120000",
      top_values: [{ value: "95000", count: 1 }], has_issues: false,
    }],
    total_rows: 12, total_columns: 1, overall_completeness: 100.0,
  }).ok);
  ok("profile_columns filters out column with bad data_type", (() => {
    const r = validateProposal("profile_columns", {
      column_profiles: [
        { column_name: "Good", data_type: "string", null_count: 0, null_percentage: 0, unique_count: 1, unique_percentage: 100, min_value: null, max_value: null, top_values: [], has_issues: false },
        { column_name: "Bad", data_type: "object", null_count: 0, null_percentage: 0, unique_count: 1, unique_percentage: 100, min_value: null, max_value: null, top_values: [], has_issues: false },
      ],
      total_rows: 1, total_columns: 2, overall_completeness: 100,
    });
    return r.ok && (r.payload.column_profiles as unknown[]).length === 1;
  })());
  ok("profile_columns filters out column with null_percentage > 100", (() => {
    const r = validateProposal("profile_columns", {
      column_profiles: [
        { column_name: "Good", data_type: "string", null_count: 0, null_percentage: 0, unique_count: 1, unique_percentage: 100, min_value: null, max_value: null, top_values: [], has_issues: false },
        { column_name: "Bad", data_type: "string", null_count: 0, null_percentage: 150, unique_count: 1, unique_percentage: 100, min_value: null, max_value: null, top_values: [], has_issues: false },
      ],
      total_rows: 1, total_columns: 2, overall_completeness: 100,
    });
    return r.ok && (r.payload.column_profiles as unknown[]).length === 1;
  })());
  ok("column_profiler → haiku model",
    (await import("./lib/agent-brain")).modelForRole("column_profiler") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentCp } = await import("./lib/run-agent");
  const { stubBrain: sbCp } = await import("./lib/agent-brain");
  const { approveAction: approveCp, listPending: listCp } = await import("./lib/actions-service");
  const orgCp = await makeOrg("pro");
  const payloadCp = await makePayload(orgCp);
  const rCp = await runAgentCp({ orgId: orgCp, payloadId: payloadCp, role: "column_profiler" }, { db, brain: sbCp });
  ok("column_profiler run produced an analysis", rCp.ok && rCp.proposalCount === 1);
  const pendCp = await listCp(orgCp, { db });
  ok("stub proposal passes validateProposal", pendCp.length === 1 && pendCp[0].kind === "profile_columns");
  const apprCp = await approveCp(orgCp, pendCp[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes column_profiler_runs", apprCp.ok && apprCp.recordTable === "column_profiler_runs", JSON.stringify(apprCp));
  const { data: cpRows } = await db.from("column_profiler_runs").select("org_id,total_rows").eq("org_id", orgCp);
  ok("column profiler record org-stamped", cpRows?.length === 1 && cpRows[0].org_id === orgCp);
  const { data: cpAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgCp);
  ok("approveAction writes agent_accuracy for column_profiler",
    cpAccRows?.length === 1 && cpAccRows[0].agent_role === "column_profiler" && cpAccRows[0].approved_count === 1);
  const { routePayload: routeCp } = await import("./lib/manager");
  const routeCheckCpFin = await routeCp({ orgId: orgCp, payloadId: payloadCp }, { db, enqueue: () => {} });
  const { data: plainPayloadCp } = await db.from("inbound_payloads").insert({
    org_id: orgCp, source: "upload", storage_path: `${orgCp}/cp/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckCpNonFin = await routeCp({ orgId: orgCp, payloadId: plainPayloadCp!.id }, { db, enqueue: () => {} });
  ok("column_profiler routes on BOTH the financial and non-financial route, immediately after schema_evolution_agent",
    routeCheckCpFin.ok && routeCheckCpFin.plan[routeCheckCpFin.plan.indexOf("schema_evolution_agent") + 1] === "column_profiler" &&
    routeCheckCpNonFin.ok && routeCheckCpNonFin.plan[routeCheckCpNonFin.plan.indexOf("schema_evolution_agent") + 1] === "column_profiler");
  await db.from("organizations").delete().eq("id", orgCp);

  console.log("== data dictionary agent ==");
  ok("build_data_dictionary accepts good", validateProposal("build_data_dictionary", {
    entries: [{
      column_name: "customer_id", description: "Unique customer identifier",
      business_meaning: "Links record to specific customer account",
      data_type: "string", expected_format: "UUID", example_values: ["cust-001"],
      is_key: true, is_sensitive: false, tags: ["identifier", "customer"],
    }],
    total_columns_documented: 1, undocumented_columns: [],
  }).ok);
  ok("build_data_dictionary filters out entry with empty description", (() => {
    const r = validateProposal("build_data_dictionary", {
      entries: [
        { column_name: "Good", description: "d", business_meaning: "m", data_type: "string", expected_format: null, example_values: [], is_key: false, is_sensitive: false, tags: [] },
        { column_name: "Bad", description: "", business_meaning: "m", data_type: "string", expected_format: null, example_values: [], is_key: false, is_sensitive: false, tags: [] },
      ],
      total_columns_documented: 2, undocumented_columns: [],
    });
    return r.ok && (r.payload.entries as unknown[]).length === 1;
  })());
  ok("build_data_dictionary truncates tags to max 5", (() => {
    const r = validateProposal("build_data_dictionary", {
      entries: [{
        column_name: "Good", description: "d", business_meaning: "m", data_type: "string",
        expected_format: null, example_values: [], is_key: false, is_sensitive: false,
        tags: ["a", "b", "c", "d", "e", "f", "g"],
      }],
      total_columns_documented: 1, undocumented_columns: [],
    });
    return r.ok && (((r.payload.entries as { tags: string[] }[])[0]).tags.length === 5);
  })());
  ok("data_dictionary_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("data_dictionary_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentDda } = await import("./lib/run-agent");
  const { stubBrain: sbDda } = await import("./lib/agent-brain");
  const { approveAction: approveDda, listPending: listDda } = await import("./lib/actions-service");
  const orgDda = await makeOrg("pro");
  const payloadDda = await makePayload(orgDda);
  const rDda = await runAgentDda({ orgId: orgDda, payloadId: payloadDda, role: "data_dictionary_agent" }, { db, brain: sbDda });
  ok("data_dictionary_agent run produced an analysis", rDda.ok && rDda.proposalCount === 1);
  const pendDda = await listDda(orgDda, { db });
  ok("stub proposal passes validateProposal", pendDda.length === 1 && pendDda[0].kind === "build_data_dictionary");
  const apprDda = await approveDda(orgDda, pendDda[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes data_dictionary_runs", apprDda.ok && apprDda.recordTable === "data_dictionary_runs", JSON.stringify(apprDda));
  const { data: ddaRows } = await db.from("data_dictionary_runs").select("org_id,total_columns_documented").eq("org_id", orgDda);
  ok("data dictionary record org-stamped", ddaRows?.length === 1 && ddaRows[0].org_id === orgDda);
  const { data: ddaAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgDda);
  ok("approveAction writes agent_accuracy for data_dictionary_agent",
    ddaAccRows?.length === 1 && ddaAccRows[0].agent_role === "data_dictionary_agent" && ddaAccRows[0].approved_count === 1);
  const { routePayload: routeDda } = await import("./lib/manager");
  const routeCheckDdaFin = await routeDda({ orgId: orgDda, payloadId: payloadDda }, { db, enqueue: () => {} });
  const { data: plainPayloadDda } = await db.from("inbound_payloads").insert({
    org_id: orgDda, source: "upload", storage_path: `${orgDda}/dda/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckDdaNonFin = await routeDda({ orgId: orgDda, payloadId: plainPayloadDda!.id }, { db, enqueue: () => {} });
  ok("data_dictionary_agent routes on BOTH the financial and non-financial route, immediately after column_profiler",
    routeCheckDdaFin.ok && routeCheckDdaFin.plan[routeCheckDdaFin.plan.indexOf("column_profiler") + 1] === "data_dictionary_agent" &&
    routeCheckDdaNonFin.ok && routeCheckDdaNonFin.plan[routeCheckDdaNonFin.plan.indexOf("column_profiler") + 1] === "data_dictionary_agent");
  await db.from("organizations").delete().eq("id", orgDda);

  console.log("== missing data agent ==");
  ok("analyze_missing_data accepts good", validateProposal("analyze_missing_data", {
    missing_summary: [{ column_name: "cost", missing_count: 3, missing_percentage: 25.0, missing_pattern: "random", impact: "high" }],
    critical_gaps: ["cost data missing affects margin calc"],
    imputation_suggestions: [{ column_name: "cost", strategy: "median", rationale: "random missingness" }],
    overall_completeness: 87.5, data_usability: "partially_usable",
  }).ok);
  ok("analyze_missing_data filters out summary with bad missing_pattern", (() => {
    const r = validateProposal("analyze_missing_data", {
      missing_summary: [
        { column_name: "Good", missing_count: 0, missing_percentage: 0, missing_pattern: "none", impact: "low" },
        { column_name: "Bad", missing_count: 0, missing_percentage: 0, missing_pattern: "sporadic", impact: "low" },
      ],
      critical_gaps: [], imputation_suggestions: [], overall_completeness: 100, data_usability: "fully_usable",
    });
    return r.ok && (r.payload.missing_summary as unknown[]).length === 1;
  })());
  ok("analyze_missing_data rejects bad data_usability", !validateProposal("analyze_missing_data", {
    missing_summary: [], critical_gaps: [], imputation_suggestions: [],
    overall_completeness: 100, data_usability: "somewhat_usable",
  }).ok);
  ok("missing_data_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("missing_data_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentMd } = await import("./lib/run-agent");
  const { stubBrain: sbMd } = await import("./lib/agent-brain");
  const { approveAction: approveMd, listPending: listMd } = await import("./lib/actions-service");
  const orgMd = await makeOrg("pro");
  const payloadMd = await makePayload(orgMd);
  const rMd = await runAgentMd({ orgId: orgMd, payloadId: payloadMd, role: "missing_data_agent" }, { db, brain: sbMd });
  ok("missing_data_agent run produced an analysis", rMd.ok && rMd.proposalCount === 1);
  const pendMd = await listMd(orgMd, { db });
  ok("stub proposal passes validateProposal", pendMd.length === 1 && pendMd[0].kind === "analyze_missing_data");
  const apprMd = await approveMd(orgMd, pendMd[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes missing_data_runs", apprMd.ok && apprMd.recordTable === "missing_data_runs", JSON.stringify(apprMd));
  const { data: mdRows } = await db.from("missing_data_runs").select("org_id,data_usability").eq("org_id", orgMd);
  ok("missing data record org-stamped", mdRows?.length === 1 && mdRows[0].org_id === orgMd);
  const { data: mdAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgMd);
  ok("approveAction writes agent_accuracy for missing_data_agent",
    mdAccRows?.length === 1 && mdAccRows[0].agent_role === "missing_data_agent" && mdAccRows[0].approved_count === 1);
  const { routePayload: routeMd } = await import("./lib/manager");
  const routeCheckMdFin = await routeMd({ orgId: orgMd, payloadId: payloadMd }, { db, enqueue: () => {} });
  const { data: plainPayloadMd } = await db.from("inbound_payloads").insert({
    org_id: orgMd, source: "upload", storage_path: `${orgMd}/md/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckMdNonFin = await routeMd({ orgId: orgMd, payloadId: plainPayloadMd!.id }, { db, enqueue: () => {} });
  ok("missing_data_agent routes on BOTH the financial and non-financial route, immediately after data_dictionary_agent",
    routeCheckMdFin.ok && routeCheckMdFin.plan[routeCheckMdFin.plan.indexOf("data_dictionary_agent") + 1] === "missing_data_agent" &&
    routeCheckMdNonFin.ok && routeCheckMdNonFin.plan[routeCheckMdNonFin.plan.indexOf("data_dictionary_agent") + 1] === "missing_data_agent");
  await db.from("organizations").delete().eq("id", orgMd);

  console.log("== data privacy agent ==");
  ok("assess_data_privacy accepts good", validateProposal("assess_data_privacy", {
    pii_fields: [{ column_name: "customer_email", pii_type: "email", confidence: "high", example_pattern: "email format" }],
    sensitive_financial_fields: [{ column_name: "salary", sensitivity_type: "individual_compensation", notes: "n" }],
    risk_level: "high",
    compliance_concerns: ["GDPR exposure"],
    masking_recommendations: [{ column_name: "customer_email", technique: "hash", priority: "immediate" }],
  }).ok);
  ok("assess_data_privacy filters out field with bad pii_type", (() => {
    const r = validateProposal("assess_data_privacy", {
      pii_fields: [
        { column_name: "Good", pii_type: "email", confidence: "high", example_pattern: "p" },
        { column_name: "Bad", pii_type: "biometric", confidence: "high", example_pattern: "p" },
      ],
      sensitive_financial_fields: [], risk_level: "low", compliance_concerns: [], masking_recommendations: [],
    });
    return r.ok && (r.payload.pii_fields as unknown[]).length === 1;
  })());
  ok("assess_data_privacy rejects bad risk_level", !validateProposal("assess_data_privacy", {
    pii_fields: [], sensitive_financial_fields: [], risk_level: "severe",
    compliance_concerns: [], masking_recommendations: [],
  }).ok);
  ok("data_privacy_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("data_privacy_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentDp } = await import("./lib/run-agent");
  const { stubBrain: sbDp } = await import("./lib/agent-brain");
  const { approveAction: approveDp, listPending: listDp } = await import("./lib/actions-service");
  const orgDp = await makeOrg("pro");
  const payloadDp = await makePayload(orgDp);
  const rDp = await runAgentDp({ orgId: orgDp, payloadId: payloadDp, role: "data_privacy_agent" }, { db, brain: sbDp });
  ok("data_privacy_agent run produced an analysis", rDp.ok && rDp.proposalCount === 1);
  const pendDp = await listDp(orgDp, { db });
  ok("stub proposal passes validateProposal", pendDp.length === 1 && pendDp[0].kind === "assess_data_privacy");
  const apprDp = await approveDp(orgDp, pendDp[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes data_privacy_runs", apprDp.ok && apprDp.recordTable === "data_privacy_runs", JSON.stringify(apprDp));
  const { data: dpRows } = await db.from("data_privacy_runs").select("org_id,risk_level").eq("org_id", orgDp);
  ok("data privacy record org-stamped", dpRows?.length === 1 && dpRows[0].org_id === orgDp);
  const { data: dpAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgDp);
  ok("approveAction writes agent_accuracy for data_privacy_agent",
    dpAccRows?.length === 1 && dpAccRows[0].agent_role === "data_privacy_agent" && dpAccRows[0].approved_count === 1);
  const { routePayload: routeDp } = await import("./lib/manager");
  const routeCheckDpFin = await routeDp({ orgId: orgDp, payloadId: payloadDp }, { db, enqueue: () => {} });
  const { data: plainPayloadDp } = await db.from("inbound_payloads").insert({
    org_id: orgDp, source: "upload", storage_path: `${orgDp}/dp/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckDpNonFin = await routeDp({ orgId: orgDp, payloadId: plainPayloadDp!.id }, { db, enqueue: () => {} });
  ok("data_privacy_agent routes on BOTH the financial and non-financial route, immediately after growth_rate_agent",
    routeCheckDpFin.ok && routeCheckDpFin.plan[routeCheckDpFin.plan.indexOf("growth_rate_agent") + 1] === "data_privacy_agent" &&
    routeCheckDpNonFin.ok && routeCheckDpNonFin.plan[routeCheckDpNonFin.plan.indexOf("growth_rate_agent") + 1] === "data_privacy_agent");
  await db.from("organizations").delete().eq("id", orgDp);

  console.log("== transaction classifier ==");
  ok("classify_transactions accepts good", validateProposal("classify_transactions", {
    classified_transactions: [{ transaction_ref: "T001", description: "Customer payment", amount: 5000, date: "2024-01-15", category: "revenue", subcategory: "subscription", confidence: "high" }],
    category_summary: [{ category: "revenue", transaction_count: 1, total_amount: 5000, percentage_of_total: 100 }],
    total_transactions: 1, total_amount: 5000, classification_accuracy: "high", uncategorized_count: 0,
  }).ok);
  ok("classify_transactions filters out transaction with bad category", (() => {
    const r = validateProposal("classify_transactions", {
      classified_transactions: [
        { transaction_ref: "Good", description: "d", amount: 100, date: "2024-01-01", category: "revenue", subcategory: null, confidence: "high" },
        { transaction_ref: "Bad", description: "d", amount: 100, date: "2024-01-01", category: "bribery", subcategory: null, confidence: "high" },
      ],
      category_summary: [], total_transactions: 2, total_amount: 200, classification_accuracy: "high", uncategorized_count: 0,
    });
    return r.ok && (r.payload.classified_transactions as unknown[]).length === 1;
  })());
  ok("classify_transactions filters out transaction with bad confidence", (() => {
    const r = validateProposal("classify_transactions", {
      classified_transactions: [
        { transaction_ref: "Good", description: "d", amount: 100, date: "2024-01-01", category: "revenue", subcategory: null, confidence: "high" },
        { transaction_ref: "Bad", description: "d", amount: 100, date: "2024-01-01", category: "revenue", subcategory: null, confidence: "certain" },
      ],
      category_summary: [], total_transactions: 2, total_amount: 200, classification_accuracy: "high", uncategorized_count: 0,
    });
    return r.ok && (r.payload.classified_transactions as unknown[]).length === 1;
  })());
  ok("transaction_classifier → haiku model",
    (await import("./lib/agent-brain")).modelForRole("transaction_classifier") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentTc } = await import("./lib/run-agent");
  const { stubBrain: sbTc } = await import("./lib/agent-brain");
  const { approveAction: approveTc, listPending: listTc } = await import("./lib/actions-service");
  const orgTc = await makeOrg("pro");
  const payloadTc = await makePayload(orgTc);
  const rTc = await runAgentTc({ orgId: orgTc, payloadId: payloadTc, role: "transaction_classifier" }, { db, brain: sbTc });
  ok("transaction_classifier run produced an analysis", rTc.ok && rTc.proposalCount === 1);
  const pendTc = await listTc(orgTc, { db });
  ok("stub proposal passes validateProposal", pendTc.length === 1 && pendTc[0].kind === "classify_transactions");
  const apprTc = await approveTc(orgTc, pendTc[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes transaction_classifier_runs", apprTc.ok && apprTc.recordTable === "transaction_classifier_runs", JSON.stringify(apprTc));
  const { data: tcRows } = await db.from("transaction_classifier_runs").select("org_id,total_transactions").eq("org_id", orgTc);
  ok("transaction classifier record org-stamped", tcRows?.length === 1 && tcRows[0].org_id === orgTc);
  const { data: tcAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgTc);
  ok("approveAction writes agent_accuracy for transaction_classifier",
    tcAccRows?.length === 1 && tcAccRows[0].agent_role === "transaction_classifier" && tcAccRows[0].approved_count === 1);
  const { routePayload: routeTc } = await import("./lib/manager");
  const routeCheckTc = await routeTc({ orgId: orgTc, payloadId: payloadTc }, { db, enqueue: () => {} });
  ok("transaction_classifier routes on the financial route", routeCheckTc.ok && routeCheckTc.plan.includes("transaction_classifier"));
  await db.from("organizations").delete().eq("id", orgTc);

  console.log("== expense policy agent ==");
  ok("check_expense_policy accepts good", validateProposal("check_expense_policy", {
    violations: [{ expense_ref: "E001", submitter: "J. Smith", amount: 185, category: "meals", violation_type: "over_limit", policy_limit: 150, excess_amount: 35, severity: "medium" }],
    violation_count: 1, total_policy_exception_amount: 35, compliance_rate: 78.5,
    policy_summary: [{ category: "meals", total_spent: 850, budget_or_limit: null, utilization: null }],
    escalations: ["E001 needs approval"],
  }).ok);
  ok("check_expense_policy filters out violation with bad violation_type", (() => {
    const r = validateProposal("check_expense_policy", {
      violations: [
        { expense_ref: "Good", submitter: null, amount: 10, category: "misc", violation_type: "missing_receipt", policy_limit: null, excess_amount: null, severity: "low" },
        { expense_ref: "Bad", submitter: null, amount: 10, category: "misc", violation_type: "fraud", policy_limit: null, excess_amount: null, severity: "low" },
      ],
      violation_count: 2, total_policy_exception_amount: 0, compliance_rate: 90,
      policy_summary: [], escalations: [],
    });
    return r.ok && (r.payload.violations as unknown[]).length === 1;
  })());
  ok("check_expense_policy rejects compliance_rate > 100", !validateProposal("check_expense_policy", {
    violations: [], violation_count: 0, total_policy_exception_amount: 0, compliance_rate: 150,
    policy_summary: [], escalations: [],
  }).ok);
  ok("expense_policy_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("expense_policy_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentEp } = await import("./lib/run-agent");
  const { stubBrain: sbEp } = await import("./lib/agent-brain");
  const { approveAction: approveEp, listPending: listEp } = await import("./lib/actions-service");
  const orgEp = await makeOrg("pro");
  const payloadEp = await makePayload(orgEp);
  const rEp = await runAgentEp({ orgId: orgEp, payloadId: payloadEp, role: "expense_policy_agent" }, { db, brain: sbEp });
  ok("expense_policy_agent run produced an analysis", rEp.ok && rEp.proposalCount === 1);
  const pendEp = await listEp(orgEp, { db });
  ok("stub proposal passes validateProposal", pendEp.length === 1 && pendEp[0].kind === "check_expense_policy");
  const apprEp = await approveEp(orgEp, pendEp[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes expense_policy_runs", apprEp.ok && apprEp.recordTable === "expense_policy_runs", JSON.stringify(apprEp));
  const { data: epRows } = await db.from("expense_policy_runs").select("org_id,compliance_rate").eq("org_id", orgEp);
  ok("expense policy record org-stamped", epRows?.length === 1 && epRows[0].org_id === orgEp);
  const { data: epAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgEp);
  ok("approveAction writes agent_accuracy for expense_policy_agent",
    epAccRows?.length === 1 && epAccRows[0].agent_role === "expense_policy_agent" && epAccRows[0].approved_count === 1);
  const { routePayload: routeEp } = await import("./lib/manager");
  const routeCheckEp = await routeEp({ orgId: orgEp, payloadId: payloadEp }, { db, enqueue: () => {} });
  ok("expense_policy_agent routes on the financial route", routeCheckEp.ok && routeCheckEp.plan.includes("expense_policy_agent"));
  await db.from("organizations").delete().eq("id", orgEp);

  console.log("== subscription tracker ==");
  ok("track_subscriptions accepts good", validateProposal("track_subscriptions", {
    subscriptions: [{ subscription_id: "S001", customer_name: "Acme", plan: "Enterprise", mrr: 5000, arr: 60000, status: "active", start_date: "2023-06-01", renewal_date: "2024-06-01", movement: "unchanged" }],
    total_mrr: 5000, total_arr: 60000, new_mrr: 0, expansion_mrr: 0, contraction_mrr: 0, churned_mrr: 0,
    net_new_mrr: 0, subscription_count: 1, avg_subscription_value: 5000,
  }).ok);
  ok("track_subscriptions filters out subscription with bad status", (() => {
    const r = validateProposal("track_subscriptions", {
      subscriptions: [
        { subscription_id: "Good", customer_name: "A", plan: "Pro", mrr: 100, arr: 1200, status: "active", start_date: "2024-01-01", renewal_date: null, movement: "unchanged" },
        { subscription_id: "Bad", customer_name: "B", plan: "Pro", mrr: 100, arr: 1200, status: "expired", start_date: "2024-01-01", renewal_date: null, movement: "unchanged" },
      ],
      total_mrr: 200, total_arr: 2400, new_mrr: 0, expansion_mrr: 0, contraction_mrr: 0, churned_mrr: 0,
      net_new_mrr: 0, subscription_count: 2, avg_subscription_value: 100,
    });
    return r.ok && (r.payload.subscriptions as unknown[]).length === 1;
  })());
  ok("track_subscriptions filters out subscription with bad movement", (() => {
    const r = validateProposal("track_subscriptions", {
      subscriptions: [
        { subscription_id: "Good", customer_name: "A", plan: "Pro", mrr: 100, arr: 1200, status: "active", start_date: "2024-01-01", renewal_date: null, movement: "unchanged" },
        { subscription_id: "Bad", customer_name: "B", plan: "Pro", mrr: 100, arr: 1200, status: "active", start_date: "2024-01-01", renewal_date: null, movement: "downgrade" },
      ],
      total_mrr: 200, total_arr: 2400, new_mrr: 0, expansion_mrr: 0, contraction_mrr: 0, churned_mrr: 0,
      net_new_mrr: 0, subscription_count: 2, avg_subscription_value: 100,
    });
    return r.ok && (r.payload.subscriptions as unknown[]).length === 1;
  })());
  ok("subscription_tracker → haiku model",
    (await import("./lib/agent-brain")).modelForRole("subscription_tracker") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentSt } = await import("./lib/run-agent");
  const { stubBrain: sbSt } = await import("./lib/agent-brain");
  const { approveAction: approveSt, listPending: listSt } = await import("./lib/actions-service");
  const orgSt = await makeOrg("pro");
  const payloadSt = await makePayload(orgSt);
  const rSt = await runAgentSt({ orgId: orgSt, payloadId: payloadSt, role: "subscription_tracker" }, { db, brain: sbSt });
  ok("subscription_tracker run produced an analysis", rSt.ok && rSt.proposalCount === 1);
  const pendSt = await listSt(orgSt, { db });
  ok("stub proposal passes validateProposal", pendSt.length === 1 && pendSt[0].kind === "track_subscriptions");
  const apprSt = await approveSt(orgSt, pendSt[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes subscription_tracker_runs", apprSt.ok && apprSt.recordTable === "subscription_tracker_runs", JSON.stringify(apprSt));
  const { data: stRows } = await db.from("subscription_tracker_runs").select("org_id,total_mrr").eq("org_id", orgSt);
  ok("subscription tracker record org-stamped", stRows?.length === 1 && stRows[0].org_id === orgSt);
  const { data: stAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgSt);
  ok("approveAction writes agent_accuracy for subscription_tracker",
    stAccRows?.length === 1 && stAccRows[0].agent_role === "subscription_tracker" && stAccRows[0].approved_count === 1);
  const { routePayload: routeSt } = await import("./lib/manager");
  const routeCheckSt = await routeSt({ orgId: orgSt, payloadId: payloadSt }, { db, enqueue: () => {} });
  ok("subscription_tracker routes on the financial route", routeCheckSt.ok && routeCheckSt.plan.includes("subscription_tracker"));
  await db.from("organizations").delete().eq("id", orgSt);

  console.log("== headcount analytics agent ==");
  ok("analyze_headcount_analytics accepts good", validateProposal("analyze_headcount_analytics", {
    total_headcount: 47,
    headcount_by_department: [{ department: "Engineering", count: 18, percentage: 38.3 }],
    headcount_by_type: [{ employment_type: "full_time", count: 42, percentage: 89.4 }],
    new_hires: 4, terminations: 2, attrition_rate: 4.4, avg_tenure_months: 28.5,
    revenue_per_employee: 25532, cost_per_employee: 8500, open_positions: 3,
  }).ok);
  ok("analyze_headcount_analytics filters out entry with bad employment_type", (() => {
    const r = validateProposal("analyze_headcount_analytics", {
      total_headcount: 10,
      headcount_by_department: [],
      headcount_by_type: [
        { employment_type: "full_time", count: 8, percentage: 80 },
        { employment_type: "volunteer", count: 2, percentage: 20 },
      ],
      new_hires: 0, terminations: 0, attrition_rate: null, avg_tenure_months: null,
      revenue_per_employee: null, cost_per_employee: null, open_positions: 0,
    });
    return r.ok && (r.payload.headcount_by_type as unknown[]).length === 1;
  })());
  ok("analyze_headcount_analytics rejects attrition_rate > 100", !validateProposal("analyze_headcount_analytics", {
    total_headcount: 10, headcount_by_department: [], headcount_by_type: [],
    new_hires: 0, terminations: 0, attrition_rate: 150, avg_tenure_months: null,
    revenue_per_employee: null, cost_per_employee: null, open_positions: 0,
  }).ok);
  ok("headcount_analytics_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("headcount_analytics_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentHa } = await import("./lib/run-agent");
  const { stubBrain: sbHa } = await import("./lib/agent-brain");
  const { approveAction: approveHa, listPending: listHa } = await import("./lib/actions-service");
  const orgHa = await makeOrg("pro");
  const payloadHa = await makePayload(orgHa);
  const rHa = await runAgentHa({ orgId: orgHa, payloadId: payloadHa, role: "headcount_analytics_agent" }, { db, brain: sbHa });
  ok("headcount_analytics_agent run produced an analysis", rHa.ok && rHa.proposalCount === 1);
  const pendHa = await listHa(orgHa, { db });
  ok("stub proposal passes validateProposal", pendHa.length === 1 && pendHa[0].kind === "analyze_headcount_analytics");
  const apprHa = await approveHa(orgHa, pendHa[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes headcount_analytics_runs", apprHa.ok && apprHa.recordTable === "headcount_analytics_runs", JSON.stringify(apprHa));
  const { data: haRows } = await db.from("headcount_analytics_runs").select("org_id,total_headcount").eq("org_id", orgHa);
  ok("headcount analytics record org-stamped", haRows?.length === 1 && haRows[0].org_id === orgHa);
  const { data: haAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgHa);
  ok("approveAction writes agent_accuracy for headcount_analytics_agent",
    haAccRows?.length === 1 && haAccRows[0].agent_role === "headcount_analytics_agent" && haAccRows[0].approved_count === 1);
  const { routePayload: routeHa } = await import("./lib/manager");
  const routeCheckHaFin = await routeHa({ orgId: orgHa, payloadId: payloadHa }, { db, enqueue: () => {} });
  const { data: plainPayloadHa } = await db.from("inbound_payloads").insert({
    org_id: orgHa, source: "upload", storage_path: `${orgHa}/ha/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckHaNonFin = await routeHa({ orgId: orgHa, payloadId: plainPayloadHa!.id }, { db, enqueue: () => {} });
  ok("headcount_analytics_agent routes on BOTH the financial and non-financial route, immediately after missing_data_agent",
    routeCheckHaFin.ok && routeCheckHaFin.plan[routeCheckHaFin.plan.indexOf("missing_data_agent") + 1] === "headcount_analytics_agent" &&
    routeCheckHaNonFin.ok && routeCheckHaNonFin.plan[routeCheckHaNonFin.plan.indexOf("missing_data_agent") + 1] === "headcount_analytics_agent");
  await db.from("organizations").delete().eq("id", orgHa);

  console.log("== commission calculator ==");
  ok("calculate_commissions accepts good", validateProposal("calculate_commissions", {
    commissions: [{ rep_name: "Alex Johnson", quota: 150000, actual_sales: 165000, quota_attainment: 110.0, commission_rate: 9.6, commission_amount: 15840, accelerator_applied: true, notes: "accelerator" }],
    total_commission_payout: 15840, total_sales_value: 165000, effective_commission_rate: 9.6,
    quota_attainment_summary: { avg_attainment: 110, reps_at_100_plus: 1, reps_below_50: 0, top_performer: "Alex Johnson" },
    disputes: [],
  }).ok);
  ok("calculate_commissions filters out commission with empty rep_name", (() => {
    const r = validateProposal("calculate_commissions", {
      commissions: [
        { rep_name: "Good", quota: 100000, actual_sales: 100000, quota_attainment: 100, commission_rate: 8, commission_amount: 8000, accelerator_applied: false, notes: null },
        { rep_name: "", quota: 100000, actual_sales: 100000, quota_attainment: 100, commission_rate: 8, commission_amount: 8000, accelerator_applied: false, notes: null },
      ],
      total_commission_payout: 16000, total_sales_value: 200000, effective_commission_rate: 8,
      quota_attainment_summary: { avg_attainment: 100, reps_at_100_plus: 2, reps_below_50: 0, top_performer: "Good" },
      disputes: [],
    });
    return r.ok && (r.payload.commissions as unknown[]).length === 1;
  })());
  ok("calculate_commissions rejects effective_commission_rate > 100", !validateProposal("calculate_commissions", {
    commissions: [],
    total_commission_payout: 0, total_sales_value: 0, effective_commission_rate: 150,
    quota_attainment_summary: { avg_attainment: null, reps_at_100_plus: 0, reps_below_50: 0, top_performer: null },
    disputes: [],
  }).ok);
  ok("commission_calculator → haiku model",
    (await import("./lib/agent-brain")).modelForRole("commission_calculator") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentCom } = await import("./lib/run-agent");
  const { stubBrain: sbCom } = await import("./lib/agent-brain");
  const { approveAction: approveCom, listPending: listCom } = await import("./lib/actions-service");
  const orgCom = await makeOrg("pro");
  const payloadCom = await makePayload(orgCom);
  const rCom = await runAgentCom({ orgId: orgCom, payloadId: payloadCom, role: "commission_calculator" }, { db, brain: sbCom });
  ok("commission_calculator run produced an analysis", rCom.ok && rCom.proposalCount === 1);
  const pendCom = await listCom(orgCom, { db });
  ok("stub proposal passes validateProposal", pendCom.length === 1 && pendCom[0].kind === "calculate_commissions");
  const apprCom = await approveCom(orgCom, pendCom[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes commission_calculator_runs", apprCom.ok && apprCom.recordTable === "commission_calculator_runs", JSON.stringify(apprCom));
  const { data: comRows } = await db.from("commission_calculator_runs").select("org_id,total_commission_payout").eq("org_id", orgCom);
  ok("commission calculator record org-stamped", comRows?.length === 1 && comRows[0].org_id === orgCom);
  const { data: comAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgCom);
  ok("approveAction writes agent_accuracy for commission_calculator",
    comAccRows?.length === 1 && comAccRows[0].agent_role === "commission_calculator" && comAccRows[0].approved_count === 1);
  const { routePayload: routeCom } = await import("./lib/manager");
  const routeCheckCom = await routeCom({ orgId: orgCom, payloadId: payloadCom }, { db, enqueue: () => {} });
  ok("commission_calculator routes on the financial route", routeCheckCom.ok && routeCheckCom.plan.includes("commission_calculator"));
  await db.from("organizations").delete().eq("id", orgCom);

  console.log("== productivity agent ==");
  ok("analyze_productivity accepts good", validateProposal("analyze_productivity", {
    productivity_metrics: [{ metric_name: "Revenue per Employee", value: 25500, unit: "USD/month", period: "Jan 2024", benchmark: 22000, vs_benchmark: 3500, status: "above_benchmark" }],
    output_per_person: [{ department: "Support", metric: "tickets/day", value: 8.2, unit: "tickets" }],
    bottlenecks: ["ticket resolution slow"],
    benchmarks: [{ area: "Support", industry_standard: 10.0, unit: "tickets/agent/day", source: "industry estimate" }],
    improvement_recommendations: ["automate triage"],
    overall_productivity_score: 72,
  }).ok);
  ok("analyze_productivity filters out metric with bad status", (() => {
    const r = validateProposal("analyze_productivity", {
      productivity_metrics: [
        { metric_name: "Good", value: 1, unit: "u", period: "p", benchmark: null, vs_benchmark: null, status: "at_benchmark" },
        { metric_name: "Bad", value: 1, unit: "u", period: "p", benchmark: null, vs_benchmark: null, status: "unclear" },
      ],
      output_per_person: [], bottlenecks: [], benchmarks: [], improvement_recommendations: [], overall_productivity_score: null,
    });
    return r.ok && (r.payload.productivity_metrics as unknown[]).length === 1;
  })());
  ok("analyze_productivity rejects overall_productivity_score > 100", !validateProposal("analyze_productivity", {
    productivity_metrics: [], output_per_person: [], bottlenecks: [], benchmarks: [], improvement_recommendations: [],
    overall_productivity_score: 150,
  }).ok);
  ok("productivity_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("productivity_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentPdy } = await import("./lib/run-agent");
  const { stubBrain: sbPdy } = await import("./lib/agent-brain");
  const { approveAction: approvePdy, listPending: listPdy } = await import("./lib/actions-service");
  const orgPdy = await makeOrg("pro");
  const payloadPdy = await makePayload(orgPdy);
  const rPdy = await runAgentPdy({ orgId: orgPdy, payloadId: payloadPdy, role: "productivity_agent" }, { db, brain: sbPdy });
  ok("productivity_agent run produced an analysis", rPdy.ok && rPdy.proposalCount === 1);
  const pendPdy = await listPdy(orgPdy, { db });
  ok("stub proposal passes validateProposal", pendPdy.length === 1 && pendPdy[0].kind === "analyze_productivity");
  const apprPdy = await approvePdy(orgPdy, pendPdy[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes productivity_runs", apprPdy.ok && apprPdy.recordTable === "productivity_runs", JSON.stringify(apprPdy));
  const { data: pdyRows } = await db.from("productivity_runs").select("org_id,overall_productivity_score").eq("org_id", orgPdy);
  ok("productivity record org-stamped", pdyRows?.length === 1 && pdyRows[0].org_id === orgPdy);
  const { data: pdyAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgPdy);
  ok("approveAction writes agent_accuracy for productivity_agent",
    pdyAccRows?.length === 1 && pdyAccRows[0].agent_role === "productivity_agent" && pdyAccRows[0].approved_count === 1);
  const { routePayload: routePdy } = await import("./lib/manager");
  const routeCheckPdyFin = await routePdy({ orgId: orgPdy, payloadId: payloadPdy }, { db, enqueue: () => {} });
  const { data: plainPayloadPdy } = await db.from("inbound_payloads").insert({
    org_id: orgPdy, source: "upload", storage_path: `${orgPdy}/pdy/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckPdyNonFin = await routePdy({ orgId: orgPdy, payloadId: plainPayloadPdy!.id }, { db, enqueue: () => {} });
  ok("productivity_agent routes on BOTH the financial and non-financial route, immediately after headcount_analytics_agent",
    routeCheckPdyFin.ok && routeCheckPdyFin.plan[routeCheckPdyFin.plan.indexOf("headcount_analytics_agent") + 1] === "productivity_agent" &&
    routeCheckPdyNonFin.ok && routeCheckPdyNonFin.plan[routeCheckPdyNonFin.plan.indexOf("headcount_analytics_agent") + 1] === "productivity_agent");
  await db.from("organizations").delete().eq("id", orgPdy);

  console.log("== overtime analysis agent ==");
  ok("analyze_overtime accepts good", validateProposal("analyze_overtime", {
    overtime_records: [{ employee_ref: "EMP-042", department: "Engineering", period: "2024-W03", regular_hours: 40, overtime_hours: 12, overtime_cost: 540, consecutive_weeks_overtime: 5 }],
    total_overtime_hours: 12, total_overtime_cost: 540, overtime_rate: 23.1,
    departments_by_overtime: [{ department: "Engineering", total_ot_hours: 12, total_ot_cost: 540, employee_count: 1 }],
    chronic_overtime_employees: ["EMP-042"], risk_indicators: ["burnout risk"],
  }).ok);
  ok("analyze_overtime rejects negative total_overtime_hours", !validateProposal("analyze_overtime", {
    overtime_records: [], total_overtime_hours: -5, total_overtime_cost: 0, overtime_rate: null,
    departments_by_overtime: [], chronic_overtime_employees: [], risk_indicators: [],
  }).ok);
  ok("analyze_overtime accepts valid with no chronic employees", validateProposal("analyze_overtime", {
    overtime_records: [{ employee_ref: "EMP-001", department: "Sales", period: "2024-W03", regular_hours: 40, overtime_hours: 2, overtime_cost: 90, consecutive_weeks_overtime: 1 }],
    total_overtime_hours: 2, total_overtime_cost: 90, overtime_rate: 4.8,
    departments_by_overtime: [{ department: "Sales", total_ot_hours: 2, total_ot_cost: 90, employee_count: 1 }],
    chronic_overtime_employees: [], risk_indicators: [],
  }).ok);
  ok("overtime_analysis_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("overtime_analysis_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentOt } = await import("./lib/run-agent");
  const { stubBrain: sbOt } = await import("./lib/agent-brain");
  const { approveAction: approveOt, listPending: listOt } = await import("./lib/actions-service");
  const orgOt = await makeOrg("pro");
  const payloadOt = await makePayload(orgOt);
  const rOt = await runAgentOt({ orgId: orgOt, payloadId: payloadOt, role: "overtime_analysis_agent" }, { db, brain: sbOt });
  ok("overtime_analysis_agent run produced an analysis", rOt.ok && rOt.proposalCount === 1);
  const pendOt = await listOt(orgOt, { db });
  ok("stub proposal passes validateProposal", pendOt.length === 1 && pendOt[0].kind === "analyze_overtime");
  const apprOt = await approveOt(orgOt, pendOt[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes overtime_analysis_runs", apprOt.ok && apprOt.recordTable === "overtime_analysis_runs", JSON.stringify(apprOt));
  const { data: otRows } = await db.from("overtime_analysis_runs").select("org_id,total_overtime_hours").eq("org_id", orgOt);
  ok("overtime analysis record org-stamped", otRows?.length === 1 && otRows[0].org_id === orgOt);
  const { data: otAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgOt);
  ok("approveAction writes agent_accuracy for overtime_analysis_agent",
    otAccRows?.length === 1 && otAccRows[0].agent_role === "overtime_analysis_agent" && otAccRows[0].approved_count === 1);
  const { routePayload: routeOt } = await import("./lib/manager");
  const routeCheckOt = await routeOt({ orgId: orgOt, payloadId: payloadOt }, { db, enqueue: () => {} });
  ok("overtime_analysis_agent routes on the financial route", routeCheckOt.ok && routeCheckOt.plan.includes("overtime_analysis_agent"));
  await db.from("organizations").delete().eq("id", orgOt);

  console.log("== growth rate agent ==");
  ok("calculate_growth_rates accepts good", validateProposal("calculate_growth_rates", {
    growth_metrics: [{ metric_name: "Monthly Revenue", current_value: 125000, prior_value: 110000, period_over_period_growth: 13.6, yoy_growth: 42.0, unit: "USD" }],
    cagr: { value: 38.5, years: 2, basis: "Monthly Revenue" },
    growth_trajectory: "accelerating",
    projection_12m: 175000, projection_24m: 245000,
    growth_drivers: ["new customer acquisition"],
  }).ok);
  ok("calculate_growth_rates filters out metric with missing metric_name", (() => {
    const r = validateProposal("calculate_growth_rates", {
      growth_metrics: [
        { metric_name: "Good", current_value: 1, prior_value: 1, period_over_period_growth: 0, yoy_growth: 0, unit: "u" },
        { metric_name: "", current_value: 1, prior_value: 1, period_over_period_growth: 0, yoy_growth: 0, unit: "u" },
      ],
      cagr: { value: null, years: null, basis: "" },
      growth_trajectory: "steady",
      projection_12m: null, projection_24m: null,
      growth_drivers: [],
    });
    return r.ok && (r.payload.growth_metrics as unknown[]).length === 1;
  })());
  ok("calculate_growth_rates rejects bad growth_trajectory", !validateProposal("calculate_growth_rates", {
    growth_metrics: [],
    cagr: { value: null, years: null, basis: "" },
    growth_trajectory: "exploding",
    projection_12m: null, projection_24m: null,
    growth_drivers: [],
  }).ok);
  ok("growth_rate_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("growth_rate_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentGr } = await import("./lib/run-agent");
  const { stubBrain: sbGr } = await import("./lib/agent-brain");
  const { approveAction: approveGr, listPending: listGr } = await import("./lib/actions-service");
  const orgGr = await makeOrg("pro");
  const payloadGr = await makePayload(orgGr);
  const rGr = await runAgentGr({ orgId: orgGr, payloadId: payloadGr, role: "growth_rate_agent" }, { db, brain: sbGr });
  ok("growth_rate_agent run produced an analysis", rGr.ok && rGr.proposalCount === 1);
  const pendGr = await listGr(orgGr, { db });
  ok("stub proposal passes validateProposal", pendGr.length === 1 && pendGr[0].kind === "calculate_growth_rates");
  const apprGr = await approveGr(orgGr, pendGr[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes growth_rate_runs", apprGr.ok && apprGr.recordTable === "growth_rate_runs", JSON.stringify(apprGr));
  const { data: grRows } = await db.from("growth_rate_runs").select("org_id,growth_trajectory").eq("org_id", orgGr);
  ok("growth rate record org-stamped", grRows?.length === 1 && grRows[0].org_id === orgGr);
  const { data: grAccRows } = await db.from("agent_accuracy").select("agent_role,approved_count").eq("org_id", orgGr);
  ok("approveAction writes agent_accuracy for growth_rate_agent",
    grAccRows?.length === 1 && grAccRows[0].agent_role === "growth_rate_agent" && grAccRows[0].approved_count === 1);
  const { routePayload: routeGr } = await import("./lib/manager");
  const routeCheckGrFin = await routeGr({ orgId: orgGr, payloadId: payloadGr }, { db, enqueue: () => {} });
  const { data: plainPayloadGr } = await db.from("inbound_payloads").insert({
    org_id: orgGr, source: "upload", storage_path: `${orgGr}/gr/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckGrNonFin = await routeGr({ orgId: orgGr, payloadId: plainPayloadGr!.id }, { db, enqueue: () => {} });
  ok("growth_rate_agent routes on BOTH the financial and non-financial route, immediately after productivity_agent",
    routeCheckGrFin.ok && routeCheckGrFin.plan[routeCheckGrFin.plan.indexOf("productivity_agent") + 1] === "growth_rate_agent" &&
    routeCheckGrNonFin.ok && routeCheckGrNonFin.plan[routeCheckGrNonFin.plan.indexOf("productivity_agent") + 1] === "growth_rate_agent");
  await db.from("organizations").delete().eq("id", orgGr);

  console.log("== outlier explanation agent ==");
  ok("explain_outliers accepts good", validateProposal("explain_outliers", {
    outlier_count: 4, explained_count: 4,
    outliers: [{ column: "Revenue", value: 2850000, z_score: 3.4, explanation: "3.4 std devs above mean" }],
    summary: "Found 4 outliers.", data_period: "Q1 2024",
  }).ok);
  ok("explain_outliers rejects negative outlier_count", !validateProposal("explain_outliers", {
    outlier_count: -1, explained_count: 0, outliers: [], summary: "s", data_period: "p",
  }).ok);
  ok("explain_outliers filters out outlier with missing column", (() => {
    const r = validateProposal("explain_outliers", {
      outlier_count: 2, explained_count: 2,
      outliers: [
        { column: "Good", value: 1, z_score: 2.1, explanation: "explained" },
        { column: "", value: 1, z_score: 2.1, explanation: "explained" },
      ],
      summary: "s", data_period: "p",
    });
    return r.ok && (r.payload.outliers as unknown[]).length === 1;
  })());
  ok("explain_outliers rejects empty summary", !validateProposal("explain_outliers", {
    outlier_count: 0, explained_count: 0, outliers: [], summary: "", data_period: "p",
  }).ok);
  ok("outlier_explanation_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("outlier_explanation_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentOe } = await import("./lib/run-agent");
  const { stubBrain: sbOe } = await import("./lib/agent-brain");
  const { approveAction: approveOe, listPending: listOe } = await import("./lib/actions-service");
  const orgOe = await makeOrg("pro");
  const payloadOe = await makePayload(orgOe);
  const rOe = await runAgentOe({ orgId: orgOe, payloadId: payloadOe, role: "outlier_explanation_agent" }, { db, brain: sbOe });
  ok("outlier_explanation_agent run produced an analysis", rOe.ok && rOe.proposalCount === 1);
  const pendOe = await listOe(orgOe, { db });
  ok("stub proposal passes validateProposal and returns explain_outliers", pendOe.length === 1 && pendOe[0].kind === "explain_outliers");
  const apprOe = await approveOe(orgOe, pendOe[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes outlier_explanation_runs", apprOe.ok && apprOe.recordTable === "outlier_explanation_runs", JSON.stringify(apprOe));
  const { data: oeRows } = await db.from("outlier_explanation_runs").select("org_id,outlier_count").eq("org_id", orgOe);
  ok("outlier explanation record org-stamped", oeRows?.length === 1 && oeRows[0].org_id === orgOe);
  const { routePayload: routeOe } = await import("./lib/manager");
  const routeCheckOeFin = await routeOe({ orgId: orgOe, payloadId: payloadOe }, { db, enqueue: () => {} });
  const { data: plainPayloadOe } = await db.from("inbound_payloads").insert({
    org_id: orgOe, source: "upload", storage_path: `${orgOe}/oe/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckOeNonFin = await routeOe({ orgId: orgOe, payloadId: plainPayloadOe!.id }, { db, enqueue: () => {} });
  ok("outlier_explanation_agent routes on BOTH the financial and non-financial route",
    routeCheckOeFin.ok && routeCheckOeFin.plan.includes("outlier_explanation_agent") &&
    routeCheckOeNonFin.ok && routeCheckOeNonFin.plan.includes("outlier_explanation_agent"));
  await db.from("organizations").delete().eq("id", orgOe);

  console.log("== time series decomposition agent ==");
  ok("decompose_time_series accepts good", validateProposal("decompose_time_series", {
    trend_direction: "upward", trend_strength: 72.5, seasonality_detected: true, seasonality_period: "quarterly",
    cycle_length_periods: 4, residual_variance_pct: 18.3, data_points_analyzed: 24,
    components: [{ period: "2023-Q1", trend_value: 310000, seasonal_value: 15000, residual: -2000 }],
    data_period: "2022-2023",
  }).ok);
  ok("decompose_time_series rejects invalid trend_direction", !validateProposal("decompose_time_series", {
    trend_direction: "sideways", trend_strength: null, seasonality_detected: false, seasonality_period: null,
    cycle_length_periods: null, residual_variance_pct: null, data_points_analyzed: 0, components: [], data_period: "p",
  }).ok);
  ok("decompose_time_series rejects trend_strength > 100", !validateProposal("decompose_time_series", {
    trend_direction: "flat", trend_strength: 150, seasonality_detected: false, seasonality_period: null,
    cycle_length_periods: null, residual_variance_pct: null, data_points_analyzed: 0, components: [], data_period: "p",
  }).ok);
  ok("decompose_time_series filters out component with missing period", (() => {
    const r = validateProposal("decompose_time_series", {
      trend_direction: "flat", trend_strength: null, seasonality_detected: false, seasonality_period: null,
      cycle_length_periods: null, residual_variance_pct: null, data_points_analyzed: 2,
      components: [
        { period: "Q1", trend_value: 1, seasonal_value: 1, residual: 1 },
        { period: "", trend_value: 1, seasonal_value: 1, residual: 1 },
      ],
      data_period: "p",
    });
    return r.ok && (r.payload.components as unknown[]).length === 1;
  })());
  ok("time_series_decomp_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("time_series_decomp_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentTs } = await import("./lib/run-agent");
  const { stubBrain: sbTs } = await import("./lib/agent-brain");
  const { approveAction: approveTs, listPending: listTs } = await import("./lib/actions-service");
  const orgTs = await makeOrg("pro");
  const payloadTs = await makePayload(orgTs);
  const rTs = await runAgentTs({ orgId: orgTs, payloadId: payloadTs, role: "time_series_decomp_agent" }, { db, brain: sbTs });
  ok("time_series_decomp_agent run produced an analysis", rTs.ok && rTs.proposalCount === 1);
  const pendTs = await listTs(orgTs, { db });
  ok("stub proposal passes validateProposal and returns decompose_time_series", pendTs.length === 1 && pendTs[0].kind === "decompose_time_series");
  const apprTs = await approveTs(orgTs, pendTs[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes time_series_decomp_runs", apprTs.ok && apprTs.recordTable === "time_series_decomp_runs", JSON.stringify(apprTs));
  const { data: tsRows } = await db.from("time_series_decomp_runs").select("org_id,trend_direction").eq("org_id", orgTs);
  ok("time series decomp record org-stamped", tsRows?.length === 1 && tsRows[0].org_id === orgTs);
  const { routePayload: routeTs } = await import("./lib/manager");
  const routeCheckTsFin = await routeTs({ orgId: orgTs, payloadId: payloadTs }, { db, enqueue: () => {} });
  const { data: plainPayloadTs } = await db.from("inbound_payloads").insert({
    org_id: orgTs, source: "upload", storage_path: `${orgTs}/ts/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckTsNonFin = await routeTs({ orgId: orgTs, payloadId: plainPayloadTs!.id }, { db, enqueue: () => {} });
  ok("time_series_decomp_agent routes on BOTH the financial and non-financial route",
    routeCheckTsFin.ok && routeCheckTsFin.plan.includes("time_series_decomp_agent") &&
    routeCheckTsNonFin.ok && routeCheckTsNonFin.plan.includes("time_series_decomp_agent"));
  await db.from("organizations").delete().eq("id", orgTs);

  console.log("== failure risk agent ==");
  ok("assess_failure_risk accepts good", validateProposal("assess_failure_risk", {
    overall_risk_score: 38.0, risk_level: "medium",
    primary_risk_factors: [{ factor: "Current Ratio", severity: "medium", description: "below threshold" }],
    altman_z_score: 2.4, current_ratio: 1.2, debt_to_equity: 0.85, interest_coverage_ratio: 3.2,
    cash_runway_months: 14.0, data_period: "Q1 2024",
  }).ok);
  ok("assess_failure_risk rejects overall_risk_score > 100", !validateProposal("assess_failure_risk", {
    overall_risk_score: 150, risk_level: "critical", primary_risk_factors: [], altman_z_score: null,
    current_ratio: null, debt_to_equity: null, interest_coverage_ratio: null, cash_runway_months: null, data_period: "p",
  }).ok);
  ok("assess_failure_risk rejects invalid risk_level", !validateProposal("assess_failure_risk", {
    overall_risk_score: 50, risk_level: "extreme", primary_risk_factors: [], altman_z_score: null,
    current_ratio: null, debt_to_equity: null, interest_coverage_ratio: null, cash_runway_months: null, data_period: "p",
  }).ok);
  ok("assess_failure_risk filters out risk factor with missing factor", (() => {
    const r = validateProposal("assess_failure_risk", {
      overall_risk_score: 50, risk_level: "high",
      primary_risk_factors: [
        { factor: "Good", severity: "high", description: "d" },
        { factor: "", severity: "high", description: "d" },
      ],
      altman_z_score: null, current_ratio: null, debt_to_equity: null, interest_coverage_ratio: null,
      cash_runway_months: null, data_period: "p",
    });
    return r.ok && (r.payload.primary_risk_factors as unknown[]).length === 1;
  })());
  ok("failure_risk_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("failure_risk_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentFlr } = await import("./lib/run-agent");
  const { stubBrain: sbFlr } = await import("./lib/agent-brain");
  const { approveAction: approveFlr, listPending: listFlr } = await import("./lib/actions-service");
  const orgFlr = await makeOrg("pro");
  const payloadFlr = await makePayload(orgFlr);
  const rFlr = await runAgentFlr({ orgId: orgFlr, payloadId: payloadFlr, role: "failure_risk_agent" }, { db, brain: sbFlr });
  ok("failure_risk_agent run produced an analysis", rFlr.ok && rFlr.proposalCount === 1);
  const pendFlr = await listFlr(orgFlr, { db });
  ok("stub proposal passes validateProposal and returns assess_failure_risk", pendFlr.length === 1 && pendFlr[0].kind === "assess_failure_risk");
  const apprFlr = await approveFlr(orgFlr, pendFlr[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes failure_risk_runs", apprFlr.ok && apprFlr.recordTable === "failure_risk_runs", JSON.stringify(apprFlr));
  const { data: flrRows } = await db.from("failure_risk_runs").select("org_id,risk_level").eq("org_id", orgFlr);
  ok("failure risk record org-stamped", flrRows?.length === 1 && flrRows[0].org_id === orgFlr);
  const { routePayload: routeFlr } = await import("./lib/manager");
  const routeCheckFlrFin = await routeFlr({ orgId: orgFlr, payloadId: payloadFlr }, { db, enqueue: () => {} });
  const { data: plainPayloadFlr } = await db.from("inbound_payloads").insert({
    org_id: orgFlr, source: "upload", storage_path: `${orgFlr}/flr/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckFlrNonFin = await routeFlr({ orgId: orgFlr, payloadId: plainPayloadFlr!.id }, { db, enqueue: () => {} });
  ok("failure_risk_agent routes on BOTH the financial and non-financial route",
    routeCheckFlrFin.ok && routeCheckFlrFin.plan.includes("failure_risk_agent") &&
    routeCheckFlrNonFin.ok && routeCheckFlrNonFin.plan.includes("failure_risk_agent"));
  await db.from("organizations").delete().eq("id", orgFlr);

  console.log("== unit economics agent ==");
  ok("analyze_unit_economics accepts good", validateProposal("analyze_unit_economics", {
    ltv: 28500, cac: 7500, ltv_cac_ratio: 3.8, payback_period_months: 14.2, avg_contract_value: 12000,
    gross_margin_pct: 76.0, churn_rate_monthly: 1.8, magic_number: 0.92,
    by_channel: [{ channel: "Paid Search", cac: 9200, ltv: 32000, ltv_cac_ratio: 3.5 }],
    data_period: "Q1 2024",
  }).ok);
  ok("analyze_unit_economics rejects gross_margin_pct > 100", !validateProposal("analyze_unit_economics", {
    ltv: null, cac: null, ltv_cac_ratio: null, payback_period_months: null, avg_contract_value: null,
    gross_margin_pct: 150, churn_rate_monthly: null, magic_number: null, by_channel: [], data_period: "p",
  }).ok);
  ok("analyze_unit_economics rejects churn_rate_monthly > 100", !validateProposal("analyze_unit_economics", {
    ltv: null, cac: null, ltv_cac_ratio: null, payback_period_months: null, avg_contract_value: null,
    gross_margin_pct: null, churn_rate_monthly: 150, magic_number: null, by_channel: [], data_period: "p",
  }).ok);
  ok("analyze_unit_economics filters out by_channel item with negative cac", (() => {
    const r = validateProposal("analyze_unit_economics", {
      ltv: null, cac: null, ltv_cac_ratio: null, payback_period_months: null, avg_contract_value: null,
      gross_margin_pct: null, churn_rate_monthly: null, magic_number: null,
      by_channel: [
        { channel: "Good", cac: 100, ltv: 500, ltv_cac_ratio: 5 },
        { channel: "Bad", cac: -100, ltv: 500, ltv_cac_ratio: 5 },
      ],
      data_period: "p",
    });
    return r.ok && (r.payload.by_channel as unknown[]).length === 1;
  })());
  ok("unit_economics_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("unit_economics_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentUe } = await import("./lib/run-agent");
  const { stubBrain: sbUe } = await import("./lib/agent-brain");
  const { approveAction: approveUe, listPending: listUe } = await import("./lib/actions-service");
  const orgUe = await makeOrg("pro");
  const payloadUe = await makePayload(orgUe);
  const rUe = await runAgentUe({ orgId: orgUe, payloadId: payloadUe, role: "unit_economics_agent" }, { db, brain: sbUe });
  ok("unit_economics_agent run produced an analysis", rUe.ok && rUe.proposalCount === 1);
  const pendUe = await listUe(orgUe, { db });
  ok("stub proposal passes validateProposal and returns analyze_unit_economics", pendUe.length === 1 && pendUe[0].kind === "analyze_unit_economics");
  const apprUe = await approveUe(orgUe, pendUe[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes unit_economics_runs", apprUe.ok && apprUe.recordTable === "unit_economics_runs", JSON.stringify(apprUe));
  const { data: ueRows } = await db.from("unit_economics_runs").select("org_id,ltv_cac_ratio").eq("org_id", orgUe);
  ok("unit economics record org-stamped", ueRows?.length === 1 && ueRows[0].org_id === orgUe);
  const { routePayload: routeUe } = await import("./lib/manager");
  const routeCheckUe = await routeUe({ orgId: orgUe, payloadId: payloadUe }, { db, enqueue: () => {} });
  ok("unit_economics_agent routes on the financial route", routeCheckUe.ok && routeCheckUe.plan.includes("unit_economics_agent"));
  await db.from("organizations").delete().eq("id", orgUe);

  console.log("== valuation agent ==");
  ok("estimate_valuation accepts good", validateProposal("estimate_valuation", {
    arr: 4800000, arr_multiple: 8.5, ev_ebitda_multiple: null, dcf_value: null,
    comparable_low: 35000000, comparable_high: 55000000,
    estimated_valuation_low: 38000000, estimated_valuation_high: 52000000,
    primary_method: "arr_multiple", valuation_notes: "ARR multiple applied.", data_period: "Q1 2024",
  }).ok);
  ok("estimate_valuation rejects invalid primary_method", !validateProposal("estimate_valuation", {
    arr: null, arr_multiple: null, ev_ebitda_multiple: null, dcf_value: null,
    comparable_low: null, comparable_high: null, estimated_valuation_low: null, estimated_valuation_high: null,
    primary_method: "book_value", valuation_notes: "n", data_period: "p",
  }).ok);
  ok("estimate_valuation rejects estimated_valuation_high < estimated_valuation_low", !validateProposal("estimate_valuation", {
    arr: null, arr_multiple: null, ev_ebitda_multiple: null, dcf_value: null,
    comparable_low: null, comparable_high: null, estimated_valuation_low: 50000000, estimated_valuation_high: 30000000,
    primary_method: "dcf", valuation_notes: "n", data_period: "p",
  }).ok);
  ok("estimate_valuation rejects empty valuation_notes", !validateProposal("estimate_valuation", {
    arr: null, arr_multiple: null, ev_ebitda_multiple: null, dcf_value: null,
    comparable_low: null, comparable_high: null, estimated_valuation_low: null, estimated_valuation_high: null,
    primary_method: "dcf", valuation_notes: "", data_period: "p",
  }).ok);
  ok("valuation_agent → opus model",
    (await import("./lib/agent-brain")).modelForRole("valuation_agent") === "claude-opus-4-8");

  const { runAgent: runAgentVa2 } = await import("./lib/run-agent");
  const { stubBrain: sbVa2 } = await import("./lib/agent-brain");
  const { approveAction: approveVa2, listPending: listVa2 } = await import("./lib/actions-service");
  const orgVa2 = await makeOrg("pro");
  const payloadVa2 = await makePayload(orgVa2);
  const rVa2 = await runAgentVa2({ orgId: orgVa2, payloadId: payloadVa2, role: "valuation_agent" }, { db, brain: sbVa2 });
  ok("valuation_agent run produced an analysis", rVa2.ok && rVa2.proposalCount === 1);
  const pendVa2 = await listVa2(orgVa2, { db });
  ok("stub proposal passes validateProposal and returns estimate_valuation", pendVa2.length === 1 && pendVa2[0].kind === "estimate_valuation");
  const apprVa2 = await approveVa2(orgVa2, pendVa2[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes valuation_runs", apprVa2.ok && apprVa2.recordTable === "valuation_runs", JSON.stringify(apprVa2));
  const { data: va2Rows } = await db.from("valuation_runs").select("org_id,primary_method").eq("org_id", orgVa2);
  ok("valuation record org-stamped", va2Rows?.length === 1 && va2Rows[0].org_id === orgVa2);
  const { routePayload: routeVa2 } = await import("./lib/manager");
  const routeCheckVa2 = await routeVa2({ orgId: orgVa2, payloadId: payloadVa2 }, { db, enqueue: () => {} });
  ok("valuation_agent routes on the financial route", routeCheckVa2.ok && routeCheckVa2.plan.includes("valuation_agent"));
  await db.from("organizations").delete().eq("id", orgVa2);

  console.log("== cap table agent ==");
  ok("analyze_cap_table accepts good", validateProposal("analyze_cap_table", {
    total_shares_outstanding: 8500000, fully_diluted_shares: 10200000, option_pool_pct: 16.7,
    top_holder_concentration_pct: 28.4, founder_ownership_pct: 45.2, investor_ownership_pct: 38.1,
    employee_pool_pct: 16.7,
    holders: [{ name: "Founder A", shares: 3000000, ownership_pct: 29.4, holder_type: "founder" }],
    data_period: "Q1 2024",
  }).ok);
  ok("analyze_cap_table rejects option_pool_pct > 100", !validateProposal("analyze_cap_table", {
    total_shares_outstanding: 100, fully_diluted_shares: 100, option_pool_pct: 150,
    top_holder_concentration_pct: null, founder_ownership_pct: null, investor_ownership_pct: null,
    employee_pool_pct: null, holders: [], data_period: "p",
  }).ok);
  ok("analyze_cap_table rejects fully_diluted_shares < total_shares_outstanding", !validateProposal("analyze_cap_table", {
    total_shares_outstanding: 1000, fully_diluted_shares: 500, option_pool_pct: null,
    top_holder_concentration_pct: null, founder_ownership_pct: null, investor_ownership_pct: null,
    employee_pool_pct: null, holders: [], data_period: "p",
  }).ok);
  ok("analyze_cap_table filters out holder with ownership_pct > 100", (() => {
    const r = validateProposal("analyze_cap_table", {
      total_shares_outstanding: 1000, fully_diluted_shares: 1000, option_pool_pct: null,
      top_holder_concentration_pct: null, founder_ownership_pct: null, investor_ownership_pct: null,
      employee_pool_pct: null,
      holders: [
        { name: "Good", shares: 100, ownership_pct: 10, holder_type: "founder" },
        { name: "Bad", shares: 100, ownership_pct: 150, holder_type: "investor" },
      ],
      data_period: "p",
    });
    return r.ok && (r.payload.holders as unknown[]).length === 1;
  })());
  ok("cap_table_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("cap_table_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentCpt } = await import("./lib/run-agent");
  const { stubBrain: sbCpt } = await import("./lib/agent-brain");
  const { approveAction: approveCpt, listPending: listCpt } = await import("./lib/actions-service");
  const orgCpt = await makeOrg("pro");
  const payloadCpt = await makePayload(orgCpt);
  const rCpt = await runAgentCpt({ orgId: orgCpt, payloadId: payloadCpt, role: "cap_table_agent" }, { db, brain: sbCpt });
  ok("cap_table_agent run produced an analysis", rCpt.ok && rCpt.proposalCount === 1);
  const pendCpt = await listCpt(orgCpt, { db });
  ok("stub proposal passes validateProposal and returns analyze_cap_table", pendCpt.length === 1 && pendCpt[0].kind === "analyze_cap_table");
  const apprCpt = await approveCpt(orgCpt, pendCpt[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes cap_table_runs", apprCpt.ok && apprCpt.recordTable === "cap_table_runs", JSON.stringify(apprCpt));
  const { data: cptRows } = await db.from("cap_table_runs").select("org_id,fully_diluted_shares").eq("org_id", orgCpt);
  ok("cap table record org-stamped", cptRows?.length === 1 && cptRows[0].org_id === orgCpt);
  const { routePayload: routeCpt } = await import("./lib/manager");
  const routeCheckCpt = await routeCpt({ orgId: orgCpt, payloadId: payloadCpt }, { db, enqueue: () => {} });
  ok("cap_table_agent routes on the financial route", routeCheckCpt.ok && routeCheckCpt.plan.includes("cap_table_agent"));
  await db.from("organizations").delete().eq("id", orgCpt);

  console.log("== lease analysis agent ==");
  ok("analyze_leases accepts good", validateProposal("analyze_leases", {
    leases: [{ lease_id: "L001", description: "Main Office", lease_type: "operating", commencement_date: "2022-01-01", expiration_date: "2026-12-31", monthly_payment: 8500, remaining_payments: 48, present_value: 362000, right_of_use_asset: 362000, days_until_expiration: 1095, renewal_options: "2x3yr options" }],
    total_lease_liability: 362000, total_right_of_use_asset: 362000, annual_lease_expense: 102000,
    asc_842_classification_summary: { operating_count: 1, finance_count: 0, short_term_count: 0, unclassified_count: 0 },
    upcoming_expirations: [], optimization_opportunities: [],
  }).ok);
  ok("analyze_leases rejects negative total_lease_liability", !validateProposal("analyze_leases", {
    leases: [], total_lease_liability: -1, total_right_of_use_asset: 0, annual_lease_expense: 0,
    asc_842_classification_summary: { operating_count: 0, finance_count: 0, short_term_count: 0, unclassified_count: 0 },
    upcoming_expirations: [], optimization_opportunities: [],
  }).ok);
  ok("analyze_leases filters out lease with invalid lease_type", (() => {
    const r = validateProposal("analyze_leases", {
      leases: [
        { lease_id: "L001", description: "Good", lease_type: "operating", commencement_date: "2022-01-01", expiration_date: "2026-12-31", monthly_payment: 100, remaining_payments: 10, present_value: null, right_of_use_asset: null, days_until_expiration: null, renewal_options: null },
        { lease_id: "L002", description: "Bad", lease_type: "perpetual", commencement_date: "2022-01-01", expiration_date: "2026-12-31", monthly_payment: 100, remaining_payments: 10, present_value: null, right_of_use_asset: null, days_until_expiration: null, renewal_options: null },
      ],
      total_lease_liability: 0, total_right_of_use_asset: 0, annual_lease_expense: 0,
      asc_842_classification_summary: { operating_count: 1, finance_count: 0, short_term_count: 0, unclassified_count: 0 },
      upcoming_expirations: [], optimization_opportunities: [],
    });
    return r.ok && (r.payload.leases as unknown[]).length === 1;
  })());
  ok("analyze_leases filters out lease with negative monthly_payment", (() => {
    const r = validateProposal("analyze_leases", {
      leases: [
        { lease_id: "L001", description: "Good", lease_type: "operating", commencement_date: "2022-01-01", expiration_date: "2026-12-31", monthly_payment: 100, remaining_payments: 10, present_value: null, right_of_use_asset: null, days_until_expiration: null, renewal_options: null },
        { lease_id: "L002", description: "Bad", lease_type: "operating", commencement_date: "2022-01-01", expiration_date: "2026-12-31", monthly_payment: -100, remaining_payments: 10, present_value: null, right_of_use_asset: null, days_until_expiration: null, renewal_options: null },
      ],
      total_lease_liability: 0, total_right_of_use_asset: 0, annual_lease_expense: 0,
      asc_842_classification_summary: { operating_count: 1, finance_count: 0, short_term_count: 0, unclassified_count: 0 },
      upcoming_expirations: [], optimization_opportunities: [],
    });
    return r.ok && (r.payload.leases as unknown[]).length === 1;
  })());
  ok("lease_analysis_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("lease_analysis_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentLa } = await import("./lib/run-agent");
  const { stubBrain: sbLa } = await import("./lib/agent-brain");
  const { approveAction: approveLa, listPending: listLa } = await import("./lib/actions-service");
  const orgLa = await makeOrg("pro");
  const payloadLa = await makePayload(orgLa);
  const rLa = await runAgentLa({ orgId: orgLa, payloadId: payloadLa, role: "lease_analysis_agent" }, { db, brain: sbLa });
  ok("lease_analysis_agent run produced an analysis", rLa.ok && rLa.proposalCount === 1);
  const pendLa = await listLa(orgLa, { db });
  ok("stub proposal passes validateProposal and returns analyze_leases", pendLa.length === 1 && pendLa[0].kind === "analyze_leases");
  const apprLa = await approveLa(orgLa, pendLa[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes lease_analysis_runs", apprLa.ok && apprLa.recordTable === "lease_analysis_runs", JSON.stringify(apprLa));
  const { data: laRows } = await db.from("lease_analysis_runs").select("org_id,total_lease_liability").eq("org_id", orgLa);
  ok("lease analysis record org-stamped", laRows?.length === 1 && laRows[0].org_id === orgLa);
  const { routePayload: routeLa } = await import("./lib/manager");
  const routeCheckLa = await routeLa({ orgId: orgLa, payloadId: payloadLa }, { db, enqueue: () => {} });
  ok("lease_analysis_agent routes on the financial route", routeCheckLa.ok && routeCheckLa.plan.includes("lease_analysis_agent"));
  await db.from("organizations").delete().eq("id", orgLa);

  console.log("== asset register agent ==");
  ok("analyze_asset_register accepts good", validateProposal("analyze_asset_register", {
    assets: [{ asset_id: "A001", description: "Laptops", asset_class: "equipment", acquisition_date: "2021-03-15", acquisition_cost: 25000, useful_life_years: 4, depreciation_method: "straight_line", accumulated_depreciation: 18750, net_book_value: 6250, is_fully_depreciated: false, age_years: 2.8 }],
    total_gross_value: 25000, total_accumulated_depreciation: 18750, total_net_book_value: 6250,
    assets_fully_depreciated: 0, assets_near_end_of_life: 1, annual_depreciation_charge: 6250,
    asset_class_summary: [{ asset_class: "equipment", count: 1, gross_value: 25000, net_book_value: 6250 }],
    replacement_needs: [],
  }).ok);
  ok("analyze_asset_register filters out asset with invalid asset_class", (() => {
    const r = validateProposal("analyze_asset_register", {
      assets: [
        { asset_id: "A001", description: "Good", asset_class: "equipment", acquisition_date: "2021-01-01", acquisition_cost: 100, useful_life_years: 5, depreciation_method: "straight_line", accumulated_depreciation: 20, net_book_value: 80, is_fully_depreciated: false, age_years: 1 },
        { asset_id: "A002", description: "Bad", asset_class: "livestock", acquisition_date: "2021-01-01", acquisition_cost: 100, useful_life_years: 5, depreciation_method: "straight_line", accumulated_depreciation: 20, net_book_value: 80, is_fully_depreciated: false, age_years: 1 },
      ],
      total_gross_value: 0, total_accumulated_depreciation: 0, total_net_book_value: 0,
      assets_fully_depreciated: 0, assets_near_end_of_life: 0, annual_depreciation_charge: 0,
      asset_class_summary: [], replacement_needs: [],
    });
    return r.ok && (r.payload.assets as unknown[]).length === 1;
  })());
  ok("analyze_asset_register filters out asset with invalid depreciation_method", (() => {
    const r = validateProposal("analyze_asset_register", {
      assets: [
        { asset_id: "A001", description: "Good", asset_class: "equipment", acquisition_date: "2021-01-01", acquisition_cost: 100, useful_life_years: 5, depreciation_method: "straight_line", accumulated_depreciation: 20, net_book_value: 80, is_fully_depreciated: false, age_years: 1 },
        { asset_id: "A002", description: "Bad", asset_class: "equipment", acquisition_date: "2021-01-01", acquisition_cost: 100, useful_life_years: 5, depreciation_method: "sum_of_years", accumulated_depreciation: 20, net_book_value: 80, is_fully_depreciated: false, age_years: 1 },
      ],
      total_gross_value: 0, total_accumulated_depreciation: 0, total_net_book_value: 0,
      assets_fully_depreciated: 0, assets_near_end_of_life: 0, annual_depreciation_charge: 0,
      asset_class_summary: [], replacement_needs: [],
    });
    return r.ok && (r.payload.assets as unknown[]).length === 1;
  })());
  ok("analyze_asset_register rejects negative total_gross_value", !validateProposal("analyze_asset_register", {
    assets: [], total_gross_value: -1, total_accumulated_depreciation: 0, total_net_book_value: 0,
    assets_fully_depreciated: 0, assets_near_end_of_life: 0, annual_depreciation_charge: 0,
    asset_class_summary: [], replacement_needs: [],
  }).ok);
  ok("asset_register_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("asset_register_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentAr } = await import("./lib/run-agent");
  const { stubBrain: sbAr } = await import("./lib/agent-brain");
  const { approveAction: approveAr, listPending: listAr } = await import("./lib/actions-service");
  const orgAr = await makeOrg("pro");
  const payloadAr = await makePayload(orgAr);
  const rAr = await runAgentAr({ orgId: orgAr, payloadId: payloadAr, role: "asset_register_agent" }, { db, brain: sbAr });
  ok("asset_register_agent run produced an analysis", rAr.ok && rAr.proposalCount === 1);
  const pendAr = await listAr(orgAr, { db });
  ok("stub proposal passes validateProposal and returns analyze_asset_register", pendAr.length === 1 && pendAr[0].kind === "analyze_asset_register");
  const apprAr = await approveAr(orgAr, pendAr[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes asset_register_runs", apprAr.ok && apprAr.recordTable === "asset_register_runs", JSON.stringify(apprAr));
  const { data: arRows } = await db.from("asset_register_runs").select("org_id,total_gross_value").eq("org_id", orgAr);
  ok("asset register record org-stamped", arRows?.length === 1 && arRows[0].org_id === orgAr);
  const { routePayload: routeAr } = await import("./lib/manager");
  const routeCheckAr = await routeAr({ orgId: orgAr, payloadId: payloadAr }, { db, enqueue: () => {} });
  ok("asset_register_agent routes on the financial route", routeCheckAr.ok && routeCheckAr.plan.includes("asset_register_agent"));
  await db.from("organizations").delete().eq("id", orgAr);

  console.log("== price volume mix agent ==");
  ok("analyze_price_volume_mix accepts good", validateProposal("analyze_price_volume_mix", {
    total_revenue_change: 85000, price_effect: 32000, volume_effect: 45000, mix_effect: 8000,
    pvm_breakdown: [{ segment: "Pro Plan", prior_price: 2000, current_price: 2500, prior_volume: 40, current_volume: 48, price_effect: 20000, volume_effect: 16000, mix_effect: 2000, total_effect: 38000 }],
    primary_driver: "volume", insights: [],
  }).ok);
  ok("analyze_price_volume_mix rejects invalid primary_driver", !validateProposal("analyze_price_volume_mix", {
    total_revenue_change: 0, price_effect: 0, volume_effect: 0, mix_effect: 0,
    pvm_breakdown: [], primary_driver: "revenue", insights: [],
  }).ok);
  ok("analyze_price_volume_mix filters out breakdown item with missing segment", (() => {
    const r = validateProposal("analyze_price_volume_mix", {
      total_revenue_change: 0, price_effect: 0, volume_effect: 0, mix_effect: 0,
      pvm_breakdown: [
        { segment: "Good", prior_price: 1, current_price: 1, prior_volume: 1, current_volume: 1, price_effect: 0, volume_effect: 0, mix_effect: 0, total_effect: 0 },
        { segment: "", prior_price: 1, current_price: 1, prior_volume: 1, current_volume: 1, price_effect: 0, volume_effect: 0, mix_effect: 0, total_effect: 0 },
      ],
      primary_driver: "balanced", insights: [],
    });
    return r.ok && (r.payload.pvm_breakdown as unknown[]).length === 1;
  })());
  ok("analyze_price_volume_mix accepts valid with primary_driver balanced", validateProposal("analyze_price_volume_mix", {
    total_revenue_change: 0, price_effect: 0, volume_effect: 0, mix_effect: 0,
    pvm_breakdown: [], primary_driver: "balanced", insights: [],
  }).ok);
  ok("price_volume_mix_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("price_volume_mix_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentPv } = await import("./lib/run-agent");
  const { stubBrain: sbPv } = await import("./lib/agent-brain");
  const { approveAction: approvePv, listPending: listPv } = await import("./lib/actions-service");
  const orgPv = await makeOrg("pro");
  const payloadPv = await makePayload(orgPv);
  const rPv = await runAgentPv({ orgId: orgPv, payloadId: payloadPv, role: "price_volume_mix_agent" }, { db, brain: sbPv });
  ok("price_volume_mix_agent run produced an analysis", rPv.ok && rPv.proposalCount === 1);
  const pendPv = await listPv(orgPv, { db });
  ok("stub proposal passes validateProposal and returns analyze_price_volume_mix", pendPv.length === 1 && pendPv[0].kind === "analyze_price_volume_mix");
  const apprPv = await approvePv(orgPv, pendPv[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes price_volume_mix_runs", apprPv.ok && apprPv.recordTable === "price_volume_mix_runs", JSON.stringify(apprPv));
  const { data: pvRows } = await db.from("price_volume_mix_runs").select("org_id,primary_driver").eq("org_id", orgPv);
  ok("price volume mix record org-stamped", pvRows?.length === 1 && pvRows[0].org_id === orgPv);
  const { routePayload: routePv } = await import("./lib/manager");
  const routeCheckPv = await routePv({ orgId: orgPv, payloadId: payloadPv }, { db, enqueue: () => {} });
  ok("price_volume_mix_agent routes on the financial route", routeCheckPv.ok && routeCheckPv.plan.includes("price_volume_mix_agent"));
  await db.from("organizations").delete().eq("id", orgPv);

  console.log("== bridge analysis agent ==");
  ok("build_bridge_analysis accepts good", validateProposal("build_bridge_analysis", {
    bridge_type: "revenue", opening_value: 850000, closing_value: 1200000, total_change: 350000,
    bridge_steps: [
      { label: "Q1 2023", value: 850000, type: "subtotal", cumulative_value: 850000 },
      { label: "New Customers", value: 185000, type: "positive", cumulative_value: 1035000 },
      { label: "Q1 2024", value: 1200000, type: "total", cumulative_value: 1200000 },
    ],
    key_insights: [],
  }).ok);
  ok("build_bridge_analysis rejects invalid bridge_type", !validateProposal("build_bridge_analysis", {
    bridge_type: "equity", opening_value: 0, closing_value: 0, total_change: 0,
    bridge_steps: [
      { label: "A", value: 0, type: "subtotal", cumulative_value: 0 },
      { label: "B", value: 0, type: "total", cumulative_value: 0 },
    ],
    key_insights: [],
  }).ok);
  ok("build_bridge_analysis filters out step with invalid type", (() => {
    const r = validateProposal("build_bridge_analysis", {
      bridge_type: "revenue", opening_value: 0, closing_value: 0, total_change: 0,
      bridge_steps: [
        { label: "A", value: 0, type: "subtotal", cumulative_value: 0 },
        { label: "B", value: 0, type: "total", cumulative_value: 0 },
        { label: "C", value: 0, type: "sideways", cumulative_value: 0 },
      ],
      key_insights: [],
    });
    return r.ok && (r.payload.bridge_steps as unknown[]).length === 2;
  })());
  ok("build_bridge_analysis rejects when fewer than 2 steps remain after filtering", !validateProposal("build_bridge_analysis", {
    bridge_type: "revenue", opening_value: 0, closing_value: 0, total_change: 0,
    bridge_steps: [
      { label: "A", value: 0, type: "subtotal", cumulative_value: 0 },
      { label: "B", value: 0, type: "sideways", cumulative_value: 0 },
    ],
    key_insights: [],
  }).ok);
  ok("bridge_analysis_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("bridge_analysis_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentBrg } = await import("./lib/run-agent");
  const { stubBrain: sbBrg } = await import("./lib/agent-brain");
  const { approveAction: approveBrg, listPending: listBrg } = await import("./lib/actions-service");
  const orgBrg = await makeOrg("pro");
  const payloadBrg = await makePayload(orgBrg);
  const rBrg = await runAgentBrg({ orgId: orgBrg, payloadId: payloadBrg, role: "bridge_analysis_agent" }, { db, brain: sbBrg });
  ok("bridge_analysis_agent run produced an analysis", rBrg.ok && rBrg.proposalCount === 1);
  const pendBrg = await listBrg(orgBrg, { db });
  ok("stub proposal passes validateProposal and returns build_bridge_analysis", pendBrg.length === 1 && pendBrg[0].kind === "build_bridge_analysis");
  const apprBrg = await approveBrg(orgBrg, pendBrg[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes bridge_analysis_runs", apprBrg.ok && apprBrg.recordTable === "bridge_analysis_runs", JSON.stringify(apprBrg));
  const { data: brgRows } = await db.from("bridge_analysis_runs").select("org_id,bridge_type").eq("org_id", orgBrg);
  ok("bridge analysis record org-stamped", brgRows?.length === 1 && brgRows[0].org_id === orgBrg);
  const { routePayload: routeBrg } = await import("./lib/manager");
  const routeCheckBrg = await routeBrg({ orgId: orgBrg, payloadId: payloadBrg }, { db, enqueue: () => {} });
  ok("bridge_analysis_agent routes on the financial route", routeCheckBrg.ok && routeCheckBrg.plan.includes("bridge_analysis_agent"));
  await db.from("organizations").delete().eq("id", orgBrg);

  console.log("== run rate agent ==");
  ok("calculate_run_rate accepts good", validateProposal("calculate_run_rate", {
    current_period_value: 102000, annualization_method: "trailing_3m_annualized", annualized_run_rate: 1188000,
    adjusted_run_rate: 1140000, run_rate_adjustments: [{ description: "one-time fee", amount: -48000, type: "remove" }],
    months_of_data_used: 3, confidence: "medium", caveats: [],
  }).ok);
  ok("calculate_run_rate rejects invalid annualization_method", !validateProposal("calculate_run_rate", {
    current_period_value: 0, annualization_method: "daily_x365", annualized_run_rate: 0,
    adjusted_run_rate: null, run_rate_adjustments: [], months_of_data_used: 1, confidence: "low", caveats: [],
  }).ok);
  ok("calculate_run_rate rejects months_of_data_used < 1", !validateProposal("calculate_run_rate", {
    current_period_value: 0, annualization_method: "ttm", annualized_run_rate: 0,
    adjusted_run_rate: null, run_rate_adjustments: [], months_of_data_used: 0, confidence: "low", caveats: [],
  }).ok);
  ok("calculate_run_rate filters out adjustment with invalid type", (() => {
    const r = validateProposal("calculate_run_rate", {
      current_period_value: 0, annualization_method: "ttm", annualized_run_rate: 0, adjusted_run_rate: null,
      run_rate_adjustments: [
        { description: "Good", amount: 100, type: "add_back" },
        { description: "Bad", amount: 100, type: "adjust" },
      ],
      months_of_data_used: 1, confidence: "low", caveats: [],
    });
    return r.ok && (r.payload.run_rate_adjustments as unknown[]).length === 1;
  })());
  ok("run_rate_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("run_rate_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentRrt } = await import("./lib/run-agent");
  const { stubBrain: sbRrt } = await import("./lib/agent-brain");
  const { approveAction: approveRrt, listPending: listRrt } = await import("./lib/actions-service");
  const orgRrt = await makeOrg("pro");
  const payloadRrt = await makePayload(orgRrt);
  const rRrt = await runAgentRrt({ orgId: orgRrt, payloadId: payloadRrt, role: "run_rate_agent" }, { db, brain: sbRrt });
  ok("run_rate_agent run produced an analysis", rRrt.ok && rRrt.proposalCount === 1);
  const pendRrt = await listRrt(orgRrt, { db });
  ok("stub proposal passes validateProposal and returns calculate_run_rate", pendRrt.length === 1 && pendRrt[0].kind === "calculate_run_rate");
  const apprRrt = await approveRrt(orgRrt, pendRrt[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes run_rate_runs", apprRrt.ok && apprRrt.recordTable === "run_rate_runs", JSON.stringify(apprRrt));
  const { data: rrtRows } = await db.from("run_rate_runs").select("org_id,confidence").eq("org_id", orgRrt);
  ok("run rate record org-stamped", rrtRows?.length === 1 && rrtRows[0].org_id === orgRrt);
  const { routePayload: routeRrt } = await import("./lib/manager");
  const routeCheckRrtFin = await routeRrt({ orgId: orgRrt, payloadId: payloadRrt }, { db, enqueue: () => {} });
  const { data: plainPayloadRrt } = await db.from("inbound_payloads").insert({
    org_id: orgRrt, source: "upload", storage_path: `${orgRrt}/rrt/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckRrtNonFin = await routeRrt({ orgId: orgRrt, payloadId: plainPayloadRrt!.id }, { db, enqueue: () => {} });
  ok("run_rate_agent routes on BOTH the financial and non-financial route",
    routeCheckRrtFin.ok && routeCheckRrtFin.plan.includes("run_rate_agent") &&
    routeCheckRrtNonFin.ok && routeCheckRrtNonFin.plan.includes("run_rate_agent"));
  await db.from("organizations").delete().eq("id", orgRrt);

  console.log("== spend analysis agent ==");
  ok("analyze_spend accepts good", validateProposal("analyze_spend", {
    total_spend: 485000,
    spend_by_category: [{ category: "SaaS/Software", amount: 145000, percentage_of_total: 29.9, yoy_change: 35.0, status: "increasing" }],
    spend_by_vendor: [{ vendor_name: "AWS", amount: 38000, percentage_of_total: 7.8, transaction_count: 12, category: "SaaS/Software" }],
    spend_trends: [],
    top_opportunities: [{ opportunity: "Consolidate tools", estimated_savings: 18000, effort: "low", category: "SaaS/Software" }],
    potential_savings: 18000,
  }).ok);
  ok("analyze_spend rejects negative total_spend", !validateProposal("analyze_spend", {
    total_spend: -1, spend_by_category: [], spend_by_vendor: [], spend_trends: [], top_opportunities: [], potential_savings: null,
  }).ok);
  ok("analyze_spend filters out category with invalid status", (() => {
    const r = validateProposal("analyze_spend", {
      total_spend: 0,
      spend_by_category: [
        { category: "Good", amount: 1, percentage_of_total: 1, yoy_change: null, status: "stable" },
        { category: "Bad", amount: 1, percentage_of_total: 1, yoy_change: null, status: "exploding" },
      ],
      spend_by_vendor: [], spend_trends: [], top_opportunities: [], potential_savings: null,
    });
    return r.ok && (r.payload.spend_by_category as unknown[]).length === 1;
  })());
  ok("analyze_spend filters out top_opportunities item with invalid effort", (() => {
    const r = validateProposal("analyze_spend", {
      total_spend: 0, spend_by_category: [], spend_by_vendor: [], spend_trends: [],
      top_opportunities: [
        { opportunity: "Good", estimated_savings: 1, effort: "low", category: "c" },
        { opportunity: "Bad", estimated_savings: 1, effort: "extreme", category: "c" },
      ],
      potential_savings: null,
    });
    return r.ok && (r.payload.top_opportunities as unknown[]).length === 1;
  })());
  ok("spend_analysis_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("spend_analysis_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentSpa } = await import("./lib/run-agent");
  const { stubBrain: sbSpa } = await import("./lib/agent-brain");
  const { approveAction: approveSpa, listPending: listSpa } = await import("./lib/actions-service");
  const orgSpa = await makeOrg("pro");
  const payloadSpa = await makePayload(orgSpa);
  const rSpa = await runAgentSpa({ orgId: orgSpa, payloadId: payloadSpa, role: "spend_analysis_agent" }, { db, brain: sbSpa });
  ok("spend_analysis_agent run produced an analysis", rSpa.ok && rSpa.proposalCount === 1);
  const pendSpa = await listSpa(orgSpa, { db });
  ok("stub proposal passes validateProposal and returns analyze_spend", pendSpa.length === 1 && pendSpa[0].kind === "analyze_spend");
  const apprSpa = await approveSpa(orgSpa, pendSpa[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes spend_analysis_runs", apprSpa.ok && apprSpa.recordTable === "spend_analysis_runs", JSON.stringify(apprSpa));
  const { data: spaRows } = await db.from("spend_analysis_runs").select("org_id,total_spend").eq("org_id", orgSpa);
  ok("spend analysis record org-stamped", spaRows?.length === 1 && spaRows[0].org_id === orgSpa);
  const { routePayload: routeSpa } = await import("./lib/manager");
  const routeCheckSpaFin = await routeSpa({ orgId: orgSpa, payloadId: payloadSpa }, { db, enqueue: () => {} });
  const { data: plainPayloadSpa } = await db.from("inbound_payloads").insert({
    org_id: orgSpa, source: "upload", storage_path: `${orgSpa}/spa/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckSpaNonFin = await routeSpa({ orgId: orgSpa, payloadId: plainPayloadSpa!.id }, { db, enqueue: () => {} });
  ok("spend_analysis_agent routes on BOTH the financial and non-financial route",
    routeCheckSpaFin.ok && routeCheckSpaFin.plan.includes("spend_analysis_agent") &&
    routeCheckSpaNonFin.ok && routeCheckSpaNonFin.plan.includes("spend_analysis_agent"));
  await db.from("organizations").delete().eq("id", orgSpa);

  console.log("== discount analysis agent ==");
  ok("analyze_discounts accepts good", validateProposal("analyze_discounts", {
    discount_summary: [{ deal_ref: "D001", customer: "Acme", list_price: 50000, discounted_price: 32500, discount_amount: 17500, discount_percentage: 35.0, discount_reason: "competitive", approved_by: "VP Sales", is_excessive: true }],
    total_list_price: 50000, total_discounted_price: 32500, total_discount_amount: 17500, average_discount_percentage: 35.0,
    discount_by_segment: [{ segment: "Enterprise", avg_discount: 35.0, deal_count: 1 }],
    excessive_discounts: ["D001"], revenue_leakage: 5000, recommendations: [],
  }).ok);
  ok("analyze_discounts rejects average_discount_percentage > 100", !validateProposal("analyze_discounts", {
    discount_summary: [], total_list_price: 0, total_discounted_price: 0, total_discount_amount: 0,
    average_discount_percentage: 150, discount_by_segment: [], excessive_discounts: [], revenue_leakage: 0, recommendations: [],
  }).ok);
  ok("analyze_discounts filters out item with discount_percentage > 100", (() => {
    const r = validateProposal("analyze_discounts", {
      discount_summary: [
        { deal_ref: "D001", customer: null, list_price: 100, discounted_price: 80, discount_amount: 20, discount_percentage: 20, discount_reason: null, approved_by: null, is_excessive: false },
        { deal_ref: "D002", customer: null, list_price: 100, discounted_price: -50, discount_amount: 150, discount_percentage: 150, discount_reason: null, approved_by: null, is_excessive: true },
      ],
      total_list_price: 0, total_discounted_price: 0, total_discount_amount: 0, average_discount_percentage: 0,
      discount_by_segment: [], excessive_discounts: [], revenue_leakage: 0, recommendations: [],
    });
    return r.ok && (r.payload.discount_summary as unknown[]).length === 1;
  })());
  ok("analyze_discounts filters out item with missing deal_ref", (() => {
    const r = validateProposal("analyze_discounts", {
      discount_summary: [
        { deal_ref: "D001", customer: null, list_price: 100, discounted_price: 80, discount_amount: 20, discount_percentage: 20, discount_reason: null, approved_by: null, is_excessive: false },
        { deal_ref: "", customer: null, list_price: 100, discounted_price: 80, discount_amount: 20, discount_percentage: 20, discount_reason: null, approved_by: null, is_excessive: false },
      ],
      total_list_price: 0, total_discounted_price: 0, total_discount_amount: 0, average_discount_percentage: 0,
      discount_by_segment: [], excessive_discounts: [], revenue_leakage: 0, recommendations: [],
    });
    return r.ok && (r.payload.discount_summary as unknown[]).length === 1;
  })());
  ok("discount_analysis_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("discount_analysis_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentDa } = await import("./lib/run-agent");
  const { stubBrain: sbDa } = await import("./lib/agent-brain");
  const { approveAction: approveDa, listPending: listDa } = await import("./lib/actions-service");
  const orgDa = await makeOrg("pro");
  const payloadDa = await makePayload(orgDa);
  const rDa = await runAgentDa({ orgId: orgDa, payloadId: payloadDa, role: "discount_analysis_agent" }, { db, brain: sbDa });
  ok("discount_analysis_agent run produced an analysis", rDa.ok && rDa.proposalCount === 1);
  const pendDa = await listDa(orgDa, { db });
  ok("stub proposal passes validateProposal and returns analyze_discounts", pendDa.length === 1 && pendDa[0].kind === "analyze_discounts");
  const apprDa = await approveDa(orgDa, pendDa[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes discount_analysis_runs", apprDa.ok && apprDa.recordTable === "discount_analysis_runs", JSON.stringify(apprDa));
  const { data: daRows } = await db.from("discount_analysis_runs").select("org_id,total_list_price").eq("org_id", orgDa);
  ok("discount analysis record org-stamped", daRows?.length === 1 && daRows[0].org_id === orgDa);
  const { routePayload: routeDa } = await import("./lib/manager");
  const routeCheckDa = await routeDa({ orgId: orgDa, payloadId: payloadDa }, { db, enqueue: () => {} });
  ok("discount_analysis_agent routes on the financial route", routeCheckDa.ok && routeCheckDa.plan.includes("discount_analysis_agent"));
  await db.from("organizations").delete().eq("id", orgDa);

  console.log("== maverick spend agent ==");
  ok("detect_maverick_spend accepts good", validateProposal("detect_maverick_spend", {
    maverick_transactions: [{ transaction_ref: "M001", vendor: "Unknown Consulting", amount: 8500, category: "Professional Services", date: "2024-01-22", maverick_reason: "unapproved_vendor", severity: "high" }],
    total_maverick_amount: 8500, maverick_percentage: 8.7, total_spend_analyzed: 154000,
    categories_affected: [{ category: "Professional Services", maverick_amount: 8500, transaction_count: 1 }],
    root_causes: [], recommendations: [],
  }).ok);
  ok("detect_maverick_spend rejects maverick_percentage > 100", !validateProposal("detect_maverick_spend", {
    maverick_transactions: [], total_maverick_amount: 0, maverick_percentage: 150, total_spend_analyzed: 0,
    categories_affected: [], root_causes: [], recommendations: [],
  }).ok);
  ok("detect_maverick_spend filters out transaction with invalid maverick_reason", (() => {
    const r = validateProposal("detect_maverick_spend", {
      maverick_transactions: [
        { transaction_ref: "M001", vendor: "Good", amount: 1, category: "c", date: "d", maverick_reason: "unapproved_vendor", severity: "high" },
        { transaction_ref: "M002", vendor: "Bad", amount: 1, category: "c", date: "d", maverick_reason: "fraud", severity: "high" },
      ],
      total_maverick_amount: 0, maverick_percentage: 0, total_spend_analyzed: 0,
      categories_affected: [], root_causes: [], recommendations: [],
    });
    return r.ok && (r.payload.maverick_transactions as unknown[]).length === 1;
  })());
  ok("detect_maverick_spend filters out transaction with invalid severity", (() => {
    const r = validateProposal("detect_maverick_spend", {
      maverick_transactions: [
        { transaction_ref: "M001", vendor: "Good", amount: 1, category: "c", date: "d", maverick_reason: "unapproved_vendor", severity: "high" },
        { transaction_ref: "M002", vendor: "Bad", amount: 1, category: "c", date: "d", maverick_reason: "unapproved_vendor", severity: "extreme" },
      ],
      total_maverick_amount: 0, maverick_percentage: 0, total_spend_analyzed: 0,
      categories_affected: [], root_causes: [], recommendations: [],
    });
    return r.ok && (r.payload.maverick_transactions as unknown[]).length === 1;
  })());
  ok("maverick_spend_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("maverick_spend_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentMs } = await import("./lib/run-agent");
  const { stubBrain: sbMs } = await import("./lib/agent-brain");
  const { approveAction: approveMs, listPending: listMs } = await import("./lib/actions-service");
  const orgMs = await makeOrg("pro");
  const payloadMs = await makePayload(orgMs);
  const rMs = await runAgentMs({ orgId: orgMs, payloadId: payloadMs, role: "maverick_spend_agent" }, { db, brain: sbMs });
  ok("maverick_spend_agent run produced an analysis", rMs.ok && rMs.proposalCount === 1);
  const pendMs = await listMs(orgMs, { db });
  ok("stub proposal passes validateProposal and returns detect_maverick_spend", pendMs.length === 1 && pendMs[0].kind === "detect_maverick_spend");
  const apprMs = await approveMs(orgMs, pendMs[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes maverick_spend_runs", apprMs.ok && apprMs.recordTable === "maverick_spend_runs", JSON.stringify(apprMs));
  const { data: msRows } = await db.from("maverick_spend_runs").select("org_id,total_maverick_amount").eq("org_id", orgMs);
  ok("maverick spend record org-stamped", msRows?.length === 1 && msRows[0].org_id === orgMs);
  const { routePayload: routeMs } = await import("./lib/manager");
  const routeCheckMs = await routeMs({ orgId: orgMs, payloadId: payloadMs }, { db, enqueue: () => {} });
  ok("maverick_spend_agent routes on the financial route", routeCheckMs.ok && routeCheckMs.plan.includes("maverick_spend_agent"));
  await db.from("organizations").delete().eq("id", orgMs);

  console.log("== collections priority agent ==");
  ok("prioritize_collections accepts good", validateProposal("prioritize_collections", {
    accounts: [{ account_ref: "AR001", customer_name: "Acme", outstanding_amount: 28500, days_overdue: 95, invoice_count: 3, priority: "P1", recommended_action: "immediate_call", collectibility: "high" }],
    total_outstanding: 28500, total_overdue: 28500, priority_1_amount: 28500, priority_2_amount: 0, priority_3_amount: 0,
    collection_actions: [], estimated_collectible: 28000,
  }).ok);
  ok("prioritize_collections rejects negative total_outstanding", !validateProposal("prioritize_collections", {
    accounts: [], total_outstanding: -1, total_overdue: 0, priority_1_amount: 0, priority_2_amount: 0, priority_3_amount: 0,
    collection_actions: [], estimated_collectible: null,
  }).ok);
  ok("prioritize_collections filters out account with invalid priority", (() => {
    const r = validateProposal("prioritize_collections", {
      accounts: [
        { account_ref: "AR001", customer_name: null, outstanding_amount: 1, days_overdue: 1, invoice_count: 1, priority: "P1", recommended_action: "follow_up", collectibility: "high" },
        { account_ref: "AR002", customer_name: null, outstanding_amount: 1, days_overdue: 1, invoice_count: 1, priority: "P4", recommended_action: "follow_up", collectibility: "high" },
      ],
      total_outstanding: 0, total_overdue: 0, priority_1_amount: 0, priority_2_amount: 0, priority_3_amount: 0,
      collection_actions: [], estimated_collectible: null,
    });
    return r.ok && (r.payload.accounts as unknown[]).length === 1;
  })());
  ok("prioritize_collections filters out account with invalid recommended_action", (() => {
    const r = validateProposal("prioritize_collections", {
      accounts: [
        { account_ref: "AR001", customer_name: null, outstanding_amount: 1, days_overdue: 1, invoice_count: 1, priority: "P1", recommended_action: "follow_up", collectibility: "high" },
        { account_ref: "AR002", customer_name: null, outstanding_amount: 1, days_overdue: 1, invoice_count: 1, priority: "P1", recommended_action: "sue", collectibility: "high" },
      ],
      total_outstanding: 0, total_overdue: 0, priority_1_amount: 0, priority_2_amount: 0, priority_3_amount: 0,
      collection_actions: [], estimated_collectible: null,
    });
    return r.ok && (r.payload.accounts as unknown[]).length === 1;
  })());
  ok("collections_priority_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("collections_priority_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentCol } = await import("./lib/run-agent");
  const { stubBrain: sbCol } = await import("./lib/agent-brain");
  const { approveAction: approveCol, listPending: listCol } = await import("./lib/actions-service");
  const orgCol = await makeOrg("pro");
  const payloadCol = await makePayload(orgCol);
  const rCol = await runAgentCol({ orgId: orgCol, payloadId: payloadCol, role: "collections_priority_agent" }, { db, brain: sbCol });
  ok("collections_priority_agent run produced an analysis", rCol.ok && rCol.proposalCount === 1);
  const pendCol = await listCol(orgCol, { db });
  ok("stub proposal passes validateProposal and returns prioritize_collections", pendCol.length === 1 && pendCol[0].kind === "prioritize_collections");
  const apprCol = await approveCol(orgCol, pendCol[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes collections_priority_runs", apprCol.ok && apprCol.recordTable === "collections_priority_runs", JSON.stringify(apprCol));
  const { data: colRows } = await db.from("collections_priority_runs").select("org_id,total_outstanding").eq("org_id", orgCol);
  ok("collections priority record org-stamped", colRows?.length === 1 && colRows[0].org_id === orgCol);
  const { routePayload: routeCol } = await import("./lib/manager");
  const routeCheckCol = await routeCol({ orgId: orgCol, payloadId: payloadCol }, { db, enqueue: () => {} });
  ok("collections_priority_agent routes on the financial route", routeCheckCol.ok && routeCheckCol.plan.includes("collections_priority_agent"));
  await db.from("organizations").delete().eq("id", orgCol);

  console.log("== bad debt provision agent ==");
  ok("calculate_bad_debt_provision accepts good", validateProposal("calculate_bad_debt_provision", {
    total_receivables: 185000, current_provision: 8500, recommended_provision: 12750, provision_methodology: "aging_schedule",
    aging_analysis: [{ bucket: "current", amount: 95000, provision_rate: 0.5, provision_amount: 475 }],
    specific_provisions: [{ account_ref: "AR009", receivable_amount: 5000, provision_amount: 3000, reason: "Chapter 11" }],
    provision_adjustment: 4250, notes: "recommend increasing provision",
  }).ok);
  ok("calculate_bad_debt_provision rejects invalid provision_methodology", !validateProposal("calculate_bad_debt_provision", {
    total_receivables: 0, current_provision: null, recommended_provision: 0, provision_methodology: "write_off",
    aging_analysis: [], specific_provisions: [], provision_adjustment: 0, notes: "n",
  }).ok);
  ok("calculate_bad_debt_provision filters out aging item with invalid bucket", (() => {
    const r = validateProposal("calculate_bad_debt_provision", {
      total_receivables: 0, current_provision: null, recommended_provision: 0, provision_methodology: "aging_schedule",
      aging_analysis: [
        { bucket: "current", amount: 1, provision_rate: 1, provision_amount: 1 },
        { bucket: "150_plus", amount: 1, provision_rate: 1, provision_amount: 1 },
      ],
      specific_provisions: [], provision_adjustment: 0, notes: "n",
    });
    return r.ok && (r.payload.aging_analysis as unknown[]).length === 1;
  })());
  ok("calculate_bad_debt_provision rejects empty notes", !validateProposal("calculate_bad_debt_provision", {
    total_receivables: 0, current_provision: null, recommended_provision: 0, provision_methodology: "aging_schedule",
    aging_analysis: [], specific_provisions: [], provision_adjustment: 0, notes: "",
  }).ok);
  ok("bad_debt_provision_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("bad_debt_provision_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentBdp } = await import("./lib/run-agent");
  const { stubBrain: sbBdp } = await import("./lib/agent-brain");
  const { approveAction: approveBdp, listPending: listBdp } = await import("./lib/actions-service");
  const orgBdp = await makeOrg("pro");
  const payloadBdp = await makePayload(orgBdp);
  const rBdp = await runAgentBdp({ orgId: orgBdp, payloadId: payloadBdp, role: "bad_debt_provision_agent" }, { db, brain: sbBdp });
  ok("bad_debt_provision_agent run produced an analysis", rBdp.ok && rBdp.proposalCount === 1);
  const pendBdp = await listBdp(orgBdp, { db });
  ok("stub proposal passes validateProposal and returns calculate_bad_debt_provision", pendBdp.length === 1 && pendBdp[0].kind === "calculate_bad_debt_provision");
  const apprBdp = await approveBdp(orgBdp, pendBdp[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes bad_debt_provision_runs", apprBdp.ok && apprBdp.recordTable === "bad_debt_provision_runs", JSON.stringify(apprBdp));
  const { data: bdpRows } = await db.from("bad_debt_provision_runs").select("org_id,recommended_provision").eq("org_id", orgBdp);
  ok("bad debt provision record org-stamped", bdpRows?.length === 1 && bdpRows[0].org_id === orgBdp);
  const { routePayload: routeBdp } = await import("./lib/manager");
  const routeCheckBdp = await routeBdp({ orgId: orgBdp, payloadId: payloadBdp }, { db, enqueue: () => {} });
  ok("bad_debt_provision_agent routes on the financial route", routeCheckBdp.ok && routeCheckBdp.plan.includes("bad_debt_provision_agent"));
  await db.from("organizations").delete().eq("id", orgBdp);

  console.log("== credit scoring agent ==");
  ok("score_credit_risk accepts good", validateProposal("score_credit_risk", {
    customers: [{ customer_ref: "Acme Corp", credit_score: 82, risk_grade: "AA", payment_history_score: 90, financial_strength_score: 78, relationship_score: 75, current_exposure: 45000, recommended_credit_limit: 90000, key_risk_factors: [] }],
    portfolio_summary: { total_customers: 1, avg_credit_score: 82, high_risk_count: 0, medium_risk_count: 0, low_risk_count: 1, total_exposure: 45000 },
    high_risk_exposure: 0, recommended_credit_limits: [],
  }).ok);
  ok("score_credit_risk rejects negative high_risk_exposure", !validateProposal("score_credit_risk", {
    customers: [], portfolio_summary: { total_customers: 0, avg_credit_score: 0, high_risk_count: 0, medium_risk_count: 0, low_risk_count: 0, total_exposure: 0 },
    high_risk_exposure: -1, recommended_credit_limits: [],
  }).ok);
  ok("score_credit_risk filters out customer with invalid risk_grade", (() => {
    const r = validateProposal("score_credit_risk", {
      customers: [
        { customer_ref: "Good", credit_score: 80, risk_grade: "AA", payment_history_score: null, financial_strength_score: null, relationship_score: null, current_exposure: 0, recommended_credit_limit: null, key_risk_factors: [] },
        { customer_ref: "Bad", credit_score: 80, risk_grade: "ZZZ", payment_history_score: null, financial_strength_score: null, relationship_score: null, current_exposure: 0, recommended_credit_limit: null, key_risk_factors: [] },
      ],
      portfolio_summary: { total_customers: 2, avg_credit_score: 80, high_risk_count: 0, medium_risk_count: 0, low_risk_count: 2, total_exposure: 0 },
      high_risk_exposure: 0, recommended_credit_limits: [],
    });
    return r.ok && (r.payload.customers as unknown[]).length === 1;
  })());
  ok("score_credit_risk filters out customer with credit_score > 100", (() => {
    const r = validateProposal("score_credit_risk", {
      customers: [
        { customer_ref: "Good", credit_score: 80, risk_grade: "AA", payment_history_score: null, financial_strength_score: null, relationship_score: null, current_exposure: 0, recommended_credit_limit: null, key_risk_factors: [] },
        { customer_ref: "Bad", credit_score: 150, risk_grade: "AA", payment_history_score: null, financial_strength_score: null, relationship_score: null, current_exposure: 0, recommended_credit_limit: null, key_risk_factors: [] },
      ],
      portfolio_summary: { total_customers: 2, avg_credit_score: 80, high_risk_count: 0, medium_risk_count: 0, low_risk_count: 2, total_exposure: 0 },
      high_risk_exposure: 0, recommended_credit_limits: [],
    });
    return r.ok && (r.payload.customers as unknown[]).length === 1;
  })());
  ok("credit_scoring_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("credit_scoring_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentCrs } = await import("./lib/run-agent");
  const { stubBrain: sbCrs } = await import("./lib/agent-brain");
  const { approveAction: approveCrs, listPending: listCrs } = await import("./lib/actions-service");
  const orgCrs = await makeOrg("pro");
  const payloadCrs = await makePayload(orgCrs);
  const rCrs = await runAgentCrs({ orgId: orgCrs, payloadId: payloadCrs, role: "credit_scoring_agent" }, { db, brain: sbCrs });
  ok("credit_scoring_agent run produced an analysis", rCrs.ok && rCrs.proposalCount === 1);
  const pendCrs = await listCrs(orgCrs, { db });
  ok("stub proposal passes validateProposal and returns score_credit_risk", pendCrs.length === 1 && pendCrs[0].kind === "score_credit_risk");
  const apprCrs = await approveCrs(orgCrs, pendCrs[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes credit_scoring_runs", apprCrs.ok && apprCrs.recordTable === "credit_scoring_runs", JSON.stringify(apprCrs));
  const { data: crsRows } = await db.from("credit_scoring_runs").select("org_id,high_risk_exposure").eq("org_id", orgCrs);
  ok("credit scoring record org-stamped", crsRows?.length === 1 && crsRows[0].org_id === orgCrs);
  const { routePayload: routeCrs } = await import("./lib/manager");
  const routeCheckCrs = await routeCrs({ orgId: orgCrs, payloadId: payloadCrs }, { db, enqueue: () => {} });
  ok("credit_scoring_agent routes on the financial route", routeCheckCrs.ok && routeCheckCrs.plan.includes("credit_scoring_agent"));
  await db.from("organizations").delete().eq("id", orgCrs);

  console.log("== fx exposure agent ==");
  ok("analyze_fx_exposure accepts good", validateProposal("analyze_fx_exposure", {
    functional_currency: "USD",
    exposures: [{ currency: "EUR", exposure_type: "transaction", gross_amount: 180000, usd_equivalent: 196000, exposure_direction: "long", risk_level: "high" }],
    total_transaction_exposure: 196000, total_translation_exposure: 0, net_exposure_usd_equivalent: 196000,
    sensitivity_analysis: [{ scenario: "EUR weakens 10%", fx_move_percentage: -10, p_and_l_impact_usd: -19600 }],
    hedging_recommendations: [],
  }).ok);
  ok("analyze_fx_exposure rejects empty functional_currency", !validateProposal("analyze_fx_exposure", {
    functional_currency: "", exposures: [], total_transaction_exposure: 0, total_translation_exposure: 0,
    net_exposure_usd_equivalent: 0, sensitivity_analysis: [], hedging_recommendations: [],
  }).ok);
  ok("analyze_fx_exposure filters out exposure with invalid exposure_type", (() => {
    const r = validateProposal("analyze_fx_exposure", {
      functional_currency: "USD",
      exposures: [
        { currency: "EUR", exposure_type: "transaction", gross_amount: 1, usd_equivalent: 1, exposure_direction: "long", risk_level: "low" },
        { currency: "GBP", exposure_type: "operational", gross_amount: 1, usd_equivalent: 1, exposure_direction: "long", risk_level: "low" },
      ],
      total_transaction_exposure: 0, total_translation_exposure: 0, net_exposure_usd_equivalent: 0,
      sensitivity_analysis: [], hedging_recommendations: [],
    });
    return r.ok && (r.payload.exposures as unknown[]).length === 1;
  })());
  ok("analyze_fx_exposure filters out exposure with invalid exposure_direction", (() => {
    const r = validateProposal("analyze_fx_exposure", {
      functional_currency: "USD",
      exposures: [
        { currency: "EUR", exposure_type: "transaction", gross_amount: 1, usd_equivalent: 1, exposure_direction: "long", risk_level: "low" },
        { currency: "GBP", exposure_type: "transaction", gross_amount: 1, usd_equivalent: 1, exposure_direction: "flat", risk_level: "low" },
      ],
      total_transaction_exposure: 0, total_translation_exposure: 0, net_exposure_usd_equivalent: 0,
      sensitivity_analysis: [], hedging_recommendations: [],
    });
    return r.ok && (r.payload.exposures as unknown[]).length === 1;
  })());
  ok("fx_exposure_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("fx_exposure_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentFx } = await import("./lib/run-agent");
  const { stubBrain: sbFx } = await import("./lib/agent-brain");
  const { approveAction: approveFx, listPending: listFx } = await import("./lib/actions-service");
  const orgFx = await makeOrg("pro");
  const payloadFx = await makePayload(orgFx);
  const rFx = await runAgentFx({ orgId: orgFx, payloadId: payloadFx, role: "fx_exposure_agent" }, { db, brain: sbFx });
  ok("fx_exposure_agent run produced an analysis", rFx.ok && rFx.proposalCount === 1);
  const pendFx = await listFx(orgFx, { db });
  ok("stub proposal passes validateProposal and returns analyze_fx_exposure", pendFx.length === 1 && pendFx[0].kind === "analyze_fx_exposure");
  const apprFx = await approveFx(orgFx, pendFx[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes fx_exposure_runs", apprFx.ok && apprFx.recordTable === "fx_exposure_runs", JSON.stringify(apprFx));
  const { data: fxRows } = await db.from("fx_exposure_runs").select("org_id,functional_currency").eq("org_id", orgFx);
  ok("fx exposure record org-stamped", fxRows?.length === 1 && fxRows[0].org_id === orgFx);
  const { routePayload: routeFx } = await import("./lib/manager");
  const routeCheckFx = await routeFx({ orgId: orgFx, payloadId: payloadFx }, { db, enqueue: () => {} });
  ok("fx_exposure_agent routes on the financial route", routeCheckFx.ok && routeCheckFx.plan.includes("fx_exposure_agent"));
  await db.from("organizations").delete().eq("id", orgFx);

  console.log("== investor memo agent ==");
  ok("draft_investor_memo accepts good", validateProposal("draft_investor_memo", {
    memo_title: "Acme Seed Memo", business_overview: "Acme provides widgets.",
    financial_highlights: [{ metric: "ARR", value: "$1.2M", context: "57% YoY" }],
    key_metrics: [{ name: "MRR", value: "$100K", trend: "up" }],
    risks_and_mitigations: [{ risk: "Concentration", mitigation: "Diversify" }],
    investment_thesis: "Strong PMF and efficient unit economics.",
    ask: "Seeking $3M seed",
    use_of_proceeds: [{ category: "Sales", percentage: 40, description: "Scale outbound" }],
  }).ok);
  ok("draft_investor_memo rejects empty memo_title", !validateProposal("draft_investor_memo", {
    memo_title: "", business_overview: "x", financial_highlights: [], key_metrics: [], risks_and_mitigations: [],
    investment_thesis: "x", ask: "x", use_of_proceeds: [],
  }).ok);
  ok("draft_investor_memo rejects empty investment_thesis", !validateProposal("draft_investor_memo", {
    memo_title: "x", business_overview: "x", financial_highlights: [], key_metrics: [], risks_and_mitigations: [],
    investment_thesis: "", ask: "x", use_of_proceeds: [],
  }).ok);
  ok("draft_investor_memo filters out key_metrics item with invalid trend", (() => {
    const r = validateProposal("draft_investor_memo", {
      memo_title: "x", business_overview: "x", financial_highlights: [],
      key_metrics: [
        { name: "Good", value: "1", trend: "up" },
        { name: "Bad", value: "1", trend: "sideways" },
      ],
      risks_and_mitigations: [], investment_thesis: "x", ask: "x", use_of_proceeds: [],
    });
    return r.ok && (r.payload.key_metrics as unknown[]).length === 1;
  })());
  ok("investor_memo_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("investor_memo_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentIvm } = await import("./lib/run-agent");
  const { stubBrain: sbIvm } = await import("./lib/agent-brain");
  const { approveAction: approveIvm, listPending: listIvm } = await import("./lib/actions-service");
  const orgIvm = await makeOrg("pro");
  const payloadIvm = await makePayload(orgIvm);
  const rIvm = await runAgentIvm({ orgId: orgIvm, payloadId: payloadIvm, role: "investor_memo_agent" }, { db, brain: sbIvm });
  ok("investor_memo_agent run produced an analysis", rIvm.ok && rIvm.proposalCount === 1);
  const pendIvm = await listIvm(orgIvm, { db });
  ok("stub proposal passes validateProposal and returns draft_investor_memo", pendIvm.length === 1 && pendIvm[0].kind === "draft_investor_memo");
  const apprIvm = await approveIvm(orgIvm, pendIvm[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes investor_memo_runs", apprIvm.ok && apprIvm.recordTable === "investor_memo_runs", JSON.stringify(apprIvm));
  const { data: ivmRows } = await db.from("investor_memo_runs").select("org_id,memo_title").eq("org_id", orgIvm);
  ok("investor memo record org-stamped", ivmRows?.length === 1 && ivmRows[0].org_id === orgIvm);
  const { routePayload: routeIvm } = await import("./lib/manager");
  const routeCheckIvmFin = await routeIvm({ orgId: orgIvm, payloadId: payloadIvm }, { db, enqueue: () => {} });
  const { data: plainPayloadIvm } = await db.from("inbound_payloads").insert({
    org_id: orgIvm, source: "upload", storage_path: `${orgIvm}/ivm/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckIvmNonFin = await routeIvm({ orgId: orgIvm, payloadId: plainPayloadIvm!.id }, { db, enqueue: () => {} });
  ok("investor_memo_agent routes on BOTH the financial and non-financial route",
    routeCheckIvmFin.ok && routeCheckIvmFin.plan.includes("investor_memo_agent") &&
    routeCheckIvmNonFin.ok && routeCheckIvmNonFin.plan.includes("investor_memo_agent"));
  await db.from("organizations").delete().eq("id", orgIvm);

  console.log("== okr tracker agent ==");
  ok("track_okrs accepts good", validateProposal("track_okrs", {
    objectives: [{
      objective: "Reach $2M ARR", owner: "CEO",
      key_results: [{ kr: "Grow MRR to $167K", target: "$167K", current: "$102K", progress: 61.1, status: "at_risk" }],
      objective_status: "at_risk", objective_score: 57.2,
    }],
    overall_score: 57.2, on_track_count: 0, at_risk_count: 1, off_track_count: 0, key_blockers: [],
  }).ok);
  ok("track_okrs filters out objective with invalid objective_status", (() => {
    const r = validateProposal("track_okrs", {
      objectives: [
        { objective: "Good", owner: null, key_results: [], objective_status: "on_track", objective_score: null },
        { objective: "Bad", owner: null, key_results: [], objective_status: "unknown", objective_score: null },
      ],
      overall_score: null, on_track_count: 0, at_risk_count: 0, off_track_count: 0, key_blockers: [],
    });
    return r.ok && (r.payload.objectives as unknown[]).length === 1;
  })());
  ok("track_okrs filters out key_result with invalid status", (() => {
    const r = validateProposal("track_okrs", {
      objectives: [{
        objective: "Obj", owner: null,
        key_results: [
          { kr: "Good", target: "1", current: "1", progress: 50, status: "at_risk" },
          { kr: "Bad", target: "1", current: "1", progress: 50, status: "unknown" },
        ],
        objective_status: "at_risk", objective_score: null,
      }],
      overall_score: null, on_track_count: 0, at_risk_count: 1, off_track_count: 0, key_blockers: [],
    });
    return r.ok && ((r.payload.objectives as { key_results: unknown[] }[])[0].key_results.length === 1);
  })());
  ok("track_okrs rejects negative on_track_count", !validateProposal("track_okrs", {
    objectives: [], overall_score: null, on_track_count: -1, at_risk_count: 0, off_track_count: 0, key_blockers: [],
  }).ok);
  ok("okr_tracker_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("okr_tracker_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentOk } = await import("./lib/run-agent");
  const { stubBrain: sbOk } = await import("./lib/agent-brain");
  const { approveAction: approveOk, listPending: listOk } = await import("./lib/actions-service");
  const orgOk = await makeOrg("pro");
  const payloadOk = await makePayload(orgOk);
  const rOk = await runAgentOk({ orgId: orgOk, payloadId: payloadOk, role: "okr_tracker_agent" }, { db, brain: sbOk });
  ok("okr_tracker_agent run produced an analysis", rOk.ok && rOk.proposalCount === 1);
  const pendOk = await listOk(orgOk, { db });
  ok("stub proposal passes validateProposal and returns track_okrs", pendOk.length === 1 && pendOk[0].kind === "track_okrs");
  const apprOk = await approveOk(orgOk, pendOk[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes okr_tracker_runs", apprOk.ok && apprOk.recordTable === "okr_tracker_runs", JSON.stringify(apprOk));
  const { data: okRows } = await db.from("okr_tracker_runs").select("org_id,overall_score").eq("org_id", orgOk);
  ok("okr tracker record org-stamped", okRows?.length === 1 && okRows[0].org_id === orgOk);
  const { routePayload: routeOk } = await import("./lib/manager");
  const routeCheckOkFin = await routeOk({ orgId: orgOk, payloadId: payloadOk }, { db, enqueue: () => {} });
  const { data: plainPayloadOk } = await db.from("inbound_payloads").insert({
    org_id: orgOk, source: "upload", storage_path: `${orgOk}/ok/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckOkNonFin = await routeOk({ orgId: orgOk, payloadId: plainPayloadOk!.id }, { db, enqueue: () => {} });
  ok("okr_tracker_agent routes on BOTH the financial and non-financial route",
    routeCheckOkFin.ok && routeCheckOkFin.plan.includes("okr_tracker_agent") &&
    routeCheckOkNonFin.ok && routeCheckOkNonFin.plan.includes("okr_tracker_agent"));
  await db.from("organizations").delete().eq("id", orgOk);

  console.log("== swot agent ==");
  ok("conduct_swot accepts good", validateProposal("conduct_swot", {
    strengths: [{ point: "Strong unit economics", evidence: "7x LTV:CAC", impact: "high" }],
    weaknesses: [{ point: "Customer concentration", evidence: "top 2 = 42%", urgency: "high" }],
    opportunities: [{ point: "Mid-market expansion", rationale: "adjacent segment", timeframe: "near_term" }],
    threats: [{ point: "Well-funded competitor", likelihood: "medium", potential_impact: "high" }],
    strategic_priorities: [{ priority: "Invest in mid-market sales", type: "SO", rationale: "leverage margins" }],
    overall_assessment: "Strong but concentrated.",
  }).ok);
  ok("conduct_swot rejects empty overall_assessment", !validateProposal("conduct_swot", {
    strengths: [], weaknesses: [], opportunities: [], threats: [], strategic_priorities: [], overall_assessment: "",
  }).ok);
  ok("conduct_swot filters out strengths item with invalid impact", (() => {
    const r = validateProposal("conduct_swot", {
      strengths: [
        { point: "Good", evidence: "e", impact: "high" },
        { point: "Bad", evidence: "e", impact: "extreme" },
      ],
      weaknesses: [], opportunities: [], threats: [], strategic_priorities: [], overall_assessment: "x",
    });
    return r.ok && (r.payload.strengths as unknown[]).length === 1;
  })());
  ok("conduct_swot filters out strategic_priorities item with invalid type", (() => {
    const r = validateProposal("conduct_swot", {
      strengths: [], weaknesses: [], opportunities: [], threats: [],
      strategic_priorities: [
        { priority: "Good", type: "SO", rationale: "r" },
        { priority: "Bad", type: "XX", rationale: "r" },
      ],
      overall_assessment: "x",
    });
    return r.ok && (r.payload.strategic_priorities as unknown[]).length === 1;
  })());
  ok("swot_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("swot_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentSw } = await import("./lib/run-agent");
  const { stubBrain: sbSw } = await import("./lib/agent-brain");
  const { approveAction: approveSw, listPending: listSw } = await import("./lib/actions-service");
  const orgSw = await makeOrg("pro");
  const payloadSw = await makePayload(orgSw);
  const rSw = await runAgentSw({ orgId: orgSw, payloadId: payloadSw, role: "swot_agent" }, { db, brain: sbSw });
  ok("swot_agent run produced an analysis", rSw.ok && rSw.proposalCount === 1);
  const pendSw = await listSw(orgSw, { db });
  ok("stub proposal passes validateProposal and returns conduct_swot", pendSw.length === 1 && pendSw[0].kind === "conduct_swot");
  const apprSw = await approveSw(orgSw, pendSw[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes swot_runs", apprSw.ok && apprSw.recordTable === "swot_runs", JSON.stringify(apprSw));
  const { data: swRows } = await db.from("swot_runs").select("org_id,overall_assessment").eq("org_id", orgSw);
  ok("swot record org-stamped", swRows?.length === 1 && swRows[0].org_id === orgSw);
  const { routePayload: routeSw } = await import("./lib/manager");
  const routeCheckSwFin = await routeSw({ orgId: orgSw, payloadId: payloadSw }, { db, enqueue: () => {} });
  const { data: plainPayloadSw } = await db.from("inbound_payloads").insert({
    org_id: orgSw, source: "upload", storage_path: `${orgSw}/sw/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckSwNonFin = await routeSw({ orgId: orgSw, payloadId: plainPayloadSw!.id }, { db, enqueue: () => {} });
  ok("swot_agent routes on BOTH the financial and non-financial route",
    routeCheckSwFin.ok && routeCheckSwFin.plan.includes("swot_agent") &&
    routeCheckSwNonFin.ok && routeCheckSwNonFin.plan.includes("swot_agent"));
  await db.from("organizations").delete().eq("id", orgSw);

  console.log("== query builder agent ==");
  ok("build_queries accepts good", validateProposal("build_queries", {
    detected_schema: [{ table_or_sheet: "transactions", columns: ["date", "amount"] }],
    suggested_queries: [
      { title: "Q1", description: "d", query_type: "aggregation", pseudo_sql: "SELECT 1", business_value: "v" },
      { title: "Q2", description: "d", query_type: "time_series", pseudo_sql: "SELECT 2", business_value: "v" },
      { title: "Q3", description: "d", query_type: "ranking", pseudo_sql: "SELECT 3", business_value: "v" },
    ],
    natural_language_questions: [
      { question: "Q1?", answer_type: "number" },
      { question: "Q2?", answer_type: "table" },
      { question: "Q3?", answer_type: "chart" },
    ],
  }).ok);
  ok("build_queries filters out suggested_queries item with invalid query_type", (() => {
    const r = validateProposal("build_queries", {
      detected_schema: [],
      suggested_queries: [
        { title: "Q1", description: "d", query_type: "aggregation", pseudo_sql: "SELECT 1", business_value: "v" },
        { title: "Q2", description: "d", query_type: "time_series", pseudo_sql: "SELECT 2", business_value: "v" },
        { title: "Q3", description: "d", query_type: "ranking", pseudo_sql: "SELECT 3", business_value: "v" },
        { title: "Bad", description: "d", query_type: "sorcery", pseudo_sql: "SELECT 4", business_value: "v" },
      ],
      natural_language_questions: [
        { question: "Q1?", answer_type: "number" },
        { question: "Q2?", answer_type: "table" },
        { question: "Q3?", answer_type: "chart" },
      ],
    });
    return r.ok && (r.payload.suggested_queries as unknown[]).length === 3;
  })());
  ok("build_queries rejects fewer than 3 valid suggested_queries after filtering", !validateProposal("build_queries", {
    detected_schema: [],
    suggested_queries: [
      { title: "Q1", description: "d", query_type: "aggregation", pseudo_sql: "SELECT 1", business_value: "v" },
      { title: "Bad", description: "d", query_type: "sorcery", pseudo_sql: "SELECT 2", business_value: "v" },
    ],
    natural_language_questions: [
      { question: "Q1?", answer_type: "number" },
      { question: "Q2?", answer_type: "table" },
      { question: "Q3?", answer_type: "chart" },
    ],
  }).ok);
  ok("build_queries filters out natural_language_questions item with invalid answer_type", (() => {
    const r = validateProposal("build_queries", {
      detected_schema: [],
      suggested_queries: [
        { title: "Q1", description: "d", query_type: "aggregation", pseudo_sql: "SELECT 1", business_value: "v" },
        { title: "Q2", description: "d", query_type: "time_series", pseudo_sql: "SELECT 2", business_value: "v" },
        { title: "Q3", description: "d", query_type: "ranking", pseudo_sql: "SELECT 3", business_value: "v" },
      ],
      natural_language_questions: [
        { question: "Q1?", answer_type: "number" },
        { question: "Q2?", answer_type: "table" },
        { question: "Q3?", answer_type: "chart" },
        { question: "Bad?", answer_type: "essay" },
      ],
    });
    return r.ok && (r.payload.natural_language_questions as unknown[]).length === 3;
  })());
  ok("query_builder_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("query_builder_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentQb } = await import("./lib/run-agent");
  const { stubBrain: sbQb } = await import("./lib/agent-brain");
  const { approveAction: approveQb, listPending: listQb } = await import("./lib/actions-service");
  const orgQb = await makeOrg("pro");
  const payloadQb = await makePayload(orgQb);
  const rQb = await runAgentQb({ orgId: orgQb, payloadId: payloadQb, role: "query_builder_agent" }, { db, brain: sbQb });
  ok("query_builder_agent run produced an analysis", rQb.ok && rQb.proposalCount === 1);
  const pendQb = await listQb(orgQb, { db });
  ok("stub proposal passes validateProposal and returns build_queries", pendQb.length === 1 && pendQb[0].kind === "build_queries");
  const apprQb = await approveQb(orgQb, pendQb[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes query_builder_runs", apprQb.ok && apprQb.recordTable === "query_builder_runs", JSON.stringify(apprQb));
  const { data: qbRows } = await db.from("query_builder_runs").select("org_id,detected_schema").eq("org_id", orgQb);
  ok("query builder record org-stamped", qbRows?.length === 1 && qbRows[0].org_id === orgQb);
  const { routePayload: routeQb } = await import("./lib/manager");
  const routeCheckQbFin = await routeQb({ orgId: orgQb, payloadId: payloadQb }, { db, enqueue: () => {} });
  const { data: plainPayloadQb } = await db.from("inbound_payloads").insert({
    org_id: orgQb, source: "upload", storage_path: `${orgQb}/qb/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckQbNonFin = await routeQb({ orgId: orgQb, payloadId: plainPayloadQb!.id }, { db, enqueue: () => {} });
  ok("query_builder_agent routes on BOTH the financial and non-financial route",
    routeCheckQbFin.ok && routeCheckQbFin.plan.includes("query_builder_agent") &&
    routeCheckQbNonFin.ok && routeCheckQbNonFin.plan.includes("query_builder_agent"));
  await db.from("organizations").delete().eq("id", orgQb);

  console.log("== esg reporting agent ==");
  ok("generate_esg_report accepts good", validateProposal("generate_esg_report", {
    environmental_metrics: [{ metric_name: "Scope 1", value: null, unit: "tCO2e", status: "not_measured" }],
    social_metrics: [{ metric_name: "Headcount", value: "47", unit: "count", status: "measured" }],
    governance_metrics: [{ metric_name: "Board Size", value: "5", unit: "members", status: "measured" }],
    esg_score: 38, key_highlights: [], gaps_and_recommendations: [], reporting_framework: "GRI",
  }).ok);
  ok("generate_esg_report rejects invalid reporting_framework", !validateProposal("generate_esg_report", {
    environmental_metrics: [], social_metrics: [], governance_metrics: [], esg_score: null,
    key_highlights: [], gaps_and_recommendations: [], reporting_framework: "CDP",
  }).ok);
  ok("generate_esg_report rejects esg_score > 100", !validateProposal("generate_esg_report", {
    environmental_metrics: [], social_metrics: [], governance_metrics: [], esg_score: 150,
    key_highlights: [], gaps_and_recommendations: [], reporting_framework: "GRI",
  }).ok);
  ok("generate_esg_report filters out environmental_metrics item with invalid status", (() => {
    const r = validateProposal("generate_esg_report", {
      environmental_metrics: [
        { metric_name: "Good", value: "1", unit: "u", status: "measured" },
        { metric_name: "Bad", value: "1", unit: "u", status: "unknown_status" },
      ],
      social_metrics: [], governance_metrics: [], esg_score: null,
      key_highlights: [], gaps_and_recommendations: [], reporting_framework: "GRI",
    });
    return r.ok && (r.payload.environmental_metrics as unknown[]).length === 1;
  })());
  ok("esg_reporting_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("esg_reporting_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentEsg } = await import("./lib/run-agent");
  const { stubBrain: sbEsg } = await import("./lib/agent-brain");
  const { approveAction: approveEsg, listPending: listEsg } = await import("./lib/actions-service");
  const orgEsg = await makeOrg("pro");
  const payloadEsg = await makePayload(orgEsg);
  const rEsg = await runAgentEsg({ orgId: orgEsg, payloadId: payloadEsg, role: "esg_reporting_agent" }, { db, brain: sbEsg });
  ok("esg_reporting_agent run produced an analysis", rEsg.ok && rEsg.proposalCount === 1);
  const pendEsg = await listEsg(orgEsg, { db });
  ok("stub proposal passes validateProposal and returns generate_esg_report", pendEsg.length === 1 && pendEsg[0].kind === "generate_esg_report");
  const apprEsg = await approveEsg(orgEsg, pendEsg[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes esg_reporting_runs", apprEsg.ok && apprEsg.recordTable === "esg_reporting_runs", JSON.stringify(apprEsg));
  const { data: esgRows } = await db.from("esg_reporting_runs").select("org_id,reporting_framework").eq("org_id", orgEsg);
  ok("esg reporting record org-stamped", esgRows?.length === 1 && esgRows[0].org_id === orgEsg);
  const { routePayload: routeEsg } = await import("./lib/manager");
  const routeCheckEsgFin = await routeEsg({ orgId: orgEsg, payloadId: payloadEsg }, { db, enqueue: () => {} });
  const { data: plainPayloadEsg } = await db.from("inbound_payloads").insert({
    org_id: orgEsg, source: "upload", storage_path: `${orgEsg}/esg/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckEsgNonFin = await routeEsg({ orgId: orgEsg, payloadId: plainPayloadEsg!.id }, { db, enqueue: () => {} });
  ok("esg_reporting_agent routes on BOTH the financial and non-financial route",
    routeCheckEsgFin.ok && routeCheckEsgFin.plan.includes("esg_reporting_agent") &&
    routeCheckEsgNonFin.ok && routeCheckEsgNonFin.plan.includes("esg_reporting_agent"));
  await db.from("organizations").delete().eq("id", orgEsg);

  console.log("== seasonality agent ==");
  ok("analyze_seasonality accepts good", validateProposal("analyze_seasonality", {
    metric_name: "Monthly Revenue",
    seasonal_indices: [{ period: "Jan", index: 0.78, raw_value: 78000 }],
    peak_season: { period: "December", index: 1.42, percentage_above_average: 42.0 },
    trough_season: { period: "January", index: 0.78, percentage_below_average: 22.0 },
    year_over_year_comparison: [{ year: "2024", total: 1450000, yoy_growth: 20.8 }],
    seasonality_strength: "strong", business_implications: [], planning_recommendations: [],
  }).ok);
  ok("analyze_seasonality rejects invalid seasonality_strength", !validateProposal("analyze_seasonality", {
    metric_name: "x", seasonal_indices: [],
    peak_season: { period: "p", index: 1, percentage_above_average: 0 },
    trough_season: { period: "p", index: 1, percentage_below_average: 0 },
    year_over_year_comparison: [], seasonality_strength: "cyclical",
    business_implications: [], planning_recommendations: [],
  }).ok);
  ok("analyze_seasonality filters out seasonal_indices item with index <= 0", (() => {
    const r = validateProposal("analyze_seasonality", {
      metric_name: "x",
      seasonal_indices: [
        { period: "Good", index: 1.1, raw_value: 1 },
        { period: "Bad", index: 0, raw_value: 1 },
      ],
      peak_season: { period: "p", index: 1, percentage_above_average: 0 },
      trough_season: { period: "p", index: 1, percentage_below_average: 0 },
      year_over_year_comparison: [], seasonality_strength: "weak",
      business_implications: [], planning_recommendations: [],
    });
    return r.ok && (r.payload.seasonal_indices as unknown[]).length === 1;
  })());
  ok("analyze_seasonality rejects empty metric_name", !validateProposal("analyze_seasonality", {
    metric_name: "", seasonal_indices: [],
    peak_season: { period: "p", index: 1, percentage_above_average: 0 },
    trough_season: { period: "p", index: 1, percentage_below_average: 0 },
    year_over_year_comparison: [], seasonality_strength: "weak",
    business_implications: [], planning_recommendations: [],
  }).ok);
  ok("seasonality_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("seasonality_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentSn } = await import("./lib/run-agent");
  const { stubBrain: sbSn } = await import("./lib/agent-brain");
  const { approveAction: approveSn, listPending: listSn } = await import("./lib/actions-service");
  const orgSn = await makeOrg("pro");
  const payloadSn = await makePayload(orgSn);
  const rSn = await runAgentSn({ orgId: orgSn, payloadId: payloadSn, role: "seasonality_agent" }, { db, brain: sbSn });
  ok("seasonality_agent run produced an analysis", rSn.ok && rSn.proposalCount === 1);
  const pendSn = await listSn(orgSn, { db });
  ok("stub proposal passes validateProposal and returns analyze_seasonality", pendSn.length === 1 && pendSn[0].kind === "analyze_seasonality");
  const apprSn = await approveSn(orgSn, pendSn[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes seasonality_runs", apprSn.ok && apprSn.recordTable === "seasonality_runs", JSON.stringify(apprSn));
  const { data: snRows } = await db.from("seasonality_runs").select("org_id,metric_name").eq("org_id", orgSn);
  ok("seasonality record org-stamped", snRows?.length === 1 && snRows[0].org_id === orgSn);
  const { routePayload: routeSn } = await import("./lib/manager");
  const routeCheckSnFin = await routeSn({ orgId: orgSn, payloadId: payloadSn }, { db, enqueue: () => {} });
  const { data: plainPayloadSn } = await db.from("inbound_payloads").insert({
    org_id: orgSn, source: "upload", storage_path: `${orgSn}/sn/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckSnNonFin = await routeSn({ orgId: orgSn, payloadId: plainPayloadSn!.id }, { db, enqueue: () => {} });
  ok("seasonality_agent routes on BOTH the financial and non-financial route",
    routeCheckSnFin.ok && routeCheckSnFin.plan.includes("seasonality_agent") &&
    routeCheckSnNonFin.ok && routeCheckSnNonFin.plan.includes("seasonality_agent"));
  await db.from("organizations").delete().eq("id", orgSn);

  console.log("== benchmark agent ==");
  ok("benchmark_performance accepts good", validateProposal("benchmark_performance", {
    industry: "B2B SaaS", company_stage: "growth",
    benchmarks: [{ metric_name: "Gross Margin %", company_value: 72.0, peer_median: 70.0, peer_top_quartile: 80.0, unit: "%", percentile_estimate: 55, performance: "above_median" }],
    overall_performance: "top_quartile", standout_strengths: [], underperforming_areas: [],
    peer_comparison_notes: "Performing well above median.",
  }).ok);
  ok("benchmark_performance rejects invalid overall_performance", !validateProposal("benchmark_performance", {
    industry: "B2B SaaS", company_stage: "growth", benchmarks: [], overall_performance: "excellent",
    standout_strengths: [], underperforming_areas: [], peer_comparison_notes: "x",
  }).ok);
  ok("benchmark_performance rejects invalid company_stage", !validateProposal("benchmark_performance", {
    industry: "B2B SaaS", company_stage: "startup", benchmarks: [], overall_performance: "top_quartile",
    standout_strengths: [], underperforming_areas: [], peer_comparison_notes: "x",
  }).ok);
  ok("benchmark_performance filters out benchmarks item with invalid performance", (() => {
    const r = validateProposal("benchmark_performance", {
      industry: "B2B SaaS", company_stage: "growth",
      benchmarks: [
        { metric_name: "Good", company_value: 1, peer_median: 1, peer_top_quartile: 1, unit: "%", percentile_estimate: 50, performance: "above_median" },
        { metric_name: "Bad", company_value: 1, peer_median: 1, peer_top_quartile: 1, unit: "%", percentile_estimate: 50, performance: "phenomenal" },
      ],
      overall_performance: "top_quartile", standout_strengths: [], underperforming_areas: [], peer_comparison_notes: "x",
    });
    return r.ok && (r.payload.benchmarks as unknown[]).length === 1;
  })());
  ok("benchmark_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("benchmark_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentBmk } = await import("./lib/run-agent");
  const { stubBrain: sbBmk } = await import("./lib/agent-brain");
  const { approveAction: approveBmk, listPending: listBmk } = await import("./lib/actions-service");
  const orgBmk = await makeOrg("pro");
  const payloadBmk = await makePayload(orgBmk);
  const rBmk = await runAgentBmk({ orgId: orgBmk, payloadId: payloadBmk, role: "benchmark_agent" }, { db, brain: sbBmk });
  ok("benchmark_agent run produced an analysis", rBmk.ok && rBmk.proposalCount === 1);
  const pendBmk = await listBmk(orgBmk, { db });
  ok("stub proposal passes validateProposal and returns benchmark_performance", pendBmk.length === 1 && pendBmk[0].kind === "benchmark_performance");
  const apprBmk = await approveBmk(orgBmk, pendBmk[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes benchmark_runs", apprBmk.ok && apprBmk.recordTable === "benchmark_runs", JSON.stringify(apprBmk));
  const { data: bmkRows } = await db.from("benchmark_runs").select("org_id,overall_performance").eq("org_id", orgBmk);
  ok("benchmark record org-stamped", bmkRows?.length === 1 && bmkRows[0].org_id === orgBmk);
  const { routePayload: routeBmk } = await import("./lib/manager");
  const routeCheckBmkFin = await routeBmk({ orgId: orgBmk, payloadId: payloadBmk }, { db, enqueue: () => {} });
  const { data: plainPayloadBmk } = await db.from("inbound_payloads").insert({
    org_id: orgBmk, source: "upload", storage_path: `${orgBmk}/bmk/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckBmkNonFin = await routeBmk({ orgId: orgBmk, payloadId: plainPayloadBmk!.id }, { db, enqueue: () => {} });
  ok("benchmark_agent routes on BOTH the financial and non-financial route",
    routeCheckBmkFin.ok && routeCheckBmkFin.plan.includes("benchmark_agent") &&
    routeCheckBmkNonFin.ok && routeCheckBmkNonFin.plan.includes("benchmark_agent"));
  await db.from("organizations").delete().eq("id", orgBmk);

  console.log("== consolidation agent ==");
  ok("consolidate_entities accepts good", validateProposal("consolidate_entities", {
    entities: [
      { entity_name: "Parent Co", ownership_percentage: 100, entity_type: "parent", currency: "USD", revenue: 800000, costs: 550000, profit: 250000, intercompany_revenues: 60000, intercompany_costs: 0 },
      { entity_name: "Sub Ltd", ownership_percentage: 80, entity_type: "subsidiary", currency: "GBP", revenue: 450000, costs: 380000, profit: 70000, intercompany_revenues: 0, intercompany_costs: 60000 },
    ],
    intercompany_eliminations: [{ description: "mgmt fees", amount: 60000, from_entity: "Sub Ltd", to_entity: "Parent Co" }],
    consolidated_revenue: 1190000, consolidated_costs: 870000, consolidated_profit: 320000,
    minority_interests: [{ entity_name: "Sub Ltd", minority_percentage: 20, minority_profit_share: 14000 }],
    fx_translation_adjustments: [{ entity_name: "Sub Ltd", local_currency: "GBP", fx_rate_used: 1.27, translation_adjustment: 2500 }],
    consolidation_notes: "GBP translated at 1.27.",
  }).ok);
  ok("consolidate_entities rejects single entity", !validateProposal("consolidate_entities", {
    entities: [{ entity_name: "Parent Co", ownership_percentage: 100, entity_type: "parent", currency: "USD", revenue: 800000, costs: 550000, profit: 250000, intercompany_revenues: 0, intercompany_costs: 0 }],
    intercompany_eliminations: [], consolidated_revenue: 800000, consolidated_costs: 550000, consolidated_profit: 250000,
    minority_interests: [], fx_translation_adjustments: [], consolidation_notes: "x",
  }).ok);
  ok("consolidate_entities filters out entity with invalid entity_type", (() => {
    const r = validateProposal("consolidate_entities", {
      entities: [
        { entity_name: "Parent Co", ownership_percentage: 100, entity_type: "parent", currency: "USD", revenue: 800000, costs: 550000, profit: 250000, intercompany_revenues: 0, intercompany_costs: 0 },
        { entity_name: "Sub Ltd", ownership_percentage: 80, entity_type: "franchise", currency: "GBP", revenue: 450000, costs: 380000, profit: 70000, intercompany_revenues: 0, intercompany_costs: 0 },
        { entity_name: "Assoc Co", ownership_percentage: 30, entity_type: "associate", currency: "USD", revenue: 100000, costs: 80000, profit: 20000, intercompany_revenues: 0, intercompany_costs: 0 },
      ],
      intercompany_eliminations: [], consolidated_revenue: 900000, consolidated_costs: 630000, consolidated_profit: 270000,
      minority_interests: [], fx_translation_adjustments: [], consolidation_notes: "x",
    });
    return r.ok && (r.payload.entities as unknown[]).length === 2;
  })());
  ok("consolidation_agent → opus model",
    (await import("./lib/agent-brain")).modelForRole("consolidation_agent") === "claude-opus-4-8");

  const { runAgent: runAgentCn } = await import("./lib/run-agent");
  const { stubBrain: sbCn } = await import("./lib/agent-brain");
  const { approveAction: approveCn, listPending: listCn } = await import("./lib/actions-service");
  const orgCn = await makeOrg("pro");
  const payloadCn = await makePayload(orgCn);
  const rCn = await runAgentCn({ orgId: orgCn, payloadId: payloadCn, role: "consolidation_agent" }, { db, brain: sbCn });
  ok("consolidation_agent run produced an analysis", rCn.ok && rCn.proposalCount === 1);
  const pendCn = await listCn(orgCn, { db });
  ok("stub proposal passes validateProposal and returns consolidate_entities", pendCn.length === 1 && pendCn[0].kind === "consolidate_entities");
  const apprCn = await approveCn(orgCn, pendCn[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes consolidation_runs", apprCn.ok && apprCn.recordTable === "consolidation_runs", JSON.stringify(apprCn));
  const { data: cnRows } = await db.from("consolidation_runs").select("org_id,consolidated_profit").eq("org_id", orgCn);
  ok("consolidation record org-stamped", cnRows?.length === 1 && cnRows[0].org_id === orgCn);
  const { routePayload: routeCn } = await import("./lib/manager");
  const routeCheckCn = await routeCn({ orgId: orgCn, payloadId: payloadCn }, { db, enqueue: () => {} });
  ok("consolidation_agent routes on the financial route", routeCheckCn.ok && routeCheckCn.plan.includes("consolidation_agent"));
  await db.from("organizations").delete().eq("id", orgCn);

  console.log("== ecommerce agent ==");
  ok("analyze_ecommerce accepts good", validateProposal("analyze_ecommerce", {
    gmv: 285000, net_revenue: 256500, take_rate: 90.0, order_count: 342,
    average_order_value: 833, conversion_rate: 3.2, cart_abandonment_rate: 68.5,
    top_products: [{ product_name: "Widget", units_sold: 85, revenue: 127500, return_rate: 2.1 }],
    channel_breakdown: [{ channel: "organic", revenue: 89775, orders: 120, percentage: 35.0 }],
    fulfillment_metrics: { avg_delivery_days: 3.2, on_time_rate: 94.5, return_rate: 3.1, refund_rate: 1.8 },
    growth_insights: ["invest in SEO"],
  }).ok);
  ok("analyze_ecommerce filters out channel_breakdown item with bad channel", (() => {
    const r = validateProposal("analyze_ecommerce", {
      gmv: 1000, net_revenue: 900, take_rate: 90, order_count: 10,
      average_order_value: 90, conversion_rate: 2, cart_abandonment_rate: 50,
      top_products: [],
      channel_breakdown: [
        { channel: "organic", revenue: 500, orders: 5, percentage: 50 },
        { channel: "referral", revenue: 500, orders: 5, percentage: 50 },
      ],
      fulfillment_metrics: { avg_delivery_days: 3, on_time_rate: 90, return_rate: 2, refund_rate: 1 },
      growth_insights: [],
    });
    return r.ok && (r.payload.channel_breakdown as unknown[]).length === 1;
  })());
  ok("analyze_ecommerce rejects conversion_rate > 100", !validateProposal("analyze_ecommerce", {
    gmv: 1000, net_revenue: 900, take_rate: 90, order_count: 10,
    average_order_value: 90, conversion_rate: 150, cart_abandonment_rate: 50,
    top_products: [], channel_breakdown: [],
    fulfillment_metrics: { avg_delivery_days: 3, on_time_rate: 90, return_rate: 2, refund_rate: 1 },
    growth_insights: [],
  }).ok);
  ok("ecommerce_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("ecommerce_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentEc } = await import("./lib/run-agent");
  const { stubBrain: sbEc } = await import("./lib/agent-brain");
  const { approveAction: approveEc, listPending: listEc } = await import("./lib/actions-service");
  const orgEc = await makeOrg("pro");
  const payloadEc = await makePayload(orgEc);
  const rEc = await runAgentEc({ orgId: orgEc, payloadId: payloadEc, role: "ecommerce_agent" }, { db, brain: sbEc });
  ok("ecommerce_agent run produced an analysis", rEc.ok && rEc.proposalCount === 1);
  const pendEc = await listEc(orgEc, { db });
  ok("stub proposal passes validateProposal and returns analyze_ecommerce", pendEc.length === 1 && pendEc[0].kind === "analyze_ecommerce");
  const apprEc = await approveEc(orgEc, pendEc[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes ecommerce_runs", apprEc.ok && apprEc.recordTable === "ecommerce_runs", JSON.stringify(apprEc));
  const { data: ecRows } = await db.from("ecommerce_runs").select("org_id,gmv").eq("org_id", orgEc);
  ok("ecommerce record org-stamped", ecRows?.length === 1 && ecRows[0].org_id === orgEc);
  const { routePayload: routeEc } = await import("./lib/manager");
  const { data: plainPayloadEc } = await db.from("inbound_payloads").insert({
    org_id: orgEc, source: "upload", storage_path: `${orgEc}/ec/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckEc = await routeEc({ orgId: orgEc, payloadId: plainPayloadEc!.id }, { db, enqueue: () => {} });
  ok("ecommerce_agent routes on the non-financial route", routeCheckEc.ok && routeCheckEc.plan.includes("ecommerce_agent"));
  await db.from("organizations").delete().eq("id", orgEc);

  console.log("== professional services agent ==");
  ok("analyze_professional_services accepts good", validateProposal("analyze_professional_services", {
    utilization_rate: 74.2, billable_hours: 1484, total_hours: 2000,
    average_bill_rate: 185, revenue_per_consultant: 68950, wip_value: 45000,
    project_profitability: [{ project_ref: "P001", client: "Acme", budgeted_hours: 200, actual_hours: 245, budgeted_revenue: 37000, actual_revenue: 37000, margin: -20.3, status: "over_budget" }],
    staff_utilization: [{ staff_ref: "J. Smith", role: "Senior Consultant", billable_hours: 158, total_hours: 180, utilization_rate: 87.8 }],
    realization_rate: 92.0,
    recommendations: ["implement change order process"],
  }).ok);
  ok("analyze_professional_services filters out project with bad status", (() => {
    const r = validateProposal("analyze_professional_services", {
      utilization_rate: 75, billable_hours: 100, total_hours: 133,
      average_bill_rate: 100, revenue_per_consultant: 10000, wip_value: 0,
      project_profitability: [
        { project_ref: "P001", client: "Acme", budgeted_hours: 100, actual_hours: 100, budgeted_revenue: 10000, actual_revenue: 10000, margin: 5, status: "on_budget" },
        { project_ref: "P002", client: "Beta", budgeted_hours: 100, actual_hours: 100, budgeted_revenue: 10000, actual_revenue: 10000, margin: 5, status: "ahead_of_schedule" },
      ],
      staff_utilization: [], realization_rate: 90, recommendations: [],
    });
    return r.ok && (r.payload.project_profitability as unknown[]).length === 1;
  })());
  ok("analyze_professional_services rejects utilization_rate > 100", !validateProposal("analyze_professional_services", {
    utilization_rate: 150, billable_hours: 100, total_hours: 66,
    average_bill_rate: 100, revenue_per_consultant: 10000, wip_value: 0,
    project_profitability: [], staff_utilization: [], realization_rate: 90, recommendations: [],
  }).ok);
  ok("professional_services_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("professional_services_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentPs } = await import("./lib/run-agent");
  const { stubBrain: sbPs } = await import("./lib/agent-brain");
  const { approveAction: approvePs, listPending: listPs } = await import("./lib/actions-service");
  const orgPs = await makeOrg("pro");
  const payloadPs = await makePayload(orgPs);
  const rPs = await runAgentPs({ orgId: orgPs, payloadId: payloadPs, role: "professional_services_agent" }, { db, brain: sbPs });
  ok("professional_services_agent run produced an analysis", rPs.ok && rPs.proposalCount === 1);
  const pendPs = await listPs(orgPs, { db });
  ok("stub proposal passes validateProposal and returns analyze_professional_services", pendPs.length === 1 && pendPs[0].kind === "analyze_professional_services");
  const apprPs = await approvePs(orgPs, pendPs[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes professional_services_runs", apprPs.ok && apprPs.recordTable === "professional_services_runs", JSON.stringify(apprPs));
  const { data: psRows } = await db.from("professional_services_runs").select("org_id,utilization_rate").eq("org_id", orgPs);
  ok("professional services record org-stamped", psRows?.length === 1 && psRows[0].org_id === orgPs);
  const { routePayload: routePs } = await import("./lib/manager");
  const routeCheckPsFin = await routePs({ orgId: orgPs, payloadId: payloadPs }, { db, enqueue: () => {} });
  const { data: plainPayloadPs } = await db.from("inbound_payloads").insert({
    org_id: orgPs, source: "upload", storage_path: `${orgPs}/ps/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckPsNonFin = await routePs({ orgId: orgPs, payloadId: plainPayloadPs!.id }, { db, enqueue: () => {} });
  ok("professional_services_agent routes on BOTH the financial and non-financial route",
    routeCheckPsFin.ok && routeCheckPsFin.plan.includes("professional_services_agent") &&
    routeCheckPsNonFin.ok && routeCheckPsNonFin.plan.includes("professional_services_agent"));
  await db.from("organizations").delete().eq("id", orgPs);

  console.log("== nonprofit agent ==");
  ok("analyze_nonprofit_financials accepts good", validateProposal("analyze_nonprofit_financials", {
    revenue_by_source: [{ source: "individual_donations", amount: 180000, percentage_of_total: 45.0, restricted: false }],
    total_revenue: 400000, program_expenses: 310000, administrative_expenses: 60000,
    fundraising_expenses: 30000, total_expenses: 400000,
    program_efficiency_ratio: 77.5, fundraising_efficiency_ratio: 16.7, months_of_reserves: 3.2,
    donor_metrics: { total_donors: 450, new_donors: 85, retained_donors: 365, avg_donation: 400, major_gift_threshold: 5000, major_gift_donors: 12 },
    grant_pipeline: [{ grantor: "Gates Foundation", amount_requested: 250000, status: "submitted", expected_decision_date: "2024-06-01" }],
    compliance_notes: "Form 990 due May 15.",
  }).ok);
  ok("analyze_nonprofit_financials filters out revenue_by_source item with bad source", (() => {
    const r = validateProposal("analyze_nonprofit_financials", {
      revenue_by_source: [
        { source: "individual_donations", amount: 100000, percentage_of_total: 50, restricted: false },
        { source: "membership_dues", amount: 100000, percentage_of_total: 50, restricted: false },
      ],
      total_revenue: 200000, program_expenses: 150000, administrative_expenses: 30000,
      fundraising_expenses: 20000, total_expenses: 200000,
      program_efficiency_ratio: 75, fundraising_efficiency_ratio: 10, months_of_reserves: 2,
      donor_metrics: { total_donors: 100, new_donors: 10, retained_donors: 90, avg_donation: 1000, major_gift_threshold: 5000, major_gift_donors: 2 },
      grant_pipeline: [], compliance_notes: "x",
    });
    return r.ok && (r.payload.revenue_by_source as unknown[]).length === 1;
  })());
  ok("analyze_nonprofit_financials filters out grant with bad status", (() => {
    const r = validateProposal("analyze_nonprofit_financials", {
      revenue_by_source: [], total_revenue: 0, program_expenses: 0, administrative_expenses: 0,
      fundraising_expenses: 0, total_expenses: 0, program_efficiency_ratio: 0, fundraising_efficiency_ratio: 0,
      months_of_reserves: 0,
      donor_metrics: { total_donors: 0, new_donors: 0, retained_donors: 0, avg_donation: 0, major_gift_threshold: 0, major_gift_donors: 0 },
      grant_pipeline: [
        { grantor: "Gates Foundation", amount_requested: 100000, status: "submitted", expected_decision_date: null },
        { grantor: "Ford Foundation", amount_requested: 50000, status: "maybe", expected_decision_date: null },
      ],
      compliance_notes: "x",
    });
    return r.ok && (r.payload.grant_pipeline as unknown[]).length === 1;
  })());
  ok("nonprofit_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("nonprofit_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentNp } = await import("./lib/run-agent");
  const { stubBrain: sbNp } = await import("./lib/agent-brain");
  const { approveAction: approveNp, listPending: listNp } = await import("./lib/actions-service");
  const orgNp = await makeOrg("pro");
  const payloadNp = await makePayload(orgNp);
  const rNp = await runAgentNp({ orgId: orgNp, payloadId: payloadNp, role: "nonprofit_agent" }, { db, brain: sbNp });
  ok("nonprofit_agent run produced an analysis", rNp.ok && rNp.proposalCount === 1);
  const pendNp = await listNp(orgNp, { db });
  ok("stub proposal passes validateProposal and returns analyze_nonprofit_financials", pendNp.length === 1 && pendNp[0].kind === "analyze_nonprofit_financials");
  const apprNp = await approveNp(orgNp, pendNp[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes nonprofit_runs", apprNp.ok && apprNp.recordTable === "nonprofit_runs", JSON.stringify(apprNp));
  const { data: npRows } = await db.from("nonprofit_runs").select("org_id,total_revenue").eq("org_id", orgNp);
  ok("nonprofit record org-stamped", npRows?.length === 1 && npRows[0].org_id === orgNp);
  const { routePayload: routeNp } = await import("./lib/manager");
  const routeCheckNp = await routeNp({ orgId: orgNp, payloadId: payloadNp }, { db, enqueue: () => {} });
  ok("nonprofit_agent routes on the financial route", routeCheckNp.ok && routeCheckNp.plan.includes("nonprofit_agent"));
  await db.from("organizations").delete().eq("id", orgNp);

  console.log("== healthcare agent ==");
  ok("analyze_healthcare_financials accepts good", validateProposal("analyze_healthcare_financials", {
    net_patient_revenue: 2850000, gross_charges: 4200000, contractual_adjustments: 1200000, bad_debt_expense: 150000,
    payor_mix: [{ payor: "medicare", revenue_percentage: 45.0, reimbursement_rate: 82.0 }],
    cost_per_patient_encounter: 285, days_in_ar: 38.5, denial_rate: 6.2, clean_claim_rate: 91.5,
    quality_metrics: [{ metric_name: "Readmission Rate", value: "8.2%", benchmark: "< 10%", status: "above" }],
    revenue_cycle_insights: ["review coding accuracy"],
  }).ok);
  ok("analyze_healthcare_financials filters out payor_mix item with bad payor", (() => {
    const r = validateProposal("analyze_healthcare_financials", {
      net_patient_revenue: 100000, gross_charges: 150000, contractual_adjustments: 40000, bad_debt_expense: 10000,
      payor_mix: [
        { payor: "medicare", revenue_percentage: 50, reimbursement_rate: 80 },
        { payor: "hmo_plan", revenue_percentage: 50, reimbursement_rate: 80 },
      ],
      cost_per_patient_encounter: 100, days_in_ar: 30, denial_rate: 4, clean_claim_rate: 96,
      quality_metrics: [], revenue_cycle_insights: [],
    });
    return r.ok && (r.payload.payor_mix as unknown[]).length === 1;
  })());
  ok("analyze_healthcare_financials rejects denial_rate > 100", !validateProposal("analyze_healthcare_financials", {
    net_patient_revenue: 100000, gross_charges: 150000, contractual_adjustments: 40000, bad_debt_expense: 10000,
    payor_mix: [], cost_per_patient_encounter: 100, days_in_ar: 30, denial_rate: 150, clean_claim_rate: 96,
    quality_metrics: [], revenue_cycle_insights: [],
  }).ok);
  ok("healthcare_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("healthcare_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentHc } = await import("./lib/run-agent");
  const { stubBrain: sbHc } = await import("./lib/agent-brain");
  const { approveAction: approveHc, listPending: listHc } = await import("./lib/actions-service");
  const orgHc = await makeOrg("pro");
  const payloadHc = await makePayload(orgHc);
  const rHc = await runAgentHc({ orgId: orgHc, payloadId: payloadHc, role: "healthcare_agent" }, { db, brain: sbHc });
  ok("healthcare_agent run produced an analysis", rHc.ok && rHc.proposalCount === 1);
  const pendHc = await listHc(orgHc, { db });
  ok("stub proposal passes validateProposal and returns analyze_healthcare_financials", pendHc.length === 1 && pendHc[0].kind === "analyze_healthcare_financials");
  const apprHc = await approveHc(orgHc, pendHc[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes healthcare_runs", apprHc.ok && apprHc.recordTable === "healthcare_runs", JSON.stringify(apprHc));
  const { data: hcRows } = await db.from("healthcare_runs").select("org_id,net_patient_revenue").eq("org_id", orgHc);
  ok("healthcare record org-stamped", hcRows?.length === 1 && hcRows[0].org_id === orgHc);
  const { routePayload: routeHc } = await import("./lib/manager");
  const routeCheckHc = await routeHc({ orgId: orgHc, payloadId: payloadHc }, { db, enqueue: () => {} });
  ok("healthcare_agent routes on the financial route", routeCheckHc.ok && routeCheckHc.plan.includes("healthcare_agent"));
  await db.from("organizations").delete().eq("id", orgHc);

  console.log("== legal billing agent ==");
  ok("analyze_legal_billing accepts good", validateProposal("analyze_legal_billing", {
    matters: [{ matter_ref: "M001", client: "Acme", matter_type: "Litigation", hours_billed: 124.5, amount_billed: 62250, amount_collected: 62250, wip_unbilled: 8500, rate_per_hour: 500, status: "open" }],
    total_billed: 62250, total_collected: 62250, collection_rate: 100, average_hourly_rate: 500,
    timekeeper_summary: [{ timekeeper: "Partner A", role: "partner", hours: 95.5, billed_amount: 57300, effective_rate: 600 }],
    writeoffs_and_discounts: 0,
    aging_wip: [{ bucket: "current", amount: 6500 }],
    billing_flags: [],
  }).ok);
  ok("analyze_legal_billing filters out timekeeper with bad role", (() => {
    const r = validateProposal("analyze_legal_billing", {
      matters: [], total_billed: 0, total_collected: 0, collection_rate: 0, average_hourly_rate: 0,
      timekeeper_summary: [
        { timekeeper: "Partner A", role: "partner", hours: 10, billed_amount: 5000, effective_rate: 500 },
        { timekeeper: "Contractor B", role: "contractor", hours: 10, billed_amount: 5000, effective_rate: 500 },
      ],
      writeoffs_and_discounts: 0, aging_wip: [], billing_flags: [],
    });
    return r.ok && (r.payload.timekeeper_summary as unknown[]).length === 1;
  })());
  ok("analyze_legal_billing filters out matter with bad status", (() => {
    const r = validateProposal("analyze_legal_billing", {
      matters: [
        { matter_ref: "M001", client: "Acme", matter_type: "Litigation", hours_billed: 10, amount_billed: 5000, amount_collected: 5000, wip_unbilled: 0, rate_per_hour: 500, status: "open" },
        { matter_ref: "M002", client: "Beta", matter_type: "M&A", hours_billed: 10, amount_billed: 5000, amount_collected: 5000, wip_unbilled: 0, rate_per_hour: 500, status: "archived" },
      ],
      total_billed: 10000, total_collected: 10000, collection_rate: 100, average_hourly_rate: 500,
      timekeeper_summary: [], writeoffs_and_discounts: 0, aging_wip: [], billing_flags: [],
    });
    return r.ok && (r.payload.matters as unknown[]).length === 1;
  })());
  ok("legal_billing_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("legal_billing_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentLb } = await import("./lib/run-agent");
  const { stubBrain: sbLb } = await import("./lib/agent-brain");
  const { approveAction: approveLb, listPending: listLb } = await import("./lib/actions-service");
  const orgLb = await makeOrg("pro");
  const payloadLb = await makePayload(orgLb);
  const rLb = await runAgentLb({ orgId: orgLb, payloadId: payloadLb, role: "legal_billing_agent" }, { db, brain: sbLb });
  ok("legal_billing_agent run produced an analysis", rLb.ok && rLb.proposalCount === 1);
  const pendLb = await listLb(orgLb, { db });
  ok("stub proposal passes validateProposal and returns analyze_legal_billing", pendLb.length === 1 && pendLb[0].kind === "analyze_legal_billing");
  const apprLb = await approveLb(orgLb, pendLb[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes legal_billing_runs", apprLb.ok && apprLb.recordTable === "legal_billing_runs", JSON.stringify(apprLb));
  const { data: lbRows } = await db.from("legal_billing_runs").select("org_id,total_billed").eq("org_id", orgLb);
  ok("legal billing record org-stamped", lbRows?.length === 1 && lbRows[0].org_id === orgLb);
  const { routePayload: routeLb } = await import("./lib/manager");
  const routeCheckLb = await routeLb({ orgId: orgLb, payloadId: payloadLb }, { db, enqueue: () => {} });
  ok("legal_billing_agent routes on the financial route", routeCheckLb.ok && routeCheckLb.plan.includes("legal_billing_agent"));
  await db.from("organizations").delete().eq("id", orgLb);

  console.log("== hospitality agent ==");
  ok("analyze_hospitality_financials accepts good", validateProposal("analyze_hospitality_financials", {
    occupancy_rate: 72.5, adr: 185, revpar: 134.1, total_rooms: 120,
    room_revenue: 724500, fb_revenue: 145000, other_revenue: 48000, total_revenue: 917500,
    goppar: 89.2, cost_per_occupied_room: 82.0,
    channel_mix: [{ channel: "direct", revenue_percentage: 38.0, commission_rate: 0.0 }],
    performance_vs_stly: [{ metric_name: "Occupancy", current_value: 72.5, stly_value: 68.0, variance_percentage: 6.6 }],
    revenue_management_insights: ["shift to direct bookings"],
  }).ok);
  ok("analyze_hospitality_financials filters out channel_mix item with bad channel", (() => {
    const r = validateProposal("analyze_hospitality_financials", {
      occupancy_rate: 70, adr: 150, revpar: 105, total_rooms: 100,
      room_revenue: 500000, fb_revenue: 50000, other_revenue: 10000, total_revenue: 560000,
      goppar: 60, cost_per_occupied_room: 40,
      channel_mix: [
        { channel: "direct", revenue_percentage: 50, commission_rate: 0 },
        { channel: "wholesaler", revenue_percentage: 50, commission_rate: 20 },
      ],
      performance_vs_stly: [], revenue_management_insights: [],
    });
    return r.ok && (r.payload.channel_mix as unknown[]).length === 1;
  })());
  ok("analyze_hospitality_financials rejects occupancy_rate > 100", !validateProposal("analyze_hospitality_financials", {
    occupancy_rate: 150, adr: 150, revpar: 105, total_rooms: 100,
    room_revenue: 500000, fb_revenue: 50000, other_revenue: 10000, total_revenue: 560000,
    goppar: 60, cost_per_occupied_room: 40, channel_mix: [], performance_vs_stly: [], revenue_management_insights: [],
  }).ok);
  ok("hospitality_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("hospitality_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentHp } = await import("./lib/run-agent");
  const { stubBrain: sbHp } = await import("./lib/agent-brain");
  const { approveAction: approveHp, listPending: listHp } = await import("./lib/actions-service");
  const orgHp = await makeOrg("pro");
  const payloadHp = await makePayload(orgHp);
  const rHp = await runAgentHp({ orgId: orgHp, payloadId: payloadHp, role: "hospitality_agent" }, { db, brain: sbHp });
  ok("hospitality_agent run produced an analysis", rHp.ok && rHp.proposalCount === 1);
  const pendHp = await listHp(orgHp, { db });
  ok("stub proposal passes validateProposal and returns analyze_hospitality_financials", pendHp.length === 1 && pendHp[0].kind === "analyze_hospitality_financials");
  const apprHp = await approveHp(orgHp, pendHp[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes hospitality_runs", apprHp.ok && apprHp.recordTable === "hospitality_runs", JSON.stringify(apprHp));
  const { data: hpRows } = await db.from("hospitality_runs").select("org_id,occupancy_rate").eq("org_id", orgHp);
  ok("hospitality record org-stamped", hpRows?.length === 1 && hpRows[0].org_id === orgHp);
  const { routePayload: routeHp } = await import("./lib/manager");
  const routeCheckHp = await routeHp({ orgId: orgHp, payloadId: payloadHp }, { db, enqueue: () => {} });
  ok("hospitality_agent routes on the financial route", routeCheckHp.ok && routeCheckHp.plan.includes("hospitality_agent"));
  await db.from("organizations").delete().eq("id", orgHp);

  console.log("== retail agent ==");
  ok("analyze_retail_performance accepts good", validateProposal("analyze_retail_performance", {
    total_net_sales: 1850000, comparable_store_sales_growth: 5.8, gross_margin_percentage: 42.5,
    inventory_turnover: 5.2, sell_through_rate: 76.0, shrinkage_rate: 1.2, sales_per_sqft: 485,
    transactions_per_day: 142, average_transaction_value: 87,
    store_breakdown: [{ store_id: "Store 01", net_sales: 650000, transactions: 7480, avg_ticket: 87, margin_percentage: 44.2, rank: 1 }],
    category_performance: [{ category: "Apparel", net_sales: 740000, units_sold: 8500, margin_percentage: 48.0, sell_through: 82.0 }],
    markdown_analysis: { total_markdown_amount: 148000, markdown_rate: 8.0, categories_with_high_markdown: ["Outerwear"] },
  }).ok);
  ok("analyze_retail_performance rejects sell_through_rate > 100", !validateProposal("analyze_retail_performance", {
    total_net_sales: 100000, comparable_store_sales_growth: 1, gross_margin_percentage: 40,
    inventory_turnover: 4, sell_through_rate: 150, shrinkage_rate: 1, sales_per_sqft: 100,
    transactions_per_day: 10, average_transaction_value: 50,
    store_breakdown: [], category_performance: [],
    markdown_analysis: { total_markdown_amount: 0, markdown_rate: 0, categories_with_high_markdown: [] },
  }).ok);
  ok("analyze_retail_performance filters out store with rank < 1", (() => {
    const r = validateProposal("analyze_retail_performance", {
      total_net_sales: 100000, comparable_store_sales_growth: 1, gross_margin_percentage: 40,
      inventory_turnover: 4, sell_through_rate: 70, shrinkage_rate: 1, sales_per_sqft: 100,
      transactions_per_day: 10, average_transaction_value: 50,
      store_breakdown: [
        { store_id: "Store 01", net_sales: 100000, transactions: 10, avg_ticket: 50, margin_percentage: 40, rank: 1 },
        { store_id: "Store 02", net_sales: 100000, transactions: 10, avg_ticket: 50, margin_percentage: 40, rank: 0 },
      ],
      category_performance: [],
      markdown_analysis: { total_markdown_amount: 0, markdown_rate: 0, categories_with_high_markdown: [] },
    });
    return r.ok && (r.payload.store_breakdown as unknown[]).length === 1;
  })());
  ok("retail_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("retail_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentRt } = await import("./lib/run-agent");
  const { stubBrain: sbRt } = await import("./lib/agent-brain");
  const { approveAction: approveRt, listPending: listRt } = await import("./lib/actions-service");
  const orgRt = await makeOrg("pro");
  const payloadRt = await makePayload(orgRt);
  const rRt = await runAgentRt({ orgId: orgRt, payloadId: payloadRt, role: "retail_agent" }, { db, brain: sbRt });
  ok("retail_agent run produced an analysis", rRt.ok && rRt.proposalCount === 1);
  const pendRt = await listRt(orgRt, { db });
  ok("stub proposal passes validateProposal and returns analyze_retail_performance", pendRt.length === 1 && pendRt[0].kind === "analyze_retail_performance");
  const apprRt = await approveRt(orgRt, pendRt[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes retail_runs", apprRt.ok && apprRt.recordTable === "retail_runs", JSON.stringify(apprRt));
  const { data: rtRows } = await db.from("retail_runs").select("org_id,total_net_sales").eq("org_id", orgRt);
  ok("retail record org-stamped", rtRows?.length === 1 && rtRows[0].org_id === orgRt);
  const { routePayload: routeRt } = await import("./lib/manager");
  const { data: plainPayloadRt } = await db.from("inbound_payloads").insert({
    org_id: orgRt, source: "upload", storage_path: `${orgRt}/rt/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckRt = await routeRt({ orgId: orgRt, payloadId: plainPayloadRt!.id }, { db, enqueue: () => {} });
  ok("retail_agent routes on the non-financial route", routeCheckRt.ok && routeCheckRt.plan.includes("retail_agent"));
  await db.from("organizations").delete().eq("id", orgRt);

  console.log("== construction agent ==");
  ok("analyze_construction_financials accepts good", validateProposal("analyze_construction_financials", {
    projects: [
      { project_ref: "C001", client: "City of Springfield", contract_value: 2500000, estimated_costs: 2000000, costs_to_date: 1200000, percent_complete: 62.0, earned_value: 1550000, billed_to_date: 1650000, estimated_gross_margin: 500000, status: "active", overbilled: true, underbilled: false },
    ],
    total_contract_value: 2500000, total_earned_value: 1550000, total_costs_to_date: 1200000, total_remaining_costs: 800000,
    overall_gross_margin: 20, overbillings: 100000, underbillings: 0, backlog_value: 950000,
    wip_schedule: [{ category: "earned_revenue", amount: 1550000 }],
    risk_summary: ["overbilled — monitor"],
  }).ok);
  ok("analyze_construction_financials filters out project with bad status", (() => {
    const r = validateProposal("analyze_construction_financials", {
      projects: [
        { project_ref: "C001", client: "Acme", contract_value: 100000, estimated_costs: 80000, costs_to_date: 40000, percent_complete: 50, earned_value: 50000, billed_to_date: 50000, estimated_gross_margin: 20000, status: "active", overbilled: false, underbilled: false },
        { project_ref: "C002", client: "Beta", contract_value: 100000, estimated_costs: 80000, costs_to_date: 40000, percent_complete: 50, earned_value: 50000, billed_to_date: 50000, estimated_gross_margin: 20000, status: "cancelled", overbilled: false, underbilled: false },
      ],
      total_contract_value: 200000, total_earned_value: 100000, total_costs_to_date: 80000, total_remaining_costs: 80000,
      overall_gross_margin: 20, overbillings: 0, underbillings: 0, backlog_value: 100000,
      wip_schedule: [], risk_summary: [],
    });
    return r.ok && (r.payload.projects as unknown[]).length === 1;
  })());
  ok("analyze_construction_financials filters out project with percent_complete > 100", (() => {
    const r = validateProposal("analyze_construction_financials", {
      projects: [
        { project_ref: "C001", client: "Acme", contract_value: 100000, estimated_costs: 80000, costs_to_date: 40000, percent_complete: 50, earned_value: 50000, billed_to_date: 50000, estimated_gross_margin: 20000, status: "active", overbilled: false, underbilled: false },
        { project_ref: "C002", client: "Beta", contract_value: 100000, estimated_costs: 80000, costs_to_date: 40000, percent_complete: 150, earned_value: 50000, billed_to_date: 50000, estimated_gross_margin: 20000, status: "active", overbilled: false, underbilled: false },
      ],
      total_contract_value: 200000, total_earned_value: 100000, total_costs_to_date: 80000, total_remaining_costs: 80000,
      overall_gross_margin: 20, overbillings: 0, underbillings: 0, backlog_value: 100000,
      wip_schedule: [], risk_summary: [],
    });
    return r.ok && (r.payload.projects as unknown[]).length === 1;
  })());
  ok("construction_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("construction_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentCx } = await import("./lib/run-agent");
  const { stubBrain: sbCx } = await import("./lib/agent-brain");
  const { approveAction: approveCx, listPending: listCx } = await import("./lib/actions-service");
  const orgCx = await makeOrg("pro");
  const payloadCx = await makePayload(orgCx);
  const rCx = await runAgentCx({ orgId: orgCx, payloadId: payloadCx, role: "construction_agent" }, { db, brain: sbCx });
  ok("construction_agent run produced an analysis", rCx.ok && rCx.proposalCount === 1);
  const pendCx = await listCx(orgCx, { db });
  ok("stub proposal passes validateProposal and returns analyze_construction_financials", pendCx.length === 1 && pendCx[0].kind === "analyze_construction_financials");
  const apprCx = await approveCx(orgCx, pendCx[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes construction_runs", apprCx.ok && apprCx.recordTable === "construction_runs", JSON.stringify(apprCx));
  const { data: cxRows } = await db.from("construction_runs").select("org_id,total_contract_value").eq("org_id", orgCx);
  ok("construction record org-stamped", cxRows?.length === 1 && cxRows[0].org_id === orgCx);
  const { routePayload: routeCx } = await import("./lib/manager");
  const routeCheckCx = await routeCx({ orgId: orgCx, payloadId: payloadCx }, { db, enqueue: () => {} });
  ok("construction_agent routes on the financial route", routeCheckCx.ok && routeCheckCx.plan.includes("construction_agent"));
  await db.from("organizations").delete().eq("id", orgCx);

  console.log("== revenue quality agent ==");
  ok("analyze_revenue_quality accepts good", validateProposal("analyze_revenue_quality", {
    recurring_revenue_pct: 82.0, non_recurring_revenue_pct: 18.0, top_customer_concentration_pct: 14.5,
    revenue_predictability_score: 78.0, arr_growth_rate_pct: 34.2, net_revenue_retention_pct: 112.0,
    churn_adjusted_arr: 3850000,
    revenue_by_type: [{ type: "Subscription", amount: 3150000, percentage: 82.0 }],
    data_period: "Q1 2024",
  }).ok);
  ok("analyze_revenue_quality rejects recurring_revenue_pct > 100", !validateProposal("analyze_revenue_quality", {
    recurring_revenue_pct: 150, non_recurring_revenue_pct: 18.0, top_customer_concentration_pct: 14.5,
    revenue_predictability_score: 78.0, arr_growth_rate_pct: 34.2, net_revenue_retention_pct: 112.0,
    churn_adjusted_arr: 3850000, revenue_by_type: [], data_period: "Q1 2024",
  }).ok);
  ok("analyze_revenue_quality rejects top_customer_concentration_pct > 100", !validateProposal("analyze_revenue_quality", {
    recurring_revenue_pct: 82.0, non_recurring_revenue_pct: 18.0, top_customer_concentration_pct: 150,
    revenue_predictability_score: 78.0, arr_growth_rate_pct: 34.2, net_revenue_retention_pct: 112.0,
    churn_adjusted_arr: 3850000, revenue_by_type: [], data_period: "Q1 2024",
  }).ok);
  ok("analyze_revenue_quality filters out revenue_by_type item with negative amount", (() => {
    const r = validateProposal("analyze_revenue_quality", {
      recurring_revenue_pct: 82.0, non_recurring_revenue_pct: 18.0, top_customer_concentration_pct: 14.5,
      revenue_predictability_score: 78.0, arr_growth_rate_pct: 34.2, net_revenue_retention_pct: 112.0,
      churn_adjusted_arr: 3850000,
      revenue_by_type: [
        { type: "Subscription", amount: 3150000, percentage: 82.0 },
        { type: "Bad", amount: -100, percentage: 18.0 },
      ],
      data_period: "Q1 2024",
    });
    return r.ok && (r.payload.revenue_by_type as unknown[]).length === 1;
  })());
  ok("revenue_quality_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("revenue_quality_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentRq } = await import("./lib/run-agent");
  const { stubBrain: sbRq } = await import("./lib/agent-brain");
  const { approveAction: approveRq, listPending: listRq } = await import("./lib/actions-service");
  const orgRq = await makeOrg("pro");
  const payloadRq = await makePayload(orgRq);
  const rRq = await runAgentRq({ orgId: orgRq, payloadId: payloadRq, role: "revenue_quality_agent" }, { db, brain: sbRq });
  ok("revenue_quality_agent run produced an analysis", rRq.ok && rRq.proposalCount === 1);
  const pendRq = await listRq(orgRq, { db });
  ok("stub proposal passes validateProposal and returns analyze_revenue_quality", pendRq.length === 1 && pendRq[0].kind === "analyze_revenue_quality");
  const apprRq = await approveRq(orgRq, pendRq[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes revenue_quality_runs", apprRq.ok && apprRq.recordTable === "revenue_quality_runs", JSON.stringify(apprRq));
  const { data: rqRows } = await db.from("revenue_quality_runs").select("org_id,recurring_revenue_pct").eq("org_id", orgRq);
  ok("revenue quality record org-stamped", rqRows?.length === 1 && rqRows[0].org_id === orgRq);
  const { routePayload: routeRq } = await import("./lib/manager");
  const routeCheckRq = await routeRq({ orgId: orgRq, payloadId: payloadRq }, { db, enqueue: () => {} });
  ok("revenue_quality_agent routes on the financial route", routeCheckRq.ok && routeCheckRq.plan.includes("revenue_quality_agent"));
  await db.from("organizations").delete().eq("id", orgRq);

  console.log("== cohort analysis agent ==");
  ok("analyze_customer_cohorts accepts good", validateProposal("analyze_customer_cohorts", {
    cohorts: [{ cohort_label: "Jan 2023", cohort_size: 25, month_1: 88.0, month_3: 72.0, month_6: 64.0, month_12: 56.0, revenue_at_start: 85000 }],
    cohort_type: "retention", avg_month1_retention: 89.5, avg_month3_retention: 75.0, avg_month6_retention: 67.5, avg_month12_retention: 56.0,
    best_cohort: "Jan 2023", worst_cohort: null, trend: "improving", data_period: "2023-2024",
  }).ok);
  ok("analyze_customer_cohorts rejects bad cohort_type", !validateProposal("analyze_customer_cohorts", {
    cohorts: [{ cohort_label: "Jan 2023", cohort_size: 25, month_1: 88.0, month_3: 72.0, month_6: 64.0, month_12: 56.0, revenue_at_start: 85000 }],
    cohort_type: "engagement", avg_month1_retention: 89.5, avg_month3_retention: 75.0, avg_month6_retention: 67.5, avg_month12_retention: 56.0,
    best_cohort: null, worst_cohort: null, trend: "improving", data_period: "2023-2024",
  }).ok);
  ok("analyze_customer_cohorts rejects bad trend value", !validateProposal("analyze_customer_cohorts", {
    cohorts: [{ cohort_label: "Jan 2023", cohort_size: 25, month_1: 88.0, month_3: 72.0, month_6: 64.0, month_12: 56.0, revenue_at_start: 85000 }],
    cohort_type: "retention", avg_month1_retention: 89.5, avg_month3_retention: 75.0, avg_month6_retention: 67.5, avg_month12_retention: 56.0,
    best_cohort: null, worst_cohort: null, trend: "trending_up", data_period: "2023-2024",
  }).ok);
  ok("analyze_customer_cohorts filters out cohort item with month_1 > 100", (() => {
    const r = validateProposal("analyze_customer_cohorts", {
      cohorts: [
        { cohort_label: "Jan 2023", cohort_size: 25, month_1: 88.0, month_3: 72.0, month_6: 64.0, month_12: 56.0, revenue_at_start: 85000 },
        { cohort_label: "Feb 2023", cohort_size: 20, month_1: 150.0, month_3: 72.0, month_6: 64.0, month_12: 56.0, revenue_at_start: 60000 },
      ],
      cohort_type: "retention", avg_month1_retention: 89.5, avg_month3_retention: 75.0, avg_month6_retention: 67.5, avg_month12_retention: 56.0,
      best_cohort: null, worst_cohort: null, trend: "stable", data_period: "2023-2024",
    });
    return r.ok && (r.payload.cohorts as unknown[]).length === 1;
  })());
  ok("cohort_analysis_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("cohort_analysis_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentCca } = await import("./lib/run-agent");
  const { stubBrain: sbCca } = await import("./lib/agent-brain");
  const { approveAction: approveCca, listPending: listCca } = await import("./lib/actions-service");
  const orgCca = await makeOrg("pro");
  const payloadCca = await makePayload(orgCca);
  const rCca = await runAgentCca({ orgId: orgCca, payloadId: payloadCca, role: "cohort_analysis_agent" }, { db, brain: sbCca });
  ok("cohort_analysis_agent run produced an analysis", rCca.ok && rCca.proposalCount === 1);
  const pendCca = await listCca(orgCca, { db });
  ok("stub proposal passes validateProposal and returns analyze_customer_cohorts", pendCca.length === 1 && pendCca[0].kind === "analyze_customer_cohorts");
  const apprCca = await approveCca(orgCca, pendCca[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes customer_cohort_runs", apprCca.ok && apprCca.recordTable === "customer_cohort_runs", JSON.stringify(apprCca));
  const { data: ccaRows } = await db.from("customer_cohort_runs").select("org_id,cohort_type").eq("org_id", orgCca);
  ok("cohort analysis record org-stamped", ccaRows?.length === 1 && ccaRows[0].org_id === orgCca);
  const { routePayload: routeCca } = await import("./lib/manager");
  const routeCheckCca = await routeCca({ orgId: orgCca, payloadId: payloadCca }, { db, enqueue: () => {} });
  ok("cohort_analysis_agent routes on the financial route", routeCheckCca.ok && routeCheckCca.plan.includes("cohort_analysis_agent"));
  await db.from("organizations").delete().eq("id", orgCca);

  console.log("== variance analysis agent ==");
  ok("analyze_variances accepts good", validateProposal("analyze_variances", {
    variances: [{ line_item: "Software Revenue", budget: 500000, actual: 548000, variance: 48000, variance_pct: 9.6, direction: "favorable" }],
    total_budget: 500000, total_actual: 548000, total_variance: 48000, total_variance_pct: 9.6,
    favorable_count: 1, unfavorable_count: 0,
    significant_variances: ["Software Revenue up 9.6%"], root_causes: ["strong quarter"], period: "Q1 2024",
  }).ok);
  ok("analyze_variances filters out variance item with bad direction", (() => {
    const r = validateProposal("analyze_variances", {
      variances: [
        { line_item: "Revenue", budget: 500000, actual: 548000, variance: 48000, variance_pct: 9.6, direction: "favorable" },
        { line_item: "Bad", budget: 100, actual: 100, variance: 0, variance_pct: 0, direction: "mixed" },
      ],
      total_budget: 500100, total_actual: 548100, total_variance: 48000, total_variance_pct: 9.6,
      favorable_count: 1, unfavorable_count: 0, significant_variances: [], root_causes: [], period: "Q1 2024",
    });
    return r.ok && (r.payload.variances as unknown[]).length === 1;
  })());
  ok("analyze_variances rejects empty period", !validateProposal("analyze_variances", {
    variances: [], total_budget: 0, total_actual: 0, total_variance: 0, total_variance_pct: 0,
    favorable_count: 0, unfavorable_count: 0, significant_variances: [], root_causes: [], period: "",
  }).ok);
  ok("analyze_variances rejects negative favorable_count", !validateProposal("analyze_variances", {
    variances: [], total_budget: 0, total_actual: 0, total_variance: 0, total_variance_pct: 0,
    favorable_count: -1, unfavorable_count: 0, significant_variances: [], root_causes: [], period: "Q1 2024",
  }).ok);
  ok("variance_analysis_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("variance_analysis_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentVa } = await import("./lib/run-agent");
  const { stubBrain: sbVa } = await import("./lib/agent-brain");
  const { approveAction: approveVa, listPending: listVa } = await import("./lib/actions-service");
  const orgVa = await makeOrg("pro");
  const payloadVa = await makePayload(orgVa);
  const rVa = await runAgentVa({ orgId: orgVa, payloadId: payloadVa, role: "variance_analysis_agent" }, { db, brain: sbVa });
  ok("variance_analysis_agent run produced an analysis", rVa.ok && rVa.proposalCount === 1);
  const pendVa = await listVa(orgVa, { db });
  ok("stub proposal passes validateProposal and returns analyze_variances", pendVa.length === 1 && pendVa[0].kind === "analyze_variances");
  const apprVa = await approveVa(orgVa, pendVa[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes variance_analysis_runs", apprVa.ok && apprVa.recordTable === "variance_analysis_runs", JSON.stringify(apprVa));
  const { data: vaRows } = await db.from("variance_analysis_runs").select("org_id,total_variance").eq("org_id", orgVa);
  ok("variance analysis record org-stamped", vaRows?.length === 1 && vaRows[0].org_id === orgVa);
  const { routePayload: routeVa } = await import("./lib/manager");
  const routeCheckVa = await routeVa({ orgId: orgVa, payloadId: payloadVa }, { db, enqueue: () => {} });
  ok("variance_analysis_agent routes on the financial route", routeCheckVa.ok && routeCheckVa.plan.includes("variance_analysis_agent"));
  await db.from("organizations").delete().eq("id", orgVa);

  console.log("== cash flow forecast agent ==");
  ok("forecast_cash_flow accepts good", validateProposal("forecast_cash_flow", {
    opening_cash_balance: 850000,
    weekly_forecast: [{ week_label: "Week 1", inflows: 95000, outflows: 78000, net: 17000, closing_balance: 867000 }],
    total_inflows: 95000, total_outflows: 78000, closing_cash_balance: 867000,
    minimum_cash_week: "Week 1", minimum_cash_amount: 867000, cash_constraint_risk: "none",
    assumptions: ["AR collected per aging schedule"],
  }).ok);
  ok("forecast_cash_flow rejects bad cash_constraint_risk", !validateProposal("forecast_cash_flow", {
    opening_cash_balance: 850000,
    weekly_forecast: [{ week_label: "Week 1", inflows: 95000, outflows: 78000, net: 17000, closing_balance: 867000 }],
    total_inflows: 95000, total_outflows: 78000, closing_cash_balance: 867000,
    minimum_cash_week: "Week 1", minimum_cash_amount: 867000, cash_constraint_risk: "severe",
    assumptions: [],
  }).ok);
  ok("forecast_cash_flow filters out weekly_forecast item with negative inflows", (() => {
    const r = validateProposal("forecast_cash_flow", {
      opening_cash_balance: 850000,
      weekly_forecast: [
        { week_label: "Week 1", inflows: 95000, outflows: 78000, net: 17000, closing_balance: 867000 },
        { week_label: "Week 2", inflows: -5000, outflows: 78000, net: -83000, closing_balance: 784000 },
      ],
      total_inflows: 95000, total_outflows: 156000, closing_cash_balance: 784000,
      minimum_cash_week: "Week 2", minimum_cash_amount: 784000, cash_constraint_risk: "low",
      assumptions: [],
    });
    return r.ok && (r.payload.weekly_forecast as unknown[]).length === 1;
  })());
  ok("forecast_cash_flow rejects empty weekly_forecast array", !validateProposal("forecast_cash_flow", {
    opening_cash_balance: 850000, weekly_forecast: [],
    total_inflows: 0, total_outflows: 0, closing_cash_balance: 850000,
    minimum_cash_week: null, minimum_cash_amount: 850000, cash_constraint_risk: "none",
    assumptions: [],
  }).ok);
  ok("cash_flow_forecast_agent → opus model",
    (await import("./lib/agent-brain")).modelForRole("cash_flow_forecast_agent") === "claude-opus-4-8");

  const { runAgent: runAgentCff } = await import("./lib/run-agent");
  const { stubBrain: sbCff } = await import("./lib/agent-brain");
  const { approveAction: approveCff, listPending: listCff } = await import("./lib/actions-service");
  const orgCff = await makeOrg("pro");
  const payloadCff = await makePayload(orgCff);
  const rCff = await runAgentCff({ orgId: orgCff, payloadId: payloadCff, role: "cash_flow_forecast_agent" }, { db, brain: sbCff });
  ok("cash_flow_forecast_agent run produced an analysis", rCff.ok && rCff.proposalCount === 1);
  const pendCff = await listCff(orgCff, { db });
  ok("stub proposal passes validateProposal and returns forecast_cash_flow", pendCff.length === 1 && pendCff[0].kind === "forecast_cash_flow");
  const apprCff = await approveCff(orgCff, pendCff[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes cash_flow_forecast_runs", apprCff.ok && apprCff.recordTable === "cash_flow_forecast_runs", JSON.stringify(apprCff));
  const { data: cffRows } = await db.from("cash_flow_forecast_runs").select("org_id,closing_cash_balance").eq("org_id", orgCff);
  ok("cash flow forecast record org-stamped", cffRows?.length === 1 && cffRows[0].org_id === orgCff);
  const { routePayload: routeCff } = await import("./lib/manager");
  const routeCheckCff = await routeCff({ orgId: orgCff, payloadId: payloadCff }, { db, enqueue: () => {} });
  ok("cash_flow_forecast_agent routes on the financial route", routeCheckCff.ok && routeCheckCff.plan.includes("cash_flow_forecast_agent"));
  await db.from("organizations").delete().eq("id", orgCff);

  console.log("== expense forecast agent ==");
  ok("forecast_expenses accepts good", validateProposal("forecast_expenses", {
    historical_monthly_avg: 245000,
    forecast_periods: [{ period_label: "April 2024", forecast_amount: 258000, growth_applied: 2.1 }],
    total_forecast_amount: 258000, growth_rate_applied: 2.1,
    largest_categories: [{ category: "Payroll", monthly_avg: 155000, forecast_next_period: 163000 }],
    fixed_vs_variable: { fixed: 180000, variable: 45000, semi_variable: 20000 },
    confidence: "medium", period_label: "April 2024",
  }).ok);
  ok("forecast_expenses rejects bad confidence value", !validateProposal("forecast_expenses", {
    historical_monthly_avg: 245000,
    forecast_periods: [{ period_label: "April 2024", forecast_amount: 258000, growth_applied: 2.1 }],
    total_forecast_amount: 258000, growth_rate_applied: 2.1,
    largest_categories: [], fixed_vs_variable: { fixed: 180000, variable: 45000, semi_variable: 20000 },
    confidence: "very_high", period_label: "April 2024",
  }).ok);
  ok("forecast_expenses rejects missing fixed_vs_variable object", !validateProposal("forecast_expenses", {
    historical_monthly_avg: 245000,
    forecast_periods: [{ period_label: "April 2024", forecast_amount: 258000, growth_applied: 2.1 }],
    total_forecast_amount: 258000, growth_rate_applied: 2.1,
    largest_categories: [], fixed_vs_variable: null,
    confidence: "medium", period_label: "April 2024",
  }).ok);
  ok("forecast_expenses filters out forecast_period item with negative forecast_amount", (() => {
    const r = validateProposal("forecast_expenses", {
      historical_monthly_avg: 245000,
      forecast_periods: [
        { period_label: "April 2024", forecast_amount: 258000, growth_applied: 2.1 },
        { period_label: "May 2024", forecast_amount: -1000, growth_applied: 2.1 },
      ],
      total_forecast_amount: 258000, growth_rate_applied: 2.1,
      largest_categories: [], fixed_vs_variable: { fixed: 180000, variable: 45000, semi_variable: 20000 },
      confidence: "medium", period_label: "April 2024",
    });
    return r.ok && (r.payload.forecast_periods as unknown[]).length === 1;
  })());
  ok("expense_forecast_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("expense_forecast_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentEf } = await import("./lib/run-agent");
  const { stubBrain: sbEf } = await import("./lib/agent-brain");
  const { approveAction: approveEf, listPending: listEf } = await import("./lib/actions-service");
  const orgEf = await makeOrg("pro");
  const payloadEf = await makePayload(orgEf);
  const rEf = await runAgentEf({ orgId: orgEf, payloadId: payloadEf, role: "expense_forecast_agent" }, { db, brain: sbEf });
  ok("expense_forecast_agent run produced an analysis", rEf.ok && rEf.proposalCount === 1);
  const pendEf = await listEf(orgEf, { db });
  ok("stub proposal passes validateProposal and returns forecast_expenses", pendEf.length === 1 && pendEf[0].kind === "forecast_expenses");
  const apprEf = await approveEf(orgEf, pendEf[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes expense_forecast_runs", apprEf.ok && apprEf.recordTable === "expense_forecast_runs", JSON.stringify(apprEf));
  const { data: efRows } = await db.from("expense_forecast_runs").select("org_id,total_forecast_amount").eq("org_id", orgEf);
  ok("expense forecast record org-stamped", efRows?.length === 1 && efRows[0].org_id === orgEf);
  const { routePayload: routeEf } = await import("./lib/manager");
  const routeCheckEf = await routeEf({ orgId: orgEf, payloadId: payloadEf }, { db, enqueue: () => {} });
  ok("expense_forecast_agent routes on the financial route", routeCheckEf.ok && routeCheckEf.plan.includes("expense_forecast_agent"));
  await db.from("organizations").delete().eq("id", orgEf);

  console.log("== headcount analysis agent ==");
  ok("analyze_headcount accepts good", validateProposal("analyze_headcount", {
    total_headcount: 42, total_payroll_cost: 485000, cost_per_head: 11548,
    by_department: [{ dept: "Engineering", headcount: 18, total_cost: 248000, avg_cost: 13778 }],
    by_level: [{ level: "IC", headcount: 34, avg_cost: 10800 }],
    headcount_revenue_ratio: 21429, compensation_revenue_pct: 42.5, open_roles: 5, attrition_rate: 12.0, period: "Q1 2024",
  }).ok);
  ok("analyze_headcount rejects compensation_revenue_pct > 100", !validateProposal("analyze_headcount", {
    total_headcount: 42, total_payroll_cost: 485000, cost_per_head: 11548,
    by_department: [], by_level: [],
    headcount_revenue_ratio: 21429, compensation_revenue_pct: 150, open_roles: 5, attrition_rate: 12.0, period: "Q1 2024",
  }).ok);
  ok("analyze_headcount rejects attrition_rate > 100", !validateProposal("analyze_headcount", {
    total_headcount: 42, total_payroll_cost: 485000, cost_per_head: 11548,
    by_department: [], by_level: [],
    headcount_revenue_ratio: 21429, compensation_revenue_pct: 42.5, open_roles: 5, attrition_rate: 150, period: "Q1 2024",
  }).ok);
  ok("analyze_headcount filters out by_department item with negative total_cost", (() => {
    const r = validateProposal("analyze_headcount", {
      total_headcount: 42, total_payroll_cost: 485000, cost_per_head: 11548,
      by_department: [
        { dept: "Engineering", headcount: 18, total_cost: 248000, avg_cost: 13778 },
        { dept: "Bad", headcount: 5, total_cost: -1000, avg_cost: -200 },
      ],
      by_level: [],
      headcount_revenue_ratio: 21429, compensation_revenue_pct: 42.5, open_roles: 5, attrition_rate: 12.0, period: "Q1 2024",
    });
    return r.ok && (r.payload.by_department as unknown[]).length === 1;
  })());
  ok("headcount_analysis_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("headcount_analysis_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentHan } = await import("./lib/run-agent");
  const { stubBrain: sbHan } = await import("./lib/agent-brain");
  const { approveAction: approveHan, listPending: listHan } = await import("./lib/actions-service");
  const orgHan = await makeOrg("pro");
  const payloadHan = await makePayload(orgHan);
  const rHan = await runAgentHan({ orgId: orgHan, payloadId: payloadHan, role: "headcount_analysis_agent" }, { db, brain: sbHan });
  ok("headcount_analysis_agent run produced an analysis", rHan.ok && rHan.proposalCount === 1);
  const pendHan = await listHan(orgHan, { db });
  ok("stub proposal passes validateProposal and returns analyze_headcount", pendHan.length === 1 && pendHan[0].kind === "analyze_headcount");
  const apprHan = await approveHan(orgHan, pendHan[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes headcount_analysis_runs", apprHan.ok && apprHan.recordTable === "headcount_analysis_runs", JSON.stringify(apprHan));
  const { data: hanRows } = await db.from("headcount_analysis_runs").select("org_id,total_headcount").eq("org_id", orgHan);
  ok("headcount analysis record org-stamped", hanRows?.length === 1 && hanRows[0].org_id === orgHan);
  const { routePayload: routeHan } = await import("./lib/manager");
  const routeCheckHanFin = await routeHan({ orgId: orgHan, payloadId: payloadHan }, { db, enqueue: () => {} });
  const { data: plainPayloadHan } = await db.from("inbound_payloads").insert({
    org_id: orgHan, source: "upload", storage_path: `${orgHan}/han/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckHanNonFin = await routeHan({ orgId: orgHan, payloadId: plainPayloadHan!.id }, { db, enqueue: () => {} });
  ok("headcount_analysis_agent routes on BOTH the financial and non-financial route",
    routeCheckHanFin.ok && routeCheckHanFin.plan.includes("headcount_analysis_agent") &&
    routeCheckHanNonFin.ok && routeCheckHanNonFin.plan.includes("headcount_analysis_agent"));
  await db.from("organizations").delete().eq("id", orgHan);

  console.log("== debt covenant agent ==");
  ok("analyze_debt_covenants accepts good", validateProposal("analyze_debt_covenants", {
    covenants: [{ covenant_name: "Minimum DSCR", metric_type: "dscr", threshold: 1.25, current_value: 1.42, headroom_pct: 13.6, status: "compliant", next_test_date: "2024-06-30" }],
    overall_status: "compliant", breach_count: 0, at_risk_count: 0, nearest_breach: null,
    total_debt_outstanding: 2500000, debt_service_coverage_ratio: 1.42, recommendations: [],
  }).ok);
  ok("analyze_debt_covenants rejects bad overall_status", !validateProposal("analyze_debt_covenants", {
    covenants: [], overall_status: "healthy", breach_count: 0, at_risk_count: 0, nearest_breach: null,
    total_debt_outstanding: 2500000, debt_service_coverage_ratio: 1.42, recommendations: [],
  }).ok);
  ok("analyze_debt_covenants filters out covenant item with bad status", (() => {
    const r = validateProposal("analyze_debt_covenants", {
      covenants: [
        { covenant_name: "Minimum DSCR", metric_type: "dscr", threshold: 1.25, current_value: 1.42, headroom_pct: 13.6, status: "compliant", next_test_date: null },
        { covenant_name: "Bad", metric_type: "x", threshold: 1, current_value: 1, headroom_pct: 0, status: "unknown_status", next_test_date: null },
      ],
      overall_status: "compliant", breach_count: 0, at_risk_count: 0, nearest_breach: null,
      total_debt_outstanding: 2500000, debt_service_coverage_ratio: 1.42, recommendations: [],
    });
    return r.ok && (r.payload.covenants as unknown[]).length === 1;
  })());
  ok("analyze_debt_covenants rejects negative breach_count", !validateProposal("analyze_debt_covenants", {
    covenants: [], overall_status: "compliant", breach_count: -1, at_risk_count: 0, nearest_breach: null,
    total_debt_outstanding: 2500000, debt_service_coverage_ratio: 1.42, recommendations: [],
  }).ok);
  ok("debt_covenant_agent → opus model",
    (await import("./lib/agent-brain")).modelForRole("debt_covenant_agent") === "claude-opus-4-8");

  const { runAgent: runAgentDbc } = await import("./lib/run-agent");
  const { stubBrain: sbDbc } = await import("./lib/agent-brain");
  const { approveAction: approveDbc, listPending: listDbc } = await import("./lib/actions-service");
  const orgDbc = await makeOrg("pro");
  const payloadDbc = await makePayload(orgDbc);
  const rDbc = await runAgentDbc({ orgId: orgDbc, payloadId: payloadDbc, role: "debt_covenant_agent" }, { db, brain: sbDbc });
  ok("debt_covenant_agent run produced an analysis", rDbc.ok && rDbc.proposalCount === 1);
  const pendDbc = await listDbc(orgDbc, { db });
  ok("stub proposal passes validateProposal and returns analyze_debt_covenants", pendDbc.length === 1 && pendDbc[0].kind === "analyze_debt_covenants");
  const apprDbc = await approveDbc(orgDbc, pendDbc[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes debt_covenant_runs", apprDbc.ok && apprDbc.recordTable === "debt_covenant_runs", JSON.stringify(apprDbc));
  const { data: dbcRows } = await db.from("debt_covenant_runs").select("org_id,overall_status").eq("org_id", orgDbc);
  ok("debt covenant record org-stamped", dbcRows?.length === 1 && dbcRows[0].org_id === orgDbc);
  const { routePayload: routeDbc } = await import("./lib/manager");
  const routeCheckDbc = await routeDbc({ orgId: orgDbc, payloadId: payloadDbc }, { db, enqueue: () => {} });
  ok("debt_covenant_agent routes on the financial route", routeCheckDbc.ok && routeCheckDbc.plan.includes("debt_covenant_agent"));
  await db.from("organizations").delete().eq("id", orgDbc);

  console.log("== tax provision agent ==");
  ok("analyze_tax_provision accepts good", validateProposal("analyze_tax_provision", {
    pre_tax_income: 420000, estimated_tax_provision: 88200, effective_tax_rate: 21.0, statutory_rate: 21.0,
    rate_reconciliation: [{ item: "Federal statutory rate", amount: 88200, rate_impact: 21.0 }],
    deferred_tax_assets: [{ item: "NOL carryforward", amount: 45000, description: "from prior year losses" }],
    deferred_tax_liabilities: [{ item: "Accelerated depreciation", amount: 12000, description: "bonus depreciation" }],
    net_deferred_tax_position: 33000, tax_risk_flags: [], period: "FY2023",
  }).ok);
  ok("analyze_tax_provision rejects statutory_rate > 100", !validateProposal("analyze_tax_provision", {
    pre_tax_income: 420000, estimated_tax_provision: 88200, effective_tax_rate: 21.0, statutory_rate: 150,
    rate_reconciliation: [], deferred_tax_assets: [], deferred_tax_liabilities: [],
    net_deferred_tax_position: 0, tax_risk_flags: [], period: "FY2023",
  }).ok);
  ok("analyze_tax_provision filters out deferred_tax_asset item with negative amount", (() => {
    const r = validateProposal("analyze_tax_provision", {
      pre_tax_income: 420000, estimated_tax_provision: 88200, effective_tax_rate: 21.0, statutory_rate: 21.0,
      rate_reconciliation: [],
      deferred_tax_assets: [
        { item: "NOL carryforward", amount: 45000, description: "prior year losses" },
        { item: "Bad", amount: -100, description: "invalid" },
      ],
      deferred_tax_liabilities: [], net_deferred_tax_position: 45000, tax_risk_flags: [], period: "FY2023",
    });
    return r.ok && (r.payload.deferred_tax_assets as unknown[]).length === 1;
  })());
  ok("analyze_tax_provision rejects empty period", !validateProposal("analyze_tax_provision", {
    pre_tax_income: 420000, estimated_tax_provision: 88200, effective_tax_rate: 21.0, statutory_rate: 21.0,
    rate_reconciliation: [], deferred_tax_assets: [], deferred_tax_liabilities: [],
    net_deferred_tax_position: 0, tax_risk_flags: [], period: "",
  }).ok);
  ok("tax_provision_agent → opus model",
    (await import("./lib/agent-brain")).modelForRole("tax_provision_agent") === "claude-opus-4-8");

  const { runAgent: runAgentTp } = await import("./lib/run-agent");
  const { stubBrain: sbTp } = await import("./lib/agent-brain");
  const { approveAction: approveTp, listPending: listTp } = await import("./lib/actions-service");
  const orgTp = await makeOrg("pro");
  const payloadTp = await makePayload(orgTp);
  const rTp = await runAgentTp({ orgId: orgTp, payloadId: payloadTp, role: "tax_provision_agent" }, { db, brain: sbTp });
  ok("tax_provision_agent run produced an analysis", rTp.ok && rTp.proposalCount === 1);
  const pendTp = await listTp(orgTp, { db });
  ok("stub proposal passes validateProposal and returns analyze_tax_provision", pendTp.length === 1 && pendTp[0].kind === "analyze_tax_provision");
  const apprTp = await approveTp(orgTp, pendTp[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes tax_provision_runs", apprTp.ok && apprTp.recordTable === "tax_provision_runs", JSON.stringify(apprTp));
  const { data: tpRows } = await db.from("tax_provision_runs").select("org_id,pre_tax_income").eq("org_id", orgTp);
  ok("tax provision record org-stamped", tpRows?.length === 1 && tpRows[0].org_id === orgTp);
  const { routePayload: routeTp } = await import("./lib/manager");
  const routeCheckTp = await routeTp({ orgId: orgTp, payloadId: payloadTp }, { db, enqueue: () => {} });
  ok("tax_provision_agent routes on the financial route", routeCheckTp.ok && routeCheckTp.plan.includes("tax_provision_agent"));
  await db.from("organizations").delete().eq("id", orgTp);

  console.log("== collections agent ==");
  ok("manage_collections accepts good", validateProposal("manage_collections", {
    total_ar_balance: 485000, overdue_balance: 185000, overdue_pct: 38.1,
    priority_accounts: [{ customer_name: "Acme Corp", balance: 85000, days_overdue: 72, priority: "critical", action_recommended: "escalate" }],
    aging_summary: [{ bucket: "Current", balance: 300000, count: 12 }],
    collection_drafts: [{ customer_name: "Acme Corp", draft_message: "Outstanding balance reminder." }],
    avg_days_outstanding: 28.4,
  }).ok);
  ok("manage_collections rejects overdue_pct > 100", !validateProposal("manage_collections", {
    total_ar_balance: 485000, overdue_balance: 185000, overdue_pct: 150,
    priority_accounts: [], aging_summary: [], collection_drafts: [], avg_days_outstanding: 28.4,
  }).ok);
  ok("manage_collections filters out priority_account item with bad priority", (() => {
    const r = validateProposal("manage_collections", {
      total_ar_balance: 485000, overdue_balance: 185000, overdue_pct: 38.1,
      priority_accounts: [
        { customer_name: "Acme Corp", balance: 85000, days_overdue: 72, priority: "critical", action_recommended: "escalate" },
        { customer_name: "Bad Co", balance: 1000, days_overdue: 5, priority: "urgent", action_recommended: "x" },
      ],
      aging_summary: [], collection_drafts: [], avg_days_outstanding: 28.4,
    });
    return r.ok && (r.payload.priority_accounts as unknown[]).length === 1;
  })());
  ok("manage_collections filters out aging_summary item with negative balance", (() => {
    const r = validateProposal("manage_collections", {
      total_ar_balance: 485000, overdue_balance: 185000, overdue_pct: 38.1,
      priority_accounts: [], aging_summary: [
        { bucket: "Current", balance: 300000, count: 12 },
        { bucket: "Bad", balance: -100, count: 1 },
      ],
      collection_drafts: [], avg_days_outstanding: 28.4,
    });
    return r.ok && (r.payload.aging_summary as unknown[]).length === 1;
  })());
  ok("collections_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("collections_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentCo } = await import("./lib/run-agent");
  const { stubBrain: sbCo } = await import("./lib/agent-brain");
  const { approveAction: approveCo, listPending: listCo } = await import("./lib/actions-service");
  const orgCo = await makeOrg("pro");
  const payloadCo = await makePayload(orgCo);
  const rCo = await runAgentCo({ orgId: orgCo, payloadId: payloadCo, role: "collections_agent" }, { db, brain: sbCo });
  ok("collections_agent run produced an analysis", rCo.ok && rCo.proposalCount === 1);
  const pendCo = await listCo(orgCo, { db });
  ok("stub proposal passes validateProposal and returns manage_collections", pendCo.length === 1 && pendCo[0].kind === "manage_collections");
  const apprCo = await approveCo(orgCo, pendCo[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes collections_runs", apprCo.ok && apprCo.recordTable === "collections_runs", JSON.stringify(apprCo));
  const { data: coRows } = await db.from("collections_runs").select("org_id,overdue_pct").eq("org_id", orgCo);
  ok("collections record org-stamped", coRows?.length === 1 && coRows[0].org_id === orgCo);
  const { routePayload: routeCo } = await import("./lib/manager");
  const routeCheckCo = await routeCo({ orgId: orgCo, payloadId: payloadCo }, { db, enqueue: () => {} });
  ok("collections_agent routes on the financial route", routeCheckCo.ok && routeCheckCo.plan.includes("collections_agent"));
  await db.from("organizations").delete().eq("id", orgCo);

  console.log("== competitive benchmarking agent ==");
  ok("benchmark_competitive accepts good", validateProposal("benchmark_competitive", {
    client_metrics: [{ metric_name: "Gross Margin", value: 72.0, unit: "%" }],
    benchmark_comparisons: [{ metric_name: "Gross Margin", client_value: 72.0, industry_median: 74.0, top_quartile: 80.0, bottom_quartile: 60.0, client_percentile: 45.0, assessment: "below_median" }],
    performance_quartile: "above_average", strengths: [], weaknesses: [], industry_context: "B2B SaaS", data_period: "Q1 2024",
  }).ok);
  ok("benchmark_competitive rejects bad performance_quartile", !validateProposal("benchmark_competitive", {
    client_metrics: [], benchmark_comparisons: [], performance_quartile: "excellent", strengths: [], weaknesses: [], industry_context: "B2B SaaS", data_period: "Q1 2024",
  }).ok);
  ok("benchmark_competitive filters out benchmark_comparison item with bad assessment", (() => {
    const r = validateProposal("benchmark_competitive", {
      client_metrics: [],
      benchmark_comparisons: [
        { metric_name: "Gross Margin", client_value: 72.0, industry_median: 74.0, top_quartile: 80.0, bottom_quartile: 60.0, client_percentile: 45.0, assessment: "below_median" },
        { metric_name: "Bad", client_value: 1, industry_median: 1, top_quartile: 1, bottom_quartile: 1, client_percentile: 1, assessment: "phenomenal" },
      ],
      performance_quartile: "mixed", strengths: [], weaknesses: [], industry_context: "B2B SaaS", data_period: "Q1 2024",
    });
    return r.ok && (r.payload.benchmark_comparisons as unknown[]).length === 1;
  })());
  ok("benchmark_competitive rejects empty industry_context", !validateProposal("benchmark_competitive", {
    client_metrics: [], benchmark_comparisons: [], performance_quartile: "mixed", strengths: [], weaknesses: [], industry_context: "", data_period: "Q1 2024",
  }).ok);
  ok("competitive_benchmarking_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("competitive_benchmarking_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentCb } = await import("./lib/run-agent");
  const { stubBrain: sbCb } = await import("./lib/agent-brain");
  const { approveAction: approveCb, listPending: listCb } = await import("./lib/actions-service");
  const orgCb = await makeOrg("pro");
  const payloadCb = await makePayload(orgCb);
  const rCb = await runAgentCb({ orgId: orgCb, payloadId: payloadCb, role: "competitive_benchmarking_agent" }, { db, brain: sbCb });
  ok("competitive_benchmarking_agent run produced an analysis", rCb.ok && rCb.proposalCount === 1);
  const pendCb = await listCb(orgCb, { db });
  ok("stub proposal passes validateProposal and returns benchmark_competitive", pendCb.length === 1 && pendCb[0].kind === "benchmark_competitive");
  const apprCb = await approveCb(orgCb, pendCb[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes competitive_benchmarking_runs", apprCb.ok && apprCb.recordTable === "competitive_benchmarking_runs", JSON.stringify(apprCb));
  const { data: cbRows } = await db.from("competitive_benchmarking_runs").select("org_id,performance_quartile").eq("org_id", orgCb);
  ok("competitive benchmarking record org-stamped", cbRows?.length === 1 && cbRows[0].org_id === orgCb);
  const { routePayload: routeCb } = await import("./lib/manager");
  const routeCheckCbFin = await routeCb({ orgId: orgCb, payloadId: payloadCb }, { db, enqueue: () => {} });
  const { data: plainPayloadCb } = await db.from("inbound_payloads").insert({
    org_id: orgCb, source: "upload", storage_path: `${orgCb}/cb/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckCbNonFin = await routeCb({ orgId: orgCb, payloadId: plainPayloadCb!.id }, { db, enqueue: () => {} });
  ok("competitive_benchmarking_agent routes on BOTH the financial and non-financial route",
    routeCheckCbFin.ok && routeCheckCbFin.plan.includes("competitive_benchmarking_agent") &&
    routeCheckCbNonFin.ok && routeCheckCbNonFin.plan.includes("competitive_benchmarking_agent"));
  await db.from("organizations").delete().eq("id", orgCb);

  console.log("== data quality agent ==");
  ok("evaluate_data_quality accepts good", validateProposal("evaluate_data_quality", {
    overall_score: 82, row_count: 847, column_count: 12, completeness_score: 88, consistency_score: 76, outlier_count: 3,
    issues: [{ issue_type: "Missing values", description: "12% of Amount column is null", severity: "medium", affected_columns: ["Amount"] }],
    usable_for_analysis: true, recommended_agents: ["collections_agent", "ratio_analysis_agent"],
  }).ok);
  ok("evaluate_data_quality rejects overall_score > 100", !validateProposal("evaluate_data_quality", {
    overall_score: 101, row_count: 847, column_count: 12, completeness_score: 88, consistency_score: 76, outlier_count: 3,
    issues: [], usable_for_analysis: true, recommended_agents: [],
  }).ok);
  ok("evaluate_data_quality rejects overall_score < 0", !validateProposal("evaluate_data_quality", {
    overall_score: -1, row_count: 847, column_count: 12, completeness_score: 88, consistency_score: 76, outlier_count: 3,
    issues: [], usable_for_analysis: true, recommended_agents: [],
  }).ok);
  ok("evaluate_data_quality filters out issue item with bad severity", (() => {
    const r = validateProposal("evaluate_data_quality", {
      overall_score: 82, row_count: 847, column_count: 12, completeness_score: 88, consistency_score: 76, outlier_count: 3,
      issues: [
        { issue_type: "Missing values", description: "12% of Amount column is null", severity: "medium", affected_columns: ["Amount"] },
        { issue_type: "Bad", description: "bad severity", severity: "catastrophic", affected_columns: [] },
      ],
      usable_for_analysis: true, recommended_agents: [],
    });
    return r.ok && (r.payload.issues as unknown[]).length === 1;
  })());
  ok("data_quality_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("data_quality_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentDqa } = await import("./lib/run-agent");
  const { stubBrain: sbDqa } = await import("./lib/agent-brain");
  const { approveAction: approveDqa, listPending: listDqa } = await import("./lib/actions-service");
  const orgDqa = await makeOrg("pro");
  const payloadDqa = await makePayload(orgDqa);
  const rDqa = await runAgentDqa({ orgId: orgDqa, payloadId: payloadDqa, role: "data_quality_agent" }, { db, brain: sbDqa });
  ok("data_quality_agent run produced an assessment", rDqa.ok && rDqa.proposalCount === 1);
  const pendDqa = await listDqa(orgDqa, { db });
  ok("stub proposal passes validateProposal and returns evaluate_data_quality", pendDqa.length === 1 && pendDqa[0].kind === "evaluate_data_quality");
  const apprDqa = await approveDqa(orgDqa, pendDqa[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes data_quality_runs", apprDqa.ok && apprDqa.recordTable === "data_quality_runs", JSON.stringify(apprDqa));
  const { data: dqaRows } = await db.from("data_quality_runs").select("org_id,overall_score").eq("org_id", orgDqa);
  ok("data quality record org-stamped", dqaRows?.length === 1 && dqaRows[0].org_id === orgDqa);
  const { routePayload: routeDqa } = await import("./lib/manager");
  const routeCheckDqaFin = await routeDqa({ orgId: orgDqa, payloadId: payloadDqa }, { db, enqueue: () => {} });
  const { data: plainPayloadDqa } = await db.from("inbound_payloads").insert({
    org_id: orgDqa, source: "upload", storage_path: `${orgDqa}/dqa/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckDqaNonFin = await routeDqa({ orgId: orgDqa, payloadId: plainPayloadDqa!.id }, { db, enqueue: () => {} });
  ok("data_quality_agent routes on BOTH the financial and non-financial route, and is FIRST in the plan",
    routeCheckDqaFin.ok && routeCheckDqaFin.plan[0] === "data_quality_agent" &&
    routeCheckDqaNonFin.ok && routeCheckDqaNonFin.plan[0] === "data_quality_agent");
  await db.from("organizations").delete().eq("id", orgDqa);

  console.log("== schema detection agent ==");
  ok("detect_schema accepts good", validateProposal("detect_schema", {
    detected_schema_type: "ar_aging", confidence: "high",
    detected_columns: [{ column_name: "Customer", inferred_type: "string", sample_values: ["Acme Corp", "Beta LLC"] }],
    key_identifiers: ["Days Outstanding", "Balance"], suggested_routing: ["collections_agent"],
    alternative_schema_types: [{ schema_type: "customer_list", confidence: "low" }],
  }).ok);
  ok("detect_schema rejects bad detected_schema_type", !validateProposal("detect_schema", {
    detected_schema_type: "spreadsheet_of_stuff", confidence: "high",
    detected_columns: [], key_identifiers: [], suggested_routing: [], alternative_schema_types: [],
  }).ok);
  ok("detect_schema rejects bad confidence", !validateProposal("detect_schema", {
    detected_schema_type: "ar_aging", confidence: "certain",
    detected_columns: [], key_identifiers: [], suggested_routing: [], alternative_schema_types: [],
  }).ok);
  ok("detect_schema filters out alternative_schema_type item with bad confidence", (() => {
    const r = validateProposal("detect_schema", {
      detected_schema_type: "ar_aging", confidence: "high",
      detected_columns: [], key_identifiers: [], suggested_routing: [],
      alternative_schema_types: [
        { schema_type: "customer_list", confidence: "low" },
        { schema_type: "gl_export", confidence: "certain" },
      ],
    });
    return r.ok && (r.payload.alternative_schema_types as unknown[]).length === 1;
  })());
  ok("schema_detection_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("schema_detection_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentSd } = await import("./lib/run-agent");
  const { stubBrain: sbSd } = await import("./lib/agent-brain");
  const { approveAction: approveSd, listPending: listSd } = await import("./lib/actions-service");
  const orgSd = await makeOrg("pro");
  const payloadSd = await makePayload(orgSd);
  const rSd = await runAgentSd({ orgId: orgSd, payloadId: payloadSd, role: "schema_detection_agent" }, { db, brain: sbSd });
  ok("schema_detection_agent run produced a classification", rSd.ok && rSd.proposalCount === 1);
  const pendSd = await listSd(orgSd, { db });
  ok("stub proposal passes validateProposal and returns detect_schema", pendSd.length === 1 && pendSd[0].kind === "detect_schema");
  const apprSd = await approveSd(orgSd, pendSd[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes schema_detection_runs", apprSd.ok && apprSd.recordTable === "schema_detection_runs", JSON.stringify(apprSd));
  const { data: sdRows } = await db.from("schema_detection_runs").select("org_id,detected_schema_type").eq("org_id", orgSd);
  ok("schema detection record org-stamped", sdRows?.length === 1 && sdRows[0].org_id === orgSd);
  const { routePayload: routeSd } = await import("./lib/manager");
  const routeCheckSdFin = await routeSd({ orgId: orgSd, payloadId: payloadSd }, { db, enqueue: () => {} });
  const { data: plainPayloadSd } = await db.from("inbound_payloads").insert({
    org_id: orgSd, source: "upload", storage_path: `${orgSd}/sd/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckSdNonFin = await routeSd({ orgId: orgSd, payloadId: plainPayloadSd!.id }, { db, enqueue: () => {} });
  ok("schema_detection_agent routes on BOTH the financial and non-financial route, and is SECOND in the plan after data_quality_agent",
    routeCheckSdFin.ok && routeCheckSdFin.plan[1] === "schema_detection_agent" &&
    routeCheckSdNonFin.ok && routeCheckSdNonFin.plan[1] === "schema_detection_agent");
  await db.from("organizations").delete().eq("id", orgSd);

  console.log("== board narrative agent ==");
  ok("draft_board_narrative accepts good", validateProposal("draft_board_narrative", {
    executive_summary: "The company delivered $1.02M ARR in Q1 2024.",
    financial_highlights: [
      { metric: "MRR Growth", value: "8.5% MoM", trend: "up", commentary: "Accelerating." },
      { metric: "Runway", value: "12.6 months", trend: "down", commentary: "Tightening." },
      { metric: "NRR", value: "112%", trend: "up", commentary: "Above median." },
    ],
    key_risks: [{ risk: "Runway below 18mo", impact: "high", mitigation: "Accelerate Series A." }],
    key_opportunities: [{ opportunity: "Enterprise pipeline", potential_impact: "$37k MRR", action_required: "Board intros" }],
    asks_for_board: ["Guidance on Series A timing"],
    narrative_sections: [
      { section_title: "Financial Performance", content: "Q1 closed with MRR of $85,000." },
      { section_title: "Looking Ahead", content: "Targeting $95k MRR by April." },
    ],
    tone: "cautious", period: "Q1 2024",
  }).ok);
  ok("draft_board_narrative rejects empty executive_summary", !validateProposal("draft_board_narrative", {
    executive_summary: "",
    financial_highlights: [
      { metric: "a", value: "a", trend: "up", commentary: "a" },
      { metric: "b", value: "b", trend: "up", commentary: "b" },
      { metric: "c", value: "c", trend: "up", commentary: "c" },
    ],
    key_risks: [{ risk: "r", impact: "high", mitigation: "m" }],
    key_opportunities: [{ opportunity: "o", potential_impact: "p", action_required: "a" }],
    asks_for_board: [],
    narrative_sections: [{ section_title: "s1", content: "c1" }, { section_title: "s2", content: "c2" }],
    tone: "neutral", period: "Q1 2024",
  }).ok);
  ok("draft_board_narrative rejects bad tone", !validateProposal("draft_board_narrative", {
    executive_summary: "summary",
    financial_highlights: [
      { metric: "a", value: "a", trend: "up", commentary: "a" },
      { metric: "b", value: "b", trend: "up", commentary: "b" },
      { metric: "c", value: "c", trend: "up", commentary: "c" },
    ],
    key_risks: [{ risk: "r", impact: "high", mitigation: "m" }],
    key_opportunities: [{ opportunity: "o", potential_impact: "p", action_required: "a" }],
    asks_for_board: [],
    narrative_sections: [{ section_title: "s1", content: "c1" }, { section_title: "s2", content: "c2" }],
    tone: "ecstatic", period: "Q1 2024",
  }).ok);
  ok("draft_board_narrative rejects financial_highlights with fewer than 3 items", !validateProposal("draft_board_narrative", {
    executive_summary: "summary",
    financial_highlights: [{ metric: "a", value: "a", trend: "up", commentary: "a" }],
    key_risks: [{ risk: "r", impact: "high", mitigation: "m" }],
    key_opportunities: [{ opportunity: "o", potential_impact: "p", action_required: "a" }],
    asks_for_board: [],
    narrative_sections: [{ section_title: "s1", content: "c1" }, { section_title: "s2", content: "c2" }],
    tone: "neutral", period: "Q1 2024",
  }).ok);
  ok("board_narrative_agent → opus model",
    (await import("./lib/agent-brain")).modelForRole("board_narrative_agent") === "claude-opus-4-8");

  const { runAgent: runAgentBn } = await import("./lib/run-agent");
  const { stubBrain: sbBn } = await import("./lib/agent-brain");
  const { approveAction: approveBn, listPending: listBn } = await import("./lib/actions-service");
  const orgBn = await makeOrg("pro");
  const payloadBn = await makePayload(orgBn);
  const rBn = await runAgentBn({ orgId: orgBn, payloadId: payloadBn, role: "board_narrative_agent" }, { db, brain: sbBn });
  ok("board_narrative_agent run produced a narrative", rBn.ok && rBn.proposalCount === 1);
  const pendBn = await listBn(orgBn, { db });
  ok("stub proposal passes validateProposal and returns draft_board_narrative", pendBn.length === 1 && pendBn[0].kind === "draft_board_narrative");
  const apprBn = await approveBn(orgBn, pendBn[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes board_narrative_runs", apprBn.ok && apprBn.recordTable === "board_narrative_runs", JSON.stringify(apprBn));
  const { data: bnRows } = await db.from("board_narrative_runs").select("org_id,tone").eq("org_id", orgBn);
  ok("board narrative record org-stamped", bnRows?.length === 1 && bnRows[0].org_id === orgBn);
  const { routePayload: routeBn } = await import("./lib/manager");
  const routeCheckBn = await routeBn({ orgId: orgBn, payloadId: payloadBn }, { db, enqueue: () => {} });
  ok("board_narrative_agent routes on the financial route", routeCheckBn.ok && routeCheckBn.plan.includes("board_narrative_agent"));
  await db.from("organizations").delete().eq("id", orgBn);

  console.log("== investor update agent ==");
  ok("draft_investor_update accepts good", validateProposal("draft_investor_update", {
    subject_line: "March 2024 Update", headline_metric: "MRR grew 8.5%",
    kpi_summary: [
      { kpi: "MRR", value: "$85,000", vs_last_period: "+8.5%" },
      { kpi: "Runway", value: "12.6 months", vs_last_period: "-1.4 months" },
      { kpi: "NRR", value: "112%", vs_last_period: "+4 points" },
    ],
    wins: ["Closed Acme Corp at $80k ACV", "NRR reached 112%"],
    challenges: ["Burn was $95k/month vs $80k planned"],
    asks: [{ ask: "Warm Series A introductions", from_whom: "All investors", context: "Targeting close by Q3" }],
    next_period_targets: [
      { target: "$95k MRR", metric: "MRR", due_date: "April 30, 2024" },
      { target: "15 Series A meetings", metric: "pipeline meetings", due_date: "April 30, 2024" },
    ],
    full_draft: "Hi all — March was our strongest growth month to date.",
    period: "March 2024",
  }).ok);
  ok("draft_investor_update rejects empty subject_line", !validateProposal("draft_investor_update", {
    subject_line: "", headline_metric: "MRR grew 8.5%",
    kpi_summary: [
      { kpi: "MRR", value: "$85,000", vs_last_period: "+8.5%" },
      { kpi: "Runway", value: "12.6 months", vs_last_period: null },
      { kpi: "NRR", value: "112%", vs_last_period: null },
    ],
    wins: ["a", "b"], challenges: ["c"], asks: [{ ask: "a", from_whom: "b", context: "c" }],
    next_period_targets: [{ target: "t1", metric: "m1", due_date: "d1" }, { target: "t2", metric: "m2", due_date: "d2" }],
    full_draft: "draft", period: "March 2024",
  }).ok);
  ok("draft_investor_update rejects wins with fewer than 2 items", !validateProposal("draft_investor_update", {
    subject_line: "subject", headline_metric: "metric",
    kpi_summary: [
      { kpi: "MRR", value: "$85,000", vs_last_period: null },
      { kpi: "Runway", value: "12.6 months", vs_last_period: null },
      { kpi: "NRR", value: "112%", vs_last_period: null },
    ],
    wins: ["only one"], challenges: ["c"], asks: [{ ask: "a", from_whom: "b", context: "c" }],
    next_period_targets: [{ target: "t1", metric: "m1", due_date: "d1" }, { target: "t2", metric: "m2", due_date: "d2" }],
    full_draft: "draft", period: "March 2024",
  }).ok);
  ok("draft_investor_update rejects empty challenges array", !validateProposal("draft_investor_update", {
    subject_line: "subject", headline_metric: "metric",
    kpi_summary: [
      { kpi: "MRR", value: "$85,000", vs_last_period: null },
      { kpi: "Runway", value: "12.6 months", vs_last_period: null },
      { kpi: "NRR", value: "112%", vs_last_period: null },
    ],
    wins: ["a", "b"], challenges: [], asks: [{ ask: "a", from_whom: "b", context: "c" }],
    next_period_targets: [{ target: "t1", metric: "m1", due_date: "d1" }, { target: "t2", metric: "m2", due_date: "d2" }],
    full_draft: "draft", period: "March 2024",
  }).ok);
  ok("investor_update_agent → opus model",
    (await import("./lib/agent-brain")).modelForRole("investor_update_agent") === "claude-opus-4-8");

  const { runAgent: runAgentIu } = await import("./lib/run-agent");
  const { stubBrain: sbIu } = await import("./lib/agent-brain");
  const { approveAction: approveIu, listPending: listIu } = await import("./lib/actions-service");
  const orgIu = await makeOrg("pro");
  const payloadIu = await makePayload(orgIu);
  const rIu = await runAgentIu({ orgId: orgIu, payloadId: payloadIu, role: "investor_update_agent" }, { db, brain: sbIu });
  ok("investor_update_agent run produced an update", rIu.ok && rIu.proposalCount === 1);
  const pendIu = await listIu(orgIu, { db });
  ok("stub proposal passes validateProposal and returns draft_investor_update", pendIu.length === 1 && pendIu[0].kind === "draft_investor_update");
  const apprIu = await approveIu(orgIu, pendIu[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes investor_update_runs", apprIu.ok && apprIu.recordTable === "investor_update_runs", JSON.stringify(apprIu));
  const { data: iuRows } = await db.from("investor_update_runs").select("org_id,subject_line").eq("org_id", orgIu);
  ok("investor update record org-stamped", iuRows?.length === 1 && iuRows[0].org_id === orgIu);
  const { routePayload: routeIu } = await import("./lib/manager");
  const routeCheckIu = await routeIu({ orgId: orgIu, payloadId: payloadIu }, { db, enqueue: () => {} });
  ok("investor_update_agent routes on the financial route", routeCheckIu.ok && routeCheckIu.plan.includes("investor_update_agent"));
  await db.from("organizations").delete().eq("id", orgIu);

  console.log("== orchestrator agent ==");
  ok("orchestrate_agents accepts good", validateProposal("orchestrate_agents", {
    data_summary: "AR aging report with 847 rows covering 65 customers.",
    recommended_agents: [{ role_key: "collections_agent", priority: "required", reason: "directly applicable" }],
    skip_agents: ["saas_metrics_agent"], execution_order: ["data_quality_agent", "collections_agent"],
    routing_rationale: "AR aging data has no subscription metrics.", estimated_insights: ["Prioritized overdue accounts"],
  }).ok);
  ok("orchestrate_agents rejects empty data_summary", !validateProposal("orchestrate_agents", {
    data_summary: "", recommended_agents: [{ role_key: "collections_agent", priority: "required", reason: "r" }],
    skip_agents: [], execution_order: [], routing_rationale: "rationale", estimated_insights: [],
  }).ok);
  ok("orchestrate_agents rejects empty recommended_agents array", !validateProposal("orchestrate_agents", {
    data_summary: "summary", recommended_agents: [],
    skip_agents: [], execution_order: [], routing_rationale: "rationale", estimated_insights: [],
  }).ok);
  ok("orchestrate_agents filters out recommended_agent item with bad priority", (() => {
    const r = validateProposal("orchestrate_agents", {
      data_summary: "summary",
      recommended_agents: [
        { role_key: "collections_agent", priority: "required", reason: "r" },
        { role_key: "bad_agent", priority: "critical", reason: "bad" },
      ],
      skip_agents: [], execution_order: [], routing_rationale: "rationale", estimated_insights: [],
    });
    return r.ok && (r.payload.recommended_agents as unknown[]).length === 1;
  })());
  ok("orchestrator_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("orchestrator_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentOr } = await import("./lib/run-agent");
  const { stubBrain: sbOr } = await import("./lib/agent-brain");
  const { approveAction: approveOr, listPending: listOr } = await import("./lib/actions-service");
  const orgOr = await makeOrg("pro");
  const payloadOr = await makePayload(orgOr);
  const rOr = await runAgentOr({ orgId: orgOr, payloadId: payloadOr, role: "orchestrator_agent" }, { db, brain: sbOr });
  ok("orchestrator_agent run produced a plan", rOr.ok && rOr.proposalCount === 1);
  const pendOr = await listOr(orgOr, { db });
  ok("stub proposal passes validateProposal and returns orchestrate_agents", pendOr.length === 1 && pendOr[0].kind === "orchestrate_agents");
  const apprOr = await approveOr(orgOr, pendOr[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes orchestrator_runs", apprOr.ok && apprOr.recordTable === "orchestrator_runs", JSON.stringify(apprOr));
  const { data: orRows } = await db.from("orchestrator_runs").select("org_id,data_summary").eq("org_id", orgOr);
  ok("orchestrator record org-stamped", orRows?.length === 1 && orRows[0].org_id === orgOr);
  const { routePayload: routeOr } = await import("./lib/manager");
  const routeCheckOrFin = await routeOr({ orgId: orgOr, payloadId: payloadOr }, { db, enqueue: () => {} });
  const { data: plainPayloadOr } = await db.from("inbound_payloads").insert({
    org_id: orgOr, source: "upload", storage_path: `${orgOr}/or/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckOrNonFin = await routeOr({ orgId: orgOr, payloadId: plainPayloadOr!.id }, { db, enqueue: () => {} });
  ok("orchestrator_agent routes on BOTH the financial and non-financial route, near the end before exec_summarizer",
    routeCheckOrFin.ok && routeCheckOrFin.plan.includes("orchestrator_agent") && routeCheckOrFin.plan.indexOf("orchestrator_agent") === routeCheckOrFin.plan.indexOf("exec_summarizer") - 2 &&
    routeCheckOrNonFin.ok && routeCheckOrNonFin.plan.includes("orchestrator_agent") && routeCheckOrNonFin.plan.indexOf("orchestrator_agent") === routeCheckOrNonFin.plan.indexOf("exec_summarizer") - 2);
  await db.from("organizations").delete().eq("id", orgOr);

  console.log("== confidence reviewer agent ==");
  ok("review_confidence accepts good", validateProposal("review_confidence", {
    reviewed_proposals: [
      { agent_role: "ratio_analysis_agent", action_kind: "analyze_ratios", confidence_assessment: "high", concerns: [], verified_fields: ["current_ratio"] },
      { agent_role: "churn_risk_agent", action_kind: "analyze_churn_risk", confidence_assessment: "medium", concerns: ["limited sample"], verified_fields: ["at_risk_customers"] },
    ],
    overall_confidence: "medium", high_confidence_count: 1, medium_confidence_count: 1, low_confidence_count: 0,
    flags: ["churn_rate estimate based on limited data"], approval_recommendation: "approve_with_review",
  }).ok);
  ok("review_confidence rejects bad overall_confidence", !validateProposal("review_confidence", {
    reviewed_proposals: [], overall_confidence: "certain", high_confidence_count: 0, medium_confidence_count: 0, low_confidence_count: 0,
    flags: [], approval_recommendation: "approve_all",
  }).ok);
  ok("review_confidence rejects bad approval_recommendation", !validateProposal("review_confidence", {
    reviewed_proposals: [], overall_confidence: "high", high_confidence_count: 0, medium_confidence_count: 0, low_confidence_count: 0,
    flags: [], approval_recommendation: "maybe",
  }).ok);
  ok("review_confidence filters out reviewed_proposal item with bad confidence_assessment", (() => {
    const r = validateProposal("review_confidence", {
      reviewed_proposals: [
        { agent_role: "ratio_analysis_agent", action_kind: "analyze_ratios", confidence_assessment: "high", concerns: [], verified_fields: [] },
        { agent_role: "bad_agent", action_kind: "bad_action", confidence_assessment: "certain", concerns: [], verified_fields: [] },
      ],
      overall_confidence: "high", high_confidence_count: 1, medium_confidence_count: 0, low_confidence_count: 0,
      flags: [], approval_recommendation: "approve_all",
    });
    return r.ok && (r.payload.reviewed_proposals as unknown[]).length === 1;
  })());
  ok("confidence_reviewer_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("confidence_reviewer_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentCfr } = await import("./lib/run-agent");
  const { stubBrain: sbCfr } = await import("./lib/agent-brain");
  const { approveAction: approveCfr, listPending: listCfr } = await import("./lib/actions-service");
  const orgCfr = await makeOrg("pro");
  const payloadCfr = await makePayload(orgCfr);
  const rCfr = await runAgentCfr({ orgId: orgCfr, payloadId: payloadCfr, role: "confidence_reviewer_agent" }, { db, brain: sbCfr });
  ok("confidence_reviewer_agent run produced a review", rCfr.ok && rCfr.proposalCount === 1);
  const pendCfr = await listCfr(orgCfr, { db });
  ok("stub proposal passes validateProposal and returns review_confidence", pendCfr.length === 1 && pendCfr[0].kind === "review_confidence");
  const apprCfr = await approveCfr(orgCfr, pendCfr[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes confidence_reviewer_runs", apprCfr.ok && apprCfr.recordTable === "confidence_reviewer_runs", JSON.stringify(apprCfr));
  const { data: cfrRows } = await db.from("confidence_reviewer_runs").select("org_id,overall_confidence").eq("org_id", orgCfr);
  ok("confidence reviewer record org-stamped", cfrRows?.length === 1 && cfrRows[0].org_id === orgCfr);
  const { routePayload: routeCfr } = await import("./lib/manager");
  const routeCheckCfrFin = await routeCfr({ orgId: orgCfr, payloadId: payloadCfr }, { db, enqueue: () => {} });
  const { data: plainPayloadCfr } = await db.from("inbound_payloads").insert({
    org_id: orgCfr, source: "upload", storage_path: `${orgCfr}/cfr/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckCfrNonFin = await routeCfr({ orgId: orgCfr, payloadId: plainPayloadCfr!.id }, { db, enqueue: () => {} });
  ok("confidence_reviewer_agent routes on BOTH the financial and non-financial route, near the end after orchestrator_agent, before exec_summarizer",
    routeCheckCfrFin.ok && routeCheckCfrFin.plan.indexOf("confidence_reviewer_agent") === routeCheckCfrFin.plan.indexOf("orchestrator_agent") + 1 &&
    routeCheckCfrFin.plan.indexOf("confidence_reviewer_agent") === routeCheckCfrFin.plan.indexOf("exec_summarizer") - 1 &&
    routeCheckCfrNonFin.ok && routeCheckCfrNonFin.plan.indexOf("confidence_reviewer_agent") === routeCheckCfrNonFin.plan.indexOf("orchestrator_agent") + 1 &&
    routeCheckCfrNonFin.plan.indexOf("confidence_reviewer_agent") === routeCheckCfrNonFin.plan.indexOf("exec_summarizer") - 1);
  await db.from("organizations").delete().eq("id", orgCfr);

  console.log("== data reshape agent ==");
  ok("reshape_data accepts good", validateProposal("reshape_data", {
    source_shape: "wide", target_shape: "narrow",
    id_columns: ["Customer", "Region"], variable_column: "Month", value_column: "Revenue",
    reshaped_preview: [{ Customer: "Acme Corp", Region: "West", Month: "Jan", Revenue: 85000 }],
    row_count_before: 45, row_count_after: 540, column_count_before: 14, column_count_after: 4,
    reshape_notes: "12 monthly columns collapsed.",
  }).ok);
  ok("reshape_data rejects bad source_shape", !validateProposal("reshape_data", {
    source_shape: "diagonal", target_shape: "narrow",
    id_columns: ["Customer"], variable_column: "", value_column: "",
    reshaped_preview: [], row_count_before: 0, row_count_after: 0, column_count_before: 0, column_count_after: 0,
    reshape_notes: "",
  }).ok);
  ok("reshape_data rejects bad target_shape", !validateProposal("reshape_data", {
    source_shape: "wide", target_shape: "diagonal",
    id_columns: ["Customer"], variable_column: "", value_column: "",
    reshaped_preview: [], row_count_before: 0, row_count_after: 0, column_count_before: 0, column_count_after: 0,
    reshape_notes: "",
  }).ok);
  ok("reshape_data rejects empty id_columns array", !validateProposal("reshape_data", {
    source_shape: "wide", target_shape: "narrow",
    id_columns: [], variable_column: "", value_column: "",
    reshaped_preview: [], row_count_before: 0, row_count_after: 0, column_count_before: 0, column_count_after: 0,
    reshape_notes: "",
  }).ok);
  ok("data_reshape_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("data_reshape_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentDrp } = await import("./lib/run-agent");
  const { stubBrain: sbDrp } = await import("./lib/agent-brain");
  const { approveAction: approveDrp, listPending: listDrp } = await import("./lib/actions-service");
  const orgDrp = await makeOrg("pro");
  const payloadDrp = await makePayload(orgDrp);
  const rDrp = await runAgentDrp({ orgId: orgDrp, payloadId: payloadDrp, role: "data_reshape_agent" }, { db, brain: sbDrp });
  ok("data_reshape_agent run produced a reshape plan", rDrp.ok && rDrp.proposalCount === 1);
  const pendDrp = await listDrp(orgDrp, { db });
  ok("stub proposal passes validateProposal and returns reshape_data", pendDrp.length === 1 && pendDrp[0].kind === "reshape_data");
  const apprDrp = await approveDrp(orgDrp, pendDrp[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes data_reshape_runs", apprDrp.ok && apprDrp.recordTable === "data_reshape_runs", JSON.stringify(apprDrp));
  const { data: drpRows } = await db.from("data_reshape_runs").select("org_id,source_shape").eq("org_id", orgDrp);
  ok("data reshape record org-stamped", drpRows?.length === 1 && drpRows[0].org_id === orgDrp);
  const { routePayload: routeDrp } = await import("./lib/manager");
  const routeCheckDrpFin = await routeDrp({ orgId: orgDrp, payloadId: payloadDrp }, { db, enqueue: () => {} });
  const { data: plainPayloadDrp } = await db.from("inbound_payloads").insert({
    org_id: orgDrp, source: "upload", storage_path: `${orgDrp}/drp/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckDrpNonFin = await routeDrp({ orgId: orgDrp, payloadId: plainPayloadDrp!.id }, { db, enqueue: () => {} });
  ok("data_reshape_agent routes on BOTH the financial and non-financial route",
    routeCheckDrpFin.ok && routeCheckDrpFin.plan.includes("data_reshape_agent") &&
    routeCheckDrpNonFin.ok && routeCheckDrpNonFin.plan.includes("data_reshape_agent"));
  await db.from("organizations").delete().eq("id", orgDrp);

  console.log("== date normalization agent ==");
  ok("normalize_dates accepts good", validateProposal("normalize_dates", {
    detected_formats: [{ column_name: "Invoice Date", formats_found: ["MM/DD/YYYY"], sample_values: ["01/15/2024"], iso_convertible: true, ambiguous_count: 3 }],
    target_format: "YYYY-MM-DD",
    normalization_map: [{ original_format: "MM/DD/YYYY", iso_format: "YYYY-MM-DD", example: "01/15/2024 → 2024-01-15" }],
    ambiguous_dates: ["01/02/2024"], timezone_issues: [], rows_affected: 847, columns_affected: 2,
    recommendations: ["Standardize Invoice Date"],
  }).ok);
  ok("normalize_dates rejects bad target_format", !validateProposal("normalize_dates", {
    detected_formats: [], target_format: "DD/MM/YYYY",
    normalization_map: [], ambiguous_dates: [], timezone_issues: [], rows_affected: 0, columns_affected: 0,
    recommendations: [],
  }).ok);
  ok("normalize_dates filters out detected_formats item with empty column_name", (() => {
    const r = validateProposal("normalize_dates", {
      detected_formats: [
        { column_name: "Invoice Date", formats_found: [], sample_values: [], iso_convertible: true, ambiguous_count: 0 },
        { column_name: "", formats_found: [], sample_values: [], iso_convertible: true, ambiguous_count: 0 },
      ],
      target_format: "YYYY-MM-DD", normalization_map: [], ambiguous_dates: [], timezone_issues: [],
      rows_affected: 0, columns_affected: 0, recommendations: [],
    });
    return r.ok && (r.payload.detected_formats as unknown[]).length === 1;
  })());
  ok("normalize_dates filters out normalization_map item with empty original_format", (() => {
    const r = validateProposal("normalize_dates", {
      detected_formats: [], target_format: "YYYY-MM-DD",
      normalization_map: [
        { original_format: "MM/DD/YYYY", iso_format: "YYYY-MM-DD", example: "e" },
        { original_format: "", iso_format: "YYYY-MM-DD", example: "e" },
      ],
      ambiguous_dates: [], timezone_issues: [], rows_affected: 0, columns_affected: 0, recommendations: [],
    });
    return r.ok && (r.payload.normalization_map as unknown[]).length === 1;
  })());
  ok("date_normalization_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("date_normalization_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentDtn } = await import("./lib/run-agent");
  const { stubBrain: sbDtn } = await import("./lib/agent-brain");
  const { approveAction: approveDtn, listPending: listDtn } = await import("./lib/actions-service");
  const orgDtn = await makeOrg("pro");
  const payloadDtn = await makePayload(orgDtn);
  const rDtn = await runAgentDtn({ orgId: orgDtn, payloadId: payloadDtn, role: "date_normalization_agent" }, { db, brain: sbDtn });
  ok("date_normalization_agent run produced a normalization plan", rDtn.ok && rDtn.proposalCount === 1);
  const pendDtn = await listDtn(orgDtn, { db });
  ok("stub proposal passes validateProposal and returns normalize_dates", pendDtn.length === 1 && pendDtn[0].kind === "normalize_dates");
  const apprDtn = await approveDtn(orgDtn, pendDtn[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes date_normalization_runs", apprDtn.ok && apprDtn.recordTable === "date_normalization_runs", JSON.stringify(apprDtn));
  const { data: dtnRows } = await db.from("date_normalization_runs").select("org_id,target_format").eq("org_id", orgDtn);
  ok("date normalization record org-stamped", dtnRows?.length === 1 && dtnRows[0].org_id === orgDtn);
  const { routePayload: routeDtn } = await import("./lib/manager");
  const routeCheckDtnFin = await routeDtn({ orgId: orgDtn, payloadId: payloadDtn }, { db, enqueue: () => {} });
  const { data: plainPayloadDtn } = await db.from("inbound_payloads").insert({
    org_id: orgDtn, source: "upload", storage_path: `${orgDtn}/dtn/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckDtnNonFin = await routeDtn({ orgId: orgDtn, payloadId: plainPayloadDtn!.id }, { db, enqueue: () => {} });
  ok("date_normalization_agent routes on BOTH the financial and non-financial route",
    routeCheckDtnFin.ok && routeCheckDtnFin.plan.includes("date_normalization_agent") &&
    routeCheckDtnNonFin.ok && routeCheckDtnNonFin.plan.includes("date_normalization_agent"));
  await db.from("organizations").delete().eq("id", orgDtn);

  console.log("== string normalization agent ==");
  ok("normalize_strings accepts good", validateProposal("normalize_strings", {
    columns_analyzed: [{ column_name: "Customer", unique_values_before: 87, unique_values_after: 74, issues_found: ["13 near-duplicates"] }],
    whitespace_issues: [{ column_name: "Customer", count: 6 }],
    case_standardization: [{ column_name: "Customer", recommended_case: "title", example_before: "ACME CORP", example_after: "Acme Corp" }],
    entity_dedup_candidates: [{ original: "Acme Corporation", canonical: "Acme Corp", similarity_score: 0.92 }],
    encoding_issues: [], total_values_affected: 312,
    normalization_rules: [{ rule_type: "trim_whitespace", description: "Remove whitespace", columns_affected: ["Customer"] }],
  }).ok);
  ok("normalize_strings filters out case_standardization item with bad recommended_case", (() => {
    const r = validateProposal("normalize_strings", {
      columns_analyzed: [], whitespace_issues: [],
      case_standardization: [
        { column_name: "Customer", recommended_case: "title", example_before: "a", example_after: "A" },
        { column_name: "Status", recommended_case: "sentence", example_before: "a", example_after: "A" },
      ],
      entity_dedup_candidates: [], encoding_issues: [], total_values_affected: 0, normalization_rules: [],
    });
    return r.ok && (r.payload.case_standardization as unknown[]).length === 1;
  })());
  ok("normalize_strings filters out entity_dedup_candidates item with similarity_score > 1", (() => {
    const r = validateProposal("normalize_strings", {
      columns_analyzed: [], whitespace_issues: [], case_standardization: [],
      entity_dedup_candidates: [
        { original: "a", canonical: "b", similarity_score: 0.9 },
        { original: "c", canonical: "d", similarity_score: 1.5 },
      ],
      encoding_issues: [], total_values_affected: 0, normalization_rules: [],
    });
    return r.ok && (r.payload.entity_dedup_candidates as unknown[]).length === 1;
  })());
  ok("normalize_strings filters out entity_dedup_candidates item with similarity_score < 0", (() => {
    const r = validateProposal("normalize_strings", {
      columns_analyzed: [], whitespace_issues: [], case_standardization: [],
      entity_dedup_candidates: [
        { original: "a", canonical: "b", similarity_score: 0.9 },
        { original: "c", canonical: "d", similarity_score: -0.5 },
      ],
      encoding_issues: [], total_values_affected: 0, normalization_rules: [],
    });
    return r.ok && (r.payload.entity_dedup_candidates as unknown[]).length === 1;
  })());
  ok("string_normalization_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("string_normalization_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentSnm } = await import("./lib/run-agent");
  const { stubBrain: sbSnm } = await import("./lib/agent-brain");
  const { approveAction: approveSnm, listPending: listSnm } = await import("./lib/actions-service");
  const orgSnm = await makeOrg("pro");
  const payloadSnm = await makePayload(orgSnm);
  const rSnm = await runAgentSnm({ orgId: orgSnm, payloadId: payloadSnm, role: "string_normalization_agent" }, { db, brain: sbSnm });
  ok("string_normalization_agent run produced a normalization plan", rSnm.ok && rSnm.proposalCount === 1);
  const pendSnm = await listSnm(orgSnm, { db });
  ok("stub proposal passes validateProposal and returns normalize_strings", pendSnm.length === 1 && pendSnm[0].kind === "normalize_strings");
  const apprSnm = await approveSnm(orgSnm, pendSnm[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes string_normalization_runs", apprSnm.ok && apprSnm.recordTable === "string_normalization_runs", JSON.stringify(apprSnm));
  const { data: snmRows } = await db.from("string_normalization_runs").select("org_id,total_values_affected").eq("org_id", orgSnm);
  ok("string normalization record org-stamped", snmRows?.length === 1 && snmRows[0].org_id === orgSnm);
  const { routePayload: routeSnm } = await import("./lib/manager");
  const routeCheckSnmFin = await routeSnm({ orgId: orgSnm, payloadId: payloadSnm }, { db, enqueue: () => {} });
  const { data: plainPayloadSnm } = await db.from("inbound_payloads").insert({
    org_id: orgSnm, source: "upload", storage_path: `${orgSnm}/snm/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckSnmNonFin = await routeSnm({ orgId: orgSnm, payloadId: plainPayloadSnm!.id }, { db, enqueue: () => {} });
  ok("string_normalization_agent routes on BOTH the financial and non-financial route",
    routeCheckSnmFin.ok && routeCheckSnmFin.plan.includes("string_normalization_agent") &&
    routeCheckSnmNonFin.ok && routeCheckSnmNonFin.plan.includes("string_normalization_agent"));
  await db.from("organizations").delete().eq("id", orgSnm);

  console.log("== currency normalization agent ==");
  ok("normalize_currency accepts good", validateProposal("normalize_currency", {
    currencies_detected: [{ currency_code: "USD", symbol: "$", row_count: 712 }, { currency_code: "EUR", symbol: "€", row_count: 135 }],
    base_currency: "USD", conversion_needed: true, rows_with_mixed_currency: 135,
    normalization_issues: [{ column_name: "Amount", issue_type: "mixed_currencies", description: "mixed", row_count: 135 }],
    conversion_recommendations: ["Apply FX rate"], columns_affected: ["Amount"],
  }).ok);
  ok("normalize_currency rejects empty base_currency", !validateProposal("normalize_currency", {
    currencies_detected: [], base_currency: "", conversion_needed: false, rows_with_mixed_currency: 0,
    normalization_issues: [], conversion_recommendations: [], columns_affected: [],
  }).ok);
  ok("normalize_currency rejects invalid conversion_needed type", !validateProposal("normalize_currency", {
    currencies_detected: [], base_currency: "USD", conversion_needed: "yes", rows_with_mixed_currency: 0,
    normalization_issues: [], conversion_recommendations: [], columns_affected: [],
  }).ok);
  ok("normalize_currency filters out currencies_detected item with empty currency_code", (() => {
    const r = validateProposal("normalize_currency", {
      currencies_detected: [
        { currency_code: "USD", symbol: "$", row_count: 712 },
        { currency_code: "", symbol: "€", row_count: 135 },
      ],
      base_currency: "USD", conversion_needed: false, rows_with_mixed_currency: 0,
      normalization_issues: [], conversion_recommendations: [], columns_affected: [],
    });
    return r.ok && (r.payload.currencies_detected as unknown[]).length === 1;
  })());
  ok("currency_normalization_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("currency_normalization_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentCun } = await import("./lib/run-agent");
  const { stubBrain: sbCun } = await import("./lib/agent-brain");
  const { approveAction: approveCun, listPending: listCun } = await import("./lib/actions-service");
  const orgCun = await makeOrg("pro");
  const payloadCun = await makePayload(orgCun);
  const rCun = await runAgentCun({ orgId: orgCun, payloadId: payloadCun, role: "currency_normalization_agent" }, { db, brain: sbCun });
  ok("currency_normalization_agent run produced a normalization plan", rCun.ok && rCun.proposalCount === 1);
  const pendCun = await listCun(orgCun, { db });
  ok("stub proposal passes validateProposal and returns normalize_currency", pendCun.length === 1 && pendCun[0].kind === "normalize_currency");
  const apprCun = await approveCun(orgCun, pendCun[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes currency_normalization_runs", apprCun.ok && apprCun.recordTable === "currency_normalization_runs", JSON.stringify(apprCun));
  const { data: cunRows } = await db.from("currency_normalization_runs").select("org_id,base_currency").eq("org_id", orgCun);
  ok("currency normalization record org-stamped", cunRows?.length === 1 && cunRows[0].org_id === orgCun);
  const { routePayload: routeCun } = await import("./lib/manager");
  const routeCheckCunFin = await routeCun({ orgId: orgCun, payloadId: payloadCun }, { db, enqueue: () => {} });
  const { data: plainPayloadCun } = await db.from("inbound_payloads").insert({
    org_id: orgCun, source: "upload", storage_path: `${orgCun}/cun/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckCunNonFin = await routeCun({ orgId: orgCun, payloadId: plainPayloadCun!.id }, { db, enqueue: () => {} });
  ok("currency_normalization_agent routes on BOTH the financial and non-financial route",
    routeCheckCunFin.ok && routeCheckCunFin.plan.includes("currency_normalization_agent") &&
    routeCheckCunNonFin.ok && routeCheckCunNonFin.plan.includes("currency_normalization_agent"));
  await db.from("organizations").delete().eq("id", orgCun);

  console.log("== join quality agent ==");
  ok("assess_join_quality accepts good", validateProposal("assess_join_quality", {
    left_dataset_profile: { column_count: 8, row_count: 847, key_candidates: ["customer_id"] },
    right_dataset_profile: { column_count: 5, row_count: 620, key_candidates: ["cust_id"] },
    recommended_join_keys: [{ left_column: "customer_id", right_column: "cust_id", match_rate: 91.2, uniqueness_left: 94.5, uniqueness_right: 99.8 }],
    join_type_recommendation: "left", match_quality: "good", unmatched_left_count: 74, unmatched_right_count: 0,
    duplicate_key_issues: [], data_quality_flags: [],
  }).ok);
  ok("assess_join_quality rejects bad join_type_recommendation", !validateProposal("assess_join_quality", {
    left_dataset_profile: { column_count: 1, row_count: 1, key_candidates: [] },
    right_dataset_profile: { column_count: 1, row_count: 1, key_candidates: [] },
    recommended_join_keys: [], join_type_recommendation: "diagonal", match_quality: "good",
    unmatched_left_count: 0, unmatched_right_count: 0, duplicate_key_issues: [], data_quality_flags: [],
  }).ok);
  ok("assess_join_quality rejects bad match_quality", !validateProposal("assess_join_quality", {
    left_dataset_profile: { column_count: 1, row_count: 1, key_candidates: [] },
    right_dataset_profile: { column_count: 1, row_count: 1, key_candidates: [] },
    recommended_join_keys: [], join_type_recommendation: "left", match_quality: "amazing",
    unmatched_left_count: 0, unmatched_right_count: 0, duplicate_key_issues: [], data_quality_flags: [],
  }).ok);
  ok("assess_join_quality filters out recommended_join_keys item with empty left_column", (() => {
    const r = validateProposal("assess_join_quality", {
      left_dataset_profile: { column_count: 1, row_count: 1, key_candidates: [] },
      right_dataset_profile: { column_count: 1, row_count: 1, key_candidates: [] },
      recommended_join_keys: [
        { left_column: "customer_id", right_column: "cust_id", match_rate: 91.2, uniqueness_left: 94.5, uniqueness_right: 99.8 },
        { left_column: "", right_column: "inv_no", match_rate: 88.7, uniqueness_left: 99.9, uniqueness_right: 99.9 },
      ],
      join_type_recommendation: "left", match_quality: "good", unmatched_left_count: 0, unmatched_right_count: 0,
      duplicate_key_issues: [], data_quality_flags: [],
    });
    return r.ok && (r.payload.recommended_join_keys as unknown[]).length === 1;
  })());
  ok("join_quality_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("join_quality_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentJql } = await import("./lib/run-agent");
  const { stubBrain: sbJql } = await import("./lib/agent-brain");
  const { approveAction: approveJql, listPending: listJql } = await import("./lib/actions-service");
  const orgJql = await makeOrg("pro");
  const payloadJql = await makePayload(orgJql);
  const rJql = await runAgentJql({ orgId: orgJql, payloadId: payloadJql, role: "join_quality_agent" }, { db, brain: sbJql });
  ok("join_quality_agent run produced an assessment", rJql.ok && rJql.proposalCount === 1);
  const pendJql = await listJql(orgJql, { db });
  ok("stub proposal passes validateProposal and returns assess_join_quality", pendJql.length === 1 && pendJql[0].kind === "assess_join_quality");
  const apprJql = await approveJql(orgJql, pendJql[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes join_quality_runs", apprJql.ok && apprJql.recordTable === "join_quality_runs", JSON.stringify(apprJql));
  const { data: jqlRows } = await db.from("join_quality_runs").select("org_id,match_quality").eq("org_id", orgJql);
  ok("join quality record org-stamped", jqlRows?.length === 1 && jqlRows[0].org_id === orgJql);
  const { routePayload: routeJql } = await import("./lib/manager");
  const routeCheckJqlFin = await routeJql({ orgId: orgJql, payloadId: payloadJql }, { db, enqueue: () => {} });
  const { data: plainPayloadJql } = await db.from("inbound_payloads").insert({
    org_id: orgJql, source: "upload", storage_path: `${orgJql}/jql/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckJqlNonFin = await routeJql({ orgId: orgJql, payloadId: plainPayloadJql!.id }, { db, enqueue: () => {} });
  ok("join_quality_agent routes on BOTH the financial and non-financial route",
    routeCheckJqlFin.ok && routeCheckJqlFin.plan.includes("join_quality_agent") &&
    routeCheckJqlNonFin.ok && routeCheckJqlNonFin.plan.includes("join_quality_agent"));
  await db.from("organizations").delete().eq("id", orgJql);

  console.log("== data validation rules agent ==");
  ok("validate_data_rules accepts good", validateProposal("validate_data_rules", {
    rules_generated: [{ rule_id: "R001", column_name: "Amount", rule_type: "range", rule_definition: "Amount >= 0", description: "Invoice amount must be non-negative" }],
    violations_found: [{ rule_id: "R001", column_name: "Amount", violation_count: 3, example_values: ["-500", "-12.50"] }],
    validation_summary: { total_rules: 3, rules_passed: 1, rules_failed: 2, total_violations: 11 },
    recommendations: ["Investigate negative Amount values"],
    data_readiness: "needs_cleaning",
  }).ok);
  ok("validate_data_rules rejects bad data_readiness", !validateProposal("validate_data_rules", {
    rules_generated: [], violations_found: [],
    validation_summary: { total_rules: 0, rules_passed: 0, rules_failed: 0, total_violations: 0 },
    recommendations: [], data_readiness: "flawless",
  }).ok);
  ok("validate_data_rules rejects invalid validation_summary object", !validateProposal("validate_data_rules", {
    rules_generated: [], violations_found: [],
    validation_summary: { total_rules: 3, rules_passed: "many", rules_failed: 2, total_violations: 11 },
    recommendations: [], data_readiness: "needs_cleaning",
  }).ok);
  ok("validate_data_rules filters out rules_generated item with empty rule_id", (() => {
    const r = validateProposal("validate_data_rules", {
      rules_generated: [
        { rule_id: "R001", column_name: "Amount", rule_type: "range", rule_definition: "Amount >= 0", description: "desc" },
        { rule_id: "", column_name: "Email", rule_type: "format", rule_definition: "regex", description: "desc" },
      ],
      violations_found: [],
      validation_summary: { total_rules: 2, rules_passed: 2, rules_failed: 0, total_violations: 0 },
      recommendations: [], data_readiness: "production_ready",
    });
    return r.ok && (r.payload.rules_generated as unknown[]).length === 1;
  })());
  ok("data_validation_rules_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("data_validation_rules_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentDvr } = await import("./lib/run-agent");
  const { stubBrain: sbDvr } = await import("./lib/agent-brain");
  const { approveAction: approveDvr, listPending: listDvr } = await import("./lib/actions-service");
  const orgDvr = await makeOrg("pro");
  const payloadDvr = await makePayload(orgDvr);
  const rDvr = await runAgentDvr({ orgId: orgDvr, payloadId: payloadDvr, role: "data_validation_rules_agent" }, { db, brain: sbDvr });
  ok("data_validation_rules_agent run produced a validation", rDvr.ok && rDvr.proposalCount === 1);
  const pendDvr = await listDvr(orgDvr, { db });
  ok("stub proposal passes validateProposal and returns validate_data_rules", pendDvr.length === 1 && pendDvr[0].kind === "validate_data_rules");
  const apprDvr = await approveDvr(orgDvr, pendDvr[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes data_validation_rules_runs", apprDvr.ok && apprDvr.recordTable === "data_validation_rules_runs", JSON.stringify(apprDvr));
  const { data: dvrRows } = await db.from("data_validation_rules_runs").select("org_id,data_readiness").eq("org_id", orgDvr);
  ok("data validation rules record org-stamped", dvrRows?.length === 1 && dvrRows[0].org_id === orgDvr);
  const { routePayload: routeDvr } = await import("./lib/manager");
  const routeCheckDvrFin = await routeDvr({ orgId: orgDvr, payloadId: payloadDvr }, { db, enqueue: () => {} });
  const { data: plainPayloadDvr } = await db.from("inbound_payloads").insert({
    org_id: orgDvr, source: "upload", storage_path: `${orgDvr}/dvr/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckDvrNonFin = await routeDvr({ orgId: orgDvr, payloadId: plainPayloadDvr!.id }, { db, enqueue: () => {} });
  ok("data_validation_rules_agent routes on BOTH the financial and non-financial route",
    routeCheckDvrFin.ok && routeCheckDvrFin.plan.includes("data_validation_rules_agent") &&
    routeCheckDvrNonFin.ok && routeCheckDvrNonFin.plan.includes("data_validation_rules_agent"));
  await db.from("organizations").delete().eq("id", orgDvr);

  console.log("== distribution agent ==");
  ok("analyze_distribution accepts good", validateProposal("analyze_distribution", {
    columns_analyzed: [{ column_name: "Revenue", data_type: "currency", min_val: 1200, max_val: 485000, mean: 52300, median: 31500, std_dev: 67800, null_count: 0, row_count: 847 }],
    distribution_summary: [{ column_name: "Revenue", distribution_shape: "right_skewed", percentile_25: 12400, percentile_75: 68900, iqr: 56500 }],
    skewness_flags: [], outlier_summary: [], normality_assessment: [], visualization_recommendations: [],
  }).ok);
  ok("analyze_distribution rejects empty columns_analyzed array", !validateProposal("analyze_distribution", {
    columns_analyzed: [],
    distribution_summary: [], skewness_flags: [], outlier_summary: [], normality_assessment: [], visualization_recommendations: [],
  }).ok);
  ok("analyze_distribution filters out distribution_summary item with bad distribution_shape", (() => {
    const r = validateProposal("analyze_distribution", {
      columns_analyzed: [{ column_name: "Revenue", data_type: "currency", min_val: 0, max_val: 100, mean: 50, median: 50, std_dev: 10, null_count: 0, row_count: 10 }],
      distribution_summary: [
        { column_name: "Revenue", distribution_shape: "right_skewed", percentile_25: 25, percentile_75: 75, iqr: 50 },
        { column_name: "Days", distribution_shape: "wobbly", percentile_25: 1, percentile_75: 2, iqr: 1 },
      ],
      skewness_flags: [], outlier_summary: [], normality_assessment: [], visualization_recommendations: [],
    });
    return r.ok && (r.payload.distribution_summary as unknown[]).length === 1;
  })());
  ok("analyze_distribution filters out columns_analyzed item with empty column_name", (() => {
    const r = validateProposal("analyze_distribution", {
      columns_analyzed: [
        { column_name: "Revenue", data_type: "currency", min_val: 0, max_val: 100, mean: 50, median: 50, std_dev: 10, null_count: 0, row_count: 10 },
        { column_name: "", data_type: "integer", min_val: 0, max_val: 10, mean: 5, median: 5, std_dev: 1, null_count: 0, row_count: 10 },
      ],
      distribution_summary: [], skewness_flags: [], outlier_summary: [], normality_assessment: [], visualization_recommendations: [],
    });
    return r.ok && (r.payload.columns_analyzed as unknown[]).length === 1;
  })());
  ok("distribution_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("distribution_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentDst } = await import("./lib/run-agent");
  const { stubBrain: sbDst } = await import("./lib/agent-brain");
  const { approveAction: approveDst, listPending: listDst } = await import("./lib/actions-service");
  const orgDst = await makeOrg("pro");
  const payloadDst = await makePayload(orgDst);
  const rDst = await runAgentDst({ orgId: orgDst, payloadId: payloadDst, role: "distribution_agent" }, { db, brain: sbDst });
  ok("distribution_agent run produced an analysis", rDst.ok && rDst.proposalCount === 1);
  const pendDst = await listDst(orgDst, { db });
  ok("stub proposal passes validateProposal and returns analyze_distribution", pendDst.length === 1 && pendDst[0].kind === "analyze_distribution");
  const apprDst = await approveDst(orgDst, pendDst[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes distribution_runs", apprDst.ok && apprDst.recordTable === "distribution_runs", JSON.stringify(apprDst));
  const { data: dstRows } = await db.from("distribution_runs").select("org_id").eq("org_id", orgDst);
  ok("distribution record org-stamped", dstRows?.length === 1 && dstRows[0].org_id === orgDst);
  const { routePayload: routeDst } = await import("./lib/manager");
  const routeCheckDstFin = await routeDst({ orgId: orgDst, payloadId: payloadDst }, { db, enqueue: () => {} });
  const { data: plainPayloadDst } = await db.from("inbound_payloads").insert({
    org_id: orgDst, source: "upload", storage_path: `${orgDst}/dst/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckDstNonFin = await routeDst({ orgId: orgDst, payloadId: plainPayloadDst!.id }, { db, enqueue: () => {} });
  ok("distribution_agent routes on BOTH the financial and non-financial route",
    routeCheckDstFin.ok && routeCheckDstFin.plan.includes("distribution_agent") &&
    routeCheckDstNonFin.ok && routeCheckDstNonFin.plan.includes("distribution_agent"));
  await db.from("organizations").delete().eq("id", orgDst);

  console.log("== correlation agent ==");
  ok("analyze_correlation accepts good", validateProposal("analyze_correlation", {
    correlation_pairs: [{ col_a: "Days Outstanding", col_b: "Churn Risk Score", pearson_r: 0.81, strength: "strong", direction: "positive" }],
    strong_correlations: [], surprising_correlations: [], multicollinearity_flags: [], business_insights: [], columns_included: 8,
  }).ok);
  ok("analyze_correlation rejects invalid columns_included", !validateProposal("analyze_correlation", {
    correlation_pairs: [], strong_correlations: [], surprising_correlations: [], multicollinearity_flags: [], business_insights: [], columns_included: -1,
  }).ok);
  ok("analyze_correlation filters out correlation_pairs item with pearson_r > 1", (() => {
    const r = validateProposal("analyze_correlation", {
      correlation_pairs: [
        { col_a: "A", col_b: "B", pearson_r: 0.5, strength: "moderate", direction: "positive" },
        { col_a: "C", col_b: "D", pearson_r: 1.5, strength: "strong", direction: "positive" },
      ],
      strong_correlations: [], surprising_correlations: [], multicollinearity_flags: [], business_insights: [], columns_included: 4,
    });
    return r.ok && (r.payload.correlation_pairs as unknown[]).length === 1;
  })());
  ok("analyze_correlation filters out correlation_pairs item with pearson_r < -1", (() => {
    const r = validateProposal("analyze_correlation", {
      correlation_pairs: [
        { col_a: "A", col_b: "B", pearson_r: -0.5, strength: "moderate", direction: "negative" },
        { col_a: "C", col_b: "D", pearson_r: -1.5, strength: "strong", direction: "negative" },
      ],
      strong_correlations: [], surprising_correlations: [], multicollinearity_flags: [], business_insights: [], columns_included: 4,
    });
    return r.ok && (r.payload.correlation_pairs as unknown[]).length === 1;
  })());
  ok("correlation_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("correlation_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentCor } = await import("./lib/run-agent");
  const { stubBrain: sbCor } = await import("./lib/agent-brain");
  const { approveAction: approveCor, listPending: listCor } = await import("./lib/actions-service");
  const orgCor = await makeOrg("pro");
  const payloadCor = await makePayload(orgCor);
  const rCor = await runAgentCor({ orgId: orgCor, payloadId: payloadCor, role: "correlation_agent" }, { db, brain: sbCor });
  ok("correlation_agent run produced an analysis", rCor.ok && rCor.proposalCount === 1);
  const pendCor = await listCor(orgCor, { db });
  ok("stub proposal passes validateProposal and returns analyze_correlation", pendCor.length === 1 && pendCor[0].kind === "analyze_correlation");
  const apprCor = await approveCor(orgCor, pendCor[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes correlation_runs", apprCor.ok && apprCor.recordTable === "correlation_runs", JSON.stringify(apprCor));
  const { data: corRows } = await db.from("correlation_runs").select("org_id").eq("org_id", orgCor);
  ok("correlation record org-stamped", corRows?.length === 1 && corRows[0].org_id === orgCor);
  const { routePayload: routeCor } = await import("./lib/manager");
  const routeCheckCorFin = await routeCor({ orgId: orgCor, payloadId: payloadCor }, { db, enqueue: () => {} });
  const { data: plainPayloadCor } = await db.from("inbound_payloads").insert({
    org_id: orgCor, source: "upload", storage_path: `${orgCor}/cor/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckCorNonFin = await routeCor({ orgId: orgCor, payloadId: plainPayloadCor!.id }, { db, enqueue: () => {} });
  ok("correlation_agent routes on BOTH the financial and non-financial route",
    routeCheckCorFin.ok && routeCheckCorFin.plan.includes("correlation_agent") &&
    routeCheckCorNonFin.ok && routeCheckCorNonFin.plan.includes("correlation_agent"));
  await db.from("organizations").delete().eq("id", orgCor);

  console.log("== regression agent ==");
  ok("analyze_regression accepts good", validateProposal("analyze_regression", {
    dependent_variable: "Churn Risk Score",
    independent_variables: ["Days Outstanding", "Contract Value"],
    regression_type: "multiple_linear",
    model_fit: { r_squared: 0.74, adjusted_r_squared: 0.71, rmse: 8.3 },
    coefficients: [], predictions: [], model_warnings: [],
    business_interpretation: "Days outstanding is the strongest predictor of churn risk.",
  }).ok);
  ok("analyze_regression rejects empty dependent_variable", !validateProposal("analyze_regression", {
    dependent_variable: "",
    independent_variables: ["X"], regression_type: "linear",
    model_fit: { r_squared: 0.5, adjusted_r_squared: 0.5, rmse: 1 },
    coefficients: [], predictions: [], model_warnings: [], business_interpretation: "text",
  }).ok);
  ok("analyze_regression rejects bad regression_type", !validateProposal("analyze_regression", {
    dependent_variable: "Y",
    independent_variables: ["X"], regression_type: "quantum",
    model_fit: { r_squared: 0.5, adjusted_r_squared: 0.5, rmse: 1 },
    coefficients: [], predictions: [], model_warnings: [], business_interpretation: "text",
  }).ok);
  ok("analyze_regression rejects model_fit with r_squared > 1", !validateProposal("analyze_regression", {
    dependent_variable: "Y",
    independent_variables: ["X"], regression_type: "linear",
    model_fit: { r_squared: 1.5, adjusted_r_squared: 0.5, rmse: 1 },
    coefficients: [], predictions: [], model_warnings: [], business_interpretation: "text",
  }).ok);
  ok("regression_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("regression_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentRgr } = await import("./lib/run-agent");
  const { stubBrain: sbRgr } = await import("./lib/agent-brain");
  const { approveAction: approveRgr, listPending: listRgr } = await import("./lib/actions-service");
  const orgRgr = await makeOrg("pro");
  const payloadRgr = await makePayload(orgRgr);
  const rRgr = await runAgentRgr({ orgId: orgRgr, payloadId: payloadRgr, role: "regression_agent" }, { db, brain: sbRgr });
  ok("regression_agent run produced an analysis", rRgr.ok && rRgr.proposalCount === 1);
  const pendRgr = await listRgr(orgRgr, { db });
  ok("stub proposal passes validateProposal and returns analyze_regression", pendRgr.length === 1 && pendRgr[0].kind === "analyze_regression");
  const apprRgr = await approveRgr(orgRgr, pendRgr[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes regression_runs", apprRgr.ok && apprRgr.recordTable === "regression_runs", JSON.stringify(apprRgr));
  const { data: rgrRows } = await db.from("regression_runs").select("org_id").eq("org_id", orgRgr);
  ok("regression record org-stamped", rgrRows?.length === 1 && rgrRows[0].org_id === orgRgr);
  const { routePayload: routeRgr } = await import("./lib/manager");
  const routeCheckRgrFin = await routeRgr({ orgId: orgRgr, payloadId: payloadRgr }, { db, enqueue: () => {} });
  const { data: plainPayloadRgr } = await db.from("inbound_payloads").insert({
    org_id: orgRgr, source: "upload", storage_path: `${orgRgr}/rgr/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckRgrNonFin = await routeRgr({ orgId: orgRgr, payloadId: plainPayloadRgr!.id }, { db, enqueue: () => {} });
  ok("regression_agent routes on BOTH the financial and non-financial route",
    routeCheckRgrFin.ok && routeCheckRgrFin.plan.includes("regression_agent") &&
    routeCheckRgrNonFin.ok && routeCheckRgrNonFin.plan.includes("regression_agent"));
  await db.from("organizations").delete().eq("id", orgRgr);

  console.log("== hypothesis testing agent ==");
  ok("test_hypothesis accepts good", validateProposal("test_hypothesis", {
    tests_performed: [{ test_name: "Enterprise vs SMB", test_type: "t_test", null_hypothesis: "No difference", p_value: 0.003, reject_null: true, confidence_level: 0.95 }],
    significant_findings: [], non_significant_findings: [], effect_sizes: [], recommended_actions: [], statistical_caveats: [],
  }).ok);
  ok("test_hypothesis rejects empty tests_performed array", !validateProposal("test_hypothesis", {
    tests_performed: [],
    significant_findings: [], non_significant_findings: [], effect_sizes: [], recommended_actions: [], statistical_caveats: [],
  }).ok);
  ok("test_hypothesis filters out test item with bad test_type", (() => {
    const r = validateProposal("test_hypothesis", {
      tests_performed: [
        { test_name: "A", test_type: "t_test", null_hypothesis: "H0", p_value: 0.03, reject_null: true, confidence_level: 0.95 },
        { test_name: "B", test_type: "wilcoxon", null_hypothesis: "H0", p_value: 0.03, reject_null: true, confidence_level: 0.95 },
      ],
      significant_findings: [], non_significant_findings: [], effect_sizes: [], recommended_actions: [], statistical_caveats: [],
    });
    return r.ok && (r.payload.tests_performed as unknown[]).length === 1;
  })());
  ok("test_hypothesis filters out test item with p_value > 1", (() => {
    const r = validateProposal("test_hypothesis", {
      tests_performed: [
        { test_name: "A", test_type: "t_test", null_hypothesis: "H0", p_value: 0.03, reject_null: true, confidence_level: 0.95 },
        { test_name: "B", test_type: "anova", null_hypothesis: "H0", p_value: 1.5, reject_null: true, confidence_level: 0.95 },
      ],
      significant_findings: [], non_significant_findings: [], effect_sizes: [], recommended_actions: [], statistical_caveats: [],
    });
    return r.ok && (r.payload.tests_performed as unknown[]).length === 1;
  })());
  ok("hypothesis_testing_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("hypothesis_testing_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentHyt } = await import("./lib/run-agent");
  const { stubBrain: sbHyt } = await import("./lib/agent-brain");
  const { approveAction: approveHyt, listPending: listHyt } = await import("./lib/actions-service");
  const orgHyt = await makeOrg("pro");
  const payloadHyt = await makePayload(orgHyt);
  const rHyt = await runAgentHyt({ orgId: orgHyt, payloadId: payloadHyt, role: "hypothesis_testing_agent" }, { db, brain: sbHyt });
  ok("hypothesis_testing_agent run produced an analysis", rHyt.ok && rHyt.proposalCount === 1);
  const pendHyt = await listHyt(orgHyt, { db });
  ok("stub proposal passes validateProposal and returns test_hypothesis", pendHyt.length === 1 && pendHyt[0].kind === "test_hypothesis");
  const apprHyt = await approveHyt(orgHyt, pendHyt[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes hypothesis_testing_runs", apprHyt.ok && apprHyt.recordTable === "hypothesis_testing_runs", JSON.stringify(apprHyt));
  const { data: hytRows } = await db.from("hypothesis_testing_runs").select("org_id").eq("org_id", orgHyt);
  ok("hypothesis testing record org-stamped", hytRows?.length === 1 && hytRows[0].org_id === orgHyt);
  const { routePayload: routeHyt } = await import("./lib/manager");
  const routeCheckHytFin = await routeHyt({ orgId: orgHyt, payloadId: payloadHyt }, { db, enqueue: () => {} });
  const { data: plainPayloadHyt } = await db.from("inbound_payloads").insert({
    org_id: orgHyt, source: "upload", storage_path: `${orgHyt}/hyt/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckHytNonFin = await routeHyt({ orgId: orgHyt, payloadId: plainPayloadHyt!.id }, { db, enqueue: () => {} });
  ok("hypothesis_testing_agent routes on BOTH the financial and non-financial route",
    routeCheckHytFin.ok && routeCheckHytFin.plan.includes("hypothesis_testing_agent") &&
    routeCheckHytNonFin.ok && routeCheckHytNonFin.plan.includes("hypothesis_testing_agent"));
  await db.from("organizations").delete().eq("id", orgHyt);

  console.log("== pareto agent ==");
  ok("analyze_pareto accepts good", validateProposal("analyze_pareto", {
    analysis_dimension: "Customer", value_metric: "Annual Revenue",
    pareto_entries: [{ rank: 1, dimension_value: "Acme Corp", metric_value: 185000, cumulative_pct: 18.2, pct_of_total: 18.2 }],
    eighty_twenty_threshold: { items_in_top_80_pct: 9, items_in_top_80_pct_pct: 14.1, actual_80_pct_item_count: 9 },
    concentration_score: 86, long_tail_count: 38, business_implications: ["Focus on top customers"],
  }).ok);
  ok("analyze_pareto rejects empty analysis_dimension", !validateProposal("analyze_pareto", {
    analysis_dimension: "", value_metric: "Annual Revenue",
    pareto_entries: [{ rank: 1, dimension_value: "Acme Corp", metric_value: 185000, cumulative_pct: 18.2, pct_of_total: 18.2 }],
    eighty_twenty_threshold: { items_in_top_80_pct: 9, items_in_top_80_pct_pct: 14.1, actual_80_pct_item_count: 9 },
    concentration_score: 86, long_tail_count: 38, business_implications: ["Focus on top customers"],
  }).ok);
  ok("analyze_pareto rejects empty pareto_entries array", !validateProposal("analyze_pareto", {
    analysis_dimension: "Customer", value_metric: "Annual Revenue",
    pareto_entries: [],
    eighty_twenty_threshold: { items_in_top_80_pct: 9, items_in_top_80_pct_pct: 14.1, actual_80_pct_item_count: 9 },
    concentration_score: 86, long_tail_count: 38, business_implications: ["Focus on top customers"],
  }).ok);
  ok("analyze_pareto rejects concentration_score > 100", !validateProposal("analyze_pareto", {
    analysis_dimension: "Customer", value_metric: "Annual Revenue",
    pareto_entries: [{ rank: 1, dimension_value: "Acme Corp", metric_value: 185000, cumulative_pct: 18.2, pct_of_total: 18.2 }],
    eighty_twenty_threshold: { items_in_top_80_pct: 9, items_in_top_80_pct_pct: 14.1, actual_80_pct_item_count: 9 },
    concentration_score: 150, long_tail_count: 38, business_implications: ["Focus on top customers"],
  }).ok);
  ok("pareto_agent → haiku model",
    (await import("./lib/agent-brain")).modelForRole("pareto_agent") === "claude-haiku-4-5-20251001");

  const { runAgent: runAgentPar } = await import("./lib/run-agent");
  const { stubBrain: sbPar } = await import("./lib/agent-brain");
  const { approveAction: approvePar, listPending: listPar } = await import("./lib/actions-service");
  const orgPar = await makeOrg("pro");
  const payloadPar = await makePayload(orgPar);
  const rPar = await runAgentPar({ orgId: orgPar, payloadId: payloadPar, role: "pareto_agent" }, { db, brain: sbPar });
  ok("pareto_agent run produced an analysis", rPar.ok && rPar.proposalCount === 1);
  const pendPar = await listPar(orgPar, { db });
  ok("stub proposal passes validateProposal and returns analyze_pareto", pendPar.length === 1 && pendPar[0].kind === "analyze_pareto");
  const apprPar = await approvePar(orgPar, pendPar[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes pareto_runs", apprPar.ok && apprPar.recordTable === "pareto_runs", JSON.stringify(apprPar));
  const { data: parRows } = await db.from("pareto_runs").select("org_id").eq("org_id", orgPar);
  ok("pareto record org-stamped", parRows?.length === 1 && parRows[0].org_id === orgPar);
  const { routePayload: routePar } = await import("./lib/manager");
  const routeCheckParFin = await routePar({ orgId: orgPar, payloadId: payloadPar }, { db, enqueue: () => {} });
  const { data: plainPayloadPar } = await db.from("inbound_payloads").insert({
    org_id: orgPar, source: "upload", storage_path: `${orgPar}/par/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckParNonFin = await routePar({ orgId: orgPar, payloadId: plainPayloadPar!.id }, { db, enqueue: () => {} });
  ok("pareto_agent routes on BOTH the financial and non-financial route",
    routeCheckParFin.ok && routeCheckParFin.plan.includes("pareto_agent") &&
    routeCheckParNonFin.ok && routeCheckParNonFin.plan.includes("pareto_agent"));
  await db.from("organizations").delete().eq("id", orgPar);

  console.log("== clustering agent ==");
  ok("cluster_data accepts good", validateProposal("cluster_data", {
    clustering_dimensions: ["Annual Revenue", "Days Outstanding"],
    cluster_count: 4,
    clusters: [
      { cluster_id: 1, label: "Champions", size: 87, centroid_description: "High revenue", key_characteristics: ["Fast payers"] },
      { cluster_id: 2, label: "At-Risk", size: 43, centroid_description: "Overdue", key_characteristics: ["Slow payers"] },
    ],
    cluster_quality: "good", outlier_entities: [], business_segments: [], recommended_actions: [],
  }).ok);
  ok("cluster_data rejects cluster_count < 2", !validateProposal("cluster_data", {
    clustering_dimensions: ["Revenue"], cluster_count: 1,
    clusters: [
      { cluster_id: 1, label: "A", size: 10, centroid_description: "x", key_characteristics: [] },
      { cluster_id: 2, label: "B", size: 10, centroid_description: "x", key_characteristics: [] },
    ],
    cluster_quality: "good", outlier_entities: [], business_segments: [], recommended_actions: [],
  }).ok);
  ok("cluster_data rejects cluster_count > 10", !validateProposal("cluster_data", {
    clustering_dimensions: ["Revenue"], cluster_count: 11,
    clusters: [
      { cluster_id: 1, label: "A", size: 10, centroid_description: "x", key_characteristics: [] },
      { cluster_id: 2, label: "B", size: 10, centroid_description: "x", key_characteristics: [] },
    ],
    cluster_quality: "good", outlier_entities: [], business_segments: [], recommended_actions: [],
  }).ok);
  ok("cluster_data rejects bad cluster_quality", !validateProposal("cluster_data", {
    clustering_dimensions: ["Revenue"], cluster_count: 3,
    clusters: [
      { cluster_id: 1, label: "A", size: 10, centroid_description: "x", key_characteristics: [] },
      { cluster_id: 2, label: "B", size: 10, centroid_description: "x", key_characteristics: [] },
    ],
    cluster_quality: "amazing", outlier_entities: [], business_segments: [], recommended_actions: [],
  }).ok);
  ok("clustering_agent → sonnet model",
    (await import("./lib/agent-brain")).modelForRole("clustering_agent") === "claude-sonnet-4-6");

  const { runAgent: runAgentClt } = await import("./lib/run-agent");
  const { stubBrain: sbClt } = await import("./lib/agent-brain");
  const { approveAction: approveClt, listPending: listClt } = await import("./lib/actions-service");
  const orgClt = await makeOrg("pro");
  const payloadClt = await makePayload(orgClt);
  const rClt = await runAgentClt({ orgId: orgClt, payloadId: payloadClt, role: "clustering_agent" }, { db, brain: sbClt });
  ok("clustering_agent run produced an analysis", rClt.ok && rClt.proposalCount === 1);
  const pendClt = await listClt(orgClt, { db });
  ok("stub proposal passes validateProposal and returns cluster_data", pendClt.length === 1 && pendClt[0].kind === "cluster_data");
  const apprClt = await approveClt(orgClt, pendClt[0].id, "00000000-0000-0000-0000-000000000000", { db });
  ok("approve writes clustering_runs", apprClt.ok && apprClt.recordTable === "clustering_runs", JSON.stringify(apprClt));
  const { data: cltRows } = await db.from("clustering_runs").select("org_id").eq("org_id", orgClt);
  ok("clustering record org-stamped", cltRows?.length === 1 && cltRows[0].org_id === orgClt);
  const { routePayload: routeClt } = await import("./lib/manager");
  const routeCheckCltFin = await routeClt({ orgId: orgClt, payloadId: payloadClt }, { db, enqueue: () => {} });
  const { data: plainPayloadClt } = await db.from("inbound_payloads").insert({
    org_id: orgClt, source: "upload", storage_path: `${orgClt}/clt/plain.csv`, original_filename: "plain.csv",
    mime_type: "text/csv", scan_status: "clean", status: "completed",
    extracted_json: { columns: ["name", "city"], rowCount: 1, rows: [["a", "b"]], truncated: false, parser: "static-mvp" },
  }).select("id").single();
  const routeCheckCltNonFin = await routeClt({ orgId: orgClt, payloadId: plainPayloadClt!.id }, { db, enqueue: () => {} });
  ok("clustering_agent routes on BOTH the financial and non-financial route",
    routeCheckCltFin.ok && routeCheckCltFin.plan.includes("clustering_agent") &&
    routeCheckCltNonFin.ok && routeCheckCltNonFin.plan.includes("clustering_agent"));
  await db.from("organizations").delete().eq("id", orgClt);

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
