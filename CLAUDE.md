# U-I-OS — Backend Foundation

Unified Intelligence OS (U-I-OS) backend foundation: a multi-tenant Postgres
schema (via Supabase) plus a typed service client. This document explains the
architecture decisions baked into `src/schema.sql` and `src/db.ts` and how to
verify the project locally.

## 1. Multi-tenant architecture

Every tenant in U-I-OS is an `organizations` row. The other two tables,
`inbound_payloads` and `system_audit_logs`, both carry an `org_id` foreign
key (`ON DELETE CASCADE`) tying every record back to exactly one tenant.

Isolation is enforced in two layers:

- **Row-Level Security (RLS).** RLS is enabled on all three tables. Each has
  a `tenant_isolation_*` policy that compares the row's `org_id` (or `id`,
  for `organizations` itself) against the Postgres session variable
  `app.current_org_id`. A connection that hasn't set this variable, or that
  sets it to a different org, sees zero rows for any other tenant's data —
  enforced by Postgres itself, not by application code.
- **Application code.** Any request handler that runs as a non-service-role
  Postgres user should call `select set_config('app.current_org_id', $1, true)`
  with the authenticated tenant's `org_id` at the start of the request/
  transaction so the RLS policies above have something to compare against.

**Important caveat:** the client exported from `src/db.ts` uses the Supabase
**service role** key, which bypasses RLS entirely by design (it's meant for
trusted backend logic, e.g. webhook ingestion, that needs to read/write
across tenants). If you add a code path that runs on behalf of a single
tenant using their own credentials, use the **anon/authenticated** key in a
separate client instead, so RLS actually applies.

## 2. Audit log immutability

`system_audit_logs` is meant to be a tamper-evident, append-only ledger.

- The `prevent_audit_log_mutation()` trigger function raises a hard
  `Security Violation` exception on any `UPDATE` or `DELETE` against the
  table.
- The `trig_protect_audit_logs` trigger runs `BEFORE UPDATE OR DELETE` on
  every row and invokes that function.
- This holds even for the service-role key — there is no application-layer
  bypass. The only way to remove a row is a manual, audited operation
  directly against the database by someone with sufficient privilege to
  drop/disable the trigger first.

Write new audit entries with plain `INSERT`s; never attempt to "correct" a
row in place — insert a new row describing the correction instead.

## 3. Billing tier guardrails

`organizations.subscription_tier` is constrained to exactly `'free'`,
`'pro'`, or `'enterprise'` via a `CHECK` constraint — invalid tiers are
rejected at the database layer regardless of what application code sends.

`inbound_payloads.status` is similarly constrained to `'pending'`,
`'processing'`, `'completed'`, `'failed'`, or `'blocked_unauthorized_tier'`.
The `blocked_unauthorized_tier` status is intended for payloads that arrive
from an org whose `subscription_tier` doesn't entitle them to the feature
that produced the payload — set this status instead of silently dropping
the row, so there's always a record of the rejected request.

> **TODO (email dedup, deferred to Phase 8 / Resend):** migration 0003
> generalized `inbound_payloads` for file uploads and **dropped** the old
> `UNIQUE` on `email_message_id` (it's email-specific and conflicts with NULL
> upload rows). When the Resend inbound-email path lands, restore email
> de-duplication with a partial unique index:
> `CREATE UNIQUE INDEX inbound_payloads_email_msg_id_uniq ON inbound_payloads(email_message_id) WHERE source = 'email';`

## 4. Project layout

```
ui-os/
├── CLAUDE.md          # this file
├── package.json
├── tsconfig.json
├── .env.example
└── src/
    ├── db.ts          # typed Supabase service-role client
    └── schema.sql      # full Postgres schema (tables, trigger, RLS)
```

## 5. Setup & run instructions

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# then edit .env and fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
# from your Supabase project's Settings > API page

# 3. Apply the schema to your Supabase/Postgres database
#    (paste src/schema.sql into the Supabase SQL editor, or:)
psql "$DATABASE_URL" -f src/schema.sql

# 4. Typecheck only (no execution, no output files)
npm run typecheck

# 5. Run the db client module directly
npm run dev
# - With .env unset/incomplete: throws a clear, intentional error naming
#   the missing variable(s). This is expected — it's the startup guard
#   working correctly, not a bug.
# - With .env populated: exits silently with a working `supabase` client
#   exported from the module (import it from other files to use it).

# 6. Compile to JS (emits to dist/)
npm run build
```

## 6. Verification performed

This foundation was validated end-to-end before being handed off:

- `npm run typecheck` (`tsc --noEmit` against the exact compiler options
  specified for this project) passes with zero errors.
- `npx tsx src/db.ts` was run with no env vars set and confirmed to throw
  the intended descriptive error (not a crash, not a TS error).
- The module was also smoke-tested with placeholder env vars present and
  confirmed to export a working `supabase` client instance.
