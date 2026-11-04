-- Paywall funnel per host: the same counts as paywall_daily (0014) with a host tag, so traffic on api.402xagent.com,
-- 402xagent.com, the legacy workers.dev host and old payscout hosts can be told apart. A separate table because the
-- paywall_daily primary key can't take a new column; paywall_daily keeps being written exactly as before.
-- host: api.402xagent.com | 402xagent.com | workers.dev | payscout | other   (normalized label, never a raw client value)
-- Privacy: same rules as 0014 (no IP, wallet, payload, tx hash or query string).
CREATE TABLE IF NOT EXISTS paywall_daily_host (
  day TEXT NOT NULL,
  host TEXT NOT NULL,
  route TEXT NOT NULL,
  segment TEXT NOT NULL,
  event TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, host, route, segment, event, reason)
);
