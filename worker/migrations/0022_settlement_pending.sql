-- 0.59.2: settlement state. A PENDING row (keyed like every row, by sha256(network|asset|from|nonce)) is written BEFORE
-- the facilitator settle call and set to 'settled' after it, so a lost settle answer or a Worker crash after settle is
-- resolved (on-chain authorizationState read) instead of answering 402. Additive: rows from 0.51.1 have state NULL and
-- are read as settled.
ALTER TABLE settled_payments ADD COLUMN state TEXT;
ALTER TABLE settled_payments ADD COLUMN updated_at TEXT;
