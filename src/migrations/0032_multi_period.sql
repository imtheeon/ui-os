-- ============================================================================
-- U-I-OS Migration 0032 — Multi-Period Analysis agent
-- ============================================================================
-- Adds role 'multi_period', action kind 'analyze_multi_period', and the
-- multi_period_analyses record table (executor target for approved analyses).
-- Run once against the same DB as 0031.
-- ============================================================================

-- 1. agent_runs.role += 'multi_period'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst','po_agent','trend_detector','period_comparator','exec_summarizer','forecaster','report_generator','data_quality','compliance_agent','vendor_risk','onboarding_agent','clarification_agent','multi_period'));

-- 2. proposed_actions.kind += 'analyze_multi_period'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets','normalize_units','reconcile_records','match_invoices','project_cash_flow','categorize_tax_items','flag_duplicates','compare_budget_actual','track_inventory','flag_reorders','analyze_suppliers','process_purchase_orders','detect_trends','compare_periods','generate_exec_summary','generate_forecast','generate_report','assess_data_quality','flag_compliance_issues','assess_vendor_risk','generate_onboarding_guidance','request_clarification','analyze_multi_period'));

-- 3. agent_accuracy.agent_role += 'multi_period'
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst','po_agent','trend_detector','period_comparator','exec_summarizer','forecaster','report_generator','data_quality','compliance_agent','vendor_risk','onboarding_agent','clarification_agent','multi_period'));

-- 4. multi_period_analyses — executor target (one row per approved analyze_multi_period action)
create table multi_period_analyses (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references organizations(id) on delete cascade,
  payload_id             uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id     uuid references proposed_actions(id),
  periods_detected       int not null default 0,
  period_labels          jsonb not null,
  cross_period_insights  jsonb not null,
  dominant_pattern       text not null,
  created_at             timestamptz not null default now()
);
create index idx_multi_period_analyses_org_id on multi_period_analyses(org_id);
create index idx_multi_period_analyses_payload_id on multi_period_analyses(payload_id);

alter table multi_period_analyses enable row level security;
create policy tenant_isolation_multi_period_analyses on multi_period_analyses
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
