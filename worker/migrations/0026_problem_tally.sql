-- The problem tally (worker/problems.js): the problems the service meets,
-- counted by the day, so that the operator can notice a fault early, fix it,
-- and tell an owner when one affected their site: a change GitHub did not
-- take, a sign-in that did not finish, an email that did not send, a site
-- being brought in that stopped, a step of setting a site up that failed, a
-- domain that could not be set up, a site that could not be put up. Written
-- only while the service's PROBLEM_TALLY setting is "on", which waits for the
-- privacy page to say so.
--
--   day       the day it happened, in Eastern time: YYYY-MM-DD
--   kind      publish_failed, signin_not_finished, email_not_sent, copy_failed,
--             setup_failed, domain_failed or hosting_failed
--   site_id   the site it happened on, when there was one on Kiln; '' when none
--   detail    one word: which door, which step or which reason; '' when none
--   count     how many times, that day
--   first_at  the first time, in milliseconds
--   last_at   the last time, in milliseconds
--
-- One row per day, kind, site and detail, so a burst makes one row with a
-- large count. Never what was being changed, a network address, a token or an
-- email address. ('' stands for none in the key, because two empty values in
-- SQLite's NULL are never the same row.)
-- Kept 400 days (13 months): older rows, and the rows of a site no longer on
-- Kiln, are deleted by the five-minute schedule; a site's rows are deleted when
-- the site is removed.
-- Apply this before the service that writes it. A service running on a
-- database this has not reached works as before and records nothing.
CREATE TABLE IF NOT EXISTS problem_tally (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  site_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (day, kind, site_id, detail)
);
CREATE INDEX IF NOT EXISTS problem_tally_site ON problem_tally (site_id);
