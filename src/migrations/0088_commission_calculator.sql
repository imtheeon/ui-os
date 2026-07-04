-- ============================================================================
-- U-I-OS Migration 0088 — Commission Calculator
-- ============================================================================
-- Adds role 'commission_calculator', action kind 'calculate_commissions', and
-- the commission_calculator_runs record table (executor target for approved
-- analyses). Run once against the same DB as 0087.
-- ============================================================================

-- 1. agent_runs.role += 'commission_calculator'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst','po_agent','trend_detector','period_comparator','exec_summarizer','forecaster','report_generator','data_quality','compliance_agent','vendor_risk','onboarding_agent','clarification_agent','multi_period','audit_summarizer','code_reviewer','code_tester','sql_analyst','validator','health_scorer','email_drafter','recommender','pattern_memory','alert_agent','client_reporter','narrator','meeting_prepper','board_deck_builder','viz_recommender','chart_config_agent','kpi_card_agent','dashboard_spec_agent','saas_metrics_agent','burn_rate_agent','cohort_agent','ar_aging_agent','ap_agent','bank_recon_agent','ratio_analysis_agent','profitability_agent','working_capital_agent','break_even_agent','cogs_analysis_agent','revenue_recognition_agent','churn_risk_agent','customer_segmentation_agent','sales_pipeline_agent','pricing_optimization_agent','contract_analysis_agent','marketing_roi_agent','fraud_detection_agent','concentration_risk_agent','scenario_agent','liquidity_risk_agent','covenant_tracking_agent','document_classifier','schema_evolution_agent','kpi_extractor','insight_synthesis_agent','conflict_detection_agent','action_priority_agent','column_profiler','data_dictionary_agent','missing_data_agent','data_privacy_agent','transaction_classifier','expense_policy_agent','subscription_tracker','headcount_analytics_agent','commission_calculator'));

-- 2. proposed_actions.kind += 'calculate_commissions'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets','normalize_units','reconcile_records','match_invoices','project_cash_flow','categorize_tax_items','flag_duplicates','compare_budget_actual','track_inventory','flag_reorders','analyze_suppliers','process_purchase_orders','detect_trends','compare_periods','generate_exec_summary','generate_forecast','generate_report','assess_data_quality','flag_compliance_issues','assess_vendor_risk','generate_onboarding_guidance','request_clarification','analyze_multi_period','summarize_audit_trail','review_code','generate_tests','analyze_sql','validate_analysis','generate_health_score','draft_email','generate_recommendations','extract_patterns','generate_alerts','generate_client_report','generate_narrative','prepare_meeting','build_board_deck','recommend_visualizations','generate_chart_configs','extract_kpi_cards','generate_dashboard_spec','calculate_saas_metrics','calculate_burn_rate','analyze_cohorts','analyze_ar_aging','analyze_accounts_payable','reconcile_bank','analyze_financial_ratios','analyze_profitability','analyze_working_capital','calculate_break_even','analyze_cogs','analyze_revenue_recognition','analyze_churn_risk','segment_customers','analyze_sales_pipeline','analyze_pricing','analyze_contracts','analyze_marketing_roi','detect_fraud_signals','analyze_concentration_risk','model_scenarios','analyze_liquidity_risk','track_covenants','classify_document','detect_schema_evolution','extract_kpis','synthesize_insights','detect_conflicts','prioritize_actions','profile_columns','build_data_dictionary','analyze_missing_data','assess_data_privacy','classify_transactions','check_expense_policy','track_subscriptions','analyze_headcount_analytics','calculate_commissions'));

-- 3. agent_accuracy.agent_role += 'commission_calculator'
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst','po_agent','trend_detector','period_comparator','exec_summarizer','forecaster','report_generator','data_quality','compliance_agent','vendor_risk','onboarding_agent','clarification_agent','multi_period','audit_summarizer','code_reviewer','code_tester','sql_analyst','validator','health_scorer','email_drafter','recommender','pattern_memory','alert_agent','client_reporter','narrator','meeting_prepper','board_deck_builder','viz_recommender','chart_config_agent','kpi_card_agent','dashboard_spec_agent','saas_metrics_agent','burn_rate_agent','cohort_agent','ar_aging_agent','ap_agent','bank_recon_agent','ratio_analysis_agent','profitability_agent','working_capital_agent','break_even_agent','cogs_analysis_agent','revenue_recognition_agent','churn_risk_agent','customer_segmentation_agent','sales_pipeline_agent','pricing_optimization_agent','contract_analysis_agent','marketing_roi_agent','fraud_detection_agent','concentration_risk_agent','scenario_agent','liquidity_risk_agent','covenant_tracking_agent','document_classifier','schema_evolution_agent','kpi_extractor','insight_synthesis_agent','conflict_detection_agent','action_priority_agent','column_profiler','data_dictionary_agent','missing_data_agent','data_privacy_agent','transaction_classifier','expense_policy_agent','subscription_tracker','headcount_analytics_agent','commission_calculator'));

-- 4. commission_calculator_runs — executor target (one row per approved calculate_commissions action)
create table commission_calculator_runs (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null references organizations(id) on delete cascade,
  payload_id                  uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id          uuid references proposed_actions(id),
  commissions                 jsonb not null,
  total_commission_payout     numeric not null default 0,
  total_sales_value           numeric not null default 0,
  effective_commission_rate   numeric,
  quota_attainment_summary    jsonb not null,
  disputes                    jsonb not null,
  created_at                  timestamptz not null default now()
);
create index idx_commission_calculator_runs_org_id on commission_calculator_runs(org_id);
create index idx_commission_calculator_runs_payload_id on commission_calculator_runs(payload_id);

alter table commission_calculator_runs enable row level security;
create policy tenant_isolation_commission_calculator_runs on commission_calculator_runs
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
