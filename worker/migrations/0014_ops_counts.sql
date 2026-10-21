-- 0.48.0 ops counters: aggregate daily counts only (Workers Paid, D1 vc-spot-receipts). No KV writes.
-- Privacy: no IP, wallet, payment payload/proof, tx hash, query string or client value is ever stored here.
-- Self/drill vs outside is decided at request time from the payment signer and only the segment label is kept.

-- Paywall funnel per route and UTC day.
--   event:   402 (a 402 was served) | attempt (an X-PAYMENT / PAYMENT-SIGNATURE header was present)
--            | failed | settled | not_charged (header present, answered without a settlement, e.g. free quota left)
--   reason:  '' except for failed: bad_sig | wrong_network_or_asset | insufficient_amount | expired | facilitator_error | other
--   segment: self (signer is our payTo or a DRILL_WALLETS wallet) | outside
CREATE TABLE IF NOT EXISTS paywall_daily (
  day TEXT NOT NULL,      -- YYYY-MM-DD (UTC)
  route TEXT NOT NULL,    -- normalized route, e.g. /v1/products/endpoint-spot-check, /v1/watch/:id/renew
  segment TEXT NOT NULL,
  event TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, route, segment, event, reason)
);

-- 404 path log: normalized method + path only (no query string, ids/hex collapsed, <= 120 chars).
CREATE TABLE IF NOT EXISTS notfound_daily (
  day TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, method, path)
);
CREATE INDEX IF NOT EXISTS notfound_daily_day ON notfound_daily (day);
