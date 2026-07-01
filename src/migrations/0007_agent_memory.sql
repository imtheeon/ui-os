-- ============================================================================
-- U-I-OS Migration 0007 — Agent memory and learning system
-- ============================================================================
-- Creates org_memory (learned patterns per org) and agent_accuracy
-- (per-agent approval rates per org). Both tables are RLS-protected and
-- org-scoped. Run once against the same DB as 0006.
-- ============================================================================

-- 1. org_memory — one row per (org, memory_type, memory_key) pattern.
--    Confidence starts at 0.5 (neutral); approved → +0.1, rejected → -0.2.
create table org_memory (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  memory_type        text not null check (memory_type in (
                       'vendor_category','spend_baseline','anomaly_pattern',
                       'client_preference','dashboard_style','code_pattern')),
  memory_key         text not null,
  memory_value       jsonb not null,
  confidence_score   float not null default 0.5
                       check (confidence_score between 0.0 and 1.0),
  times_confirmed    int not null default 0,
  times_rejected     int not null default 0,
  first_seen_at      timestamptz not null default now(),
  last_confirmed_at  timestamptz,
  source_agent       text not null,
  proposed_action_id uuid references proposed_actions(id) on delete set null,

  unique (org_id, memory_type, memory_key)
);
create index idx_org_memory_org_confidence
  on org_memory(org_id, confidence_score desc);

alter table org_memory enable row level security;
create policy tenant_isolation_org_memory on org_memory
  using  (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);

-- 2. agent_accuracy — one row per (org, agent_role).
--    approval_rate is a GENERATED STORED column: always consistent with counts.
create table agent_accuracy (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  agent_role       text not null check (agent_role in (
                     'accountant','analyst','anomaly_detector','categorizer')),
  total_proposals  int not null default 0,
  approved_count   int not null default 0,
  rejected_count   int not null default 0,
  approval_rate    float generated always as (
                     approved_count::float / nullif(total_proposals, 0)
                   ) stored,
  last_updated     timestamptz not null default now(),

  unique (org_id, agent_role)
);
create index idx_agent_accuracy_org_id on agent_accuracy(org_id);

alter table agent_accuracy enable row level security;
create policy tenant_isolation_agent_accuracy on agent_accuracy
  using  (org_id = current_setting('app.current_org_id', true)::uuid)
  with check (org_id = current_setting('app.current_org_id', true)::uuid);
