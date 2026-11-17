-- 0.76.0 reliability score, daily rollup (SCORE_BAND = shadow | on only). One row per probed endpoint per UTC day: the band
-- the formula (src/score.js, formula_version) gave that day. In shadow mode rows are recorded and never served.
-- Public data only: URL = scheme://host/path (no query), counts and codes. Never stored: buyer wallets, tx hashes, IPs,
-- client names or the observation bodies (inputs_digest = sha256 over the sorted receipt ids behind the answer).
--   band           what may be served: good | caution | unknown | operator_endpoint
--   internal_band  same plus avoid. avoid is NEVER served (it is served as caution + flags until an appeal path ships)
-- Additive and idempotent. NOT applied by merging this PR: it needs an explicit
--   npx wrangler d1 migrations apply vc-spot-receipts --remote
-- Until applied, the Worker treats the table as absent (the daily rollup and reads fail open to "unknown").
-- Rows older than 400 days are deleted by the daily seed.
CREATE TABLE IF NOT EXISTS endpoint_score_daily (
  day TEXT NOT NULL,                  -- YYYY-MM-DD (UTC)
  url TEXT NOT NULL,                  -- scheme://host/path
  method TEXT NOT NULL DEFAULT 'GET',
  band TEXT NOT NULL,
  internal_band TEXT NOT NULL,
  score INTEGER,                      -- shrunk 0..100, null when there is no usable component
  raw INTEGER,                        -- before shrinkage
  confidence TEXT NOT NULL,           -- high | medium | low | none
  confidence_score REAL,
  n_eff REAL,
  n_obs INTEGER,
  days_observed INTEGER,
  first_seen TEXT,
  last_checked TEXT,
  flags TEXT,                         -- JSON [{code, severity, confirmed}]
  reasons TEXT,                       -- JSON [code]
  excluded TEXT,                      -- JSON {category: count}
  formula_version TEXT NOT NULL,
  inputs_digest TEXT,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (day, url)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS endpoint_score_daily_url ON endpoint_score_daily (url, day);
CREATE INDEX IF NOT EXISTS endpoint_score_daily_band ON endpoint_score_daily (day, internal_band);
