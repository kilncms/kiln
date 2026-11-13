-- An account no longer needs a GitHub login: a person can sign in to the
-- dashboard with Google, for a site whose files Kiln keeps for them.
--   github_login  the person's GitHub login, as before. Empty for an account
--                 that signed in with Google. Still one account for a login.
--   google_sub    Google's own id for the person (the `sub` of their sign-in),
--                 which stays the same when they change their address. Empty
--                 for an account that signed in with GitHub. One account for
--                 an id. Never shown to anybody.
--   name          the person's name as Google gave it, for the dashboard's
--                 "Signed in as" line and for the author of a change made in
--                 their name. Empty for an account that signed in with GitHub.
-- SQLite cannot take NOT NULL off a column where it stands, so the table is
-- built again under a second name, every row is copied across with every
-- value it had, the old table is dropped and the new one takes its name.
-- No other table, index, view or trigger names `accounts` (`sites.account_id`
-- is a plain column, not a foreign key), so nothing else has to change.
--
-- And for a site: `kept` is 1 while the site's files are in Kiln's own GitHub
-- organization, and empty for a site in its owner's own repository. Nothing
-- sets it yet.
-- The two columns of `sites` come first. If this file is ever run a second
-- time by hand, it stops here, because the columns are there already, and
-- `accounts` is not built again from its five old columns.
ALTER TABLE sites ADD COLUMN kept INTEGER;

-- What its owner called a site whose files Kiln keeps ("Oak Bakery"), as they
-- typed it. The dashboard shows it where another site shows its repository.
ALTER TABLE sites ADD COLUMN name TEXT;

PRAGMA defer_foreign_keys = true;

DROP TABLE IF EXISTS accounts_new;

CREATE TABLE accounts_new (
  id             TEXT PRIMARY KEY,        -- uuid
  github_login   TEXT UNIQUE,             -- GitHub login, or empty for a Google account
  email          TEXT,
  ls_customer_id TEXT,                    -- Lemon Squeezy customer id
  created_at     INTEGER NOT NULL,
  google_sub     TEXT UNIQUE,             -- Google's id for the person, or empty for a GitHub account
  name           TEXT
);

INSERT INTO accounts_new (id, github_login, email, ls_customer_id, created_at)
  SELECT id, github_login, email, ls_customer_id, created_at FROM accounts;

DROP TABLE accounts;

ALTER TABLE accounts_new RENAME TO accounts;
