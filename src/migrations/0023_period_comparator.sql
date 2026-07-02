-- ============================================================================
-- U-I-OS Migration 0023 — Period Comparison agent
-- ============================================================================
-- Adds role 'period_comparator', action kind 'compare_periods', and the
-- period_comparisons record table (executor target for approved comparisons).
-- Run once against the same DB as 0022.
-- ============================================================================

-- 1. agent_runs.role += 'period_comparator'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst','po_agent','trend_detector','period_comparator'));

-- 2. proposed_actions.kind += 'compare_periods'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets','normalize_units','reconcile_records','match_invoices','project_cash_flow','categorize_tax_items','flag_duplicates','compare_budget_actual','track_inventory','flag_reorders','analyze_suppliers','process_purchase_orders','detect_trends','compare_periods'));

-- 3. agent_accuracy.agent_role += 'period_comparator'
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst','po_agent','trend_detector','period_comparator'));

-- 4. period_comparisons — executor target (one row per approved compare_periods action)
create table period_comparisons (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  payload_id          uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id  uuid references proposed_actions(id),
  comparisons         jsonb not null,
  period_a_label      text not null,
  period_b_label      text not null,
  overall_change_pct  numeric not null default 0,
  summary             text not null,
  created_at          timestamptz not null default now()
);
create index idx_period_comparisons_org_id on period_comparisons(org_id);
create index idx_period_comparisons_payload_id on period_comparisons(payload_id);

alter table period_comparisons enable row level security;
create policy tenant_isolation_period_comparisons on period_comparisons
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
