-- ============================================================================
-- U-I-OS Migration 0020 — Supplier Analysis agent
-- ============================================================================
-- Adds role 'supplier_analyst', action kind 'analyze_suppliers', and the
-- supplier_analyses record table (executor target for approved analyses).
-- Run once against the same DB as 0019.
-- ============================================================================

-- 1. agent_runs.role += 'supplier_analyst'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst'));

-- 2. proposed_actions.kind += 'analyze_suppliers'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets','normalize_units','reconcile_records','match_invoices','project_cash_flow','categorize_tax_items','flag_duplicates','compare_budget_actual','track_inventory','flag_reorders','analyze_suppliers'));

-- 3. agent_accuracy.agent_role += 'supplier_analyst'
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst'));

-- 4. supplier_analyses — executor target (one row per approved analyze_suppliers action)
create table supplier_analyses (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  payload_id          uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id  uuid references proposed_actions(id),
  suppliers           jsonb not null,
  total_suppliers     int not null default 0,
  concentration_risk  text not null,
  created_at          timestamptz not null default now()
);
create index idx_supplier_analyses_org_id on supplier_analyses(org_id);
create index idx_supplier_analyses_payload_id on supplier_analyses(payload_id);

alter table supplier_analyses enable row level security;
create policy tenant_isolation_supplier_analyses on supplier_analyses
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
