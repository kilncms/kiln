-- One copy of a site that is brought in from somewhere else ("Bring my site
-- in", worker/bring.js): a job outside the service reads the old site at
-- `address`, writes it as plain files into the repository Kiln keeps for
-- `site_id`, and tells the service how it went. Each try is a row of its own,
-- so an answer that comes late for an earlier try changes nothing.
--   id           the job's id: 32 hex characters, made by the service and sent
--                back by the job with its answer
--   site_id      the site the copy is for. Kiln keeps its files (sites.kept = 1)
--   account_id   the account that asked for it
--   address      the old site's address, as the service tidied it. The service
--                never reads it: only the job does
--   branch       the branch of the site's repository the copy is written to
--   state        'copying'  the job was started and has not answered yet
--                'done'     the copy is in the repository
--                'failed'   it did not work (`reason` says why)
--   reason       for a row that failed: 'unreachable' (the address did not
--                answer or refused to be read), 'blank' (the pages came out
--                blank, even in a browser), 'nothing' (no pages were found),
--                'tool' (anything else the job reported), 'no_answer' (the job
--                said nothing for 30 minutes), 'no_job' (the job could not be
--                started), 'removed' (the site was removed before the answer)
--   pages        how many pages were written
--   rendered     1 when each page was opened in a browser first, else 0
--   report       what the copy left out and what to check, for the dashboard
--   tries        which try for the site this row is: 1, 2 or 3
--   asked_at     when the job was started
--   done_at      when it answered, or was given up on
-- Times are epoch milliseconds.
CREATE TABLE IF NOT EXISTS conversions (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  address     TEXT NOT NULL,
  branch      TEXT,
  state       TEXT NOT NULL,
  reason      TEXT,
  pages       INTEGER,
  rendered    INTEGER,
  report      TEXT,
  tries       INTEGER NOT NULL DEFAULT 1,
  asked_at    INTEGER,
  done_at     INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversions_state ON conversions(state);
CREATE INDEX IF NOT EXISTS idx_conversions_site ON conversions(site_id);

-- Each time an account starts a site Kiln keeps the files of (keeps.js), one
-- row. The row is written before anything is made and stays when the site is
-- removed, so what one account starts over time can be counted, whatever it
-- removes. The same rows say when an account's free days began: with the
-- first site it ever started here.
--   id          the row's own id
--   account_id  the account that asked
--   at          when it asked
--   site_id     the site the start made, once it is in the account's list.
--               Empty for a start that did not finish
CREATE TABLE IF NOT EXISTS kept_starts (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  at          INTEGER NOT NULL,
  site_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_kept_starts_account ON kept_starts(account_id, at);

-- The address Google confirmed for a person at their last sign-in. An account
-- that signed in with Google is written to at this address and at no other,
-- and it is the address on what Kiln publishes in their name: nobody confirmed
-- an address that was typed into the dashboard. Written at every Google
-- sign-in. Empty for an account that signed in with GitHub, and for a Google
-- account that has not signed in since this column came.
ALTER TABLE accounts ADD COLUMN google_email TEXT;
