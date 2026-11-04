-- render API (RENDER=1 only, 0.65.0): API keys and usage counters for /v1/render/pdf and /v1/render/screenshot.
-- Local only until approved. No raw key and no raw email is stored.
-- key_hash   = sha256(pepper | raw key); the raw key is shown once at signup.
-- email_hash = sha256(pepper | lowercased email); one free key per email.
-- plan       = free (500/mo) | starter (5,000/mo, $10) | pro (25,000/mo, $29). Quota is a hard cap: at quota -> 429, never billed extra.
-- status     = active | suspended (auto-suspended on a sudden spike; suspended_reason says why) | revoked
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  email_hash TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  monthly_quota INTEGER NOT NULL DEFAULT 500,
  status TEXT NOT NULL DEFAULT 'active',
  suspended_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_email ON api_keys (email_hash) WHERE email_hash IS NOT NULL;

-- one row per key per UTC month (YYYY-MM): renders counted against the quota (failed renders are given back)
CREATE TABLE IF NOT EXISTS api_key_usage (
  key_id TEXT NOT NULL,
  month TEXT NOT NULL,
  renders INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, month)
);

-- per key per UTC minute (YYYY-MM-DDTHH:MM): rate limit + spike detection; old rows deleted opportunistically
CREATE TABLE IF NOT EXISTS api_key_minute (
  key_id TEXT NOT NULL,
  minute TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, minute)
);
