/**
 * src/lib/executor.ts — the ONLY code in U-I-OS that writes a record from a
 * proposed action. The agent code path MUST NOT import this module: that hard
 * boundary is what the human approval gate relies on (an agent can only write
 * status='pending'; effects happen here, behind the gate, in a different code
 * path called only by the authed approve route).
 *
 * INTERNAL RECORDS ONLY (Phase 6). External money/records (Stripe/QuickBooks/
 * bank) are deferred to Phase 7+, behind this same registry.
 *
 * org_id is CODE-OWNED: every insert uses deps.orgId (resolved from the
 * session by the caller), never anything from action_payload.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { validateProposal } from "./agent-actions";

type ApplyOk = { ok: true; recordTable: string; recordId: string };
type ApplyErr = { ok: false; code: string; message: string };

export async function applyAction(
  action: { id: string; org_id: string; payload_id: string; kind: string; action_payload: Record<string, unknown> },
  deps: { db: SupabaseClient; orgId: string }
): Promise<ApplyOk | ApplyErr> {
  const { db, orgId } = deps;
  // Defense-in-depth: the caller loaded this row scoped to the session org, so
  // these must already match. Assert anyway — identity is code-owned.
  if (action.org_id !== orgId) {
    return { ok: false, code: "ORG_MISMATCH", message: "action does not belong to caller org" };
  }
  // Re-validate at apply time — never trust a stored payload blindly.
  const v = validateProposal(action.kind, action.action_payload);
  if (!v.ok) return { ok: false, code: "INVALID_ACTION", message: v.reason };

  if (v.kind === "record_ledger_entry") {
    const { data, error } = await db
      .from("ledger_entries")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        description: v.payload.description,
        amount_cents: v.payload.amount_cents,
        direction: v.payload.direction,
        occurred_on: v.payload.occurred_on ?? null,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "ledger_entries", recordId: data.id as string };
  }

  if (v.kind === "flag_anomaly") {
    const { data, error } = await db
      .from("flagged_anomalies")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        description: v.payload.description,
        severity: v.payload.severity,
        row_reference: v.payload.row_reference,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "flagged_anomalies", recordId: data.id as string };
  }

  if (v.kind === "categorize_items") {
    const { data, error } = await db
      .from("categorization_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        scheme: v.payload.scheme,
        assignments: v.payload.assignments,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "categorization_runs", recordId: data.id as string };
  }

  if (v.kind === "clean_data") {
    const { data, error } = await db
      .from("cleaned_data_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        issues_found: v.payload.issues,
        rows_affected: v.payload.rows_affected,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "cleaned_data_runs", recordId: data.id as string };
  }

  if (v.kind === "merge_datasets") {
    const { data, error } = await db
      .from("merged_dataset_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        merge_strategy: v.payload.merge_strategy,
        join_columns: v.payload.join_columns,
        related_payload_hint: v.payload.related_payload_hint,
        estimated_merged_rows: v.payload.estimated_merged_rows ?? null,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "merged_dataset_runs", recordId: data.id as string };
  }

  if (v.kind === "normalize_units") {
    const { data, error } = await db
      .from("normalization_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        normalizations: v.payload.normalizations,
        unit_type: v.payload.unit_type,
        target_unit: v.payload.target_unit,
        values_affected: v.payload.values_affected,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "normalization_runs", recordId: data.id as string };
  }

  if (v.kind === "reconcile_records") {
    const { data, error } = await db
      .from("reconciliation_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        matched_count: v.payload.matched_count,
        unmatched_count: v.payload.unmatched_count,
        match_details: v.payload.match_details,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "reconciliation_runs", recordId: data.id as string };
  }

  if (v.kind === "match_invoices") {
    const { data, error } = await db
      .from("invoice_matches")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        matches: v.payload.matches,
        total_matched: v.payload.total_matched,
        total_discrepancy_cents: v.payload.total_discrepancy_cents,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "invoice_matches", recordId: data.id as string };
  }

  if (v.kind === "project_cash_flow") {
    const { data, error } = await db
      .from("cash_flow_projections")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        projection_period: v.payload.projection_period,
        inflow_cents: v.payload.inflow_cents,
        outflow_cents: v.payload.outflow_cents,
        net_cents: v.payload.net_cents,
        runway_days: v.payload.runway_days ?? null,
        risk_level: v.payload.risk_level,
        summary: v.payload.summary,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "cash_flow_projections", recordId: data.id as string };
  }

  if (v.kind === "categorize_tax_items") {
    const { data, error } = await db
      .from("tax_categorization_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        assignments: v.payload.assignments,
        total_deductible_cents: v.payload.total_deductible_cents,
        total_non_deductible_cents: v.payload.total_non_deductible_cents,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "tax_categorization_runs", recordId: data.id as string };
  }

  if (v.kind === "flag_duplicates") {
    const { data, error } = await db
      .from("duplicate_flags")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        duplicates: v.payload.duplicates,
        duplicate_count: v.payload.duplicate_count,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "duplicate_flags", recordId: data.id as string };
  }

  if (v.kind === "compare_budget_actual") {
    const { data, error } = await db
      .from("budget_comparisons")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        comparisons: v.payload.comparisons,
        total_budgeted_cents: v.payload.total_budgeted_cents,
        total_actual_cents: v.payload.total_actual_cents,
        total_variance_cents: v.payload.total_variance_cents,
        overall_status: v.payload.overall_status,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "budget_comparisons", recordId: data.id as string };
  }

  if (v.kind === "track_inventory") {
    const { data, error } = await db
      .from("inventory_snapshots")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        items: v.payload.items,
        total_items: v.payload.total_items,
        total_value_cents: v.payload.total_value_cents,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "inventory_snapshots", recordId: data.id as string };
  }

  if (v.kind === "flag_reorders") {
    const { data, error } = await db
      .from("reorder_flags")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        flags: v.payload.flags,
        critical_count: v.payload.critical_count,
        warning_count: v.payload.warning_count,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "reorder_flags", recordId: data.id as string };
  }

  if (v.kind === "analyze_suppliers") {
    const { data, error } = await db
      .from("supplier_analyses")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        suppliers: v.payload.suppliers,
        total_suppliers: v.payload.total_suppliers,
        concentration_risk: v.payload.concentration_risk,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "supplier_analyses", recordId: data.id as string };
  }

  if (v.kind === "process_purchase_orders") {
    const { data, error } = await db
      .from("purchase_order_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        purchase_orders: v.payload.purchase_orders,
        total_orders: v.payload.total_orders,
        total_value_cents: v.payload.total_value_cents,
        pending_count: v.payload.pending_count,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "purchase_order_runs", recordId: data.id as string };
  }

  if (v.kind === "detect_trends") {
    const { data, error } = await db
      .from("trend_detections")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        trends: v.payload.trends,
        trend_count: v.payload.trend_count,
        overall_direction: v.payload.overall_direction,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "trend_detections", recordId: data.id as string };
  }

  if (v.kind === "compare_periods") {
    const { data, error } = await db
      .from("period_comparisons")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        comparisons: v.payload.comparisons,
        period_a_label: v.payload.period_a_label,
        period_b_label: v.payload.period_b_label,
        overall_change_pct: v.payload.overall_change_pct,
        summary: v.payload.summary,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "period_comparisons", recordId: data.id as string };
  }

  if (v.kind === "generate_exec_summary") {
    const { data, error } = await db
      .from("exec_summaries")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        headline: v.payload.headline,
        key_findings: v.payload.key_findings,
        recommended_actions: v.payload.recommended_actions,
        risk_flags: v.payload.risk_flags,
        confidence: v.payload.confidence,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "exec_summaries", recordId: data.id as string };
  }

  if (v.kind === "generate_forecast") {
    const { data, error } = await db
      .from("forecast_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        forecasts: v.payload.forecasts,
        horizon: v.payload.horizon,
        methodology: v.payload.methodology,
        confidence: v.payload.confidence,
        assumptions: v.payload.assumptions,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "forecast_runs", recordId: data.id as string };
  }

  if (v.kind === "generate_report") {
    const { data, error } = await db
      .from("generated_reports")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        report_type: v.payload.report_type,
        title: v.payload.title,
        sections: v.payload.sections,
        word_count: v.payload.word_count,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "generated_reports", recordId: data.id as string };
  }

  if (v.kind === "assess_data_quality") {
    const { data, error } = await db
      .from("data_quality_assessments")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        issues: v.payload.issues,
        quality_score: v.payload.quality_score,
        overall_grade: v.payload.overall_grade,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "data_quality_assessments", recordId: data.id as string };
  }

  if (v.kind === "flag_compliance_issues") {
    const { data, error } = await db
      .from("compliance_flags")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        flags: v.payload.flags,
        pii_detected: v.payload.pii_detected,
        risk_level: v.payload.risk_level,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "compliance_flags", recordId: data.id as string };
  }

  if (v.kind === "assess_vendor_risk") {
    const { data, error } = await db
      .from("vendor_risk_assessments")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        vendors: v.payload.vendors,
        total_vendors: v.payload.total_vendors,
        high_risk_count: v.payload.high_risk_count,
        concentration_risk: v.payload.concentration_risk,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "vendor_risk_assessments", recordId: data.id as string };
  }

  if (v.kind === "generate_onboarding_guidance") {
    const { data, error } = await db
      .from("onboarding_guidance_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        data_type_detected: v.payload.data_type_detected,
        guidance_steps: v.payload.guidance_steps,
        next_upload_suggestion: v.payload.next_upload_suggestion,
        confidence: v.payload.confidence,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "onboarding_guidance_runs", recordId: data.id as string };
  }

  if (v.kind === "request_clarification") {
    const { data, error } = await db
      .from("clarification_requests")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        questions: v.payload.questions,
        context: v.payload.context,
        urgency: v.payload.urgency,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "clarification_requests", recordId: data.id as string };
  }

  if (v.kind === "analyze_multi_period") {
    const { data, error } = await db
      .from("multi_period_analyses")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        periods_detected: v.payload.periods_detected,
        period_labels: v.payload.period_labels,
        cross_period_insights: v.payload.cross_period_insights,
        dominant_pattern: v.payload.dominant_pattern,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "multi_period_analyses", recordId: data.id as string };
  }

  if (v.kind === "summarize_audit_trail") {
    const { data, error } = await db
      .from("audit_summaries")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        events_summarized: v.payload.events_summarized,
        summary_paragraphs: v.payload.summary_paragraphs,
        key_actions: v.payload.key_actions,
        anomalies_noted: v.payload.anomalies_noted,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "audit_summaries", recordId: data.id as string };
  }

  if (v.kind === "review_code") {
    const { data, error } = await db
      .from("code_review_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        findings: v.payload.findings,
        language_detected: v.payload.language_detected,
        overall_risk: v.payload.overall_risk,
        total_issues: v.payload.total_issues,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "code_review_runs", recordId: data.id as string };
  }

  if (v.kind === "generate_tests") {
    const { data, error } = await db
      .from("test_generation_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        test_cases: v.payload.test_cases,
        language_detected: v.payload.language_detected,
        framework_suggested: v.payload.framework_suggested,
        coverage_estimate: v.payload.coverage_estimate,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "test_generation_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_sql") {
    const { data, error } = await db
      .from("sql_analysis_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        queries_found: v.payload.queries_found,
        issues: v.payload.issues,
        optimizations: v.payload.optimizations,
        risk_level: v.payload.risk_level,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "sql_analysis_runs", recordId: data.id as string };
  }

  if (v.kind === "validate_analysis") {
    const { data, error } = await db
      .from("validation_reports")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        concerns: v.payload.concerns,
        data_interpretability: v.payload.data_interpretability,
        confidence_in_swarm: v.payload.confidence_in_swarm,
        recommendation: v.payload.recommendation,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "validation_reports", recordId: data.id as string };
  }

  if (v.kind === "generate_health_score") {
    const { data, error } = await db
      .from("health_score_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        overall_score: v.payload.overall_score,
        grade: v.payload.grade,
        dimensions: v.payload.dimensions,
        summary: v.payload.summary,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "health_score_runs", recordId: data.id as string };
  }

  if (v.kind === "draft_email") {
    const { data, error } = await db
      .from("email_drafts")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        subject: v.payload.subject,
        body: v.payload.body,
        recipient_type: v.payload.recipient_type,
        tone: v.payload.tone,
        key_points: v.payload.key_points,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "email_drafts", recordId: data.id as string };
  }

  if (v.kind === "generate_recommendations") {
    const { data, error } = await db
      .from("recommendation_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        recommendations: v.payload.recommendations,
        next_upload_type: v.payload.next_upload_type,
        priority: v.payload.priority,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "recommendation_runs", recordId: data.id as string };
  }

  if (v.kind === "extract_patterns") {
    const { data, error } = await db
      .from("pattern_extractions")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        patterns: v.payload.patterns,
        pattern_count: v.payload.pattern_count,
        learnable: v.payload.learnable,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "pattern_extractions", recordId: data.id as string };
  }

  if (v.kind === "generate_alerts") {
    const { data, error } = await db
      .from("alert_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        alerts: v.payload.alerts,
        severity_level: v.payload.severity_level,
        requires_immediate_action: v.payload.requires_immediate_action,
        summary: v.payload.summary,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "alert_runs", recordId: data.id as string };
  }

  if (v.kind === "generate_client_report") {
    const { data, error } = await db
      .from("client_report_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        report_title: v.payload.report_title,
        executive_summary: v.payload.executive_summary,
        sections: v.payload.sections,
        key_takeaways: v.payload.key_takeaways,
        next_steps: v.payload.next_steps,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "client_report_runs", recordId: data.id as string };
  }

  if (v.kind === "generate_narrative") {
    const { data, error } = await db
      .from("narrative_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        headline: v.payload.headline,
        story: v.payload.story,
        tone: v.payload.tone,
        audience: v.payload.audience,
        word_count: v.payload.word_count,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "narrative_runs", recordId: data.id as string };
  }

  if (v.kind === "prepare_meeting") {
    const { data, error } = await db
      .from("meeting_prep_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        meeting_type: v.payload.meeting_type,
        agenda_items: v.payload.agenda_items,
        talking_points: v.payload.talking_points,
        questions_to_ask: v.payload.questions_to_ask,
        likely_client_questions: v.payload.likely_client_questions,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "meeting_prep_runs", recordId: data.id as string };
  }

  if (v.kind === "build_board_deck") {
    const { data, error } = await db
      .from("board_deck_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        slides: v.payload.slides,
        key_metrics: v.payload.key_metrics,
        narrative_thread: v.payload.narrative_thread,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "board_deck_runs", recordId: data.id as string };
  }

  if (v.kind === "recommend_visualizations") {
    const { data, error } = await db
      .from("viz_recommendation_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        recommendations: v.payload.recommendations,
        data_shape: v.payload.data_shape,
        total_recommended: v.payload.total_recommended,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "viz_recommendation_runs", recordId: data.id as string };
  }

  if (v.kind === "generate_chart_configs") {
    const { data, error } = await db
      .from("chart_config_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        configs: v.payload.configs,
        total_configs: v.payload.total_configs,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "chart_config_runs", recordId: data.id as string };
  }

  if (v.kind === "extract_kpi_cards") {
    const { data, error } = await db
      .from("kpi_card_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        kpi_cards: v.payload.kpi_cards,
        total_kpis: v.payload.total_kpis,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "kpi_card_runs", recordId: data.id as string };
  }

  if (v.kind === "generate_dashboard_spec") {
    const { data, error } = await db
      .from("dashboard_spec_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        dashboard_title: v.payload.dashboard_title,
        layout: v.payload.layout,
        sections: v.payload.sections,
        recommended_refresh: v.payload.recommended_refresh,
        total_components: v.payload.total_components,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "dashboard_spec_runs", recordId: data.id as string };
  }

  if (v.kind === "calculate_saas_metrics") {
    const { data, error } = await db
      .from("saas_metrics_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        mrr: v.payload.mrr,
        arr: v.payload.arr,
        churn_rate: v.payload.churn_rate,
        ltv: v.payload.ltv,
        cac: v.payload.cac,
        ltv_cac_ratio: v.payload.ltv_cac_ratio,
        net_revenue_retention: v.payload.net_revenue_retention,
        metrics_confidence: v.payload.metrics_confidence,
        available_metrics: v.payload.available_metrics,
        notes: v.payload.notes,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "saas_metrics_runs", recordId: data.id as string };
  }

  if (v.kind === "calculate_burn_rate") {
    const { data, error } = await db
      .from("burn_rate_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        monthly_burn: v.payload.monthly_burn,
        net_burn: v.payload.net_burn,
        cash_balance: v.payload.cash_balance,
        runway_months: v.payload.runway_months,
        burn_trend: v.payload.burn_trend,
        runway_status: v.payload.runway_status,
        assumptions: v.payload.assumptions,
        confidence: v.payload.confidence,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "burn_rate_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_cohorts") {
    const { data, error } = await db
      .from("cohort_analysis_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        cohorts: v.payload.cohorts,
        cohort_type: v.payload.cohort_type,
        avg_retention_m1: v.payload.avg_retention_m1,
        avg_retention_m3: v.payload.avg_retention_m3,
        trend: v.payload.trend,
        notes: v.payload.notes,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "cohort_analysis_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_ar_aging") {
    const { data, error } = await db
      .from("ar_aging_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        buckets: v.payload.buckets,
        total_ar: v.payload.total_ar,
        overdue_amount: v.payload.overdue_amount,
        overdue_percentage: v.payload.overdue_percentage,
        collection_priority: v.payload.collection_priority,
        risk_level: v.payload.risk_level,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "ar_aging_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_accounts_payable") {
    const { data, error } = await db
      .from("ap_analysis_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        total_payables: v.payload.total_payables,
        due_this_week: v.payload.due_this_week,
        due_this_month: v.payload.due_this_month,
        overdue_amount: v.payload.overdue_amount,
        vendors: v.payload.vendors,
        early_payment_opportunities: v.payload.early_payment_opportunities,
        cash_required_30_days: v.payload.cash_required_30_days,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "ap_analysis_runs", recordId: data.id as string };
  }

  if (v.kind === "reconcile_bank") {
    const { data, error } = await db
      .from("bank_recon_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        book_balance: v.payload.book_balance,
        bank_balance: v.payload.bank_balance,
        variance: v.payload.variance,
        unmatched_items: v.payload.unmatched_items,
        reconciliation_status: v.payload.reconciliation_status,
        total_unmatched: v.payload.total_unmatched,
        notes: v.payload.notes,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "bank_recon_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_financial_ratios") {
    const { data, error } = await db
      .from("ratio_analysis_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        liquidity_ratios: v.payload.liquidity_ratios,
        profitability_ratios: v.payload.profitability_ratios,
        leverage_ratios: v.payload.leverage_ratios,
        efficiency_ratios: v.payload.efficiency_ratios,
        overall_health: v.payload.overall_health,
        notes: v.payload.notes,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "ratio_analysis_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_profitability") {
    const { data, error } = await db
      .from("profitability_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        segments: v.payload.segments,
        total_revenue: v.payload.total_revenue,
        total_cost: v.payload.total_cost,
        total_gross_profit: v.payload.total_gross_profit,
        overall_margin: v.payload.overall_margin,
        most_profitable: v.payload.most_profitable,
        least_profitable: v.payload.least_profitable,
        recommendations: v.payload.recommendations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "profitability_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_working_capital") {
    const { data, error } = await db
      .from("working_capital_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        current_assets: v.payload.current_assets,
        current_liabilities: v.payload.current_liabilities,
        working_capital: v.payload.working_capital,
        current_ratio: v.payload.current_ratio,
        quick_ratio: v.payload.quick_ratio,
        days_inventory_outstanding: v.payload.days_inventory_outstanding,
        days_sales_outstanding: v.payload.days_sales_outstanding,
        days_payable_outstanding: v.payload.days_payable_outstanding,
        cash_conversion_cycle_days: v.payload.cash_conversion_cycle_days,
        status: v.payload.status,
        recommendations: v.payload.recommendations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "working_capital_runs", recordId: data.id as string };
  }

  if (v.kind === "calculate_break_even") {
    const { data, error } = await db
      .from("break_even_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        fixed_costs: v.payload.fixed_costs,
        variable_cost_per_unit: v.payload.variable_cost_per_unit,
        price_per_unit: v.payload.price_per_unit,
        break_even_units: v.payload.break_even_units,
        break_even_revenue: v.payload.break_even_revenue,
        current_units_or_revenue: v.payload.current_units_or_revenue,
        margin_of_safety: v.payload.margin_of_safety,
        margin_of_safety_percentage: v.payload.margin_of_safety_percentage,
        contribution_margin_per_unit: v.payload.contribution_margin_per_unit,
        contribution_margin_ratio: v.payload.contribution_margin_ratio,
        status: v.payload.status,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "break_even_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_cogs") {
    const { data, error } = await db
      .from("cogs_analysis_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        total_cogs: v.payload.total_cogs,
        total_revenue: v.payload.total_revenue,
        gross_profit: v.payload.gross_profit,
        gross_margin_percentage: v.payload.gross_margin_percentage,
        cogs_components: v.payload.cogs_components,
        cogs_trend: v.payload.cogs_trend,
        cost_drivers: v.payload.cost_drivers,
        optimization_opportunities: v.payload.optimization_opportunities,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "cogs_analysis_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_revenue_recognition") {
    const { data, error } = await db
      .from("revenue_recognition_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        recognized_revenue: v.payload.recognized_revenue,
        deferred_revenue: v.payload.deferred_revenue,
        recognition_method: v.payload.recognition_method,
        contracts: v.payload.contracts,
        compliance_flags: v.payload.compliance_flags,
        asc_606_notes: v.payload.asc_606_notes,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "revenue_recognition_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_churn_risk") {
    const { data, error } = await db
      .from("churn_risk_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        overall_churn_rate: v.payload.overall_churn_rate,
        at_risk_customers: v.payload.at_risk_customers,
        risk_factors: v.payload.risk_factors,
        predicted_revenue_loss: v.payload.predicted_revenue_loss,
        retention_recommendations: v.payload.retention_recommendations,
        data_period: v.payload.data_period,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "churn_risk_runs", recordId: data.id as string };
  }

  if (v.kind === "segment_customers") {
    const { data, error } = await db
      .from("customer_segmentation_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        segments: v.payload.segments,
        segmentation_method: v.payload.segmentation_method,
        total_customers: v.payload.total_customers,
        insights: v.payload.insights,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "customer_segmentation_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_sales_pipeline") {
    const { data, error } = await db
      .from("sales_pipeline_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        total_pipeline_value: v.payload.total_pipeline_value,
        weighted_pipeline_value: v.payload.weighted_pipeline_value,
        deals: v.payload.deals,
        stage_summary: v.payload.stage_summary,
        avg_deal_size: v.payload.avg_deal_size,
        avg_sales_cycle_days: v.payload.avg_sales_cycle_days,
        win_rate: v.payload.win_rate,
        forecast_this_period: v.payload.forecast_this_period,
        risks: v.payload.risks,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "sales_pipeline_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_pricing") {
    const { data, error } = await db
      .from("pricing_optimization_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        current_pricing: v.payload.current_pricing,
        price_elasticity: v.payload.price_elasticity,
        competitive_position: v.payload.competitive_position,
        optimization_opportunities: v.payload.optimization_opportunities,
        recommended_changes: v.payload.recommended_changes,
        projected_revenue_impact: v.payload.projected_revenue_impact,
        confidence: v.payload.confidence,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "pricing_optimization_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_contracts") {
    const { data, error } = await db
      .from("contract_analysis_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        contracts: v.payload.contracts,
        total_contract_value: v.payload.total_contract_value,
        total_annual_value: v.payload.total_annual_value,
        renewal_risk_summary: v.payload.renewal_risk_summary,
        upcoming_renewals: v.payload.upcoming_renewals,
        red_flags: v.payload.red_flags,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "contract_analysis_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_marketing_roi") {
    const { data, error } = await db
      .from("marketing_roi_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        channels: v.payload.channels,
        total_spend: v.payload.total_spend,
        total_revenue_attributed: v.payload.total_revenue_attributed,
        overall_roi: v.payload.overall_roi,
        customer_acquisition_cost: v.payload.customer_acquisition_cost,
        best_performing_channel: v.payload.best_performing_channel,
        worst_performing_channel: v.payload.worst_performing_channel,
        recommendations: v.payload.recommendations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "marketing_roi_runs", recordId: data.id as string };
  }

  if (v.kind === "detect_fraud_signals") {
    const { data, error } = await db
      .from("fraud_detection_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        suspicious_items: v.payload.suspicious_items,
        risk_level: v.payload.risk_level,
        fraud_patterns: v.payload.fraud_patterns,
        benford_analysis: v.payload.benford_analysis,
        total_suspicious_amount: v.payload.total_suspicious_amount,
        recommended_actions: v.payload.recommended_actions,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "fraud_detection_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_concentration_risk") {
    const { data, error } = await db
      .from("concentration_risk_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        risk_dimensions: v.payload.risk_dimensions,
        overall_risk_level: v.payload.overall_risk_level,
        herfindahl_index: v.payload.herfindahl_index,
        top_3_concentration_percentage: v.payload.top_3_concentration_percentage,
        mitigation_recommendations: v.payload.mitigation_recommendations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "concentration_risk_runs", recordId: data.id as string };
  }

  if (v.kind === "model_scenarios") {
    const { data, error } = await db
      .from("scenario_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        base_case: v.payload.base_case,
        scenarios: v.payload.scenarios,
        key_variables: v.payload.key_variables,
        recommendation: v.payload.recommendation,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "scenario_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_liquidity_risk") {
    const { data, error } = await db
      .from("liquidity_risk_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        cash_and_equivalents: v.payload.cash_and_equivalents,
        total_short_term_obligations: v.payload.total_short_term_obligations,
        liquidity_coverage_ratio: v.payload.liquidity_coverage_ratio,
        months_of_runway: v.payload.months_of_runway,
        cash_flow_forecast: v.payload.cash_flow_forecast,
        stress_scenarios: v.payload.stress_scenarios,
        risk_level: v.payload.risk_level,
        recommendations: v.payload.recommendations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "liquidity_risk_runs", recordId: data.id as string };
  }

  if (v.kind === "track_covenants") {
    const { data, error } = await db
      .from("covenant_tracking_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        covenants: v.payload.covenants,
        overall_compliance: v.payload.overall_compliance,
        violations_count: v.payload.violations_count,
        at_risk_count: v.payload.at_risk_count,
        next_test_date: v.payload.next_test_date,
        remediation_actions: v.payload.remediation_actions,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "covenant_tracking_runs", recordId: data.id as string };
  }

  if (v.kind === "classify_document") {
    const { data, error } = await db
      .from("document_classifier_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        document_type: v.payload.document_type,
        document_subtype: v.payload.document_subtype,
        confidence: v.payload.confidence,
        detected_entities: v.payload.detected_entities,
        language: v.payload.language,
        time_period: v.payload.time_period,
        currency: v.payload.currency,
        classification_notes: v.payload.classification_notes,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "document_classifier_runs", recordId: data.id as string };
  }

  if (v.kind === "detect_schema_evolution") {
    const { data, error } = await db
      .from("schema_evolution_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        columns_detected: v.payload.columns_detected,
        schema_version: v.payload.schema_version,
        breaking_changes: v.payload.breaking_changes,
        added_columns: v.payload.added_columns,
        removed_columns: v.payload.removed_columns,
        renamed_columns: v.payload.renamed_columns,
        type_changes: v.payload.type_changes,
        compatibility: v.payload.compatibility,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "schema_evolution_runs", recordId: data.id as string };
  }

  if (v.kind === "extract_kpis") {
    const { data, error } = await db
      .from("kpi_extractor_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        kpis: v.payload.kpis,
        kpi_count: v.payload.kpi_count,
        top_kpis: v.payload.top_kpis,
        data_quality: v.payload.data_quality,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "kpi_extractor_runs", recordId: data.id as string };
  }

  if (v.kind === "synthesize_insights") {
    const { data, error } = await db
      .from("insight_synthesis_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        executive_summary: v.payload.executive_summary,
        key_insights: v.payload.key_insights,
        strategic_implications: v.payload.strategic_implications,
        critical_risks: v.payload.critical_risks,
        opportunities: v.payload.opportunities,
        confidence: v.payload.confidence,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "insight_synthesis_runs", recordId: data.id as string };
  }

  if (v.kind === "detect_conflicts") {
    const { data, error } = await db
      .from("conflict_detection_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        conflicts: v.payload.conflicts,
        conflict_count: v.payload.conflict_count,
        severity: v.payload.severity,
        resolution_suggestions: v.payload.resolution_suggestions,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "conflict_detection_runs", recordId: data.id as string };
  }

  if (v.kind === "prioritize_actions") {
    const { data, error } = await db
      .from("action_priority_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        prioritized_actions: v.payload.prioritized_actions,
        top_3_actions: v.payload.top_3_actions,
        total_actions_reviewed: v.payload.total_actions_reviewed,
        decision_rationale: v.payload.decision_rationale,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "action_priority_runs", recordId: data.id as string };
  }

  if (v.kind === "profile_columns") {
    const { data, error } = await db
      .from("column_profiler_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        column_profiles: v.payload.column_profiles,
        total_rows: v.payload.total_rows,
        total_columns: v.payload.total_columns,
        overall_completeness: v.payload.overall_completeness,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "column_profiler_runs", recordId: data.id as string };
  }

  if (v.kind === "build_data_dictionary") {
    const { data, error } = await db
      .from("data_dictionary_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        entries: v.payload.entries,
        total_columns_documented: v.payload.total_columns_documented,
        undocumented_columns: v.payload.undocumented_columns,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "data_dictionary_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_missing_data") {
    const { data, error } = await db
      .from("missing_data_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        missing_summary: v.payload.missing_summary,
        critical_gaps: v.payload.critical_gaps,
        imputation_suggestions: v.payload.imputation_suggestions,
        overall_completeness: v.payload.overall_completeness,
        data_usability: v.payload.data_usability,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "missing_data_runs", recordId: data.id as string };
  }

  if (v.kind === "assess_data_privacy") {
    const { data, error } = await db
      .from("data_privacy_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        pii_fields: v.payload.pii_fields,
        sensitive_financial_fields: v.payload.sensitive_financial_fields,
        risk_level: v.payload.risk_level,
        compliance_concerns: v.payload.compliance_concerns,
        masking_recommendations: v.payload.masking_recommendations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "data_privacy_runs", recordId: data.id as string };
  }

  if (v.kind === "classify_transactions") {
    const { data, error } = await db
      .from("transaction_classifier_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        classified_transactions: v.payload.classified_transactions,
        category_summary: v.payload.category_summary,
        total_transactions: v.payload.total_transactions,
        total_amount: v.payload.total_amount,
        classification_accuracy: v.payload.classification_accuracy,
        uncategorized_count: v.payload.uncategorized_count,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "transaction_classifier_runs", recordId: data.id as string };
  }

  if (v.kind === "check_expense_policy") {
    const { data, error } = await db
      .from("expense_policy_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        violations: v.payload.violations,
        violation_count: v.payload.violation_count,
        total_policy_exception_amount: v.payload.total_policy_exception_amount,
        compliance_rate: v.payload.compliance_rate,
        policy_summary: v.payload.policy_summary,
        escalations: v.payload.escalations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "expense_policy_runs", recordId: data.id as string };
  }

  if (v.kind === "track_subscriptions") {
    const { data, error } = await db
      .from("subscription_tracker_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        subscriptions: v.payload.subscriptions,
        total_mrr: v.payload.total_mrr,
        total_arr: v.payload.total_arr,
        new_mrr: v.payload.new_mrr,
        expansion_mrr: v.payload.expansion_mrr,
        contraction_mrr: v.payload.contraction_mrr,
        churned_mrr: v.payload.churned_mrr,
        net_new_mrr: v.payload.net_new_mrr,
        subscription_count: v.payload.subscription_count,
        avg_subscription_value: v.payload.avg_subscription_value,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "subscription_tracker_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_headcount_analytics") {
    const { data, error } = await db
      .from("headcount_analytics_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        total_headcount: v.payload.total_headcount,
        headcount_by_department: v.payload.headcount_by_department,
        headcount_by_type: v.payload.headcount_by_type,
        new_hires: v.payload.new_hires,
        terminations: v.payload.terminations,
        attrition_rate: v.payload.attrition_rate,
        avg_tenure_months: v.payload.avg_tenure_months,
        revenue_per_employee: v.payload.revenue_per_employee,
        cost_per_employee: v.payload.cost_per_employee,
        open_positions: v.payload.open_positions,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "headcount_analytics_runs", recordId: data.id as string };
  }

  if (v.kind === "calculate_commissions") {
    const { data, error } = await db
      .from("commission_calculator_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        commissions: v.payload.commissions,
        total_commission_payout: v.payload.total_commission_payout,
        total_sales_value: v.payload.total_sales_value,
        effective_commission_rate: v.payload.effective_commission_rate,
        quota_attainment_summary: v.payload.quota_attainment_summary,
        disputes: v.payload.disputes,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "commission_calculator_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_productivity") {
    const { data, error } = await db
      .from("productivity_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        productivity_metrics: v.payload.productivity_metrics,
        output_per_person: v.payload.output_per_person,
        bottlenecks: v.payload.bottlenecks,
        benchmarks: v.payload.benchmarks,
        improvement_recommendations: v.payload.improvement_recommendations,
        overall_productivity_score: v.payload.overall_productivity_score,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "productivity_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_overtime") {
    const { data, error } = await db
      .from("overtime_analysis_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        overtime_records: v.payload.overtime_records,
        total_overtime_hours: v.payload.total_overtime_hours,
        total_overtime_cost: v.payload.total_overtime_cost,
        overtime_rate: v.payload.overtime_rate,
        departments_by_overtime: v.payload.departments_by_overtime,
        chronic_overtime_employees: v.payload.chronic_overtime_employees,
        risk_indicators: v.payload.risk_indicators,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "overtime_analysis_runs", recordId: data.id as string };
  }

  if (v.kind === "calculate_growth_rates") {
    const { data, error } = await db
      .from("growth_rate_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        growth_metrics: v.payload.growth_metrics,
        cagr: v.payload.cagr,
        growth_trajectory: v.payload.growth_trajectory,
        projection_12m: v.payload.projection_12m,
        projection_24m: v.payload.projection_24m,
        growth_drivers: v.payload.growth_drivers,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "growth_rate_runs", recordId: data.id as string };
  }

  if (v.kind === "explain_outliers") {
    const { data, error } = await db
      .from("outlier_explanation_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        outlier_count: v.payload.outlier_count,
        explained_count: v.payload.explained_count,
        outliers: v.payload.outliers,
        summary: v.payload.summary,
        data_period: v.payload.data_period,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "outlier_explanation_runs", recordId: data.id as string };
  }

  if (v.kind === "decompose_time_series") {
    const { data, error } = await db
      .from("time_series_decomp_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        trend_direction: v.payload.trend_direction,
        trend_strength: v.payload.trend_strength,
        seasonality_detected: v.payload.seasonality_detected,
        seasonality_period: v.payload.seasonality_period,
        cycle_length_periods: v.payload.cycle_length_periods,
        residual_variance_pct: v.payload.residual_variance_pct,
        data_points_analyzed: v.payload.data_points_analyzed,
        components: v.payload.components,
        data_period: v.payload.data_period,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "time_series_decomp_runs", recordId: data.id as string };
  }

  if (v.kind === "assess_failure_risk") {
    const { data, error } = await db
      .from("failure_risk_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        overall_risk_score: v.payload.overall_risk_score,
        risk_level: v.payload.risk_level,
        primary_risk_factors: v.payload.primary_risk_factors,
        altman_z_score: v.payload.altman_z_score,
        current_ratio: v.payload.current_ratio,
        debt_to_equity: v.payload.debt_to_equity,
        interest_coverage_ratio: v.payload.interest_coverage_ratio,
        cash_runway_months: v.payload.cash_runway_months,
        data_period: v.payload.data_period,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "failure_risk_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_unit_economics") {
    const { data, error } = await db
      .from("unit_economics_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        ltv: v.payload.ltv,
        cac: v.payload.cac,
        ltv_cac_ratio: v.payload.ltv_cac_ratio,
        payback_period_months: v.payload.payback_period_months,
        avg_contract_value: v.payload.avg_contract_value,
        gross_margin_pct: v.payload.gross_margin_pct,
        churn_rate_monthly: v.payload.churn_rate_monthly,
        magic_number: v.payload.magic_number,
        by_channel: v.payload.by_channel,
        data_period: v.payload.data_period,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "unit_economics_runs", recordId: data.id as string };
  }

  if (v.kind === "estimate_valuation") {
    const { data, error } = await db
      .from("valuation_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        arr: v.payload.arr,
        arr_multiple: v.payload.arr_multiple,
        ev_ebitda_multiple: v.payload.ev_ebitda_multiple,
        dcf_value: v.payload.dcf_value,
        comparable_low: v.payload.comparable_low,
        comparable_high: v.payload.comparable_high,
        estimated_valuation_low: v.payload.estimated_valuation_low,
        estimated_valuation_high: v.payload.estimated_valuation_high,
        primary_method: v.payload.primary_method,
        valuation_notes: v.payload.valuation_notes,
        data_period: v.payload.data_period,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "valuation_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_cap_table") {
    const { data, error } = await db
      .from("cap_table_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        total_shares_outstanding: v.payload.total_shares_outstanding,
        fully_diluted_shares: v.payload.fully_diluted_shares,
        option_pool_pct: v.payload.option_pool_pct,
        top_holder_concentration_pct: v.payload.top_holder_concentration_pct,
        founder_ownership_pct: v.payload.founder_ownership_pct,
        investor_ownership_pct: v.payload.investor_ownership_pct,
        employee_pool_pct: v.payload.employee_pool_pct,
        holders: v.payload.holders,
        data_period: v.payload.data_period,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "cap_table_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_leases") {
    const { data, error } = await db
      .from("lease_analysis_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        leases: v.payload.leases,
        total_lease_liability: v.payload.total_lease_liability,
        total_right_of_use_asset: v.payload.total_right_of_use_asset,
        annual_lease_expense: v.payload.annual_lease_expense,
        asc_842_classification_summary: v.payload.asc_842_classification_summary,
        upcoming_expirations: v.payload.upcoming_expirations,
        optimization_opportunities: v.payload.optimization_opportunities,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "lease_analysis_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_asset_register") {
    const { data, error } = await db
      .from("asset_register_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        assets: v.payload.assets,
        total_gross_value: v.payload.total_gross_value,
        total_accumulated_depreciation: v.payload.total_accumulated_depreciation,
        total_net_book_value: v.payload.total_net_book_value,
        assets_fully_depreciated: v.payload.assets_fully_depreciated,
        assets_near_end_of_life: v.payload.assets_near_end_of_life,
        annual_depreciation_charge: v.payload.annual_depreciation_charge,
        asset_class_summary: v.payload.asset_class_summary,
        replacement_needs: v.payload.replacement_needs,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "asset_register_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_price_volume_mix") {
    const { data, error } = await db
      .from("price_volume_mix_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        total_revenue_change: v.payload.total_revenue_change,
        price_effect: v.payload.price_effect,
        volume_effect: v.payload.volume_effect,
        mix_effect: v.payload.mix_effect,
        pvm_breakdown: v.payload.pvm_breakdown,
        primary_driver: v.payload.primary_driver,
        insights: v.payload.insights,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "price_volume_mix_runs", recordId: data.id as string };
  }

  if (v.kind === "build_bridge_analysis") {
    const { data, error } = await db
      .from("bridge_analysis_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        bridge_type: v.payload.bridge_type,
        opening_value: v.payload.opening_value,
        closing_value: v.payload.closing_value,
        total_change: v.payload.total_change,
        bridge_steps: v.payload.bridge_steps,
        key_insights: v.payload.key_insights,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "bridge_analysis_runs", recordId: data.id as string };
  }

  if (v.kind === "calculate_run_rate") {
    const { data, error } = await db
      .from("run_rate_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        current_period_value: v.payload.current_period_value,
        annualization_method: v.payload.annualization_method,
        annualized_run_rate: v.payload.annualized_run_rate,
        adjusted_run_rate: v.payload.adjusted_run_rate,
        run_rate_adjustments: v.payload.run_rate_adjustments,
        months_of_data_used: v.payload.months_of_data_used,
        confidence: v.payload.confidence,
        caveats: v.payload.caveats,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "run_rate_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_spend") {
    const { data, error } = await db
      .from("spend_analysis_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        total_spend: v.payload.total_spend,
        spend_by_category: v.payload.spend_by_category,
        spend_by_vendor: v.payload.spend_by_vendor,
        spend_trends: v.payload.spend_trends,
        top_opportunities: v.payload.top_opportunities,
        potential_savings: v.payload.potential_savings,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "spend_analysis_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_discounts") {
    const { data, error } = await db
      .from("discount_analysis_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        discount_summary: v.payload.discount_summary,
        total_list_price: v.payload.total_list_price,
        total_discounted_price: v.payload.total_discounted_price,
        total_discount_amount: v.payload.total_discount_amount,
        average_discount_percentage: v.payload.average_discount_percentage,
        discount_by_segment: v.payload.discount_by_segment,
        excessive_discounts: v.payload.excessive_discounts,
        revenue_leakage: v.payload.revenue_leakage,
        recommendations: v.payload.recommendations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "discount_analysis_runs", recordId: data.id as string };
  }

  if (v.kind === "detect_maverick_spend") {
    const { data, error } = await db
      .from("maverick_spend_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        maverick_transactions: v.payload.maverick_transactions,
        total_maverick_amount: v.payload.total_maverick_amount,
        maverick_percentage: v.payload.maverick_percentage,
        total_spend_analyzed: v.payload.total_spend_analyzed,
        categories_affected: v.payload.categories_affected,
        root_causes: v.payload.root_causes,
        recommendations: v.payload.recommendations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "maverick_spend_runs", recordId: data.id as string };
  }

  if (v.kind === "prioritize_collections") {
    const { data, error } = await db
      .from("collections_priority_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        accounts: v.payload.accounts,
        total_outstanding: v.payload.total_outstanding,
        total_overdue: v.payload.total_overdue,
        priority_1_amount: v.payload.priority_1_amount,
        priority_2_amount: v.payload.priority_2_amount,
        priority_3_amount: v.payload.priority_3_amount,
        collection_actions: v.payload.collection_actions,
        estimated_collectible: v.payload.estimated_collectible,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "collections_priority_runs", recordId: data.id as string };
  }

  if (v.kind === "calculate_bad_debt_provision") {
    const { data, error } = await db
      .from("bad_debt_provision_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        total_receivables: v.payload.total_receivables,
        current_provision: v.payload.current_provision,
        recommended_provision: v.payload.recommended_provision,
        provision_methodology: v.payload.provision_methodology,
        aging_analysis: v.payload.aging_analysis,
        specific_provisions: v.payload.specific_provisions,
        provision_adjustment: v.payload.provision_adjustment,
        notes: v.payload.notes,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "bad_debt_provision_runs", recordId: data.id as string };
  }

  if (v.kind === "score_credit_risk") {
    const { data, error } = await db
      .from("credit_scoring_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        customers: v.payload.customers,
        portfolio_summary: v.payload.portfolio_summary,
        high_risk_exposure: v.payload.high_risk_exposure,
        recommended_credit_limits: v.payload.recommended_credit_limits,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "credit_scoring_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_fx_exposure") {
    const { data, error } = await db
      .from("fx_exposure_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        functional_currency: v.payload.functional_currency,
        exposures: v.payload.exposures,
        total_transaction_exposure: v.payload.total_transaction_exposure,
        total_translation_exposure: v.payload.total_translation_exposure,
        net_exposure_usd_equivalent: v.payload.net_exposure_usd_equivalent,
        sensitivity_analysis: v.payload.sensitivity_analysis,
        hedging_recommendations: v.payload.hedging_recommendations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "fx_exposure_runs", recordId: data.id as string };
  }

  if (v.kind === "draft_investor_memo") {
    const { data, error } = await db
      .from("investor_memo_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        memo_title: v.payload.memo_title,
        business_overview: v.payload.business_overview,
        financial_highlights: v.payload.financial_highlights,
        key_metrics: v.payload.key_metrics,
        risks_and_mitigations: v.payload.risks_and_mitigations,
        investment_thesis: v.payload.investment_thesis,
        ask: v.payload.ask,
        use_of_proceeds: v.payload.use_of_proceeds,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "investor_memo_runs", recordId: data.id as string };
  }

  if (v.kind === "track_okrs") {
    const { data, error } = await db
      .from("okr_tracker_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        objectives: v.payload.objectives,
        overall_score: v.payload.overall_score,
        on_track_count: v.payload.on_track_count,
        at_risk_count: v.payload.at_risk_count,
        off_track_count: v.payload.off_track_count,
        key_blockers: v.payload.key_blockers,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "okr_tracker_runs", recordId: data.id as string };
  }

  if (v.kind === "conduct_swot") {
    const { data, error } = await db
      .from("swot_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        strengths: v.payload.strengths,
        weaknesses: v.payload.weaknesses,
        opportunities: v.payload.opportunities,
        threats: v.payload.threats,
        strategic_priorities: v.payload.strategic_priorities,
        overall_assessment: v.payload.overall_assessment,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "swot_runs", recordId: data.id as string };
  }

  if (v.kind === "build_queries") {
    const { data, error } = await db
      .from("query_builder_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        detected_schema: v.payload.detected_schema,
        suggested_queries: v.payload.suggested_queries,
        natural_language_questions: v.payload.natural_language_questions,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "query_builder_runs", recordId: data.id as string };
  }

  if (v.kind === "generate_esg_report") {
    const { data, error } = await db
      .from("esg_reporting_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        environmental_metrics: v.payload.environmental_metrics,
        social_metrics: v.payload.social_metrics,
        governance_metrics: v.payload.governance_metrics,
        esg_score: v.payload.esg_score,
        key_highlights: v.payload.key_highlights,
        gaps_and_recommendations: v.payload.gaps_and_recommendations,
        reporting_framework: v.payload.reporting_framework,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "esg_reporting_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_seasonality") {
    const { data, error } = await db
      .from("seasonality_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        metric_name: v.payload.metric_name,
        seasonal_indices: v.payload.seasonal_indices,
        peak_season: v.payload.peak_season,
        trough_season: v.payload.trough_season,
        year_over_year_comparison: v.payload.year_over_year_comparison,
        seasonality_strength: v.payload.seasonality_strength,
        business_implications: v.payload.business_implications,
        planning_recommendations: v.payload.planning_recommendations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "seasonality_runs", recordId: data.id as string };
  }

  if (v.kind === "benchmark_performance") {
    const { data, error } = await db
      .from("benchmark_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        industry: v.payload.industry,
        company_stage: v.payload.company_stage,
        benchmarks: v.payload.benchmarks,
        overall_performance: v.payload.overall_performance,
        standout_strengths: v.payload.standout_strengths,
        underperforming_areas: v.payload.underperforming_areas,
        peer_comparison_notes: v.payload.peer_comparison_notes,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "benchmark_runs", recordId: data.id as string };
  }

  if (v.kind === "consolidate_entities") {
    const { data, error } = await db
      .from("consolidation_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        entities: v.payload.entities,
        intercompany_eliminations: v.payload.intercompany_eliminations,
        consolidated_revenue: v.payload.consolidated_revenue,
        consolidated_costs: v.payload.consolidated_costs,
        consolidated_profit: v.payload.consolidated_profit,
        minority_interests: v.payload.minority_interests,
        fx_translation_adjustments: v.payload.fx_translation_adjustments,
        consolidation_notes: v.payload.consolidation_notes,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "consolidation_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_ecommerce") {
    const { data, error } = await db
      .from("ecommerce_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        gmv: v.payload.gmv,
        net_revenue: v.payload.net_revenue,
        take_rate: v.payload.take_rate,
        order_count: v.payload.order_count,
        average_order_value: v.payload.average_order_value,
        conversion_rate: v.payload.conversion_rate,
        cart_abandonment_rate: v.payload.cart_abandonment_rate,
        top_products: v.payload.top_products,
        channel_breakdown: v.payload.channel_breakdown,
        fulfillment_metrics: v.payload.fulfillment_metrics,
        growth_insights: v.payload.growth_insights,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "ecommerce_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_professional_services") {
    const { data, error } = await db
      .from("professional_services_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        utilization_rate: v.payload.utilization_rate,
        billable_hours: v.payload.billable_hours,
        total_hours: v.payload.total_hours,
        average_bill_rate: v.payload.average_bill_rate,
        revenue_per_consultant: v.payload.revenue_per_consultant,
        wip_value: v.payload.wip_value,
        project_profitability: v.payload.project_profitability,
        staff_utilization: v.payload.staff_utilization,
        realization_rate: v.payload.realization_rate,
        recommendations: v.payload.recommendations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "professional_services_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_nonprofit_financials") {
    const { data, error } = await db
      .from("nonprofit_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        revenue_by_source: v.payload.revenue_by_source,
        total_revenue: v.payload.total_revenue,
        program_expenses: v.payload.program_expenses,
        administrative_expenses: v.payload.administrative_expenses,
        fundraising_expenses: v.payload.fundraising_expenses,
        total_expenses: v.payload.total_expenses,
        program_efficiency_ratio: v.payload.program_efficiency_ratio,
        fundraising_efficiency_ratio: v.payload.fundraising_efficiency_ratio,
        months_of_reserves: v.payload.months_of_reserves,
        donor_metrics: v.payload.donor_metrics,
        grant_pipeline: v.payload.grant_pipeline,
        compliance_notes: v.payload.compliance_notes,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "nonprofit_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_healthcare_financials") {
    const { data, error } = await db
      .from("healthcare_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        net_patient_revenue: v.payload.net_patient_revenue,
        gross_charges: v.payload.gross_charges,
        contractual_adjustments: v.payload.contractual_adjustments,
        bad_debt_expense: v.payload.bad_debt_expense,
        payor_mix: v.payload.payor_mix,
        cost_per_patient_encounter: v.payload.cost_per_patient_encounter,
        days_in_ar: v.payload.days_in_ar,
        denial_rate: v.payload.denial_rate,
        clean_claim_rate: v.payload.clean_claim_rate,
        quality_metrics: v.payload.quality_metrics,
        revenue_cycle_insights: v.payload.revenue_cycle_insights,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "healthcare_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_legal_billing") {
    const { data, error } = await db
      .from("legal_billing_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        matters: v.payload.matters,
        total_billed: v.payload.total_billed,
        total_collected: v.payload.total_collected,
        collection_rate: v.payload.collection_rate,
        average_hourly_rate: v.payload.average_hourly_rate,
        timekeeper_summary: v.payload.timekeeper_summary,
        writeoffs_and_discounts: v.payload.writeoffs_and_discounts,
        aging_wip: v.payload.aging_wip,
        billing_flags: v.payload.billing_flags,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "legal_billing_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_hospitality_financials") {
    const { data, error } = await db
      .from("hospitality_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        occupancy_rate: v.payload.occupancy_rate,
        adr: v.payload.adr,
        revpar: v.payload.revpar,
        total_rooms: v.payload.total_rooms,
        room_revenue: v.payload.room_revenue,
        fb_revenue: v.payload.fb_revenue,
        other_revenue: v.payload.other_revenue,
        total_revenue: v.payload.total_revenue,
        goppar: v.payload.goppar,
        cost_per_occupied_room: v.payload.cost_per_occupied_room,
        channel_mix: v.payload.channel_mix,
        performance_vs_stly: v.payload.performance_vs_stly,
        revenue_management_insights: v.payload.revenue_management_insights,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "hospitality_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_retail_performance") {
    const { data, error } = await db
      .from("retail_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        total_net_sales: v.payload.total_net_sales,
        comparable_store_sales_growth: v.payload.comparable_store_sales_growth,
        gross_margin_percentage: v.payload.gross_margin_percentage,
        inventory_turnover: v.payload.inventory_turnover,
        sell_through_rate: v.payload.sell_through_rate,
        shrinkage_rate: v.payload.shrinkage_rate,
        sales_per_sqft: v.payload.sales_per_sqft,
        transactions_per_day: v.payload.transactions_per_day,
        average_transaction_value: v.payload.average_transaction_value,
        store_breakdown: v.payload.store_breakdown,
        category_performance: v.payload.category_performance,
        markdown_analysis: v.payload.markdown_analysis,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "retail_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_construction_financials") {
    const { data, error } = await db
      .from("construction_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        projects: v.payload.projects,
        total_contract_value: v.payload.total_contract_value,
        total_earned_value: v.payload.total_earned_value,
        total_costs_to_date: v.payload.total_costs_to_date,
        total_remaining_costs: v.payload.total_remaining_costs,
        overall_gross_margin: v.payload.overall_gross_margin,
        overbillings: v.payload.overbillings,
        underbillings: v.payload.underbillings,
        backlog_value: v.payload.backlog_value,
        wip_schedule: v.payload.wip_schedule,
        risk_summary: v.payload.risk_summary,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "construction_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_revenue_quality") {
    const { data, error } = await db
      .from("revenue_quality_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        recurring_revenue_pct: v.payload.recurring_revenue_pct,
        non_recurring_revenue_pct: v.payload.non_recurring_revenue_pct,
        top_customer_concentration_pct: v.payload.top_customer_concentration_pct,
        revenue_predictability_score: v.payload.revenue_predictability_score,
        arr_growth_rate_pct: v.payload.arr_growth_rate_pct,
        net_revenue_retention_pct: v.payload.net_revenue_retention_pct,
        churn_adjusted_arr: v.payload.churn_adjusted_arr,
        revenue_by_type: v.payload.revenue_by_type,
        data_period: v.payload.data_period,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "revenue_quality_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_customer_cohorts") {
    const { data, error } = await db
      .from("customer_cohort_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        cohorts: v.payload.cohorts,
        cohort_type: v.payload.cohort_type,
        avg_month1_retention: v.payload.avg_month1_retention,
        avg_month3_retention: v.payload.avg_month3_retention,
        avg_month6_retention: v.payload.avg_month6_retention,
        avg_month12_retention: v.payload.avg_month12_retention,
        best_cohort: v.payload.best_cohort,
        worst_cohort: v.payload.worst_cohort,
        trend: v.payload.trend,
        data_period: v.payload.data_period,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "customer_cohort_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_variances") {
    const { data, error } = await db
      .from("variance_analysis_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        variances: v.payload.variances,
        total_budget: v.payload.total_budget,
        total_actual: v.payload.total_actual,
        total_variance: v.payload.total_variance,
        total_variance_pct: v.payload.total_variance_pct,
        favorable_count: v.payload.favorable_count,
        unfavorable_count: v.payload.unfavorable_count,
        significant_variances: v.payload.significant_variances,
        root_causes: v.payload.root_causes,
        period: v.payload.period,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "variance_analysis_runs", recordId: data.id as string };
  }

  if (v.kind === "forecast_cash_flow") {
    const { data, error } = await db
      .from("cash_flow_forecast_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        opening_cash_balance: v.payload.opening_cash_balance,
        weekly_forecast: v.payload.weekly_forecast,
        total_inflows: v.payload.total_inflows,
        total_outflows: v.payload.total_outflows,
        closing_cash_balance: v.payload.closing_cash_balance,
        minimum_cash_week: v.payload.minimum_cash_week,
        minimum_cash_amount: v.payload.minimum_cash_amount,
        cash_constraint_risk: v.payload.cash_constraint_risk,
        assumptions: v.payload.assumptions,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "cash_flow_forecast_runs", recordId: data.id as string };
  }

  if (v.kind === "forecast_expenses") {
    const { data, error } = await db
      .from("expense_forecast_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        historical_monthly_avg: v.payload.historical_monthly_avg,
        forecast_periods: v.payload.forecast_periods,
        total_forecast_amount: v.payload.total_forecast_amount,
        growth_rate_applied: v.payload.growth_rate_applied,
        largest_categories: v.payload.largest_categories,
        fixed_vs_variable: v.payload.fixed_vs_variable,
        confidence: v.payload.confidence,
        period_label: v.payload.period_label,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "expense_forecast_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_headcount") {
    const { data, error } = await db
      .from("headcount_analysis_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        total_headcount: v.payload.total_headcount,
        total_payroll_cost: v.payload.total_payroll_cost,
        cost_per_head: v.payload.cost_per_head,
        by_department: v.payload.by_department,
        by_level: v.payload.by_level,
        headcount_revenue_ratio: v.payload.headcount_revenue_ratio,
        compensation_revenue_pct: v.payload.compensation_revenue_pct,
        open_roles: v.payload.open_roles,
        attrition_rate: v.payload.attrition_rate,
        period: v.payload.period,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "headcount_analysis_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_debt_covenants") {
    const { data, error } = await db
      .from("debt_covenant_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        covenants: v.payload.covenants,
        overall_status: v.payload.overall_status,
        breach_count: v.payload.breach_count,
        at_risk_count: v.payload.at_risk_count,
        nearest_breach: v.payload.nearest_breach,
        total_debt_outstanding: v.payload.total_debt_outstanding,
        debt_service_coverage_ratio: v.payload.debt_service_coverage_ratio,
        recommendations: v.payload.recommendations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "debt_covenant_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_tax_provision") {
    const { data, error } = await db
      .from("tax_provision_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        pre_tax_income: v.payload.pre_tax_income,
        estimated_tax_provision: v.payload.estimated_tax_provision,
        effective_tax_rate: v.payload.effective_tax_rate,
        statutory_rate: v.payload.statutory_rate,
        rate_reconciliation: v.payload.rate_reconciliation,
        deferred_tax_assets: v.payload.deferred_tax_assets,
        deferred_tax_liabilities: v.payload.deferred_tax_liabilities,
        net_deferred_tax_position: v.payload.net_deferred_tax_position,
        tax_risk_flags: v.payload.tax_risk_flags,
        period: v.payload.period,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "tax_provision_runs", recordId: data.id as string };
  }

  if (v.kind === "manage_collections") {
    const { data, error } = await db
      .from("collections_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        total_ar_balance: v.payload.total_ar_balance,
        overdue_balance: v.payload.overdue_balance,
        overdue_pct: v.payload.overdue_pct,
        priority_accounts: v.payload.priority_accounts,
        aging_summary: v.payload.aging_summary,
        collection_drafts: v.payload.collection_drafts,
        avg_days_outstanding: v.payload.avg_days_outstanding,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "collections_runs", recordId: data.id as string };
  }

  if (v.kind === "benchmark_competitive") {
    const { data, error } = await db
      .from("competitive_benchmarking_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        client_metrics: v.payload.client_metrics,
        benchmark_comparisons: v.payload.benchmark_comparisons,
        performance_quartile: v.payload.performance_quartile,
        strengths: v.payload.strengths,
        weaknesses: v.payload.weaknesses,
        industry_context: v.payload.industry_context,
        data_period: v.payload.data_period,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "competitive_benchmarking_runs", recordId: data.id as string };
  }

  if (v.kind === "evaluate_data_quality") {
    const { data, error } = await db
      .from("data_quality_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        overall_score: v.payload.overall_score,
        row_count: v.payload.row_count,
        column_count: v.payload.column_count,
        completeness_score: v.payload.completeness_score,
        consistency_score: v.payload.consistency_score,
        outlier_count: v.payload.outlier_count,
        issues: v.payload.issues,
        usable_for_analysis: v.payload.usable_for_analysis,
        recommended_agents: v.payload.recommended_agents,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "data_quality_runs", recordId: data.id as string };
  }

  if (v.kind === "detect_schema") {
    const { data, error } = await db
      .from("schema_detection_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        detected_schema_type: v.payload.detected_schema_type,
        confidence: v.payload.confidence,
        detected_columns: v.payload.detected_columns,
        key_identifiers: v.payload.key_identifiers,
        suggested_routing: v.payload.suggested_routing,
        alternative_schema_types: v.payload.alternative_schema_types,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "schema_detection_runs", recordId: data.id as string };
  }

  if (v.kind === "draft_board_narrative") {
    const { data, error } = await db
      .from("board_narrative_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        executive_summary: v.payload.executive_summary,
        financial_highlights: v.payload.financial_highlights,
        key_risks: v.payload.key_risks,
        key_opportunities: v.payload.key_opportunities,
        asks_for_board: v.payload.asks_for_board,
        narrative_sections: v.payload.narrative_sections,
        tone: v.payload.tone,
        period: v.payload.period,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "board_narrative_runs", recordId: data.id as string };
  }

  if (v.kind === "draft_investor_update") {
    const { data, error } = await db
      .from("investor_update_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        subject_line: v.payload.subject_line,
        headline_metric: v.payload.headline_metric,
        kpi_summary: v.payload.kpi_summary,
        wins: v.payload.wins,
        challenges: v.payload.challenges,
        asks: v.payload.asks,
        next_period_targets: v.payload.next_period_targets,
        full_draft: v.payload.full_draft,
        period: v.payload.period,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "investor_update_runs", recordId: data.id as string };
  }

  if (v.kind === "orchestrate_agents") {
    const { data, error } = await db
      .from("orchestrator_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        data_summary: v.payload.data_summary,
        recommended_agents: v.payload.recommended_agents,
        skip_agents: v.payload.skip_agents,
        execution_order: v.payload.execution_order,
        routing_rationale: v.payload.routing_rationale,
        estimated_insights: v.payload.estimated_insights,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "orchestrator_runs", recordId: data.id as string };
  }

  if (v.kind === "review_confidence") {
    const { data, error } = await db
      .from("confidence_reviewer_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        reviewed_proposals: v.payload.reviewed_proposals,
        overall_confidence: v.payload.overall_confidence,
        high_confidence_count: v.payload.high_confidence_count,
        medium_confidence_count: v.payload.medium_confidence_count,
        low_confidence_count: v.payload.low_confidence_count,
        flags: v.payload.flags,
        approval_recommendation: v.payload.approval_recommendation,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "confidence_reviewer_runs", recordId: data.id as string };
  }

  if (v.kind === "reshape_data") {
    const { data, error } = await db
      .from("data_reshape_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        source_shape: v.payload.source_shape,
        target_shape: v.payload.target_shape,
        id_columns: v.payload.id_columns,
        variable_column: v.payload.variable_column,
        value_column: v.payload.value_column,
        reshaped_preview: v.payload.reshaped_preview,
        row_count_before: v.payload.row_count_before,
        row_count_after: v.payload.row_count_after,
        column_count_before: v.payload.column_count_before,
        column_count_after: v.payload.column_count_after,
        reshape_notes: v.payload.reshape_notes,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "data_reshape_runs", recordId: data.id as string };
  }

  if (v.kind === "normalize_dates") {
    const { data, error } = await db
      .from("date_normalization_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        detected_formats: v.payload.detected_formats,
        target_format: v.payload.target_format,
        normalization_map: v.payload.normalization_map,
        ambiguous_dates: v.payload.ambiguous_dates,
        timezone_issues: v.payload.timezone_issues,
        rows_affected: v.payload.rows_affected,
        columns_affected: v.payload.columns_affected,
        recommendations: v.payload.recommendations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "date_normalization_runs", recordId: data.id as string };
  }

  if (v.kind === "normalize_strings") {
    const { data, error } = await db
      .from("string_normalization_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        columns_analyzed: v.payload.columns_analyzed,
        whitespace_issues: v.payload.whitespace_issues,
        case_standardization: v.payload.case_standardization,
        entity_dedup_candidates: v.payload.entity_dedup_candidates,
        encoding_issues: v.payload.encoding_issues,
        total_values_affected: v.payload.total_values_affected,
        normalization_rules: v.payload.normalization_rules,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "string_normalization_runs", recordId: data.id as string };
  }

  if (v.kind === "normalize_currency") {
    const { data, error } = await db
      .from("currency_normalization_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        currencies_detected: v.payload.currencies_detected,
        base_currency: v.payload.base_currency,
        conversion_needed: v.payload.conversion_needed,
        rows_with_mixed_currency: v.payload.rows_with_mixed_currency,
        normalization_issues: v.payload.normalization_issues,
        conversion_recommendations: v.payload.conversion_recommendations,
        columns_affected: v.payload.columns_affected,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "currency_normalization_runs", recordId: data.id as string };
  }

  if (v.kind === "assess_join_quality") {
    const { data, error } = await db
      .from("join_quality_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        left_dataset_profile: v.payload.left_dataset_profile,
        right_dataset_profile: v.payload.right_dataset_profile,
        recommended_join_keys: v.payload.recommended_join_keys,
        join_type_recommendation: v.payload.join_type_recommendation,
        match_quality: v.payload.match_quality,
        unmatched_left_count: v.payload.unmatched_left_count,
        unmatched_right_count: v.payload.unmatched_right_count,
        duplicate_key_issues: v.payload.duplicate_key_issues,
        data_quality_flags: v.payload.data_quality_flags,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "join_quality_runs", recordId: data.id as string };
  }

  if (v.kind === "validate_data_rules") {
    const { data, error } = await db
      .from("data_validation_rules_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        rules_generated: v.payload.rules_generated,
        violations_found: v.payload.violations_found,
        validation_summary: v.payload.validation_summary,
        recommendations: v.payload.recommendations,
        data_readiness: v.payload.data_readiness,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "data_validation_rules_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_distribution") {
    const { data, error } = await db
      .from("distribution_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        columns_analyzed: v.payload.columns_analyzed,
        distribution_summary: v.payload.distribution_summary,
        skewness_flags: v.payload.skewness_flags,
        outlier_summary: v.payload.outlier_summary,
        normality_assessment: v.payload.normality_assessment,
        visualization_recommendations: v.payload.visualization_recommendations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "distribution_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_correlation") {
    const { data, error } = await db
      .from("correlation_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        correlation_pairs: v.payload.correlation_pairs,
        strong_correlations: v.payload.strong_correlations,
        surprising_correlations: v.payload.surprising_correlations,
        multicollinearity_flags: v.payload.multicollinearity_flags,
        business_insights: v.payload.business_insights,
        columns_included: v.payload.columns_included,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "correlation_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_regression") {
    const { data, error } = await db
      .from("regression_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        dependent_variable: v.payload.dependent_variable,
        independent_variables: v.payload.independent_variables,
        regression_type: v.payload.regression_type,
        model_fit: v.payload.model_fit,
        coefficients: v.payload.coefficients,
        predictions: v.payload.predictions,
        model_warnings: v.payload.model_warnings,
        business_interpretation: v.payload.business_interpretation,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "regression_runs", recordId: data.id as string };
  }

  if (v.kind === "test_hypothesis") {
    const { data, error } = await db
      .from("hypothesis_testing_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        tests_performed: v.payload.tests_performed,
        significant_findings: v.payload.significant_findings,
        non_significant_findings: v.payload.non_significant_findings,
        effect_sizes: v.payload.effect_sizes,
        recommended_actions: v.payload.recommended_actions,
        statistical_caveats: v.payload.statistical_caveats,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "hypothesis_testing_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_pareto") {
    const { data, error } = await db
      .from("pareto_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        analysis_dimension: v.payload.analysis_dimension,
        value_metric: v.payload.value_metric,
        pareto_entries: v.payload.pareto_entries,
        eighty_twenty_threshold: v.payload.eighty_twenty_threshold,
        concentration_score: v.payload.concentration_score,
        long_tail_count: v.payload.long_tail_count,
        business_implications: v.payload.business_implications,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "pareto_runs", recordId: data.id as string };
  }

  if (v.kind === "cluster_data") {
    const { data, error } = await db
      .from("clustering_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        clustering_dimensions: v.payload.clustering_dimensions,
        cluster_count: v.payload.cluster_count,
        clusters: v.payload.clusters,
        cluster_quality: v.payload.cluster_quality,
        outlier_entities: v.payload.outlier_entities,
        business_segments: v.payload.business_segments,
        recommended_actions: v.payload.recommended_actions,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "clustering_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_funnel") {
    const { data, error } = await db
      .from("funnel_analysis_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        funnel_name: v.payload.funnel_name,
        funnel_stages: v.payload.funnel_stages,
        overall_conversion_rate: v.payload.overall_conversion_rate,
        biggest_drop_off_stage: v.payload.biggest_drop_off_stage,
        drop_off_analysis: v.payload.drop_off_analysis,
        segment_breakdowns: v.payload.segment_breakdowns,
        optimization_recommendations: v.payload.optimization_recommendations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "funnel_analysis_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_retention") {
    const { data, error } = await db
      .from("retention_analysis_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        cohort_type: v.payload.cohort_type,
        cohorts: v.payload.cohorts,
        average_retention_by_period: v.payload.average_retention_by_period,
        retention_curve_shape: v.payload.retention_curve_shape,
        critical_drop_off_period: v.payload.critical_drop_off_period,
        churn_drivers: v.payload.churn_drivers,
        retention_benchmarks: v.payload.retention_benchmarks,
        improvement_recommendations: v.payload.improvement_recommendations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "retention_analysis_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_ab_test") {
    const { data, error } = await db
      .from("ab_test_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        test_name: v.payload.test_name,
        hypothesis: v.payload.hypothesis,
        variants: v.payload.variants,
        primary_metric: v.payload.primary_metric,
        statistical_result: v.payload.statistical_result,
        winner: v.payload.winner,
        effect_size: v.payload.effect_size,
        sample_size_adequacy: v.payload.sample_size_adequacy,
        segment_effects: v.payload.segment_effects,
        recommendation: v.payload.recommendation,
        caveats: v.payload.caveats,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "ab_test_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_nps") {
    const { data, error } = await db
      .from("nps_analysis_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        nps_score: v.payload.nps_score,
        promoter_count: v.payload.promoter_count,
        passive_count: v.payload.passive_count,
        detractor_count: v.payload.detractor_count,
        total_responses: v.payload.total_responses,
        promoter_pct: v.payload.promoter_pct,
        passive_pct: v.payload.passive_pct,
        detractor_pct: v.payload.detractor_pct,
        top_promoter_themes: v.payload.top_promoter_themes,
        top_detractor_themes: v.payload.top_detractor_themes,
        segment_nps: v.payload.segment_nps,
        trend_assessment: v.payload.trend_assessment,
        action_priorities: v.payload.action_priorities,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "nps_analysis_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_feature_adoption") {
    const { data, error } = await db
      .from("feature_adoption_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        features_analyzed: v.payload.features_analyzed,
        adoption_summary: v.payload.adoption_summary,
        power_features: v.payload.power_features,
        underutilized_features: v.payload.underutilized_features,
        adoption_by_segment: v.payload.adoption_by_segment,
        correlation_with_retention: v.payload.correlation_with_retention,
        recommendations: v.payload.recommendations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "feature_adoption_runs", recordId: data.id as string };
  }

  if (v.kind === "score_customer_health") {
    const { data, error } = await db
      .from("customer_health_score_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        scored_customers: v.payload.scored_customers,
        score_components: v.payload.score_components,
        health_distribution: v.payload.health_distribution,
        high_risk_customers: v.payload.high_risk_customers,
        champion_customers: v.payload.champion_customers,
        model_confidence: v.payload.model_confidence,
        recommended_playbooks: v.payload.recommended_playbooks,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "customer_health_score_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_quota_attainment") {
    const { data, error } = await db
      .from("quota_attainment_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        period: v.payload.period,
        team_attainment_pct: v.payload.team_attainment_pct,
        rep_attainments: v.payload.rep_attainments,
        attainment_distribution: v.payload.attainment_distribution,
        at_risk_reps: v.payload.at_risk_reps,
        top_performers: v.payload.top_performers,
        quota_setting_assessment: v.payload.quota_setting_assessment,
        recommendations: v.payload.recommendations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "quota_attainment_runs", recordId: data.id as string };
  }

  if (v.kind === "analyze_win_loss") {
    const { data, error } = await db
      .from("win_loss_runs")
      .insert({
        org_id: orgId, // CODE-OWNED
        payload_id: action.payload_id,
        proposed_action_id: action.id,
        period: v.payload.period,
        total_opportunities: v.payload.total_opportunities,
        won_count: v.payload.won_count,
        lost_count: v.payload.lost_count,
        win_rate_pct: v.payload.win_rate_pct,
        win_factors: v.payload.win_factors,
        loss_factors: v.payload.loss_factors,
        competitor_analysis: v.payload.competitor_analysis,
        deal_characteristic_analysis: v.payload.deal_characteristic_analysis,
        win_rate_by_segment: v.payload.win_rate_by_segment,
        recommendations: v.payload.recommendations,
      })
      .select("id")
      .single();
    if (error) return { ok: false, code: "DB_ERROR", message: error.message };
    return { ok: true, recordTable: "win_loss_runs", recordId: data.id as string };
  }

  const { data, error } = await db
    .from("analyst_reports")
    .insert({
      org_id: orgId, // CODE-OWNED
      payload_id: action.payload_id,
      proposed_action_id: action.id,
      title: v.payload.title,
      body: v.payload.body,
    })
    .select("id")
    .single();
  if (error) return { ok: false, code: "DB_ERROR", message: error.message };
  return { ok: true, recordTable: "analyst_reports", recordId: data.id as string };
}
