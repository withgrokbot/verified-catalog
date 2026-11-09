-- 0.67.0 social cards. Usage is counted by kind: pdf, shot, or card.
-- The monthly quota stays the SUM of renders for the key and month (one card = one render, same hard cap).
-- Existing rows are pdf. A failed render gives that kind's unit back. Cache hits are not counted.
CREATE TABLE api_key_usage_kind (
  key_id TEXT NOT NULL,
  month TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'pdf' CHECK (kind IN ('pdf', 'shot', 'card')),
  renders INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, month, kind)
);
INSERT INTO api_key_usage_kind (key_id, month, kind, renders, updated_at)
  SELECT key_id, month, 'pdf', renders, updated_at FROM api_key_usage;
DROP TABLE api_key_usage;
ALTER TABLE api_key_usage_kind RENAME TO api_key_usage;
