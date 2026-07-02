-- ============================================================================
-- U-I-OS Migration 0015 — Tax Categorization agent
-- ============================================================================
-- Adds role 'tax_categorizer', action kind 'categorize_tax_items', and the
-- tax_categorization_runs record table (executor target for approved runs).
-- Run once against the same DB as 0014.
-- ============================================================================

-- 1. agent_runs.role += 'tax_categorizer'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer'));

-- 2. proposed_actions.kind += 'categorize_tax_items'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets','normalize_units','reconcile_records','match_invoices','project_cash_flow','categorize_tax_items'));

-- 3. agent_accuracy.agent_role += 'tax_categorizer'
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer'));

-- 4. tax_categorization_runs — executor target (one row per approved categorize_tax_items action)
create table tax_categorization_runs (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null references organizations(id) on delete cascade,
  payload_id                  uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id          uuid references proposed_actions(id),
  assignments                 jsonb not null,
  total_deductible_cents      bigint not null default 0,
  total_non_deductible_cents  bigint not null default 0,
  created_at                  timestamptz not null default now()
);
create index idx_tax_categorization_runs_org_id on tax_categorization_runs(org_id);
create index idx_tax_categorization_runs_payload_id on tax_categorization_runs(payload_id);

alter table tax_categorization_runs enable row level security;
create policy tenant_isolation_tax_categorization_runs on tax_categorization_runs
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
