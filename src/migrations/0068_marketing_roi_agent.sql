-- ============================================================================
-- U-I-OS Migration 0068 — Marketing ROI Agent
-- ============================================================================
-- Adds role 'marketing_roi_agent', action kind 'analyze_marketing_roi', and
-- the marketing_roi_runs record table (executor target for approved
-- analyses). Run once against the same DB as 0067.
-- ============================================================================

-- 1. agent_runs.role += 'marketing_roi_agent'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst','po_agent','trend_detector','period_comparator','exec_summarizer','forecaster','report_generator','data_quality','compliance_agent','vendor_risk','onboarding_agent','clarification_agent','multi_period','audit_summarizer','code_reviewer','code_tester','sql_analyst','validator','health_scorer','email_drafter','recommender','pattern_memory','alert_agent','client_reporter','narrator','meeting_prepper','board_deck_builder','viz_recommender','chart_config_agent','kpi_card_agent','dashboard_spec_agent','saas_metrics_agent','burn_rate_agent','cohort_agent','ar_aging_agent','ap_agent','bank_recon_agent','ratio_analysis_agent','profitability_agent','working_capital_agent','break_even_agent','cogs_analysis_agent','revenue_recognition_agent','churn_risk_agent','customer_segmentation_agent','sales_pipeline_agent','pricing_optimization_agent','contract_analysis_agent','marketing_roi_agent'));

-- 2. proposed_actions.kind += 'analyze_marketing_roi'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets','normalize_units','reconcile_records','match_invoices','project_cash_flow','categorize_tax_items','flag_duplicates','compare_budget_actual','track_inventory','flag_reorders','analyze_suppliers','process_purchase_orders','detect_trends','compare_periods','generate_exec_summary','generate_forecast','generate_report','assess_data_quality','flag_compliance_issues','assess_vendor_risk','generate_onboarding_guidance','request_clarification','analyze_multi_period','summarize_audit_trail','review_code','generate_tests','analyze_sql','validate_analysis','generate_health_score','draft_email','generate_recommendations','extract_patterns','generate_alerts','generate_client_report','generate_narrative','prepare_meeting','build_board_deck','recommend_visualizations','generate_chart_configs','extract_kpi_cards','generate_dashboard_spec','calculate_saas_metrics','calculate_burn_rate','analyze_cohorts','analyze_ar_aging','analyze_accounts_payable','reconcile_bank','analyze_financial_ratios','analyze_profitability','analyze_working_capital','calculate_break_even','analyze_cogs','analyze_revenue_recognition','analyze_churn_risk','segment_customers','analyze_sales_pipeline','analyze_pricing','analyze_contracts','analyze_marketing_roi'));

-- 3. agent_accuracy.agent_role += 'marketing_roi_agent'
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst','po_agent','trend_detector','period_comparator','exec_summarizer','forecaster','report_generator','data_quality','compliance_agent','vendor_risk','onboarding_agent','clarification_agent','multi_period','audit_summarizer','code_reviewer','code_tester','sql_analyst','validator','health_scorer','email_drafter','recommender','pattern_memory','alert_agent','client_reporter','narrator','meeting_prepper','board_deck_builder','viz_recommender','chart_config_agent','kpi_card_agent','dashboard_spec_agent','saas_metrics_agent','burn_rate_agent','cohort_agent','ar_aging_agent','ap_agent','bank_recon_agent','ratio_analysis_agent','profitability_agent','working_capital_agent','break_even_agent','cogs_analysis_agent','revenue_recognition_agent','churn_risk_agent','customer_segmentation_agent','sales_pipeline_agent','pricing_optimization_agent','contract_analysis_agent','marketing_roi_agent'));

-- 4. marketing_roi_runs — executor target (one row per approved analyze_marketing_roi action)
create table marketing_roi_runs (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null references organizations(id) on delete cascade,
  payload_id                  uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id          uuid references proposed_actions(id),
  channels                    jsonb not null,
  total_spend                 numeric not null default 0,
  total_revenue_attributed    numeric not null default 0,
  overall_roi                 numeric not null default 0,
  customer_acquisition_cost   numeric,
  best_performing_channel     text not null,
  worst_performing_channel    text not null,
  recommendations             jsonb not null,
  created_at                  timestamptz not null default now()
);
create index idx_marketing_roi_runs_org_id on marketing_roi_runs(org_id);
create index idx_marketing_roi_runs_payload_id on marketing_roi_runs(payload_id);

alter table marketing_roi_runs enable row level security;
create policy tenant_isolation_marketing_roi_runs on marketing_roi_runs
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
