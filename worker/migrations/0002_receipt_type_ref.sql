-- 0.13.0: dry runs. check_type = 'live' | 'dry-run' (existing rows are live); ref = the caller's ref tag (never a client id, IP or payer).
ALTER TABLE spot_receipts ADD COLUMN check_type TEXT NOT NULL DEFAULT 'live';
ALTER TABLE spot_receipts ADD COLUMN ref TEXT;
CREATE INDEX IF NOT EXISTS spot_receipts_type_time ON spot_receipts (check_type, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS spot_receipts_type_ref_time ON spot_receipts (check_type, ref, created_at DESC, id DESC);
