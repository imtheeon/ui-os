-- ============================================================================
-- U-I-OS Migration 0027 — Data Quality agent
-- ============================================================================
-- Adds role 'data_quality', action kind 'assess_data_quality', and the
-- data_quality_assessments record table (executor target for approved
-- assessments).
-- Run once against the same DB as 0026.
-- ============================================================================

-- 1. agent_runs.role += 'data_quality'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst','po_agent','trend_detector','period_comparator','exec_summarizer','forecaster','report_generator','data_quality'));

-- 2. proposed_actions.kind += 'assess_data_quality'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets','normalize_units','reconcile_records','match_invoices','project_cash_flow','categorize_tax_items','flag_duplicates','compare_budget_actual','track_inventory','flag_reorders','analyze_suppliers','process_purchase_orders','detect_trends','compare_periods','generate_exec_summary','generate_forecast','generate_report','assess_data_quality'));

-- 3. agent_accuracy.agent_role += 'data_quality'
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst','po_agent','trend_detector','period_comparator','exec_summarizer','forecaster','report_generator','data_quality'));

-- 4. data_quality_assessments — executor target (one row per approved assess_data_quality action)
create table data_quality_assessments (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  payload_id         uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id uuid references proposed_actions(id),
  issues             jsonb not null,
  quality_score      int not null,
  overall_grade      text not null,
  created_at         timestamptz not null default now()
);
create index idx_data_quality_assessments_org_id on data_quality_assessments(org_id);
create index idx_data_quality_assessments_payload_id on data_quality_assessments(payload_id);

alter table data_quality_assessments enable row level security;
create policy tenant_isolation_data_quality_assessments on data_quality_assessments
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
