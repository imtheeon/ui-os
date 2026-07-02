-- ============================================================================
-- U-I-OS Migration 0013 — Invoice Matching agent
-- ============================================================================
-- Adds role 'invoice_matcher', action kind 'match_invoices', and the
-- invoice_matches record table (executor target for approved matches).
-- Run once against the same DB as 0012.
-- ============================================================================

-- 1. agent_runs.role += 'invoice_matcher'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher'));

-- 2. proposed_actions.kind += 'match_invoices'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets','normalize_units','reconcile_records','match_invoices'));

-- 3. agent_accuracy.agent_role += 'invoice_matcher'
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher'));

-- 4. invoice_matches — executor target (one row per approved match_invoices action)
create table invoice_matches (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references organizations(id) on delete cascade,
  payload_id              uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id      uuid references proposed_actions(id),
  matches                 jsonb not null,
  total_matched           int not null default 0,
  total_discrepancy_cents bigint not null default 0,
  created_at              timestamptz not null default now()
);
create index idx_invoice_matches_org_id on invoice_matches(org_id);
create index idx_invoice_matches_payload_id on invoice_matches(payload_id);

alter table invoice_matches enable row level security;
create policy tenant_isolation_invoice_matches on invoice_matches
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
