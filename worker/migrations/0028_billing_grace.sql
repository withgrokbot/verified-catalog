-- render billing grace (0.66.1, BILLING=1 only): after invoice.payment_failed the paid plan is kept until grace_ends_at
-- (event time + BILLING_GRACE_DAYS, default 3), then the key drops to free (500/mo) on its next use, unless a later
-- successful payment (invoice.paid / invoice.payment_succeeded) or a subscription update to active clears it.
-- Separate from plan_ends_at so a recovery never undoes a cancel-at-period-end. Local only until approved.
ALTER TABLE api_keys ADD COLUMN grace_ends_at INTEGER;
