-- 0.75.0 probe-set demand (SCORE_DEMAND=1 only). Aggregate daily counts of how often a public endpoint URL was shown to a
-- real caller: kind 'discover' = it was among the first results of a /v1/discover or MCP discover answer.
-- Privacy: URL = scheme://host/path only (no query or fragment), a count, a UTC day. No client id, IP, UA, wallet or query text.
-- Callers that are ours, uptime monitors, crawlers and bots (the existing exclusion()) are never counted.
-- Additive and idempotent. NOT applied by merging this PR: it needs an explicit
--   npx wrangler d1 migrations apply vc-spot-receipts --remote
-- Until it is applied the Worker treats the table as absent (reads and writes fail open) and the expansion uses the
-- check-receipt demand from spot_receipts only. Rows older than 45 days are deleted by the daily seed.
CREATE TABLE IF NOT EXISTS endpoint_demand_daily (
  day TEXT NOT NULL,                 -- YYYY-MM-DD (UTC)
  url TEXT NOT NULL,                 -- scheme://host/path
  kind TEXT NOT NULL,                -- discover
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, url, kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS endpoint_demand_daily_url ON endpoint_demand_daily (url, day);
