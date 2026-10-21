-- 0.46.0: locked teaser commitments + paid endpoint reports.
-- commitments: one row per committed snapshot set (free check answers). ref = cm-<16 hex>; digests/snapshots/nonces are
-- JSON. Rows are written with INSERT OR IGNORE (dedupe by keyed hash of endpoint + snapshot + 15-day period), expire after
-- 30 days and are pruned on paid report calls. The URL is stored without query string; hkey = sha256 of the normalized URL.
-- endpoint_reports: signed er- receipts (body = full signed JSON; served only through the privacy scrub).
-- Apply with (deploy step, NOT run yet):
--   wrangler d1 migrations apply vc-spot-receipts --remote
CREATE TABLE IF NOT EXISTS commitments (
  ref TEXT PRIMARY KEY,
  hkey TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  digests TEXT NOT NULL,
  snapshots TEXT NOT NULL,
  nonces TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commitments_expires ON commitments (expires_at);
CREATE TABLE IF NOT EXISTS endpoint_reports (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  body TEXT NOT NULL
);
