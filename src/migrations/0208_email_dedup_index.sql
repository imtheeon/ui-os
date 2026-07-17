-- ============================================================================
-- Migration 0208: restore email_message_id dedup (Phase 8)
-- ============================================================================
-- Migration 0003 dropped the old UNIQUE on email_message_id when generalizing
-- inbound_payloads for file uploads (it conflicted with NULL upload rows).
-- Restore de-duplication for the Resend inbound-email path with a partial
-- unique index: it only applies to email rows with a non-null message id, so
-- upload/webhook rows (NULL email_message_id) are unaffected. Scoped by
-- org_id to match this project's multi-tenant isolation model.
CREATE UNIQUE INDEX IF NOT EXISTS inbound_payloads_email_msg_id_uniq
  ON inbound_payloads(org_id, email_message_id)
  WHERE source = 'email' AND email_message_id IS NOT NULL;
