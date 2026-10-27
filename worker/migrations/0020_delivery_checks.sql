-- 0.52.3 post-payment delivery checks ("did I get what I paid for"). Rows come from our own paid check rounds
-- (scripts/run_checks.py --pay -> scripts/delivery_upload.py); the Worker itself never pays a seller.
-- One row per settled paid call: flag ok|failed + a stable reason code. Never stored: the response body, buyer or
-- our own wallet, tx hash, payment proof, client IP. hkey = "h:" + sha256(normalized URL), same as endpoint_history.
-- Additive and idempotent: CREATE ... IF NOT EXISTS only.
CREATE TABLE IF NOT EXISTS delivery_checks (
  hkey TEXT NOT NULL,
  host TEXT NOT NULL,                -- lower-case host[:port], for the per-host reputation read
  checked_at TEXT NOT NULL,          -- ISO 8601 UTC of the paid call
  flag TEXT NOT NULL,                -- ok | failed
  reason TEXT,                       -- NULL for ok; server_error | http_error | empty_body | challenge_page | soft_paywall | canned_refusal | error_body | placeholder_body | no_response
  http_status INTEGER,
  PRIMARY KEY (hkey, checked_at)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS delivery_checks_host ON delivery_checks (host, checked_at);
