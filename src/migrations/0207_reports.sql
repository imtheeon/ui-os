-- ============================================================================
-- Migration 0207: reports table (Phase 11 — client PDF reports)
-- ============================================================================
CREATE TABLE IF NOT EXISTS reports (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payload_id    uuid        NOT NULL REFERENCES inbound_payloads(id) ON DELETE CASCADE,
  title         text        NOT NULL,
  storage_path  text,       -- path in Supabase Storage (reports bucket)
  status        text        NOT NULL DEFAULT 'generating'
                CHECK (status IN ('generating', 'ready', 'failed')),
  recipient_email text,     -- if emailed
  emailed_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reports_org_id_idx ON reports(org_id);
CREATE INDEX IF NOT EXISTS reports_payload_id_idx ON reports(payload_id);

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_reports ON reports
  USING (org_id::text = current_setting('app.current_org_id', true));
