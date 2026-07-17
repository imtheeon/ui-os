-- ============================================================================
-- U-I-OS Migration 0205 — Org invites
-- ============================================================================
-- Allows org admins/owners to invite teammates by email. Raw tokens are
-- never stored — only their SHA-256 hash (token_hash), matching the pattern
-- used for org_api_keys.
-- ============================================================================

create table if not exists org_invites (
  id          uuid        primary key default gen_random_uuid(),
  org_id      uuid        not null references organizations(id) on delete cascade,
  email       text        not null,
  token_hash  text        not null unique, -- SHA-256 of the raw token
  role        text        not null default 'member' check (role in ('admin', 'member')),
  invited_by  uuid        not null references auth.users(id),
  accepted_at timestamptz,
  expires_at  timestamptz not null default (now() + interval '7 days'),
  created_at  timestamptz not null default now()
);

create index if not exists org_invites_org_id_idx on org_invites(org_id);

alter table org_invites enable row level security;

create policy tenant_isolation_org_invites on org_invites
  using (org_id::text = current_setting('app.current_org_id', true));
