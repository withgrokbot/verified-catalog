-- render API billing (BILLING=1 only, 0.66.0): Stripe monthly plans for API keys. Local only until approved.
-- Only Stripe object ids are stored (cus_..., sub_..., price_...), never card data, never the raw API key.
-- plan_ends_at (unix s): the paid plan stays until then (cancel or failed payment), after which the key drops to free (500/mo).
ALTER TABLE api_keys ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE api_keys ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE api_keys ADD COLUMN plan_ends_at INTEGER;
CREATE INDEX IF NOT EXISTS api_keys_stripe_customer ON api_keys (stripe_customer_id);
CREATE INDEX IF NOT EXISTS api_keys_stripe_subscription ON api_keys (stripe_subscription_id);

-- webhook idempotency: one row per Stripe event id; a redelivered event is acknowledged and not applied again.
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
