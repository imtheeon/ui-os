-- ============================================================================
-- U-I-OS Migration 0012 — Reconciliation agent
-- ============================================================================
-- Adds role 'reconciler', action kind 'reconcile_records', and the
-- reconciliation_runs record table (executor target for approved reconciliations).
-- Run once against the same DB as 0011.
-- ============================================================================

-- 1. agent_runs.role += 'reconciler'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler'));

-- 2. proposed_actions.kind += 'reconcile_records'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets','normalize_units','reconcile_records'));

-- 3. agent_accuracy.agent_role += 'reconciler'
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler'));

-- 4. reconciliation_runs — executor target (one row per approved reconcile_records action)
create table reconciliation_runs (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  payload_id         uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id uuid references proposed_actions(id),
  matched_count      int not null default 0,
  unmatched_count    int not null default 0,
  match_details      jsonb not null,
  created_at         timestamptz not null default now()
);
create index idx_reconciliation_runs_org_id on reconciliation_runs(org_id);
create index idx_reconciliation_runs_payload_id on reconciliation_runs(payload_id);

alter table reconciliation_runs enable row level security;
create policy tenant_isolation_reconciliation_runs on reconciliation_runs
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
