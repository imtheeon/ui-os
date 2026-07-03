/**
 * src/lib/agent-actions.ts — the typed action registry shared by the executor
 * and the agent handler. Defines WHICH action kinds exist and validates a
 * model-proposed payload for each. Validation is a SECURITY boundary: the LLM
 * supplies content; code decides whether it is a legal, bounded action of a
 * known kind before any row is ever written. Unknown kind / bad shape → reject.
 */
export const ACTION_KINDS = ["record_ledger_entry", "store_report", "flag_anomaly", "categorize_items", "clean_data", "merge_datasets", "normalize_units", "reconcile_records", "match_invoices", "project_cash_flow", "categorize_tax_items", "flag_duplicates", "compare_budget_actual", "track_inventory", "flag_reorders", "analyze_suppliers", "process_purchase_orders", "detect_trends", "compare_periods", "generate_exec_summary", "generate_forecast", "generate_report", "assess_data_quality", "flag_compliance_issues", "assess_vendor_risk", "generate_onboarding_guidance", "request_clarification", "analyze_multi_period", "summarize_audit_trail", "review_code", "generate_tests", "analyze_sql", "validate_analysis", "generate_health_score", "draft_email", "generate_recommendations", "extract_patterns", "generate_alerts", "generate_client_report", "generate_narrative", "prepare_meeting", "build_board_deck", "recommend_visualizations", "generate_chart_configs", "extract_kpi_cards", "generate_dashboard_spec", "calculate_saas_metrics", "calculate_burn_rate", "analyze_cohorts", "analyze_ar_aging", "analyze_accounts_payable", "reconcile_bank", "analyze_financial_ratios", "analyze_profitability", "analyze_working_capital", "calculate_break_even", "analyze_cogs", "analyze_revenue_recognition", "analyze_churn_risk", "segment_customers", "analyze_sales_pipeline", "analyze_pricing", "analyze_contracts", "analyze_marketing_roi", "detect_fraud_signals", "analyze_concentration_risk", "model_scenarios", "analyze_liquidity_risk", "track_covenants", "classify_document", "detect_schema_evolution"] as const;
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

  // store_report
  const title = str(p.title);
  const body = str(p.body);
  if (!title) return { ok: false, reason: "missing_title" };
  if (!body) return { ok: false, reason: "missing_body" };
  return { ok: true, kind: "store_report", payload: { title, body } };
}
