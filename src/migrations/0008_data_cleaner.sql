-- ============================================================================
-- U-I-OS Migration 0008 — Data Cleaning agent
-- ============================================================================
-- Adds role 'data_cleaner', action kind 'clean_data', and the
-- cleaned_data_runs record table (executor target for approved cleanups).
-- Run once against the same DB as 0007.
-- ============================================================================

-- 1. agent_runs.role += 'data_cleaner'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner'));

-- 2. proposed_actions.kind += 'clean_data'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data'));

-- 3. cleaned_data_runs — executor target (one row per approved clean_data action)
create table cleaned_data_runs (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  payload_id         uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id uuid references proposed_actions(id),
  issues_found       jsonb not null, -- array of {row_reference, column, issue_type, original_value, suggested_value}
  rows_affected      int not null default 0,
  created_at         timestamptz not null default now()
);
create index idx_cleaned_data_runs_org_id on cleaned_data_runs(org_id);
create index idx_cleaned_data_runs_payload_id on cleaned_data_runs(payload_id);

alter table cleaned_data_runs enable row level security;
create policy tenant_isolation_cleaned_data_runs on cleaned_data_runs
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
