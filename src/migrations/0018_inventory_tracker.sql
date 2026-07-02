-- ============================================================================
-- U-I-OS Migration 0018 — Inventory Tracking agent
-- ============================================================================
-- Adds role 'inventory_tracker', action kind 'track_inventory', and the
-- inventory_snapshots record table (executor target for approved snapshots).
-- Run once against the same DB as 0017.
-- ============================================================================

-- 1. agent_runs.role += 'inventory_tracker'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker'));

-- 2. proposed_actions.kind += 'track_inventory'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets','normalize_units','reconcile_records','match_invoices','project_cash_flow','categorize_tax_items','flag_duplicates','compare_budget_actual','track_inventory'));

-- 3. agent_accuracy.agent_role += 'inventory_tracker'
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker'));

-- 4. inventory_snapshots — executor target (one row per approved track_inventory action)
create table inventory_snapshots (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  payload_id         uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id uuid references proposed_actions(id),
  items              jsonb not null,
  total_items        int not null default 0,
  total_value_cents  bigint not null default 0,
  created_at         timestamptz not null default now()
);
create index idx_inventory_snapshots_org_id on inventory_snapshots(org_id);
create index idx_inventory_snapshots_payload_id on inventory_snapshots(payload_id);

alter table inventory_snapshots enable row level security;
create policy tenant_isolation_inventory_snapshots on inventory_snapshots
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
