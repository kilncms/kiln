-- The daily site check (worker/daily-check.js): once a day the service asks
-- each site's public address, the editor's file its home page loads and its
-- Kiln sign-in page whether they answer, and keeps the result here, so that
-- the operator and the owner can see when a site is down or its editor is out
-- of date. Written only while the service's SITE_CHECK_DAILY setting is "on",
-- which waits for the privacy page to say so.
--
--   site_id  the site
--   at       when it was checked, in milliseconds
--   ok       1 when all three answered, else 0
--   summary  each check's outcome in a word or two, and the editor version
--            the site's editors last reported: nothing else
--
-- The latest row of each site and 30 days before it are kept: older rows, and
-- those of sites no longer on Kiln, are deleted by the same run that checks.
-- Apply this before the service that writes it. A service running on a
-- database this has not reached works as before and checks nothing.
CREATE TABLE IF NOT EXISTS site_checks (
  site_id TEXT,
  at INTEGER,
  ok INTEGER,
  summary TEXT
);
CREATE INDEX IF NOT EXISTS site_checks_site_at ON site_checks (site_id, at);
CREATE INDEX IF NOT EXISTS site_checks_at ON site_checks (at);
