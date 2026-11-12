-- A site that Kiln hosts (the Kiln Cloud + hosting plan): the Worker in the
-- hosting account that holds its files, the temporary address it answers at,
-- and which commit of the repository it serves.
--   state       'starting'  being put up for the first time
--               'live'      serving `commit_sha`
--               'waiting'   the repository cannot be a website as it stands (`reason` says why)
--               'failed'    the last copy did not go through (`reason`); it is tried again
--               'removing'  the site was removed and its Worker is still to be taken down
--   wanted_sha  a commit known to be newer than what is served (a push notice
--               that could not be acted on at once)
-- Times are epoch milliseconds.
CREATE TABLE IF NOT EXISTS hosting (
  site_id      TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  url          TEXT NOT NULL,
  state        TEXT NOT NULL,
  reason       TEXT,
  branch       TEXT,
  commit_sha   TEXT,
  files        INTEGER,
  deployed_at  INTEGER,
  wanted_sha   TEXT,
  checked_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hosting_url ON hosting(url);
