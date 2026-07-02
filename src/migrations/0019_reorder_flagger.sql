-- ============================================================================
-- U-I-OS Migration 0019 — Reorder Flagging agent
-- ============================================================================
-- Adds role 'reorder_flagger', action kind 'flag_reorders', and the
-- reorder_flags record table (executor target for approved reorder flags).
-- Run once against the same DB as 0018.
-- ============================================================================

-- 1. agent_runs.role += 'reorder_flagger'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger'));

-- 2. proposed_actions.kind += 'flag_reorders'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets','normalize_units','reconcile_records','match_invoices','project_cash_flow','categorize_tax_items','flag_duplicates','compare_budget_actual','track_inventory','flag_reorders'));

-- 3. agent_accuracy.agent_role += 'reorder_flagger'
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger'));

-- 4. reorder_flags — executor target (one row per approved flag_reorders action)
create table reorder_flags (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  payload_id         uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id uuid references proposed_actions(id),
  flags              jsonb not null,
  critical_count     int not null default 0,
  warning_count      int not null default 0,
  created_at         timestamptz not null default now()
);
create index idx_reorder_flags_org_id on reorder_flags(org_id);
create index idx_reorder_flags_payload_id on reorder_flags(payload_id);

alter table reorder_flags enable row level security;
create policy tenant_isolation_reorder_flags on reorder_flags
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
