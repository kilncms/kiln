-- The security log (worker/security-log.js): the requests the service
-- refuses, counted by the hour, so that the operator can notice an attack or a
-- fault early: asked too often (and which limit), a sign-in code typed wrong,
-- a request for a site or account that is not the asker's, a message claiming
-- to come from Stripe or GitHub without their signature, and the operator's
-- own sign-ins. Written only while the service's SECURITY_LOG setting is "on",
-- which waits for the privacy page to say so.
--
--   hour        the hour it happened in: its start, in milliseconds
--   kind        rate_limited, wrong_code, cross_account, bad_signature or operator_signin
--   account_id  the account, when the request was signed in to the dashboard; '' when not
--   site_id     the site it named, when it named one on Kiln; '' when none
--   detail      one word: which limit, which guard, or which sender; '' when none
--   count       how many times, in that hour
--   first_at    the first time, in milliseconds
--   last_at     the last time, in milliseconds
--
-- One row per hour, kind, account, site and detail, so a burst makes one row
-- with a large count. Never a network address, a token, a code, an email
-- address or what was being edited. ('' stands for none in the key, because
-- two empty values in SQLite's NULL are never the same row.)
-- Kept 90 days: older rows are deleted by the five-minute schedule.
-- Apply this before the service that writes it. A service running on a
-- database this has not reached works as before and records nothing.
CREATE TABLE IF NOT EXISTS security_log (
  hour INTEGER NOT NULL,
  kind TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  site_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (hour, kind, account_id, site_id, detail)
);
