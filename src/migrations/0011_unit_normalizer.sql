-- ============================================================================
-- U-I-OS Migration 0011 — Currency/Unit Normalizer agent
-- ============================================================================
-- Adds role 'unit_normalizer', action kind 'normalize_units', and the
-- normalization_runs record table (executor target for approved normalizations).
-- Run once against the same DB as 0010.
-- ============================================================================

-- 1. agent_runs.role += 'unit_normalizer'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer'));

-- 2. proposed_actions.kind += 'normalize_units'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets','normalize_units'));

-- 3. agent_accuracy.agent_role += 'unit_normalizer'
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer'));

-- 4. normalization_runs — executor target (one row per approved normalize_units action)
create table normalization_runs (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  payload_id         uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id uuid references proposed_actions(id),
  normalizations     jsonb not null,
  unit_type          text not null,
  target_unit        text not null,
  values_affected    int not null default 0,
  created_at         timestamptz not null default now()
);
create index idx_normalization_runs_org_id on normalization_runs(org_id);
create index idx_normalization_runs_payload_id on normalization_runs(payload_id);

alter table normalization_runs enable row level security;
create policy tenant_isolation_normalization_runs on normalization_runs
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
