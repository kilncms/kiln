-- Where a person came from, for the operator's funnel read per campaign: the
-- three campaign tags (utm_source, utm_medium, utm_campaign) of the link they
-- followed to Kiln, as the dashboard found them in its own address. Written
-- once, in the first hour after the account was made, and only while the
-- service's CAMPAIGN_TAGS setting is "on". Empty for every account before
-- that, and for anyone who came without tags.
-- Apply this before the service that writes them. A service running on a
-- database this has not reached works as before and records nothing.
ALTER TABLE accounts ADD COLUMN utm_source TEXT;
ALTER TABLE accounts ADD COLUMN utm_medium TEXT;
ALTER TABLE accounts ADD COLUMN utm_campaign TEXT;
