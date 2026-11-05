-- email billing grace (0.68.1, EMAIL=1 only): invoice.payment_failed keeps the email plan until email_grace_ends_at
-- (event time + BILLING_GRACE_DAYS, the same window as render). A later invoice.paid, invoice.payment_succeeded,
-- or subscription update to active clears it. Separate from grace_ends_at so the two products do not clobber each other.
-- Local only until approved. No raw address is stored.
ALTER TABLE api_keys ADD COLUMN email_stripe_subscription_id TEXT;
ALTER TABLE api_keys ADD COLUMN email_grace_ends_at INTEGER;
