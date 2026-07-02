/**
 * src/lib/agent-actions.ts — the typed action registry shared by the executor
 * and the agent handler. Defines WHICH action kinds exist and validates a
 * model-proposed payload for each. Validation is a SECURITY boundary: the LLM
 * supplies content; code decides whether it is a legal, bounded action of a
 * known kind before any row is ever written. Unknown kind / bad shape → reject.
 */
export const ACTION_KINDS = ["record_ledger_entry", "store_report", "flag_anomaly", "categorize_items", "clean_data", "merge_datasets", "normalize_units", "reconcile_records", "match_invoices", "project_cash_flow", "categorize_tax_items", "flag_duplicates", "compare_budget_actual", "track_inventory", "flag_reorders", "analyze_suppliers", "process_purchase_orders", "detect_trends", "compare_periods", "generate_exec_summary", "generate_forecast", "generate_report", "assess_data_quality", "flag_compliance_issues", "assess_vendor_risk", "generate_onboarding_guidance", "request_clarification", "analyze_multi_period"] as const;
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

  // store_report
  const title = str(p.title);
  const body = str(p.body);
  if (!title) return { ok: false, reason: "missing_title" };
  if (!body) return { ok: false, reason: "missing_body" };
  return { ok: true, kind: "store_report", payload: { title, body } };
}
