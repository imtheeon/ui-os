/**
 * src/lib/agent-actions.ts — the typed action registry shared by the executor
 * and the agent handler. Defines WHICH action kinds exist and validates a
 * model-proposed payload for each. Validation is a SECURITY boundary: the LLM
 * supplies content; code decides whether it is a legal, bounded action of a
 * known kind before any row is ever written. Unknown kind / bad shape → reject.
 */
export const ACTION_KINDS = ["record_ledger_entry", "store_report", "flag_anomaly", "categorize_items", "clean_data", "merge_datasets", "normalize_units", "reconcile_records", "match_invoices", "project_cash_flow", "categorize_tax_items", "flag_duplicates", "compare_budget_actual"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

const MAX_STR = 2_000; // clamp every string field (DoS + bounded storage)
const MAX_AMOUNT_CENTS = 1_000_000_000_00; // $1B sanity ceiling

type Ok = { ok: true; kind: ActionKind; payload: Record<string, unknown> };
type Err = { ok: false; reason: string };

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, MAX_STR) : null;
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

  // store_report
  const title = str(p.title);
  const body = str(p.body);
  if (!title) return { ok: false, reason: "missing_title" };
  if (!body) return { ok: false, reason: "missing_body" };
  return { ok: true, kind: "store_report", payload: { title, body } };
}
