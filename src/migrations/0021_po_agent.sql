-- ============================================================================
-- U-I-OS Migration 0021 — Purchase Order agent
-- ============================================================================
-- Adds role 'po_agent', action kind 'process_purchase_orders', and the
-- purchase_order_runs record table (executor target for approved PO runs).
-- Run once against the same DB as 0020.
-- ============================================================================

-- 1. agent_runs.role += 'po_agent'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst','po_agent'));

-- 2. proposed_actions.kind += 'process_purchase_orders'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets','normalize_units','reconcile_records','match_invoices','project_cash_flow','categorize_tax_items','flag_duplicates','compare_budget_actual','track_inventory','flag_reorders','analyze_suppliers','process_purchase_orders'));

-- 3. agent_accuracy.agent_role += 'po_agent'
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst','po_agent'));

-- 4. purchase_order_runs — executor target (one row per approved process_purchase_orders action)
create table purchase_order_runs (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  payload_id         uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id uuid references proposed_actions(id),
  purchase_orders    jsonb not null,
  total_orders       int not null default 0,
  total_value_cents  bigint not null default 0,
  pending_count      int not null default 0,
  created_at         timestamptz not null default now()
);
create index idx_purchase_order_runs_org_id on purchase_order_runs(org_id);
create index idx_purchase_order_runs_payload_id on purchase_order_runs(payload_id);

alter table purchase_order_runs enable row level security;
create policy tenant_isolation_purchase_order_runs on purchase_order_runs
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
