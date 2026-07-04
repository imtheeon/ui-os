/**
 * src/lib/manager.ts — deterministic router (no LLM, no side effects). Handler
 * for the trusted 'payload/completed' event: inspect the payload's column names,
 * decide which agents apply, and enqueue an 'agent/run' per selected role.
 * orgId rides inside the event and is forwarded verbatim.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { UiEvent } from "./queue";
import type { LLMRole } from "./agent-brain";

const FINANCE_LEXICON = [
  "amount", "total", "price", "cost", "revenue", "debit", "credit",
  "balance", "invoice", "tax", "payment",
];

/** Pure: any column name containing a finance term (case-insensitive) ⇒ financial. */
export function looksFinancial(columns: string[]): boolean {
  return columns.some((c) => {
    const lc = c.toLowerCase();
    return FINANCE_LEXICON.some((term) => lc.includes(term));
  });
}

export async function routePayload(
  params: { orgId: string; payloadId: string },
  deps?: { db?: SupabaseClient; enqueue?: (e: UiEvent) => void }
): Promise<{ ok: true; plan: LLMRole[] } | { ok: false; code: string }> {
  const { orgId, payloadId } = params;
  const db = deps?.db ?? (await import("../db")).supabase;
  const enqueue = deps?.enqueue ?? (await import("./queue")).enqueue;

  const { data: row, error } = await db
    .from("inbound_payloads")
    .select("status, extracted_json")
    .eq("id", payloadId).eq("org_id", orgId).maybeSingle();
  if (error) return { ok: false, code: "DB_ERROR" };
  if (!row || row.status !== "completed") return { ok: false, code: "NOT_ELIGIBLE" };

  const columns = ((row.extracted_json as { columns?: string[] } | null)?.columns) ?? [];
  const plan: LLMRole[] = ["document_classifier", "schema_evolution_agent", "column_profiler", "data_dictionary_agent", "missing_data_agent", "headcount_analytics_agent", "productivity_agent", "growth_rate_agent", "data_privacy_agent", "data_quality", "compliance_agent", "onboarding_agent", "clarification_agent", "multi_period", "audit_summarizer", "kpi_extractor", "sql_analyst", "anomaly_detector", "categorizer", "data_cleaner", "unit_normalizer", "duplicate_detector", "outlier_explanation_agent", "time_series_decomp_agent", "failure_risk_agent", "run_rate_agent"];
  const financial = looksFinancial(columns);
  if (financial) {
    plan.push("reconciler", "invoice_matcher", "cash_flow_agent", "tax_categorizer", "budget_analyst", "saas_metrics_agent", "burn_rate_agent", "cohort_agent", "ar_aging_agent", "ap_agent", "bank_recon_agent", "ratio_analysis_agent", "profitability_agent", "working_capital_agent", "break_even_agent", "cogs_analysis_agent", "revenue_recognition_agent", "churn_risk_agent", "customer_segmentation_agent", "sales_pipeline_agent", "pricing_optimization_agent", "contract_analysis_agent", "marketing_roi_agent", "fraud_detection_agent", "concentration_risk_agent", "scenario_agent", "liquidity_risk_agent", "covenant_tracking_agent", "transaction_classifier", "expense_policy_agent", "subscription_tracker", "commission_calculator", "overtime_analysis_agent", "unit_economics_agent", "valuation_agent", "cap_table_agent", "lease_analysis_agent", "asset_register_agent", "price_volume_mix_agent", "bridge_analysis_agent", "vendor_risk", "trend_detector", "period_comparator", "health_scorer", "email_drafter", "recommender", "pattern_memory", "accountant", "forecaster");
  } else {
    plan.push("inventory_tracker", "reorder_flagger", "supplier_analyst", "po_agent", "code_reviewer", "code_tester", "customer_segmentation_agent", "contract_analysis_agent", "fraud_detection_agent", "concentration_risk_agent", "scenario_agent", "vendor_risk", "trend_detector", "period_comparator", "health_scorer", "email_drafter", "recommender", "pattern_memory", "data_merger"); // non-financial only
  }
  plan.push("report_generator"); // always, before exec_summarizer
  plan.push("exec_summarizer"); // always, before alert_agent
  plan.push("insight_synthesis_agent"); // always, after exec_summarizer
  plan.push("conflict_detection_agent"); // always, after insight_synthesis_agent
  plan.push("alert_agent"); // always, before client_reporter
  plan.push("client_reporter"); // always, before narrator
  plan.push("narrator"); // always, before meeting_prepper
  plan.push("meeting_prepper"); // always, before board_deck_builder
  plan.push("board_deck_builder"); // always, before viz_recommender
  plan.push("viz_recommender"); // always, before chart_config_agent
  plan.push("chart_config_agent"); // always, before kpi_card_agent
  plan.push("kpi_card_agent"); // always, before dashboard_spec_agent
  plan.push("dashboard_spec_agent"); // always, before validator
  plan.push("validator"); // always, last before analyst
  plan.push("analyst"); // always
  plan.push("action_priority_agent"); // always, final agent before output

  for (const role of plan) {
    enqueue({ name: "agent/run", data: { orgId, payloadId, role } });
  }
  await db.from("system_audit_logs").insert({
    org_id: orgId, action: "manager.routed", log_meta: { payloadId, plan },
  });
  return { ok: true, plan };
}
