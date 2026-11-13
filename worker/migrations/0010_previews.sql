-- One preview of a hosted site: a branch the editor wrote a suggestion or a
-- shared draft to (kiln/suggest-<name>, kiln-drafts), put up as a Worker of
-- its own beside the site's Worker so the link the editor shows leads
-- somewhere. Five for a site at most (worker/hosted.js).
--   site_id      the site the branch belongs to
--   alias        the branch's name as it stands in the preview's address:
--                lowercase letters, digits and dashes, 28 at most
--                (worker/hosting.js previewAlias)
--   branch       the branch that is up at that address now
--   name         the preview's Worker in the hosting account: pv-<the start
--                of the site's id>-<alias>
--   commit_sha   the commit that is up. Empty until the first copy finished.
--   deployed_at  when that copy finished. Empty until then.
--   updated_at   when the preview last changed. One that has not changed for
--                thirty days is taken down. 0 marks a preview that was to come
--                down and that Cloudflare did not take away: the next sweep
--                tries again.
-- Times are epoch milliseconds.
CREATE TABLE IF NOT EXISTS previews (
  site_id     TEXT NOT NULL,
  alias       TEXT NOT NULL,
  branch      TEXT NOT NULL,
  name        TEXT NOT NULL,
  commit_sha  TEXT,
  deployed_at INTEGER,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (site_id, alias)
);
CREATE INDEX IF NOT EXISTS previews_updated ON previews (updated_at);
