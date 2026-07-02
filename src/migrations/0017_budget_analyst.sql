-- ============================================================================
-- U-I-OS Migration 0017 — Budget vs Actual agent
-- ============================================================================
-- Adds role 'budget_analyst', action kind 'compare_budget_actual', and the
-- budget_comparisons record table (executor target for approved comparisons).
-- Run once against the same DB as 0016.
-- ============================================================================

-- 1. agent_runs.role += 'budget_analyst'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst'));

-- 2. proposed_actions.kind += 'compare_budget_actual'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets','normalize_units','reconcile_records','match_invoices','project_cash_flow','categorize_tax_items','flag_duplicates','compare_budget_actual'));

-- 3. agent_accuracy.agent_role += 'budget_analyst'
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst'));

-- 4. budget_comparisons — executor target (one row per approved compare_budget_actual action)
create table budget_comparisons (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organizations(id) on delete cascade,
  payload_id            uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id    uuid references proposed_actions(id),
  comparisons           jsonb not null,
  total_budgeted_cents  bigint not null default 0,
  total_actual_cents    bigint not null default 0,
  total_variance_cents  bigint not null default 0,
  overall_status        text not null,
  created_at            timestamptz not null default now()
);
create index idx_budget_comparisons_org_id on budget_comparisons(org_id);
create index idx_budget_comparisons_payload_id on budget_comparisons(payload_id);

alter table budget_comparisons enable row level security;
create policy tenant_isolation_budget_comparisons on budget_comparisons
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
