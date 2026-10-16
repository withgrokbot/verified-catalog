-- 0.41.0 hosted mode part one: integrator keys (hash only) and per-check usage (invoice source of truth)
CREATE TABLE IF NOT EXISTS integrators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  key_hash TEXT NOT NULL,
  free_total INTEGER NOT NULL DEFAULT 1000,
  first_invoice_paid INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS hosted_usage (
  receipt_id TEXT PRIMARY KEY,
  integrator_id TEXT NOT NULL,
  product TEXT NOT NULL,
  created_at TEXT NOT NULL,
  month TEXT NOT NULL,
  price_atomic INTEGER NOT NULL,
  band TEXT NOT NULL,
  end_user_hash TEXT,
  invoiced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_hosted_usage_integ ON hosted_usage (integrator_id, month);
