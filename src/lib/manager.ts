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
  const plan: LLMRole[] = ["data_quality", "compliance_agent", "onboarding_agent", "clarification_agent", "multi_period", "audit_summarizer", "sql_analyst", "anomaly_detector", "categorizer", "data_cleaner", "unit_normalizer", "duplicate_detector"];
  const financial = looksFinancial(columns);
  if (financial) {
    plan.push("reconciler", "invoice_matcher", "cash_flow_agent", "tax_categorizer", "budget_analyst", "vendor_risk", "trend_detector", "period_comparator", "health_scorer", "email_drafter", "recommender", "pattern_memory", "accountant", "forecaster");
  } else {
    plan.push("inventory_tracker", "reorder_flagger", "supplier_analyst", "po_agent", "code_reviewer", "code_tester", "vendor_risk", "trend_detector", "period_comparator", "health_scorer", "email_drafter", "recommender", "pattern_memory", "data_merger"); // non-financial only
  }
  plan.push("report_generator"); // always, before exec_summarizer
  plan.push("exec_summarizer"); // always, before alert_agent
  plan.push("alert_agent"); // always, before client_reporter
  plan.push("client_reporter"); // always, before validator
  plan.push("validator"); // always, last before analyst
  plan.push("analyst"); // always

  for (const role of plan) {
    enqueue({ name: "agent/run", data: { orgId, payloadId, role } });
  }
  await db.from("system_audit_logs").insert({
    org_id: orgId, action: "manager.routed", log_meta: { payloadId, plan },
  });
  return { ok: true, plan };
}
