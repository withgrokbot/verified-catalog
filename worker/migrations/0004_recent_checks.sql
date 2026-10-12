-- 0.25.0: public recent_checks list on /v1/skips.json. A free check with a clear verdict marks its receipt as published:
-- pub_url = scheme://host/path only (no query, fragment or userinfo), pub_day = UTC day. One per URL per day (unique).
ALTER TABLE spot_receipts ADD COLUMN pub_url TEXT;
ALTER TABLE spot_receipts ADD COLUMN pub_day TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS spot_receipts_pub_day_url ON spot_receipts (pub_day, pub_url) WHERE pub_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS spot_receipts_pub_time ON spot_receipts (pub_day, created_at DESC) WHERE pub_url IS NOT NULL;
