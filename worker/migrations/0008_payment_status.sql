-- 0.40.0: after-payment check (POST /v1/products/payment-status). FINAL answers only (landed with enough
-- confirmations, canceled, not_landed + expired); pending/unknown answers are never stored.
-- body = the signed receipt JSON (served as-is by GET /v1/receipts/ps-...). Apply with:
--   wrangler d1 migrations apply vc-spot-receipts --remote   (deploy step; not run yet)
CREATE TABLE IF NOT EXISTS payment_status (
  id TEXT PRIMARY KEY,
  lookup_key TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_status_key ON payment_status (lookup_key, created_at);
