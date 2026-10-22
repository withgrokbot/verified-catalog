-- 0.50.0 hygiene scorer (D1 vc-spot-receipts). PRIVATE tables: read only by worker/src/hygiene.js, never exported to
-- /v1/skips, /saves, /bazaar, recent lists, ops stats or any public page/feed. No raw IP or IP prefix is stored.
CREATE TABLE IF NOT EXISTS hygiene_cache (
  hkey TEXT PRIMARY KEY,      -- sha256(normalized url)
  scored_at TEXT NOT NULL,    -- ISO UTC; served for 24 h, pruned after 48 h
  json TEXT NOT NULL          -- {score, grade, deductions[{code, points, fix}]}
);
CREATE INDEX IF NOT EXISTS hygiene_cache_scored ON hygiene_cache (scored_at);
-- Free quota: 20 per UTC day per client network. pkey = sha256(CLIENT_SALT|hygiene|/24 or /48 prefix)[0:32].
CREATE TABLE IF NOT EXISTS hygiene_quota (
  day TEXT NOT NULL,
  pkey TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, pkey)
);
