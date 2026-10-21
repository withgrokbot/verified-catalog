-- 0.47.0 Watchtower: hourly re-probe of a watched x402 endpoint, signed webhooks on drift/down/recovery.
-- Privacy (0.45.6 rules): no payer wallet, tx hash, payment payload or client IP is stored. Secrets and trial keys are hashed.
CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY,               -- wt- + 16 hex
  secret_hash TEXT NOT NULL,         -- sha256(pepper ":" wts_secret); the secret is shown once
  url TEXT NOT NULL,                 -- endpoint URL (no query string)
  method TEXT NOT NULL DEFAULT 'GET',
  hkey TEXT NOT NULL,                -- sha256 of url+method (pair/dedupe key)
  webhook_url TEXT NOT NULL,
  webhook_hash TEXT NOT NULL,        -- sha256(webhook_url) for the same-pair lookup
  webhook_domain_hash TEXT NOT NULL, -- HMAC(pepper, trial key) for per-domain limits
  ip_hash TEXT,                      -- HMAC(pepper, ip prefix + day): create rate limit only
  status TEXT NOT NULL,              -- active | paused | deleted
  paused_reason TEXT,                -- expired | webhook_failing
  trial INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0,   -- number of paid periods (create/renew)
  created_at TEXT NOT NULL,
  paid_until TEXT NOT NULL,
  period_start TEXT NOT NULL,
  deleted_at TEXT,
  slot INTEGER NOT NULL DEFAULT 0,
  next_probe_at TEXT NOT NULL,
  baseline_json TEXT NOT NULL,
  baseline_sig TEXT NOT NULL,
  baseline_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'up',  -- up | down
  fail_streak INTEGER NOT NULL DEFAULT 0,
  ok_streak INTEGER NOT NULL DEFAULT 0,
  pending_sig TEXT,
  pending_count INTEGER NOT NULL DEFAULT 0,
  was_paused INTEGER NOT NULL DEFAULT 0,
  quiet_until TEXT,                  -- flapping: down/recovery suppressed until stable
  last_probe_at TEXT,
  last_event_id TEXT,
  probes_total INTEGER NOT NULL DEFAULT 0,
  probes_period INTEGER NOT NULL DEFAULT 0,
  events_total INTEGER NOT NULL DEFAULT 0,
  deliveries_failed INTEGER NOT NULL DEFAULT 0,
  consecutive_failed INTEGER NOT NULL DEFAULT 0,
  fail_days INTEGER NOT NULL DEFAULT 0,
  fail_day TEXT,
  ok_day TEXT
);
CREATE INDEX IF NOT EXISTS watches_due ON watches (status, next_probe_at);
CREATE INDEX IF NOT EXISTS watches_pair ON watches (hkey, webhook_hash);
CREATE INDEX IF NOT EXISTS watches_domain ON watches (webhook_domain_hash, status);
CREATE INDEX IF NOT EXISTS watches_ip ON watches (ip_hash);
CREATE TABLE IF NOT EXISTS watch_events (
  id TEXT PRIMARY KEY,               -- evt- + 16 hex (or wr- for payment receipts)
  watch_id TEXT NOT NULL,
  type TEXT NOT NULL,                -- watch.verify | drift | down | recovery | flapping | paused | resumed | receipt
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL              -- the signed event / receipt JSON (no secrets, no buyer data)
);
CREATE INDEX IF NOT EXISTS watch_events_by_watch ON watch_events (watch_id, created_at);
CREATE TABLE IF NOT EXISTS watch_deliveries (
  event_id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  status TEXT NOT NULL,              -- pending | delivered | failed
  http_status INTEGER,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS watch_deliveries_due ON watch_deliveries (status, next_attempt_at);
CREATE TABLE IF NOT EXISTS watch_usage (
  watch_id TEXT NOT NULL,
  day TEXT NOT NULL,
  probes INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,
  deliveries_ok INTEGER NOT NULL DEFAULT 0,
  deliveries_failed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (watch_id, day)
);
CREATE TABLE IF NOT EXISTS trial_claims (
  key_hash TEXT PRIMARY KEY,         -- HMAC(pepper, "trial|" + key), key = webhook registrable domain or relay host+path
  kind TEXT NOT NULL,                -- domain | url | ip
  n INTEGER NOT NULL DEFAULT 1,
  claimed_at TEXT NOT NULL
);
