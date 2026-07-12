-- ============================================================================
-- U-I-OS Migration 0192 — BigQuery Connections (infrastructure, not an agent)
-- ============================================================================
-- Stores encrypted BigQuery service-account credentials per org, used by
-- bigquery-connector.ts (executor-only). Does NOT touch any agent CHECK
-- constraints (agent_runs.role, proposed_actions.kind, agent_accuracy.agent_role)
-- since this is not an agent.
-- ============================================================================

create table bigquery_connections (
  id                              uuid primary key default gen_random_uuid(),
  org_id                          uuid not null references organizations(id) on delete cascade,
  connection_name                 text not null,
  gcp_project_id                  text not null,
  service_account_key_encrypted   text not null,
  default_dataset_id              text not null default '',
  is_active                       boolean not null default true,
  last_tested_at                  timestamptz,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  unique (org_id, connection_name)
);

create index idx_bigquery_connections_org_id on bigquery_connections(org_id);

alter table bigquery_connections enable row level security;
create policy tenant_isolation_bigquery_connections on bigquery_connections
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);

create or replace function update_bigquery_connections_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trig_bigquery_connections_updated_at
  before update on bigquery_connections
  for each row execute function update_bigquery_connections_updated_at();
