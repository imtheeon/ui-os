/**
 * src/lib/agent-actions.ts — the typed action registry shared by the executor
 * and the agent handler. Defines WHICH action kinds exist and validates a
 * model-proposed payload for each. Validation is a SECURITY boundary: the LLM
 * supplies content; code decides whether it is a legal, bounded action of a
 * known kind before any row is ever written. Unknown kind / bad shape → reject.
 */
export const ACTION_KINDS = ["record_ledger_entry", "store_report", "flag_anomaly", "categorize_items", "clean_data", "merge_datasets", "normalize_units", "reconcile_records", "match_invoices", "project_cash_flow", "categorize_tax_items", "flag_duplicates", "compare_budget_actual", "track_inventory", "flag_reorders", "analyze_suppliers", "process_purchase_orders", "detect_trends", "compare_periods", "generate_exec_summary", "generate_forecast", "generate_report", "assess_data_quality", "flag_compliance_issues", "assess_vendor_risk", "generate_onboarding_guidance", "request_clarification", "analyze_multi_period", "summarize_audit_trail", "review_code", "generate_tests", "analyze_sql", "validate_analysis", "generate_health_score", "draft_email", "generate_recommendations", "extract_patterns", "generate_alerts", "generate_client_report", "generate_narrative", "prepare_meeting", "build_board_deck", "recommend_visualizations", "generate_chart_configs", "extract_kpi_cards", "generate_dashboard_spec", "calculate_saas_metrics", "calculate_burn_rate", "analyze_cohorts", "analyze_ar_aging", "analyze_accounts_payable", "reconcile_bank", "analyze_financial_ratios", "analyze_profitability", "analyze_working_capital", "calculate_break_even", "analyze_cogs", "analyze_revenue_recognition", "analyze_churn_risk", "segment_customers", "analyze_sales_pipeline", "analyze_pricing", "analyze_contracts", "analyze_marketing_roi", "detect_fraud_signals", "analyze_concentration_risk", "model_scenarios", "analyze_liquidity_risk", "track_covenants", "classify_document", "detect_schema_evolution", "extract_kpis", "synthesize_insights", "detect_conflicts", "prioritize_actions", "profile_columns", "build_data_dictionary", "analyze_missing_data", "assess_data_privacy", "classify_transactions", "check_expense_policy", "track_subscriptions", "analyze_headcount_analytics", "calculate_commissions", "analyze_productivity", "analyze_overtime", "calculate_growth_rates", "explain_outliers", "decompose_time_series", "assess_failure_risk", "analyze_unit_economics", "estimate_valuation", "analyze_cap_table", "analyze_leases", "analyze_asset_register", "analyze_price_volume_mix", "build_bridge_analysis", "calculate_run_rate", "analyze_spend", "analyze_discounts", "detect_maverick_spend", "prioritize_collections", "calculate_bad_debt_provision", "score_credit_risk", "analyze_fx_exposure", "draft_investor_memo", "track_okrs", "conduct_swot", "build_queries", "generate_esg_report", "analyze_seasonality", "benchmark_performance", "consolidate_entities", "analyze_ecommerce", "analyze_professional_services", "analyze_nonprofit_financials", "analyze_healthcare_financials", "analyze_legal_billing", "analyze_hospitality_financials", "analyze_retail_performance", "analyze_construction_financials", "analyze_revenue_quality", "analyze_customer_cohorts", "analyze_variances", "forecast_cash_flow", "forecast_expenses", "analyze_headcount", "analyze_debt_covenants", "analyze_tax_provision", "manage_collections", "benchmark_competitive", "evaluate_data_quality", "detect_schema", "draft_board_narrative"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

const MAX_STR = 2_000; // clamp every string field (DoS + bounded storage)
const MAX_AMOUNT_CENTS = 1_000_000_000_00; // $1B sanity ceiling

type Ok = { ok: true; kind: ActionKind; payload: Record<string, unknown> };
type Err = { ok: false; reason: string };

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, MAX_STR) : null;
}

/** Filters a proposed array down to non-empty strings, truncated per-item, bounded in count. */
function strArray(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .slice(0, maxItems)
    .map((s) => s.slice(0, maxLen));
}

/** Sentinel distinguishing "field present but invalid" from a legitimate null. */
const NUM_INVALID = Symbol("num_invalid");
/** A nullable numeric field: null passes through; a present value must be a finite number in range. */
function numOrNull(v: unknown, min = -Infinity, max = Infinity): number | null | typeof NUM_INVALID {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max) return v;
  return NUM_INVALID;
}

export function validateProposal(kind: string, payload: unknown): Ok | Err {
  if (!(ACTION_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: `unknown_kind:${kind}` };
  }
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "payload_not_object" };
  }
  const p = payload as Record<string, unknown>;

  if (kind === "record_ledger_entry") {
    const description = str(p.description);
    const amount = typeof p.amount_cents === "number" ? Math.round(p.amount_cents) : NaN;
    const direction = p.direction === "debit" || p.direction === "credit" ? p.direction : null;
    if (!description) return { ok: false, reason: "missing_description" };
    if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT_CENTS) {
      return { ok: false, reason: "bad_amount_cents" };
    }
    if (!direction) return { ok: false, reason: "bad_direction" };
    const occurred_on = str(p.occurred_on); // optional ISO date string; stored as-is, validated by DB date cast
    return {
      ok: true,
      kind: "record_ledger_entry",
      payload: { description, amount_cents: amount, direction, occurred_on },
    };
  }

  if (kind === "flag_anomaly") {
    const description = str(p.description);
    const severity = p.severity === "low" || p.severity === "medium" || p.severity === "high" ? p.severity : null;
    const row_reference = str(p.row_reference);
    if (!description) return { ok: false, reason: "missing_description" };
    if (!severity) return { ok: false, reason: "bad_severity" };
    if (!row_reference) return { ok: false, reason: "missing_row_reference" };
    return { ok: true, kind: "flag_anomaly", payload: { description, severity, row_reference } };
  }

  if (kind === "categorize_items") {
    const scheme = str(p.scheme);
    if (!scheme) return { ok: false, reason: "missing_scheme" };
    if (!Array.isArray(p.assignments)) return { ok: false, reason: "assignments_not_array" };
    const MAX_ASSIGNMENTS = 50;
    const raw = (p.assignments as unknown[]).slice(0, MAX_ASSIGNMENTS);
    const assignments: { row_reference: string; category: string }[] = [];
    for (const a of raw) {
      if (typeof a !== "object" || a === null) continue;
      const rr = str((a as Record<string, unknown>).row_reference);
      const cat = str((a as Record<string, unknown>).category);
      if (rr && cat) assignments.push({ row_reference: rr, category: cat });
    }
    return { ok: true, kind: "categorize_items", payload: { scheme, assignments } };
  }

  if (kind === "clean_data") {
    if (!Array.isArray(p.issues)) return { ok: false, reason: "issues_not_array" };
    const rowsAffected = typeof p.rows_affected === "number" ? Math.round(p.rows_affected) : NaN;
    if (!Number.isFinite(rowsAffected) || rowsAffected < 0) {
      return { ok: false, reason: "bad_rows_affected" };
    }
    const MAX_ISSUES = 100;
    const raw = (p.issues as unknown[]).slice(0, MAX_ISSUES);
    const issues: { row_reference: string; column: string; issue_type: string; original_value: string; suggested_value: string }[] = [];
    for (const i of raw) {
      if (typeof i !== "object" || i === null) continue;
      const rec = i as Record<string, unknown>;
      const row_reference = str(rec.row_reference);
      const column = str(rec.column);
      const issue_type = str(rec.issue_type);
      const suggested_value = str(rec.suggested_value);
      if (row_reference && column && issue_type && suggested_value) {
        issues.push({
          row_reference, column, issue_type, suggested_value,
          original_value: str(rec.original_value) ?? "",
        });
      }
    }
    return { ok: true, kind: "clean_data", payload: { issues, rows_affected: rowsAffected } };
  }

  if (kind === "merge_datasets") {
    const merge_strategy = str(p.merge_strategy);
    if (!merge_strategy) return { ok: false, reason: "missing_merge_strategy" };
    if (!Array.isArray(p.join_columns) || p.join_columns.length === 0) {
      return { ok: false, reason: "missing_join_columns" };
    }
    const MAX_JOIN_COLUMNS = 20;
    const rawCols = (p.join_columns as unknown[]).slice(0, MAX_JOIN_COLUMNS);
    const join_columns: string[] = [];
    for (const c of rawCols) {
      const s = str(c);
      if (s) join_columns.push(s);
    }
    if (join_columns.length === 0) return { ok: false, reason: "missing_join_columns" };
    const related_payload_hint = str(p.related_payload_hint);
    if (!related_payload_hint) return { ok: false, reason: "missing_related_payload_hint" };
    let estimated_merged_rows: number | null = null;
    if (p.estimated_merged_rows !== undefined && p.estimated_merged_rows !== null) {
      const n = typeof p.estimated_merged_rows === "number" ? Math.round(p.estimated_merged_rows) : NaN;
      if (!Number.isFinite(n) || n < 0) return { ok: false, reason: "bad_estimated_merged_rows" };
      estimated_merged_rows = n;
    }
    return {
      ok: true,
      kind: "merge_datasets",
      payload: { merge_strategy, join_columns, related_payload_hint, estimated_merged_rows },
    };
  }

  if (kind === "normalize_units") {
    const UNIT_TYPES = ["currency", "weight", "volume", "length", "percentage", "mixed", "other"];
    const unit_type = typeof p.unit_type === "string" && UNIT_TYPES.includes(p.unit_type) ? p.unit_type : null;
    if (!unit_type) return { ok: false, reason: "bad_unit_type" };
    const target_unit = str(p.target_unit);
    if (!target_unit) return { ok: false, reason: "missing_target_unit" };
    const valuesAffected = typeof p.values_affected === "number" ? Math.round(p.values_affected) : NaN;
    if (!Number.isFinite(valuesAffected) || valuesAffected < 0) {
      return { ok: false, reason: "bad_values_affected" };
    }
    if (!Array.isArray(p.normalizations)) return { ok: false, reason: "normalizations_not_array" };
    const MAX_NORMALIZATIONS = 200;
    const raw = (p.normalizations as unknown[]).slice(0, MAX_NORMALIZATIONS);
    const normalizations: {
      row_reference: string; column: string; original_value: string;
      normalized_value: string; unit_type: string; target_unit: string;
    }[] = [];
    for (const n of raw) {
      if (typeof n !== "object" || n === null) continue;
      const rec = n as Record<string, unknown>;
      const row_reference = str(rec.row_reference);
      const column = str(rec.column);
      const original_value = str(rec.original_value);
      const normalized_value = str(rec.normalized_value);
      const nUnitType = str(rec.unit_type);
      const nTargetUnit = str(rec.target_unit);
      if (row_reference && column && original_value && normalized_value && nUnitType && nTargetUnit) {
        normalizations.push({
          row_reference, column, original_value, normalized_value,
          unit_type: nUnitType, target_unit: nTargetUnit,
        });
      }
    }
    return {
      ok: true,
      kind: "normalize_units",
      payload: { normalizations, unit_type, target_unit, values_affected: valuesAffected },
    };
  }

  if (kind === "reconcile_records") {
    const matchedCount = typeof p.matched_count === "number" ? Math.round(p.matched_count) : NaN;
    if (!Number.isFinite(matchedCount) || matchedCount < 0) return { ok: false, reason: "bad_matched_count" };
    const unmatchedCount = typeof p.unmatched_count === "number" ? Math.round(p.unmatched_count) : NaN;
    if (!Number.isFinite(unmatchedCount) || unmatchedCount < 0) return { ok: false, reason: "bad_unmatched_count" };
    if (!Array.isArray(p.match_details)) return { ok: false, reason: "match_details_not_array" };
    const MATCH_STATUSES = ["matched", "unmatched", "partial"];
    const MAX_MATCH_DETAILS = 500;
    const raw = (p.match_details as unknown[]).slice(0, MAX_MATCH_DETAILS);
    const match_details: { row_reference: string; match_status: string; matched_value: string; confidence: number }[] = [];
    for (const m of raw) {
      if (typeof m !== "object" || m === null) continue;
      const rec = m as Record<string, unknown>;
      const row_reference = str(rec.row_reference);
      const match_status = typeof rec.match_status === "string" && MATCH_STATUSES.includes(rec.match_status) ? rec.match_status : null;
      const matched_value = str(rec.matched_value);
      const confidence = typeof rec.confidence === "number" ? rec.confidence : NaN;
      if (row_reference && match_status && matched_value && Number.isFinite(confidence) && confidence >= 0.0 && confidence <= 1.0) {
        match_details.push({ row_reference, match_status, matched_value, confidence });
      }
    }
    return {
      ok: true,
      kind: "reconcile_records",
      payload: { match_details, matched_count: matchedCount, unmatched_count: unmatchedCount },
    };
  }

  if (kind === "match_invoices") {
    const totalMatched = typeof p.total_matched === "number" ? Math.round(p.total_matched) : NaN;
    if (!Number.isFinite(totalMatched) || totalMatched < 0) return { ok: false, reason: "bad_total_matched" };
    const totalDiscrepancyCents = typeof p.total_discrepancy_cents === "number" ? Math.round(p.total_discrepancy_cents) : NaN;
    if (!Number.isFinite(totalDiscrepancyCents)) return { ok: false, reason: "bad_total_discrepancy_cents" };
    if (!Array.isArray(p.matches)) return { ok: false, reason: "matches_not_array" };
    const MATCH_STATUSES = ["matched", "partial", "unmatched"];
    const MAX_MATCHES = 200;
    const raw = (p.matches as unknown[]).slice(0, MAX_MATCHES);
    const matches: { invoice_ref: string; po_ref: string; amount_cents: number; match_status: string; discrepancy_cents: number }[] = [];
    for (const m of raw) {
      if (typeof m !== "object" || m === null) continue;
      const rec = m as Record<string, unknown>;
      const invoice_ref = str(rec.invoice_ref);
      const po_ref = str(rec.po_ref);
      const amount_cents = typeof rec.amount_cents === "number" ? Math.round(rec.amount_cents) : NaN;
      const match_status = typeof rec.match_status === "string" && MATCH_STATUSES.includes(rec.match_status) ? rec.match_status : null;
      const discrepancy_cents = typeof rec.discrepancy_cents === "number" ? Math.round(rec.discrepancy_cents) : NaN;
      if (invoice_ref && po_ref && Number.isFinite(amount_cents) && amount_cents >= 0 && match_status && Number.isFinite(discrepancy_cents)) {
        matches.push({ invoice_ref, po_ref, amount_cents, match_status, discrepancy_cents });
      }
    }
    return {
      ok: true,
      kind: "match_invoices",
      payload: { matches, total_matched: totalMatched, total_discrepancy_cents: totalDiscrepancyCents },
    };
  }

  if (kind === "project_cash_flow") {
    const PERIODS = ["30_days", "90_days", "12_months", "unknown"];
    const projection_period = typeof p.projection_period === "string" && PERIODS.includes(p.projection_period) ? p.projection_period : null;
    if (!projection_period) return { ok: false, reason: "bad_projection_period" };
    const RISK_LEVELS = ["low", "medium", "high", "critical"];
    const risk_level = typeof p.risk_level === "string" && RISK_LEVELS.includes(p.risk_level) ? p.risk_level : null;
    if (!risk_level) return { ok: false, reason: "bad_risk_level" };
    const inflowCents = typeof p.inflow_cents === "number" ? Math.round(p.inflow_cents) : NaN;
    if (!Number.isFinite(inflowCents) || inflowCents < 0) return { ok: false, reason: "bad_inflow_cents" };
    const outflowCents = typeof p.outflow_cents === "number" ? Math.round(p.outflow_cents) : NaN;
    if (!Number.isFinite(outflowCents) || outflowCents < 0) return { ok: false, reason: "bad_outflow_cents" };
    const netCents = typeof p.net_cents === "number" ? Math.round(p.net_cents) : NaN;
    if (!Number.isFinite(netCents)) return { ok: false, reason: "bad_net_cents" };
    let runway_days: number | null = null;
    if (p.runway_days !== undefined && p.runway_days !== null) {
      const n = typeof p.runway_days === "number" ? Math.round(p.runway_days) : NaN;
      if (!Number.isFinite(n) || n < 0) return { ok: false, reason: "bad_runway_days" };
      runway_days = n;
    }
    const summary = str(p.summary);
    if (!summary) return { ok: false, reason: "missing_summary" };
    return {
      ok: true,
      kind: "project_cash_flow",
      payload: {
        projection_period, risk_level, inflow_cents: inflowCents, outflow_cents: outflowCents,
        net_cents: netCents, runway_days, summary,
      },
    };
  }

  if (kind === "categorize_tax_items") {
    const totalDeductibleCents = typeof p.total_deductible_cents === "number" ? Math.round(p.total_deductible_cents) : NaN;
    if (!Number.isFinite(totalDeductibleCents) || totalDeductibleCents < 0) return { ok: false, reason: "bad_total_deductible_cents" };
    const totalNonDeductibleCents = typeof p.total_non_deductible_cents === "number" ? Math.round(p.total_non_deductible_cents) : NaN;
    if (!Number.isFinite(totalNonDeductibleCents) || totalNonDeductibleCents < 0) return { ok: false, reason: "bad_total_non_deductible_cents" };
    if (!Array.isArray(p.assignments)) return { ok: false, reason: "assignments_not_array" };
    const MAX_TAX_ASSIGNMENTS = 200;
    const MAX_TAX_CATEGORY_LEN = 100;
    const raw = (p.assignments as unknown[]).slice(0, MAX_TAX_ASSIGNMENTS);
    const assignments: { row_reference: string; description: string; amount_cents: number; tax_category: string; deductible: boolean }[] = [];
    for (const a of raw) {
      if (typeof a !== "object" || a === null) continue;
      const rec = a as Record<string, unknown>;
      const row_reference = str(rec.row_reference);
      const description = str(rec.description);
      const amount_cents = typeof rec.amount_cents === "number" ? Math.round(rec.amount_cents) : NaN;
      const tax_category = typeof rec.tax_category === "string" && rec.tax_category.length > 0
        ? rec.tax_category.slice(0, MAX_TAX_CATEGORY_LEN) : null;
      const deductible = typeof rec.deductible === "boolean" ? rec.deductible : null;
      if (row_reference && description && Number.isFinite(amount_cents) && amount_cents >= 0 && tax_category && deductible !== null) {
        assignments.push({ row_reference, description, amount_cents, tax_category, deductible });
      }
    }
    return {
      ok: true,
      kind: "categorize_tax_items",
      payload: { assignments, total_deductible_cents: totalDeductibleCents, total_non_deductible_cents: totalNonDeductibleCents },
    };
  }

  if (kind === "flag_duplicates") {
    const duplicateCount = typeof p.duplicate_count === "number" ? Math.round(p.duplicate_count) : NaN;
    if (!Number.isFinite(duplicateCount) || duplicateCount < 0) return { ok: false, reason: "bad_duplicate_count" };
    if (!Array.isArray(p.duplicates)) return { ok: false, reason: "duplicates_not_array" };
    const DUPLICATE_TYPES = ["exact", "near_exact", "fuzzy"];
    const MAX_DUPLICATES = 100;
    const raw = (p.duplicates as unknown[]).slice(0, MAX_DUPLICATES);
    const duplicates: { row_references: string[]; similarity_score: number; duplicate_type: string; key_columns: string[] }[] = [];
    for (const d of raw) {
      if (typeof d !== "object" || d === null) continue;
      const rec = d as Record<string, unknown>;
      const rowRefsRaw = Array.isArray(rec.row_references) ? rec.row_references : [];
      const row_references = rowRefsRaw.filter((r): r is string => typeof r === "string" && r.length > 0);
      const similarity_score = typeof rec.similarity_score === "number" ? rec.similarity_score : NaN;
      const duplicate_type = typeof rec.duplicate_type === "string" && DUPLICATE_TYPES.includes(rec.duplicate_type) ? rec.duplicate_type : null;
      const keyColsRaw = Array.isArray(rec.key_columns) ? rec.key_columns : [];
      const key_columns = keyColsRaw.filter((c): c is string => typeof c === "string" && c.length > 0);
      if (row_references.length >= 2 && Number.isFinite(similarity_score) && similarity_score >= 0.0 && similarity_score <= 1.0 && duplicate_type) {
        duplicates.push({ row_references, similarity_score, duplicate_type, key_columns });
      }
    }
    return {
      ok: true,
      kind: "flag_duplicates",
      payload: { duplicates, duplicate_count: duplicateCount },
    };
  }

  if (kind === "compare_budget_actual") {
    const OVERALL_STATUSES = ["on_track", "over_budget", "under_budget", "mixed"];
    const overall_status = typeof p.overall_status === "string" && OVERALL_STATUSES.includes(p.overall_status) ? p.overall_status : null;
    if (!overall_status) return { ok: false, reason: "bad_overall_status" };
    const totalBudgetedCents = typeof p.total_budgeted_cents === "number" ? Math.round(p.total_budgeted_cents) : NaN;
    if (!Number.isFinite(totalBudgetedCents) || totalBudgetedCents < 0) return { ok: false, reason: "bad_total_budgeted_cents" };
    const totalActualCents = typeof p.total_actual_cents === "number" ? Math.round(p.total_actual_cents) : NaN;
    if (!Number.isFinite(totalActualCents) || totalActualCents < 0) return { ok: false, reason: "bad_total_actual_cents" };
    const totalVarianceCents = typeof p.total_variance_cents === "number" ? Math.round(p.total_variance_cents) : NaN;
    if (!Number.isFinite(totalVarianceCents)) return { ok: false, reason: "bad_total_variance_cents" };
    if (!Array.isArray(p.comparisons)) return { ok: false, reason: "comparisons_not_array" };
    const COMPARISON_STATUSES = ["on_track", "over_budget", "under_budget"];
    const MAX_COMPARISONS = 200;
    const raw = (p.comparisons as unknown[]).slice(0, MAX_COMPARISONS);
    const comparisons: { category: string; budgeted_cents: number; actual_cents: number; variance_cents: number; variance_pct: number; status: string }[] = [];
    for (const c of raw) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const category = str(rec.category);
      const budgeted_cents = typeof rec.budgeted_cents === "number" ? Math.round(rec.budgeted_cents) : NaN;
      const actual_cents = typeof rec.actual_cents === "number" ? Math.round(rec.actual_cents) : NaN;
      const variance_cents = typeof rec.variance_cents === "number" ? Math.round(rec.variance_cents) : NaN;
      const variance_pct = typeof rec.variance_pct === "number" ? rec.variance_pct : NaN;
      const status = typeof rec.status === "string" && COMPARISON_STATUSES.includes(rec.status) ? rec.status : null;
      if (
        category && Number.isFinite(budgeted_cents) && budgeted_cents >= 0 &&
        Number.isFinite(actual_cents) && actual_cents >= 0 &&
        Number.isFinite(variance_cents) && Number.isFinite(variance_pct) && status
      ) {
        comparisons.push({ category, budgeted_cents, actual_cents, variance_cents, variance_pct, status });
      }
    }
    return {
      ok: true,
      kind: "compare_budget_actual",
      payload: {
        comparisons, total_budgeted_cents: totalBudgetedCents, total_actual_cents: totalActualCents,
        total_variance_cents: totalVarianceCents, overall_status,
      },
    };
  }

  if (kind === "track_inventory") {
    const totalItems = typeof p.total_items === "number" ? Math.round(p.total_items) : NaN;
    if (!Number.isFinite(totalItems) || totalItems < 0) return { ok: false, reason: "bad_total_items" };
    const totalValueCents = typeof p.total_value_cents === "number" ? Math.round(p.total_value_cents) : NaN;
    if (!Number.isFinite(totalValueCents) || totalValueCents < 0) return { ok: false, reason: "bad_total_value_cents" };
    if (!Array.isArray(p.items)) return { ok: false, reason: "items_not_array" };
    const MAX_ITEMS = 500;
    const raw = (p.items as unknown[]).slice(0, MAX_ITEMS);
    const items: { sku: string; name: string; quantity: number; unit_value_cents: number; location: string }[] = [];
    for (const it of raw) {
      if (typeof it !== "object" || it === null) continue;
      const rec = it as Record<string, unknown>;
      const sku = str(rec.sku);
      const name = str(rec.name);
      const quantity = typeof rec.quantity === "number" ? Math.round(rec.quantity) : NaN;
      const unit_value_cents = typeof rec.unit_value_cents === "number" ? Math.round(rec.unit_value_cents) : NaN;
      const location = typeof rec.location === "string" ? rec.location.slice(0, MAX_STR) : "";
      if (sku && name && Number.isFinite(quantity) && quantity >= 0 && Number.isFinite(unit_value_cents) && unit_value_cents >= 0) {
        items.push({ sku, name, quantity, unit_value_cents, location });
      }
    }
    return {
      ok: true,
      kind: "track_inventory",
      payload: { items, total_items: totalItems, total_value_cents: totalValueCents },
    };
  }

  if (kind === "flag_reorders") {
    const criticalCount = typeof p.critical_count === "number" ? Math.round(p.critical_count) : NaN;
    if (!Number.isFinite(criticalCount) || criticalCount < 0) return { ok: false, reason: "bad_critical_count" };
    const warningCount = typeof p.warning_count === "number" ? Math.round(p.warning_count) : NaN;
    if (!Number.isFinite(warningCount) || warningCount < 0) return { ok: false, reason: "bad_warning_count" };
    if (!Array.isArray(p.flags)) return { ok: false, reason: "flags_not_array" };
    const URGENCIES = ["critical", "warning", "ok"];
    const MAX_FLAGS = 200;
    const raw = (p.flags as unknown[]).slice(0, MAX_FLAGS);
    const flags: { sku: string; name: string; current_quantity: number; reorder_point: number; urgency: string; suggested_reorder_qty: number }[] = [];
    for (const f of raw) {
      if (typeof f !== "object" || f === null) continue;
      const rec = f as Record<string, unknown>;
      const sku = str(rec.sku);
      const name = str(rec.name);
      const current_quantity = typeof rec.current_quantity === "number" ? Math.round(rec.current_quantity) : NaN;
      const reorder_point = typeof rec.reorder_point === "number" ? Math.round(rec.reorder_point) : NaN;
      const urgency = typeof rec.urgency === "string" && URGENCIES.includes(rec.urgency) ? rec.urgency : null;
      const suggested_reorder_qty = typeof rec.suggested_reorder_qty === "number" ? Math.round(rec.suggested_reorder_qty) : NaN;
      if (
        sku && name && Number.isFinite(current_quantity) && current_quantity >= 0 &&
        Number.isFinite(reorder_point) && reorder_point >= 0 && urgency &&
        Number.isFinite(suggested_reorder_qty) && suggested_reorder_qty >= 0
      ) {
        flags.push({ sku, name, current_quantity, reorder_point, urgency, suggested_reorder_qty });
      }
    }
    return {
      ok: true,
      kind: "flag_reorders",
      payload: { flags, critical_count: criticalCount, warning_count: warningCount },
    };
  }

  if (kind === "analyze_suppliers") {
    const RISK_LEVELS_CONC = ["low", "medium", "high", "critical"];
    const concentration_risk = typeof p.concentration_risk === "string" && RISK_LEVELS_CONC.includes(p.concentration_risk) ? p.concentration_risk : null;
    if (!concentration_risk) return { ok: false, reason: "bad_concentration_risk" };
    const totalSuppliers = typeof p.total_suppliers === "number" ? Math.round(p.total_suppliers) : NaN;
    if (!Number.isFinite(totalSuppliers) || totalSuppliers < 0) return { ok: false, reason: "bad_total_suppliers" };
    if (!Array.isArray(p.suppliers)) return { ok: false, reason: "suppliers_not_array" };
    const SUPPLIER_RISK_LEVELS = ["low", "medium", "high"];
    const MAX_SUPPLIERS = 100;
    const raw = (p.suppliers as unknown[]).slice(0, MAX_SUPPLIERS);
    const suppliers: { supplier_name: string; total_spend_cents: number; order_count: number; on_time_rate: number; risk_level: string; notes: string }[] = [];
    for (const s of raw) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const supplier_name = str(rec.supplier_name);
      const total_spend_cents = typeof rec.total_spend_cents === "number" ? Math.round(rec.total_spend_cents) : NaN;
      const order_count = typeof rec.order_count === "number" ? Math.round(rec.order_count) : NaN;
      const on_time_rate = typeof rec.on_time_rate === "number" ? rec.on_time_rate : NaN;
      const risk_level = typeof rec.risk_level === "string" && SUPPLIER_RISK_LEVELS.includes(rec.risk_level) ? rec.risk_level : null;
      const notes = typeof rec.notes === "string" ? rec.notes.slice(0, MAX_STR) : "";
      if (
        supplier_name && Number.isFinite(total_spend_cents) && total_spend_cents >= 0 &&
        Number.isFinite(order_count) && order_count >= 0 &&
        Number.isFinite(on_time_rate) && on_time_rate >= 0.0 && on_time_rate <= 1.0 && risk_level
      ) {
        suppliers.push({ supplier_name, total_spend_cents, order_count, on_time_rate, risk_level, notes });
      }
    }
    return {
      ok: true,
      kind: "analyze_suppliers",
      payload: { suppliers, total_suppliers: totalSuppliers, concentration_risk },
    };
  }

  if (kind === "process_purchase_orders") {
    const totalOrders = typeof p.total_orders === "number" ? Math.round(p.total_orders) : NaN;
    if (!Number.isFinite(totalOrders) || totalOrders < 0) return { ok: false, reason: "bad_total_orders" };
    const totalValueCents = typeof p.total_value_cents === "number" ? Math.round(p.total_value_cents) : NaN;
    if (!Number.isFinite(totalValueCents) || totalValueCents < 0) return { ok: false, reason: "bad_total_value_cents" };
    const pendingCount = typeof p.pending_count === "number" ? Math.round(p.pending_count) : NaN;
    if (!Number.isFinite(pendingCount) || pendingCount < 0) return { ok: false, reason: "bad_pending_count" };
    if (!Array.isArray(p.purchase_orders)) return { ok: false, reason: "purchase_orders_not_array" };
    const PO_STATUSES = ["pending", "approved", "received", "cancelled"];
    const MAX_POS = 200;
    const raw = (p.purchase_orders as unknown[]).slice(0, MAX_POS);
    const purchase_orders: { po_number: string; vendor: string; line_items: number; total_cents: number; status: string }[] = [];
    for (const po of raw) {
      if (typeof po !== "object" || po === null) continue;
      const rec = po as Record<string, unknown>;
      const po_number = str(rec.po_number);
      const vendor = str(rec.vendor);
      const line_items = typeof rec.line_items === "number" ? Math.round(rec.line_items) : NaN;
      const total_cents = typeof rec.total_cents === "number" ? Math.round(rec.total_cents) : NaN;
      const status = typeof rec.status === "string" && PO_STATUSES.includes(rec.status) ? rec.status : null;
      if (
        po_number && vendor && Number.isFinite(line_items) && line_items >= 0 &&
        Number.isFinite(total_cents) && total_cents >= 0 && status
      ) {
        purchase_orders.push({ po_number, vendor, line_items, total_cents, status });
      }
    }
    return {
      ok: true,
      kind: "process_purchase_orders",
      payload: { purchase_orders, total_orders: totalOrders, total_value_cents: totalValueCents, pending_count: pendingCount },
    };
  }

  if (kind === "detect_trends") {
    const OVERALL_DIRECTIONS = ["up", "down", "flat", "volatile", "mixed"];
    const overall_direction = typeof p.overall_direction === "string" && OVERALL_DIRECTIONS.includes(p.overall_direction) ? p.overall_direction : null;
    if (!overall_direction) return { ok: false, reason: "bad_overall_direction" };
    const trendCount = typeof p.trend_count === "number" ? Math.round(p.trend_count) : NaN;
    if (!Number.isFinite(trendCount) || trendCount < 0) return { ok: false, reason: "bad_trend_count" };
    if (!Array.isArray(p.trends)) return { ok: false, reason: "trends_not_array" };
    const DIRECTIONS = ["up", "down", "flat", "volatile"];
    const MAGNITUDES = ["low", "medium", "high"];
    const MAX_TRENDS = 50;
    const raw = (p.trends as unknown[]).slice(0, MAX_TRENDS);
    const trends: { column: string; direction: string; magnitude: string; description: string; data_points: number }[] = [];
    for (const t of raw) {
      if (typeof t !== "object" || t === null) continue;
      const rec = t as Record<string, unknown>;
      const column = str(rec.column);
      const direction = typeof rec.direction === "string" && DIRECTIONS.includes(rec.direction) ? rec.direction : null;
      const magnitude = typeof rec.magnitude === "string" && MAGNITUDES.includes(rec.magnitude) ? rec.magnitude : null;
      const description = str(rec.description);
      const data_points = typeof rec.data_points === "number" ? Math.round(rec.data_points) : NaN;
      if (column && direction && magnitude && description && Number.isFinite(data_points) && data_points >= 0) {
        trends.push({ column, direction, magnitude, description, data_points });
      }
    }
    return {
      ok: true,
      kind: "detect_trends",
      payload: { trends, trend_count: trendCount, overall_direction },
    };
  }

  if (kind === "compare_periods") {
    const MAX_LABEL_LEN = 200;
    const period_a_label = typeof p.period_a_label === "string" && p.period_a_label.length > 0
      ? p.period_a_label.slice(0, MAX_LABEL_LEN) : null;
    if (!period_a_label) return { ok: false, reason: "missing_period_a_label" };
    const period_b_label = typeof p.period_b_label === "string" && p.period_b_label.length > 0
      ? p.period_b_label.slice(0, MAX_LABEL_LEN) : null;
    if (!period_b_label) return { ok: false, reason: "missing_period_b_label" };
    const overallChangePct = typeof p.overall_change_pct === "number" ? p.overall_change_pct : NaN;
    if (!Number.isFinite(overallChangePct)) return { ok: false, reason: "bad_overall_change_pct" };
    const summary = str(p.summary);
    if (!summary) return { ok: false, reason: "missing_summary" };
    if (!Array.isArray(p.comparisons)) return { ok: false, reason: "comparisons_not_array" };
    const CHANGE_DIRECTIONS = ["up", "down", "flat"];
    const MAX_COMPARISONS = 100;
    const raw = (p.comparisons as unknown[]).slice(0, MAX_COMPARISONS);
    const comparisons: { metric: string; period_a_value: number; period_b_value: number; change_pct: number; change_direction: string }[] = [];
    for (const c of raw) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const metric = str(rec.metric);
      const period_a_value = typeof rec.period_a_value === "number" ? rec.period_a_value : NaN;
      const period_b_value = typeof rec.period_b_value === "number" ? rec.period_b_value : NaN;
      const change_pct = typeof rec.change_pct === "number" ? rec.change_pct : NaN;
      const change_direction = typeof rec.change_direction === "string" && CHANGE_DIRECTIONS.includes(rec.change_direction) ? rec.change_direction : null;
      if (metric && Number.isFinite(period_a_value) && Number.isFinite(period_b_value) && Number.isFinite(change_pct) && change_direction) {
        comparisons.push({ metric, period_a_value, period_b_value, change_pct, change_direction });
      }
    }
    return {
      ok: true,
      kind: "compare_periods",
      payload: { comparisons, period_a_label, period_b_label, overall_change_pct: overallChangePct, summary },
    };
  }

  if (kind === "generate_exec_summary") {
    const MAX_HEADLINE_LEN = 300;
    const headline = typeof p.headline === "string" && p.headline.length > 0 ? p.headline.slice(0, MAX_HEADLINE_LEN) : null;
    if (!headline) return { ok: false, reason: "missing_headline" };
    const CONFIDENCE_LEVELS = ["low", "medium", "high"];
    const confidence = typeof p.confidence === "string" && CONFIDENCE_LEVELS.includes(p.confidence) ? p.confidence : null;
    if (!confidence) return { ok: false, reason: "bad_confidence" };

    const key_findings = strArray(p.key_findings, 10, 500);
    const recommended_actions = strArray(p.recommended_actions, 5, 500);
    const risk_flags = strArray(p.risk_flags, 10, 500);

    return {
      ok: true,
      kind: "generate_exec_summary",
      payload: { headline, key_findings, recommended_actions, risk_flags, confidence },
    };
  }

  if (kind === "generate_forecast") {
    const HORIZONS = ["30_days", "90_days", "6_months", "12_months", "unknown"];
    const horizon = typeof p.horizon === "string" && HORIZONS.includes(p.horizon) ? p.horizon : null;
    if (!horizon) return { ok: false, reason: "bad_horizon" };
    const MAX_METHODOLOGY_LEN = 500;
    const methodology = typeof p.methodology === "string" && p.methodology.length > 0
      ? p.methodology.slice(0, MAX_METHODOLOGY_LEN) : null;
    if (!methodology) return { ok: false, reason: "missing_methodology" };
    const CONFIDENCE_LEVELS = ["low", "medium", "high"];
    const confidence = typeof p.confidence === "string" && CONFIDENCE_LEVELS.includes(p.confidence) ? p.confidence : null;
    if (!confidence) return { ok: false, reason: "bad_confidence" };
    const MAX_ASSUMPTIONS_LEN = 1000;
    const assumptions = typeof p.assumptions === "string" && p.assumptions.length > 0
      ? p.assumptions.slice(0, MAX_ASSUMPTIONS_LEN) : null;
    if (!assumptions) return { ok: false, reason: "missing_assumptions" };
    if (!Array.isArray(p.forecasts)) return { ok: false, reason: "forecasts_not_array" };
    const MAX_FORECASTS = 50;
    const raw = (p.forecasts as unknown[]).slice(0, MAX_FORECASTS);
    const forecasts: { metric: string; current_value: number; projected_value: number; change_pct: number; basis: string }[] = [];
    for (const f of raw) {
      if (typeof f !== "object" || f === null) continue;
      const rec = f as Record<string, unknown>;
      const metric = str(rec.metric);
      const current_value = typeof rec.current_value === "number" ? rec.current_value : NaN;
      const projected_value = typeof rec.projected_value === "number" ? rec.projected_value : NaN;
      const change_pct = typeof rec.change_pct === "number" ? rec.change_pct : NaN;
      const basis = str(rec.basis);
      if (metric && Number.isFinite(current_value) && Number.isFinite(projected_value) && Number.isFinite(change_pct) && basis) {
        forecasts.push({ metric, current_value, projected_value, change_pct, basis });
      }
    }
    return {
      ok: true,
      kind: "generate_forecast",
      payload: { forecasts, horizon, methodology, confidence, assumptions },
    };
  }

  if (kind === "generate_report") {
    const REPORT_TYPES = ["financial", "operational", "inventory", "compliance", "general"];
    const report_type = typeof p.report_type === "string" && REPORT_TYPES.includes(p.report_type) ? p.report_type : null;
    if (!report_type) return { ok: false, reason: "bad_report_type" };
    const MAX_TITLE_LEN = 300;
    const reportTitle = typeof p.title === "string" && p.title.length > 0 ? p.title.slice(0, MAX_TITLE_LEN) : null;
    if (!reportTitle) return { ok: false, reason: "missing_title" };
    const wordCount = typeof p.word_count === "number" ? Math.round(p.word_count) : NaN;
    if (!Number.isFinite(wordCount) || wordCount < 0) return { ok: false, reason: "bad_word_count" };
    if (!Array.isArray(p.sections)) return { ok: false, reason: "sections_not_array" };
    const MAX_SECTIONS = 10;
    const MAX_CONTENT_LEN = 2000;
    const raw = (p.sections as unknown[]).slice(0, MAX_SECTIONS);
    const sections: { heading: string; content: string }[] = [];
    for (const s of raw) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const heading = str(rec.heading);
      const content = typeof rec.content === "string" && rec.content.length > 0 ? rec.content.slice(0, MAX_CONTENT_LEN) : null;
      if (heading && content) {
        sections.push({ heading, content });
      }
    }
    return {
      ok: true,
      kind: "generate_report",
      payload: { report_type, title: reportTitle, sections, word_count: wordCount },
    };
  }

  if (kind === "assess_data_quality") {
    const qualityScore = typeof p.quality_score === "number" ? Math.round(p.quality_score) : NaN;
    if (!Number.isFinite(qualityScore) || qualityScore < 0 || qualityScore > 100) {
      return { ok: false, reason: "bad_quality_score" };
    }
    const GRADES = ["A", "B", "C", "D", "F"];
    const overall_grade = typeof p.overall_grade === "string" && GRADES.includes(p.overall_grade) ? p.overall_grade : null;
    if (!overall_grade) return { ok: false, reason: "bad_overall_grade" };
    if (!Array.isArray(p.issues)) return { ok: false, reason: "issues_not_array" };
    const ISSUE_TYPES = ["missing_values", "wrong_type", "out_of_range", "inconsistent_format", "suspicious_value", "other"];
    const SEVERITIES = ["low", "medium", "high"];
    const MAX_ISSUES = 100;
    const raw = (p.issues as unknown[]).slice(0, MAX_ISSUES);
    const issues: { column: string; issue_type: string; affected_rows: number; severity: string }[] = [];
    for (const i of raw) {
      if (typeof i !== "object" || i === null) continue;
      const rec = i as Record<string, unknown>;
      const column = str(rec.column);
      const issue_type = typeof rec.issue_type === "string" && ISSUE_TYPES.includes(rec.issue_type) ? rec.issue_type : null;
      const affected_rows = typeof rec.affected_rows === "number" ? Math.round(rec.affected_rows) : NaN;
      const severity = typeof rec.severity === "string" && SEVERITIES.includes(rec.severity) ? rec.severity : null;
      if (column && issue_type && Number.isFinite(affected_rows) && affected_rows >= 0 && severity) {
        issues.push({ column, issue_type, affected_rows, severity });
      }
    }
    return {
      ok: true,
      kind: "assess_data_quality",
      payload: { issues, quality_score: qualityScore, overall_grade },
    };
  }

  if (kind === "flag_compliance_issues") {
    const pii_detected = typeof p.pii_detected === "boolean" ? p.pii_detected : null;
    if (pii_detected === null) return { ok: false, reason: "bad_pii_detected" };
    const RISK_LEVELS_COMP = ["low", "medium", "high", "critical"];
    const risk_level = typeof p.risk_level === "string" && RISK_LEVELS_COMP.includes(p.risk_level) ? p.risk_level : null;
    if (!risk_level) return { ok: false, reason: "bad_risk_level" };
    if (!Array.isArray(p.flags)) return { ok: false, reason: "flags_not_array" };
    const COMPLIANCE_ISSUE_TYPES = ["pii_detected", "sensitive_data", "regulatory_concern", "data_retention", "other"];
    const SEVERITIES_COMP = ["low", "medium", "high"];
    const MAX_COMPLIANCE_FLAGS = 100;
    const raw = (p.flags as unknown[]).slice(0, MAX_COMPLIANCE_FLAGS);
    const flags: { column: string; row_reference: string; issue_type: string; description: string; severity: string }[] = [];
    for (const f of raw) {
      if (typeof f !== "object" || f === null) continue;
      const rec = f as Record<string, unknown>;
      const column = str(rec.column);
      const row_reference = str(rec.row_reference);
      const issue_type = typeof rec.issue_type === "string" && COMPLIANCE_ISSUE_TYPES.includes(rec.issue_type) ? rec.issue_type : null;
      const description = str(rec.description);
      const severity = typeof rec.severity === "string" && SEVERITIES_COMP.includes(rec.severity) ? rec.severity : null;
      if (column && row_reference && issue_type && description && severity) {
        flags.push({ column, row_reference, issue_type, description, severity });
      }
    }
    return {
      ok: true,
      kind: "flag_compliance_issues",
      payload: { flags, pii_detected, risk_level },
    };
  }

  if (kind === "assess_vendor_risk") {
    const totalVendors = typeof p.total_vendors === "number" ? Math.round(p.total_vendors) : NaN;
    if (!Number.isFinite(totalVendors) || totalVendors < 0) return { ok: false, reason: "bad_total_vendors" };
    const highRiskCount = typeof p.high_risk_count === "number" ? Math.round(p.high_risk_count) : NaN;
    if (!Number.isFinite(highRiskCount) || highRiskCount < 0) return { ok: false, reason: "bad_high_risk_count" };
    const CONCENTRATION_RISKS = ["low", "medium", "high", "critical"];
    const concentration_risk = typeof p.concentration_risk === "string" && CONCENTRATION_RISKS.includes(p.concentration_risk) ? p.concentration_risk : null;
    if (!concentration_risk) return { ok: false, reason: "bad_concentration_risk" };
    if (!Array.isArray(p.vendors)) return { ok: false, reason: "vendors_not_array" };
    const VENDOR_RISK_LEVELS = ["low", "medium", "high"];
    const MAX_VENDORS = 100;
    const MAX_RISK_FACTORS = 5;
    const raw = (p.vendors as unknown[]).slice(0, MAX_VENDORS);
    const vendors: { vendor_name: string; spend_pct: number; risk_level: string; risk_factors: string[]; single_source: boolean }[] = [];
    for (const v2 of raw) {
      if (typeof v2 !== "object" || v2 === null) continue;
      const rec = v2 as Record<string, unknown>;
      const vendor_name = str(rec.vendor_name);
      const spend_pct = typeof rec.spend_pct === "number" ? rec.spend_pct : NaN;
      const risk_level = typeof rec.risk_level === "string" && VENDOR_RISK_LEVELS.includes(rec.risk_level) ? rec.risk_level : null;
      const single_source = typeof rec.single_source === "boolean" ? rec.single_source : null;
      const riskFactorsRaw = Array.isArray(rec.risk_factors) ? rec.risk_factors : [];
      const risk_factors = riskFactorsRaw.filter((f): f is string => typeof f === "string" && f.length > 0).slice(0, MAX_RISK_FACTORS);
      if (
        vendor_name && Number.isFinite(spend_pct) && spend_pct >= 0.0 && spend_pct <= 100.0 &&
        risk_level && single_source !== null
      ) {
        vendors.push({ vendor_name, spend_pct, risk_level, risk_factors, single_source });
      }
    }
    return {
      ok: true,
      kind: "assess_vendor_risk",
      payload: { vendors, total_vendors: totalVendors, high_risk_count: highRiskCount, concentration_risk },
    };
  }

  if (kind === "generate_onboarding_guidance") {
    const MAX_DATA_TYPE_LEN = 200;
    const data_type_detected = typeof p.data_type_detected === "string" && p.data_type_detected.length > 0
      ? p.data_type_detected.slice(0, MAX_DATA_TYPE_LEN) : null;
    if (!data_type_detected) return { ok: false, reason: "missing_data_type_detected" };
    const MAX_SUGGESTION_LEN = 500;
    const next_upload_suggestion = typeof p.next_upload_suggestion === "string" && p.next_upload_suggestion.length > 0
      ? p.next_upload_suggestion.slice(0, MAX_SUGGESTION_LEN) : null;
    if (!next_upload_suggestion) return { ok: false, reason: "missing_next_upload_suggestion" };
    const CONFIDENCE_LEVELS_OB = ["low", "medium", "high"];
    const confidence = typeof p.confidence === "string" && CONFIDENCE_LEVELS_OB.includes(p.confidence) ? p.confidence : null;
    if (!confidence) return { ok: false, reason: "bad_confidence" };
    const guidance_steps = strArray(p.guidance_steps, 10, 500);
    return {
      ok: true,
      kind: "generate_onboarding_guidance",
      payload: { data_type_detected, guidance_steps, next_upload_suggestion, confidence },
    };
  }

  if (kind === "request_clarification") {
    const MAX_CONTEXT_LEN = 1000;
    const context = typeof p.context === "string" && p.context.length > 0 ? p.context.slice(0, MAX_CONTEXT_LEN) : null;
    if (!context) return { ok: false, reason: "missing_context" };
    const URGENCIES = ["low", "medium", "high"];
    const urgency = typeof p.urgency === "string" && URGENCIES.includes(p.urgency) ? p.urgency : null;
    if (!urgency) return { ok: false, reason: "bad_urgency" };
    if (!Array.isArray(p.questions) || p.questions.length === 0) return { ok: false, reason: "missing_questions" };
    const MAX_QUESTIONS = 5;
    const MAX_Q_LEN = 500;
    const MAX_OPTIONS = 5;
    const raw = (p.questions as unknown[]).slice(0, MAX_QUESTIONS);
    const questions: { question: string; reason: string; options: string[] }[] = [];
    for (const q of raw) {
      if (typeof q !== "object" || q === null) continue;
      const rec = q as Record<string, unknown>;
      const question = typeof rec.question === "string" && rec.question.length > 0 ? rec.question.slice(0, MAX_Q_LEN) : null;
      const qReason = typeof rec.reason === "string" && rec.reason.length > 0 ? rec.reason.slice(0, MAX_Q_LEN) : null;
      const options = strArray(rec.options, MAX_OPTIONS, MAX_Q_LEN);
      if (question && qReason) {
        questions.push({ question, reason: qReason, options });
      }
    }
    if (questions.length === 0) return { ok: false, reason: "missing_questions" };
    return {
      ok: true,
      kind: "request_clarification",
      payload: { questions, context, urgency },
    };
  }

  if (kind === "analyze_multi_period") {
    const periodsDetected = typeof p.periods_detected === "number" ? Math.round(p.periods_detected) : NaN;
    if (!Number.isFinite(periodsDetected) || periodsDetected < 0) return { ok: false, reason: "bad_periods_detected" };
    const DOMINANT_PATTERNS = ["growth", "decline", "seasonal", "volatile", "stable", "insufficient_data"];
    const dominant_pattern = typeof p.dominant_pattern === "string" && DOMINANT_PATTERNS.includes(p.dominant_pattern) ? p.dominant_pattern : null;
    if (!dominant_pattern) return { ok: false, reason: "bad_dominant_pattern" };
    const period_labels = strArray(p.period_labels, 24, MAX_STR);
    if (!Array.isArray(p.cross_period_insights)) return { ok: false, reason: "cross_period_insights_not_array" };
    const SIGNIFICANCES = ["low", "medium", "high"];
    const MAX_INSIGHTS = 20;
    const raw = (p.cross_period_insights as unknown[]).slice(0, MAX_INSIGHTS);
    const cross_period_insights: { insight: string; affected_periods: string[]; significance: string }[] = [];
    for (const i of raw) {
      if (typeof i !== "object" || i === null) continue;
      const rec = i as Record<string, unknown>;
      const insight = str(rec.insight);
      const affected_periods = strArray(rec.affected_periods, 24, MAX_STR);
      const significance = typeof rec.significance === "string" && SIGNIFICANCES.includes(rec.significance) ? rec.significance : null;
      if (insight && significance) {
        cross_period_insights.push({ insight, affected_periods, significance });
      }
    }
    return {
      ok: true,
      kind: "analyze_multi_period",
      payload: { periods_detected: periodsDetected, period_labels, cross_period_insights, dominant_pattern },
    };
  }

  if (kind === "summarize_audit_trail") {
    const eventsSummarized = typeof p.events_summarized === "number" ? Math.round(p.events_summarized) : NaN;
    if (!Number.isFinite(eventsSummarized) || eventsSummarized < 0) return { ok: false, reason: "bad_events_summarized" };
    const summary_paragraphs = strArray(p.summary_paragraphs, 5, 1000);
    const key_actions = strArray(p.key_actions, 20, 300);
    const anomalies_noted = strArray(p.anomalies_noted, 10, 300);
    return {
      ok: true,
      kind: "summarize_audit_trail",
      payload: { events_summarized: eventsSummarized, summary_paragraphs, key_actions, anomalies_noted },
    };
  }

  if (kind === "review_code") {
    const language_detected = str(p.language_detected);
    if (!language_detected) return { ok: false, reason: "missing_language_detected" };
    const RISKS = ["low", "medium", "high", "critical", "none_detected"];
    const overall_risk = typeof p.overall_risk === "string" && RISKS.includes(p.overall_risk) ? p.overall_risk : null;
    if (!overall_risk) return { ok: false, reason: "bad_overall_risk" };
    const totalIssues = typeof p.total_issues === "number" ? Math.round(p.total_issues) : NaN;
    if (!Number.isFinite(totalIssues) || totalIssues < 0) return { ok: false, reason: "bad_total_issues" };
    if (!Array.isArray(p.findings)) return { ok: false, reason: "findings_not_array" };
    const ISSUE_TYPES = ["bug", "security", "performance", "style", "logic", "other"];
    const SEVERITIES = ["low", "medium", "high", "critical"];
    const MAX_FINDINGS = 50;
    const raw = (p.findings as unknown[]).slice(0, MAX_FINDINGS);
    const findings: { location: string; issue_type: string; severity: string; description: string }[] = [];
    for (const f of raw) {
      if (typeof f !== "object" || f === null) continue;
      const rec = f as Record<string, unknown>;
      const location = str(rec.location);
      const issue_type = typeof rec.issue_type === "string" && ISSUE_TYPES.includes(rec.issue_type) ? rec.issue_type : null;
      const severity = typeof rec.severity === "string" && SEVERITIES.includes(rec.severity) ? rec.severity : null;
      const description = str(rec.description);
      if (location && issue_type && severity && description) {
        findings.push({ location, issue_type, severity, description });
      }
    }
    return {
      ok: true,
      kind: "review_code",
      payload: { findings, language_detected, overall_risk, total_issues: totalIssues },
    };
  }

  if (kind === "generate_tests") {
    const language_detected = str(p.language_detected);
    if (!language_detected) return { ok: false, reason: "missing_language_detected" };
    const framework_suggested = str(p.framework_suggested);
    if (!framework_suggested) return { ok: false, reason: "missing_framework_suggested" };
    const coverageEstimate = typeof p.coverage_estimate === "number" ? Math.round(p.coverage_estimate) : NaN;
    if (!Number.isFinite(coverageEstimate) || coverageEstimate < 0 || coverageEstimate > 100) {
      return { ok: false, reason: "bad_coverage_estimate" };
    }
    if (!Array.isArray(p.test_cases)) return { ok: false, reason: "test_cases_not_array" };
    const TEST_TYPES = ["unit", "integration", "edge_case", "security"];
    const MAX_CASES = 20;
    const MAX_PSEUDOCODE = 2000;
    const raw = (p.test_cases as unknown[]).slice(0, MAX_CASES);
    const test_cases: { name: string; description: string; test_type: string; pseudocode: string }[] = [];
    for (const t of raw) {
      if (typeof t !== "object" || t === null) continue;
      const rec = t as Record<string, unknown>;
      const name = str(rec.name);
      const description = str(rec.description);
      const test_type = typeof rec.test_type === "string" && TEST_TYPES.includes(rec.test_type) ? rec.test_type : null;
      const pseudocode = typeof rec.pseudocode === "string" && rec.pseudocode.length > 0 ? rec.pseudocode.slice(0, MAX_PSEUDOCODE) : null;
      if (name && description && test_type && pseudocode) {
        test_cases.push({ name, description, test_type, pseudocode });
      }
    }
    return {
      ok: true,
      kind: "generate_tests",
      payload: { test_cases, language_detected, framework_suggested, coverage_estimate: coverageEstimate },
    };
  }

  if (kind === "analyze_sql") {
    const queriesFound = typeof p.queries_found === "number" ? Math.round(p.queries_found) : NaN;
    if (!Number.isFinite(queriesFound) || queriesFound < 0) return { ok: false, reason: "bad_queries_found" };
    const RISK_LEVELS = ["none", "low", "medium", "high", "critical"];
    const risk_level = typeof p.risk_level === "string" && RISK_LEVELS.includes(p.risk_level) ? p.risk_level : null;
    if (!risk_level) return { ok: false, reason: "bad_risk_level" };
    if (!Array.isArray(p.issues)) return { ok: false, reason: "issues_not_array" };
    if (!Array.isArray(p.optimizations)) return { ok: false, reason: "optimizations_not_array" };

    const ISSUE_TYPES = ["injection_risk", "performance", "missing_index", "cartesian_join", "n_plus_one", "other"];
    const SEVERITIES = ["low", "medium", "high", "critical"];
    const MAX_ISSUES = 50;
    const rawIssues = (p.issues as unknown[]).slice(0, MAX_ISSUES);
    const issues: { query_reference: string; issue_type: string; severity: string; description: string }[] = [];
    for (const i of rawIssues) {
      if (typeof i !== "object" || i === null) continue;
      const rec = i as Record<string, unknown>;
      const query_reference = str(rec.query_reference);
      const issue_type = typeof rec.issue_type === "string" && ISSUE_TYPES.includes(rec.issue_type) ? rec.issue_type : null;
      const severity = typeof rec.severity === "string" && SEVERITIES.includes(rec.severity) ? rec.severity : null;
      const description = str(rec.description);
      if (query_reference && issue_type && severity && description) {
        issues.push({ query_reference, issue_type, severity, description });
      }
    }

    const MAX_OPTIMIZATIONS = 20;
    const rawOpts = (p.optimizations as unknown[]).slice(0, MAX_OPTIMIZATIONS);
    const optimizations: { query_reference: string; suggestion: string }[] = [];
    for (const o of rawOpts) {
      if (typeof o !== "object" || o === null) continue;
      const rec = o as Record<string, unknown>;
      const query_reference = str(rec.query_reference);
      const suggestion = str(rec.suggestion);
      if (query_reference && suggestion) {
        optimizations.push({ query_reference, suggestion });
      }
    }

    return {
      ok: true,
      kind: "analyze_sql",
      payload: { queries_found: queriesFound, issues, optimizations, risk_level },
    };
  }

  if (kind === "validate_analysis") {
    const INTERPRETABILITY = ["clear", "ambiguous", "poor", "insufficient"];
    const data_interpretability = typeof p.data_interpretability === "string" && INTERPRETABILITY.includes(p.data_interpretability) ? p.data_interpretability : null;
    if (!data_interpretability) return { ok: false, reason: "bad_data_interpretability" };
    const CONFIDENCES = ["high", "medium", "low", "very_low"];
    const confidence_in_swarm = typeof p.confidence_in_swarm === "string" && CONFIDENCES.includes(p.confidence_in_swarm) ? p.confidence_in_swarm : null;
    if (!confidence_in_swarm) return { ok: false, reason: "bad_confidence_in_swarm" };
    const RECOMMENDATIONS = ["proceed", "proceed_with_caution", "request_clarification", "reject"];
    const recommendation = typeof p.recommendation === "string" && RECOMMENDATIONS.includes(p.recommendation) ? p.recommendation : null;
    if (!recommendation) return { ok: false, reason: "bad_recommendation" };
    if (!Array.isArray(p.concerns)) return { ok: false, reason: "concerns_not_array" };
    const SEVERITIES = ["low", "medium", "high"];
    const MAX_CONCERNS = 20;
    const raw = (p.concerns as unknown[]).slice(0, MAX_CONCERNS);
    const concerns: { area: string; concern: string; severity: string }[] = [];
    for (const c of raw) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const area = str(rec.area);
      const concern = str(rec.concern);
      const severity = typeof rec.severity === "string" && SEVERITIES.includes(rec.severity) ? rec.severity : null;
      if (area && concern && severity) {
        concerns.push({ area, concern, severity });
      }
    }
    return {
      ok: true,
      kind: "validate_analysis",
      payload: { concerns, data_interpretability, confidence_in_swarm, recommendation },
    };
  }

  if (kind === "generate_health_score") {
    const overallScore = typeof p.overall_score === "number" ? Math.round(p.overall_score) : NaN;
    if (!Number.isFinite(overallScore) || overallScore < 0 || overallScore > 100) {
      return { ok: false, reason: "bad_overall_score" };
    }
    const GRADES = ["A", "B", "C", "D", "F"];
    const grade = typeof p.grade === "string" && GRADES.includes(p.grade) ? p.grade : null;
    if (!grade) return { ok: false, reason: "bad_grade" };
    const summary = str(p.summary);
    if (!summary) return { ok: false, reason: "missing_summary" };
    if (!Array.isArray(p.dimensions)) return { ok: false, reason: "dimensions_not_array" };
    const MAX_DIMENSIONS = 10;
    const raw = (p.dimensions as unknown[]).slice(0, MAX_DIMENSIONS);
    const dimensions: { dimension: string; score: number; notes: string }[] = [];
    for (const d of raw) {
      if (typeof d !== "object" || d === null) continue;
      const rec = d as Record<string, unknown>;
      const dimension = str(rec.dimension);
      const score = typeof rec.score === "number" ? Math.round(rec.score) : NaN;
      const notes = str(rec.notes);
      if (dimension && Number.isFinite(score) && score >= 0 && score <= 100 && notes) {
        dimensions.push({ dimension, score, notes });
      }
    }
    return {
      ok: true,
      kind: "generate_health_score",
      payload: { overall_score: overallScore, grade, dimensions, summary },
    };
  }

  if (kind === "draft_email") {
    const MAX_SUBJECT = 200;
    const MAX_BODY = 5000;
    const subject = typeof p.subject === "string" && p.subject.length > 0 ? p.subject.slice(0, MAX_SUBJECT) : null;
    if (!subject) return { ok: false, reason: "missing_subject" };
    const body = typeof p.body === "string" && p.body.length > 0 ? p.body.slice(0, MAX_BODY) : null;
    if (!body) return { ok: false, reason: "missing_body" };
    const RECIPIENT_TYPES = ["client", "internal", "vendor", "board", "general"];
    const recipient_type = typeof p.recipient_type === "string" && RECIPIENT_TYPES.includes(p.recipient_type) ? p.recipient_type : null;
    if (!recipient_type) return { ok: false, reason: "bad_recipient_type" };
    const TONES = ["formal", "professional", "friendly", "urgent"];
    const tone = typeof p.tone === "string" && TONES.includes(p.tone) ? p.tone : null;
    if (!tone) return { ok: false, reason: "bad_tone" };
    const key_points = strArray(p.key_points, 10, 300);
    return {
      ok: true,
      kind: "draft_email",
      payload: { subject, body, recipient_type, tone, key_points },
    };
  }

  if (kind === "generate_recommendations") {
    const next_upload_type = str(p.next_upload_type);
    if (!next_upload_type) return { ok: false, reason: "missing_next_upload_type" };
    const PRIORITIES = ["low", "medium", "high", "urgent"];
    const priority = typeof p.priority === "string" && PRIORITIES.includes(p.priority) ? p.priority : null;
    if (!priority) return { ok: false, reason: "bad_priority" };
    if (!Array.isArray(p.recommendations)) return { ok: false, reason: "recommendations_not_array" };
    const IMPACTS = ["low", "medium", "high"];
    const EFFORTS = ["low", "medium", "high"];
    const MAX_RECS = 10;
    const raw = (p.recommendations as unknown[]).slice(0, MAX_RECS);
    const recommendations: { action: string; reason: string; impact: string; effort: string }[] = [];
    for (const r of raw) {
      if (typeof r !== "object" || r === null) continue;
      const rec = r as Record<string, unknown>;
      const action = str(rec.action);
      const reason = str(rec.reason);
      const impact = typeof rec.impact === "string" && IMPACTS.includes(rec.impact) ? rec.impact : null;
      const effort = typeof rec.effort === "string" && EFFORTS.includes(rec.effort) ? rec.effort : null;
      if (action && reason && impact && effort) {
        recommendations.push({ action, reason, impact, effort });
      }
    }
    return {
      ok: true,
      kind: "generate_recommendations",
      payload: { recommendations, next_upload_type, priority },
    };
  }

  if (kind === "extract_patterns") {
    const patternCount = typeof p.pattern_count === "number" ? Math.round(p.pattern_count) : NaN;
    if (!Number.isFinite(patternCount) || patternCount < 0) return { ok: false, reason: "bad_pattern_count" };
    if (typeof p.learnable !== "boolean") return { ok: false, reason: "bad_learnable" };
    if (!Array.isArray(p.patterns)) return { ok: false, reason: "patterns_not_array" };
    const MAX_PATTERNS = 30;
    const MAX_EXAMPLE_VALUES = 5;
    const raw = (p.patterns as unknown[]).slice(0, MAX_PATTERNS);
    const patterns: { pattern_type: string; description: string; confidence: number; example_values: string[]; recurring: boolean }[] = [];
    for (const pat of raw) {
      if (typeof pat !== "object" || pat === null) continue;
      const rec = pat as Record<string, unknown>;
      const pattern_type = str(rec.pattern_type);
      const description = str(rec.description);
      const confidence = typeof rec.confidence === "number" ? rec.confidence : NaN;
      const recurring = typeof rec.recurring === "boolean" ? rec.recurring : null;
      if (
        pattern_type && description && recurring !== null &&
        Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
      ) {
        const example_values = strArray(rec.example_values, MAX_EXAMPLE_VALUES, MAX_STR);
        patterns.push({ pattern_type, description, confidence, example_values, recurring });
      }
    }
    return {
      ok: true,
      kind: "extract_patterns",
      payload: { patterns, pattern_count: patternCount, learnable: p.learnable },
    };
  }

  if (kind === "generate_alerts") {
    const SEVERITY_LEVELS = ["none", "info", "warning", "critical", "urgent"];
    const severity_level = typeof p.severity_level === "string" && SEVERITY_LEVELS.includes(p.severity_level) ? p.severity_level : null;
    if (!severity_level) return { ok: false, reason: "bad_severity_level" };
    if (typeof p.requires_immediate_action !== "boolean") return { ok: false, reason: "bad_requires_immediate_action" };
    const MAX_SUMMARY = 500;
    const summary = typeof p.summary === "string" && p.summary.length > 0 ? p.summary.slice(0, MAX_SUMMARY) : null;
    if (!summary) return { ok: false, reason: "missing_summary" };
    if (!Array.isArray(p.alerts)) return { ok: false, reason: "alerts_not_array" };
    const ALERT_SEVERITIES = ["info", "warning", "critical", "urgent"];
    const MAX_ALERTS = 20;
    const raw = (p.alerts as unknown[]).slice(0, MAX_ALERTS);
    const alerts: { area: string; condition: string; severity: string; message: string; recommended_action: string }[] = [];
    for (const a of raw) {
      if (typeof a !== "object" || a === null) continue;
      const rec = a as Record<string, unknown>;
      const area = str(rec.area);
      const condition = str(rec.condition);
      const severity = typeof rec.severity === "string" && ALERT_SEVERITIES.includes(rec.severity) ? rec.severity : null;
      const message = str(rec.message);
      const recommended_action = str(rec.recommended_action);
      if (area && condition && severity && message && recommended_action) {
        alerts.push({ area, condition, severity, message, recommended_action });
      }
    }
    return {
      ok: true,
      kind: "generate_alerts",
      payload: { alerts, severity_level, requires_immediate_action: p.requires_immediate_action, summary },
    };
  }

  if (kind === "generate_client_report") {
    const MAX_TITLE = 200;
    const MAX_SUMMARY = 1000;
    const report_title = typeof p.report_title === "string" && p.report_title.length > 0 ? p.report_title.slice(0, MAX_TITLE) : null;
    if (!report_title) return { ok: false, reason: "missing_report_title" };
    const executive_summary = typeof p.executive_summary === "string" && p.executive_summary.length > 0 ? p.executive_summary.slice(0, MAX_SUMMARY) : null;
    if (!executive_summary) return { ok: false, reason: "missing_executive_summary" };
    if (!Array.isArray(p.sections)) return { ok: false, reason: "sections_not_array" };
    const MAX_SECTIONS = 10;
    const MAX_CONTENT = 2000;
    const rawSections = (p.sections as unknown[]).slice(0, MAX_SECTIONS);
    const sections: { heading: string; content: string }[] = [];
    for (const s of rawSections) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const heading = str(rec.heading);
      const content = typeof rec.content === "string" && rec.content.length > 0 ? rec.content.slice(0, MAX_CONTENT) : null;
      if (heading && content) {
        sections.push({ heading, content });
      }
    }
    const key_takeaways = strArray(p.key_takeaways, 10, 300);
    const next_steps = strArray(p.next_steps, 10, 300);
    return {
      ok: true,
      kind: "generate_client_report",
      payload: { report_title, executive_summary, sections, key_takeaways, next_steps },
    };
  }

  if (kind === "generate_narrative") {
    const MAX_HEADLINE = 200;
    const MAX_STORY = 3000;
    const headline = typeof p.headline === "string" && p.headline.length > 0 ? p.headline.slice(0, MAX_HEADLINE) : null;
    if (!headline) return { ok: false, reason: "missing_headline" };
    const story = typeof p.story === "string" && p.story.length > 0 ? p.story.slice(0, MAX_STORY) : null;
    if (!story) return { ok: false, reason: "missing_story" };
    const TONES = ["optimistic", "neutral", "cautious", "urgent"];
    const tone = typeof p.tone === "string" && TONES.includes(p.tone) ? p.tone : null;
    if (!tone) return { ok: false, reason: "bad_tone" };
    const AUDIENCES = ["client", "internal", "board", "investor"];
    const audience = typeof p.audience === "string" && AUDIENCES.includes(p.audience) ? p.audience : null;
    if (!audience) return { ok: false, reason: "bad_audience" };
    const wordCount = typeof p.word_count === "number" ? Math.round(p.word_count) : NaN;
    if (!Number.isFinite(wordCount) || wordCount < 0) return { ok: false, reason: "bad_word_count" };
    return {
      ok: true,
      kind: "generate_narrative",
      payload: { headline, story, tone, audience, word_count: wordCount },
    };
  }

  if (kind === "prepare_meeting") {
    const MEETING_TYPES = ["monthly_review", "quarterly_review", "strategy", "crisis", "onboarding", "general"];
    const meeting_type = typeof p.meeting_type === "string" && MEETING_TYPES.includes(p.meeting_type) ? p.meeting_type : null;
    if (!meeting_type) return { ok: false, reason: "bad_meeting_type" };
    if (!Array.isArray(p.agenda_items)) return { ok: false, reason: "agenda_items_not_array" };
    if (!Array.isArray(p.likely_client_questions)) return { ok: false, reason: "likely_client_questions_not_array" };

    const PRIORITIES = ["low", "medium", "high"];
    const MAX_AGENDA = 10;
    const rawAgenda = (p.agenda_items as unknown[]).slice(0, MAX_AGENDA);
    const agenda_items: { item: string; duration_minutes: number; priority: string }[] = [];
    for (const a of rawAgenda) {
      if (typeof a !== "object" || a === null) continue;
      const rec = a as Record<string, unknown>;
      const item = str(rec.item);
      const duration_minutes = typeof rec.duration_minutes === "number" ? Math.round(rec.duration_minutes) : NaN;
      const priority = typeof rec.priority === "string" && PRIORITIES.includes(rec.priority) ? rec.priority : null;
      if (item && priority && Number.isFinite(duration_minutes) && duration_minutes >= 1 && duration_minutes <= 60) {
        agenda_items.push({ item, duration_minutes, priority });
      }
    }

    const talking_points = strArray(p.talking_points, 20, 300);
    const questions_to_ask = strArray(p.questions_to_ask, 10, 300);

    const MAX_CLIENT_Q = 10;
    const rawClientQ = (p.likely_client_questions as unknown[]).slice(0, MAX_CLIENT_Q);
    const likely_client_questions: { question: string; suggested_answer: string }[] = [];
    for (const q of rawClientQ) {
      if (typeof q !== "object" || q === null) continue;
      const rec = q as Record<string, unknown>;
      const question = str(rec.question);
      const suggested_answer = str(rec.suggested_answer);
      if (question && suggested_answer) {
        likely_client_questions.push({ question, suggested_answer });
      }
    }

    return {
      ok: true,
      kind: "prepare_meeting",
      payload: { meeting_type, agenda_items, talking_points, questions_to_ask, likely_client_questions },
    };
  }

  if (kind === "build_board_deck") {
    const MAX_THREAD = 1000;
    const narrative_thread = typeof p.narrative_thread === "string" && p.narrative_thread.length > 0 ? p.narrative_thread.slice(0, MAX_THREAD) : null;
    if (!narrative_thread) return { ok: false, reason: "missing_narrative_thread" };
    if (!Array.isArray(p.slides)) return { ok: false, reason: "slides_not_array" };
    if (!Array.isArray(p.key_metrics)) return { ok: false, reason: "key_metrics_not_array" };

    const CONTENT_TYPES = ["title_slide", "metrics", "chart_suggestion", "narrative", "next_steps", "appendix"];
    const MAX_SLIDES = 20;
    const MAX_BULLETS = 5;
    const MAX_BULLET_LEN = 200;
    const MAX_NOTES = 500;
    const rawSlides = (p.slides as unknown[]).slice(0, MAX_SLIDES);
    const slides: { slide_number: number; title: string; content_type: string; bullet_points: string[]; speaker_notes: string }[] = [];
    for (const s of rawSlides) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const slide_number = typeof rec.slide_number === "number" ? Math.round(rec.slide_number) : NaN;
      const slideTitle = str(rec.title);
      const content_type = typeof rec.content_type === "string" && CONTENT_TYPES.includes(rec.content_type) ? rec.content_type : null;
      const speaker_notes = typeof rec.speaker_notes === "string" ? rec.speaker_notes.slice(0, MAX_NOTES) : null;
      if (
        Number.isFinite(slide_number) && slide_number >= 1 && slide_number <= 20 &&
        slideTitle && content_type && speaker_notes !== null
      ) {
        const bullet_points = strArray(rec.bullet_points, MAX_BULLETS, MAX_BULLET_LEN);
        slides.push({ slide_number, title: slideTitle, content_type, bullet_points, speaker_notes });
      }
    }

    const TRENDS = ["up", "down", "flat", "unknown"];
    const MAX_METRICS = 10;
    const rawMetrics = (p.key_metrics as unknown[]).slice(0, MAX_METRICS);
    const key_metrics: { metric: string; value: string; trend: string }[] = [];
    for (const m of rawMetrics) {
      if (typeof m !== "object" || m === null) continue;
      const rec = m as Record<string, unknown>;
      const metric = str(rec.metric);
      const value = str(rec.value);
      const trend = typeof rec.trend === "string" && TRENDS.includes(rec.trend) ? rec.trend : null;
      if (metric && value && trend) {
        key_metrics.push({ metric, value, trend });
      }
    }

    return {
      ok: true,
      kind: "build_board_deck",
      payload: { slides, key_metrics, narrative_thread },
    };
  }

  if (kind === "recommend_visualizations") {
    const DATA_SHAPES = ["time_series", "categorical", "financial", "mixed", "insufficient"];
    const data_shape = typeof p.data_shape === "string" && DATA_SHAPES.includes(p.data_shape) ? p.data_shape : null;
    if (!data_shape) return { ok: false, reason: "bad_data_shape" };
    const totalRecommended = typeof p.total_recommended === "number" ? Math.round(p.total_recommended) : NaN;
    if (!Number.isFinite(totalRecommended) || totalRecommended < 0) return { ok: false, reason: "bad_total_recommended" };
    if (!Array.isArray(p.recommendations)) return { ok: false, reason: "recommendations_not_array" };

    const CHART_TYPES = ["bar", "line", "area", "pie", "donut", "scatter", "heatmap", "table", "metric_card", "waterfall"];
    const PRIORITIES = ["primary", "secondary", "supplemental"];
    const MAX_RECS = 10;
    const raw = (p.recommendations as unknown[]).slice(0, MAX_RECS);
    const recommendations: { chart_type: string; title: string; x_axis_field: string; y_axis_field: string; reason: string; priority: string }[] = [];
    for (const r of raw) {
      if (typeof r !== "object" || r === null) continue;
      const rec = r as Record<string, unknown>;
      const chart_type = typeof rec.chart_type === "string" && CHART_TYPES.includes(rec.chart_type) ? rec.chart_type : null;
      const recTitle = str(rec.title);
      const x_axis_field = str(rec.x_axis_field);
      const y_axis_field = str(rec.y_axis_field);
      const reason = str(rec.reason);
      const priority = typeof rec.priority === "string" && PRIORITIES.includes(rec.priority) ? rec.priority : null;
      if (chart_type && recTitle && x_axis_field && y_axis_field && reason && priority) {
        recommendations.push({ chart_type, title: recTitle, x_axis_field, y_axis_field, reason, priority });
      }
    }

    return {
      ok: true,
      kind: "recommend_visualizations",
      payload: { recommendations, data_shape, total_recommended: totalRecommended },
    };
  }

  if (kind === "generate_chart_configs") {
    const totalConfigs = typeof p.total_configs === "number" ? Math.round(p.total_configs) : NaN;
    if (!Number.isFinite(totalConfigs) || totalConfigs < 0) return { ok: false, reason: "bad_total_configs" };
    if (!Array.isArray(p.configs)) return { ok: false, reason: "configs_not_array" };

    const CHART_TYPES = ["bar", "line", "area", "pie", "donut", "scatter", "heatmap", "table", "metric_card", "waterfall"];
    const COLOR_SCHEMES = ["blue", "green", "amber", "red", "multi"];
    const AGGREGATIONS = ["sum", "average", "count", "max", "min", "none"];
    const MAX_CONFIGS = 10;
    const MAX_DATA_COLUMNS = 5;
    const raw = (p.configs as unknown[]).slice(0, MAX_CONFIGS);
    const configs: { chart_id: string; chart_type: string; title: string; x_axis_label: string; y_axis_label: string; data_columns: string[]; color_scheme: string; aggregation: string; notes: string }[] = [];
    for (const c of raw) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const chart_id = str(rec.chart_id);
      const chart_type = typeof rec.chart_type === "string" && CHART_TYPES.includes(rec.chart_type) ? rec.chart_type : null;
      const configTitle = str(rec.title);
      const x_axis_label = str(rec.x_axis_label);
      const y_axis_label = str(rec.y_axis_label);
      const color_scheme = typeof rec.color_scheme === "string" && COLOR_SCHEMES.includes(rec.color_scheme) ? rec.color_scheme : null;
      const aggregation = typeof rec.aggregation === "string" && AGGREGATIONS.includes(rec.aggregation) ? rec.aggregation : null;
      const notes = str(rec.notes);
      if (chart_id && chart_type && configTitle && x_axis_label && y_axis_label && color_scheme && aggregation && notes) {
        const data_columns = strArray(rec.data_columns, MAX_DATA_COLUMNS, MAX_STR);
        configs.push({ chart_id, chart_type, title: configTitle, x_axis_label, y_axis_label, data_columns, color_scheme, aggregation, notes });
      }
    }

    return {
      ok: true,
      kind: "generate_chart_configs",
      payload: { configs, total_configs: totalConfigs },
    };
  }

  if (kind === "extract_kpi_cards") {
    const totalKpis = typeof p.total_kpis === "number" ? Math.round(p.total_kpis) : NaN;
    if (!Number.isFinite(totalKpis) || totalKpis < 0) return { ok: false, reason: "bad_total_kpis" };
    if (!Array.isArray(p.kpi_cards)) return { ok: false, reason: "kpi_cards_not_array" };

    const TRENDS = ["up", "down", "flat", "unknown"];
    const CATEGORIES = ["revenue", "cost", "efficiency", "risk", "growth", "other"];
    const MAX_KPIS = 12;
    const raw = (p.kpi_cards as unknown[]).slice(0, MAX_KPIS);
    const kpi_cards: { metric_name: string; value: string; unit: string; trend: string; category: string; is_primary: boolean }[] = [];
    for (const k of raw) {
      if (typeof k !== "object" || k === null) continue;
      const rec = k as Record<string, unknown>;
      const metric_name = str(rec.metric_name);
      const value = str(rec.value);
      const unit = typeof rec.unit === "string" ? rec.unit.slice(0, MAX_STR) : null;
      const trend = typeof rec.trend === "string" && TRENDS.includes(rec.trend) ? rec.trend : null;
      const category = typeof rec.category === "string" && CATEGORIES.includes(rec.category) ? rec.category : null;
      const is_primary = typeof rec.is_primary === "boolean" ? rec.is_primary : null;
      if (metric_name && value && unit !== null && trend && category && is_primary !== null) {
        kpi_cards.push({ metric_name, value, unit, trend, category, is_primary });
      }
    }

    return {
      ok: true,
      kind: "extract_kpi_cards",
      payload: { kpi_cards, total_kpis: totalKpis },
    };
  }

  if (kind === "generate_dashboard_spec") {
    const MAX_TITLE = 200;
    const dashboard_title = typeof p.dashboard_title === "string" && p.dashboard_title.length > 0 ? p.dashboard_title.slice(0, MAX_TITLE) : null;
    if (!dashboard_title) return { ok: false, reason: "missing_dashboard_title" };
    const LAYOUTS = ["financial", "operational", "executive", "mixed"];
    const layout = typeof p.layout === "string" && LAYOUTS.includes(p.layout) ? p.layout : null;
    if (!layout) return { ok: false, reason: "bad_layout" };
    const REFRESHES = ["realtime", "daily", "weekly", "monthly", "on_upload"];
    const recommended_refresh = typeof p.recommended_refresh === "string" && REFRESHES.includes(p.recommended_refresh) ? p.recommended_refresh : null;
    if (!recommended_refresh) return { ok: false, reason: "bad_recommended_refresh" };
    const totalComponents = typeof p.total_components === "number" ? Math.round(p.total_components) : NaN;
    if (!Number.isFinite(totalComponents) || totalComponents < 0) return { ok: false, reason: "bad_total_components" };
    if (!Array.isArray(p.sections)) return { ok: false, reason: "sections_not_array" };

    const SECTION_TYPES = ["kpi_row", "chart_section", "table_section", "narrative_section"];
    const MAX_SECTIONS = 5;
    const MAX_COMPONENT_IDS = 10;
    const raw = (p.sections as unknown[]).slice(0, MAX_SECTIONS);
    const sections: { section_title: string; section_type: string; component_ids: string[]; display_order: number }[] = [];
    for (const s of raw) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const section_title = str(rec.section_title);
      const section_type = typeof rec.section_type === "string" && SECTION_TYPES.includes(rec.section_type) ? rec.section_type : null;
      const display_order = typeof rec.display_order === "number" ? Math.round(rec.display_order) : NaN;
      if (section_title && section_type && Number.isFinite(display_order) && display_order >= 1 && display_order <= 5) {
        const component_ids = strArray(rec.component_ids, MAX_COMPONENT_IDS, MAX_STR);
        sections.push({ section_title, section_type, component_ids, display_order });
      }
    }

    return {
      ok: true,
      kind: "generate_dashboard_spec",
      payload: { dashboard_title, layout, sections, recommended_refresh, total_components: totalComponents },
    };
  }

  if (kind === "calculate_saas_metrics") {
    const CONFIDENCES = ["high", "medium", "low"];
    const metrics_confidence = typeof p.metrics_confidence === "string" && CONFIDENCES.includes(p.metrics_confidence) ? p.metrics_confidence : null;
    if (!metrics_confidence) return { ok: false, reason: "bad_metrics_confidence" };
    const notes = str(p.notes);
    if (!notes) return { ok: false, reason: "missing_notes" };

    const mrr = numOrNull(p.mrr);
    if (mrr === NUM_INVALID) return { ok: false, reason: "bad_mrr" };
    const arr = numOrNull(p.arr);
    if (arr === NUM_INVALID) return { ok: false, reason: "bad_arr" };
    const churn_rate = numOrNull(p.churn_rate, 0, 1);
    if (churn_rate === NUM_INVALID) return { ok: false, reason: "bad_churn_rate" };
    const ltv = numOrNull(p.ltv);
    if (ltv === NUM_INVALID) return { ok: false, reason: "bad_ltv" };
    const cac = numOrNull(p.cac);
    if (cac === NUM_INVALID) return { ok: false, reason: "bad_cac" };
    const ltv_cac_ratio = numOrNull(p.ltv_cac_ratio);
    if (ltv_cac_ratio === NUM_INVALID) return { ok: false, reason: "bad_ltv_cac_ratio" };
    const net_revenue_retention = numOrNull(p.net_revenue_retention, 0);
    if (net_revenue_retention === NUM_INVALID) return { ok: false, reason: "bad_net_revenue_retention" };

    const available_metrics = strArray(p.available_metrics, 20, MAX_STR);

    return {
      ok: true,
      kind: "calculate_saas_metrics",
      payload: { mrr, arr, churn_rate, ltv, cac, ltv_cac_ratio, net_revenue_retention, metrics_confidence, available_metrics, notes },
    };
  }

  if (kind === "calculate_burn_rate") {
    const TRENDS = ["increasing", "decreasing", "stable", "unknown"];
    const burn_trend = typeof p.burn_trend === "string" && TRENDS.includes(p.burn_trend) ? p.burn_trend : null;
    if (!burn_trend) return { ok: false, reason: "bad_burn_trend" };
    const STATUSES = ["healthy", "watch", "critical", "unknown"];
    const runway_status = typeof p.runway_status === "string" && STATUSES.includes(p.runway_status) ? p.runway_status : null;
    if (!runway_status) return { ok: false, reason: "bad_runway_status" };
    const CONFIDENCES = ["high", "medium", "low"];
    const confidence = typeof p.confidence === "string" && CONFIDENCES.includes(p.confidence) ? p.confidence : null;
    if (!confidence) return { ok: false, reason: "bad_confidence" };

    const monthly_burn = numOrNull(p.monthly_burn);
    if (monthly_burn === NUM_INVALID) return { ok: false, reason: "bad_monthly_burn" };
    const net_burn = numOrNull(p.net_burn);
    if (net_burn === NUM_INVALID) return { ok: false, reason: "bad_net_burn" };
    const cash_balance = numOrNull(p.cash_balance);
    if (cash_balance === NUM_INVALID) return { ok: false, reason: "bad_cash_balance" };
    const runway_months = numOrNull(p.runway_months, 0);
    if (runway_months === NUM_INVALID) return { ok: false, reason: "bad_runway_months" };

    const assumptions = strArray(p.assumptions, 10, MAX_STR);

    return {
      ok: true,
      kind: "calculate_burn_rate",
      payload: { monthly_burn, net_burn, cash_balance, runway_months, burn_trend, runway_status, assumptions, confidence },
    };
  }

  if (kind === "analyze_cohorts") {
    const COHORT_TYPES = ["monthly", "quarterly", "weekly", "unknown"];
    const cohort_type = typeof p.cohort_type === "string" && COHORT_TYPES.includes(p.cohort_type) ? p.cohort_type : null;
    if (!cohort_type) return { ok: false, reason: "bad_cohort_type" };
    const TRENDS = ["improving", "declining", "stable", "insufficient_data"];
    const trend = typeof p.trend === "string" && TRENDS.includes(p.trend) ? p.trend : null;
    if (!trend) return { ok: false, reason: "bad_trend" };
    const notes = str(p.notes);
    if (!notes) return { ok: false, reason: "missing_notes" };
    const avg_retention_m1 = numOrNull(p.avg_retention_m1, 0, 1);
    if (avg_retention_m1 === NUM_INVALID) return { ok: false, reason: "bad_avg_retention_m1" };
    const avg_retention_m3 = numOrNull(p.avg_retention_m3, 0, 1);
    if (avg_retention_m3 === NUM_INVALID) return { ok: false, reason: "bad_avg_retention_m3" };
    if (!Array.isArray(p.cohorts)) return { ok: false, reason: "cohorts_not_array" };

    const MAX_COHORTS = 24;
    const MAX_RATES = 24;
    const raw = (p.cohorts as unknown[]).slice(0, MAX_COHORTS);
    const cohorts: { cohort_period: string; cohort_size: number; retention_rates: number[]; revenue: number | null }[] = [];
    for (const c of raw) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const cohort_period = str(rec.cohort_period);
      const cohort_size = typeof rec.cohort_size === "number" ? Math.round(rec.cohort_size) : NaN;
      const revenue = numOrNull(rec.revenue);
      if (cohort_period && Number.isFinite(cohort_size) && cohort_size >= 0 && revenue !== NUM_INVALID && Array.isArray(rec.retention_rates)) {
        const retention_rates = (rec.retention_rates as unknown[])
          .filter((r): r is number => typeof r === "number" && Number.isFinite(r) && r >= 0 && r <= 1)
          .slice(0, MAX_RATES);
        cohorts.push({ cohort_period, cohort_size, retention_rates, revenue });
      }
    }

    return {
      ok: true,
      kind: "analyze_cohorts",
      payload: { cohorts, cohort_type, avg_retention_m1, avg_retention_m3, trend, notes },
    };
  }

  if (kind === "analyze_ar_aging") {
    const RISK_LEVELS = ["low", "medium", "high", "critical"];
    const risk_level = typeof p.risk_level === "string" && RISK_LEVELS.includes(p.risk_level) ? p.risk_level : null;
    if (!risk_level) return { ok: false, reason: "bad_risk_level" };
    const total_ar = typeof p.total_ar === "number" && Number.isFinite(p.total_ar) && p.total_ar >= 0 ? p.total_ar : null;
    if (total_ar === null) return { ok: false, reason: "bad_total_ar" };
    const overdue_amount = typeof p.overdue_amount === "number" && Number.isFinite(p.overdue_amount) && p.overdue_amount >= 0 ? p.overdue_amount : null;
    if (overdue_amount === null) return { ok: false, reason: "bad_overdue_amount" };
    const overdue_percentage = typeof p.overdue_percentage === "number" && Number.isFinite(p.overdue_percentage) && p.overdue_percentage >= 0 && p.overdue_percentage <= 100 ? p.overdue_percentage : null;
    if (overdue_percentage === null) return { ok: false, reason: "bad_overdue_percentage" };
    if (!Array.isArray(p.buckets)) return { ok: false, reason: "buckets_not_array" };

    const BUCKETS = ["0-30", "31-60", "61-90", "91-120", "120+"];
    const MAX_BUCKETS = 5;
    const raw = (p.buckets as unknown[]).slice(0, MAX_BUCKETS);
    const buckets: { bucket: string; amount: number; invoice_count: number; percentage: number }[] = [];
    for (const b of raw) {
      if (typeof b !== "object" || b === null) continue;
      const rec = b as Record<string, unknown>;
      const bucket = typeof rec.bucket === "string" && BUCKETS.includes(rec.bucket) ? rec.bucket : null;
      const amount = typeof rec.amount === "number" && Number.isFinite(rec.amount) && rec.amount >= 0 ? rec.amount : null;
      const invoice_count = typeof rec.invoice_count === "number" ? Math.round(rec.invoice_count) : NaN;
      const percentage = typeof rec.percentage === "number" && Number.isFinite(rec.percentage) && rec.percentage >= 0 && rec.percentage <= 100 ? rec.percentage : null;
      if (bucket && amount !== null && Number.isFinite(invoice_count) && invoice_count >= 0 && percentage !== null) {
        buckets.push({ bucket, amount, invoice_count, percentage });
      }
    }

    const collection_priority = strArray(p.collection_priority, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_ar_aging",
      payload: { buckets, total_ar, overdue_amount, overdue_percentage, collection_priority, risk_level },
    };
  }

  if (kind === "analyze_accounts_payable") {
    const total_payables = typeof p.total_payables === "number" && Number.isFinite(p.total_payables) && p.total_payables >= 0 ? p.total_payables : null;
    if (total_payables === null) return { ok: false, reason: "bad_total_payables" };
    const due_this_week = typeof p.due_this_week === "number" && Number.isFinite(p.due_this_week) && p.due_this_week >= 0 ? p.due_this_week : null;
    if (due_this_week === null) return { ok: false, reason: "bad_due_this_week" };
    const due_this_month = typeof p.due_this_month === "number" && Number.isFinite(p.due_this_month) && p.due_this_month >= 0 ? p.due_this_month : null;
    if (due_this_month === null) return { ok: false, reason: "bad_due_this_month" };
    const overdue_amount = typeof p.overdue_amount === "number" && Number.isFinite(p.overdue_amount) && p.overdue_amount >= 0 ? p.overdue_amount : null;
    if (overdue_amount === null) return { ok: false, reason: "bad_overdue_amount" };
    const cash_required_30_days = typeof p.cash_required_30_days === "number" && Number.isFinite(p.cash_required_30_days) && p.cash_required_30_days >= 0 ? p.cash_required_30_days : null;
    if (cash_required_30_days === null) return { ok: false, reason: "bad_cash_required_30_days" };
    if (!Array.isArray(p.vendors)) return { ok: false, reason: "vendors_not_array" };

    const STATUSES = ["current", "due_soon", "overdue"];
    const MAX_VENDORS = 20;
    const raw = (p.vendors as unknown[]).slice(0, MAX_VENDORS);
    const vendors: { vendor_name: string; amount_owed: number; due_date: string; status: string }[] = [];
    for (const v of raw) {
      if (typeof v !== "object" || v === null) continue;
      const rec = v as Record<string, unknown>;
      const vendor_name = str(rec.vendor_name);
      const amount_owed = typeof rec.amount_owed === "number" && Number.isFinite(rec.amount_owed) && rec.amount_owed >= 0 ? rec.amount_owed : null;
      const due_date = typeof rec.due_date === "string" ? rec.due_date.slice(0, MAX_STR) : null;
      const status = typeof rec.status === "string" && STATUSES.includes(rec.status) ? rec.status : null;
      if (vendor_name && amount_owed !== null && due_date !== null && status) {
        vendors.push({ vendor_name, amount_owed, due_date, status });
      }
    }

    const early_payment_opportunities = strArray(p.early_payment_opportunities, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_accounts_payable",
      payload: { total_payables, due_this_week, due_this_month, overdue_amount, vendors, early_payment_opportunities, cash_required_30_days },
    };
  }

  if (kind === "reconcile_bank") {
    const STATUSES = ["balanced", "variance_found", "insufficient_data"];
    const reconciliation_status = typeof p.reconciliation_status === "string" && STATUSES.includes(p.reconciliation_status) ? p.reconciliation_status : null;
    if (!reconciliation_status) return { ok: false, reason: "bad_reconciliation_status" };
    const notes = str(p.notes);
    if (!notes) return { ok: false, reason: "missing_notes" };
    const total_unmatched = typeof p.total_unmatched === "number" ? Math.round(p.total_unmatched) : NaN;
    if (!Number.isFinite(total_unmatched) || total_unmatched < 0) return { ok: false, reason: "bad_total_unmatched" };

    const book_balance = numOrNull(p.book_balance);
    if (book_balance === NUM_INVALID) return { ok: false, reason: "bad_book_balance" };
    const bank_balance = numOrNull(p.bank_balance);
    if (bank_balance === NUM_INVALID) return { ok: false, reason: "bad_bank_balance" };
    const variance = numOrNull(p.variance);
    if (variance === NUM_INVALID) return { ok: false, reason: "bad_variance" };

    if (!Array.isArray(p.unmatched_items)) return { ok: false, reason: "unmatched_items_not_array" };
    const ITEM_TYPES = ["deposit_in_transit", "outstanding_check", "bank_charge", "error", "other"];
    const MAX_ITEMS = 50;
    const raw = (p.unmatched_items as unknown[]).slice(0, MAX_ITEMS);
    const unmatched_items: { description: string; amount: number; item_type: string }[] = [];
    for (const i of raw) {
      if (typeof i !== "object" || i === null) continue;
      const rec = i as Record<string, unknown>;
      const description = str(rec.description);
      const amount = typeof rec.amount === "number" && Number.isFinite(rec.amount) ? rec.amount : null;
      const item_type = typeof rec.item_type === "string" && ITEM_TYPES.includes(rec.item_type) ? rec.item_type : null;
      if (description && amount !== null && item_type) {
        unmatched_items.push({ description, amount, item_type });
      }
    }

    return {
      ok: true,
      kind: "reconcile_bank",
      payload: { book_balance, bank_balance, variance, unmatched_items, reconciliation_status, total_unmatched, notes },
    };
  }

  if (kind === "analyze_financial_ratios") {
    const HEALTH = ["strong", "healthy", "watch", "weak", "critical"];
    const overall_health = typeof p.overall_health === "string" && HEALTH.includes(p.overall_health) ? p.overall_health : null;
    if (!overall_health) return { ok: false, reason: "bad_overall_health" };
    const notesRaw = str(p.notes);
    if (!notesRaw) return { ok: false, reason: "missing_notes" };
    const notes = notesRaw.slice(0, 1000);

    // Each ratio category is a required object, but every key inside it is optional:
    // a key that is missing or fails its range check is silently dropped to null
    // (same as "not calculable from the data") rather than rejecting the whole proposal.
    function ratioObj(v: unknown, spec: Record<string, [number, number]>): Record<string, number | null> | null {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
      const rec = v as Record<string, unknown>;
      const out: Record<string, number | null> = {};
      for (const key of Object.keys(spec)) {
        const [min, max] = spec[key];
        const val = numOrNull(rec[key], min, max);
        out[key] = val === NUM_INVALID ? null : val;
      }
      return out;
    }

    const liquidity_ratios = ratioObj(p.liquidity_ratios, {
      current_ratio: [-Infinity, Infinity], quick_ratio: [-Infinity, Infinity], cash_ratio: [-Infinity, Infinity],
    });
    if (!liquidity_ratios) return { ok: false, reason: "bad_liquidity_ratios" };
    const profitability_ratios = ratioObj(p.profitability_ratios, {
      gross_margin: [0, 100], net_margin: [-Infinity, Infinity], roe: [-Infinity, Infinity],
      roa: [-Infinity, Infinity], ebitda_margin: [-Infinity, Infinity],
    });
    if (!profitability_ratios) return { ok: false, reason: "bad_profitability_ratios" };
    const leverage_ratios = ratioObj(p.leverage_ratios, {
      debt_to_equity: [-Infinity, Infinity], debt_to_assets: [0, 1], interest_coverage: [-Infinity, Infinity],
    });
    if (!leverage_ratios) return { ok: false, reason: "bad_leverage_ratios" };
    const efficiency_ratios = ratioObj(p.efficiency_ratios, {
      asset_turnover: [-Infinity, Infinity], inventory_turnover: [-Infinity, Infinity], receivables_turnover: [-Infinity, Infinity],
    });
    if (!efficiency_ratios) return { ok: false, reason: "bad_efficiency_ratios" };

    return {
      ok: true,
      kind: "analyze_financial_ratios",
      payload: { liquidity_ratios, profitability_ratios, leverage_ratios, efficiency_ratios, overall_health, notes },
    };
  }

  if (kind === "analyze_profitability") {
    const total_revenue = typeof p.total_revenue === "number" && Number.isFinite(p.total_revenue) && p.total_revenue >= 0 ? p.total_revenue : null;
    if (total_revenue === null) return { ok: false, reason: "bad_total_revenue" };
    const total_cost = typeof p.total_cost === "number" && Number.isFinite(p.total_cost) && p.total_cost >= 0 ? p.total_cost : null;
    if (total_cost === null) return { ok: false, reason: "bad_total_cost" };
    const total_gross_profit = typeof p.total_gross_profit === "number" && Number.isFinite(p.total_gross_profit) ? p.total_gross_profit : null;
    if (total_gross_profit === null) return { ok: false, reason: "bad_total_gross_profit" };
    const overall_margin = typeof p.overall_margin === "number" && Number.isFinite(p.overall_margin) ? p.overall_margin : null;
    if (overall_margin === null) return { ok: false, reason: "bad_overall_margin" };
    const most_profitable = str(p.most_profitable);
    if (!most_profitable) return { ok: false, reason: "missing_most_profitable" };
    const least_profitable = str(p.least_profitable);
    if (!least_profitable) return { ok: false, reason: "missing_least_profitable" };

    const MAX_SEGMENTS = 20;
    const rawSegments = Array.isArray(p.segments) ? (p.segments as unknown[]).slice(0, MAX_SEGMENTS) : [];
    const segments: { segment_name: string; revenue: number; cost: number; gross_profit: number; gross_margin: number }[] = [];
    for (const s of rawSegments) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const segment_name = str(rec.segment_name);
      const revenue = typeof rec.revenue === "number" && Number.isFinite(rec.revenue) ? rec.revenue : null;
      const cost = typeof rec.cost === "number" && Number.isFinite(rec.cost) ? rec.cost : null;
      const gross_profit = typeof rec.gross_profit === "number" && Number.isFinite(rec.gross_profit) ? rec.gross_profit : null;
      const gross_margin = typeof rec.gross_margin === "number" && Number.isFinite(rec.gross_margin) && rec.gross_margin >= 0 && rec.gross_margin <= 100 ? rec.gross_margin : null;
      if (segment_name && revenue !== null && cost !== null && gross_profit !== null && gross_margin !== null) {
        segments.push({ segment_name, revenue, cost, gross_profit, gross_margin });
      }
    }

    const recommendations = strArray(p.recommendations, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_profitability",
      payload: { segments, total_revenue, total_cost, total_gross_profit, overall_margin, most_profitable, least_profitable, recommendations },
    };
  }

  if (kind === "analyze_working_capital") {
    const STATUSES = ["healthy", "tight", "negative", "unknown"];
    const status = typeof p.status === "string" && STATUSES.includes(p.status) ? p.status : null;
    if (!status) return { ok: false, reason: "bad_status" };

    const current_assets = numOrNull(p.current_assets);
    if (current_assets === NUM_INVALID) return { ok: false, reason: "bad_current_assets" };
    const current_liabilities = numOrNull(p.current_liabilities);
    if (current_liabilities === NUM_INVALID) return { ok: false, reason: "bad_current_liabilities" };
    const working_capital = numOrNull(p.working_capital);
    if (working_capital === NUM_INVALID) return { ok: false, reason: "bad_working_capital" };
    const current_ratio = numOrNull(p.current_ratio);
    if (current_ratio === NUM_INVALID) return { ok: false, reason: "bad_current_ratio" };
    const quick_ratio = numOrNull(p.quick_ratio);
    if (quick_ratio === NUM_INVALID) return { ok: false, reason: "bad_quick_ratio" };
    const days_inventory_outstanding = numOrNull(p.days_inventory_outstanding, 0);
    if (days_inventory_outstanding === NUM_INVALID) return { ok: false, reason: "bad_days_inventory_outstanding" };
    const days_sales_outstanding = numOrNull(p.days_sales_outstanding, 0);
    if (days_sales_outstanding === NUM_INVALID) return { ok: false, reason: "bad_days_sales_outstanding" };
    const days_payable_outstanding = numOrNull(p.days_payable_outstanding, 0);
    if (days_payable_outstanding === NUM_INVALID) return { ok: false, reason: "bad_days_payable_outstanding" };
    const cash_conversion_cycle_days = numOrNull(p.cash_conversion_cycle_days);
    if (cash_conversion_cycle_days === NUM_INVALID) return { ok: false, reason: "bad_cash_conversion_cycle_days" };

    const recommendations = strArray(p.recommendations, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_working_capital",
      payload: {
        current_assets, current_liabilities, working_capital, current_ratio, quick_ratio,
        days_inventory_outstanding, days_sales_outstanding, days_payable_outstanding,
        cash_conversion_cycle_days, status, recommendations,
      },
    };
  }

  if (kind === "calculate_break_even") {
    const STATUSES = ["above_break_even", "below_break_even", "at_break_even", "insufficient_data"];
    const status = typeof p.status === "string" && STATUSES.includes(p.status) ? p.status : null;
    if (!status) return { ok: false, reason: "bad_status" };

    const fixed_costs = numOrNull(p.fixed_costs, 0);
    if (fixed_costs === NUM_INVALID) return { ok: false, reason: "bad_fixed_costs" };
    const variable_cost_per_unit = numOrNull(p.variable_cost_per_unit, 0);
    if (variable_cost_per_unit === NUM_INVALID) return { ok: false, reason: "bad_variable_cost_per_unit" };
    const price_per_unit = numOrNull(p.price_per_unit, 0);
    if (price_per_unit === NUM_INVALID) return { ok: false, reason: "bad_price_per_unit" };
    const break_even_units = numOrNull(p.break_even_units, 0);
    if (break_even_units === NUM_INVALID) return { ok: false, reason: "bad_break_even_units" };
    const break_even_revenue = numOrNull(p.break_even_revenue, 0);
    if (break_even_revenue === NUM_INVALID) return { ok: false, reason: "bad_break_even_revenue" };
    const current_units_or_revenue = numOrNull(p.current_units_or_revenue, 0);
    if (current_units_or_revenue === NUM_INVALID) return { ok: false, reason: "bad_current_units_or_revenue" };
    const margin_of_safety = numOrNull(p.margin_of_safety, 0);
    if (margin_of_safety === NUM_INVALID) return { ok: false, reason: "bad_margin_of_safety" };
    const margin_of_safety_percentage = numOrNull(p.margin_of_safety_percentage, 0);
    if (margin_of_safety_percentage === NUM_INVALID) return { ok: false, reason: "bad_margin_of_safety_percentage" };
    const contribution_margin_per_unit = numOrNull(p.contribution_margin_per_unit, 0);
    if (contribution_margin_per_unit === NUM_INVALID) return { ok: false, reason: "bad_contribution_margin_per_unit" };
    const contribution_margin_ratio = numOrNull(p.contribution_margin_ratio, 0, 1);
    if (contribution_margin_ratio === NUM_INVALID) return { ok: false, reason: "bad_contribution_margin_ratio" };

    return {
      ok: true,
      kind: "calculate_break_even",
      payload: {
        fixed_costs, variable_cost_per_unit, price_per_unit, break_even_units, break_even_revenue,
        current_units_or_revenue, margin_of_safety, margin_of_safety_percentage,
        contribution_margin_per_unit, contribution_margin_ratio, status,
      },
    };
  }

  if (kind === "analyze_cogs") {
    const total_cogs = typeof p.total_cogs === "number" && Number.isFinite(p.total_cogs) && p.total_cogs >= 0 ? p.total_cogs : null;
    if (total_cogs === null) return { ok: false, reason: "bad_total_cogs" };
    const total_revenue = typeof p.total_revenue === "number" && Number.isFinite(p.total_revenue) && p.total_revenue >= 0 ? p.total_revenue : null;
    if (total_revenue === null) return { ok: false, reason: "bad_total_revenue" };
    const gross_profit = typeof p.gross_profit === "number" && Number.isFinite(p.gross_profit) ? p.gross_profit : null;
    if (gross_profit === null) return { ok: false, reason: "bad_gross_profit" };
    const gross_margin_percentage = typeof p.gross_margin_percentage === "number" && Number.isFinite(p.gross_margin_percentage) ? p.gross_margin_percentage : null;
    if (gross_margin_percentage === null) return { ok: false, reason: "bad_gross_margin_percentage" };

    const TRENDS = ["increasing", "decreasing", "stable", "unknown"];
    const cogs_trend = typeof p.cogs_trend === "string" && TRENDS.includes(p.cogs_trend) ? p.cogs_trend : null;
    if (!cogs_trend) return { ok: false, reason: "bad_cogs_trend" };

    const MAX_COMPONENTS = 20;
    const rawComponents = Array.isArray(p.cogs_components) ? (p.cogs_components as unknown[]).slice(0, MAX_COMPONENTS) : [];
    const cogs_components: { component_name: string; amount: number; percentage_of_cogs: number }[] = [];
    for (const c of rawComponents) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const component_name = str(rec.component_name);
      const amount = typeof rec.amount === "number" && Number.isFinite(rec.amount) && rec.amount >= 0 ? rec.amount : null;
      const percentage_of_cogs = typeof rec.percentage_of_cogs === "number" && Number.isFinite(rec.percentage_of_cogs) && rec.percentage_of_cogs >= 0 && rec.percentage_of_cogs <= 100 ? rec.percentage_of_cogs : null;
      if (component_name && amount !== null && percentage_of_cogs !== null) {
        cogs_components.push({ component_name, amount, percentage_of_cogs });
      }
    }

    const cost_drivers = strArray(p.cost_drivers, 10, MAX_STR);
    const optimization_opportunities = strArray(p.optimization_opportunities, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_cogs",
      payload: { total_cogs, total_revenue, gross_profit, gross_margin_percentage, cogs_components, cogs_trend, cost_drivers, optimization_opportunities },
    };
  }

  if (kind === "analyze_revenue_recognition") {
    const recognized_revenue = typeof p.recognized_revenue === "number" && Number.isFinite(p.recognized_revenue) && p.recognized_revenue >= 0 ? p.recognized_revenue : null;
    if (recognized_revenue === null) return { ok: false, reason: "bad_recognized_revenue" };
    const deferred_revenue = typeof p.deferred_revenue === "number" && Number.isFinite(p.deferred_revenue) && p.deferred_revenue >= 0 ? p.deferred_revenue : null;
    if (deferred_revenue === null) return { ok: false, reason: "bad_deferred_revenue" };

    const METHODS = ["point_in_time", "over_time", "mixed", "unknown"];
    const recognition_method = typeof p.recognition_method === "string" && METHODS.includes(p.recognition_method) ? p.recognition_method : null;
    if (!recognition_method) return { ok: false, reason: "bad_recognition_method" };

    const asc_606_notesRaw = str(p.asc_606_notes);
    if (!asc_606_notesRaw) return { ok: false, reason: "missing_asc_606_notes" };
    const asc_606_notes = asc_606_notesRaw.slice(0, 1000);

    const MAX_CONTRACTS = 30;
    const rawContracts = Array.isArray(p.contracts) ? (p.contracts as unknown[]).slice(0, MAX_CONTRACTS) : [];
    const contracts: { contract_ref: string; total_value: number; recognized: number; deferred: number; start_date: string; end_date: string }[] = [];
    for (const c of rawContracts) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const contract_ref = str(rec.contract_ref);
      const total_value = typeof rec.total_value === "number" && Number.isFinite(rec.total_value) && rec.total_value >= 0 ? rec.total_value : null;
      const recognized = typeof rec.recognized === "number" && Number.isFinite(rec.recognized) && rec.recognized >= 0 ? rec.recognized : null;
      const deferred = typeof rec.deferred === "number" && Number.isFinite(rec.deferred) && rec.deferred >= 0 ? rec.deferred : null;
      const start_date = str(rec.start_date);
      const end_date = str(rec.end_date);
      if (contract_ref && total_value !== null && recognized !== null && deferred !== null && start_date && end_date) {
        contracts.push({ contract_ref, total_value, recognized, deferred, start_date, end_date });
      }
    }

    const MAX_FLAGS = 20;
    const SEVERITIES = ["low", "medium", "high"];
    const rawFlags = Array.isArray(p.compliance_flags) ? (p.compliance_flags as unknown[]).slice(0, MAX_FLAGS) : [];
    const compliance_flags: { flag: string; severity: string }[] = [];
    for (const f of rawFlags) {
      if (typeof f !== "object" || f === null) continue;
      const rec = f as Record<string, unknown>;
      const flag = str(rec.flag);
      const severity = typeof rec.severity === "string" && SEVERITIES.includes(rec.severity) ? rec.severity : null;
      if (flag && severity) {
        compliance_flags.push({ flag, severity });
      }
    }

    return {
      ok: true,
      kind: "analyze_revenue_recognition",
      payload: { recognized_revenue, deferred_revenue, recognition_method, contracts, compliance_flags, asc_606_notes },
    };
  }

  if (kind === "analyze_churn_risk") {
    const data_period = str(p.data_period);
    if (!data_period) return { ok: false, reason: "missing_data_period" };

    const overall_churn_rate = numOrNull(p.overall_churn_rate, 0, 100);
    if (overall_churn_rate === NUM_INVALID) return { ok: false, reason: "bad_overall_churn_rate" };
    const predicted_revenue_loss = numOrNull(p.predicted_revenue_loss, 0);
    if (predicted_revenue_loss === NUM_INVALID) return { ok: false, reason: "bad_predicted_revenue_loss" };

    const MAX_CUSTOMERS = 50;
    const RISK_LEVELS = ["high", "medium", "low"];
    const rawCustomers = Array.isArray(p.at_risk_customers) ? (p.at_risk_customers as unknown[]).slice(0, MAX_CUSTOMERS) : [];
    const at_risk_customers: { customer_id: string; risk_score: number; risk_level: string; last_active: string; revenue_at_risk: number }[] = [];
    for (const c of rawCustomers) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const customer_id = str(rec.customer_id);
      const risk_score = typeof rec.risk_score === "number" && Number.isFinite(rec.risk_score) && rec.risk_score >= 0 && rec.risk_score <= 100 ? rec.risk_score : null;
      const risk_level = typeof rec.risk_level === "string" && RISK_LEVELS.includes(rec.risk_level) ? rec.risk_level : null;
      const last_active = str(rec.last_active);
      const revenue_at_risk = typeof rec.revenue_at_risk === "number" && Number.isFinite(rec.revenue_at_risk) && rec.revenue_at_risk >= 0 ? rec.revenue_at_risk : null;
      if (customer_id && risk_score !== null && risk_level && last_active && revenue_at_risk !== null) {
        at_risk_customers.push({ customer_id, risk_score, risk_level, last_active, revenue_at_risk });
      }
    }

    const risk_factors = strArray(p.risk_factors, 15, MAX_STR);
    const retention_recommendations = strArray(p.retention_recommendations, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_churn_risk",
      payload: { overall_churn_rate, at_risk_customers, risk_factors, predicted_revenue_loss, retention_recommendations, data_period },
    };
  }

  if (kind === "segment_customers") {
    const METHODS = ["rfm", "revenue_tier", "industry", "product_usage", "geography", "size", "custom"];
    const segmentation_method = typeof p.segmentation_method === "string" && METHODS.includes(p.segmentation_method) ? p.segmentation_method : null;
    if (!segmentation_method) return { ok: false, reason: "bad_segmentation_method" };
    const total_customers = typeof p.total_customers === "number" && Number.isInteger(p.total_customers) && p.total_customers >= 0 ? p.total_customers : null;
    if (total_customers === null) return { ok: false, reason: "bad_total_customers" };

    const MAX_SEGMENTS = 20;
    const rawSegments = Array.isArray(p.segments) ? (p.segments as unknown[]).slice(0, MAX_SEGMENTS) : [];
    const segments: { segment_name: string; customer_count: number; percentage_of_total: number; avg_revenue: number; characteristics: string[] }[] = [];
    for (const s of rawSegments) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const segment_name = str(rec.segment_name);
      const customer_count = typeof rec.customer_count === "number" && Number.isInteger(rec.customer_count) && rec.customer_count >= 0 ? rec.customer_count : null;
      const percentage_of_total = typeof rec.percentage_of_total === "number" && Number.isFinite(rec.percentage_of_total) && rec.percentage_of_total >= 0 && rec.percentage_of_total <= 100 ? rec.percentage_of_total : null;
      const avg_revenue = typeof rec.avg_revenue === "number" && Number.isFinite(rec.avg_revenue) && rec.avg_revenue >= 0 ? rec.avg_revenue : null;
      if (segment_name && customer_count !== null && percentage_of_total !== null && avg_revenue !== null) {
        const characteristics = strArray(rec.characteristics, 5, MAX_STR);
        segments.push({ segment_name, customer_count, percentage_of_total, avg_revenue, characteristics });
      }
    }
    if (segments.length === 0) return { ok: false, reason: "no_valid_segments" };

    const insights = strArray(p.insights, 10, MAX_STR);

    return {
      ok: true,
      kind: "segment_customers",
      payload: { segments, segmentation_method, total_customers, insights },
    };
  }

  if (kind === "analyze_sales_pipeline") {
    const total_pipeline_value = typeof p.total_pipeline_value === "number" && Number.isFinite(p.total_pipeline_value) && p.total_pipeline_value >= 0 ? p.total_pipeline_value : null;
    if (total_pipeline_value === null) return { ok: false, reason: "bad_total_pipeline_value" };
    const weighted_pipeline_value = typeof p.weighted_pipeline_value === "number" && Number.isFinite(p.weighted_pipeline_value) && p.weighted_pipeline_value >= 0 ? p.weighted_pipeline_value : null;
    if (weighted_pipeline_value === null) return { ok: false, reason: "bad_weighted_pipeline_value" };

    const avg_deal_size = numOrNull(p.avg_deal_size, 0);
    if (avg_deal_size === NUM_INVALID) return { ok: false, reason: "bad_avg_deal_size" };
    const avg_sales_cycle_days = numOrNull(p.avg_sales_cycle_days, 0);
    if (avg_sales_cycle_days === NUM_INVALID) return { ok: false, reason: "bad_avg_sales_cycle_days" };
    const win_rate = numOrNull(p.win_rate, 0, 100);
    if (win_rate === NUM_INVALID) return { ok: false, reason: "bad_win_rate" };
    const forecast_this_period = numOrNull(p.forecast_this_period, 0);
    if (forecast_this_period === NUM_INVALID) return { ok: false, reason: "bad_forecast_this_period" };

    const MAX_DEALS = 100;
    const rawDeals = Array.isArray(p.deals) ? (p.deals as unknown[]).slice(0, MAX_DEALS) : [];
    const deals: { deal_name: string; stage: string; value: number; probability: number; expected_close: string; owner: string }[] = [];
    for (const d of rawDeals) {
      if (typeof d !== "object" || d === null) continue;
      const rec = d as Record<string, unknown>;
      const deal_name = str(rec.deal_name);
      const stage = str(rec.stage);
      const value = typeof rec.value === "number" && Number.isFinite(rec.value) && rec.value >= 0 ? rec.value : null;
      const probability = typeof rec.probability === "number" && Number.isFinite(rec.probability) && rec.probability >= 0 && rec.probability <= 100 ? rec.probability : null;
      const expected_close = str(rec.expected_close);
      const owner = str(rec.owner);
      if (deal_name && stage && value !== null && probability !== null && expected_close && owner) {
        deals.push({ deal_name, stage, value, probability, expected_close, owner });
      }
    }

    const MAX_STAGES = 15;
    const rawStages = Array.isArray(p.stage_summary) ? (p.stage_summary as unknown[]).slice(0, MAX_STAGES) : [];
    const stage_summary: { stage_name: string; deal_count: number; total_value: number; avg_probability: number }[] = [];
    for (const s of rawStages) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const stage_name = str(rec.stage_name);
      const deal_count = typeof rec.deal_count === "number" && Number.isInteger(rec.deal_count) && rec.deal_count >= 0 ? rec.deal_count : null;
      const total_value = typeof rec.total_value === "number" && Number.isFinite(rec.total_value) && rec.total_value >= 0 ? rec.total_value : null;
      const avg_probability = typeof rec.avg_probability === "number" && Number.isFinite(rec.avg_probability) && rec.avg_probability >= 0 && rec.avg_probability <= 100 ? rec.avg_probability : null;
      if (stage_name && deal_count !== null && total_value !== null && avg_probability !== null) {
        stage_summary.push({ stage_name, deal_count, total_value, avg_probability });
      }
    }

    const risks = strArray(p.risks, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_sales_pipeline",
      payload: {
        total_pipeline_value, weighted_pipeline_value, deals, stage_summary,
        avg_deal_size, avg_sales_cycle_days, win_rate, forecast_this_period, risks,
      },
    };
  }

  if (kind === "analyze_pricing") {
    const ELASTICITIES = ["elastic", "inelastic", "unit_elastic", "unknown"];
    const price_elasticity = typeof p.price_elasticity === "string" && ELASTICITIES.includes(p.price_elasticity) ? p.price_elasticity : null;
    if (!price_elasticity) return { ok: false, reason: "bad_price_elasticity" };
    const POSITIONS = ["premium", "parity", "discount", "unknown"];
    const competitive_position = typeof p.competitive_position === "string" && POSITIONS.includes(p.competitive_position) ? p.competitive_position : null;
    if (!competitive_position) return { ok: false, reason: "bad_competitive_position" };
    const CONFIDENCES = ["high", "medium", "low"];
    const confidence = typeof p.confidence === "string" && CONFIDENCES.includes(p.confidence) ? p.confidence : null;
    if (!confidence) return { ok: false, reason: "bad_confidence" };

    const projected_revenue_impact = numOrNull(p.projected_revenue_impact);
    if (projected_revenue_impact === NUM_INVALID) return { ok: false, reason: "bad_projected_revenue_impact" };

    const MAX_PRICING = 30;
    const rawPricing = Array.isArray(p.current_pricing) ? (p.current_pricing as unknown[]).slice(0, MAX_PRICING) : [];
    const current_pricing: { product_service: string; current_price: number; unit: string; cost: number; margin: number }[] = [];
    for (const c of rawPricing) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const product_service = str(rec.product_service);
      const current_price = typeof rec.current_price === "number" && Number.isFinite(rec.current_price) && rec.current_price >= 0 ? rec.current_price : null;
      const unit = str(rec.unit);
      const cost = typeof rec.cost === "number" && Number.isFinite(rec.cost) && rec.cost >= 0 ? rec.cost : null;
      const margin = typeof rec.margin === "number" && Number.isFinite(rec.margin) ? rec.margin : null;
      if (product_service && current_price !== null && unit && cost !== null && margin !== null) {
        current_pricing.push({ product_service, current_price, unit, cost, margin });
      }
    }

    const MAX_CHANGES = 20;
    const rawChanges = Array.isArray(p.recommended_changes) ? (p.recommended_changes as unknown[]).slice(0, MAX_CHANGES) : [];
    const recommended_changes: { product_service: string; current_price: number; recommended_price: number; rationale: string }[] = [];
    for (const c of rawChanges) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const product_service = str(rec.product_service);
      const current_price = typeof rec.current_price === "number" && Number.isFinite(rec.current_price) && rec.current_price >= 0 ? rec.current_price : null;
      const recommended_price = typeof rec.recommended_price === "number" && Number.isFinite(rec.recommended_price) && rec.recommended_price >= 0 ? rec.recommended_price : null;
      const rationale = str(rec.rationale);
      if (product_service && current_price !== null && recommended_price !== null && rationale) {
        recommended_changes.push({ product_service, current_price, recommended_price, rationale });
      }
    }

    const optimization_opportunities = strArray(p.optimization_opportunities, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_pricing",
      payload: {
        current_pricing, price_elasticity, competitive_position, optimization_opportunities,
        recommended_changes, projected_revenue_impact, confidence,
      },
    };
  }

  if (kind === "analyze_contracts") {
    const total_contract_value = typeof p.total_contract_value === "number" && Number.isFinite(p.total_contract_value) && p.total_contract_value >= 0 ? p.total_contract_value : null;
    if (total_contract_value === null) return { ok: false, reason: "bad_total_contract_value" };
    const total_annual_value = typeof p.total_annual_value === "number" && Number.isFinite(p.total_annual_value) && p.total_annual_value >= 0 ? p.total_annual_value : null;
    if (total_annual_value === null) return { ok: false, reason: "bad_total_annual_value" };

    if (typeof p.renewal_risk_summary !== "object" || p.renewal_risk_summary === null || Array.isArray(p.renewal_risk_summary)) {
      return { ok: false, reason: "bad_renewal_risk_summary" };
    }
    const rrsRaw = p.renewal_risk_summary as Record<string, unknown>;
    const at_risk_count = typeof rrsRaw.at_risk_count === "number" && Number.isInteger(rrsRaw.at_risk_count) && rrsRaw.at_risk_count >= 0 ? rrsRaw.at_risk_count : null;
    const at_risk_value = typeof rrsRaw.at_risk_value === "number" && Number.isFinite(rrsRaw.at_risk_value) && rrsRaw.at_risk_value >= 0 ? rrsRaw.at_risk_value : null;
    const renewals_due_90_days = typeof rrsRaw.renewals_due_90_days === "number" && Number.isInteger(rrsRaw.renewals_due_90_days) && rrsRaw.renewals_due_90_days >= 0 ? rrsRaw.renewals_due_90_days : null;
    if (at_risk_count === null || at_risk_value === null || renewals_due_90_days === null) {
      return { ok: false, reason: "bad_renewal_risk_summary" };
    }
    const renewal_risk_summary = { at_risk_count, at_risk_value, renewals_due_90_days };

    const CONTRACT_TYPES = ["customer", "vendor", "employee", "other"];
    const CONTRACT_STATUSES = ["active", "expired", "pending", "terminated"];
    const MAX_CONTRACTS = 50;
    const rawContracts = Array.isArray(p.contracts) ? (p.contracts as unknown[]).slice(0, MAX_CONTRACTS) : [];
    const contracts: {
      contract_id: string; counterparty: string; contract_type: string; total_value: number; annual_value: number;
      start_date: string; end_date: string; auto_renews: boolean; status: string; days_until_renewal: number | null;
    }[] = [];
    for (const c of rawContracts) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const contract_id = str(rec.contract_id);
      const counterparty = str(rec.counterparty);
      const contract_type = typeof rec.contract_type === "string" && CONTRACT_TYPES.includes(rec.contract_type) ? rec.contract_type : null;
      const total_value = typeof rec.total_value === "number" && Number.isFinite(rec.total_value) && rec.total_value >= 0 ? rec.total_value : null;
      const annual_value = typeof rec.annual_value === "number" && Number.isFinite(rec.annual_value) && rec.annual_value >= 0 ? rec.annual_value : null;
      const start_date = str(rec.start_date);
      const end_date = str(rec.end_date);
      const auto_renews = typeof rec.auto_renews === "boolean" ? rec.auto_renews : null;
      const status = typeof rec.status === "string" && CONTRACT_STATUSES.includes(rec.status) ? rec.status : null;
      const days_until_renewal = rec.days_until_renewal === null ? null : (typeof rec.days_until_renewal === "number" && Number.isInteger(rec.days_until_renewal) ? rec.days_until_renewal : undefined);
      if (contract_id && counterparty && contract_type && total_value !== null && annual_value !== null && start_date && end_date && auto_renews !== null && status && days_until_renewal !== undefined) {
        contracts.push({ contract_id, counterparty, contract_type, total_value, annual_value, start_date, end_date, auto_renews, status, days_until_renewal });
      }
    }

    const MAX_RENEWALS = 30;
    const RISKS = ["high", "medium", "low"];
    const rawRenewals = Array.isArray(p.upcoming_renewals) ? (p.upcoming_renewals as unknown[]).slice(0, MAX_RENEWALS) : [];
    const upcoming_renewals: { contract_id: string; counterparty: string; renewal_date: string; annual_value: number; risk: string }[] = [];
    for (const u of rawRenewals) {
      if (typeof u !== "object" || u === null) continue;
      const rec = u as Record<string, unknown>;
      const contract_id = str(rec.contract_id);
      const counterparty = str(rec.counterparty);
      const renewal_date = str(rec.renewal_date);
      const annual_value = typeof rec.annual_value === "number" && Number.isFinite(rec.annual_value) && rec.annual_value >= 0 ? rec.annual_value : null;
      const risk = typeof rec.risk === "string" && RISKS.includes(rec.risk) ? rec.risk : null;
      if (contract_id && counterparty && renewal_date && annual_value !== null && risk) {
        upcoming_renewals.push({ contract_id, counterparty, renewal_date, annual_value, risk });
      }
    }

    const red_flags = strArray(p.red_flags, 15, MAX_STR);

    return {
      ok: true,
      kind: "analyze_contracts",
      payload: { contracts, total_contract_value, total_annual_value, renewal_risk_summary, upcoming_renewals, red_flags },
    };
  }

  if (kind === "analyze_marketing_roi") {
    const total_spend = typeof p.total_spend === "number" && Number.isFinite(p.total_spend) && p.total_spend >= 0 ? p.total_spend : null;
    if (total_spend === null) return { ok: false, reason: "bad_total_spend" };
    const total_revenue_attributed = typeof p.total_revenue_attributed === "number" && Number.isFinite(p.total_revenue_attributed) && p.total_revenue_attributed >= 0 ? p.total_revenue_attributed : null;
    if (total_revenue_attributed === null) return { ok: false, reason: "bad_total_revenue_attributed" };
    const overall_roi = typeof p.overall_roi === "number" && Number.isFinite(p.overall_roi) ? p.overall_roi : null;
    if (overall_roi === null) return { ok: false, reason: "bad_overall_roi" };
    const best_performing_channel = str(p.best_performing_channel);
    if (!best_performing_channel) return { ok: false, reason: "missing_best_performing_channel" };
    const worst_performing_channel = str(p.worst_performing_channel);
    if (!worst_performing_channel) return { ok: false, reason: "missing_worst_performing_channel" };

    const customer_acquisition_cost = numOrNull(p.customer_acquisition_cost, 0);
    if (customer_acquisition_cost === NUM_INVALID) return { ok: false, reason: "bad_customer_acquisition_cost" };

    const MAX_CHANNELS = 20;
    const rawChannels = Array.isArray(p.channels) ? (p.channels as unknown[]).slice(0, MAX_CHANNELS) : [];
    const channels: { channel_name: string; spend: number; revenue_attributed: number; roi: number; leads_generated: number | null; conversions: number | null; cac: number | null }[] = [];
    for (const c of rawChannels) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const channel_name = str(rec.channel_name);
      const spend = typeof rec.spend === "number" && Number.isFinite(rec.spend) && rec.spend >= 0 ? rec.spend : null;
      const revenue_attributed = typeof rec.revenue_attributed === "number" && Number.isFinite(rec.revenue_attributed) && rec.revenue_attributed >= 0 ? rec.revenue_attributed : null;
      const roi = typeof rec.roi === "number" && Number.isFinite(rec.roi) ? rec.roi : null;
      const leads_generated = numOrNull(rec.leads_generated, 0);
      const conversions = numOrNull(rec.conversions, 0);
      const cac = numOrNull(rec.cac, 0);
      if (channel_name && spend !== null && revenue_attributed !== null && roi !== null
        && leads_generated !== NUM_INVALID && conversions !== NUM_INVALID && cac !== NUM_INVALID) {
        channels.push({ channel_name, spend, revenue_attributed, roi, leads_generated, conversions, cac });
      }
    }
    if (channels.length === 0) return { ok: false, reason: "no_valid_channels" };

    const recommendations = strArray(p.recommendations, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_marketing_roi",
      payload: {
        channels, total_spend, total_revenue_attributed, overall_roi, customer_acquisition_cost,
        best_performing_channel, worst_performing_channel, recommendations,
      },
    };
  }

  if (kind === "detect_fraud_signals") {
    const SEVERITIES = ["critical", "high", "medium", "low"];
    const MAX_ITEMS = 100;
    const rawItems = Array.isArray(p.suspicious_items) ? (p.suspicious_items as unknown[]).slice(0, MAX_ITEMS) : [];
    const suspicious_items: { item_ref: string; description: string; amount: number | null; flag_reason: string; severity: string }[] = [];
    for (const it of rawItems) {
      if (typeof it !== "object" || it === null) continue;
      const rec = it as Record<string, unknown>;
      const item_ref = str(rec.item_ref);
      const description = str(rec.description);
      const flag_reason = str(rec.flag_reason);
      const severity = typeof rec.severity === "string" && SEVERITIES.includes(rec.severity) ? rec.severity : null;
      const amount = numOrNull(rec.amount);
      if (item_ref && description && flag_reason && severity && amount !== NUM_INVALID) {
        suspicious_items.push({ item_ref, description, amount, flag_reason, severity });
      }
    }

    const RISK_LEVELS = ["critical", "high", "medium", "low", "clean"];
    const risk_level = typeof p.risk_level === "string" && RISK_LEVELS.includes(p.risk_level) ? p.risk_level : null;
    if (!risk_level) return { ok: false, reason: "bad_risk_level" };

    const fraud_patterns = strArray(p.fraud_patterns, 20, MAX_STR);

    let benford_analysis: { first_digit_distribution: number[]; expected_distribution: number[]; anomaly_detected: boolean; anomaly_description: string } | null = null;
    if (p.benford_analysis !== undefined && p.benford_analysis !== null) {
      if (typeof p.benford_analysis !== "object" || Array.isArray(p.benford_analysis)) {
        return { ok: false, reason: "bad_benford_analysis" };
      }
      const b = p.benford_analysis as Record<string, unknown>;
      const isDist = (v: unknown): v is number[] =>
        Array.isArray(v) && v.length === 9 && v.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1);
      if (!isDist(b.first_digit_distribution) || !isDist(b.expected_distribution)) {
        return { ok: false, reason: "bad_benford_analysis" };
      }
      if (typeof b.anomaly_detected !== "boolean") return { ok: false, reason: "bad_benford_analysis" };
      const anomaly_description = str(b.anomaly_description);
      if (!anomaly_description) return { ok: false, reason: "bad_benford_analysis" };
      benford_analysis = {
        first_digit_distribution: b.first_digit_distribution,
        expected_distribution: b.expected_distribution,
        anomaly_detected: b.anomaly_detected,
        anomaly_description,
      };
    }

    const total_suspicious_amount = typeof p.total_suspicious_amount === "number" && Number.isFinite(p.total_suspicious_amount) && p.total_suspicious_amount >= 0 ? p.total_suspicious_amount : null;
    if (total_suspicious_amount === null) return { ok: false, reason: "bad_total_suspicious_amount" };

    const recommended_actions = strArray(p.recommended_actions, 10, MAX_STR);

    return {
      ok: true,
      kind: "detect_fraud_signals",
      payload: { suspicious_items, risk_level, fraud_patterns, benford_analysis, total_suspicious_amount, recommended_actions },
    };
  }

  if (kind === "analyze_concentration_risk") {
    const RISK_LEVELS4 = ["critical", "high", "medium", "low"];
    if (!Array.isArray(p.risk_dimensions)) return { ok: false, reason: "risk_dimensions_not_array" };
    const rawDims = (p.risk_dimensions as unknown[]).slice(0, 10);
    const risk_dimensions: { dimension: string; top_entities: { name: string; share: number }[]; hhi: number | null; risk_level: string; notes: string }[] = [];
    for (const d of rawDims) {
      if (typeof d !== "object" || d === null) continue;
      const rec = d as Record<string, unknown>;
      const dimension = str(rec.dimension);
      const risk_level = typeof rec.risk_level === "string" && RISK_LEVELS4.includes(rec.risk_level) ? rec.risk_level : null;
      const notes = str(rec.notes) ?? "";
      const hhi = numOrNull(rec.hhi, 0, 10000);
      if (!dimension || !risk_level || hhi === NUM_INVALID) continue;
      const rawEntities = Array.isArray(rec.top_entities) ? (rec.top_entities as unknown[]).slice(0, 10) : [];
      const top_entities: { name: string; share: number }[] = [];
      for (const e of rawEntities) {
        if (typeof e !== "object" || e === null) continue;
        const erec = e as Record<string, unknown>;
        const name = str(erec.name);
        const share = typeof erec.share === "number" && Number.isFinite(erec.share) && erec.share >= 0 && erec.share <= 100 ? erec.share : null;
        if (name && share !== null) top_entities.push({ name, share });
      }
      risk_dimensions.push({ dimension, top_entities, hhi, risk_level, notes });
    }
    if (risk_dimensions.length === 0) return { ok: false, reason: "no_valid_risk_dimensions" };

    const overall_risk_level = typeof p.overall_risk_level === "string" && RISK_LEVELS4.includes(p.overall_risk_level) ? p.overall_risk_level : null;
    if (!overall_risk_level) return { ok: false, reason: "bad_overall_risk_level" };

    const herfindahl_index = numOrNull(p.herfindahl_index, 0, 10000);
    if (herfindahl_index === NUM_INVALID) return { ok: false, reason: "bad_herfindahl_index" };

    const top_3_concentration_percentage = numOrNull(p.top_3_concentration_percentage, 0, 100);
    if (top_3_concentration_percentage === NUM_INVALID) return { ok: false, reason: "bad_top_3_concentration_percentage" };

    const mitigation_recommendations = strArray(p.mitigation_recommendations, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_concentration_risk",
      payload: { risk_dimensions, overall_risk_level, herfindahl_index, top_3_concentration_percentage, mitigation_recommendations },
    };
  }

  if (kind === "model_scenarios") {
    if (typeof p.base_case !== "object" || p.base_case === null || Array.isArray(p.base_case)) {
      return { ok: false, reason: "bad_base_case" };
    }
    const bc = p.base_case as Record<string, unknown>;
    const bcDescription = str(bc.description);
    if (!bcDescription) return { ok: false, reason: "bad_base_case" };
    const bcRevenue = numOrNull(bc.revenue);
    const bcCosts = numOrNull(bc.costs);
    const bcProfit = numOrNull(bc.profit);
    if (bcRevenue === NUM_INVALID || bcCosts === NUM_INVALID || bcProfit === NUM_INVALID) {
      return { ok: false, reason: "bad_base_case" };
    }
    const rawBcMetrics = Array.isArray(bc.key_metrics) ? (bc.key_metrics as unknown[]).slice(0, 10) : [];
    const bcKeyMetrics: { metric: string; value: number }[] = [];
    for (const m of rawBcMetrics) {
      if (typeof m !== "object" || m === null) continue;
      const rec = m as Record<string, unknown>;
      const metric = str(rec.metric);
      const value = typeof rec.value === "number" && Number.isFinite(rec.value) ? rec.value : null;
      if (metric && value !== null) bcKeyMetrics.push({ metric, value });
    }
    const base_case = { description: bcDescription, revenue: bcRevenue, costs: bcCosts, profit: bcProfit, key_metrics: bcKeyMetrics };

    const SCENARIO_TYPES = ["optimistic", "pessimistic", "stress_test", "custom"];
    if (!Array.isArray(p.scenarios)) return { ok: false, reason: "scenarios_not_array" };
    const rawScenarios = (p.scenarios as unknown[]).slice(0, 5);
    const scenarios: { scenario_name: string; type: string; assumptions: string[]; revenue: number | null; costs: number | null; profit: number | null; key_metrics: { metric: string; value: number }[]; probability: number | null; narrative: string }[] = [];
    for (const s of rawScenarios) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const scenario_name = str(rec.scenario_name);
      const type = typeof rec.type === "string" && SCENARIO_TYPES.includes(rec.type) ? rec.type : null;
      const narrative = str(rec.narrative);
      if (!scenario_name || !type || !narrative) continue;
      const revenue = numOrNull(rec.revenue);
      const costs = numOrNull(rec.costs);
      const profit = numOrNull(rec.profit);
      const probability = numOrNull(rec.probability, 0, 100);
      if (revenue === NUM_INVALID || costs === NUM_INVALID || profit === NUM_INVALID || probability === NUM_INVALID) continue;
      const assumptions = strArray(rec.assumptions, 10, MAX_STR);
      const rawMetrics = Array.isArray(rec.key_metrics) ? (rec.key_metrics as unknown[]).slice(0, 10) : [];
      const key_metrics: { metric: string; value: number }[] = [];
      for (const m of rawMetrics) {
        if (typeof m !== "object" || m === null) continue;
        const mrec = m as Record<string, unknown>;
        const metric = str(mrec.metric);
        const value = typeof mrec.value === "number" && Number.isFinite(mrec.value) ? mrec.value : null;
        if (metric && value !== null) key_metrics.push({ metric, value });
      }
      scenarios.push({ scenario_name, type, assumptions, revenue, costs, profit, key_metrics, probability, narrative });
    }
    if (scenarios.length < 2) return { ok: false, reason: "insufficient_scenarios" };

    const rawKeyVars = Array.isArray(p.key_variables) ? (p.key_variables as unknown[]).slice(0, 15) : [];
    const SENSITIVITIES = ["high", "medium", "low"];
    const key_variables: { variable: string; base_value: number | null; sensitivity: string }[] = [];
    for (const kv of rawKeyVars) {
      if (typeof kv !== "object" || kv === null) continue;
      const rec = kv as Record<string, unknown>;
      const variable = str(rec.variable);
      const sensitivity = typeof rec.sensitivity === "string" && SENSITIVITIES.includes(rec.sensitivity) ? rec.sensitivity : null;
      const base_value = numOrNull(rec.base_value);
      if (variable && sensitivity && base_value !== NUM_INVALID) {
        key_variables.push({ variable, base_value, sensitivity });
      }
    }

    const recommendation = str(p.recommendation);
    if (!recommendation) return { ok: false, reason: "missing_recommendation" };

    return {
      ok: true,
      kind: "model_scenarios",
      payload: { base_case, scenarios, key_variables, recommendation },
    };
  }

  if (kind === "analyze_liquidity_risk") {
    const cash_and_equivalents = numOrNull(p.cash_and_equivalents, 0);
    if (cash_and_equivalents === NUM_INVALID) return { ok: false, reason: "bad_cash_and_equivalents" };
    const total_short_term_obligations = numOrNull(p.total_short_term_obligations, 0);
    if (total_short_term_obligations === NUM_INVALID) return { ok: false, reason: "bad_total_short_term_obligations" };
    const liquidity_coverage_ratio = numOrNull(p.liquidity_coverage_ratio, 0);
    if (liquidity_coverage_ratio === NUM_INVALID) return { ok: false, reason: "bad_liquidity_coverage_ratio" };
    const months_of_runway = numOrNull(p.months_of_runway, 0);
    if (months_of_runway === NUM_INVALID) return { ok: false, reason: "bad_months_of_runway" };

    const rawForecast = Array.isArray(p.cash_flow_forecast) ? (p.cash_flow_forecast as unknown[]).slice(0, 24) : [];
    const cash_flow_forecast: { period: string; projected_inflow: number; projected_outflow: number; net_cash_flow: number; cumulative_cash: number | null }[] = [];
    for (const f of rawForecast) {
      if (typeof f !== "object" || f === null) continue;
      const rec = f as Record<string, unknown>;
      const period = str(rec.period);
      const projected_inflow = typeof rec.projected_inflow === "number" && Number.isFinite(rec.projected_inflow) && rec.projected_inflow >= 0 ? rec.projected_inflow : null;
      const projected_outflow = typeof rec.projected_outflow === "number" && Number.isFinite(rec.projected_outflow) && rec.projected_outflow >= 0 ? rec.projected_outflow : null;
      const net_cash_flow = typeof rec.net_cash_flow === "number" && Number.isFinite(rec.net_cash_flow) ? rec.net_cash_flow : null;
      const cumulative_cash = numOrNull(rec.cumulative_cash);
      if (period && projected_inflow !== null && projected_outflow !== null && net_cash_flow !== null && cumulative_cash !== NUM_INVALID) {
        cash_flow_forecast.push({ period, projected_inflow, projected_outflow, net_cash_flow, cumulative_cash });
      }
    }

    if (!Array.isArray(p.stress_scenarios)) return { ok: false, reason: "stress_scenarios_not_array" };
    const rawStress = (p.stress_scenarios as unknown[]).slice(0, 4);
    const stress_scenarios: { scenario_name: string; assumption: string; projected_cash_impact: number; months_of_runway_remaining: number | null }[] = [];
    for (const s of rawStress) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const scenario_name = str(rec.scenario_name);
      const assumption = str(rec.assumption);
      const projected_cash_impact = typeof rec.projected_cash_impact === "number" && Number.isFinite(rec.projected_cash_impact) ? rec.projected_cash_impact : null;
      const months_of_runway_remaining = numOrNull(rec.months_of_runway_remaining);
      if (scenario_name && assumption && projected_cash_impact !== null && months_of_runway_remaining !== NUM_INVALID) {
        stress_scenarios.push({ scenario_name, assumption, projected_cash_impact, months_of_runway_remaining });
      }
    }
    if (stress_scenarios.length === 0) return { ok: false, reason: "no_valid_stress_scenarios" };

    const RISK_LEVELS5 = ["critical", "high", "medium", "low"];
    const risk_level = typeof p.risk_level === "string" && RISK_LEVELS5.includes(p.risk_level) ? p.risk_level : null;
    if (!risk_level) return { ok: false, reason: "bad_risk_level" };

    const recommendations = strArray(p.recommendations, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_liquidity_risk",
      payload: { cash_and_equivalents, total_short_term_obligations, liquidity_coverage_ratio, months_of_runway, cash_flow_forecast, stress_scenarios, risk_level, recommendations },
    };
  }

  if (kind === "track_covenants") {
    const COVENANT_TYPES = ["financial", "operational", "reporting"];
    const STATUSES = ["compliant", "at_risk", "violated", "waived", "not_tested"];
    const rawCovenants = Array.isArray(p.covenants) ? (p.covenants as unknown[]).slice(0, 30) : [];
    const covenants: { covenant_name: string; covenant_type: string; threshold: string; current_value: string; status: string; headroom_percentage: number | null; lender_or_counterparty: string; notes: string }[] = [];
    for (const c of rawCovenants) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const covenant_name = str(rec.covenant_name);
      const covenant_type = typeof rec.covenant_type === "string" && COVENANT_TYPES.includes(rec.covenant_type) ? rec.covenant_type : null;
      const threshold = str(rec.threshold);
      const current_value = str(rec.current_value);
      const status = typeof rec.status === "string" && STATUSES.includes(rec.status) ? rec.status : null;
      const lender_or_counterparty = str(rec.lender_or_counterparty) ?? "";
      const notes = str(rec.notes) ?? "";
      const headroom_percentage = numOrNull(rec.headroom_percentage);
      if (covenant_name && covenant_type && threshold && current_value && status && headroom_percentage !== NUM_INVALID) {
        covenants.push({ covenant_name, covenant_type, threshold, current_value, status, headroom_percentage, lender_or_counterparty, notes });
      }
    }

    const COMPLIANCE = ["compliant", "at_risk", "breach", "unknown"];
    const overall_compliance = typeof p.overall_compliance === "string" && COMPLIANCE.includes(p.overall_compliance) ? p.overall_compliance : null;
    if (!overall_compliance) return { ok: false, reason: "bad_overall_compliance" };

    const violations_count = typeof p.violations_count === "number" && Number.isInteger(p.violations_count) && p.violations_count >= 0 ? p.violations_count : null;
    if (violations_count === null) return { ok: false, reason: "bad_violations_count" };
    const at_risk_count = typeof p.at_risk_count === "number" && Number.isInteger(p.at_risk_count) && p.at_risk_count >= 0 ? p.at_risk_count : null;
    if (at_risk_count === null) return { ok: false, reason: "bad_at_risk_count" };

    const next_test_date = typeof p.next_test_date === "string" && p.next_test_date.length > 0 ? p.next_test_date.slice(0, 100) : null;

    const remediation_actions = strArray(p.remediation_actions, 15, MAX_STR);

    return {
      ok: true,
      kind: "track_covenants",
      payload: { covenants, overall_compliance, violations_count, at_risk_count, next_test_date, remediation_actions },
    };
  }

  if (kind === "classify_document") {
    const DOC_TYPES = ["financial_statement", "invoice", "contract", "expense_report", "payroll", "bank_statement", "budget", "forecast", "hr_data", "sales_data", "operational_data", "unknown"];
    const document_type = typeof p.document_type === "string" && DOC_TYPES.includes(p.document_type) ? p.document_type : null;
    if (!document_type) return { ok: false, reason: "bad_document_type" };

    const document_subtype = typeof p.document_subtype === "string" && p.document_subtype.length > 0 ? p.document_subtype.slice(0, 100) : null;
    if (!document_subtype) return { ok: false, reason: "missing_document_subtype" };

    const CONFIDENCES = ["high", "medium", "low"];
    const confidence = typeof p.confidence === "string" && CONFIDENCES.includes(p.confidence) ? p.confidence : null;
    if (!confidence) return { ok: false, reason: "bad_confidence" };

    if (typeof p.detected_entities !== "object" || p.detected_entities === null || Array.isArray(p.detected_entities)) {
      return { ok: false, reason: "bad_detected_entities" };
    }
    const de = p.detected_entities as Record<string, unknown>;
    const companies = strArray(de.companies, 20, 200);
    const dates = strArray(de.dates, 20, 50);
    const currencies = strArray(de.currencies, 10, 10);
    const rawAmounts = Array.isArray(de.amounts) ? (de.amounts as unknown[]).slice(0, 50) : [];
    const amounts = rawAmounts.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    const detected_entities = { companies, dates, currencies, amounts };

    const language = str(p.language);
    if (!language) return { ok: false, reason: "missing_language" };

    const time_period = typeof p.time_period === "string" && p.time_period.length > 0 ? p.time_period.slice(0, 100) : null;
    const currency = typeof p.currency === "string" && p.currency.length > 0 ? p.currency.slice(0, 10) : null;

    const classification_notes = typeof p.classification_notes === "string" && p.classification_notes.length > 0 ? p.classification_notes.slice(0, 500) : null;
    if (!classification_notes) return { ok: false, reason: "missing_classification_notes" };

    return {
      ok: true,
      kind: "classify_document",
      payload: { document_type, document_subtype, confidence, detected_entities, language, time_period, currency, classification_notes },
    };
  }

  if (kind === "detect_schema_evolution") {
    const INFERRED_TYPES = ["string", "number", "date", "boolean", "mixed", "empty"];
    const rawCols = Array.isArray(p.columns_detected) ? (p.columns_detected as unknown[]).slice(0, 200) : [];
    const columns_detected: { column_name: string; inferred_type: string; nullable: boolean; sample_values: string[] }[] = [];
    for (const c of rawCols) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const column_name = str(rec.column_name);
      const inferred_type = typeof rec.inferred_type === "string" && INFERRED_TYPES.includes(rec.inferred_type) ? rec.inferred_type : null;
      if (column_name && inferred_type && typeof rec.nullable === "boolean") {
        columns_detected.push({ column_name, inferred_type, nullable: rec.nullable, sample_values: strArray(rec.sample_values, 3, 200) });
      }
    }

    const schema_version = str(p.schema_version);
    if (!schema_version) return { ok: false, reason: "missing_schema_version" };

    const breaking_changes = strArray(p.breaking_changes, 20, MAX_STR);
    const added_columns = strArray(p.added_columns, 50, 200);
    const removed_columns = strArray(p.removed_columns, 50, 200);

    const RENAME_CONFS = ["high", "medium", "low"];
    const rawRenamed = Array.isArray(p.renamed_columns) ? (p.renamed_columns as unknown[]).slice(0, 20) : [];
    const renamed_columns: { old_name: string; new_name: string; confidence: string }[] = [];
    for (const r of rawRenamed) {
      if (typeof r !== "object" || r === null) continue;
      const rec = r as Record<string, unknown>;
      const old_name = str(rec.old_name);
      const new_name = str(rec.new_name);
      const confidence = typeof rec.confidence === "string" && RENAME_CONFS.includes(rec.confidence) ? rec.confidence : null;
      if (old_name && new_name && confidence) {
        renamed_columns.push({ old_name, new_name, confidence });
      }
    }

    const rawTypeChanges = Array.isArray(p.type_changes) ? (p.type_changes as unknown[]).slice(0, 20) : [];
    const type_changes: { column_name: string; old_type: string; new_type: string }[] = [];
    for (const t of rawTypeChanges) {
      if (typeof t !== "object" || t === null) continue;
      const rec = t as Record<string, unknown>;
      const column_name = str(rec.column_name);
      const old_type = str(rec.old_type);
      const new_type = str(rec.new_type);
      if (column_name && old_type && new_type) {
        type_changes.push({ column_name, old_type, new_type });
      }
    }

    const COMPATIBILITIES = ["compatible", "minor_changes", "breaking", "new_schema"];
    const compatibility = typeof p.compatibility === "string" && COMPATIBILITIES.includes(p.compatibility) ? p.compatibility : null;
    if (!compatibility) return { ok: false, reason: "bad_compatibility" };

    return {
      ok: true,
      kind: "detect_schema_evolution",
      payload: { columns_detected, schema_version, breaking_changes, added_columns, removed_columns, renamed_columns, type_changes, compatibility },
    };
  }

  if (kind === "extract_kpis") {
    const CATEGORIES = ["financial", "operational", "customer", "people", "other"];
    const TRENDS = ["improving", "declining", "stable", "unknown"];
    const rawKpis = Array.isArray(p.kpis) ? (p.kpis as unknown[]).slice(0, 50) : [];
    const kpis: { kpi_name: string; value: number | null; unit: string; category: string; period: string | null; trend: string; benchmark: number | null; vs_benchmark: number | null }[] = [];
    for (const k of rawKpis) {
      if (typeof k !== "object" || k === null) continue;
      const rec = k as Record<string, unknown>;
      const kpi_name = str(rec.kpi_name);
      const unit = str(rec.unit) ?? "";
      const category = typeof rec.category === "string" && CATEGORIES.includes(rec.category) ? rec.category : null;
      const trend = typeof rec.trend === "string" && TRENDS.includes(rec.trend) ? rec.trend : null;
      const value = numOrNull(rec.value);
      const period = typeof rec.period === "string" && rec.period.length > 0 ? rec.period.slice(0, 100) : null;
      const benchmark = numOrNull(rec.benchmark);
      const vs_benchmark = numOrNull(rec.vs_benchmark);
      if (kpi_name && category && trend && value !== NUM_INVALID && benchmark !== NUM_INVALID && vs_benchmark !== NUM_INVALID) {
        kpis.push({ kpi_name, value, unit, category, period, trend, benchmark, vs_benchmark });
      }
    }

    const kpi_count = typeof p.kpi_count === "number" && Number.isInteger(p.kpi_count) && p.kpi_count >= 0 ? p.kpi_count : null;
    if (kpi_count === null) return { ok: false, reason: "bad_kpi_count" };

    const top_kpis = strArray(p.top_kpis, 10, 200);

    const DATA_QUALITIES = ["high", "medium", "low"];
    const data_quality = typeof p.data_quality === "string" && DATA_QUALITIES.includes(p.data_quality) ? p.data_quality : null;
    if (!data_quality) return { ok: false, reason: "bad_data_quality" };

    return {
      ok: true,
      kind: "extract_kpis",
      payload: { kpis, kpi_count, top_kpis, data_quality },
    };
  }

  if (kind === "synthesize_insights") {
    const executive_summary = typeof p.executive_summary === "string" && p.executive_summary.length > 0 ? p.executive_summary.slice(0, 2000) : null;
    if (!executive_summary) return { ok: false, reason: "missing_executive_summary" };

    const IMPACTS = ["high", "medium", "low"];
    if (!Array.isArray(p.key_insights)) return { ok: false, reason: "key_insights_not_array" };
    const rawInsights = (p.key_insights as unknown[]).slice(0, 10);
    const key_insights: { insight: string; evidence: string; impact: string }[] = [];
    for (const k of rawInsights) {
      if (typeof k !== "object" || k === null) continue;
      const rec = k as Record<string, unknown>;
      const insight = str(rec.insight);
      const evidence = str(rec.evidence);
      const impact = typeof rec.impact === "string" && IMPACTS.includes(rec.impact) ? rec.impact : null;
      if (insight && evidence && impact) {
        key_insights.push({ insight, evidence, impact });
      }
    }
    if (key_insights.length < 3) return { ok: false, reason: "insufficient_key_insights" };

    const strategic_implications = strArray(p.strategic_implications, 10, MAX_STR);

    const LIKELIHOODS = ["high", "medium", "low"];
    const rawRisks = Array.isArray(p.critical_risks) ? (p.critical_risks as unknown[]).slice(0, 10) : [];
    const critical_risks: { risk: string; likelihood: string; potential_impact: string }[] = [];
    for (const r of rawRisks) {
      if (typeof r !== "object" || r === null) continue;
      const rec = r as Record<string, unknown>;
      const risk = str(rec.risk);
      const likelihood = typeof rec.likelihood === "string" && LIKELIHOODS.includes(rec.likelihood) ? rec.likelihood : null;
      const potential_impact = str(rec.potential_impact);
      if (risk && likelihood && potential_impact) {
        critical_risks.push({ risk, likelihood, potential_impact });
      }
    }

    const EFFORTS = ["high", "medium", "low"];
    const rawOpps = Array.isArray(p.opportunities) ? (p.opportunities as unknown[]).slice(0, 10) : [];
    const opportunities: { opportunity: string; effort: string; potential_impact: string }[] = [];
    for (const o of rawOpps) {
      if (typeof o !== "object" || o === null) continue;
      const rec = o as Record<string, unknown>;
      const opportunity = str(rec.opportunity);
      const effort = typeof rec.effort === "string" && EFFORTS.includes(rec.effort) ? rec.effort : null;
      const potential_impact = str(rec.potential_impact);
      if (opportunity && effort && potential_impact) {
        opportunities.push({ opportunity, effort, potential_impact });
      }
    }

    const CONFIDENCES = ["high", "medium", "low"];
    const confidence = typeof p.confidence === "string" && CONFIDENCES.includes(p.confidence) ? p.confidence : null;
    if (!confidence) return { ok: false, reason: "bad_confidence" };

    return {
      ok: true,
      kind: "synthesize_insights",
      payload: { executive_summary, key_insights, strategic_implications, critical_risks, opportunities, confidence },
    };
  }

  if (kind === "detect_conflicts") {
    const TYPES = ["data_inconsistency", "logic_error", "duplicate", "missing_data", "constraint_violation", "calculation_error"];
    const SEVERITIES4 = ["critical", "high", "medium", "low"];
    const rawConflicts = Array.isArray(p.conflicts) ? (p.conflicts as unknown[]).slice(0, 50) : [];
    const conflicts: { conflict_id: string; type: string; description: string; affected_fields: string[]; severity: string; resolution: string }[] = [];
    for (const c of rawConflicts) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const conflict_id = str(rec.conflict_id);
      const type = typeof rec.type === "string" && TYPES.includes(rec.type) ? rec.type : null;
      const description = str(rec.description);
      const severity = typeof rec.severity === "string" && SEVERITIES4.includes(rec.severity) ? rec.severity : null;
      const resolution = str(rec.resolution);
      if (conflict_id && type && description && severity && resolution) {
        conflicts.push({ conflict_id, type, description, affected_fields: strArray(rec.affected_fields, 10, 200), severity, resolution });
      }
    }

    const conflict_count = typeof p.conflict_count === "number" && Number.isInteger(p.conflict_count) && p.conflict_count >= 0 ? p.conflict_count : null;
    if (conflict_count === null) return { ok: false, reason: "bad_conflict_count" };

    const SEVERITIES5 = ["critical", "high", "medium", "low", "none"];
    const severity = typeof p.severity === "string" && SEVERITIES5.includes(p.severity) ? p.severity : null;
    if (!severity) return { ok: false, reason: "bad_severity" };

    const resolution_suggestions = strArray(p.resolution_suggestions, 10, MAX_STR);

    return {
      ok: true,
      kind: "detect_conflicts",
      payload: { conflicts, conflict_count, severity, resolution_suggestions },
    };
  }

  if (kind === "prioritize_actions") {
    const IMPACTS2 = ["high", "medium", "low"];
    const EFFORTS2 = ["high", "medium", "low"];
    const URGENCIES = ["immediate", "this_week", "this_month", "this_quarter"];
    const rawActions = Array.isArray(p.prioritized_actions) ? (p.prioritized_actions as unknown[]).slice(0, 30) : [];
    const prioritized_actions: { action: string; priority_rank: number; impact: string; effort: string; urgency: string; owner_role: string; rationale: string }[] = [];
    for (const a of rawActions) {
      if (typeof a !== "object" || a === null) continue;
      const rec = a as Record<string, unknown>;
      const action = str(rec.action);
      const priority_rank = typeof rec.priority_rank === "number" && Number.isInteger(rec.priority_rank) && rec.priority_rank >= 1 ? rec.priority_rank : null;
      const impact = typeof rec.impact === "string" && IMPACTS2.includes(rec.impact) ? rec.impact : null;
      const effort = typeof rec.effort === "string" && EFFORTS2.includes(rec.effort) ? rec.effort : null;
      const urgency = typeof rec.urgency === "string" && URGENCIES.includes(rec.urgency) ? rec.urgency : null;
      const owner_role = str(rec.owner_role);
      const rationale = str(rec.rationale);
      if (action && priority_rank !== null && impact && effort && urgency && owner_role && rationale) {
        prioritized_actions.push({ action, priority_rank, impact, effort, urgency, owner_role, rationale });
      }
    }

    if (!Array.isArray(p.top_3_actions) || p.top_3_actions.length !== 3) {
      return { ok: false, reason: "top_3_actions_must_have_exactly_3_items" };
    }
    const top_3_actions: { rank: number; action: string; why_now: string }[] = [];
    for (const t of p.top_3_actions as unknown[]) {
      if (typeof t !== "object" || t === null) return { ok: false, reason: "bad_top_3_action" };
      const rec = t as Record<string, unknown>;
      const rank = typeof rec.rank === "number" && Number.isInteger(rec.rank) && rec.rank >= 1 && rec.rank <= 3 ? rec.rank : null;
      const action = str(rec.action);
      const why_now = str(rec.why_now);
      if (rank === null || !action || !why_now) return { ok: false, reason: "bad_top_3_action" };
      top_3_actions.push({ rank, action, why_now });
    }

    const total_actions_reviewed = typeof p.total_actions_reviewed === "number" && Number.isInteger(p.total_actions_reviewed) && p.total_actions_reviewed >= 0 ? p.total_actions_reviewed : null;
    if (total_actions_reviewed === null) return { ok: false, reason: "bad_total_actions_reviewed" };

    const decision_rationale = typeof p.decision_rationale === "string" && p.decision_rationale.length > 0 ? p.decision_rationale.slice(0, 1000) : null;
    if (!decision_rationale) return { ok: false, reason: "missing_decision_rationale" };

    return {
      ok: true,
      kind: "prioritize_actions",
      payload: { prioritized_actions, top_3_actions, total_actions_reviewed, decision_rationale },
    };
  }

  if (kind === "profile_columns") {
    const DATA_TYPES = ["string", "integer", "float", "date", "boolean", "mixed", "empty"];
    const rawProfiles = Array.isArray(p.column_profiles) ? (p.column_profiles as unknown[]).slice(0, 200) : [];
    const column_profiles: { column_name: string; data_type: string; null_count: number; null_percentage: number; unique_count: number; unique_percentage: number; min_value: string | null; max_value: string | null; top_values: { value: string; count: number }[]; has_issues: boolean }[] = [];
    for (const c of rawProfiles) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const column_name = str(rec.column_name);
      const data_type = typeof rec.data_type === "string" && DATA_TYPES.includes(rec.data_type) ? rec.data_type : null;
      const null_count = typeof rec.null_count === "number" && Number.isInteger(rec.null_count) && rec.null_count >= 0 ? rec.null_count : null;
      const null_percentage = typeof rec.null_percentage === "number" && Number.isFinite(rec.null_percentage) && rec.null_percentage >= 0 && rec.null_percentage <= 100 ? rec.null_percentage : null;
      const unique_count = typeof rec.unique_count === "number" && Number.isInteger(rec.unique_count) && rec.unique_count >= 0 ? rec.unique_count : null;
      const unique_percentage = typeof rec.unique_percentage === "number" && Number.isFinite(rec.unique_percentage) && rec.unique_percentage >= 0 && rec.unique_percentage <= 100 ? rec.unique_percentage : null;
      if (!column_name || !data_type || null_count === null || null_percentage === null || unique_count === null || unique_percentage === null || typeof rec.has_issues !== "boolean") continue;
      const min_value = typeof rec.min_value === "string" ? rec.min_value.slice(0, MAX_STR) : null;
      const max_value = typeof rec.max_value === "string" ? rec.max_value.slice(0, MAX_STR) : null;
      const rawTop = Array.isArray(rec.top_values) ? (rec.top_values as unknown[]).slice(0, 5) : [];
      const top_values: { value: string; count: number }[] = [];
      for (const t of rawTop) {
        if (typeof t !== "object" || t === null) continue;
        const trec = t as Record<string, unknown>;
        const value = str(trec.value);
        const count = typeof trec.count === "number" && Number.isInteger(trec.count) && trec.count >= 0 ? trec.count : null;
        if (value && count !== null) top_values.push({ value, count });
      }
      column_profiles.push({ column_name, data_type, null_count, null_percentage, unique_count, unique_percentage, min_value, max_value, top_values, has_issues: rec.has_issues });
    }

    const total_rows = typeof p.total_rows === "number" && Number.isInteger(p.total_rows) && p.total_rows >= 0 ? p.total_rows : null;
    if (total_rows === null) return { ok: false, reason: "bad_total_rows" };
    const total_columns = typeof p.total_columns === "number" && Number.isInteger(p.total_columns) && p.total_columns >= 0 ? p.total_columns : null;
    if (total_columns === null) return { ok: false, reason: "bad_total_columns" };
    const overall_completeness = typeof p.overall_completeness === "number" && Number.isFinite(p.overall_completeness) && p.overall_completeness >= 0 && p.overall_completeness <= 100 ? p.overall_completeness : null;
    if (overall_completeness === null) return { ok: false, reason: "bad_overall_completeness" };

    return {
      ok: true,
      kind: "profile_columns",
      payload: { column_profiles, total_rows, total_columns, overall_completeness },
    };
  }

  if (kind === "build_data_dictionary") {
    const rawEntries = Array.isArray(p.entries) ? (p.entries as unknown[]).slice(0, 200) : [];
    const entries: { column_name: string; description: string; business_meaning: string; data_type: string; expected_format: string | null; example_values: string[]; is_key: boolean; is_sensitive: boolean; tags: string[] }[] = [];
    for (const e of rawEntries) {
      if (typeof e !== "object" || e === null) continue;
      const rec = e as Record<string, unknown>;
      const column_name = str(rec.column_name);
      const description = str(rec.description);
      const business_meaning = str(rec.business_meaning);
      const data_type = str(rec.data_type);
      if (!column_name || !description || !business_meaning || !data_type) continue;
      if (typeof rec.is_key !== "boolean" || typeof rec.is_sensitive !== "boolean") continue;
      const expected_format = typeof rec.expected_format === "string" && rec.expected_format.length > 0 ? rec.expected_format.slice(0, 200) : null;
      entries.push({
        column_name, description, business_meaning, data_type, expected_format,
        example_values: strArray(rec.example_values, 3, 200),
        is_key: rec.is_key, is_sensitive: rec.is_sensitive,
        tags: strArray(rec.tags, 5, 50),
      });
    }

    const total_columns_documented = typeof p.total_columns_documented === "number" && Number.isInteger(p.total_columns_documented) && p.total_columns_documented >= 0 ? p.total_columns_documented : null;
    if (total_columns_documented === null) return { ok: false, reason: "bad_total_columns_documented" };

    const undocumented_columns = strArray(p.undocumented_columns, 50, 200);

    return {
      ok: true,
      kind: "build_data_dictionary",
      payload: { entries, total_columns_documented, undocumented_columns },
    };
  }

  if (kind === "analyze_missing_data") {
    const PATTERNS = ["random", "systematic", "none", "unknown"];
    const IMPACTS3 = ["critical", "high", "medium", "low"];
    const rawSummary = Array.isArray(p.missing_summary) ? (p.missing_summary as unknown[]).slice(0, 200) : [];
    const missing_summary: { column_name: string; missing_count: number; missing_percentage: number; missing_pattern: string; impact: string }[] = [];
    for (const m of rawSummary) {
      if (typeof m !== "object" || m === null) continue;
      const rec = m as Record<string, unknown>;
      const column_name = str(rec.column_name);
      const missing_count = typeof rec.missing_count === "number" && Number.isInteger(rec.missing_count) && rec.missing_count >= 0 ? rec.missing_count : null;
      const missing_percentage = typeof rec.missing_percentage === "number" && Number.isFinite(rec.missing_percentage) && rec.missing_percentage >= 0 && rec.missing_percentage <= 100 ? rec.missing_percentage : null;
      const missing_pattern = typeof rec.missing_pattern === "string" && PATTERNS.includes(rec.missing_pattern) ? rec.missing_pattern : null;
      const impact = typeof rec.impact === "string" && IMPACTS3.includes(rec.impact) ? rec.impact : null;
      if (column_name && missing_count !== null && missing_percentage !== null && missing_pattern && impact) {
        missing_summary.push({ column_name, missing_count, missing_percentage, missing_pattern, impact });
      }
    }

    const critical_gaps = strArray(p.critical_gaps, 20, MAX_STR);

    const STRATEGIES = ["mean", "median", "mode", "forward_fill", "backward_fill", "zero", "drop_row", "model", "flag_and_exclude"];
    const rawImputation = Array.isArray(p.imputation_suggestions) ? (p.imputation_suggestions as unknown[]).slice(0, 20) : [];
    const imputation_suggestions: { column_name: string; strategy: string; rationale: string }[] = [];
    for (const i of rawImputation) {
      if (typeof i !== "object" || i === null) continue;
      const rec = i as Record<string, unknown>;
      const column_name = str(rec.column_name);
      const strategy = typeof rec.strategy === "string" && STRATEGIES.includes(rec.strategy) ? rec.strategy : null;
      const rationale = str(rec.rationale);
      if (column_name && strategy && rationale) {
        imputation_suggestions.push({ column_name, strategy, rationale });
      }
    }

    const overall_completeness = typeof p.overall_completeness === "number" && Number.isFinite(p.overall_completeness) && p.overall_completeness >= 0 && p.overall_completeness <= 100 ? p.overall_completeness : null;
    if (overall_completeness === null) return { ok: false, reason: "bad_overall_completeness" };

    const USABILITIES = ["fully_usable", "partially_usable", "limited_use", "not_usable"];
    const data_usability = typeof p.data_usability === "string" && USABILITIES.includes(p.data_usability) ? p.data_usability : null;
    if (!data_usability) return { ok: false, reason: "bad_data_usability" };

    return {
      ok: true,
      kind: "analyze_missing_data",
      payload: { missing_summary, critical_gaps, imputation_suggestions, overall_completeness, data_usability },
    };
  }

  if (kind === "assess_data_privacy") {
    const PII_TYPES = ["name", "email", "phone", "ssn", "address", "dob", "ip_address", "device_id", "financial_account", "health", "other"];
    const CONFIDENCES2 = ["high", "medium", "low"];
    const rawPii = Array.isArray(p.pii_fields) ? (p.pii_fields as unknown[]).slice(0, 50) : [];
    const pii_fields: { column_name: string; pii_type: string; confidence: string; example_pattern: string }[] = [];
    for (const f of rawPii) {
      if (typeof f !== "object" || f === null) continue;
      const rec = f as Record<string, unknown>;
      const column_name = str(rec.column_name);
      const pii_type = typeof rec.pii_type === "string" && PII_TYPES.includes(rec.pii_type) ? rec.pii_type : null;
      const confidence = typeof rec.confidence === "string" && CONFIDENCES2.includes(rec.confidence) ? rec.confidence : null;
      const example_pattern = str(rec.example_pattern);
      if (column_name && pii_type && confidence && example_pattern) {
        pii_fields.push({ column_name, pii_type, confidence, example_pattern });
      }
    }

    const rawSensitive = Array.isArray(p.sensitive_financial_fields) ? (p.sensitive_financial_fields as unknown[]).slice(0, 30) : [];
    const sensitive_financial_fields: { column_name: string; sensitivity_type: string; notes: string }[] = [];
    for (const s of rawSensitive) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const column_name = str(rec.column_name);
      const sensitivity_type = str(rec.sensitivity_type);
      const notes = str(rec.notes) ?? "";
      if (column_name && sensitivity_type) {
        sensitive_financial_fields.push({ column_name, sensitivity_type, notes });
      }
    }

    const RISK_LEVELS6 = ["critical", "high", "medium", "low"];
    const risk_level = typeof p.risk_level === "string" && RISK_LEVELS6.includes(p.risk_level) ? p.risk_level : null;
    if (!risk_level) return { ok: false, reason: "bad_risk_level" };

    const compliance_concerns = strArray(p.compliance_concerns, 10, MAX_STR);

    const TECHNIQUES = ["hash", "tokenize", "redact", "generalize", "pseudonymize", "encrypt"];
    const PRIORITIES2 = ["immediate", "before_sharing", "optional"];
    const rawMasking = Array.isArray(p.masking_recommendations) ? (p.masking_recommendations as unknown[]).slice(0, 20) : [];
    const masking_recommendations: { column_name: string; technique: string; priority: string }[] = [];
    for (const m of rawMasking) {
      if (typeof m !== "object" || m === null) continue;
      const rec = m as Record<string, unknown>;
      const column_name = str(rec.column_name);
      const technique = typeof rec.technique === "string" && TECHNIQUES.includes(rec.technique) ? rec.technique : null;
      const priority = typeof rec.priority === "string" && PRIORITIES2.includes(rec.priority) ? rec.priority : null;
      if (column_name && technique && priority) {
        masking_recommendations.push({ column_name, technique, priority });
      }
    }

    return {
      ok: true,
      kind: "assess_data_privacy",
      payload: { pii_fields, sensitive_financial_fields, risk_level, compliance_concerns, masking_recommendations },
    };
  }

  if (kind === "classify_transactions") {
    const CATEGORIES2 = ["revenue", "cogs", "payroll", "rent", "utilities", "software", "marketing", "travel", "professional_services", "tax", "capex", "loan", "transfer", "refund", "other"];
    const CONFIDENCES3 = ["high", "medium", "low"];
    const rawTx = Array.isArray(p.classified_transactions) ? (p.classified_transactions as unknown[]).slice(0, 500) : [];
    const classified_transactions: { transaction_ref: string; description: string; amount: number; date: string; category: string; subcategory: string | null; confidence: string }[] = [];
    for (const t of rawTx) {
      if (typeof t !== "object" || t === null) continue;
      const rec = t as Record<string, unknown>;
      const transaction_ref = str(rec.transaction_ref);
      const description = str(rec.description);
      const amount = typeof rec.amount === "number" && Number.isFinite(rec.amount) ? rec.amount : null;
      const date = str(rec.date);
      const category = typeof rec.category === "string" && CATEGORIES2.includes(rec.category) ? rec.category : null;
      const confidence = typeof rec.confidence === "string" && CONFIDENCES3.includes(rec.confidence) ? rec.confidence : null;
      if (transaction_ref && description && amount !== null && date && category && confidence) {
        const subcategory = typeof rec.subcategory === "string" && rec.subcategory.length > 0 ? rec.subcategory.slice(0, 200) : null;
        classified_transactions.push({ transaction_ref, description, amount, date, category, subcategory, confidence });
      }
    }

    const rawSummary2 = Array.isArray(p.category_summary) ? (p.category_summary as unknown[]).slice(0, 30) : [];
    const category_summary: { category: string; transaction_count: number; total_amount: number; percentage_of_total: number }[] = [];
    for (const c of rawSummary2) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const category = str(rec.category);
      const transaction_count = typeof rec.transaction_count === "number" && Number.isInteger(rec.transaction_count) && rec.transaction_count >= 0 ? rec.transaction_count : null;
      const total_amount = typeof rec.total_amount === "number" && Number.isFinite(rec.total_amount) ? rec.total_amount : null;
      const percentage_of_total = typeof rec.percentage_of_total === "number" && Number.isFinite(rec.percentage_of_total) && rec.percentage_of_total >= 0 && rec.percentage_of_total <= 100 ? rec.percentage_of_total : null;
      if (category && transaction_count !== null && total_amount !== null && percentage_of_total !== null) {
        category_summary.push({ category, transaction_count, total_amount, percentage_of_total });
      }
    }

    const total_transactions = typeof p.total_transactions === "number" && Number.isInteger(p.total_transactions) && p.total_transactions >= 0 ? p.total_transactions : null;
    if (total_transactions === null) return { ok: false, reason: "bad_total_transactions" };
    const total_amount = typeof p.total_amount === "number" && Number.isFinite(p.total_amount) ? p.total_amount : null;
    if (total_amount === null) return { ok: false, reason: "bad_total_amount" };

    const ACCURACIES = ["high", "medium", "low"];
    const classification_accuracy = typeof p.classification_accuracy === "string" && ACCURACIES.includes(p.classification_accuracy) ? p.classification_accuracy : null;
    if (!classification_accuracy) return { ok: false, reason: "bad_classification_accuracy" };

    const uncategorized_count = typeof p.uncategorized_count === "number" && Number.isInteger(p.uncategorized_count) && p.uncategorized_count >= 0 ? p.uncategorized_count : null;
    if (uncategorized_count === null) return { ok: false, reason: "bad_uncategorized_count" };

    return {
      ok: true,
      kind: "classify_transactions",
      payload: { classified_transactions, category_summary, total_transactions, total_amount, classification_accuracy, uncategorized_count },
    };
  }

  if (kind === "check_expense_policy") {
    const VIOLATION_TYPES = ["over_limit", "missing_receipt", "unapproved_vendor", "wrong_category", "duplicate", "out_of_policy", "requires_approval"];
    const SEVERITIES6 = ["critical", "high", "medium", "low"];
    const rawViolations = Array.isArray(p.violations) ? (p.violations as unknown[]).slice(0, 200) : [];
    const violations: { expense_ref: string; submitter: string | null; amount: number; category: string; violation_type: string; policy_limit: number | null; excess_amount: number | null; severity: string }[] = [];
    for (const v of rawViolations) {
      if (typeof v !== "object" || v === null) continue;
      const rec = v as Record<string, unknown>;
      const expense_ref = str(rec.expense_ref);
      const amount = typeof rec.amount === "number" && Number.isFinite(rec.amount) && rec.amount >= 0 ? rec.amount : null;
      const category = str(rec.category);
      const violation_type = typeof rec.violation_type === "string" && VIOLATION_TYPES.includes(rec.violation_type) ? rec.violation_type : null;
      const severity = typeof rec.severity === "string" && SEVERITIES6.includes(rec.severity) ? rec.severity : null;
      const policy_limit = numOrNull(rec.policy_limit);
      const excess_amount = numOrNull(rec.excess_amount, 0);
      if (expense_ref && amount !== null && category && violation_type && severity && policy_limit !== NUM_INVALID && excess_amount !== NUM_INVALID) {
        const submitter = typeof rec.submitter === "string" && rec.submitter.length > 0 ? rec.submitter.slice(0, 200) : null;
        violations.push({ expense_ref, submitter, amount, category, violation_type, policy_limit, excess_amount, severity });
      }
    }

    const violation_count = typeof p.violation_count === "number" && Number.isInteger(p.violation_count) && p.violation_count >= 0 ? p.violation_count : null;
    if (violation_count === null) return { ok: false, reason: "bad_violation_count" };

    const total_policy_exception_amount = typeof p.total_policy_exception_amount === "number" && Number.isFinite(p.total_policy_exception_amount) && p.total_policy_exception_amount >= 0 ? p.total_policy_exception_amount : null;
    if (total_policy_exception_amount === null) return { ok: false, reason: "bad_total_policy_exception_amount" };

    const compliance_rate = typeof p.compliance_rate === "number" && Number.isFinite(p.compliance_rate) && p.compliance_rate >= 0 && p.compliance_rate <= 100 ? p.compliance_rate : null;
    if (compliance_rate === null) return { ok: false, reason: "bad_compliance_rate" };

    const rawSummary3 = Array.isArray(p.policy_summary) ? (p.policy_summary as unknown[]).slice(0, 20) : [];
    const policy_summary: { category: string; total_spent: number; budget_or_limit: number | null; utilization: number | null }[] = [];
    for (const s of rawSummary3) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const category = str(rec.category);
      const total_spent = typeof rec.total_spent === "number" && Number.isFinite(rec.total_spent) && rec.total_spent >= 0 ? rec.total_spent : null;
      const budget_or_limit = numOrNull(rec.budget_or_limit);
      const utilization = numOrNull(rec.utilization);
      if (category && total_spent !== null && budget_or_limit !== NUM_INVALID && utilization !== NUM_INVALID) {
        policy_summary.push({ category, total_spent, budget_or_limit, utilization });
      }
    }

    const escalations = strArray(p.escalations, 10, MAX_STR);

    return {
      ok: true,
      kind: "check_expense_policy",
      payload: { violations, violation_count, total_policy_exception_amount, compliance_rate, policy_summary, escalations },
    };
  }

  if (kind === "track_subscriptions") {
    const STATUSES2 = ["active", "trialing", "past_due", "cancelled", "paused"];
    const MOVEMENTS = ["new", "expansion", "contraction", "churn", "reactivation", "unchanged"];
    const rawSubs = Array.isArray(p.subscriptions) ? (p.subscriptions as unknown[]).slice(0, 500) : [];
    const subscriptions: { subscription_id: string; customer_name: string; plan: string; mrr: number; arr: number; status: string; start_date: string; renewal_date: string | null; movement: string }[] = [];
    for (const s of rawSubs) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const subscription_id = str(rec.subscription_id);
      const customer_name = str(rec.customer_name);
      const plan = str(rec.plan);
      const mrr = typeof rec.mrr === "number" && Number.isFinite(rec.mrr) && rec.mrr >= 0 ? rec.mrr : null;
      const arr = typeof rec.arr === "number" && Number.isFinite(rec.arr) && rec.arr >= 0 ? rec.arr : null;
      const status = typeof rec.status === "string" && STATUSES2.includes(rec.status) ? rec.status : null;
      const start_date = str(rec.start_date);
      const movement = typeof rec.movement === "string" && MOVEMENTS.includes(rec.movement) ? rec.movement : null;
      if (subscription_id && customer_name && plan && mrr !== null && arr !== null && status && start_date && movement) {
        const renewal_date = typeof rec.renewal_date === "string" && rec.renewal_date.length > 0 ? rec.renewal_date.slice(0, 100) : null;
        subscriptions.push({ subscription_id, customer_name, plan, mrr, arr, status, start_date, renewal_date, movement });
      }
    }

    const total_mrr = typeof p.total_mrr === "number" && Number.isFinite(p.total_mrr) && p.total_mrr >= 0 ? p.total_mrr : null;
    if (total_mrr === null) return { ok: false, reason: "bad_total_mrr" };
    const total_arr = typeof p.total_arr === "number" && Number.isFinite(p.total_arr) && p.total_arr >= 0 ? p.total_arr : null;
    if (total_arr === null) return { ok: false, reason: "bad_total_arr" };
    const new_mrr = typeof p.new_mrr === "number" && Number.isFinite(p.new_mrr) && p.new_mrr >= 0 ? p.new_mrr : null;
    if (new_mrr === null) return { ok: false, reason: "bad_new_mrr" };
    const expansion_mrr = typeof p.expansion_mrr === "number" && Number.isFinite(p.expansion_mrr) && p.expansion_mrr >= 0 ? p.expansion_mrr : null;
    if (expansion_mrr === null) return { ok: false, reason: "bad_expansion_mrr" };
    const contraction_mrr = typeof p.contraction_mrr === "number" && Number.isFinite(p.contraction_mrr) && p.contraction_mrr >= 0 ? p.contraction_mrr : null;
    if (contraction_mrr === null) return { ok: false, reason: "bad_contraction_mrr" };
    const churned_mrr = typeof p.churned_mrr === "number" && Number.isFinite(p.churned_mrr) && p.churned_mrr >= 0 ? p.churned_mrr : null;
    if (churned_mrr === null) return { ok: false, reason: "bad_churned_mrr" };
    const net_new_mrr = typeof p.net_new_mrr === "number" && Number.isFinite(p.net_new_mrr) ? p.net_new_mrr : null;
    if (net_new_mrr === null) return { ok: false, reason: "bad_net_new_mrr" };
    const subscription_count = typeof p.subscription_count === "number" && Number.isInteger(p.subscription_count) && p.subscription_count >= 0 ? p.subscription_count : null;
    if (subscription_count === null) return { ok: false, reason: "bad_subscription_count" };

    const avg_subscription_value = numOrNull(p.avg_subscription_value, 0);
    if (avg_subscription_value === NUM_INVALID) return { ok: false, reason: "bad_avg_subscription_value" };

    return {
      ok: true,
      kind: "track_subscriptions",
      payload: { subscriptions, total_mrr, total_arr, new_mrr, expansion_mrr, contraction_mrr, churned_mrr, net_new_mrr, subscription_count, avg_subscription_value },
    };
  }

  if (kind === "analyze_headcount_analytics") {
    const total_headcount = typeof p.total_headcount === "number" && Number.isInteger(p.total_headcount) && p.total_headcount >= 0 ? p.total_headcount : null;
    if (total_headcount === null) return { ok: false, reason: "bad_total_headcount" };

    const rawByDept = Array.isArray(p.headcount_by_department) ? (p.headcount_by_department as unknown[]).slice(0, 30) : [];
    const headcount_by_department: { department: string; count: number; percentage: number }[] = [];
    for (const d of rawByDept) {
      if (typeof d !== "object" || d === null) continue;
      const rec = d as Record<string, unknown>;
      const department = str(rec.department);
      const count = typeof rec.count === "number" && Number.isInteger(rec.count) && rec.count >= 0 ? rec.count : null;
      const percentage = typeof rec.percentage === "number" && Number.isFinite(rec.percentage) && rec.percentage >= 0 && rec.percentage <= 100 ? rec.percentage : null;
      if (department && count !== null && percentage !== null) {
        headcount_by_department.push({ department, count, percentage });
      }
    }

    const EMPLOYMENT_TYPES = ["full_time", "part_time", "contractor", "intern", "other"];
    const rawByType = Array.isArray(p.headcount_by_type) ? (p.headcount_by_type as unknown[]).slice(0, 10) : [];
    const headcount_by_type: { employment_type: string; count: number; percentage: number }[] = [];
    for (const t of rawByType) {
      if (typeof t !== "object" || t === null) continue;
      const rec = t as Record<string, unknown>;
      const employment_type = typeof rec.employment_type === "string" && EMPLOYMENT_TYPES.includes(rec.employment_type) ? rec.employment_type : null;
      const count = typeof rec.count === "number" && Number.isInteger(rec.count) && rec.count >= 0 ? rec.count : null;
      const percentage = typeof rec.percentage === "number" && Number.isFinite(rec.percentage) && rec.percentage >= 0 && rec.percentage <= 100 ? rec.percentage : null;
      if (employment_type && count !== null && percentage !== null) {
        headcount_by_type.push({ employment_type, count, percentage });
      }
    }

    const new_hires = typeof p.new_hires === "number" && Number.isInteger(p.new_hires) && p.new_hires >= 0 ? p.new_hires : null;
    if (new_hires === null) return { ok: false, reason: "bad_new_hires" };
    const terminations = typeof p.terminations === "number" && Number.isInteger(p.terminations) && p.terminations >= 0 ? p.terminations : null;
    if (terminations === null) return { ok: false, reason: "bad_terminations" };

    const attrition_rate = numOrNull(p.attrition_rate, 0, 100);
    if (attrition_rate === NUM_INVALID) return { ok: false, reason: "bad_attrition_rate" };
    const avg_tenure_months = numOrNull(p.avg_tenure_months, 0);
    if (avg_tenure_months === NUM_INVALID) return { ok: false, reason: "bad_avg_tenure_months" };
    const revenue_per_employee = numOrNull(p.revenue_per_employee, 0);
    if (revenue_per_employee === NUM_INVALID) return { ok: false, reason: "bad_revenue_per_employee" };
    const cost_per_employee = numOrNull(p.cost_per_employee, 0);
    if (cost_per_employee === NUM_INVALID) return { ok: false, reason: "bad_cost_per_employee" };

    const open_positions = typeof p.open_positions === "number" && Number.isInteger(p.open_positions) && p.open_positions >= 0 ? p.open_positions : null;
    if (open_positions === null) return { ok: false, reason: "bad_open_positions" };

    return {
      ok: true,
      kind: "analyze_headcount_analytics",
      payload: { total_headcount, headcount_by_department, headcount_by_type, new_hires, terminations, attrition_rate, avg_tenure_months, revenue_per_employee, cost_per_employee, open_positions },
    };
  }

  if (kind === "calculate_commissions") {
    const rawCommissions = Array.isArray(p.commissions) ? (p.commissions as unknown[]).slice(0, 100) : [];
    const commissions: { rep_name: string; quota: number | null; actual_sales: number; quota_attainment: number | null; commission_rate: number; commission_amount: number; accelerator_applied: boolean; notes: string | null }[] = [];
    for (const c of rawCommissions) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const rep_name = str(rec.rep_name);
      const actual_sales = typeof rec.actual_sales === "number" && Number.isFinite(rec.actual_sales) && rec.actual_sales >= 0 ? rec.actual_sales : null;
      const commission_rate = typeof rec.commission_rate === "number" && Number.isFinite(rec.commission_rate) && rec.commission_rate >= 0 && rec.commission_rate <= 100 ? rec.commission_rate : null;
      const commission_amount = typeof rec.commission_amount === "number" && Number.isFinite(rec.commission_amount) && rec.commission_amount >= 0 ? rec.commission_amount : null;
      if (!rep_name || actual_sales === null || commission_rate === null || commission_amount === null || typeof rec.accelerator_applied !== "boolean") continue;
      const quota = numOrNull(rec.quota, 0);
      const quota_attainment = numOrNull(rec.quota_attainment, 0);
      if (quota === NUM_INVALID || quota_attainment === NUM_INVALID) continue;
      const notes = typeof rec.notes === "string" && rec.notes.length > 0 ? rec.notes.slice(0, MAX_STR) : null;
      commissions.push({ rep_name, quota, actual_sales, quota_attainment, commission_rate, commission_amount, accelerator_applied: rec.accelerator_applied, notes });
    }

    const total_commission_payout = typeof p.total_commission_payout === "number" && Number.isFinite(p.total_commission_payout) && p.total_commission_payout >= 0 ? p.total_commission_payout : null;
    if (total_commission_payout === null) return { ok: false, reason: "bad_total_commission_payout" };
    const total_sales_value = typeof p.total_sales_value === "number" && Number.isFinite(p.total_sales_value) && p.total_sales_value >= 0 ? p.total_sales_value : null;
    if (total_sales_value === null) return { ok: false, reason: "bad_total_sales_value" };

    const effective_commission_rate = numOrNull(p.effective_commission_rate, 0, 100);
    if (effective_commission_rate === NUM_INVALID) return { ok: false, reason: "bad_effective_commission_rate" };

    if (typeof p.quota_attainment_summary !== "object" || p.quota_attainment_summary === null || Array.isArray(p.quota_attainment_summary)) {
      return { ok: false, reason: "bad_quota_attainment_summary" };
    }
    const qasRaw = p.quota_attainment_summary as Record<string, unknown>;
    const avg_attainment = numOrNull(qasRaw.avg_attainment, 0);
    if (avg_attainment === NUM_INVALID) return { ok: false, reason: "bad_quota_attainment_summary" };
    const reps_at_100_plus = typeof qasRaw.reps_at_100_plus === "number" && Number.isInteger(qasRaw.reps_at_100_plus) && qasRaw.reps_at_100_plus >= 0 ? qasRaw.reps_at_100_plus : null;
    if (reps_at_100_plus === null) return { ok: false, reason: "bad_quota_attainment_summary" };
    const reps_below_50 = typeof qasRaw.reps_below_50 === "number" && Number.isInteger(qasRaw.reps_below_50) && qasRaw.reps_below_50 >= 0 ? qasRaw.reps_below_50 : null;
    if (reps_below_50 === null) return { ok: false, reason: "bad_quota_attainment_summary" };
    const top_performer = typeof qasRaw.top_performer === "string" && qasRaw.top_performer.length > 0 ? qasRaw.top_performer.slice(0, 200) : null;
    const quota_attainment_summary = { avg_attainment, reps_at_100_plus, reps_below_50, top_performer };

    const disputes = strArray(p.disputes, 10, MAX_STR);

    return {
      ok: true,
      kind: "calculate_commissions",
      payload: { commissions, total_commission_payout, total_sales_value, effective_commission_rate, quota_attainment_summary, disputes },
    };
  }

  if (kind === "analyze_productivity") {
    const STATUSES3 = ["above_benchmark", "at_benchmark", "below_benchmark", "no_benchmark"];
    const rawMetrics = Array.isArray(p.productivity_metrics) ? (p.productivity_metrics as unknown[]).slice(0, 30) : [];
    const productivity_metrics: { metric_name: string; value: number | null; unit: string; period: string; benchmark: number | null; vs_benchmark: number | null; status: string }[] = [];
    for (const m of rawMetrics) {
      if (typeof m !== "object" || m === null) continue;
      const rec = m as Record<string, unknown>;
      const metric_name = str(rec.metric_name);
      const unit = str(rec.unit) ?? "";
      const period = str(rec.period);
      const status = typeof rec.status === "string" && STATUSES3.includes(rec.status) ? rec.status : null;
      const value = numOrNull(rec.value);
      const benchmark = numOrNull(rec.benchmark);
      const vs_benchmark = numOrNull(rec.vs_benchmark);
      if (metric_name && period && status && value !== NUM_INVALID && benchmark !== NUM_INVALID && vs_benchmark !== NUM_INVALID) {
        productivity_metrics.push({ metric_name, value, unit, period, benchmark, vs_benchmark, status });
      }
    }

    const rawOutput = Array.isArray(p.output_per_person) ? (p.output_per_person as unknown[]).slice(0, 20) : [];
    const output_per_person: { department: string; metric: string; value: number | null; unit: string }[] = [];
    for (const o of rawOutput) {
      if (typeof o !== "object" || o === null) continue;
      const rec = o as Record<string, unknown>;
      const department = str(rec.department);
      const metric = str(rec.metric);
      const unit = str(rec.unit) ?? "";
      const value = numOrNull(rec.value);
      if (department && metric && value !== NUM_INVALID) {
        output_per_person.push({ department, metric, value, unit });
      }
    }

    const bottlenecks = strArray(p.bottlenecks, 10, MAX_STR);

    const rawBenchmarks = Array.isArray(p.benchmarks) ? (p.benchmarks as unknown[]).slice(0, 10) : [];
    const benchmarks: { area: string; industry_standard: number | null; unit: string; source: string }[] = [];
    for (const b of rawBenchmarks) {
      if (typeof b !== "object" || b === null) continue;
      const rec = b as Record<string, unknown>;
      const area = str(rec.area);
      const unit = str(rec.unit) ?? "";
      const source = str(rec.source);
      const industry_standard = numOrNull(rec.industry_standard);
      if (area && source && industry_standard !== NUM_INVALID) {
        benchmarks.push({ area, industry_standard, unit, source });
      }
    }

    const improvement_recommendations = strArray(p.improvement_recommendations, 10, MAX_STR);

    const overall_productivity_score = numOrNull(p.overall_productivity_score, 0, 100);
    if (overall_productivity_score === NUM_INVALID || (typeof overall_productivity_score === "number" && !Number.isInteger(overall_productivity_score))) {
      return { ok: false, reason: "bad_overall_productivity_score" };
    }

    return {
      ok: true,
      kind: "analyze_productivity",
      payload: { productivity_metrics, output_per_person, bottlenecks, benchmarks, improvement_recommendations, overall_productivity_score },
    };
  }

  if (kind === "analyze_overtime") {
    const rawRecords = Array.isArray(p.overtime_records) ? (p.overtime_records as unknown[]).slice(0, 500) : [];
    const overtime_records: { employee_ref: string; department: string; period: string; regular_hours: number; overtime_hours: number; overtime_cost: number; consecutive_weeks_overtime: number | null }[] = [];
    for (const r of rawRecords) {
      if (typeof r !== "object" || r === null) continue;
      const rec = r as Record<string, unknown>;
      const employee_ref = str(rec.employee_ref);
      const department = str(rec.department);
      const period = str(rec.period);
      const regular_hours = typeof rec.regular_hours === "number" && Number.isFinite(rec.regular_hours) && rec.regular_hours >= 0 ? rec.regular_hours : null;
      const overtime_hours = typeof rec.overtime_hours === "number" && Number.isFinite(rec.overtime_hours) && rec.overtime_hours >= 0 ? rec.overtime_hours : null;
      const overtime_cost = typeof rec.overtime_cost === "number" && Number.isFinite(rec.overtime_cost) && rec.overtime_cost >= 0 ? rec.overtime_cost : null;
      if (!employee_ref || !department || !period || regular_hours === null || overtime_hours === null || overtime_cost === null) continue;
      let consecutive_weeks_overtime: number | null;
      if (rec.consecutive_weeks_overtime === null || rec.consecutive_weeks_overtime === undefined) {
        consecutive_weeks_overtime = null;
      } else if (typeof rec.consecutive_weeks_overtime === "number" && Number.isInteger(rec.consecutive_weeks_overtime) && rec.consecutive_weeks_overtime >= 0) {
        consecutive_weeks_overtime = rec.consecutive_weeks_overtime;
      } else {
        continue;
      }
      overtime_records.push({ employee_ref, department, period, regular_hours, overtime_hours, overtime_cost, consecutive_weeks_overtime });
    }

    const total_overtime_hours = typeof p.total_overtime_hours === "number" && Number.isFinite(p.total_overtime_hours) && p.total_overtime_hours >= 0 ? p.total_overtime_hours : null;
    if (total_overtime_hours === null) return { ok: false, reason: "bad_total_overtime_hours" };
    const total_overtime_cost = typeof p.total_overtime_cost === "number" && Number.isFinite(p.total_overtime_cost) && p.total_overtime_cost >= 0 ? p.total_overtime_cost : null;
    if (total_overtime_cost === null) return { ok: false, reason: "bad_total_overtime_cost" };

    const overtime_rate = numOrNull(p.overtime_rate, 0);
    if (overtime_rate === NUM_INVALID) return { ok: false, reason: "bad_overtime_rate" };

    const rawDepts = Array.isArray(p.departments_by_overtime) ? (p.departments_by_overtime as unknown[]).slice(0, 20) : [];
    const departments_by_overtime: { department: string; total_ot_hours: number; total_ot_cost: number; employee_count: number }[] = [];
    for (const d of rawDepts) {
      if (typeof d !== "object" || d === null) continue;
      const rec = d as Record<string, unknown>;
      const department = str(rec.department);
      const total_ot_hours = typeof rec.total_ot_hours === "number" && Number.isFinite(rec.total_ot_hours) && rec.total_ot_hours >= 0 ? rec.total_ot_hours : null;
      const total_ot_cost = typeof rec.total_ot_cost === "number" && Number.isFinite(rec.total_ot_cost) && rec.total_ot_cost >= 0 ? rec.total_ot_cost : null;
      const employee_count = typeof rec.employee_count === "number" && Number.isInteger(rec.employee_count) && rec.employee_count >= 0 ? rec.employee_count : null;
      if (department && total_ot_hours !== null && total_ot_cost !== null && employee_count !== null) {
        departments_by_overtime.push({ department, total_ot_hours, total_ot_cost, employee_count });
      }
    }

    const chronic_overtime_employees = strArray(p.chronic_overtime_employees, 50, 200);
    const risk_indicators = strArray(p.risk_indicators, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_overtime",
      payload: { overtime_records, total_overtime_hours, total_overtime_cost, overtime_rate, departments_by_overtime, chronic_overtime_employees, risk_indicators },
    };
  }

  if (kind === "calculate_growth_rates") {
    const rawMetrics = Array.isArray(p.growth_metrics) ? (p.growth_metrics as unknown[]).slice(0, 30) : [];
    const growth_metrics: { metric_name: string; current_value: number | null; prior_value: number | null; period_over_period_growth: number | null; yoy_growth: number | null; unit: string }[] = [];
    for (const m of rawMetrics) {
      if (typeof m !== "object" || m === null) continue;
      const rec = m as Record<string, unknown>;
      const metric_name = str(rec.metric_name);
      const unit = str(rec.unit) ?? "";
      const current_value = numOrNull(rec.current_value);
      const prior_value = numOrNull(rec.prior_value);
      const period_over_period_growth = numOrNull(rec.period_over_period_growth);
      const yoy_growth = numOrNull(rec.yoy_growth);
      if (metric_name && current_value !== NUM_INVALID && prior_value !== NUM_INVALID && period_over_period_growth !== NUM_INVALID && yoy_growth !== NUM_INVALID) {
        growth_metrics.push({ metric_name, current_value, prior_value, period_over_period_growth, yoy_growth, unit });
      }
    }

    if (typeof p.cagr !== "object" || p.cagr === null || Array.isArray(p.cagr)) {
      return { ok: false, reason: "bad_cagr" };
    }
    const cagrRaw = p.cagr as Record<string, unknown>;
    const cagrValue = numOrNull(cagrRaw.value);
    if (cagrValue === NUM_INVALID) return { ok: false, reason: "bad_cagr" };
    const cagrYears = typeof cagrRaw.years === "number" && Number.isFinite(cagrRaw.years) && cagrRaw.years >= 0 ? cagrRaw.years : (cagrRaw.years === null || cagrRaw.years === undefined ? null : NUM_INVALID);
    if (cagrYears === NUM_INVALID) return { ok: false, reason: "bad_cagr" };
    const cagrBasis = str(cagrRaw.basis) ?? "";
    const cagr = { value: cagrValue, years: cagrYears, basis: cagrBasis };

    const TRAJECTORIES = ["accelerating", "steady", "decelerating", "declining", "insufficient_data"];
    const growth_trajectory = typeof p.growth_trajectory === "string" && TRAJECTORIES.includes(p.growth_trajectory) ? p.growth_trajectory : null;
    if (growth_trajectory === null) return { ok: false, reason: "bad_growth_trajectory" };

    const projection_12m = numOrNull(p.projection_12m);
    if (projection_12m === NUM_INVALID) return { ok: false, reason: "bad_projection_12m" };
    const projection_24m = numOrNull(p.projection_24m);
    if (projection_24m === NUM_INVALID) return { ok: false, reason: "bad_projection_24m" };

    const growth_drivers = strArray(p.growth_drivers, 10, MAX_STR);

    return {
      ok: true,
      kind: "calculate_growth_rates",
      payload: { growth_metrics, cagr, growth_trajectory, projection_12m, projection_24m, growth_drivers },
    };
  }

  if (kind === "explain_outliers") {
    const outlier_count = typeof p.outlier_count === "number" && Number.isInteger(p.outlier_count) && p.outlier_count >= 0 ? p.outlier_count : null;
    if (outlier_count === null) return { ok: false, reason: "bad_outlier_count" };
    const explained_count = typeof p.explained_count === "number" && Number.isInteger(p.explained_count) && p.explained_count >= 0 ? p.explained_count : null;
    if (explained_count === null) return { ok: false, reason: "bad_explained_count" };

    const rawOutliers = Array.isArray(p.outliers) ? (p.outliers as unknown[]).slice(0, 20) : [];
    const outliers: { column: string; value: number | null; z_score: number | null; explanation: string }[] = [];
    for (const o of rawOutliers) {
      if (typeof o !== "object" || o === null) continue;
      const rec = o as Record<string, unknown>;
      const column = str(rec.column);
      const explanation = str(rec.explanation);
      if (!column || !explanation) continue;
      const value = numOrNull(rec.value);
      const z_score = numOrNull(rec.z_score);
      if (value === NUM_INVALID || z_score === NUM_INVALID) continue;
      outliers.push({ column, value, z_score, explanation });
    }

    const summary = str(p.summary);
    if (!summary) return { ok: false, reason: "bad_summary" };
    const data_period = str(p.data_period);
    if (!data_period) return { ok: false, reason: "bad_data_period" };

    return {
      ok: true,
      kind: "explain_outliers",
      payload: { outlier_count, explained_count, outliers, summary, data_period },
    };
  }

  if (kind === "decompose_time_series") {
    const TRENDS = ["upward", "downward", "flat"];
    const trend_direction = typeof p.trend_direction === "string" && TRENDS.includes(p.trend_direction) ? p.trend_direction : null;
    if (trend_direction === null) return { ok: false, reason: "bad_trend_direction" };

    const trend_strength = numOrNull(p.trend_strength, 0, 100);
    if (trend_strength === NUM_INVALID) return { ok: false, reason: "bad_trend_strength" };

    if (typeof p.seasonality_detected !== "boolean") return { ok: false, reason: "bad_seasonality_detected" };
    const seasonality_detected = p.seasonality_detected;

    const seasonality_period = typeof p.seasonality_period === "string" && p.seasonality_period.length > 0 ? p.seasonality_period.slice(0, MAX_STR) : null;

    const cycle_length_periods = typeof p.cycle_length_periods === "number" && Number.isInteger(p.cycle_length_periods) && p.cycle_length_periods >= 1
      ? p.cycle_length_periods
      : (p.cycle_length_periods === null || p.cycle_length_periods === undefined ? null : NUM_INVALID);
    if (cycle_length_periods === NUM_INVALID) return { ok: false, reason: "bad_cycle_length_periods" };

    const residual_variance_pct = numOrNull(p.residual_variance_pct, 0, 100);
    if (residual_variance_pct === NUM_INVALID) return { ok: false, reason: "bad_residual_variance_pct" };

    const data_points_analyzed = typeof p.data_points_analyzed === "number" && Number.isInteger(p.data_points_analyzed) && p.data_points_analyzed >= 0 ? p.data_points_analyzed : null;
    if (data_points_analyzed === null) return { ok: false, reason: "bad_data_points_analyzed" };

    const rawComponents = Array.isArray(p.components) ? (p.components as unknown[]).slice(0, 20) : [];
    const components: { period: string; trend_value: number | null; seasonal_value: number | null; residual: number | null }[] = [];
    for (const c of rawComponents) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const period = str(rec.period);
      if (!period) continue;
      const trend_value = numOrNull(rec.trend_value);
      const seasonal_value = numOrNull(rec.seasonal_value);
      const residual = numOrNull(rec.residual);
      if (trend_value === NUM_INVALID || seasonal_value === NUM_INVALID || residual === NUM_INVALID) continue;
      components.push({ period, trend_value, seasonal_value, residual });
    }

    const data_period = str(p.data_period);
    if (!data_period) return { ok: false, reason: "bad_data_period" };

    return {
      ok: true,
      kind: "decompose_time_series",
      payload: { trend_direction, trend_strength, seasonality_detected, seasonality_period, cycle_length_periods, residual_variance_pct, data_points_analyzed, components, data_period },
    };
  }

  if (kind === "assess_failure_risk") {
    const overall_risk_score = typeof p.overall_risk_score === "number" && Number.isFinite(p.overall_risk_score) && p.overall_risk_score >= 0 && p.overall_risk_score <= 100 ? p.overall_risk_score : null;
    if (overall_risk_score === null) return { ok: false, reason: "bad_overall_risk_score" };

    const RISK_LEVELS = ["low", "medium", "high", "critical"];
    const risk_level = typeof p.risk_level === "string" && RISK_LEVELS.includes(p.risk_level) ? p.risk_level : null;
    if (risk_level === null) return { ok: false, reason: "bad_risk_level" };

    const SEVERITIES = ["low", "medium", "high"];
    const rawFactors = Array.isArray(p.primary_risk_factors) ? (p.primary_risk_factors as unknown[]).slice(0, 10) : [];
    const primary_risk_factors: { factor: string; severity: string; description: string }[] = [];
    for (const f of rawFactors) {
      if (typeof f !== "object" || f === null) continue;
      const rec = f as Record<string, unknown>;
      const factor = str(rec.factor);
      const severity = typeof rec.severity === "string" && SEVERITIES.includes(rec.severity) ? rec.severity : null;
      const description = str(rec.description) ?? "";
      if (factor && severity) {
        primary_risk_factors.push({ factor, severity, description });
      }
    }

    const altman_z_score = numOrNull(p.altman_z_score);
    if (altman_z_score === NUM_INVALID) return { ok: false, reason: "bad_altman_z_score" };
    const current_ratio = numOrNull(p.current_ratio, 0);
    if (current_ratio === NUM_INVALID) return { ok: false, reason: "bad_current_ratio" };
    const debt_to_equity = numOrNull(p.debt_to_equity);
    if (debt_to_equity === NUM_INVALID) return { ok: false, reason: "bad_debt_to_equity" };
    const interest_coverage_ratio = numOrNull(p.interest_coverage_ratio);
    if (interest_coverage_ratio === NUM_INVALID) return { ok: false, reason: "bad_interest_coverage_ratio" };
    const cash_runway_months = numOrNull(p.cash_runway_months, 0);
    if (cash_runway_months === NUM_INVALID) return { ok: false, reason: "bad_cash_runway_months" };

    const data_period = str(p.data_period);
    if (!data_period) return { ok: false, reason: "bad_data_period" };

    return {
      ok: true,
      kind: "assess_failure_risk",
      payload: { overall_risk_score, risk_level, primary_risk_factors, altman_z_score, current_ratio, debt_to_equity, interest_coverage_ratio, cash_runway_months, data_period },
    };
  }

  if (kind === "analyze_unit_economics") {
    const ltv = numOrNull(p.ltv, 0);
    if (ltv === NUM_INVALID) return { ok: false, reason: "bad_ltv" };
    const cac = numOrNull(p.cac, 0);
    if (cac === NUM_INVALID) return { ok: false, reason: "bad_cac" };
    const ltv_cac_ratio = numOrNull(p.ltv_cac_ratio, 0);
    if (ltv_cac_ratio === NUM_INVALID) return { ok: false, reason: "bad_ltv_cac_ratio" };
    const payback_period_months = numOrNull(p.payback_period_months, 0);
    if (payback_period_months === NUM_INVALID) return { ok: false, reason: "bad_payback_period_months" };
    const avg_contract_value = numOrNull(p.avg_contract_value, 0);
    if (avg_contract_value === NUM_INVALID) return { ok: false, reason: "bad_avg_contract_value" };

    const gross_margin_pct = numOrNull(p.gross_margin_pct, 0, 100);
    if (gross_margin_pct === NUM_INVALID) return { ok: false, reason: "bad_gross_margin_pct" };
    const churn_rate_monthly = numOrNull(p.churn_rate_monthly, 0, 100);
    if (churn_rate_monthly === NUM_INVALID) return { ok: false, reason: "bad_churn_rate_monthly" };

    const magic_number = numOrNull(p.magic_number);
    if (magic_number === NUM_INVALID) return { ok: false, reason: "bad_magic_number" };

    const rawChannels = Array.isArray(p.by_channel) ? (p.by_channel as unknown[]).slice(0, 10) : [];
    const by_channel: { channel: string; cac: number; ltv: number; ltv_cac_ratio: number }[] = [];
    for (const c of rawChannels) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const channel = str(rec.channel);
      const chCac = typeof rec.cac === "number" && Number.isFinite(rec.cac) && rec.cac >= 0 ? rec.cac : null;
      const chLtv = typeof rec.ltv === "number" && Number.isFinite(rec.ltv) && rec.ltv >= 0 ? rec.ltv : null;
      const chRatio = typeof rec.ltv_cac_ratio === "number" && Number.isFinite(rec.ltv_cac_ratio) && rec.ltv_cac_ratio >= 0 ? rec.ltv_cac_ratio : null;
      if (channel && chCac !== null && chLtv !== null && chRatio !== null) {
        by_channel.push({ channel, cac: chCac, ltv: chLtv, ltv_cac_ratio: chRatio });
      }
    }

    const data_period = str(p.data_period);
    if (!data_period) return { ok: false, reason: "bad_data_period" };

    return {
      ok: true,
      kind: "analyze_unit_economics",
      payload: { ltv, cac, ltv_cac_ratio, payback_period_months, avg_contract_value, gross_margin_pct, churn_rate_monthly, magic_number, by_channel, data_period },
    };
  }

  if (kind === "estimate_valuation") {
    const arr = numOrNull(p.arr, 0);
    if (arr === NUM_INVALID) return { ok: false, reason: "bad_arr" };
    const arr_multiple = numOrNull(p.arr_multiple, 0);
    if (arr_multiple === NUM_INVALID) return { ok: false, reason: "bad_arr_multiple" };
    const ev_ebitda_multiple = numOrNull(p.ev_ebitda_multiple);
    if (ev_ebitda_multiple === NUM_INVALID) return { ok: false, reason: "bad_ev_ebitda_multiple" };
    const dcf_value = numOrNull(p.dcf_value, 0);
    if (dcf_value === NUM_INVALID) return { ok: false, reason: "bad_dcf_value" };
    const comparable_low = numOrNull(p.comparable_low, 0);
    if (comparable_low === NUM_INVALID) return { ok: false, reason: "bad_comparable_low" };
    const comparable_high = numOrNull(p.comparable_high, 0);
    if (comparable_high === NUM_INVALID) return { ok: false, reason: "bad_comparable_high" };
    const estimated_valuation_low = numOrNull(p.estimated_valuation_low, 0);
    if (estimated_valuation_low === NUM_INVALID) return { ok: false, reason: "bad_estimated_valuation_low" };
    const estimated_valuation_high = numOrNull(p.estimated_valuation_high, 0);
    if (estimated_valuation_high === NUM_INVALID) return { ok: false, reason: "bad_estimated_valuation_high" };
    if (estimated_valuation_low !== null && estimated_valuation_high !== null && estimated_valuation_high < estimated_valuation_low) {
      return { ok: false, reason: "valuation_high_below_low" };
    }

    const METHODS = ["arr_multiple", "ev_ebitda", "dcf", "comparable", "blended"];
    const primary_method = typeof p.primary_method === "string" && METHODS.includes(p.primary_method) ? p.primary_method : null;
    if (primary_method === null) return { ok: false, reason: "bad_primary_method" };

    const valuation_notes = str(p.valuation_notes);
    if (!valuation_notes) return { ok: false, reason: "bad_valuation_notes" };
    const data_period = str(p.data_period);
    if (!data_period) return { ok: false, reason: "bad_data_period" };

    return {
      ok: true,
      kind: "estimate_valuation",
      payload: { arr, arr_multiple, ev_ebitda_multiple, dcf_value, comparable_low, comparable_high, estimated_valuation_low, estimated_valuation_high, primary_method, valuation_notes, data_period },
    };
  }

  if (kind === "analyze_cap_table") {
    const total_shares_outstanding = typeof p.total_shares_outstanding === "number" && Number.isInteger(p.total_shares_outstanding) && p.total_shares_outstanding >= 0 ? p.total_shares_outstanding : null;
    if (total_shares_outstanding === null) return { ok: false, reason: "bad_total_shares_outstanding" };
    const fully_diluted_shares = typeof p.fully_diluted_shares === "number" && Number.isInteger(p.fully_diluted_shares) && p.fully_diluted_shares >= 0 ? p.fully_diluted_shares : null;
    if (fully_diluted_shares === null) return { ok: false, reason: "bad_fully_diluted_shares" };
    if (fully_diluted_shares < total_shares_outstanding) return { ok: false, reason: "fully_diluted_below_outstanding" };

    const option_pool_pct = numOrNull(p.option_pool_pct, 0, 100);
    if (option_pool_pct === NUM_INVALID) return { ok: false, reason: "bad_option_pool_pct" };
    const top_holder_concentration_pct = numOrNull(p.top_holder_concentration_pct, 0, 100);
    if (top_holder_concentration_pct === NUM_INVALID) return { ok: false, reason: "bad_top_holder_concentration_pct" };
    const founder_ownership_pct = numOrNull(p.founder_ownership_pct, 0, 100);
    if (founder_ownership_pct === NUM_INVALID) return { ok: false, reason: "bad_founder_ownership_pct" };
    const investor_ownership_pct = numOrNull(p.investor_ownership_pct, 0, 100);
    if (investor_ownership_pct === NUM_INVALID) return { ok: false, reason: "bad_investor_ownership_pct" };
    const employee_pool_pct = numOrNull(p.employee_pool_pct, 0, 100);
    if (employee_pool_pct === NUM_INVALID) return { ok: false, reason: "bad_employee_pool_pct" };

    const HOLDER_TYPES = ["founder", "investor", "employee", "advisor", "other"];
    const rawHolders = Array.isArray(p.holders) ? (p.holders as unknown[]).slice(0, 50) : [];
    const holders: { name: string; shares: number; ownership_pct: number; holder_type: string }[] = [];
    for (const h of rawHolders) {
      if (typeof h !== "object" || h === null) continue;
      const rec = h as Record<string, unknown>;
      const name = str(rec.name);
      const shares = typeof rec.shares === "number" && Number.isInteger(rec.shares) && rec.shares >= 0 ? rec.shares : null;
      const ownership_pct = typeof rec.ownership_pct === "number" && Number.isFinite(rec.ownership_pct) && rec.ownership_pct >= 0 && rec.ownership_pct <= 100 ? rec.ownership_pct : null;
      const holder_type = typeof rec.holder_type === "string" && HOLDER_TYPES.includes(rec.holder_type) ? rec.holder_type : null;
      if (name && shares !== null && ownership_pct !== null && holder_type) {
        holders.push({ name, shares, ownership_pct, holder_type });
      }
    }

    const data_period = str(p.data_period);
    if (!data_period) return { ok: false, reason: "bad_data_period" };

    return {
      ok: true,
      kind: "analyze_cap_table",
      payload: { total_shares_outstanding, fully_diluted_shares, option_pool_pct, top_holder_concentration_pct, founder_ownership_pct, investor_ownership_pct, employee_pool_pct, holders, data_period },
    };
  }

  if (kind === "analyze_leases") {
    const LEASE_TYPES = ["operating", "finance", "short_term", "unclassified"];
    const rawLeases = Array.isArray(p.leases) ? (p.leases as unknown[]).slice(0, 50) : [];
    const leases: { lease_id: string; description: string; lease_type: string; commencement_date: string; expiration_date: string; monthly_payment: number; remaining_payments: number; present_value: number | null; right_of_use_asset: number | null; days_until_expiration: number | null; renewal_options: string | null }[] = [];
    for (const l of rawLeases) {
      if (typeof l !== "object" || l === null) continue;
      const rec = l as Record<string, unknown>;
      const lease_id = str(rec.lease_id);
      const description = str(rec.description);
      const lease_type = typeof rec.lease_type === "string" && LEASE_TYPES.includes(rec.lease_type) ? rec.lease_type : null;
      const commencement_date = str(rec.commencement_date);
      const expiration_date = str(rec.expiration_date);
      const monthly_payment = typeof rec.monthly_payment === "number" && Number.isFinite(rec.monthly_payment) && rec.monthly_payment >= 0 ? rec.monthly_payment : null;
      const remaining_payments = typeof rec.remaining_payments === "number" && Number.isInteger(rec.remaining_payments) && rec.remaining_payments >= 0 ? rec.remaining_payments : null;
      if (!lease_id || !description || !lease_type || !commencement_date || !expiration_date || monthly_payment === null || remaining_payments === null) continue;
      const present_value = numOrNull(rec.present_value, 0);
      const right_of_use_asset = numOrNull(rec.right_of_use_asset, 0);
      if (present_value === NUM_INVALID || right_of_use_asset === NUM_INVALID) continue;
      let days_until_expiration: number | null;
      if (rec.days_until_expiration === null || rec.days_until_expiration === undefined) {
        days_until_expiration = null;
      } else if (typeof rec.days_until_expiration === "number" && Number.isInteger(rec.days_until_expiration)) {
        days_until_expiration = rec.days_until_expiration;
      } else {
        continue;
      }
      const renewal_options = typeof rec.renewal_options === "string" && rec.renewal_options.length > 0 ? rec.renewal_options.slice(0, MAX_STR) : null;
      leases.push({ lease_id, description, lease_type, commencement_date, expiration_date, monthly_payment, remaining_payments, present_value, right_of_use_asset, days_until_expiration, renewal_options });
    }

    const total_lease_liability = typeof p.total_lease_liability === "number" && Number.isFinite(p.total_lease_liability) && p.total_lease_liability >= 0 ? p.total_lease_liability : null;
    if (total_lease_liability === null) return { ok: false, reason: "bad_total_lease_liability" };
    const total_right_of_use_asset = typeof p.total_right_of_use_asset === "number" && Number.isFinite(p.total_right_of_use_asset) && p.total_right_of_use_asset >= 0 ? p.total_right_of_use_asset : null;
    if (total_right_of_use_asset === null) return { ok: false, reason: "bad_total_right_of_use_asset" };
    const annual_lease_expense = typeof p.annual_lease_expense === "number" && Number.isFinite(p.annual_lease_expense) && p.annual_lease_expense >= 0 ? p.annual_lease_expense : null;
    if (annual_lease_expense === null) return { ok: false, reason: "bad_annual_lease_expense" };

    if (typeof p.asc_842_classification_summary !== "object" || p.asc_842_classification_summary === null || Array.isArray(p.asc_842_classification_summary)) {
      return { ok: false, reason: "bad_asc_842_classification_summary" };
    }
    const summaryRaw = p.asc_842_classification_summary as Record<string, unknown>;
    const operating_count = typeof summaryRaw.operating_count === "number" && Number.isInteger(summaryRaw.operating_count) && summaryRaw.operating_count >= 0 ? summaryRaw.operating_count : null;
    const finance_count = typeof summaryRaw.finance_count === "number" && Number.isInteger(summaryRaw.finance_count) && summaryRaw.finance_count >= 0 ? summaryRaw.finance_count : null;
    const short_term_count = typeof summaryRaw.short_term_count === "number" && Number.isInteger(summaryRaw.short_term_count) && summaryRaw.short_term_count >= 0 ? summaryRaw.short_term_count : null;
    const unclassified_count = typeof summaryRaw.unclassified_count === "number" && Number.isInteger(summaryRaw.unclassified_count) && summaryRaw.unclassified_count >= 0 ? summaryRaw.unclassified_count : null;
    if (operating_count === null || finance_count === null || short_term_count === null || unclassified_count === null) {
      return { ok: false, reason: "bad_asc_842_classification_summary" };
    }
    const asc_842_classification_summary = { operating_count, finance_count, short_term_count, unclassified_count };

    const rawExpirations = Array.isArray(p.upcoming_expirations) ? (p.upcoming_expirations as unknown[]).slice(0, 20) : [];
    const upcoming_expirations: { lease_id: string; description: string; expiration_date: string; monthly_payment: number; days_until_expiration: number }[] = [];
    for (const e of rawExpirations) {
      if (typeof e !== "object" || e === null) continue;
      const rec = e as Record<string, unknown>;
      const lease_id = str(rec.lease_id);
      const description = str(rec.description);
      const expiration_date = str(rec.expiration_date);
      const monthly_payment = typeof rec.monthly_payment === "number" && Number.isFinite(rec.monthly_payment) && rec.monthly_payment >= 0 ? rec.monthly_payment : null;
      const days_until_expiration = typeof rec.days_until_expiration === "number" && Number.isInteger(rec.days_until_expiration) ? rec.days_until_expiration : null;
      if (lease_id && description && expiration_date && monthly_payment !== null && days_until_expiration !== null) {
        upcoming_expirations.push({ lease_id, description, expiration_date, monthly_payment, days_until_expiration });
      }
    }

    const optimization_opportunities = strArray(p.optimization_opportunities, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_leases",
      payload: { leases, total_lease_liability, total_right_of_use_asset, annual_lease_expense, asc_842_classification_summary, upcoming_expirations, optimization_opportunities },
    };
  }

  if (kind === "analyze_asset_register") {
    const ASSET_CLASSES = ["land", "building", "equipment", "vehicle", "software", "intangible", "furniture", "other"];
    const DEPRECIATION_METHODS = ["straight_line", "declining_balance", "units_of_production", "none", "unknown"];
    const rawAssets = Array.isArray(p.assets) ? (p.assets as unknown[]).slice(0, 200) : [];
    const assets: { asset_id: string; description: string; asset_class: string; acquisition_date: string; acquisition_cost: number; useful_life_years: number | null; depreciation_method: string; accumulated_depreciation: number; net_book_value: number; is_fully_depreciated: boolean; age_years: number | null }[] = [];
    for (const a of rawAssets) {
      if (typeof a !== "object" || a === null) continue;
      const rec = a as Record<string, unknown>;
      const asset_id = str(rec.asset_id);
      const description = str(rec.description);
      const asset_class = typeof rec.asset_class === "string" && ASSET_CLASSES.includes(rec.asset_class) ? rec.asset_class : null;
      const acquisition_date = str(rec.acquisition_date);
      const acquisition_cost = typeof rec.acquisition_cost === "number" && Number.isFinite(rec.acquisition_cost) && rec.acquisition_cost >= 0 ? rec.acquisition_cost : null;
      const depreciation_method = typeof rec.depreciation_method === "string" && DEPRECIATION_METHODS.includes(rec.depreciation_method) ? rec.depreciation_method : null;
      const accumulated_depreciation = typeof rec.accumulated_depreciation === "number" && Number.isFinite(rec.accumulated_depreciation) && rec.accumulated_depreciation >= 0 ? rec.accumulated_depreciation : null;
      const net_book_value = typeof rec.net_book_value === "number" && Number.isFinite(rec.net_book_value) && rec.net_book_value >= 0 ? rec.net_book_value : null;
      if (!asset_id || !description || !asset_class || !acquisition_date || acquisition_cost === null || !depreciation_method || accumulated_depreciation === null || net_book_value === null || typeof rec.is_fully_depreciated !== "boolean") continue;
      const useful_life_years = numOrNull(rec.useful_life_years, 0);
      const age_years = numOrNull(rec.age_years, 0);
      if (useful_life_years === NUM_INVALID || age_years === NUM_INVALID) continue;
      assets.push({ asset_id, description, asset_class, acquisition_date, acquisition_cost, useful_life_years, depreciation_method, accumulated_depreciation, net_book_value, is_fully_depreciated: rec.is_fully_depreciated, age_years });
    }

    const total_gross_value = typeof p.total_gross_value === "number" && Number.isFinite(p.total_gross_value) && p.total_gross_value >= 0 ? p.total_gross_value : null;
    if (total_gross_value === null) return { ok: false, reason: "bad_total_gross_value" };
    const total_accumulated_depreciation = typeof p.total_accumulated_depreciation === "number" && Number.isFinite(p.total_accumulated_depreciation) && p.total_accumulated_depreciation >= 0 ? p.total_accumulated_depreciation : null;
    if (total_accumulated_depreciation === null) return { ok: false, reason: "bad_total_accumulated_depreciation" };
    const total_net_book_value = typeof p.total_net_book_value === "number" && Number.isFinite(p.total_net_book_value) && p.total_net_book_value >= 0 ? p.total_net_book_value : null;
    if (total_net_book_value === null) return { ok: false, reason: "bad_total_net_book_value" };
    const assets_fully_depreciated = typeof p.assets_fully_depreciated === "number" && Number.isInteger(p.assets_fully_depreciated) && p.assets_fully_depreciated >= 0 ? p.assets_fully_depreciated : null;
    if (assets_fully_depreciated === null) return { ok: false, reason: "bad_assets_fully_depreciated" };
    const assets_near_end_of_life = typeof p.assets_near_end_of_life === "number" && Number.isInteger(p.assets_near_end_of_life) && p.assets_near_end_of_life >= 0 ? p.assets_near_end_of_life : null;
    if (assets_near_end_of_life === null) return { ok: false, reason: "bad_assets_near_end_of_life" };
    const annual_depreciation_charge = typeof p.annual_depreciation_charge === "number" && Number.isFinite(p.annual_depreciation_charge) && p.annual_depreciation_charge >= 0 ? p.annual_depreciation_charge : null;
    if (annual_depreciation_charge === null) return { ok: false, reason: "bad_annual_depreciation_charge" };

    const rawSummary = Array.isArray(p.asset_class_summary) ? (p.asset_class_summary as unknown[]).slice(0, 10) : [];
    const asset_class_summary: { asset_class: string; count: number; gross_value: number; net_book_value: number }[] = [];
    for (const s of rawSummary) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const asset_class = str(rec.asset_class);
      const count = typeof rec.count === "number" && Number.isInteger(rec.count) && rec.count >= 0 ? rec.count : null;
      const gross_value = typeof rec.gross_value === "number" && Number.isFinite(rec.gross_value) && rec.gross_value >= 0 ? rec.gross_value : null;
      const summaryNbv = typeof rec.net_book_value === "number" && Number.isFinite(rec.net_book_value) && rec.net_book_value >= 0 ? rec.net_book_value : null;
      if (asset_class && count !== null && gross_value !== null && summaryNbv !== null) {
        asset_class_summary.push({ asset_class, count, gross_value, net_book_value: summaryNbv });
      }
    }

    const replacement_needs = strArray(p.replacement_needs, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_asset_register",
      payload: { assets, total_gross_value, total_accumulated_depreciation, total_net_book_value, assets_fully_depreciated, assets_near_end_of_life, annual_depreciation_charge, asset_class_summary, replacement_needs },
    };
  }

  if (kind === "analyze_price_volume_mix") {
    const total_revenue_change = typeof p.total_revenue_change === "number" && Number.isFinite(p.total_revenue_change) ? p.total_revenue_change : null;
    if (total_revenue_change === null) return { ok: false, reason: "bad_total_revenue_change" };
    const price_effect = typeof p.price_effect === "number" && Number.isFinite(p.price_effect) ? p.price_effect : null;
    if (price_effect === null) return { ok: false, reason: "bad_price_effect" };
    const volume_effect = typeof p.volume_effect === "number" && Number.isFinite(p.volume_effect) ? p.volume_effect : null;
    if (volume_effect === null) return { ok: false, reason: "bad_volume_effect" };
    const mix_effect = typeof p.mix_effect === "number" && Number.isFinite(p.mix_effect) ? p.mix_effect : null;
    if (mix_effect === null) return { ok: false, reason: "bad_mix_effect" };

    const rawBreakdown = Array.isArray(p.pvm_breakdown) ? (p.pvm_breakdown as unknown[]).slice(0, 30) : [];
    const pvm_breakdown: { segment: string; prior_price: number; current_price: number; prior_volume: number; current_volume: number; price_effect: number; volume_effect: number; mix_effect: number; total_effect: number }[] = [];
    for (const b of rawBreakdown) {
      if (typeof b !== "object" || b === null) continue;
      const rec = b as Record<string, unknown>;
      const segment = str(rec.segment);
      if (!segment) continue;
      const prior_price = typeof rec.prior_price === "number" && Number.isFinite(rec.prior_price) && rec.prior_price >= 0 ? rec.prior_price : null;
      const current_price = typeof rec.current_price === "number" && Number.isFinite(rec.current_price) && rec.current_price >= 0 ? rec.current_price : null;
      const prior_volume = typeof rec.prior_volume === "number" && Number.isFinite(rec.prior_volume) && rec.prior_volume >= 0 ? rec.prior_volume : null;
      const current_volume = typeof rec.current_volume === "number" && Number.isFinite(rec.current_volume) && rec.current_volume >= 0 ? rec.current_volume : null;
      const bPriceEffect = typeof rec.price_effect === "number" && Number.isFinite(rec.price_effect) ? rec.price_effect : null;
      const bVolumeEffect = typeof rec.volume_effect === "number" && Number.isFinite(rec.volume_effect) ? rec.volume_effect : null;
      const bMixEffect = typeof rec.mix_effect === "number" && Number.isFinite(rec.mix_effect) ? rec.mix_effect : null;
      const total_effect = typeof rec.total_effect === "number" && Number.isFinite(rec.total_effect) ? rec.total_effect : null;
      if (prior_price === null || current_price === null || prior_volume === null || current_volume === null || bPriceEffect === null || bVolumeEffect === null || bMixEffect === null || total_effect === null) continue;
      pvm_breakdown.push({ segment, prior_price, current_price, prior_volume, current_volume, price_effect: bPriceEffect, volume_effect: bVolumeEffect, mix_effect: bMixEffect, total_effect });
    }

    const DRIVERS = ["price", "volume", "mix", "balanced", "insufficient_data"];
    const primary_driver = typeof p.primary_driver === "string" && DRIVERS.includes(p.primary_driver) ? p.primary_driver : null;
    if (primary_driver === null) return { ok: false, reason: "bad_primary_driver" };

    const insights = strArray(p.insights, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_price_volume_mix",
      payload: { total_revenue_change, price_effect, volume_effect, mix_effect, pvm_breakdown, primary_driver, insights },
    };
  }

  if (kind === "build_bridge_analysis") {
    const BRIDGE_TYPES = ["revenue", "ebitda", "profit", "cash", "headcount", "budget_vs_actual", "custom"];
    const bridge_type = typeof p.bridge_type === "string" && BRIDGE_TYPES.includes(p.bridge_type) ? p.bridge_type : null;
    if (bridge_type === null) return { ok: false, reason: "bad_bridge_type" };

    const opening_value = typeof p.opening_value === "number" && Number.isFinite(p.opening_value) ? p.opening_value : null;
    if (opening_value === null) return { ok: false, reason: "bad_opening_value" };
    const closing_value = typeof p.closing_value === "number" && Number.isFinite(p.closing_value) ? p.closing_value : null;
    if (closing_value === null) return { ok: false, reason: "bad_closing_value" };
    const total_change = typeof p.total_change === "number" && Number.isFinite(p.total_change) ? p.total_change : null;
    if (total_change === null) return { ok: false, reason: "bad_total_change" };

    const STEP_TYPES = ["positive", "negative", "subtotal", "total"];
    const rawSteps = Array.isArray(p.bridge_steps) ? (p.bridge_steps as unknown[]).slice(0, 20) : [];
    const bridge_steps: { label: string; value: number; type: string; cumulative_value: number }[] = [];
    for (const s of rawSteps) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const label = str(rec.label);
      const type = typeof rec.type === "string" && STEP_TYPES.includes(rec.type) ? rec.type : null;
      const value = typeof rec.value === "number" && Number.isFinite(rec.value) ? rec.value : null;
      const cumulative_value = typeof rec.cumulative_value === "number" && Number.isFinite(rec.cumulative_value) ? rec.cumulative_value : null;
      if (!label || !type || value === null || cumulative_value === null) continue;
      bridge_steps.push({ label, value, type, cumulative_value });
    }
    if (bridge_steps.length < 2) return { ok: false, reason: "insufficient_bridge_steps" };

    const key_insights = strArray(p.key_insights, 10, MAX_STR);

    return {
      ok: true,
      kind: "build_bridge_analysis",
      payload: { bridge_type, opening_value, closing_value, total_change, bridge_steps, key_insights },
    };
  }

  if (kind === "calculate_run_rate") {
    const current_period_value = typeof p.current_period_value === "number" && Number.isFinite(p.current_period_value) ? p.current_period_value : null;
    if (current_period_value === null) return { ok: false, reason: "bad_current_period_value" };

    const METHODS = ["single_month_x12", "trailing_3m_annualized", "trailing_6m_annualized", "ttm", "weighted_average", "custom"];
    const annualization_method = typeof p.annualization_method === "string" && METHODS.includes(p.annualization_method) ? p.annualization_method : null;
    if (annualization_method === null) return { ok: false, reason: "bad_annualization_method" };

    const annualized_run_rate = typeof p.annualized_run_rate === "number" && Number.isFinite(p.annualized_run_rate) ? p.annualized_run_rate : null;
    if (annualized_run_rate === null) return { ok: false, reason: "bad_annualized_run_rate" };

    const adjusted_run_rate = numOrNull(p.adjusted_run_rate);
    if (adjusted_run_rate === NUM_INVALID) return { ok: false, reason: "bad_adjusted_run_rate" };

    const ADJ_TYPES = ["add_back", "remove"];
    const rawAdjustments = Array.isArray(p.run_rate_adjustments) ? (p.run_rate_adjustments as unknown[]).slice(0, 20) : [];
    const run_rate_adjustments: { description: string; amount: number; type: string }[] = [];
    for (const a of rawAdjustments) {
      if (typeof a !== "object" || a === null) continue;
      const rec = a as Record<string, unknown>;
      const description = str(rec.description);
      const type = typeof rec.type === "string" && ADJ_TYPES.includes(rec.type) ? rec.type : null;
      const amount = typeof rec.amount === "number" && Number.isFinite(rec.amount) ? rec.amount : null;
      if (description && type && amount !== null) {
        run_rate_adjustments.push({ description, amount, type });
      }
    }

    const months_of_data_used = typeof p.months_of_data_used === "number" && Number.isInteger(p.months_of_data_used) && p.months_of_data_used >= 1 ? p.months_of_data_used : null;
    if (months_of_data_used === null) return { ok: false, reason: "bad_months_of_data_used" };

    const CONFIDENCE = ["high", "medium", "low"];
    const confidence = typeof p.confidence === "string" && CONFIDENCE.includes(p.confidence) ? p.confidence : null;
    if (confidence === null) return { ok: false, reason: "bad_confidence" };

    const caveats = strArray(p.caveats, 10, MAX_STR);

    return {
      ok: true,
      kind: "calculate_run_rate",
      payload: { current_period_value, annualization_method, annualized_run_rate, adjusted_run_rate, run_rate_adjustments, months_of_data_used, confidence, caveats },
    };
  }

  if (kind === "analyze_spend") {
    const total_spend = typeof p.total_spend === "number" && Number.isFinite(p.total_spend) && p.total_spend >= 0 ? p.total_spend : null;
    if (total_spend === null) return { ok: false, reason: "bad_total_spend" };

    const STATUSES4 = ["increasing", "decreasing", "stable", "new", "unknown"];
    const rawCategory = Array.isArray(p.spend_by_category) ? (p.spend_by_category as unknown[]).slice(0, 30) : [];
    const spend_by_category: { category: string; amount: number; percentage_of_total: number; yoy_change: number | null; status: string }[] = [];
    for (const c of rawCategory) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const category = str(rec.category);
      const amount = typeof rec.amount === "number" && Number.isFinite(rec.amount) && rec.amount >= 0 ? rec.amount : null;
      const percentage_of_total = typeof rec.percentage_of_total === "number" && Number.isFinite(rec.percentage_of_total) && rec.percentage_of_total >= 0 && rec.percentage_of_total <= 100 ? rec.percentage_of_total : null;
      const status = typeof rec.status === "string" && STATUSES4.includes(rec.status) ? rec.status : null;
      if (!category || amount === null || percentage_of_total === null || !status) continue;
      const yoy_change = numOrNull(rec.yoy_change);
      if (yoy_change === NUM_INVALID) continue;
      spend_by_category.push({ category, amount, percentage_of_total, yoy_change, status });
    }

    const rawVendor = Array.isArray(p.spend_by_vendor) ? (p.spend_by_vendor as unknown[]).slice(0, 50) : [];
    const spend_by_vendor: { vendor_name: string; amount: number; percentage_of_total: number; transaction_count: number; category: string }[] = [];
    for (const v of rawVendor) {
      if (typeof v !== "object" || v === null) continue;
      const rec = v as Record<string, unknown>;
      const vendor_name = str(rec.vendor_name);
      const amount = typeof rec.amount === "number" && Number.isFinite(rec.amount) && rec.amount >= 0 ? rec.amount : null;
      const percentage_of_total = typeof rec.percentage_of_total === "number" && Number.isFinite(rec.percentage_of_total) && rec.percentage_of_total >= 0 && rec.percentage_of_total <= 100 ? rec.percentage_of_total : null;
      const transaction_count = typeof rec.transaction_count === "number" && Number.isInteger(rec.transaction_count) && rec.transaction_count >= 0 ? rec.transaction_count : null;
      const category = str(rec.category);
      if (!vendor_name || amount === null || percentage_of_total === null || transaction_count === null || !category) continue;
      spend_by_vendor.push({ vendor_name, amount, percentage_of_total, transaction_count, category });
    }

    const spend_trends = strArray(p.spend_trends, 10, MAX_STR);

    const EFFORTS = ["high", "medium", "low"];
    const rawOpportunities = Array.isArray(p.top_opportunities) ? (p.top_opportunities as unknown[]).slice(0, 10) : [];
    const top_opportunities: { opportunity: string; estimated_savings: number; effort: string; category: string }[] = [];
    for (const o of rawOpportunities) {
      if (typeof o !== "object" || o === null) continue;
      const rec = o as Record<string, unknown>;
      const opportunity = str(rec.opportunity);
      const estimated_savings = typeof rec.estimated_savings === "number" && Number.isFinite(rec.estimated_savings) && rec.estimated_savings >= 0 ? rec.estimated_savings : null;
      const effort = typeof rec.effort === "string" && EFFORTS.includes(rec.effort) ? rec.effort : null;
      const category = str(rec.category);
      if (!opportunity || estimated_savings === null || !effort || !category) continue;
      top_opportunities.push({ opportunity, estimated_savings, effort, category });
    }

    const potential_savings = numOrNull(p.potential_savings, 0);
    if (potential_savings === NUM_INVALID) return { ok: false, reason: "bad_potential_savings" };

    return {
      ok: true,
      kind: "analyze_spend",
      payload: { total_spend, spend_by_category, spend_by_vendor, spend_trends, top_opportunities, potential_savings },
    };
  }

  if (kind === "analyze_discounts") {
    const rawSummary = Array.isArray(p.discount_summary) ? (p.discount_summary as unknown[]).slice(0, 200) : [];
    const discount_summary: { deal_ref: string; customer: string | null; list_price: number; discounted_price: number; discount_amount: number; discount_percentage: number; discount_reason: string | null; approved_by: string | null; is_excessive: boolean }[] = [];
    for (const d of rawSummary) {
      if (typeof d !== "object" || d === null) continue;
      const rec = d as Record<string, unknown>;
      const deal_ref = str(rec.deal_ref);
      const list_price = typeof rec.list_price === "number" && Number.isFinite(rec.list_price) && rec.list_price >= 0 ? rec.list_price : null;
      const discounted_price = typeof rec.discounted_price === "number" && Number.isFinite(rec.discounted_price) && rec.discounted_price >= 0 ? rec.discounted_price : null;
      const discount_amount = typeof rec.discount_amount === "number" && Number.isFinite(rec.discount_amount) && rec.discount_amount >= 0 ? rec.discount_amount : null;
      const discount_percentage = typeof rec.discount_percentage === "number" && Number.isFinite(rec.discount_percentage) && rec.discount_percentage >= 0 && rec.discount_percentage <= 100 ? rec.discount_percentage : null;
      if (!deal_ref || list_price === null || discounted_price === null || discount_amount === null || discount_percentage === null || typeof rec.is_excessive !== "boolean") continue;
      const customer = typeof rec.customer === "string" && rec.customer.length > 0 ? rec.customer.slice(0, MAX_STR) : null;
      const discount_reason = typeof rec.discount_reason === "string" && rec.discount_reason.length > 0 ? rec.discount_reason.slice(0, MAX_STR) : null;
      const approved_by = typeof rec.approved_by === "string" && rec.approved_by.length > 0 ? rec.approved_by.slice(0, MAX_STR) : null;
      discount_summary.push({ deal_ref, customer, list_price, discounted_price, discount_amount, discount_percentage, discount_reason, approved_by, is_excessive: rec.is_excessive });
    }

    const total_list_price = typeof p.total_list_price === "number" && Number.isFinite(p.total_list_price) && p.total_list_price >= 0 ? p.total_list_price : null;
    if (total_list_price === null) return { ok: false, reason: "bad_total_list_price" };
    const total_discounted_price = typeof p.total_discounted_price === "number" && Number.isFinite(p.total_discounted_price) && p.total_discounted_price >= 0 ? p.total_discounted_price : null;
    if (total_discounted_price === null) return { ok: false, reason: "bad_total_discounted_price" };
    const total_discount_amount = typeof p.total_discount_amount === "number" && Number.isFinite(p.total_discount_amount) && p.total_discount_amount >= 0 ? p.total_discount_amount : null;
    if (total_discount_amount === null) return { ok: false, reason: "bad_total_discount_amount" };
    const average_discount_percentage = typeof p.average_discount_percentage === "number" && Number.isFinite(p.average_discount_percentage) && p.average_discount_percentage >= 0 && p.average_discount_percentage <= 100 ? p.average_discount_percentage : null;
    if (average_discount_percentage === null) return { ok: false, reason: "bad_average_discount_percentage" };

    const rawSegment = Array.isArray(p.discount_by_segment) ? (p.discount_by_segment as unknown[]).slice(0, 20) : [];
    const discount_by_segment: { segment: string; avg_discount: number; deal_count: number }[] = [];
    for (const s of rawSegment) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const segment = str(rec.segment);
      const avg_discount = typeof rec.avg_discount === "number" && Number.isFinite(rec.avg_discount) && rec.avg_discount >= 0 && rec.avg_discount <= 100 ? rec.avg_discount : null;
      const deal_count = typeof rec.deal_count === "number" && Number.isInteger(rec.deal_count) && rec.deal_count >= 0 ? rec.deal_count : null;
      if (segment && avg_discount !== null && deal_count !== null) {
        discount_by_segment.push({ segment, avg_discount, deal_count });
      }
    }

    const excessive_discounts = strArray(p.excessive_discounts, 20, MAX_STR);

    const revenue_leakage = typeof p.revenue_leakage === "number" && Number.isFinite(p.revenue_leakage) && p.revenue_leakage >= 0 ? p.revenue_leakage : null;
    if (revenue_leakage === null) return { ok: false, reason: "bad_revenue_leakage" };

    const recommendations = strArray(p.recommendations, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_discounts",
      payload: { discount_summary, total_list_price, total_discounted_price, total_discount_amount, average_discount_percentage, discount_by_segment, excessive_discounts, revenue_leakage, recommendations },
    };
  }

  if (kind === "detect_maverick_spend") {
    const MAVERICK_REASONS = ["unapproved_vendor", "bypassed_procurement", "no_purchase_order", "off_contract", "split_to_avoid_approval", "wrong_approver", "other"];
    const SEVERITIES2 = ["critical", "high", "medium", "low"];
    const rawTransactions = Array.isArray(p.maverick_transactions) ? (p.maverick_transactions as unknown[]).slice(0, 200) : [];
    const maverick_transactions: { transaction_ref: string; vendor: string; amount: number; category: string; date: string; maverick_reason: string; severity: string }[] = [];
    for (const t of rawTransactions) {
      if (typeof t !== "object" || t === null) continue;
      const rec = t as Record<string, unknown>;
      const transaction_ref = str(rec.transaction_ref);
      const vendor = str(rec.vendor);
      const amount = typeof rec.amount === "number" && Number.isFinite(rec.amount) && rec.amount >= 0 ? rec.amount : null;
      const category = str(rec.category);
      const date = str(rec.date);
      const maverick_reason = typeof rec.maverick_reason === "string" && MAVERICK_REASONS.includes(rec.maverick_reason) ? rec.maverick_reason : null;
      const severity = typeof rec.severity === "string" && SEVERITIES2.includes(rec.severity) ? rec.severity : null;
      if (!transaction_ref || !vendor || amount === null || !category || !date || !maverick_reason || !severity) continue;
      maverick_transactions.push({ transaction_ref, vendor, amount, category, date, maverick_reason, severity });
    }

    const total_maverick_amount = typeof p.total_maverick_amount === "number" && Number.isFinite(p.total_maverick_amount) && p.total_maverick_amount >= 0 ? p.total_maverick_amount : null;
    if (total_maverick_amount === null) return { ok: false, reason: "bad_total_maverick_amount" };
    const maverick_percentage = typeof p.maverick_percentage === "number" && Number.isFinite(p.maverick_percentage) && p.maverick_percentage >= 0 && p.maverick_percentage <= 100 ? p.maverick_percentage : null;
    if (maverick_percentage === null) return { ok: false, reason: "bad_maverick_percentage" };
    const total_spend_analyzed = typeof p.total_spend_analyzed === "number" && Number.isFinite(p.total_spend_analyzed) && p.total_spend_analyzed >= 0 ? p.total_spend_analyzed : null;
    if (total_spend_analyzed === null) return { ok: false, reason: "bad_total_spend_analyzed" };

    const rawCategories = Array.isArray(p.categories_affected) ? (p.categories_affected as unknown[]).slice(0, 20) : [];
    const categories_affected: { category: string; maverick_amount: number; transaction_count: number }[] = [];
    for (const c of rawCategories) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const category = str(rec.category);
      const maverick_amount = typeof rec.maverick_amount === "number" && Number.isFinite(rec.maverick_amount) && rec.maverick_amount >= 0 ? rec.maverick_amount : null;
      const transaction_count = typeof rec.transaction_count === "number" && Number.isInteger(rec.transaction_count) && rec.transaction_count >= 0 ? rec.transaction_count : null;
      if (category && maverick_amount !== null && transaction_count !== null) {
        categories_affected.push({ category, maverick_amount, transaction_count });
      }
    }

    const root_causes = strArray(p.root_causes, 10, MAX_STR);
    const recommendations2 = strArray(p.recommendations, 10, MAX_STR);

    return {
      ok: true,
      kind: "detect_maverick_spend",
      payload: { maverick_transactions, total_maverick_amount, maverick_percentage, total_spend_analyzed, categories_affected, root_causes, recommendations: recommendations2 },
    };
  }

  if (kind === "prioritize_collections") {
    const PRIORITIES = ["P1", "P2", "P3"];
    const ACTIONS2 = ["immediate_call", "demand_letter", "payment_plan", "collections_agency", "write_off_candidate", "follow_up"];
    const COLLECTIBILITY = ["high", "medium", "low", "unknown"];
    const rawAccounts = Array.isArray(p.accounts) ? (p.accounts as unknown[]).slice(0, 200) : [];
    const accounts: { account_ref: string; customer_name: string | null; outstanding_amount: number; days_overdue: number; invoice_count: number; priority: string; recommended_action: string; collectibility: string }[] = [];
    for (const a of rawAccounts) {
      if (typeof a !== "object" || a === null) continue;
      const rec = a as Record<string, unknown>;
      const account_ref = str(rec.account_ref);
      const outstanding_amount = typeof rec.outstanding_amount === "number" && Number.isFinite(rec.outstanding_amount) && rec.outstanding_amount >= 0 ? rec.outstanding_amount : null;
      const days_overdue = typeof rec.days_overdue === "number" && Number.isInteger(rec.days_overdue) && rec.days_overdue >= 0 ? rec.days_overdue : null;
      const invoice_count = typeof rec.invoice_count === "number" && Number.isInteger(rec.invoice_count) && rec.invoice_count >= 0 ? rec.invoice_count : null;
      const priority = typeof rec.priority === "string" && PRIORITIES.includes(rec.priority) ? rec.priority : null;
      const recommended_action = typeof rec.recommended_action === "string" && ACTIONS2.includes(rec.recommended_action) ? rec.recommended_action : null;
      const collectibility = typeof rec.collectibility === "string" && COLLECTIBILITY.includes(rec.collectibility) ? rec.collectibility : null;
      if (!account_ref || outstanding_amount === null || days_overdue === null || invoice_count === null || !priority || !recommended_action || !collectibility) continue;
      const customer_name = typeof rec.customer_name === "string" && rec.customer_name.length > 0 ? rec.customer_name.slice(0, MAX_STR) : null;
      accounts.push({ account_ref, customer_name, outstanding_amount, days_overdue, invoice_count, priority, recommended_action, collectibility });
    }

    const total_outstanding = typeof p.total_outstanding === "number" && Number.isFinite(p.total_outstanding) && p.total_outstanding >= 0 ? p.total_outstanding : null;
    if (total_outstanding === null) return { ok: false, reason: "bad_total_outstanding" };
    const total_overdue = typeof p.total_overdue === "number" && Number.isFinite(p.total_overdue) && p.total_overdue >= 0 ? p.total_overdue : null;
    if (total_overdue === null) return { ok: false, reason: "bad_total_overdue" };
    const priority_1_amount = typeof p.priority_1_amount === "number" && Number.isFinite(p.priority_1_amount) && p.priority_1_amount >= 0 ? p.priority_1_amount : null;
    if (priority_1_amount === null) return { ok: false, reason: "bad_priority_1_amount" };
    const priority_2_amount = typeof p.priority_2_amount === "number" && Number.isFinite(p.priority_2_amount) && p.priority_2_amount >= 0 ? p.priority_2_amount : null;
    if (priority_2_amount === null) return { ok: false, reason: "bad_priority_2_amount" };
    const priority_3_amount = typeof p.priority_3_amount === "number" && Number.isFinite(p.priority_3_amount) && p.priority_3_amount >= 0 ? p.priority_3_amount : null;
    if (priority_3_amount === null) return { ok: false, reason: "bad_priority_3_amount" };

    const collection_actions = strArray(p.collection_actions, 10, MAX_STR);

    const estimated_collectible = numOrNull(p.estimated_collectible, 0);
    if (estimated_collectible === NUM_INVALID) return { ok: false, reason: "bad_estimated_collectible" };

    return {
      ok: true,
      kind: "prioritize_collections",
      payload: { accounts, total_outstanding, total_overdue, priority_1_amount, priority_2_amount, priority_3_amount, collection_actions, estimated_collectible },
    };
  }

  if (kind === "calculate_bad_debt_provision") {
    const total_receivables = typeof p.total_receivables === "number" && Number.isFinite(p.total_receivables) && p.total_receivables >= 0 ? p.total_receivables : null;
    if (total_receivables === null) return { ok: false, reason: "bad_total_receivables" };

    const current_provision = numOrNull(p.current_provision, 0);
    if (current_provision === NUM_INVALID) return { ok: false, reason: "bad_current_provision" };

    const recommended_provision = typeof p.recommended_provision === "number" && Number.isFinite(p.recommended_provision) && p.recommended_provision >= 0 ? p.recommended_provision : null;
    if (recommended_provision === null) return { ok: false, reason: "bad_recommended_provision" };

    const METHODOLOGIES = ["aging_schedule", "percentage_of_sales", "specific_identification", "combined", "historical_loss_rate"];
    const provision_methodology = typeof p.provision_methodology === "string" && METHODOLOGIES.includes(p.provision_methodology) ? p.provision_methodology : null;
    if (provision_methodology === null) return { ok: false, reason: "bad_provision_methodology" };

    const BUCKETS = ["current", "1_30", "31_60", "61_90", "91_120", "120_plus"];
    const rawAging = Array.isArray(p.aging_analysis) ? (p.aging_analysis as unknown[]).slice(0, 10) : [];
    const aging_analysis: { bucket: string; amount: number; provision_rate: number; provision_amount: number }[] = [];
    for (const a of rawAging) {
      if (typeof a !== "object" || a === null) continue;
      const rec = a as Record<string, unknown>;
      const bucket = typeof rec.bucket === "string" && BUCKETS.includes(rec.bucket) ? rec.bucket : null;
      const amount = typeof rec.amount === "number" && Number.isFinite(rec.amount) && rec.amount >= 0 ? rec.amount : null;
      const provision_rate = typeof rec.provision_rate === "number" && Number.isFinite(rec.provision_rate) && rec.provision_rate >= 0 && rec.provision_rate <= 100 ? rec.provision_rate : null;
      const provision_amount = typeof rec.provision_amount === "number" && Number.isFinite(rec.provision_amount) && rec.provision_amount >= 0 ? rec.provision_amount : null;
      if (bucket && amount !== null && provision_rate !== null && provision_amount !== null) {
        aging_analysis.push({ bucket, amount, provision_rate, provision_amount });
      }
    }

    const rawSpecific = Array.isArray(p.specific_provisions) ? (p.specific_provisions as unknown[]).slice(0, 20) : [];
    const specific_provisions: { account_ref: string; receivable_amount: number; provision_amount: number; reason: string }[] = [];
    for (const s of rawSpecific) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const account_ref = str(rec.account_ref);
      const receivable_amount = typeof rec.receivable_amount === "number" && Number.isFinite(rec.receivable_amount) && rec.receivable_amount >= 0 ? rec.receivable_amount : null;
      const provision_amount = typeof rec.provision_amount === "number" && Number.isFinite(rec.provision_amount) && rec.provision_amount >= 0 ? rec.provision_amount : null;
      const reason = str(rec.reason) ?? "";
      if (account_ref && receivable_amount !== null && provision_amount !== null) {
        specific_provisions.push({ account_ref, receivable_amount, provision_amount, reason });
      }
    }

    const provision_adjustment = typeof p.provision_adjustment === "number" && Number.isFinite(p.provision_adjustment) ? p.provision_adjustment : null;
    if (provision_adjustment === null) return { ok: false, reason: "bad_provision_adjustment" };

    const notes = str(p.notes);
    if (!notes) return { ok: false, reason: "bad_notes" };

    return {
      ok: true,
      kind: "calculate_bad_debt_provision",
      payload: { total_receivables, current_provision, recommended_provision, provision_methodology, aging_analysis, specific_provisions, provision_adjustment, notes },
    };
  }

  if (kind === "score_credit_risk") {
    const RISK_GRADES = ["AAA", "AA", "A", "BBB", "BB", "B", "CCC", "D"];
    const rawCustomers = Array.isArray(p.customers) ? (p.customers as unknown[]).slice(0, 100) : [];
    const customers: { customer_ref: string; credit_score: number; risk_grade: string; payment_history_score: number | null; financial_strength_score: number | null; relationship_score: number | null; current_exposure: number; recommended_credit_limit: number | null; key_risk_factors: string[] }[] = [];
    for (const c of rawCustomers) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const customer_ref = str(rec.customer_ref);
      const credit_score = typeof rec.credit_score === "number" && Number.isInteger(rec.credit_score) && rec.credit_score >= 0 && rec.credit_score <= 100 ? rec.credit_score : null;
      const risk_grade = typeof rec.risk_grade === "string" && RISK_GRADES.includes(rec.risk_grade) ? rec.risk_grade : null;
      const current_exposure = typeof rec.current_exposure === "number" && Number.isFinite(rec.current_exposure) && rec.current_exposure >= 0 ? rec.current_exposure : null;
      if (!customer_ref || credit_score === null || !risk_grade || current_exposure === null) continue;
      const payment_history_score = typeof rec.payment_history_score === "number" && Number.isInteger(rec.payment_history_score) && rec.payment_history_score >= 0 && rec.payment_history_score <= 100 ? rec.payment_history_score : (rec.payment_history_score === null || rec.payment_history_score === undefined ? null : undefined);
      const financial_strength_score = typeof rec.financial_strength_score === "number" && Number.isInteger(rec.financial_strength_score) && rec.financial_strength_score >= 0 && rec.financial_strength_score <= 100 ? rec.financial_strength_score : (rec.financial_strength_score === null || rec.financial_strength_score === undefined ? null : undefined);
      const relationship_score = typeof rec.relationship_score === "number" && Number.isInteger(rec.relationship_score) && rec.relationship_score >= 0 && rec.relationship_score <= 100 ? rec.relationship_score : (rec.relationship_score === null || rec.relationship_score === undefined ? null : undefined);
      if (payment_history_score === undefined || financial_strength_score === undefined || relationship_score === undefined) continue;
      const recommended_credit_limit = numOrNull(rec.recommended_credit_limit, 0);
      if (recommended_credit_limit === NUM_INVALID) continue;
      const key_risk_factors = strArray(rec.key_risk_factors, 5, MAX_STR);
      customers.push({ customer_ref, credit_score, risk_grade, payment_history_score, financial_strength_score, relationship_score, current_exposure, recommended_credit_limit, key_risk_factors });
    }

    if (typeof p.portfolio_summary !== "object" || p.portfolio_summary === null || Array.isArray(p.portfolio_summary)) {
      return { ok: false, reason: "bad_portfolio_summary" };
    }
    const psRaw = p.portfolio_summary as Record<string, unknown>;
    const total_customers = typeof psRaw.total_customers === "number" && Number.isInteger(psRaw.total_customers) && psRaw.total_customers >= 0 ? psRaw.total_customers : null;
    const avg_credit_score = typeof psRaw.avg_credit_score === "number" && Number.isFinite(psRaw.avg_credit_score) && psRaw.avg_credit_score >= 0 && psRaw.avg_credit_score <= 100 ? psRaw.avg_credit_score : null;
    const high_risk_count = typeof psRaw.high_risk_count === "number" && Number.isInteger(psRaw.high_risk_count) && psRaw.high_risk_count >= 0 ? psRaw.high_risk_count : null;
    const medium_risk_count = typeof psRaw.medium_risk_count === "number" && Number.isInteger(psRaw.medium_risk_count) && psRaw.medium_risk_count >= 0 ? psRaw.medium_risk_count : null;
    const low_risk_count = typeof psRaw.low_risk_count === "number" && Number.isInteger(psRaw.low_risk_count) && psRaw.low_risk_count >= 0 ? psRaw.low_risk_count : null;
    const total_exposure = typeof psRaw.total_exposure === "number" && Number.isFinite(psRaw.total_exposure) && psRaw.total_exposure >= 0 ? psRaw.total_exposure : null;
    if (total_customers === null || avg_credit_score === null || high_risk_count === null || medium_risk_count === null || low_risk_count === null || total_exposure === null) {
      return { ok: false, reason: "bad_portfolio_summary" };
    }
    const portfolio_summary = { total_customers, avg_credit_score, high_risk_count, medium_risk_count, low_risk_count, total_exposure };

    const high_risk_exposure = typeof p.high_risk_exposure === "number" && Number.isFinite(p.high_risk_exposure) && p.high_risk_exposure >= 0 ? p.high_risk_exposure : null;
    if (high_risk_exposure === null) return { ok: false, reason: "bad_high_risk_exposure" };

    const recommended_credit_limits = strArray(p.recommended_credit_limits, 10, MAX_STR);

    return {
      ok: true,
      kind: "score_credit_risk",
      payload: { customers, portfolio_summary, high_risk_exposure, recommended_credit_limits },
    };
  }

  if (kind === "analyze_fx_exposure") {
    const functional_currency = str(p.functional_currency);
    if (!functional_currency) return { ok: false, reason: "bad_functional_currency" };

    const EXPOSURE_TYPES = ["transaction", "translation", "economic"];
    const DIRECTIONS = ["long", "short"];
    const RISK_LEVELS2 = ["critical", "high", "medium", "low"];
    const rawExposures = Array.isArray(p.exposures) ? (p.exposures as unknown[]).slice(0, 30) : [];
    const exposures: { currency: string; exposure_type: string; gross_amount: number; usd_equivalent: number; exposure_direction: string; risk_level: string }[] = [];
    for (const e of rawExposures) {
      if (typeof e !== "object" || e === null) continue;
      const rec = e as Record<string, unknown>;
      const currency = str(rec.currency);
      const exposure_type = typeof rec.exposure_type === "string" && EXPOSURE_TYPES.includes(rec.exposure_type) ? rec.exposure_type : null;
      const gross_amount = typeof rec.gross_amount === "number" && Number.isFinite(rec.gross_amount) ? rec.gross_amount : null;
      const usd_equivalent = typeof rec.usd_equivalent === "number" && Number.isFinite(rec.usd_equivalent) ? rec.usd_equivalent : null;
      const exposure_direction = typeof rec.exposure_direction === "string" && DIRECTIONS.includes(rec.exposure_direction) ? rec.exposure_direction : null;
      const risk_level = typeof rec.risk_level === "string" && RISK_LEVELS2.includes(rec.risk_level) ? rec.risk_level : null;
      if (!currency || !exposure_type || gross_amount === null || usd_equivalent === null || !exposure_direction || !risk_level) continue;
      exposures.push({ currency, exposure_type, gross_amount, usd_equivalent, exposure_direction, risk_level });
    }

    const total_transaction_exposure = typeof p.total_transaction_exposure === "number" && Number.isFinite(p.total_transaction_exposure) && p.total_transaction_exposure >= 0 ? p.total_transaction_exposure : null;
    if (total_transaction_exposure === null) return { ok: false, reason: "bad_total_transaction_exposure" };
    const total_translation_exposure = typeof p.total_translation_exposure === "number" && Number.isFinite(p.total_translation_exposure) && p.total_translation_exposure >= 0 ? p.total_translation_exposure : null;
    if (total_translation_exposure === null) return { ok: false, reason: "bad_total_translation_exposure" };
    const net_exposure_usd_equivalent = typeof p.net_exposure_usd_equivalent === "number" && Number.isFinite(p.net_exposure_usd_equivalent) ? p.net_exposure_usd_equivalent : null;
    if (net_exposure_usd_equivalent === null) return { ok: false, reason: "bad_net_exposure_usd_equivalent" };

    const rawSensitivity = Array.isArray(p.sensitivity_analysis) ? (p.sensitivity_analysis as unknown[]).slice(0, 10) : [];
    const sensitivity_analysis: { scenario: string; fx_move_percentage: number; p_and_l_impact_usd: number }[] = [];
    for (const s of rawSensitivity) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const scenario = str(rec.scenario);
      const fx_move_percentage = typeof rec.fx_move_percentage === "number" && Number.isFinite(rec.fx_move_percentage) ? rec.fx_move_percentage : null;
      const p_and_l_impact_usd = typeof rec.p_and_l_impact_usd === "number" && Number.isFinite(rec.p_and_l_impact_usd) ? rec.p_and_l_impact_usd : null;
      if (scenario && fx_move_percentage !== null && p_and_l_impact_usd !== null) {
        sensitivity_analysis.push({ scenario, fx_move_percentage, p_and_l_impact_usd });
      }
    }

    const hedging_recommendations = strArray(p.hedging_recommendations, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_fx_exposure",
      payload: { functional_currency, exposures, total_transaction_exposure, total_translation_exposure, net_exposure_usd_equivalent, sensitivity_analysis, hedging_recommendations },
    };
  }

  if (kind === "draft_investor_memo") {
    const memo_title = typeof p.memo_title === "string" && p.memo_title.length > 0 ? p.memo_title.slice(0, 200) : null;
    if (!memo_title) return { ok: false, reason: "bad_memo_title" };
    const business_overview = typeof p.business_overview === "string" && p.business_overview.length > 0 ? p.business_overview.slice(0, 2000) : null;
    if (!business_overview) return { ok: false, reason: "bad_business_overview" };

    const rawHighlights = Array.isArray(p.financial_highlights) ? (p.financial_highlights as unknown[]).slice(0, 15) : [];
    const financial_highlights: { metric: string; value: string; context: string }[] = [];
    for (const h of rawHighlights) {
      if (typeof h !== "object" || h === null) continue;
      const rec = h as Record<string, unknown>;
      const metric = str(rec.metric);
      if (!metric) continue;
      const value = str(rec.value) ?? "";
      const context = str(rec.context) ?? "";
      financial_highlights.push({ metric, value, context });
    }

    const TRENDS = ["up", "down", "flat", "unknown"];
    const rawKeyMetrics = Array.isArray(p.key_metrics) ? (p.key_metrics as unknown[]).slice(0, 10) : [];
    const key_metrics: { name: string; value: string; trend: string }[] = [];
    for (const m of rawKeyMetrics) {
      if (typeof m !== "object" || m === null) continue;
      const rec = m as Record<string, unknown>;
      const trend = typeof rec.trend === "string" && TRENDS.includes(rec.trend) ? rec.trend : null;
      if (!trend) continue;
      const name = str(rec.name) ?? "";
      const value = str(rec.value) ?? "";
      key_metrics.push({ name, value, trend });
    }

    const rawRisks = Array.isArray(p.risks_and_mitigations) ? (p.risks_and_mitigations as unknown[]).slice(0, 10) : [];
    const risks_and_mitigations: { risk: string; mitigation: string }[] = [];
    for (const r of rawRisks) {
      if (typeof r !== "object" || r === null) continue;
      const rec = r as Record<string, unknown>;
      const risk = str(rec.risk);
      if (!risk) continue;
      const mitigation = str(rec.mitigation) ?? "";
      risks_and_mitigations.push({ risk, mitigation });
    }

    const investment_thesis = typeof p.investment_thesis === "string" && p.investment_thesis.length > 0 ? p.investment_thesis.slice(0, 1500) : null;
    if (!investment_thesis) return { ok: false, reason: "bad_investment_thesis" };
    const ask = typeof p.ask === "string" && p.ask.length > 0 ? p.ask.slice(0, 500) : null;
    if (!ask) return { ok: false, reason: "bad_ask" };

    const rawUseOfProceeds = Array.isArray(p.use_of_proceeds) ? (p.use_of_proceeds as unknown[]).slice(0, 10) : [];
    const use_of_proceeds: { category: string; percentage: number; description: string }[] = [];
    for (const u of rawUseOfProceeds) {
      if (typeof u !== "object" || u === null) continue;
      const rec = u as Record<string, unknown>;
      const percentage = typeof rec.percentage === "number" && Number.isFinite(rec.percentage) && rec.percentage >= 0 && rec.percentage <= 100 ? rec.percentage : null;
      if (percentage === null) continue;
      const category = str(rec.category) ?? "";
      const description = str(rec.description) ?? "";
      use_of_proceeds.push({ category, percentage, description });
    }

    return {
      ok: true,
      kind: "draft_investor_memo",
      payload: { memo_title, business_overview, financial_highlights, key_metrics, risks_and_mitigations, investment_thesis, ask, use_of_proceeds },
    };
  }

  if (kind === "track_okrs") {
    const OKR_STATUSES = ["on_track", "at_risk", "off_track", "completed", "not_started"];
    const rawObjectives = Array.isArray(p.objectives) ? (p.objectives as unknown[]).slice(0, 20) : [];
    const objectives: { objective: string; owner: string | null; key_results: { kr: string; target: string; current: string; progress: number; status: string }[]; objective_status: string; objective_score: number | null }[] = [];
    for (const o of rawObjectives) {
      if (typeof o !== "object" || o === null) continue;
      const rec = o as Record<string, unknown>;
      const objective = str(rec.objective);
      const objective_status = typeof rec.objective_status === "string" && OKR_STATUSES.includes(rec.objective_status) ? rec.objective_status : null;
      if (!objective || !objective_status) continue;
      const owner = typeof rec.owner === "string" && rec.owner.length > 0 ? rec.owner.slice(0, MAX_STR) : null;
      const objective_score = numOrNull(rec.objective_score, 0, 100);
      if (objective_score === NUM_INVALID) continue;

      const rawKrs = Array.isArray(rec.key_results) ? (rec.key_results as unknown[]).slice(0, 5) : [];
      const key_results: { kr: string; target: string; current: string; progress: number; status: string }[] = [];
      for (const k of rawKrs) {
        if (typeof k !== "object" || k === null) continue;
        const krRec = k as Record<string, unknown>;
        const status = typeof krRec.status === "string" && OKR_STATUSES.includes(krRec.status) ? krRec.status : null;
        const progress = typeof krRec.progress === "number" && Number.isFinite(krRec.progress) && krRec.progress >= 0 && krRec.progress <= 100 ? krRec.progress : null;
        if (!status || progress === null) continue;
        const kr = str(krRec.kr) ?? "";
        const target = str(krRec.target) ?? "";
        const current = str(krRec.current) ?? "";
        key_results.push({ kr, target, current, progress, status });
      }

      objectives.push({ objective, owner, key_results, objective_status, objective_score });
    }

    const overall_score = numOrNull(p.overall_score, 0, 100);
    if (overall_score === NUM_INVALID) return { ok: false, reason: "bad_overall_score" };

    const on_track_count = typeof p.on_track_count === "number" && Number.isInteger(p.on_track_count) && p.on_track_count >= 0 ? p.on_track_count : null;
    if (on_track_count === null) return { ok: false, reason: "bad_on_track_count" };
    const at_risk_count = typeof p.at_risk_count === "number" && Number.isInteger(p.at_risk_count) && p.at_risk_count >= 0 ? p.at_risk_count : null;
    if (at_risk_count === null) return { ok: false, reason: "bad_at_risk_count" };
    const off_track_count = typeof p.off_track_count === "number" && Number.isInteger(p.off_track_count) && p.off_track_count >= 0 ? p.off_track_count : null;
    if (off_track_count === null) return { ok: false, reason: "bad_off_track_count" };

    const key_blockers = strArray(p.key_blockers, 10, MAX_STR);

    return {
      ok: true,
      kind: "track_okrs",
      payload: { objectives, overall_score, on_track_count, at_risk_count, off_track_count, key_blockers },
    };
  }

  if (kind === "conduct_swot") {
    const IMPACTS = ["high", "medium", "low"];
    const TIMEFRAMES = ["immediate", "near_term", "long_term"];
    const PRIORITY_TYPES = ["SO", "WO", "ST", "WT"];

    const rawStrengths = Array.isArray(p.strengths) ? (p.strengths as unknown[]).slice(0, 10) : [];
    const strengths: { point: string; evidence: string; impact: string }[] = [];
    for (const s of rawStrengths) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const impact = typeof rec.impact === "string" && IMPACTS.includes(rec.impact) ? rec.impact : null;
      if (!impact) continue;
      strengths.push({ point: str(rec.point) ?? "", evidence: str(rec.evidence) ?? "", impact });
    }

    const rawWeaknesses = Array.isArray(p.weaknesses) ? (p.weaknesses as unknown[]).slice(0, 10) : [];
    const weaknesses: { point: string; evidence: string; urgency: string }[] = [];
    for (const w of rawWeaknesses) {
      if (typeof w !== "object" || w === null) continue;
      const rec = w as Record<string, unknown>;
      const urgency = typeof rec.urgency === "string" && IMPACTS.includes(rec.urgency) ? rec.urgency : null;
      if (!urgency) continue;
      weaknesses.push({ point: str(rec.point) ?? "", evidence: str(rec.evidence) ?? "", urgency });
    }

    const rawOpportunities = Array.isArray(p.opportunities) ? (p.opportunities as unknown[]).slice(0, 10) : [];
    const opportunities: { point: string; rationale: string; timeframe: string }[] = [];
    for (const o of rawOpportunities) {
      if (typeof o !== "object" || o === null) continue;
      const rec = o as Record<string, unknown>;
      const timeframe = typeof rec.timeframe === "string" && TIMEFRAMES.includes(rec.timeframe) ? rec.timeframe : null;
      if (!timeframe) continue;
      opportunities.push({ point: str(rec.point) ?? "", rationale: str(rec.rationale) ?? "", timeframe });
    }

    const rawThreats = Array.isArray(p.threats) ? (p.threats as unknown[]).slice(0, 10) : [];
    const threats: { point: string; likelihood: string; potential_impact: string }[] = [];
    for (const t of rawThreats) {
      if (typeof t !== "object" || t === null) continue;
      const rec = t as Record<string, unknown>;
      const likelihood = typeof rec.likelihood === "string" && IMPACTS.includes(rec.likelihood) ? rec.likelihood : null;
      const potential_impact = typeof rec.potential_impact === "string" && IMPACTS.includes(rec.potential_impact) ? rec.potential_impact : null;
      if (!likelihood || !potential_impact) continue;
      threats.push({ point: str(rec.point) ?? "", likelihood, potential_impact });
    }

    const rawPriorities = Array.isArray(p.strategic_priorities) ? (p.strategic_priorities as unknown[]).slice(0, 5) : [];
    const strategic_priorities: { priority: string; type: string; rationale: string }[] = [];
    for (const sp of rawPriorities) {
      if (typeof sp !== "object" || sp === null) continue;
      const rec = sp as Record<string, unknown>;
      const type = typeof rec.type === "string" && PRIORITY_TYPES.includes(rec.type) ? rec.type : null;
      if (!type) continue;
      strategic_priorities.push({ priority: str(rec.priority) ?? "", type, rationale: str(rec.rationale) ?? "" });
    }

    const overall_assessment = typeof p.overall_assessment === "string" && p.overall_assessment.length > 0 ? p.overall_assessment.slice(0, 1000) : null;
    if (!overall_assessment) return { ok: false, reason: "bad_overall_assessment" };

    return {
      ok: true,
      kind: "conduct_swot",
      payload: { strengths, weaknesses, opportunities, threats, strategic_priorities, overall_assessment },
    };
  }

  if (kind === "build_queries") {
    const rawSchema = Array.isArray(p.detected_schema) ? (p.detected_schema as unknown[]).slice(0, 100) : [];
    const detected_schema: { table_or_sheet: string; columns: string[] }[] = [];
    for (const s of rawSchema) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const table_or_sheet = str(rec.table_or_sheet);
      if (!table_or_sheet) continue;
      const columns = strArray(rec.columns, 100, MAX_STR);
      detected_schema.push({ table_or_sheet, columns });
    }

    const QUERY_TYPES = ["aggregation", "filter", "join", "time_series", "ranking", "calculation"];
    const rawQueries = Array.isArray(p.suggested_queries) ? (p.suggested_queries as unknown[]).slice(0, 10) : [];
    const suggested_queries: { title: string; description: string; query_type: string; pseudo_sql: string; business_value: string }[] = [];
    for (const q of rawQueries) {
      if (typeof q !== "object" || q === null) continue;
      const rec = q as Record<string, unknown>;
      const query_type = typeof rec.query_type === "string" && QUERY_TYPES.includes(rec.query_type) ? rec.query_type : null;
      const pseudo_sql = typeof rec.pseudo_sql === "string" && rec.pseudo_sql.length > 0 ? rec.pseudo_sql.slice(0, 500) : null;
      if (!query_type || !pseudo_sql) continue;
      suggested_queries.push({
        title: str(rec.title) ?? "",
        description: str(rec.description) ?? "",
        query_type,
        pseudo_sql,
        business_value: str(rec.business_value) ?? "",
      });
    }
    if (suggested_queries.length < 3) return { ok: false, reason: "too_few_suggested_queries" };

    const ANSWER_TYPES = ["number", "list", "chart", "table", "boolean"];
    const rawQuestions = Array.isArray(p.natural_language_questions) ? (p.natural_language_questions as unknown[]).slice(0, 10) : [];
    const natural_language_questions: { question: string; answer_type: string }[] = [];
    for (const q of rawQuestions) {
      if (typeof q !== "object" || q === null) continue;
      const rec = q as Record<string, unknown>;
      const answer_type = typeof rec.answer_type === "string" && ANSWER_TYPES.includes(rec.answer_type) ? rec.answer_type : null;
      if (!answer_type) continue;
      natural_language_questions.push({ question: str(rec.question) ?? "", answer_type });
    }
    if (natural_language_questions.length < 3) return { ok: false, reason: "too_few_natural_language_questions" };

    return {
      ok: true,
      kind: "build_queries",
      payload: { detected_schema, suggested_queries, natural_language_questions },
    };
  }

  if (kind === "generate_esg_report") {
    const ESG_STATUSES = ["measured", "estimated", "not_measured", "not_applicable"];
    const esgMetrics = (raw: unknown): { metric_name: string; value: string | null; unit: string | null; status: string }[] => {
      const arr = Array.isArray(raw) ? (raw as unknown[]).slice(0, 20) : [];
      const out: { metric_name: string; value: string | null; unit: string | null; status: string }[] = [];
      for (const m of arr) {
        if (typeof m !== "object" || m === null) continue;
        const rec = m as Record<string, unknown>;
        const status = typeof rec.status === "string" && ESG_STATUSES.includes(rec.status) ? rec.status : null;
        if (!status) continue;
        const value = typeof rec.value === "string" && rec.value.length > 0 ? rec.value.slice(0, MAX_STR) : null;
        const unit = typeof rec.unit === "string" && rec.unit.length > 0 ? rec.unit.slice(0, MAX_STR) : null;
        out.push({ metric_name: str(rec.metric_name) ?? "", value, unit, status });
      }
      return out;
    };
    const environmental_metrics = esgMetrics(p.environmental_metrics);
    const social_metrics = esgMetrics(p.social_metrics);
    const governance_metrics = esgMetrics(p.governance_metrics);

    let esg_score: number | null = null;
    if (p.esg_score !== null && p.esg_score !== undefined) {
      if (typeof p.esg_score !== "number" || !Number.isInteger(p.esg_score) || p.esg_score < 0 || p.esg_score > 100) {
        return { ok: false, reason: "bad_esg_score" };
      }
      esg_score = p.esg_score;
    }

    const key_highlights = strArray(p.key_highlights, 10, MAX_STR);
    const gaps_and_recommendations = strArray(p.gaps_and_recommendations, 10, MAX_STR);

    const FRAMEWORKS = ["GRI", "SASB", "TCFD", "UN_SDGs", "custom", "none"];
    const reporting_framework = typeof p.reporting_framework === "string" && FRAMEWORKS.includes(p.reporting_framework) ? p.reporting_framework : null;
    if (!reporting_framework) return { ok: false, reason: "bad_reporting_framework" };

    return {
      ok: true,
      kind: "generate_esg_report",
      payload: { environmental_metrics, social_metrics, governance_metrics, esg_score, key_highlights, gaps_and_recommendations, reporting_framework },
    };
  }

  if (kind === "analyze_seasonality") {
    const metric_name = str(p.metric_name);
    if (!metric_name) return { ok: false, reason: "bad_metric_name" };

    const rawIndices = Array.isArray(p.seasonal_indices) ? (p.seasonal_indices as unknown[]).slice(0, 52) : [];
    const seasonal_indices: { period: string; index: number; raw_value: number | null }[] = [];
    for (const s of rawIndices) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const index = typeof rec.index === "number" && Number.isFinite(rec.index) && rec.index > 0 ? rec.index : null;
      if (index === null) continue;
      const raw_value = numOrNull(rec.raw_value);
      if (raw_value === NUM_INVALID) continue;
      seasonal_indices.push({ period: str(rec.period) ?? "", index, raw_value });
    }

    const parseSeason = (raw: unknown, pctKey: string): { period: string; index: number; [k: string]: unknown } | null => {
      if (typeof raw !== "object" || raw === null) return null;
      const rec = raw as Record<string, unknown>;
      const period = str(rec.period);
      const index = typeof rec.index === "number" && Number.isFinite(rec.index) && rec.index > 0 ? rec.index : null;
      const pct = typeof rec[pctKey] === "number" && Number.isFinite(rec[pctKey] as number) && (rec[pctKey] as number) >= 0 ? (rec[pctKey] as number) : null;
      if (!period || index === null || pct === null) return null;
      return { period, index, [pctKey]: pct };
    };
    const peak_season = parseSeason(p.peak_season, "percentage_above_average");
    if (!peak_season) return { ok: false, reason: "bad_peak_season" };
    const trough_season = parseSeason(p.trough_season, "percentage_below_average");
    if (!trough_season) return { ok: false, reason: "bad_trough_season" };

    const rawYoy = Array.isArray(p.year_over_year_comparison) ? (p.year_over_year_comparison as unknown[]).slice(0, 5) : [];
    const year_over_year_comparison: { year: string; total: number | null; yoy_growth: number | null }[] = [];
    for (const y of rawYoy) {
      if (typeof y !== "object" || y === null) continue;
      const rec = y as Record<string, unknown>;
      const year = str(rec.year);
      if (!year) continue;
      const total = numOrNull(rec.total);
      const yoy_growth = numOrNull(rec.yoy_growth);
      if (total === NUM_INVALID || yoy_growth === NUM_INVALID) continue;
      year_over_year_comparison.push({ year, total, yoy_growth });
    }

    const STRENGTHS = ["strong", "moderate", "weak", "none", "insufficient_data"];
    const seasonality_strength = typeof p.seasonality_strength === "string" && STRENGTHS.includes(p.seasonality_strength) ? p.seasonality_strength : null;
    if (!seasonality_strength) return { ok: false, reason: "bad_seasonality_strength" };

    const business_implications = strArray(p.business_implications, 10, MAX_STR);
    const planning_recommendations = strArray(p.planning_recommendations, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_seasonality",
      payload: { metric_name, seasonal_indices, peak_season, trough_season, year_over_year_comparison, seasonality_strength, business_implications, planning_recommendations },
    };
  }

  if (kind === "benchmark_performance") {
    const industry = typeof p.industry === "string" && p.industry.length > 0 ? p.industry.slice(0, 100) : null;
    if (!industry) return { ok: false, reason: "bad_industry" };

    const STAGES = ["pre_revenue", "early_stage", "growth", "scale", "mature"];
    const company_stage = typeof p.company_stage === "string" && STAGES.includes(p.company_stage) ? p.company_stage : null;
    if (!company_stage) return { ok: false, reason: "bad_company_stage" };

    const PERFORMANCE_LEVELS = ["top_quartile", "above_median", "at_median", "below_median", "bottom_quartile", "unknown"];
    const rawBenchmarks = Array.isArray(p.benchmarks) ? (p.benchmarks as unknown[]).slice(0, 30) : [];
    const benchmarks: { metric_name: string; company_value: number | null; peer_median: number | null; peer_top_quartile: number | null; unit: string; percentile_estimate: number | null; performance: string }[] = [];
    for (const b of rawBenchmarks) {
      if (typeof b !== "object" || b === null) continue;
      const rec = b as Record<string, unknown>;
      const performance = typeof rec.performance === "string" && PERFORMANCE_LEVELS.includes(rec.performance) ? rec.performance : null;
      if (!performance) continue;
      const company_value = numOrNull(rec.company_value);
      const peer_median = numOrNull(rec.peer_median);
      const peer_top_quartile = numOrNull(rec.peer_top_quartile);
      if (company_value === NUM_INVALID || peer_median === NUM_INVALID || peer_top_quartile === NUM_INVALID) continue;
      const percentile_estimate = numOrNull(rec.percentile_estimate, 0, 100);
      if (percentile_estimate === NUM_INVALID) continue;
      benchmarks.push({
        metric_name: str(rec.metric_name) ?? "",
        company_value,
        peer_median,
        peer_top_quartile,
        unit: str(rec.unit) ?? "",
        percentile_estimate,
        performance,
      });
    }

    const OVERALL_LEVELS = ["top_quartile", "above_median", "at_median", "below_median", "bottom_quartile", "mixed", "insufficient_data"];
    const overall_performance = typeof p.overall_performance === "string" && OVERALL_LEVELS.includes(p.overall_performance) ? p.overall_performance : null;
    if (!overall_performance) return { ok: false, reason: "bad_overall_performance" };

    const standout_strengths = strArray(p.standout_strengths, 5, MAX_STR);
    const underperforming_areas = strArray(p.underperforming_areas, 5, MAX_STR);

    const peer_comparison_notes = typeof p.peer_comparison_notes === "string" && p.peer_comparison_notes.length > 0 ? p.peer_comparison_notes.slice(0, 1000) : null;
    if (!peer_comparison_notes) return { ok: false, reason: "bad_peer_comparison_notes" };

    return {
      ok: true,
      kind: "benchmark_performance",
      payload: { industry, company_stage, benchmarks, overall_performance, standout_strengths, underperforming_areas, peer_comparison_notes },
    };
  }

  if (kind === "consolidate_entities") {
    const ENTITY_TYPES = ["subsidiary", "associate", "joint_venture", "parent"];
    const rawEntities = Array.isArray(p.entities) ? (p.entities as unknown[]).slice(0, 20) : [];
    const entities: { entity_name: string; ownership_percentage: number; entity_type: string; currency: string; revenue: number; costs: number; profit: number; intercompany_revenues: number; intercompany_costs: number }[] = [];
    for (const e of rawEntities) {
      if (typeof e !== "object" || e === null) continue;
      const rec = e as Record<string, unknown>;
      const entity_type = typeof rec.entity_type === "string" && ENTITY_TYPES.includes(rec.entity_type) ? rec.entity_type : null;
      if (!entity_type) continue;
      const ownership_percentage = numOrNull(rec.ownership_percentage, 0, 100);
      const revenue = numOrNull(rec.revenue);
      const costs = numOrNull(rec.costs);
      const profit = numOrNull(rec.profit);
      const intercompany_revenues = numOrNull(rec.intercompany_revenues, 0);
      const intercompany_costs = numOrNull(rec.intercompany_costs, 0);
      if (ownership_percentage === NUM_INVALID || ownership_percentage === null) continue;
      if (revenue === NUM_INVALID || revenue === null) continue;
      if (costs === NUM_INVALID || costs === null) continue;
      if (profit === NUM_INVALID || profit === null) continue;
      if (intercompany_revenues === NUM_INVALID || intercompany_revenues === null) continue;
      if (intercompany_costs === NUM_INVALID || intercompany_costs === null) continue;
      entities.push({
        entity_name: str(rec.entity_name) ?? "",
        ownership_percentage, entity_type,
        currency: str(rec.currency) ?? "",
        revenue, costs, profit, intercompany_revenues, intercompany_costs,
      });
    }
    if (entities.length < 2) return { ok: false, reason: "insufficient_entities" };

    const rawEliminations = Array.isArray(p.intercompany_eliminations) ? (p.intercompany_eliminations as unknown[]).slice(0, 30) : [];
    const intercompany_eliminations: { description: string; amount: number; from_entity: string; to_entity: string }[] = [];
    for (const el of rawEliminations) {
      if (typeof el !== "object" || el === null) continue;
      const rec = el as Record<string, unknown>;
      const amount = numOrNull(rec.amount);
      if (amount === NUM_INVALID || amount === null) continue;
      intercompany_eliminations.push({
        description: str(rec.description) ?? "",
        amount,
        from_entity: str(rec.from_entity) ?? "",
        to_entity: str(rec.to_entity) ?? "",
      });
    }

    const consolidated_revenue = numOrNull(p.consolidated_revenue);
    if (consolidated_revenue === NUM_INVALID || consolidated_revenue === null) return { ok: false, reason: "bad_consolidated_revenue" };
    const consolidated_costs = numOrNull(p.consolidated_costs);
    if (consolidated_costs === NUM_INVALID || consolidated_costs === null) return { ok: false, reason: "bad_consolidated_costs" };
    const consolidated_profit = numOrNull(p.consolidated_profit);
    if (consolidated_profit === NUM_INVALID || consolidated_profit === null) return { ok: false, reason: "bad_consolidated_profit" };

    const rawMinority = Array.isArray(p.minority_interests) ? (p.minority_interests as unknown[]).slice(0, 10) : [];
    const minority_interests: { entity_name: string; minority_percentage: number; minority_profit_share: number }[] = [];
    for (const m of rawMinority) {
      if (typeof m !== "object" || m === null) continue;
      const rec = m as Record<string, unknown>;
      const minority_percentage = numOrNull(rec.minority_percentage, 0, 100);
      const minority_profit_share = numOrNull(rec.minority_profit_share);
      if (minority_percentage === NUM_INVALID || minority_percentage === null) continue;
      if (minority_profit_share === NUM_INVALID || minority_profit_share === null) continue;
      minority_interests.push({ entity_name: str(rec.entity_name) ?? "", minority_percentage, minority_profit_share });
    }

    const rawFx = Array.isArray(p.fx_translation_adjustments) ? (p.fx_translation_adjustments as unknown[]).slice(0, 20) : [];
    const fx_translation_adjustments: { entity_name: string; local_currency: string; fx_rate_used: number; translation_adjustment: number }[] = [];
    for (const f of rawFx) {
      if (typeof f !== "object" || f === null) continue;
      const rec = f as Record<string, unknown>;
      const fx_rate_used = numOrNull(rec.fx_rate_used);
      if (fx_rate_used === NUM_INVALID || fx_rate_used === null || fx_rate_used <= 0) continue;
      const translation_adjustment = numOrNull(rec.translation_adjustment);
      if (translation_adjustment === NUM_INVALID || translation_adjustment === null) continue;
      fx_translation_adjustments.push({
        entity_name: str(rec.entity_name) ?? "",
        local_currency: str(rec.local_currency) ?? "",
        fx_rate_used, translation_adjustment,
      });
    }

    const consolidation_notes = typeof p.consolidation_notes === "string" && p.consolidation_notes.length > 0 ? p.consolidation_notes.slice(0, 1000) : null;
    if (!consolidation_notes) return { ok: false, reason: "bad_consolidation_notes" };

    return {
      ok: true,
      kind: "consolidate_entities",
      payload: { entities, intercompany_eliminations, consolidated_revenue, consolidated_costs, consolidated_profit, minority_interests, fx_translation_adjustments, consolidation_notes },
    };
  }

  if (kind === "analyze_ecommerce") {
    const gmv = numOrNull(p.gmv, 0);
    if (gmv === NUM_INVALID || gmv === null) return { ok: false, reason: "bad_gmv" };
    const net_revenue = numOrNull(p.net_revenue, 0);
    if (net_revenue === NUM_INVALID || net_revenue === null) return { ok: false, reason: "bad_net_revenue" };
    const take_rate = numOrNull(p.take_rate, 0, 100);
    if (take_rate === NUM_INVALID) return { ok: false, reason: "bad_take_rate" };
    const order_count = numOrNull(p.order_count, 0);
    if (order_count === NUM_INVALID || order_count === null || !Number.isInteger(order_count)) return { ok: false, reason: "bad_order_count" };
    const average_order_value = numOrNull(p.average_order_value, 0);
    if (average_order_value === NUM_INVALID) return { ok: false, reason: "bad_average_order_value" };
    const conversion_rate = numOrNull(p.conversion_rate, 0, 100);
    if (conversion_rate === NUM_INVALID) return { ok: false, reason: "bad_conversion_rate" };
    const cart_abandonment_rate = numOrNull(p.cart_abandonment_rate, 0, 100);
    if (cart_abandonment_rate === NUM_INVALID) return { ok: false, reason: "bad_cart_abandonment_rate" };

    const rawProducts = Array.isArray(p.top_products) ? (p.top_products as unknown[]).slice(0, 20) : [];
    const top_products: { product_name: string; units_sold: number; revenue: number; return_rate: number | null }[] = [];
    for (const item of rawProducts) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const units_sold = numOrNull(rec.units_sold, 0);
      const revenue = numOrNull(rec.revenue, 0);
      const return_rate = numOrNull(rec.return_rate, 0, 100);
      if (units_sold === NUM_INVALID || units_sold === null || !Number.isInteger(units_sold)) continue;
      if (revenue === NUM_INVALID || revenue === null) continue;
      if (return_rate === NUM_INVALID) continue;
      top_products.push({ product_name: str(rec.product_name) ?? "", units_sold, revenue, return_rate });
    }

    const CHANNELS = ["organic", "paid_search", "social", "email", "direct", "marketplace", "other"];
    const rawChannels = Array.isArray(p.channel_breakdown) ? (p.channel_breakdown as unknown[]).slice(0, 10) : [];
    const channel_breakdown: { channel: string; revenue: number; orders: number; percentage: number }[] = [];
    for (const c of rawChannels) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const channel = typeof rec.channel === "string" && CHANNELS.includes(rec.channel) ? rec.channel : null;
      if (!channel) continue;
      const revenue = numOrNull(rec.revenue, 0);
      const orders = numOrNull(rec.orders, 0);
      const percentage = numOrNull(rec.percentage, 0, 100);
      if (revenue === NUM_INVALID || revenue === null) continue;
      if (orders === NUM_INVALID || orders === null || !Number.isInteger(orders)) continue;
      if (percentage === NUM_INVALID || percentage === null) continue;
      channel_breakdown.push({ channel, revenue, orders, percentage });
    }

    let fulfillment_metrics: { avg_delivery_days: number | null; on_time_rate: number | null; return_rate: number | null; refund_rate: number | null } | null = null;
    if (typeof p.fulfillment_metrics === "object" && p.fulfillment_metrics !== null) {
      const rec = p.fulfillment_metrics as Record<string, unknown>;
      const avg_delivery_days = numOrNull(rec.avg_delivery_days, 0);
      const on_time_rate = numOrNull(rec.on_time_rate, 0, 100);
      const return_rate = numOrNull(rec.return_rate, 0, 100);
      const refund_rate = numOrNull(rec.refund_rate, 0, 100);
      if (avg_delivery_days !== NUM_INVALID && on_time_rate !== NUM_INVALID && return_rate !== NUM_INVALID && refund_rate !== NUM_INVALID) {
        fulfillment_metrics = { avg_delivery_days, on_time_rate, return_rate, refund_rate };
      }
    }
    if (!fulfillment_metrics) return { ok: false, reason: "bad_fulfillment_metrics" };

    const growth_insights = strArray(p.growth_insights, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_ecommerce",
      payload: { gmv, net_revenue, take_rate, order_count, average_order_value, conversion_rate, cart_abandonment_rate, top_products, channel_breakdown, fulfillment_metrics, growth_insights },
    };
  }

  if (kind === "analyze_professional_services") {
    const utilization_rate = numOrNull(p.utilization_rate, 0, 100);
    if (utilization_rate === NUM_INVALID) return { ok: false, reason: "bad_utilization_rate" };
    const billable_hours = numOrNull(p.billable_hours, 0);
    if (billable_hours === NUM_INVALID || billable_hours === null || !Number.isInteger(billable_hours)) return { ok: false, reason: "bad_billable_hours" };
    const total_hours = numOrNull(p.total_hours, 0);
    if (total_hours === NUM_INVALID || total_hours === null || !Number.isInteger(total_hours)) return { ok: false, reason: "bad_total_hours" };
    const average_bill_rate = numOrNull(p.average_bill_rate, 0);
    if (average_bill_rate === NUM_INVALID) return { ok: false, reason: "bad_average_bill_rate" };
    const revenue_per_consultant = numOrNull(p.revenue_per_consultant, 0);
    if (revenue_per_consultant === NUM_INVALID) return { ok: false, reason: "bad_revenue_per_consultant" };
    const wip_value = numOrNull(p.wip_value, 0);
    if (wip_value === NUM_INVALID) return { ok: false, reason: "bad_wip_value" };

    const STATUSES = ["on_budget", "over_budget", "under_budget", "unknown"];
    const rawProjects = Array.isArray(p.project_profitability) ? (p.project_profitability as unknown[]).slice(0, 50) : [];
    const project_profitability: { project_ref: string; client: string | null; budgeted_hours: number | null; actual_hours: number; budgeted_revenue: number | null; actual_revenue: number; margin: number | null; status: string }[] = [];
    for (const proj of rawProjects) {
      if (typeof proj !== "object" || proj === null) continue;
      const rec = proj as Record<string, unknown>;
      const status = typeof rec.status === "string" && STATUSES.includes(rec.status) ? rec.status : null;
      if (!status) continue;
      const budgeted_hours = numOrNull(rec.budgeted_hours, 0);
      const actual_hours = numOrNull(rec.actual_hours, 0);
      const budgeted_revenue = numOrNull(rec.budgeted_revenue, 0);
      const actual_revenue = numOrNull(rec.actual_revenue, 0);
      const margin = numOrNull(rec.margin);
      if (budgeted_hours === NUM_INVALID) continue;
      if (actual_hours === NUM_INVALID || actual_hours === null || !Number.isInteger(actual_hours)) continue;
      if (budgeted_revenue === NUM_INVALID) continue;
      if (actual_revenue === NUM_INVALID || actual_revenue === null) continue;
      if (margin === NUM_INVALID) continue;
      project_profitability.push({
        project_ref: str(rec.project_ref) ?? "",
        client: str(rec.client),
        budgeted_hours, actual_hours, budgeted_revenue, actual_revenue, margin, status,
      });
    }

    const rawStaff = Array.isArray(p.staff_utilization) ? (p.staff_utilization as unknown[]).slice(0, 100) : [];
    const staff_utilization: { staff_ref: string; role: string | null; billable_hours: number; total_hours: number; utilization_rate: number }[] = [];
    for (const s of rawStaff) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const sBillable = numOrNull(rec.billable_hours, 0);
      const sTotal = numOrNull(rec.total_hours, 0);
      const sUtil = numOrNull(rec.utilization_rate, 0, 100);
      if (sBillable === NUM_INVALID || sBillable === null || !Number.isInteger(sBillable)) continue;
      if (sTotal === NUM_INVALID || sTotal === null || !Number.isInteger(sTotal)) continue;
      if (sUtil === NUM_INVALID || sUtil === null) continue;
      staff_utilization.push({ staff_ref: str(rec.staff_ref) ?? "", role: str(rec.role), billable_hours: sBillable, total_hours: sTotal, utilization_rate: sUtil });
    }

    const realization_rate = numOrNull(p.realization_rate, 0, 100);
    if (realization_rate === NUM_INVALID) return { ok: false, reason: "bad_realization_rate" };

    const recommendations = strArray(p.recommendations, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_professional_services",
      payload: { utilization_rate, billable_hours, total_hours, average_bill_rate, revenue_per_consultant, wip_value, project_profitability, staff_utilization, realization_rate, recommendations },
    };
  }

  if (kind === "analyze_nonprofit_financials") {
    const SOURCES = ["individual_donations", "corporate_donations", "grants_government", "grants_private", "earned_revenue", "events", "in_kind", "endowment", "other"];
    const rawSources = Array.isArray(p.revenue_by_source) ? (p.revenue_by_source as unknown[]).slice(0, 20) : [];
    const revenue_by_source: { source: string; amount: number; percentage_of_total: number; restricted: boolean }[] = [];
    for (const s of rawSources) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const source = typeof rec.source === "string" && SOURCES.includes(rec.source) ? rec.source : null;
      if (!source) continue;
      const amount = numOrNull(rec.amount, 0);
      const percentage_of_total = numOrNull(rec.percentage_of_total, 0, 100);
      if (amount === NUM_INVALID || amount === null) continue;
      if (percentage_of_total === NUM_INVALID || percentage_of_total === null) continue;
      revenue_by_source.push({ source, amount, percentage_of_total, restricted: rec.restricted === true });
    }

    const total_revenue = numOrNull(p.total_revenue, 0);
    if (total_revenue === NUM_INVALID || total_revenue === null) return { ok: false, reason: "bad_total_revenue" };
    const program_expenses = numOrNull(p.program_expenses, 0);
    if (program_expenses === NUM_INVALID || program_expenses === null) return { ok: false, reason: "bad_program_expenses" };
    const administrative_expenses = numOrNull(p.administrative_expenses, 0);
    if (administrative_expenses === NUM_INVALID || administrative_expenses === null) return { ok: false, reason: "bad_administrative_expenses" };
    const fundraising_expenses = numOrNull(p.fundraising_expenses, 0);
    if (fundraising_expenses === NUM_INVALID || fundraising_expenses === null) return { ok: false, reason: "bad_fundraising_expenses" };
    const total_expenses = numOrNull(p.total_expenses, 0);
    if (total_expenses === NUM_INVALID || total_expenses === null) return { ok: false, reason: "bad_total_expenses" };
    const program_efficiency_ratio = numOrNull(p.program_efficiency_ratio, 0, 100);
    if (program_efficiency_ratio === NUM_INVALID) return { ok: false, reason: "bad_program_efficiency_ratio" };
    const fundraising_efficiency_ratio = numOrNull(p.fundraising_efficiency_ratio, 0, 100);
    if (fundraising_efficiency_ratio === NUM_INVALID) return { ok: false, reason: "bad_fundraising_efficiency_ratio" };
    const months_of_reserves = numOrNull(p.months_of_reserves, 0);
    if (months_of_reserves === NUM_INVALID) return { ok: false, reason: "bad_months_of_reserves" };

    let donor_metrics: { total_donors: number | null; new_donors: number | null; retained_donors: number | null; avg_donation: number | null; major_gift_threshold: number | null; major_gift_donors: number | null } | null = null;
    if (typeof p.donor_metrics === "object" && p.donor_metrics !== null) {
      const rec = p.donor_metrics as Record<string, unknown>;
      const total_donors = numOrNull(rec.total_donors, 0);
      const new_donors = numOrNull(rec.new_donors, 0);
      const retained_donors = numOrNull(rec.retained_donors, 0);
      const avg_donation = numOrNull(rec.avg_donation, 0);
      const major_gift_threshold = numOrNull(rec.major_gift_threshold, 0);
      const major_gift_donors = numOrNull(rec.major_gift_donors, 0);
      if (total_donors !== NUM_INVALID && new_donors !== NUM_INVALID && retained_donors !== NUM_INVALID && avg_donation !== NUM_INVALID && major_gift_threshold !== NUM_INVALID && major_gift_donors !== NUM_INVALID) {
        donor_metrics = { total_donors, new_donors, retained_donors, avg_donation, major_gift_threshold, major_gift_donors };
      }
    }
    if (!donor_metrics) return { ok: false, reason: "bad_donor_metrics" };

    const GRANT_STATUSES = ["submitted", "pending", "awarded", "declined", "in_progress"];
    const rawGrants = Array.isArray(p.grant_pipeline) ? (p.grant_pipeline as unknown[]).slice(0, 20) : [];
    const grant_pipeline: { grantor: string; amount_requested: number; status: string; expected_decision_date: string | null }[] = [];
    for (const g of rawGrants) {
      if (typeof g !== "object" || g === null) continue;
      const rec = g as Record<string, unknown>;
      const status = typeof rec.status === "string" && GRANT_STATUSES.includes(rec.status) ? rec.status : null;
      if (!status) continue;
      const amount_requested = numOrNull(rec.amount_requested, 0);
      if (amount_requested === NUM_INVALID || amount_requested === null) continue;
      grant_pipeline.push({ grantor: str(rec.grantor) ?? "", amount_requested, status, expected_decision_date: str(rec.expected_decision_date) });
    }

    const compliance_notes = typeof p.compliance_notes === "string" && p.compliance_notes.length > 0 ? p.compliance_notes.slice(0, 1000) : null;
    if (!compliance_notes) return { ok: false, reason: "bad_compliance_notes" };

    return {
      ok: true,
      kind: "analyze_nonprofit_financials",
      payload: { revenue_by_source, total_revenue, program_expenses, administrative_expenses, fundraising_expenses, total_expenses, program_efficiency_ratio, fundraising_efficiency_ratio, months_of_reserves, donor_metrics, grant_pipeline, compliance_notes },
    };
  }

  if (kind === "analyze_healthcare_financials") {
    const net_patient_revenue = numOrNull(p.net_patient_revenue, 0);
    if (net_patient_revenue === NUM_INVALID || net_patient_revenue === null) return { ok: false, reason: "bad_net_patient_revenue" };
    const gross_charges = numOrNull(p.gross_charges, 0);
    if (gross_charges === NUM_INVALID) return { ok: false, reason: "bad_gross_charges" };
    const contractual_adjustments = numOrNull(p.contractual_adjustments, 0);
    if (contractual_adjustments === NUM_INVALID) return { ok: false, reason: "bad_contractual_adjustments" };
    const bad_debt_expense = numOrNull(p.bad_debt_expense, 0);
    if (bad_debt_expense === NUM_INVALID) return { ok: false, reason: "bad_bad_debt_expense" };

    const PAYORS = ["medicare", "medicaid", "commercial", "self_pay", "other"];
    const rawPayorMix = Array.isArray(p.payor_mix) ? (p.payor_mix as unknown[]).slice(0, 10) : [];
    const payor_mix: { payor: string; revenue_percentage: number; reimbursement_rate: number | null }[] = [];
    for (const item of rawPayorMix) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const payor = typeof rec.payor === "string" && PAYORS.includes(rec.payor) ? rec.payor : null;
      if (!payor) continue;
      const revenue_percentage = numOrNull(rec.revenue_percentage, 0, 100);
      const reimbursement_rate = numOrNull(rec.reimbursement_rate, 0, 100);
      if (revenue_percentage === NUM_INVALID || revenue_percentage === null) continue;
      if (reimbursement_rate === NUM_INVALID) continue;
      payor_mix.push({ payor, revenue_percentage, reimbursement_rate });
    }

    const cost_per_patient_encounter = numOrNull(p.cost_per_patient_encounter, 0);
    if (cost_per_patient_encounter === NUM_INVALID) return { ok: false, reason: "bad_cost_per_patient_encounter" };
    const days_in_ar = numOrNull(p.days_in_ar, 0);
    if (days_in_ar === NUM_INVALID) return { ok: false, reason: "bad_days_in_ar" };
    const denial_rate = numOrNull(p.denial_rate, 0, 100);
    if (denial_rate === NUM_INVALID) return { ok: false, reason: "bad_denial_rate" };
    const clean_claim_rate = numOrNull(p.clean_claim_rate, 0, 100);
    if (clean_claim_rate === NUM_INVALID) return { ok: false, reason: "bad_clean_claim_rate" };

    const QUALITY_STATUSES = ["above", "at", "below", "unknown"];
    const rawQuality = Array.isArray(p.quality_metrics) ? (p.quality_metrics as unknown[]).slice(0, 15) : [];
    const quality_metrics: { metric_name: string; value: string | null; benchmark: string | null; status: string }[] = [];
    for (const q of rawQuality) {
      if (typeof q !== "object" || q === null) continue;
      const rec = q as Record<string, unknown>;
      const status = typeof rec.status === "string" && QUALITY_STATUSES.includes(rec.status) ? rec.status : null;
      if (!status) continue;
      quality_metrics.push({ metric_name: str(rec.metric_name) ?? "", value: str(rec.value), benchmark: str(rec.benchmark), status });
    }

    const revenue_cycle_insights = strArray(p.revenue_cycle_insights, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_healthcare_financials",
      payload: { net_patient_revenue, gross_charges, contractual_adjustments, bad_debt_expense, payor_mix, cost_per_patient_encounter, days_in_ar, denial_rate, clean_claim_rate, quality_metrics, revenue_cycle_insights },
    };
  }

  if (kind === "analyze_legal_billing") {
    const MATTER_STATUSES = ["open", "closed", "on_hold"];
    const rawMatters = Array.isArray(p.matters) ? (p.matters as unknown[]).slice(0, 100) : [];
    const matters: { matter_ref: string; client: string | null; matter_type: string; hours_billed: number; amount_billed: number; amount_collected: number; wip_unbilled: number; rate_per_hour: number | null; status: string }[] = [];
    for (const m of rawMatters) {
      if (typeof m !== "object" || m === null) continue;
      const rec = m as Record<string, unknown>;
      const status = typeof rec.status === "string" && MATTER_STATUSES.includes(rec.status) ? rec.status : null;
      if (!status) continue;
      const hours_billed = numOrNull(rec.hours_billed, 0);
      const amount_billed = numOrNull(rec.amount_billed, 0);
      const amount_collected = numOrNull(rec.amount_collected, 0);
      const wip_unbilled = numOrNull(rec.wip_unbilled, 0);
      const rate_per_hour = numOrNull(rec.rate_per_hour, 0);
      if (hours_billed === NUM_INVALID || hours_billed === null) continue;
      if (amount_billed === NUM_INVALID || amount_billed === null) continue;
      if (amount_collected === NUM_INVALID || amount_collected === null) continue;
      if (wip_unbilled === NUM_INVALID || wip_unbilled === null) continue;
      if (rate_per_hour === NUM_INVALID) continue;
      matters.push({
        matter_ref: str(rec.matter_ref) ?? "", client: str(rec.client),
        matter_type: str(rec.matter_type) ?? "",
        hours_billed, amount_billed, amount_collected, wip_unbilled, rate_per_hour, status,
      });
    }

    const total_billed = numOrNull(p.total_billed, 0);
    if (total_billed === NUM_INVALID || total_billed === null) return { ok: false, reason: "bad_total_billed" };
    const total_collected = numOrNull(p.total_collected, 0);
    if (total_collected === NUM_INVALID || total_collected === null) return { ok: false, reason: "bad_total_collected" };
    const collection_rate = numOrNull(p.collection_rate, 0, 100);
    if (collection_rate === NUM_INVALID) return { ok: false, reason: "bad_collection_rate" };
    const average_hourly_rate = numOrNull(p.average_hourly_rate, 0);
    if (average_hourly_rate === NUM_INVALID) return { ok: false, reason: "bad_average_hourly_rate" };

    const TIMEKEEPER_ROLES = ["partner", "associate", "paralegal", "other"];
    const rawTimekeepers = Array.isArray(p.timekeeper_summary) ? (p.timekeeper_summary as unknown[]).slice(0, 30) : [];
    const timekeeper_summary: { timekeeper: string; role: string; hours: number; billed_amount: number; effective_rate: number }[] = [];
    for (const t of rawTimekeepers) {
      if (typeof t !== "object" || t === null) continue;
      const rec = t as Record<string, unknown>;
      const role = typeof rec.role === "string" && TIMEKEEPER_ROLES.includes(rec.role) ? rec.role : null;
      if (!role) continue;
      const hours = numOrNull(rec.hours, 0);
      const billed_amount = numOrNull(rec.billed_amount, 0);
      const effective_rate = numOrNull(rec.effective_rate, 0);
      if (hours === NUM_INVALID || hours === null) continue;
      if (billed_amount === NUM_INVALID || billed_amount === null) continue;
      if (effective_rate === NUM_INVALID || effective_rate === null) continue;
      timekeeper_summary.push({ timekeeper: str(rec.timekeeper) ?? "", role, hours, billed_amount, effective_rate });
    }

    const writeoffs_and_discounts = numOrNull(p.writeoffs_and_discounts, 0);
    if (writeoffs_and_discounts === NUM_INVALID || writeoffs_and_discounts === null) return { ok: false, reason: "bad_writeoffs_and_discounts" };

    const AGING_BUCKETS = ["current", "30_60", "61_90", "91_120", "120_plus"];
    const rawAging = Array.isArray(p.aging_wip) ? (p.aging_wip as unknown[]).slice(0, 5) : [];
    const aging_wip: { bucket: string; amount: number }[] = [];
    for (const a of rawAging) {
      if (typeof a !== "object" || a === null) continue;
      const rec = a as Record<string, unknown>;
      const bucket = typeof rec.bucket === "string" && AGING_BUCKETS.includes(rec.bucket) ? rec.bucket : null;
      if (!bucket) continue;
      const amount = numOrNull(rec.amount, 0);
      if (amount === NUM_INVALID || amount === null) continue;
      aging_wip.push({ bucket, amount });
    }

    const billing_flags = strArray(p.billing_flags, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_legal_billing",
      payload: { matters, total_billed, total_collected, collection_rate, average_hourly_rate, timekeeper_summary, writeoffs_and_discounts, aging_wip, billing_flags },
    };
  }

  if (kind === "analyze_hospitality_financials") {
    const occupancy_rate = numOrNull(p.occupancy_rate, 0, 100);
    if (occupancy_rate === NUM_INVALID) return { ok: false, reason: "bad_occupancy_rate" };
    const adr = numOrNull(p.adr, 0);
    if (adr === NUM_INVALID) return { ok: false, reason: "bad_adr" };
    const revpar = numOrNull(p.revpar, 0);
    if (revpar === NUM_INVALID) return { ok: false, reason: "bad_revpar" };
    const total_rooms = numOrNull(p.total_rooms, 0);
    if (total_rooms === NUM_INVALID || (total_rooms !== null && !Number.isInteger(total_rooms))) return { ok: false, reason: "bad_total_rooms" };
    const room_revenue = numOrNull(p.room_revenue, 0);
    if (room_revenue === NUM_INVALID || room_revenue === null) return { ok: false, reason: "bad_room_revenue" };
    const fb_revenue = numOrNull(p.fb_revenue, 0);
    if (fb_revenue === NUM_INVALID || fb_revenue === null) return { ok: false, reason: "bad_fb_revenue" };
    const other_revenue = numOrNull(p.other_revenue, 0);
    if (other_revenue === NUM_INVALID || other_revenue === null) return { ok: false, reason: "bad_other_revenue" };
    const total_revenue = numOrNull(p.total_revenue, 0);
    if (total_revenue === NUM_INVALID || total_revenue === null) return { ok: false, reason: "bad_total_revenue" };
    const goppar = numOrNull(p.goppar, 0);
    if (goppar === NUM_INVALID) return { ok: false, reason: "bad_goppar" };
    const cost_per_occupied_room = numOrNull(p.cost_per_occupied_room, 0);
    if (cost_per_occupied_room === NUM_INVALID) return { ok: false, reason: "bad_cost_per_occupied_room" };

    const CHANNELS = ["direct", "ota", "gds", "corporate", "group", "other"];
    const rawChannelMix = Array.isArray(p.channel_mix) ? (p.channel_mix as unknown[]).slice(0, 10) : [];
    const channel_mix: { channel: string; revenue_percentage: number; commission_rate: number | null }[] = [];
    for (const c of rawChannelMix) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const channel = typeof rec.channel === "string" && CHANNELS.includes(rec.channel) ? rec.channel : null;
      if (!channel) continue;
      const revenue_percentage = numOrNull(rec.revenue_percentage, 0, 100);
      const commission_rate = numOrNull(rec.commission_rate, 0, 100);
      if (revenue_percentage === NUM_INVALID || revenue_percentage === null) continue;
      if (commission_rate === NUM_INVALID) continue;
      channel_mix.push({ channel, revenue_percentage, commission_rate });
    }

    const rawStly = Array.isArray(p.performance_vs_stly) ? (p.performance_vs_stly as unknown[]).slice(0, 10) : [];
    const performance_vs_stly: { metric_name: string; current_value: number | null; stly_value: number | null; variance_percentage: number | null }[] = [];
    for (const s of rawStly) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const current_value = numOrNull(rec.current_value);
      const stly_value = numOrNull(rec.stly_value);
      const variance_percentage = numOrNull(rec.variance_percentage);
      if (current_value === NUM_INVALID || stly_value === NUM_INVALID || variance_percentage === NUM_INVALID) continue;
      performance_vs_stly.push({ metric_name: str(rec.metric_name) ?? "", current_value, stly_value, variance_percentage });
    }

    const revenue_management_insights = strArray(p.revenue_management_insights, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_hospitality_financials",
      payload: { occupancy_rate, adr, revpar, total_rooms, room_revenue, fb_revenue, other_revenue, total_revenue, goppar, cost_per_occupied_room, channel_mix, performance_vs_stly, revenue_management_insights },
    };
  }

  if (kind === "analyze_retail_performance") {
    const total_net_sales = numOrNull(p.total_net_sales, 0);
    if (total_net_sales === NUM_INVALID || total_net_sales === null) return { ok: false, reason: "bad_total_net_sales" };
    const comparable_store_sales_growth = numOrNull(p.comparable_store_sales_growth);
    if (comparable_store_sales_growth === NUM_INVALID) return { ok: false, reason: "bad_comparable_store_sales_growth" };
    const gross_margin_percentage = numOrNull(p.gross_margin_percentage);
    if (gross_margin_percentage === NUM_INVALID) return { ok: false, reason: "bad_gross_margin_percentage" };
    const inventory_turnover = numOrNull(p.inventory_turnover, 0);
    if (inventory_turnover === NUM_INVALID) return { ok: false, reason: "bad_inventory_turnover" };
    const sell_through_rate = numOrNull(p.sell_through_rate, 0, 100);
    if (sell_through_rate === NUM_INVALID) return { ok: false, reason: "bad_sell_through_rate" };
    const shrinkage_rate = numOrNull(p.shrinkage_rate, 0, 100);
    if (shrinkage_rate === NUM_INVALID) return { ok: false, reason: "bad_shrinkage_rate" };
    const sales_per_sqft = numOrNull(p.sales_per_sqft, 0);
    if (sales_per_sqft === NUM_INVALID) return { ok: false, reason: "bad_sales_per_sqft" };
    const transactions_per_day = numOrNull(p.transactions_per_day, 0);
    if (transactions_per_day === NUM_INVALID) return { ok: false, reason: "bad_transactions_per_day" };
    const average_transaction_value = numOrNull(p.average_transaction_value, 0);
    if (average_transaction_value === NUM_INVALID) return { ok: false, reason: "bad_average_transaction_value" };

    const rawStores = Array.isArray(p.store_breakdown) ? (p.store_breakdown as unknown[]).slice(0, 50) : [];
    const store_breakdown: { store_id: string; net_sales: number; transactions: number; avg_ticket: number; margin_percentage: number | null; rank: number | null }[] = [];
    for (const s of rawStores) {
      if (typeof s !== "object" || s === null) continue;
      const rec = s as Record<string, unknown>;
      const net_sales = numOrNull(rec.net_sales, 0);
      const transactions = numOrNull(rec.transactions, 0);
      const avg_ticket = numOrNull(rec.avg_ticket, 0);
      const margin_percentage = numOrNull(rec.margin_percentage);
      const rank = numOrNull(rec.rank, 1);
      if (net_sales === NUM_INVALID || net_sales === null) continue;
      if (transactions === NUM_INVALID || transactions === null || !Number.isInteger(transactions)) continue;
      if (avg_ticket === NUM_INVALID || avg_ticket === null) continue;
      if (margin_percentage === NUM_INVALID) continue;
      if (rank === NUM_INVALID) continue;
      if (rank !== null && !Number.isInteger(rank)) continue;
      store_breakdown.push({ store_id: str(rec.store_id) ?? "", net_sales, transactions, avg_ticket, margin_percentage, rank });
    }

    const rawCategories = Array.isArray(p.category_performance) ? (p.category_performance as unknown[]).slice(0, 30) : [];
    const category_performance: { category: string; net_sales: number; units_sold: number; margin_percentage: number | null; sell_through: number | null }[] = [];
    for (const c of rawCategories) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const net_sales = numOrNull(rec.net_sales, 0);
      const units_sold = numOrNull(rec.units_sold, 0);
      const margin_percentage = numOrNull(rec.margin_percentage);
      const sell_through = numOrNull(rec.sell_through, 0, 100);
      if (net_sales === NUM_INVALID || net_sales === null) continue;
      if (units_sold === NUM_INVALID || units_sold === null || !Number.isInteger(units_sold)) continue;
      if (margin_percentage === NUM_INVALID) continue;
      if (sell_through === NUM_INVALID) continue;
      category_performance.push({ category: str(rec.category) ?? "", net_sales, units_sold, margin_percentage, sell_through });
    }

    let markdown_analysis: { total_markdown_amount: number; markdown_rate: number | null; categories_with_high_markdown: string[] } | null = null;
    if (typeof p.markdown_analysis === "object" && p.markdown_analysis !== null) {
      const rec = p.markdown_analysis as Record<string, unknown>;
      const total_markdown_amount = numOrNull(rec.total_markdown_amount, 0);
      const markdown_rate = numOrNull(rec.markdown_rate, 0, 100);
      if (total_markdown_amount !== NUM_INVALID && total_markdown_amount !== null && markdown_rate !== NUM_INVALID) {
        markdown_analysis = {
          total_markdown_amount,
          markdown_rate,
          categories_with_high_markdown: strArray(rec.categories_with_high_markdown, 10, MAX_STR),
        };
      }
    }
    if (!markdown_analysis) return { ok: false, reason: "bad_markdown_analysis" };

    return {
      ok: true,
      kind: "analyze_retail_performance",
      payload: { total_net_sales, comparable_store_sales_growth, gross_margin_percentage, inventory_turnover, sell_through_rate, shrinkage_rate, sales_per_sqft, transactions_per_day, average_transaction_value, store_breakdown, category_performance, markdown_analysis },
    };
  }

  if (kind === "analyze_construction_financials") {
    const PROJECT_STATUSES = ["active", "complete", "on_hold", "at_risk"];
    const rawProjects = Array.isArray(p.projects) ? (p.projects as unknown[]).slice(0, 50) : [];
    const projects: { project_ref: string; client: string | null; contract_value: number; estimated_costs: number; costs_to_date: number; percent_complete: number; earned_value: number; billed_to_date: number; estimated_gross_margin: number; status: string; overbilled: boolean; underbilled: boolean }[] = [];
    for (const proj of rawProjects) {
      if (typeof proj !== "object" || proj === null) continue;
      const rec = proj as Record<string, unknown>;
      const status = typeof rec.status === "string" && PROJECT_STATUSES.includes(rec.status) ? rec.status : null;
      if (!status) continue;
      const contract_value = numOrNull(rec.contract_value, 0);
      const estimated_costs = numOrNull(rec.estimated_costs, 0);
      const costs_to_date = numOrNull(rec.costs_to_date, 0);
      const percent_complete = numOrNull(rec.percent_complete, 0, 100);
      const earned_value = numOrNull(rec.earned_value, 0);
      const billed_to_date = numOrNull(rec.billed_to_date, 0);
      const estimated_gross_margin = numOrNull(rec.estimated_gross_margin);
      if (contract_value === NUM_INVALID || contract_value === null) continue;
      if (estimated_costs === NUM_INVALID || estimated_costs === null) continue;
      if (costs_to_date === NUM_INVALID || costs_to_date === null) continue;
      if (percent_complete === NUM_INVALID || percent_complete === null) continue;
      if (earned_value === NUM_INVALID || earned_value === null) continue;
      if (billed_to_date === NUM_INVALID || billed_to_date === null) continue;
      if (estimated_gross_margin === NUM_INVALID || estimated_gross_margin === null) continue;
      projects.push({
        project_ref: str(rec.project_ref) ?? "", client: str(rec.client),
        contract_value, estimated_costs, costs_to_date, percent_complete, earned_value, billed_to_date, estimated_gross_margin, status,
        overbilled: rec.overbilled === true, underbilled: rec.underbilled === true,
      });
    }

    const total_contract_value = numOrNull(p.total_contract_value, 0);
    if (total_contract_value === NUM_INVALID || total_contract_value === null) return { ok: false, reason: "bad_total_contract_value" };
    const total_earned_value = numOrNull(p.total_earned_value, 0);
    if (total_earned_value === NUM_INVALID || total_earned_value === null) return { ok: false, reason: "bad_total_earned_value" };
    const total_costs_to_date = numOrNull(p.total_costs_to_date, 0);
    if (total_costs_to_date === NUM_INVALID || total_costs_to_date === null) return { ok: false, reason: "bad_total_costs_to_date" };
    const total_remaining_costs = numOrNull(p.total_remaining_costs, 0);
    if (total_remaining_costs === NUM_INVALID || total_remaining_costs === null) return { ok: false, reason: "bad_total_remaining_costs" };
    const overall_gross_margin = numOrNull(p.overall_gross_margin);
    if (overall_gross_margin === NUM_INVALID) return { ok: false, reason: "bad_overall_gross_margin" };
    const overbillings = numOrNull(p.overbillings, 0);
    if (overbillings === NUM_INVALID || overbillings === null) return { ok: false, reason: "bad_overbillings" };
    const underbillings = numOrNull(p.underbillings, 0);
    if (underbillings === NUM_INVALID || underbillings === null) return { ok: false, reason: "bad_underbillings" };
    const backlog_value = numOrNull(p.backlog_value, 0);
    if (backlog_value === NUM_INVALID || backlog_value === null) return { ok: false, reason: "bad_backlog_value" };

    const WIP_CATEGORIES = ["earned_revenue", "overbilling", "underbilling", "backlog"];
    const rawWip = Array.isArray(p.wip_schedule) ? (p.wip_schedule as unknown[]).slice(0, 5) : [];
    const wip_schedule: { category: string; amount: number }[] = [];
    for (const w of rawWip) {
      if (typeof w !== "object" || w === null) continue;
      const rec = w as Record<string, unknown>;
      const category = typeof rec.category === "string" && WIP_CATEGORIES.includes(rec.category) ? rec.category : null;
      if (!category) continue;
      const amount = numOrNull(rec.amount);
      if (amount === NUM_INVALID || amount === null) continue;
      wip_schedule.push({ category, amount });
    }

    const risk_summary = strArray(p.risk_summary, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_construction_financials",
      payload: { projects, total_contract_value, total_earned_value, total_costs_to_date, total_remaining_costs, overall_gross_margin, overbillings, underbillings, backlog_value, wip_schedule, risk_summary },
    };
  }

  if (kind === "analyze_revenue_quality") {
    const recurring_revenue_pct = numOrNull(p.recurring_revenue_pct, 0, 100);
    if (recurring_revenue_pct === NUM_INVALID) return { ok: false, reason: "bad_recurring_revenue_pct" };
    const non_recurring_revenue_pct = numOrNull(p.non_recurring_revenue_pct, 0, 100);
    if (non_recurring_revenue_pct === NUM_INVALID) return { ok: false, reason: "bad_non_recurring_revenue_pct" };
    const top_customer_concentration_pct = numOrNull(p.top_customer_concentration_pct, 0, 100);
    if (top_customer_concentration_pct === NUM_INVALID) return { ok: false, reason: "bad_top_customer_concentration_pct" };
    const revenue_predictability_score = numOrNull(p.revenue_predictability_score, 0, 100);
    if (revenue_predictability_score === NUM_INVALID) return { ok: false, reason: "bad_revenue_predictability_score" };
    const arr_growth_rate_pct = numOrNull(p.arr_growth_rate_pct);
    if (arr_growth_rate_pct === NUM_INVALID) return { ok: false, reason: "bad_arr_growth_rate_pct" };
    const net_revenue_retention_pct = numOrNull(p.net_revenue_retention_pct, 0);
    if (net_revenue_retention_pct === NUM_INVALID) return { ok: false, reason: "bad_net_revenue_retention_pct" };
    const churn_adjusted_arr = numOrNull(p.churn_adjusted_arr, 0);
    if (churn_adjusted_arr === NUM_INVALID) return { ok: false, reason: "bad_churn_adjusted_arr" };

    const rawByType = Array.isArray(p.revenue_by_type) ? (p.revenue_by_type as unknown[]).slice(0, 10) : [];
    const revenue_by_type: { type: string; amount: number; percentage: number }[] = [];
    for (const item of rawByType) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const amount = numOrNull(rec.amount, 0);
      const percentage = numOrNull(rec.percentage, 0, 100);
      if (amount === NUM_INVALID || amount === null) continue;
      if (percentage === NUM_INVALID || percentage === null) continue;
      revenue_by_type.push({ type: str(rec.type) ?? "", amount, percentage });
    }

    const data_period = typeof p.data_period === "string" && p.data_period.length > 0 ? p.data_period.slice(0, MAX_STR) : null;
    if (!data_period) return { ok: false, reason: "missing_data_period" };

    return {
      ok: true,
      kind: "analyze_revenue_quality",
      payload: { recurring_revenue_pct, non_recurring_revenue_pct, top_customer_concentration_pct, revenue_predictability_score, arr_growth_rate_pct, net_revenue_retention_pct, churn_adjusted_arr, revenue_by_type, data_period },
    };
  }

  if (kind === "analyze_customer_cohorts") {
    const rawCohorts = Array.isArray(p.cohorts) ? (p.cohorts as unknown[]).slice(0, 24) : [];
    const cohorts: { cohort_label: string; cohort_size: number; month_1: number | null; month_3: number | null; month_6: number | null; month_12: number | null; revenue_at_start: number | null }[] = [];
    for (const item of rawCohorts) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const cohort_size = numOrNull(rec.cohort_size, 0);
      const month_1 = numOrNull(rec.month_1, 0, 100);
      const month_3 = numOrNull(rec.month_3, 0, 100);
      const month_6 = numOrNull(rec.month_6, 0, 100);
      const month_12 = numOrNull(rec.month_12, 0, 100);
      const revenue_at_start = numOrNull(rec.revenue_at_start, 0);
      if (cohort_size === NUM_INVALID || cohort_size === null || !Number.isInteger(cohort_size)) continue;
      if (month_1 === NUM_INVALID || month_3 === NUM_INVALID || month_6 === NUM_INVALID || month_12 === NUM_INVALID) continue;
      if (revenue_at_start === NUM_INVALID) continue;
      cohorts.push({ cohort_label: str(rec.cohort_label) ?? "", cohort_size, month_1, month_3, month_6, month_12, revenue_at_start });
    }
    if (cohorts.length < 1) return { ok: false, reason: "empty_cohorts" };

    const COHORT_TYPES = ["revenue", "retention", "usage"];
    const cohort_type = typeof p.cohort_type === "string" && COHORT_TYPES.includes(p.cohort_type) ? p.cohort_type : null;
    if (!cohort_type) return { ok: false, reason: "bad_cohort_type" };

    const avg_month1_retention = numOrNull(p.avg_month1_retention, 0, 100);
    if (avg_month1_retention === NUM_INVALID) return { ok: false, reason: "bad_avg_month1_retention" };
    const avg_month3_retention = numOrNull(p.avg_month3_retention, 0, 100);
    if (avg_month3_retention === NUM_INVALID) return { ok: false, reason: "bad_avg_month3_retention" };
    const avg_month6_retention = numOrNull(p.avg_month6_retention, 0, 100);
    if (avg_month6_retention === NUM_INVALID) return { ok: false, reason: "bad_avg_month6_retention" };
    const avg_month12_retention = numOrNull(p.avg_month12_retention, 0, 100);
    if (avg_month12_retention === NUM_INVALID) return { ok: false, reason: "bad_avg_month12_retention" };

    const best_cohort = str(p.best_cohort);
    const worst_cohort = str(p.worst_cohort);

    const TRENDS = ["improving", "declining", "stable", "insufficient_data"];
    const trend = typeof p.trend === "string" && TRENDS.includes(p.trend) ? p.trend : null;
    if (!trend) return { ok: false, reason: "bad_trend" };

    const data_period = typeof p.data_period === "string" && p.data_period.length > 0 ? p.data_period.slice(0, MAX_STR) : null;
    if (!data_period) return { ok: false, reason: "missing_data_period" };

    return {
      ok: true,
      kind: "analyze_customer_cohorts",
      payload: { cohorts, cohort_type, avg_month1_retention, avg_month3_retention, avg_month6_retention, avg_month12_retention, best_cohort, worst_cohort, trend, data_period },
    };
  }

  if (kind === "analyze_variances") {
    const DIRECTIONS = ["favorable", "unfavorable", "neutral"];
    const rawVariances = Array.isArray(p.variances) ? (p.variances as unknown[]).slice(0, 100) : [];
    const variances: { line_item: string; budget: number; actual: number; variance: number; variance_pct: number; direction: string }[] = [];
    for (const item of rawVariances) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const direction = typeof rec.direction === "string" && DIRECTIONS.includes(rec.direction) ? rec.direction : null;
      if (!direction) continue;
      const budget = numOrNull(rec.budget);
      const actual = numOrNull(rec.actual);
      const variance = numOrNull(rec.variance);
      const variance_pct = numOrNull(rec.variance_pct);
      if (budget === NUM_INVALID || budget === null) continue;
      if (actual === NUM_INVALID || actual === null) continue;
      if (variance === NUM_INVALID || variance === null) continue;
      if (variance_pct === NUM_INVALID || variance_pct === null) continue;
      variances.push({ line_item: str(rec.line_item) ?? "", budget, actual, variance, variance_pct, direction });
    }

    const total_budget = numOrNull(p.total_budget);
    if (total_budget === NUM_INVALID || total_budget === null) return { ok: false, reason: "bad_total_budget" };
    const total_actual = numOrNull(p.total_actual);
    if (total_actual === NUM_INVALID || total_actual === null) return { ok: false, reason: "bad_total_actual" };
    const total_variance = numOrNull(p.total_variance);
    if (total_variance === NUM_INVALID || total_variance === null) return { ok: false, reason: "bad_total_variance" };
    const total_variance_pct = numOrNull(p.total_variance_pct);
    if (total_variance_pct === NUM_INVALID || total_variance_pct === null) return { ok: false, reason: "bad_total_variance_pct" };
    const favorable_count = numOrNull(p.favorable_count, 0);
    if (favorable_count === NUM_INVALID || favorable_count === null || !Number.isInteger(favorable_count)) return { ok: false, reason: "bad_favorable_count" };
    const unfavorable_count = numOrNull(p.unfavorable_count, 0);
    if (unfavorable_count === NUM_INVALID || unfavorable_count === null || !Number.isInteger(unfavorable_count)) return { ok: false, reason: "bad_unfavorable_count" };

    const significant_variances = strArray(p.significant_variances, 15, MAX_STR);
    const root_causes = strArray(p.root_causes, 10, MAX_STR);

    const period = typeof p.period === "string" && p.period.length > 0 ? p.period.slice(0, MAX_STR) : null;
    if (!period) return { ok: false, reason: "missing_period" };

    return {
      ok: true,
      kind: "analyze_variances",
      payload: { variances, total_budget, total_actual, total_variance, total_variance_pct, favorable_count, unfavorable_count, significant_variances, root_causes, period },
    };
  }

  if (kind === "forecast_cash_flow") {
    const opening_cash_balance = numOrNull(p.opening_cash_balance);
    if (opening_cash_balance === NUM_INVALID) return { ok: false, reason: "bad_opening_cash_balance" };

    const rawWeekly = Array.isArray(p.weekly_forecast) ? (p.weekly_forecast as unknown[]).slice(0, 13) : [];
    const weekly_forecast: { week_label: string; inflows: number; outflows: number; net: number; closing_balance: number }[] = [];
    for (const item of rawWeekly) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const inflows = numOrNull(rec.inflows, 0);
      const outflows = numOrNull(rec.outflows, 0);
      const net = numOrNull(rec.net);
      const closing_balance = numOrNull(rec.closing_balance);
      if (inflows === NUM_INVALID || inflows === null) continue;
      if (outflows === NUM_INVALID || outflows === null) continue;
      if (net === NUM_INVALID || net === null) continue;
      if (closing_balance === NUM_INVALID || closing_balance === null) continue;
      weekly_forecast.push({ week_label: str(rec.week_label) ?? "", inflows, outflows, net, closing_balance });
    }
    if (weekly_forecast.length < 1) return { ok: false, reason: "empty_weekly_forecast" };

    const total_inflows = numOrNull(p.total_inflows, 0);
    if (total_inflows === NUM_INVALID || total_inflows === null) return { ok: false, reason: "bad_total_inflows" };
    const total_outflows = numOrNull(p.total_outflows, 0);
    if (total_outflows === NUM_INVALID || total_outflows === null) return { ok: false, reason: "bad_total_outflows" };
    const closing_cash_balance = numOrNull(p.closing_cash_balance);
    if (closing_cash_balance === NUM_INVALID) return { ok: false, reason: "bad_closing_cash_balance" };
    const minimum_cash_week = str(p.minimum_cash_week);
    const minimum_cash_amount = numOrNull(p.minimum_cash_amount);
    if (minimum_cash_amount === NUM_INVALID) return { ok: false, reason: "bad_minimum_cash_amount" };

    const RISK_LEVELS = ["high", "medium", "low", "none"];
    const cash_constraint_risk = typeof p.cash_constraint_risk === "string" && RISK_LEVELS.includes(p.cash_constraint_risk) ? p.cash_constraint_risk : null;
    if (!cash_constraint_risk) return { ok: false, reason: "bad_cash_constraint_risk" };

    const assumptions = strArray(p.assumptions, 10, MAX_STR);

    return {
      ok: true,
      kind: "forecast_cash_flow",
      payload: { opening_cash_balance, weekly_forecast, total_inflows, total_outflows, closing_cash_balance, minimum_cash_week, minimum_cash_amount, cash_constraint_risk, assumptions },
    };
  }

  if (kind === "forecast_expenses") {
    const historical_monthly_avg = numOrNull(p.historical_monthly_avg, 0);
    if (historical_monthly_avg === NUM_INVALID) return { ok: false, reason: "bad_historical_monthly_avg" };

    const rawPeriods = Array.isArray(p.forecast_periods) ? (p.forecast_periods as unknown[]).slice(0, 12) : [];
    const forecast_periods: { period_label: string; forecast_amount: number; growth_applied: number }[] = [];
    for (const item of rawPeriods) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const forecast_amount = numOrNull(rec.forecast_amount, 0);
      const growth_applied = numOrNull(rec.growth_applied);
      if (forecast_amount === NUM_INVALID || forecast_amount === null) continue;
      if (growth_applied === NUM_INVALID || growth_applied === null) continue;
      forecast_periods.push({ period_label: str(rec.period_label) ?? "", forecast_amount, growth_applied });
    }
    if (forecast_periods.length < 1) return { ok: false, reason: "empty_forecast_periods" };

    const total_forecast_amount = numOrNull(p.total_forecast_amount, 0);
    if (total_forecast_amount === NUM_INVALID || total_forecast_amount === null) return { ok: false, reason: "bad_total_forecast_amount" };
    const growth_rate_applied = numOrNull(p.growth_rate_applied);
    if (growth_rate_applied === NUM_INVALID) return { ok: false, reason: "bad_growth_rate_applied" };

    const rawCategories = Array.isArray(p.largest_categories) ? (p.largest_categories as unknown[]).slice(0, 10) : [];
    const largest_categories: { category: string; monthly_avg: number; forecast_next_period: number }[] = [];
    for (const item of rawCategories) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const monthly_avg = numOrNull(rec.monthly_avg, 0);
      const forecast_next_period = numOrNull(rec.forecast_next_period, 0);
      if (monthly_avg === NUM_INVALID || monthly_avg === null) continue;
      if (forecast_next_period === NUM_INVALID || forecast_next_period === null) continue;
      largest_categories.push({ category: str(rec.category) ?? "", monthly_avg, forecast_next_period });
    }

    let fixed_vs_variable: { fixed: number; variable: number; semi_variable: number } | null = null;
    if (typeof p.fixed_vs_variable === "object" && p.fixed_vs_variable !== null) {
      const rec = p.fixed_vs_variable as Record<string, unknown>;
      const fixed = numOrNull(rec.fixed, 0);
      const variable = numOrNull(rec.variable, 0);
      const semi_variable = numOrNull(rec.semi_variable, 0);
      if (fixed !== NUM_INVALID && fixed !== null && variable !== NUM_INVALID && variable !== null && semi_variable !== NUM_INVALID && semi_variable !== null) {
        fixed_vs_variable = { fixed, variable, semi_variable };
      }
    }
    if (!fixed_vs_variable) return { ok: false, reason: "bad_fixed_vs_variable" };

    const CONFIDENCES = ["high", "medium", "low"];
    const confidence = typeof p.confidence === "string" && CONFIDENCES.includes(p.confidence) ? p.confidence : null;
    if (!confidence) return { ok: false, reason: "bad_confidence" };

    const period_label = typeof p.period_label === "string" && p.period_label.length > 0 ? p.period_label.slice(0, MAX_STR) : null;
    if (!period_label) return { ok: false, reason: "missing_period_label" };

    return {
      ok: true,
      kind: "forecast_expenses",
      payload: { historical_monthly_avg, forecast_periods, total_forecast_amount, growth_rate_applied, largest_categories, fixed_vs_variable, confidence, period_label },
    };
  }

  if (kind === "analyze_headcount") {
    const total_headcount = numOrNull(p.total_headcount, 0);
    if (total_headcount === NUM_INVALID || total_headcount === null || !Number.isInteger(total_headcount)) return { ok: false, reason: "bad_total_headcount" };
    const total_payroll_cost = numOrNull(p.total_payroll_cost, 0);
    if (total_payroll_cost === NUM_INVALID || total_payroll_cost === null) return { ok: false, reason: "bad_total_payroll_cost" };
    const cost_per_head = numOrNull(p.cost_per_head, 0);
    if (cost_per_head === NUM_INVALID) return { ok: false, reason: "bad_cost_per_head" };

    const rawByDept = Array.isArray(p.by_department) ? (p.by_department as unknown[]).slice(0, 20) : [];
    const by_department: { dept: string; headcount: number; total_cost: number; avg_cost: number }[] = [];
    for (const item of rawByDept) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const headcount = numOrNull(rec.headcount, 0);
      const total_cost = numOrNull(rec.total_cost, 0);
      const avg_cost = numOrNull(rec.avg_cost, 0);
      if (headcount === NUM_INVALID || headcount === null || !Number.isInteger(headcount)) continue;
      if (total_cost === NUM_INVALID || total_cost === null) continue;
      if (avg_cost === NUM_INVALID || avg_cost === null) continue;
      by_department.push({ dept: str(rec.dept) ?? "", headcount, total_cost, avg_cost });
    }

    const rawByLevel = Array.isArray(p.by_level) ? (p.by_level as unknown[]).slice(0, 10) : [];
    const by_level: { level: string; headcount: number; avg_cost: number }[] = [];
    for (const item of rawByLevel) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const headcount = numOrNull(rec.headcount, 0);
      const avg_cost = numOrNull(rec.avg_cost, 0);
      if (headcount === NUM_INVALID || headcount === null || !Number.isInteger(headcount)) continue;
      if (avg_cost === NUM_INVALID || avg_cost === null) continue;
      by_level.push({ level: str(rec.level) ?? "", headcount, avg_cost });
    }

    const headcount_revenue_ratio = numOrNull(p.headcount_revenue_ratio, 0);
    if (headcount_revenue_ratio === NUM_INVALID) return { ok: false, reason: "bad_headcount_revenue_ratio" };
    const compensation_revenue_pct = numOrNull(p.compensation_revenue_pct, 0, 100);
    if (compensation_revenue_pct === NUM_INVALID) return { ok: false, reason: "bad_compensation_revenue_pct" };
    const open_roles = numOrNull(p.open_roles, 0);
    if (open_roles === NUM_INVALID || open_roles === null || !Number.isInteger(open_roles)) return { ok: false, reason: "bad_open_roles" };
    const attrition_rate = numOrNull(p.attrition_rate, 0, 100);
    if (attrition_rate === NUM_INVALID) return { ok: false, reason: "bad_attrition_rate" };

    const period = typeof p.period === "string" && p.period.length > 0 ? p.period.slice(0, MAX_STR) : null;
    if (!period) return { ok: false, reason: "missing_period" };

    return {
      ok: true,
      kind: "analyze_headcount",
      payload: { total_headcount, total_payroll_cost, cost_per_head, by_department, by_level, headcount_revenue_ratio, compensation_revenue_pct, open_roles, attrition_rate, period },
    };
  }

  if (kind === "analyze_debt_covenants") {
    const STATUSES = ["compliant", "at_risk", "breach", "not_calculable"];
    const rawCovenants = Array.isArray(p.covenants) ? (p.covenants as unknown[]).slice(0, 20) : [];
    const covenants: { covenant_name: string; metric_type: string; threshold: number; current_value: number; headroom_pct: number; status: string; next_test_date: string | null }[] = [];
    for (const item of rawCovenants) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const status = typeof rec.status === "string" && STATUSES.includes(rec.status) ? rec.status : null;
      if (!status) continue;
      const threshold = numOrNull(rec.threshold);
      const current_value = numOrNull(rec.current_value);
      const headroom_pct = numOrNull(rec.headroom_pct);
      if (threshold === NUM_INVALID || threshold === null) continue;
      if (current_value === NUM_INVALID || current_value === null) continue;
      if (headroom_pct === NUM_INVALID || headroom_pct === null) continue;
      covenants.push({
        covenant_name: str(rec.covenant_name) ?? "", metric_type: str(rec.metric_type) ?? "",
        threshold, current_value, headroom_pct, status, next_test_date: str(rec.next_test_date),
      });
    }

    const OVERALL_STATUSES = ["compliant", "at_risk", "breach", "unknown"];
    const overall_status = typeof p.overall_status === "string" && OVERALL_STATUSES.includes(p.overall_status) ? p.overall_status : null;
    if (!overall_status) return { ok: false, reason: "bad_overall_status" };

    const breach_count = numOrNull(p.breach_count, 0);
    if (breach_count === NUM_INVALID || breach_count === null || !Number.isInteger(breach_count)) return { ok: false, reason: "bad_breach_count" };
    const at_risk_count = numOrNull(p.at_risk_count, 0);
    if (at_risk_count === NUM_INVALID || at_risk_count === null || !Number.isInteger(at_risk_count)) return { ok: false, reason: "bad_at_risk_count" };

    let nearest_breach: { covenant_name: string; headroom_pct: number } | null = null;
    if (typeof p.nearest_breach === "object" && p.nearest_breach !== null) {
      const rec = p.nearest_breach as Record<string, unknown>;
      const headroom_pct = numOrNull(rec.headroom_pct);
      if (headroom_pct !== NUM_INVALID && headroom_pct !== null) {
        nearest_breach = { covenant_name: str(rec.covenant_name) ?? "", headroom_pct };
      }
    }

    const total_debt_outstanding = numOrNull(p.total_debt_outstanding, 0);
    if (total_debt_outstanding === NUM_INVALID) return { ok: false, reason: "bad_total_debt_outstanding" };
    const debt_service_coverage_ratio = numOrNull(p.debt_service_coverage_ratio, 0);
    if (debt_service_coverage_ratio === NUM_INVALID) return { ok: false, reason: "bad_debt_service_coverage_ratio" };

    const recommendations = strArray(p.recommendations, 10, MAX_STR);

    return {
      ok: true,
      kind: "analyze_debt_covenants",
      payload: { covenants, overall_status, breach_count, at_risk_count, nearest_breach, total_debt_outstanding, debt_service_coverage_ratio, recommendations },
    };
  }

  if (kind === "analyze_tax_provision") {
    const pre_tax_income = numOrNull(p.pre_tax_income);
    if (pre_tax_income === NUM_INVALID) return { ok: false, reason: "bad_pre_tax_income" };
    const estimated_tax_provision = numOrNull(p.estimated_tax_provision);
    if (estimated_tax_provision === NUM_INVALID) return { ok: false, reason: "bad_estimated_tax_provision" };
    const effective_tax_rate = numOrNull(p.effective_tax_rate);
    if (effective_tax_rate === NUM_INVALID) return { ok: false, reason: "bad_effective_tax_rate" };
    const statutory_rate = numOrNull(p.statutory_rate, 0, 100);
    if (statutory_rate === NUM_INVALID) return { ok: false, reason: "bad_statutory_rate" };

    const rawRecon = Array.isArray(p.rate_reconciliation) ? (p.rate_reconciliation as unknown[]).slice(0, 10) : [];
    const rate_reconciliation: { item: string; amount: number; rate_impact: number }[] = [];
    for (const item of rawRecon) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const amount = numOrNull(rec.amount);
      const rate_impact = numOrNull(rec.rate_impact);
      if (amount === NUM_INVALID || amount === null) continue;
      if (rate_impact === NUM_INVALID || rate_impact === null) continue;
      rate_reconciliation.push({ item: str(rec.item) ?? "", amount, rate_impact });
    }

    const rawDTAs = Array.isArray(p.deferred_tax_assets) ? (p.deferred_tax_assets as unknown[]).slice(0, 15) : [];
    const deferred_tax_assets: { item: string; amount: number; description: string }[] = [];
    for (const item of rawDTAs) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const amount = numOrNull(rec.amount, 0);
      if (amount === NUM_INVALID || amount === null) continue;
      deferred_tax_assets.push({ item: str(rec.item) ?? "", amount, description: str(rec.description) ?? "" });
    }

    const rawDTLs = Array.isArray(p.deferred_tax_liabilities) ? (p.deferred_tax_liabilities as unknown[]).slice(0, 15) : [];
    const deferred_tax_liabilities: { item: string; amount: number; description: string }[] = [];
    for (const item of rawDTLs) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const amount = numOrNull(rec.amount, 0);
      if (amount === NUM_INVALID || amount === null) continue;
      deferred_tax_liabilities.push({ item: str(rec.item) ?? "", amount, description: str(rec.description) ?? "" });
    }

    const net_deferred_tax_position = numOrNull(p.net_deferred_tax_position);
    if (net_deferred_tax_position === NUM_INVALID) return { ok: false, reason: "bad_net_deferred_tax_position" };

    const tax_risk_flags = strArray(p.tax_risk_flags, 10, MAX_STR);

    const period = typeof p.period === "string" && p.period.length > 0 ? p.period.slice(0, MAX_STR) : null;
    if (!period) return { ok: false, reason: "missing_period" };

    return {
      ok: true,
      kind: "analyze_tax_provision",
      payload: { pre_tax_income, estimated_tax_provision, effective_tax_rate, statutory_rate, rate_reconciliation, deferred_tax_assets, deferred_tax_liabilities, net_deferred_tax_position, tax_risk_flags, period },
    };
  }

  if (kind === "manage_collections") {
    const total_ar_balance = numOrNull(p.total_ar_balance, 0);
    if (total_ar_balance === NUM_INVALID || total_ar_balance === null) return { ok: false, reason: "bad_total_ar_balance" };
    const overdue_balance = numOrNull(p.overdue_balance, 0);
    if (overdue_balance === NUM_INVALID || overdue_balance === null) return { ok: false, reason: "bad_overdue_balance" };
    const overdue_pct = numOrNull(p.overdue_pct, 0, 100);
    if (overdue_pct === NUM_INVALID || overdue_pct === null) return { ok: false, reason: "bad_overdue_pct" };

    const PRIORITIES = ["critical", "high", "medium", "low"];
    const rawAccounts = Array.isArray(p.priority_accounts) ? (p.priority_accounts as unknown[]).slice(0, 20) : [];
    const priority_accounts: { customer_name: string; balance: number; days_overdue: number; priority: string; action_recommended: string }[] = [];
    for (const item of rawAccounts) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const priority = typeof rec.priority === "string" && PRIORITIES.includes(rec.priority) ? rec.priority : null;
      if (!priority) continue;
      const balance = numOrNull(rec.balance, 0);
      const days_overdue = numOrNull(rec.days_overdue, 0);
      if (balance === NUM_INVALID || balance === null) continue;
      if (days_overdue === NUM_INVALID || days_overdue === null || !Number.isInteger(days_overdue)) continue;
      priority_accounts.push({ customer_name: str(rec.customer_name) ?? "", balance, days_overdue, priority, action_recommended: str(rec.action_recommended) ?? "" });
    }

    const rawAging = Array.isArray(p.aging_summary) ? (p.aging_summary as unknown[]).slice(0, 5) : [];
    const aging_summary: { bucket: string; balance: number; count: number }[] = [];
    for (const item of rawAging) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const balance = numOrNull(rec.balance, 0);
      const count = numOrNull(rec.count, 0);
      if (balance === NUM_INVALID || balance === null) continue;
      if (count === NUM_INVALID || count === null || !Number.isInteger(count)) continue;
      aging_summary.push({ bucket: str(rec.bucket) ?? "", balance, count });
    }

    const rawDrafts = Array.isArray(p.collection_drafts) ? (p.collection_drafts as unknown[]).slice(0, 5) : [];
    const collection_drafts: { customer_name: string; draft_message: string }[] = [];
    for (const item of rawDrafts) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const draft_message = str(rec.draft_message);
      if (!draft_message) continue;
      collection_drafts.push({ customer_name: str(rec.customer_name) ?? "", draft_message });
    }

    const avg_days_outstanding = numOrNull(p.avg_days_outstanding, 0);
    if (avg_days_outstanding === NUM_INVALID) return { ok: false, reason: "bad_avg_days_outstanding" };

    return {
      ok: true,
      kind: "manage_collections",
      payload: { total_ar_balance, overdue_balance, overdue_pct, priority_accounts, aging_summary, collection_drafts, avg_days_outstanding },
    };
  }

  if (kind === "benchmark_competitive") {
    const rawMetrics = Array.isArray(p.client_metrics) ? (p.client_metrics as unknown[]).slice(0, 20) : [];
    const client_metrics: { metric_name: string; value: number; unit: string }[] = [];
    for (const item of rawMetrics) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const value = numOrNull(rec.value);
      if (value === NUM_INVALID || value === null) continue;
      client_metrics.push({ metric_name: str(rec.metric_name) ?? "", value, unit: str(rec.unit) ?? "" });
    }

    const ASSESSMENTS = ["top_quartile", "above_median", "below_median", "bottom_quartile", "unknown"];
    const rawComparisons = Array.isArray(p.benchmark_comparisons) ? (p.benchmark_comparisons as unknown[]).slice(0, 20) : [];
    const benchmark_comparisons: { metric_name: string; client_value: number; industry_median: number | null; top_quartile: number | null; bottom_quartile: number | null; client_percentile: number | null; assessment: string }[] = [];
    for (const item of rawComparisons) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const assessment = typeof rec.assessment === "string" && ASSESSMENTS.includes(rec.assessment) ? rec.assessment : null;
      if (!assessment) continue;
      const client_value = numOrNull(rec.client_value);
      if (client_value === NUM_INVALID || client_value === null) continue;
      const industry_median = numOrNull(rec.industry_median);
      const top_quartile = numOrNull(rec.top_quartile);
      const bottom_quartile = numOrNull(rec.bottom_quartile);
      const client_percentile = numOrNull(rec.client_percentile, 0, 100);
      if (industry_median === NUM_INVALID || top_quartile === NUM_INVALID || bottom_quartile === NUM_INVALID || client_percentile === NUM_INVALID) continue;
      benchmark_comparisons.push({ metric_name: str(rec.metric_name) ?? "", client_value, industry_median, top_quartile, bottom_quartile, client_percentile, assessment });
    }

    const PERFORMANCE_LEVELS = ["top", "above_average", "below_average", "bottom", "mixed", "insufficient_data"];
    const performance_quartile = typeof p.performance_quartile === "string" && PERFORMANCE_LEVELS.includes(p.performance_quartile) ? p.performance_quartile : null;
    if (!performance_quartile) return { ok: false, reason: "bad_performance_quartile" };

    const strengths = strArray(p.strengths, 10, MAX_STR);
    const weaknesses = strArray(p.weaknesses, 10, MAX_STR);

    const industry_context = typeof p.industry_context === "string" && p.industry_context.length > 0 ? p.industry_context.slice(0, MAX_STR) : null;
    if (!industry_context) return { ok: false, reason: "missing_industry_context" };

    const data_period = typeof p.data_period === "string" && p.data_period.length > 0 ? p.data_period.slice(0, MAX_STR) : null;
    if (!data_period) return { ok: false, reason: "missing_data_period" };

    return {
      ok: true,
      kind: "benchmark_competitive",
      payload: { client_metrics, benchmark_comparisons, performance_quartile, strengths, weaknesses, industry_context, data_period },
    };
  }

  if (kind === "evaluate_data_quality") {
    const overall_score = numOrNull(p.overall_score, 0, 100);
    if (overall_score === NUM_INVALID || overall_score === null) return { ok: false, reason: "bad_overall_score" };
    const row_count = numOrNull(p.row_count, 0);
    if (row_count === NUM_INVALID || row_count === null) return { ok: false, reason: "bad_row_count" };
    const column_count = numOrNull(p.column_count, 0);
    if (column_count === NUM_INVALID || column_count === null) return { ok: false, reason: "bad_column_count" };
    const completeness_score = numOrNull(p.completeness_score, 0, 100);
    if (completeness_score === NUM_INVALID || completeness_score === null) return { ok: false, reason: "bad_completeness_score" };
    const consistency_score = numOrNull(p.consistency_score, 0, 100);
    if (consistency_score === NUM_INVALID || consistency_score === null) return { ok: false, reason: "bad_consistency_score" };
    const outlier_count = numOrNull(p.outlier_count, 0);
    if (outlier_count === NUM_INVALID || outlier_count === null) return { ok: false, reason: "bad_outlier_count" };

    const SEVERITIES_DQ = ["high", "medium", "low"];
    const rawIssues = Array.isArray(p.issues) ? (p.issues as unknown[]).slice(0, 20) : [];
    const issues: { issue_type: string; description: string; severity: string; affected_columns: string[] }[] = [];
    for (const item of rawIssues) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const severity = typeof rec.severity === "string" && SEVERITIES_DQ.includes(rec.severity) ? rec.severity : null;
      if (!severity) continue;
      issues.push({
        issue_type: str(rec.issue_type) ?? "",
        description: str(rec.description) ?? "",
        severity,
        affected_columns: strArray(rec.affected_columns, 20, MAX_STR),
      });
    }

    if (typeof p.usable_for_analysis !== "boolean") return { ok: false, reason: "bad_usable_for_analysis" };
    const usable_for_analysis = p.usable_for_analysis;

    const recommended_agents = strArray(p.recommended_agents, 10, MAX_STR);

    return {
      ok: true,
      kind: "evaluate_data_quality",
      payload: { overall_score, row_count, column_count, completeness_score, consistency_score, outlier_count, issues, usable_for_analysis, recommended_agents },
    };
  }

  if (kind === "detect_schema") {
    const SCHEMA_TYPES = ["gl_export", "ar_aging", "ap_aging", "bank_statement", "income_statement", "balance_sheet", "cash_flow_statement", "payroll", "cap_table", "sales_pipeline", "customer_list", "subscription_data", "inventory", "contract_list", "unknown"];
    const detected_schema_type = typeof p.detected_schema_type === "string" && SCHEMA_TYPES.includes(p.detected_schema_type) ? p.detected_schema_type : null;
    if (!detected_schema_type) return { ok: false, reason: "bad_detected_schema_type" };

    const CONFIDENCE_LEVELS = ["high", "medium", "low"];
    const confidence = typeof p.confidence === "string" && CONFIDENCE_LEVELS.includes(p.confidence) ? p.confidence : null;
    if (!confidence) return { ok: false, reason: "bad_confidence" };

    const rawColumns = Array.isArray(p.detected_columns) ? (p.detected_columns as unknown[]).slice(0, 30) : [];
    const detected_columns: { column_name: string; inferred_type: string; sample_values: string[] }[] = [];
    for (const item of rawColumns) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const column_name = str(rec.column_name);
      if (!column_name) continue;
      detected_columns.push({
        column_name,
        inferred_type: str(rec.inferred_type) ?? "",
        sample_values: strArray(rec.sample_values, 3, MAX_STR),
      });
    }

    const key_identifiers = strArray(p.key_identifiers, 10, MAX_STR);
    const suggested_routing = strArray(p.suggested_routing, 10, MAX_STR);

    const ALT_CONFIDENCE_LEVELS = ["medium", "low"];
    const rawAlts = Array.isArray(p.alternative_schema_types) ? (p.alternative_schema_types as unknown[]).slice(0, 3) : [];
    const alternative_schema_types: { schema_type: string; confidence: string }[] = [];
    for (const item of rawAlts) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const altConfidence = typeof rec.confidence === "string" && ALT_CONFIDENCE_LEVELS.includes(rec.confidence) ? rec.confidence : null;
      if (!altConfidence) continue;
      alternative_schema_types.push({ schema_type: str(rec.schema_type) ?? "", confidence: altConfidence });
    }

    return {
      ok: true,
      kind: "detect_schema",
      payload: { detected_schema_type, confidence, detected_columns, key_identifiers, suggested_routing, alternative_schema_types },
    };
  }

  if (kind === "draft_board_narrative") {
    const executive_summary = typeof p.executive_summary === "string" && p.executive_summary.length > 0 ? p.executive_summary.slice(0, 1000) : null;
    if (!executive_summary) return { ok: false, reason: "missing_executive_summary" };

    const TRENDS_BN = ["up", "down", "flat"];
    const rawHighlights = Array.isArray(p.financial_highlights) ? (p.financial_highlights as unknown[]).slice(0, 10) : [];
    const financial_highlights: { metric: string; value: string; trend: string; commentary: string }[] = [];
    for (const item of rawHighlights) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const trend = typeof rec.trend === "string" && TRENDS_BN.includes(rec.trend) ? rec.trend : null;
      if (!trend) continue;
      financial_highlights.push({ metric: str(rec.metric) ?? "", value: str(rec.value) ?? "", trend, commentary: str(rec.commentary) ?? "" });
    }
    if (financial_highlights.length < 3) return { ok: false, reason: "insufficient_financial_highlights" };

    const IMPACTS_BN = ["high", "medium", "low"];
    const rawRisks = Array.isArray(p.key_risks) ? (p.key_risks as unknown[]).slice(0, 8) : [];
    const key_risks: { risk: string; impact: string; mitigation: string }[] = [];
    for (const item of rawRisks) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const impact = typeof rec.impact === "string" && IMPACTS_BN.includes(rec.impact) ? rec.impact : null;
      if (!impact) continue;
      key_risks.push({ risk: str(rec.risk) ?? "", impact, mitigation: str(rec.mitigation) ?? "" });
    }
    if (key_risks.length < 1) return { ok: false, reason: "empty_key_risks" };

    const rawOpportunities = Array.isArray(p.key_opportunities) ? (p.key_opportunities as unknown[]).slice(0, 8) : [];
    const key_opportunities: { opportunity: string; potential_impact: string; action_required: string }[] = [];
    for (const item of rawOpportunities) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const opportunity = str(rec.opportunity);
      if (!opportunity) continue;
      key_opportunities.push({ opportunity, potential_impact: str(rec.potential_impact) ?? "", action_required: str(rec.action_required) ?? "" });
    }
    if (key_opportunities.length < 1) return { ok: false, reason: "empty_key_opportunities" };

    const asks_for_board = strArray(p.asks_for_board, 5, MAX_STR);

    const rawSections = Array.isArray(p.narrative_sections) ? (p.narrative_sections as unknown[]).slice(0, 6) : [];
    const narrative_sections: { section_title: string; content: string }[] = [];
    for (const item of rawSections) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const section_title = str(rec.section_title);
      if (!section_title) continue;
      narrative_sections.push({ section_title, content: str(rec.content) ?? "" });
    }
    if (narrative_sections.length < 2) return { ok: false, reason: "insufficient_narrative_sections" };

    const TONES = ["confident", "cautious", "urgent", "neutral"];
    const tone = typeof p.tone === "string" && TONES.includes(p.tone) ? p.tone : null;
    if (!tone) return { ok: false, reason: "bad_tone" };

    const period = str(p.period);
    if (!period) return { ok: false, reason: "missing_period" };

    return {
      ok: true,
      kind: "draft_board_narrative",
      payload: { executive_summary, financial_highlights, key_risks, key_opportunities, asks_for_board, narrative_sections, tone, period },
    };
  }

  // store_report
  const title = str(p.title);
  const body = str(p.body);
  if (!title) return { ok: false, reason: "missing_title" };
  if (!body) return { ok: false, reason: "missing_body" };
  return { ok: true, kind: "store_report", payload: { title, body } };
}
