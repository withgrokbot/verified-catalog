-- 0.78.0 settlement matching (src/settle.js). Record-only, behind SETTLE_MATCH=1 (off by default). Nothing here is served.
-- Additive and idempotent. NOT applied by merging this PR: it needs an explicit
--   wrangler d1 migrations apply vc-spot-receipts --remote
-- Until applied, the cron step fails closed (one log line, nothing written) and /v1/ops/stats omits the section.
--
-- What it records: after a live spot check quoted Base USDC (eip155:8453, 0x8335...2913) to a seller payTo, the cron
-- watches USDC Transfer events TO that payTo for SETTLE_WINDOW_H hours (default 6) after checked_at and counts them:
--   exact  value == the quoted amount_atomic                          -> high confidence
--   near   0 < |value - quoted| <= max(1, quoted * SETTLE_NEAR_BPS / 10000) (default 500 bps = 5%) -> low confidence,
--          its own columns, never added to the exact ones
-- Each transfer is attributed to at most one check (the latest check of that payTo whose window covers it; exact first).
--
-- Never stored, logged or published: the sender/buyer wallet, the tx hash, block number, log index or the exact
-- transfer time. Time is kept only as a coarse delay bucket and a UTC day. pay_to is the seller's own public payTo
-- from its 402 (already in the public receipt). We cannot link a payer to whoever asked us for the check.
--
-- CAVEAT (applies to every count below): absence of an observed settlement never means "not paid". Payments can
-- settle on other networks or assets, outside the window, to a different payTo, in batches, off-chain, or in blocks
-- the cron skipped (gap_blocks), and RPC sources can miss logs.

-- One row per Base USDC quote in a live spot check (a receipt can quote more than one option: opt = accepts index).
CREATE TABLE IF NOT EXISTS settle_checks (
  check_id TEXT NOT NULL,              -- spot_receipts.id (public receipt id)
  opt INTEGER NOT NULL DEFAULT 0,      -- index in live_402.accepts
  url TEXT NOT NULL,                   -- scheme://host/path, as on the receipt
  method TEXT NOT NULL DEFAULT 'GET',
  verdict TEXT NOT NULL,               -- pay | recheck | skip (our verdict on that check)
  pay_to TEXT NOT NULL,                -- seller payTo from its 402 (lowercase); never a buyer wallet
  amount_atomic TEXT NOT NULL,         -- quoted USDC amount (6 decimals)
  checked_at TEXT NOT NULL,
  window_end TEXT NOT NULL,            -- checked_at + SETTLE_WINDOW_H
  exact_n INTEGER NOT NULL DEFAULT 0,  -- high confidence: transfers of exactly amount_atomic
  near_n INTEGER NOT NULL DEFAULT 0,   -- low confidence: within the near tolerance, never merged into exact_n
  ambiguous_n INTEGER NOT NULL DEFAULT 0, -- of those, transfers another endpoint sharing this payTo could also claim
  exact_first_bucket TEXT,             -- delay from checked_at to the first exact transfer: lt1m|1_5m|5_15m|15_60m|1_6h|6_24h
  near_first_bucket TEXT,
  near_min_atomic TEXT,
  near_max_atomic TEXT,
  last_observed_day TEXT,              -- YYYY-MM-DD (UTC) of the latest counted transfer
  created_at TEXT NOT NULL,
  PRIMARY KEY (check_id, opt)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS settle_checks_window ON settle_checks (window_end);
CREATE INDEX IF NOT EXISTS settle_checks_time ON settle_checks (checked_at);

-- Cursors: k = 'receipts' (v = created_at|id of the last synced receipt), 'block' (v = last scanned Base block; our
-- scan position, not any transaction's block).
CREATE TABLE IF NOT EXISTS settle_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Per UTC day run counters (cost + coverage). Counts only.
CREATE TABLE IF NOT EXISTS settle_runs_daily (
  day TEXT PRIMARY KEY,
  runs INTEGER NOT NULL DEFAULT 0,
  blocks INTEGER NOT NULL DEFAULT 0,       -- blocks scanned
  gap_blocks INTEGER NOT NULL DEFAULT 0,   -- blocks skipped (cursor too far behind); settlements there are never seen
  log_queries INTEGER NOT NULL DEFAULT 0,  -- eth_getLogs calls
  rpc_calls INTEGER NOT NULL DEFAULT 0,    -- all JSON-RPC calls (getLogs + head)
  rpc_errors INTEGER NOT NULL DEFAULT 0,
  logs_seen INTEGER NOT NULL DEFAULT 0,
  exact_n INTEGER NOT NULL DEFAULT 0,
  near_n INTEGER NOT NULL DEFAULT 0,
  other_n INTEGER NOT NULL DEFAULT 0,      -- transfers to a watched payTo that matched no open check
  self_excluded INTEGER NOT NULL DEFAULT 0,-- transfers from our own wallets (PAY_TO, DRILL_WALLETS), not counted
  checks_added INTEGER NOT NULL DEFAULT 0
);
