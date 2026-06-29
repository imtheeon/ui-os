-- ============================================================================
-- U-I-OS Migration 0004 — Ruflo agent swarm
-- ============================================================================
-- Adds the swarm's four tables. agent_runs = observability; proposed_actions =
-- the human-approval gate; ledger_entries / analyst_reports = the internal
-- records the executor writes on approval. All org-scoped + RLS, identical
-- discipline to schema.sql / 0002 / 0003. Run once (Supabase SQL editor or
-- psql -f) against the same database.
-- ============================================================================

-- ── agent_runs ───────────────────────────────────────────────────────────
create table agent_runs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  payload_id    uuid not null references inbound_payloads(id) on delete cascade,
  role          text not null check (role in ('manager','accountant','analyst')),
  status        text not null default 'pending'
                  check (status in ('pending','running','completed','failed','skipped_tier')),
  -- model id ('claude-haiku-4-5' / 'claude-sonnet-4-6') or 'stub'; NULL for the
  -- deterministic Manager (no model).
  brain         text,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  error         text,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index idx_agent_runs_org_id on agent_runs(org_id);
create index idx_agent_runs_payload on agent_runs(org_id, payload_id);

-- ── proposed_actions (the gate) ────────────────────────────────────────────
create table proposed_actions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  payload_id     uuid not null references inbound_payloads(id) on delete cascade,
  agent_run_id   uuid not null references agent_runs(id) on delete cascade,
  kind           text not null
                   check (kind in ('record_ledger_entry','store_report')),
  action_payload jsonb not null,
  rationale      text not null,
  status         text not null default 'pending'
                   check (status in ('pending','approved','rejected','applied','apply_failed')),
  decided_by     uuid,
  decided_at     timestamptz,
  applied_at     timestamptz,
  created_at     timestamptz not null default now()
);
create index idx_proposed_actions_org_id on proposed_actions(org_id);
-- Fast lookup of an org's pending queue for the dashboard.
create index idx_proposed_actions_pending
  on proposed_actions(org_id, created_at)
  where status = 'pending';

-- ── internal record tables (executor targets) ─────────────────────────────
create table ledger_entries (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  payload_id         uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id uuid not null references proposed_actions(id) on delete cascade,
  description        text not null,
  amount_cents       bigint not null,
  direction          text not null check (direction in ('debit','credit')),
  occurred_on        date,
  created_at         timestamptz not null default now()
);
create index idx_ledger_entries_org_id on ledger_entries(org_id);

create table analyst_reports (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  payload_id         uuid not null references inbound_payloads(id) on delete cascade,
  proposed_action_id uuid not null references proposed_actions(id) on delete cascade,
  title              text not null,
  body               text not null,
  created_at         timestamptz not null default now()
);
create index idx_analyst_reports_org_id on analyst_reports(org_id);

-- ── RLS — tenant isolation (matches schema.sql) ────────────────────────────
alter table agent_runs       enable row level security;
alter table proposed_actions enable row level security;
alter table ledger_entries   enable row level security;
alter table analyst_reports  enable row level security;

create policy tenant_isolation_agent_runs on agent_runs
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
create policy tenant_isolation_proposed_actions on proposed_actions
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
create policy tenant_isolation_ledger_entries on ledger_entries
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
create policy tenant_isolation_analyst_reports on analyst_reports
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
