-- Stripe Managed Payments as Kiln Cloud's billing company (worker/billing.js).
-- A site paid for through Stripe keeps Stripe's customer and subscription ids
-- here, as one paid for through Lemon Squeezy keeps `ls_subscription_id`,
-- which stays as it is. The account keeps the Stripe customer too, so a second
-- site's checkout and "Manage billing" find the same customer.
ALTER TABLE sites ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE sites ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE accounts ADD COLUMN stripe_customer_id TEXT;
CREATE INDEX IF NOT EXISTS sites_stripe_subscription ON sites (stripe_subscription_id);
