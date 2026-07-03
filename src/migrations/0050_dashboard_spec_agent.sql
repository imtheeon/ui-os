-- ============================================================================
-- U-I-OS Migration 0050 — Dashboard Spec Agent
-- ============================================================================
-- Adds role 'dashboard_spec_agent', action kind 'generate_dashboard_spec', and
-- the dashboard_spec_runs record table (executor target for approved specs).
-- Run once against the same DB as 0049.
-- ============================================================================

-- 1. agent_runs.role += 'dashboard_spec_agent'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst','po_agent','trend_detector','period_comparator','exec_summarizer','forecaster','report_generator','data_quality','compliance_agent','vendor_risk','onboarding_agent','clarification_agent','multi_period','audit_summarizer','code_reviewer','code_tester','sql_analyst','validator','health_scorer','email_drafter','recommender','pattern_memory','alert_agent','client_reporter','narrator','meeting_prepper','board_deck_builder','viz_recommender','chart_config_agent','kpi_card_agent','dashboard_spec_agent'));

-- 2. proposed_actions.kind += 'generate_dashboard_spec'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets','normalize_units','reconcile_records','match_invoices','project_cash_flow','categorize_tax_items','flag_duplicates','compare_budget_actual','track_inventory','flag_reorders','analyze_suppliers','process_purchase_orders','detect_trends','compare_periods','generate_exec_summary','generate_forecast','generate_report','assess_data_quality','flag_compliance_issues','assess_vendor_risk','generate_onboarding_guidance','request_clarification','analyze_multi_period','summarize_audit_trail','review_code','generate_tests','analyze_sql','validate_analysis','generate_health_score','draft_email','generate_recommendations','extract_patterns','generate_alerts','generate_client_report','generate_narrative','prepare_meeting','build_board_deck','recommend_visualizations','generate_chart_configs','extract_kpi_cards','generate_dashboard_spec'));

-- 3. agent_accuracy.agent_role += 'dashboard_spec_agent'
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst','po_agent','trend_detector','period_comparator','exec_summarizer','forecaster','report_generator','data_quality','compliance_agent','vendor_risk','onboarding_agent','clarification_agent','multi_period','audit_summarizer','code_reviewer','code_tester','sql_analyst','validator','health_scorer','email_drafter','recommender','pattern_memory','alert_agent','client_reporter','narrator','meeting_prepper','board_deck_builder','viz_recommender','chart_config_agent','kpi_card_agent','dashboard_spec_agent'));

-- 4. dashboard_spec_runs — executor target (one row per approved generate_dashboard_spec action)
create table dashboard_spec_runs (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organizations(id) on delete cascade,
  payload_id            uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id    uuid references proposed_actions(id),
  dashboard_title       text not null,
  layout                text not null,
  sections              jsonb not null,
  recommended_refresh   text not null,
  total_components      int not null default 0,
  created_at            timestamptz not null default now()
);
create index idx_dashboard_spec_runs_org_id on dashboard_spec_runs(org_id);
create index idx_dashboard_spec_runs_payload_id on dashboard_spec_runs(payload_id);

alter table dashboard_spec_runs enable row level security;
create policy tenant_isolation_dashboard_spec_runs on dashboard_spec_runs
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
