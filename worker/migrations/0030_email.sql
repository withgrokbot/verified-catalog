-- email validation (EMAIL=1 only, 0.68.0, unreleased): a separate plan and quota from render, usage per UTC month,
-- and a domain cache (MX result and catch-all, 24 h). No raw address is stored. Local only until approved.
-- email_plan = free | starter | pro | scale. Quotas: free 1,000, starter 10,000, pro 50,000, scale 200,000.
-- Hard cap. The free tier has no Stripe price id. Paid price ids are not set yet (not priced, not launched).
ALTER TABLE api_keys ADD COLUMN email_plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE api_keys ADD COLUMN email_monthly_quota INTEGER NOT NULL DEFAULT 1000;

-- Email usage is its own kind, 'email'. The counter is the emails column on that row (renders stays 0).
-- Render quota stays SUM(renders) for pdf, shot and card only, so the two counters never share a row.
-- SQLite cannot widen the 0029 CHECK, so the table is rebuilt.
CREATE TABLE api_key_usage_v2 (
  key_id TEXT NOT NULL,
  month TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pdf', 'shot', 'card', 'email')),
  renders INTEGER NOT NULL DEFAULT 0,
  emails INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, month, kind)
);
INSERT INTO api_key_usage_v2 (key_id, month, kind, renders, emails, updated_at)
  SELECT key_id, month, kind, renders, 0, updated_at FROM api_key_usage;
DROP TABLE api_key_usage;
ALTER TABLE api_key_usage_v2 RENAME TO api_key_usage;

-- one row per ASCII domain. mx = present | missing | a_fallback. catch_all stays not_checked until an SMTP probe exists.
CREATE TABLE IF NOT EXISTS email_domain_cache (
  domain TEXT PRIMARY KEY,
  mx TEXT NOT NULL,
  catch_all TEXT,
  checked_at INTEGER NOT NULL
);

-- weekly refresh of the upstream disposable-domain list. The bundled list is always checked as well.
CREATE TABLE IF NOT EXISTS email_disposable_domains (
  domain TEXT PRIMARY KEY,
  refreshed_at INTEGER NOT NULL
);
