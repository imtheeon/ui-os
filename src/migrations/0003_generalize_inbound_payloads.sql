-- ============================================================================
-- U-I-OS Migration 0003 — Generalize inbound_payloads for file uploads
-- ============================================================================
-- inbound_payloads was email-shaped (email_message_id NOT NULL UNIQUE,
-- raw_content NOT NULL). A file upload is still an "inbound payload", but its
-- body lives in Storage, not inline. This migration widens the table to carry
-- both shapes, gated by a `source` discriminator and a CHECK that enforces the
-- right required fields per source.
--
-- Run once against the same database as schema.sql / 0002 (Supabase SQL editor
-- or psql -f). Existing rows are all emails: `source` backfills to 'email' and
-- they already have email_message_id, so the new CHECK passes for them.
-- ============================================================================

-- ── 1. Relax the email-specific constraints ────────────────────────────────
-- Drop the UNIQUE on email_message_id (email-specific; uploads have none, and
-- multiple NULLs would also be disallowed by a plain UNIQUE on some setups).
-- NOTE: this REMOVES email de-duplication. If we want it back later, use a
-- PARTIAL unique index: UNIQUE (email_message_id) WHERE source = 'email'.
alter table inbound_payloads
  drop constraint if exists inbound_payloads_email_message_id_key;

alter table inbound_payloads
  alter column email_message_id drop not null;

alter table inbound_payloads
  alter column raw_content drop not null;

-- ── 2. Add the upload-shape columns ────────────────────────────────────────
alter table inbound_payloads
  -- 'email' default backfills existing rows and keeps the email path working.
  add column source            text not null default 'email'
                                 check (source in ('email', 'upload')),
  -- Storage object key, e.g. '<org_id>/<payload_id>/<filename>'. NULL for email.
  add column storage_path      text,
  add column original_filename text,
  add column mime_type         text,
  add column size_bytes        bigint,
  -- File AV lifecycle. Added WITHOUT a default so existing email rows stay
  -- NULL (no backfill); the default for NEW rows is set separately below.
  add column scan_status       text
                                 check (scan_status in
                                   ('not_required', 'pending', 'clean', 'infected', 'error'));

-- Default applies to FUTURE inserts only (existing rows keep their NULL):
-- new emails get 'not_required', uploads override with 'pending' explicitly.
alter table inbound_payloads
  alter column scan_status set default 'not_required';

-- ── 3. Enforce the per-source required fields ──────────────────────────────
-- An upload MUST have a storage_path; an email MUST have an email_message_id.
-- (source is already restricted to exactly these two values above.)
alter table inbound_payloads
  add constraint inbound_payloads_source_shape check (
    (source = 'upload' and storage_path     is not null)
    or
    (source = 'email'  and email_message_id is not null)
  );

-- ── 4. Helpful index for the upload-processing path ────────────────────────
-- Lets workers cheaply find uploads awaiting an AV scan without scanning the
-- whole table. Partial: only upload rows that are still pending a scan.
create index idx_inbound_payloads_pending_scan
  on inbound_payloads (created_at)
  where source = 'upload' and scan_status = 'pending';
