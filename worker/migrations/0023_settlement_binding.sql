-- 0.59.3: bind a settled payment to the exact request it paid for. A retry of the SAME request (route + target URL +
-- HTTP method) within 10 minutes gets the ORIGINAL answer back (response, receipt_id); anything else is refused.
-- Additive: rows from before 0.59.3 have NULL here and are never reused by the spot check.
ALTER TABLE settled_payments ADD COLUMN target TEXT;
ALTER TABLE settled_payments ADD COLUMN method TEXT;
ALTER TABLE settled_payments ADD COLUMN receipt_id TEXT;
ALTER TABLE settled_payments ADD COLUMN response TEXT;
