-- ============================================================================
-- U-I-OS Migration 0022 — Trend Detection agent
-- ============================================================================
-- Adds role 'trend_detector', action kind 'detect_trends', and the
-- trend_detections record table (executor target for approved detections).
-- Run once against the same DB as 0021.
-- ============================================================================

-- 1. agent_runs.role += 'trend_detector'
alter table agent_runs drop constraint if exists agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('manager','accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst','po_agent','trend_detector'));

-- 2. proposed_actions.kind += 'detect_trends'
alter table proposed_actions drop constraint if exists proposed_actions_kind_check;
alter table proposed_actions add constraint proposed_actions_kind_check
  check (kind in ('record_ledger_entry','store_report','flag_anomaly','categorize_items','clean_data','merge_datasets','normalize_units','reconcile_records','match_invoices','project_cash_flow','categorize_tax_items','flag_duplicates','compare_budget_actual','track_inventory','flag_reorders','analyze_suppliers','process_purchase_orders','detect_trends'));

-- 3. agent_accuracy.agent_role += 'trend_detector'
alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner','data_merger','unit_normalizer','reconciler','invoice_matcher','cash_flow_agent','tax_categorizer','duplicate_detector','budget_analyst','inventory_tracker','reorder_flagger','supplier_analyst','po_agent','trend_detector'));

-- 4. trend_detections — executor target (one row per approved detect_trends action)
create table trend_detections (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  payload_id         uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id uuid references proposed_actions(id),
  trends             jsonb not null,
  trend_count        int not null default 0,
  overall_direction  text not null,
  created_at         timestamptz not null default now()
);
create index idx_trend_detections_org_id on trend_detections(org_id);
create index idx_trend_detections_payload_id on trend_detections(payload_id);

alter table trend_detections enable row level security;
create policy tenant_isolation_trend_detections on trend_detections
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
