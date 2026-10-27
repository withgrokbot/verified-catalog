-- 0019 crawl term history (written by scripts/weekly-crawl/term_history.py after the weekly crawl; no Worker code reads
-- or serves it yet). One row per run of identical payment terms per endpoint: a new row only when the terms the
-- endpoint's 402 asks for change (amount, pay_to, network, asset); otherwise the open row's last_seen moves forward.
-- endpoint_key = "h:" + sha256(normalized URL), the same key as endpoint_history.hkey (the URL itself is not stored).
-- pay_to is the seller's public payTo from its own 402. Never stored: buyer wallets, tx hashes, proofs, client IPs.
-- Additive and idempotent: CREATE ... IF NOT EXISTS only.
CREATE TABLE IF NOT EXISTS term_history (
  endpoint_key TEXT NOT NULL,
  first_seen TEXT NOT NULL,          -- first crawl observation with these terms (ISO 8601 UTC)
  last_seen TEXT NOT NULL,           -- latest crawl observation with these terms
  amount TEXT,                       -- atomic units, decimal string
  pay_to TEXT,
  network TEXT,                      -- CAIP-2, e.g. eip155:8453
  asset TEXT,
  PRIMARY KEY (endpoint_key, first_seen)
) WITHOUT ROWID;
