-- pdf-tables (draft endpoint, PDF_TABLES=1 only): cached results per payment so a replayed PAYMENT-SIGNATURE returns
-- the same extraction without re-running the Apify Actor (and never charges twice). TTL 24 h (expires_at, unix seconds);
-- expired rows are deleted opportunistically on write.
-- key  = sha256 of the x402 payload's signature + authorization nonce (never the raw header)
-- bind = sha256 of url + page set + ocr mode the payment was quoted for (a reused signature on another request is refused)
-- body = the JSON response returned to the payer (extracted tables/text of a public PDF). No IP, wallet, header or tx hash.
CREATE TABLE IF NOT EXISTS pdf_results (
  key TEXT PRIMARY KEY,
  bind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pdf_results_expires ON pdf_results (expires_at);
