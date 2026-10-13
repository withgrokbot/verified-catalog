-- 0.29.0: last 30 observations per normalized endpoint URL (key = sha256 of the normalized URL; the URL itself is not stored).
-- One row per fresh (uncached) probe; older rows beyond 30 are pruned on insert. Drives stable_for_days / last_changed / drift.
CREATE TABLE IF NOT EXISTS endpoint_history (
  hkey TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  http_status INTEGER,
  amount_atomic TEXT,
  price_usd REAL,
  network TEXT,
  asset TEXT,
  pay_to TEXT,
  verdict TEXT
);
CREATE INDEX IF NOT EXISTS endpoint_history_key_time ON endpoint_history (hkey, observed_at DESC);
