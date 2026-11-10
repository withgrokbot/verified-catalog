-- 0.70.0 receipt anchoring (ANCHORS=1 only). One row per nightly Merkle root, plus the ordered
-- leaf of each receipt in that batch. Does not alter spot_receipts rows or receipt signatures.
-- The (created_at, id) index is only for the cursor that walks new receipts. Apply before enabling
-- the flag: npx wrangler d1 migrations apply vc-spot-receipts --remote
CREATE TABLE IF NOT EXISTS receipt_anchors (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  merkle_root TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  receipt_count INTEGER NOT NULL,
  first_receipt_id TEXT,
  last_receipt_id TEXT,
  first_created_at TEXT,
  last_created_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed')),
  ots_proof BLOB NOT NULL,
  calendars TEXT NOT NULL,
  btc_height INTEGER,
  confirmed_at TEXT
);
CREATE INDEX IF NOT EXISTS receipt_anchors_created ON receipt_anchors (created_at DESC);

CREATE TABLE IF NOT EXISTS receipt_anchor_items (
  receipt_id TEXT PRIMARY KEY,
  anchor_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  receipt_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipt_anchor_items_anchor ON receipt_anchor_items (anchor_id, position);

CREATE INDEX IF NOT EXISTS spot_receipts_created_id ON spot_receipts (created_at, id);
