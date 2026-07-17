-- ── 1. org_api_keys ────────────────────────────────────────────────────────
-- Stores hashed API keys used for webhook ingestion (Zapier / Make / direct).
-- Raw keys are NEVER stored; only SHA-256 hex hash + the first 8 chars for display.
CREATE TABLE IF NOT EXISTS org_api_keys (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key_hash      text        NOT NULL UNIQUE,          -- SHA-256(raw_key) hex
  key_prefix    text        NOT NULL,                 -- first 8 chars of raw key (display only)
  name          text        NOT NULL,                 -- human label (e.g. "Zapier webhook")
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

CREATE INDEX IF NOT EXISTS org_api_keys_org_id_idx ON org_api_keys(org_id);

-- RLS
ALTER TABLE org_api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_org_api_keys ON org_api_keys
  USING (org_id::text = current_setting('app.current_org_id', true));

-- ── 2. Extend inbound_payloads.source to include 'webhook' ─────────────────
-- Current allowed values are 'email' and 'upload'. Add 'webhook'.
ALTER TABLE inbound_payloads
  DROP CONSTRAINT IF EXISTS inbound_payloads_source_check;

ALTER TABLE inbound_payloads
  ADD CONSTRAINT inbound_payloads_source_check
  CHECK (source IN ('email', 'upload', 'webhook'));

-- ── 2b. Fix inbound_payloads_source_shape to allow the webhook shape ───────
-- Migration 0003 added a per-source shape CHECK that only accounts for
-- 'upload' (requires storage_path) and 'email' (requires email_message_id).
-- Without this fix, EVERY webhook row would violate that constraint (neither
-- disjunct matches source = 'webhook') and inserts would fail outright.
-- Webhook rows carry their body in extracted_json and have no required
-- shape column (webhook_ref is optional, for idempotency only).
ALTER TABLE inbound_payloads
  DROP CONSTRAINT IF EXISTS inbound_payloads_source_shape;

ALTER TABLE inbound_payloads
  ADD CONSTRAINT inbound_payloads_source_shape CHECK (
    (source = 'upload' and storage_path is not null)
    or (source = 'email' and email_message_id is not null)
    or (source = 'webhook')
  );

-- ── 3. webhook_ref column (nullable) ───────────────────────────────────────
-- Stores the caller-supplied idempotency key for webhook payloads (like
-- email_message_id for email). Nullable — upload rows leave it NULL.
ALTER TABLE inbound_payloads
  ADD COLUMN IF NOT EXISTS webhook_ref text;

-- Partial unique index: one webhook_ref per org (deduplicate retries).
CREATE UNIQUE INDEX IF NOT EXISTS inbound_payloads_webhook_ref_uniq
  ON inbound_payloads(org_id, webhook_ref)
  WHERE source = 'webhook' AND webhook_ref IS NOT NULL;
