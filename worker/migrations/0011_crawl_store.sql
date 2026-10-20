-- 0.44.0: weekly crawl storage moves from Workers KV (CRAWL_KV) to D1. One logical key (same names as the KV keys:
-- c:<id[0:2]> receipt shards, s:<n> skip pages, meta) is stored as 1..n parts of <= ~90 KB each, because a D1 SQL
-- statement is capped at 100 KB. The Worker reads all parts in order and uses the row only when every part is present
-- and the sha256 of the joined value matches; otherwise it falls back to KV, so deploying this before any backfill is safe.
-- `source` lets other producers (e.g. discovery, 0.43.0, whose discover_index is 0010) share the table under their own key prefix.
CREATE TABLE IF NOT EXISTS crawl_store (
  key TEXT NOT NULL,
  part INTEGER NOT NULL,
  parts INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'crawl',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (key, part)
);
CREATE INDEX IF NOT EXISTS crawl_store_source ON crawl_store (source, key);
