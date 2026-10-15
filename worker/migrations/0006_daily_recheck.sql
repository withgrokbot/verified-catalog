-- 0.36.0: daily re-check of the badge hosts (src/daily.js). One run row per UTC day + one queue row per endpoint.
CREATE TABLE IF NOT EXISTS daily_runs (
  day TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS daily_queue (
  day TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  host TEXT NOT NULL,
  done_at TEXT,
  verdict TEXT,
  receipt_id TEXT,
  PRIMARY KEY (day, url)
);
CREATE INDEX IF NOT EXISTS daily_queue_pending ON daily_queue (day, done_at, host);
