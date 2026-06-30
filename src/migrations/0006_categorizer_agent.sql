-- ============================================================================
-- U-I-OS Migration 0006 — Categorizer agent
-- ============================================================================
-- Adds role 'categorizer', action kind 'categorize_items', and the
-- categorization_runs record table (executor target for approved categorizations).
-- Run once against the same DB as 0005.
-- ============================================================================

-- 1. agent_runs.role += 'categorizer'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer'));

-- 2. proposed_actions.kind += 'categorize_items'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items'));

-- 3. categorization_runs — executor target (one row per approved categorize_items action)
create table categorization_runs (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  payload_id         uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id uuid not null references proposed_actions(id) on delete cascade,
  scheme             text not null,
  assignments        jsonb not null,
  created_at         timestamptz not null default now()
);
create index idx_categorization_runs_org_id on categorization_runs(org_id);

alter table categorization_runs enable row level security;
create policy tenant_isolation_categorization_runs on categorization_runs
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
