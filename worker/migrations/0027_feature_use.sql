-- Feature use (worker/feature-use.js): for each site, how many times each of
-- Kiln's features was used in a week (publishing, publishing several pages
-- together, scheduling a change, inviting an editor or a member, comments,
-- suggestions, the writing helper, the API and API tokens, putting a page
-- back, adding, removing and looking back at pages), so that the operator can
-- see which parts of Kiln help people and which need explaining better.
-- Written only while the service's FEATURE_USE setting is "on", which waits
-- for the privacy page to say so.
--
--   week     the Monday the week started on, in Eastern time: YYYY-MM-DD
--   site_id  the site, one on Kiln
--   feature  which feature (worker/feature-use.js FEATURES)
--   count    how many times, that week
--
-- Counts only, never what was written. Kept 400 days (13 months): older rows,
-- and the rows of a site no longer on Kiln, are deleted by the five-minute
-- schedule; a site's rows are deleted when the site is removed.
-- Apply this before the service that writes it. A service running on a
-- database this has not reached works as before and records nothing.
CREATE TABLE IF NOT EXISTS feature_use (
  week TEXT NOT NULL,
  site_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (week, site_id, feature)
);
CREATE INDEX IF NOT EXISTS feature_use_site ON feature_use (site_id);
