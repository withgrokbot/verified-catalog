-- 0.37.0: response quality metadata, one row per FRESH probe (same cadence as endpoint_history), last 30 per hkey.
-- hkey = sha256 of the normalized URL (as endpoint_history); host = the seller host only (no path, no query).
-- Metadata only: status, media type, size, schema declared / matched, quality code. Never a body, header or query string.
CREATE TABLE IF NOT EXISTS endpoint_quality (
  hkey TEXT NOT NULL,
  host TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  http_status INTEGER,
  content_type TEXT,
  body_bytes INTEGER,
  schema_declared INTEGER,
  schema_match INTEGER,
  code TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS endpoint_quality_hkey_time ON endpoint_quality (hkey, observed_at DESC);
CREATE INDEX IF NOT EXISTS endpoint_quality_host_time ON endpoint_quality (host, observed_at DESC);
