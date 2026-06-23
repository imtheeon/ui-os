-- ============================================================================
-- U-I-OS Migration 0002 — Auth profiles + atomic signup
-- ============================================================================
-- Adds the bridge between Supabase Auth users (auth.users) and tenants
-- (organizations), plus a trigger that provisions an org + profile + audit
-- entry atomically when a new user signs up.
--
-- Run once against the same database that received src/schema.sql (paste into
-- the Supabase SQL editor, or psql "$DATABASE_URL" -f this file).
-- Model: ONE org per user (a profiles table), per project decision.
-- ============================================================================

-- ============================================================================
-- profiles — links exactly one auth user to exactly one organization
-- ============================================================================
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  org_id      uuid not null references organizations(id) on delete cascade,
  role        text not null default 'owner'
                check (role in ('owner', 'admin', 'member')),
  created_at  timestamptz not null default now()
);

create index idx_profiles_org_id on profiles(org_id);

-- ============================================================================
-- Atomic signup provisioning
--
-- Fires inside the same transaction as the auth.users INSERT, so a user can
-- never exist without an org. SECURITY DEFINER lets it write to
-- organizations/profiles/system_audit_logs (which RLS would otherwise block
-- for the calling role). search_path is pinned to defeat search_path
-- hijacking — a standard hardening step for SECURITY DEFINER functions.
-- ============================================================================
create function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_org_id uuid;
  resolved_org_name text;
begin
  -- Org name comes from signup metadata (options.data.org_name on the client,
  -- i.e. raw_user_meta_data here). Fall back to a safe default if absent/blank.
  resolved_org_name := coalesce(
    nullif(trim(new.raw_user_meta_data->>'org_name'), ''),
    'My Organization'
  );

  insert into organizations (name)
  values (resolved_org_name)
  returning id into new_org_id;

  -- First user of an org is its owner.
  insert into profiles (id, org_id, role)
  values (new.id, new_org_id, 'owner');

  -- Append-only audit trail of org creation. NOTE: this makes the org
  -- un-deletable via cascade thereafter (the audit-immutability trigger
  -- blocks deleting this row) — intended for a tamper-evident ledger.
  insert into system_audit_logs (org_id, action, log_meta)
  values (
    new_org_id,
    'org.created',
    jsonb_build_object(
      'user_id', new.id,
      'email', new.email,
      'source', 'signup'
    )
  );

  return new;
end;
$$;

create trigger trig_on_auth_user_created
  after insert on auth.users
  for each row
  execute function handle_new_user();

-- ============================================================================
-- Row-Level Security on profiles
--
-- A logged-in user may READ ONLY their own profile row (so the app can
-- resolve their org_id from the session). There is deliberately NO insert/
-- update/delete policy for end users: profile rows are written exclusively by
-- the SECURITY DEFINER trigger above (and the service role). This prevents a
-- user from reassigning their own org_id or escalating their role to break
-- tenant isolation.
-- ============================================================================
alter table profiles enable row level security;

create policy profiles_select_own
  on profiles
  for select
  using (id = auth.uid());
