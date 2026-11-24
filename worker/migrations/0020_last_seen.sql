-- The operator's admin page lists who the customers are and where each one
-- stopped. Two moments it could not tell until now:
--   accounts.last_seen   when the person last signed in to the dashboard, or
--                        opened it while signed in, in milliseconds. Written
--                        at a sign-in, and otherwise at most once an hour for
--                        an account.
--   sites.last_publish   when a change was last saved to the site's
--                        repository through Kiln (someone publishing in the
--                        editor, a scheduled change going out), in
--                        milliseconds. Written at most once a minute for a
--                        repository. A commit made on GitHub directly is not
--                        a Kiln publish and is not counted.
-- Both are empty until the first such moment after this migration.
-- Apply this before the service that writes them. A service running on a
-- database this has not reached works as before and records neither.
ALTER TABLE accounts ADD COLUMN last_seen INTEGER;
ALTER TABLE sites ADD COLUMN last_publish INTEGER;
