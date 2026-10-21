-- 0.49.0 re-check window + bulk endpoint report (plan docs/plan-0.49.0.md). Apply before turning RECHECK / BULK_REPORT on.
-- Privacy: no IP, wallet, payment proof or tx hash. The re-check secret is stored only as HMAC(RECHECK_PEPPER, receipt_id ":" secret).
CREATE TABLE IF NOT EXISTS recheck_credits (
  receipt_id TEXT PRIMARY KEY,    -- er-<16 hex> (window: the paid report; bulk_retry: the id reserved for the failed URL)
  kind TEXT NOT NULL,             -- window | bulk_retry
  hkey TEXT NOT NULL,             -- sha256 of the normalized endpoint URL
  secret_hash TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL,      -- 10 (window) | 1 (bulk_retry)
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,       -- +24 h (window) | +7 d (bulk_retry)
  last_used_at TEXT,
  bulk_id TEXT                    -- eb-<16 hex> or NULL
);
CREATE INDEX IF NOT EXISTS idx_recheck_expires ON recheck_credits (expires_at);
-- Signed eb- bulk envelopes (body = full signed JSON; served only through the privacy scrub).
CREATE TABLE IF NOT EXISTS endpoint_bulk (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  body TEXT NOT NULL
);
