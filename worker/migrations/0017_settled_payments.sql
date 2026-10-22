-- 0.51.1: settlement idempotency. One row per settled x402 payment, keyed by sha256(network|asset|from|nonce).
-- A retry of the same signed payload (lost response) replays the stored settlement instead of answering 402.
CREATE TABLE IF NOT EXISTS settled_payments (
  key TEXT PRIMARY KEY,
  resource TEXT NOT NULL,
  amount TEXT NOT NULL,
  settle TEXT NOT NULL,
  facilitator TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS settled_payments_created ON settled_payments (created_at);
