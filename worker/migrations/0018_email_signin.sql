-- A person can sign in to the dashboard, or start on Kiln Cloud + hosting,
-- with an email address alone: Kiln sends the address a link and a code, and
-- opening the link or typing the code shows the address is theirs.
--   signin_email  the address an email sign-in confirmed, lower-cased. It is
--                 written once, when such a sign-in makes the account, and
--                 only then. Empty for an account that signed in with GitHub,
--                 and for one made by a Google sign-in.
-- An email sign-in finds an account only by an address Kiln itself has
-- confirmed: this one, or `google_email` (the address Google confirmed). Never
-- by `email`, which GitHub reports or a person typed, and nobody checked.
-- One account for an address: the index makes a second account with the same
-- confirmed address impossible, even when two sign-ins make one at the same
-- moment. SQLite lets many rows leave the column empty.
-- This touches no column another migration adds, so it applies the same
-- whether or not 0017 ran first.
ALTER TABLE accounts ADD COLUMN signin_email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS accounts_signin_email ON accounts (signin_email);
