-- ============================================================================
-- Unified Intelligence OS (U-I-OS) — Core Database Schema
-- ============================================================================
-- This script is idempotent-unsafe by design (plain CREATE statements) and is
-- meant to be run once against a fresh Supabase/Postgres database. Wrap in a
-- migration tool (e.g. supabase migration, node-pg-migrate) for repeat runs.
-- ============================================================================

-- gen_random_uuid() lives in pgcrypto on most Postgres builds. Supabase
-- enables this by default, but we declare it explicitly for portability.
create extension if not exists pgcrypto;

-- ============================================================================
-- organizations
-- ============================================================================
create table organizations (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  subscription_tier  text not null default 'free'
                       check (subscription_tier in ('free', 'pro', 'enterprise')),
  created_at         timestamptz not null default now()
);

-- ============================================================================
-- inbound_payloads
-- ============================================================================
create table inbound_payloads (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  email_message_id   text not null unique,
  raw_content        text not null,
  extracted_json     jsonb,
  status             text not null default 'pending'
                       check (status in ('pending', 'processing', 'completed', 'failed', 'blocked_unauthorized_tier')),
  created_at         timestamptz not null default now()
);

create index idx_inbound_payloads_org_id on inbound_payloads(org_id);
create index idx_inbound_payloads_status on inbound_payloads(status);

-- ============================================================================
-- system_audit_logs
-- ============================================================================
create table system_audit_logs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  action      text not null,
  log_meta    jsonb,
  created_at  timestamptz not null default now()
);

create index idx_system_audit_logs_org_id on system_audit_logs(org_id);

-- ============================================================================
-- Immutable audit log protection
--
-- system_audit_logs is an append-only ledger. No application role, including
-- the service role used by src/db.ts, should ever be able to UPDATE or
-- DELETE a row once written. This trigger enforces that at the database
-- layer so it cannot be bypassed by a bug in application code.
-- ============================================================================
create function prevent_audit_log_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Security Violation: System audit logs are strictly append-only and cannot be updated or deleted.';
  return null;
end;
$$;

create trigger trig_protect_audit_logs
  before update or delete on system_audit_logs
  for each row
  execute function prevent_audit_log_mutation();

-- ============================================================================
-- Row-Level Security — multi-tenant isolation
--
-- Every tenant-scoped query must run with `app.current_org_id` set in the
-- session (e.g. via `select set_config('app.current_org_id', $1, true)` at
-- the start of a request). The service-role key used in src/db.ts bypasses
-- RLS by default, so these policies are the enforcement boundary for any
-- non-service-role (e.g. anon/authenticated) Postgres role.
-- ============================================================================
alter table organizations      enable row level security;
alter table inbound_payloads   enable row level security;
alter table system_audit_logs  enable row level security;

create policy tenant_isolation_organizations
  on organizations
  using (id = current_setting('app.current_org_id', true)::uuid)
  with check (id = current_setting('app.current_org_id', true)::uuid);

create policy tenant_isolation_inbound_payloads
  on inbound_payloads
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);

create policy tenant_isolation_system_audit_logs
  on system_audit_logs
  using (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
