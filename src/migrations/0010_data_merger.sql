-- ============================================================================
-- U-I-OS Migration 0010 — Data Merging agent
-- ============================================================================
-- Adds role 'data_merger', action kind 'merge_datasets', and the
-- merged_dataset_runs record table (executor target for approved merges).
-- Run once against the same DB as 0009.
-- ============================================================================

-- 1. agent_runs.role += 'data_merger'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger'));

-- 2. proposed_actions.kind += 'merge_datasets'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets'));

-- 2b. agent_accuracy.agent_role += 'data_merger' (0008 missed this for data_cleaner,
--     fixed in 0009 — updating it here alongside the role/kind checks so this new
--     role doesn't repeat the same silent CHECK-constraint gap).
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger'));

-- 3. merged_dataset_runs — executor target (one row per approved merge_datasets action)
create table merged_dataset_runs (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  payload_id          uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id  uuid references proposed_actions(id),
  merge_strategy      text not null,       -- e.g. "left_join", "union", "lookup"
  join_columns        jsonb not null,      -- array of column names used as join keys
  related_payload_hint text,              -- description of what the related dataset looks like
  estimated_merged_rows int,
  created_at          timestamptz not null default now()
);
create index idx_merged_dataset_runs_org_id on merged_dataset_runs(org_id);
create index idx_merged_dataset_runs_payload_id on merged_dataset_runs(payload_id);

alter table merged_dataset_runs enable row level security;
create policy tenant_isolation_merged_dataset_runs on merged_dataset_runs
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
