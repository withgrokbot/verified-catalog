-- Public live Spot-Check receipts (one row per delivered decision). No client ids, IPs or payers are stored.
CREATE TABLE IF NOT EXISTS spot_receipts (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS spot_receipts_url_time ON spot_receipts (url, created_at DESC);
