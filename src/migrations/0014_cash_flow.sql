-- ============================================================================
-- U-I-OS Migration 0014 — Cash Flow agent
-- ============================================================================
-- Adds role 'cash_flow_agent', action kind 'project_cash_flow', and the
-- cash_flow_projections record table (executor target for approved projections).
-- Run once against the same DB as 0013.
-- ============================================================================

-- 1. agent_runs.role += 'cash_flow_agent'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent'));

-- 2. proposed_actions.kind += 'project_cash_flow'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets','normalize_units','reconcile_records','match_invoices','project_cash_flow'));

-- 3. agent_accuracy.agent_role += 'cash_flow_agent'
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent'));

-- 4. cash_flow_projections — executor target (one row per approved project_cash_flow action)
create table cash_flow_projections (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  payload_id         uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id uuid references proposed_actions(id),
  projection_period  text not null,
  inflow_cents       bigint not null default 0,
  outflow_cents      bigint not null default 0,
  net_cents          bigint not null default 0,
  runway_days        int,
  risk_level         text not null,
  summary            text not null,
  created_at         timestamptz not null default now()
);
create index idx_cash_flow_projections_org_id on cash_flow_projections(org_id);
create index idx_cash_flow_projections_payload_id on cash_flow_projections(payload_id);

alter table cash_flow_projections enable row level security;
create policy tenant_isolation_cash_flow_projections on cash_flow_projections
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
