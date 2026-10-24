-- 0.52.0 Watchtower drift & liveness data feed (GET /v1/feed*). D1 only, no KV.
-- PUBLIC by construction: a row is written only for a crawl-known public URL or a watch that opted in (watches.feed_opt_in = 1).
-- Facts only: liveness, payment terms (pay_to is the public seller address), drift events. No scores, grades or rankings.
-- Never stored here: buyer wallets, tx hashes, payment proofs, client IPs, webhook URLs/hashes, query strings.
ALTER TABLE watches ADD COLUMN feed_opt_in INTEGER NOT NULL DEFAULT 0;
-- current state, one row per endpoint (hkey = "h:" + sha256(normalized URL), same key as endpoint_history)
CREATE TABLE IF NOT EXISTS feed_endpoints (
  hkey TEXT PRIMARY KEY,
  url TEXT NOT NULL,                 -- scheme://host[:port]/path, no query string
  host TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  category TEXT NOT NULL,            -- search/data | inference | crypto-market | content | infra | other
  crawl_known INTEGER NOT NULL DEFAULT 0,
  watch_opt_in INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  state TEXT NOT NULL,               -- up | down | unknown
  http_status INTEGER,
  price_usd REAL,
  amount_atomic TEXT,
  network TEXT,
  asset TEXT,
  pay_to TEXT,
  terms_sig TEXT,
  last_change_at TEXT
);
CREATE INDEX IF NOT EXISTS feed_endpoints_cat ON feed_endpoints (category, hkey);
CREATE INDEX IF NOT EXISTS feed_endpoints_host ON feed_endpoints (host, hkey);
-- hourly time series (watch probes) + backfill (crawl runs, endpoint_history). Kept 400 days, pruned by the daily cron.
-- url/host live in feed_endpoints (not repeated per row) to keep the table small.
CREATE TABLE IF NOT EXISTS feed_observations (
  hkey TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  src TEXT NOT NULL,                 -- w = watch probe, c = crawl run, h = endpoint_history
  state TEXT NOT NULL,
  http_status INTEGER,
  price_usd REAL,
  amount_atomic TEXT,
  network TEXT,
  asset TEXT,
  pay_to TEXT,
  terms_sig TEXT,
  event TEXT,                        -- NULL | drift | down | recovery  (drift flag = event IS NOT NULL)
  changes TEXT,                      -- JSON [{field, from, to}] for drift (terms fields only)
  PRIMARY KEY (hkey, observed_at)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS feed_observations_time ON feed_observations (observed_at);
CREATE INDEX IF NOT EXISTS feed_observations_events ON feed_observations (observed_at) WHERE event IS NOT NULL;
-- subscription keys: fk_ key shown once, stored as sha256(pepper ":" key) like watches.secret_hash
CREATE TABLE IF NOT EXISTS feed_keys (
  key_hash TEXT PRIMARY KEY,
  tier TEXT NOT NULL,                -- endpoint | category | firehose
  scope TEXT NOT NULL,               -- hkey | category | *
  created_at TEXT NOT NULL,
  paid_until TEXT NOT NULL,
  periods INTEGER NOT NULL DEFAULT 1
);
-- free quota: pkey = sha256(CLIENT_SALT|feed|/24 or /48 prefix)[0:32] (as hygiene_quota). No raw IP or prefix is stored.
CREATE TABLE IF NOT EXISTS feed_quota (
  day TEXT NOT NULL,
  pkey TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, pkey)
);
