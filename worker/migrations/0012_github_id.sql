-- An account that signs in with GitHub is now known by GitHub's own number for
-- the person, not by their login. A login is not permanent: a person can
-- rename their GitHub account, and somebody else can then take the old name.
-- Until now the renamed person found an empty dashboard, and whoever took the
-- old name signed in as the old account.
--   github_id     GitHub's number for the person (the `id` of their sign-in),
--                 which stays the same when they rename. Empty for an account
--                 that signed in with Google, and for an account made before
--                 this change until its person signs in again or the number
--                 is filled in by hand (scripts/fill-github-ids.mjs prints
--                 the statements). One account for a number. Never shown to
--                 anybody.
-- `github_login` stays as it is: still one account for a login (the UNIQUE of
-- 0008), and still what the dashboard shows. The worker writes the login
-- GitHub gives at each sign-in, and takes it off any other row first.
ALTER TABLE accounts ADD COLUMN github_id INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS accounts_github_id ON accounts(github_id) WHERE github_id IS NOT NULL;
