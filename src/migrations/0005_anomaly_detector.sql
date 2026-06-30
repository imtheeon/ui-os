-- ============================================================================
-- U-I-OS Migration 0005 — Anomaly Detector agent
-- ============================================================================
-- Adds role 'anomaly_detector', action kind 'flag_anomaly', and the
-- flagged_anomalies record table (the executor target for approved flags).
-- Run once against the same DB as 0004.
-- ============================================================================

-- 1. agent_runs.role += 'anomaly_detector'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector'));

-- 2. proposed_actions.kind += 'flag_anomaly'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly'));

-- 3. flagged_anomalies — executor target (same discipline as ledger_entries)
create table flagged_anomalies (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  payload_id         uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id uuid not null references proposed_actions(id) on delete cascade,
  description        text not null,
  severity           text not null check (severity in ('low','medium','high')),
  row_reference      text not null,
  created_at         timestamptz not null default now()
);
create index idx_flagged_anomalies_org_id on flagged_anomalies(org_id);

alter table flagged_anomalies enable row level security;
create policy tenant_isolation_flagged_anomalies on flagged_anomalies
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
