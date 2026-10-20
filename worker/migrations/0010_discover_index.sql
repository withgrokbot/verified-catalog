-- 0.43.0: free discovery (GET /v1/discover, MCP tool `discover`). One row per crawl receipt (public crawl data only:
-- endpoint URL, verdict, reason, quoted price, network). No client ids, IPs or payers. Seeded from the weekly crawl
-- JSONL by scripts/seed-discover.mjs (D1 only; no KV writes).
CREATE TABLE IF NOT EXISTS discover_index (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  search TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT NOT NULL,
  price_usd REAL,
  network TEXT,
  asset TEXT,
  method TEXT,
  source_list TEXT,
  checked_at TEXT NOT NULL,
  crawl_run TEXT
);
CREATE INDEX IF NOT EXISTS discover_index_verdict_time ON discover_index (verdict, checked_at DESC);
