-- 0.14.0: determinism cache. norm_key = normalized URL + " " + method; probed_at = when the reused live probe ran (UTC).
ALTER TABLE spot_receipts ADD COLUMN norm_key TEXT;
ALTER TABLE spot_receipts ADD COLUMN probed_at TEXT;
CREATE INDEX IF NOT EXISTS spot_receipts_probe_cache ON spot_receipts (norm_key, probed_at DESC);
