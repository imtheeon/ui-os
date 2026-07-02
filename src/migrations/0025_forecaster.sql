-- ============================================================================
-- U-I-OS Migration 0025 — Forecasting agent
-- ============================================================================
-- Adds role 'forecaster', action kind 'generate_forecast', and the
-- forecast_runs record table (executor target for approved forecasts).
-- Run once against the same DB as 0024.
-- ============================================================================

-- 1. agent_runs.role += 'forecaster'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst','po_agent','trend_detector','period_comparator','exec_summarizer','forecaster'));

-- 2. proposed_actions.kind += 'generate_forecast'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets','normalize_units','reconcile_records','match_invoices','project_cash_flow','categorize_tax_items','flag_duplicates','compare_budget_actual','track_inventory','flag_reorders','analyze_suppliers','process_purchase_orders','detect_trends','compare_periods','generate_exec_summary','generate_forecast'));

-- 3. agent_accuracy.agent_role += 'forecaster'
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst','po_agent','trend_detector','period_comparator','exec_summarizer','forecaster'));

-- 4. forecast_runs — executor target (one row per approved generate_forecast action)
create table forecast_runs (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  payload_id         uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id uuid references proposed_actions(id),
  forecasts          jsonb not null,
  horizon            text not null,
  methodology        text not null,
  confidence         text not null,
  assumptions        text not null,
  created_at         timestamptz not null default now()
);
create index idx_forecast_runs_org_id on forecast_runs(org_id);
create index idx_forecast_runs_payload_id on forecast_runs(payload_id);

alter table forecast_runs enable row level security;
create policy tenant_isolation_forecast_runs on forecast_runs
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
