-- The activity record (worker/activity.js): one dated line for each thing that
-- happens to an account or a site: signed up, a site added and set up, a
-- change published (the site, and whether the owner or an invited editor
-- published it, never what was changed), a payment that went through or did
-- not, a subscription that ended, free days ended or given, an email Kiln sent
-- about a site, a site removed, hosting down or up, a domain live, and the
-- operator's own actions. Written only while the service's ACTIVITY_RECORD
-- setting is "on", which waits for the privacy page to say so.
--
--   at          when, in milliseconds
--   account_id  the account it happened to
--   site_id     the site, when it was about one
--   kind        what happened, one of the fixed list in activity.js
--   by          who did it: person (the account holder), editor (an invited
--               editor), operator, kiln (on its own) or stripe
--   detail      a few named fields of one word or number each, at most 500
--               characters: never what someone wrote or published, a token,
--               or an address
--
-- Kept with the account and removed with it. A removed site's lines go with
-- it, except the one that says it was removed. An account is deleted by hand
-- today: its lines go with `DELETE FROM activity WHERE account_id = ?`.
-- Apply this before the service that writes it. A service running on a
-- database this has not reached works as before and records nothing.
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  account_id TEXT,
  site_id TEXT,
  kind TEXT NOT NULL,
  "by" TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS activity_account_at ON activity (account_id, at);
CREATE INDEX IF NOT EXISTS activity_site_at ON activity (site_id, at);
CREATE INDEX IF NOT EXISTS activity_kind_at ON activity (kind, at);
