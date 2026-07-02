-- ============================================================================
-- U-I-OS Migration 0016 — Duplicate Detection agent
-- ============================================================================
-- Adds role 'duplicate_detector', action kind 'flag_duplicates', and the
-- duplicate_flags record table (executor target for approved duplicate flags).
-- Run once against the same DB as 0015.
-- ============================================================================

-- 1. agent_runs.role += 'duplicate_detector'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector'));

-- 2. proposed_actions.kind += 'flag_duplicates'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets','normalize_units','reconcile_records','match_invoices','project_cash_flow','categorize_tax_items','flag_duplicates'));

-- 3. agent_accuracy.agent_role += 'duplicate_detector'
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector'));

-- 4. duplicate_flags — executor target (one row per approved flag_duplicates action)
create table duplicate_flags (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  payload_id         uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id uuid references proposed_actions(id),
  duplicates         jsonb not null,
  duplicate_count    int not null default 0,
  created_at         timestamptz not null default now()
);
create index idx_duplicate_flags_org_id on duplicate_flags(org_id);
create index idx_duplicate_flags_payload_id on duplicate_flags(payload_id);

alter table duplicate_flags enable row level security;
create policy tenant_isolation_duplicate_flags on duplicate_flags
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
