-- 0206_stripe_customer_id.sql
-- Phase 5 (billing): link an organization to its Stripe customer.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS stripe_customer_id text UNIQUE;

CREATE INDEX IF NOT EXISTS organizations_stripe_customer_id_idx
  ON organizations(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
