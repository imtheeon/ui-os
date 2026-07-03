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
