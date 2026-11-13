-- The account a forwarded address belongs to, kept on the row itself.
-- Until now a row of `forwards` was tied to its account only through its site
-- (forwards.site_id to sites.id to sites.account_id). When a person removes a
-- site, the site's row goes and the forwarded address stays on purpose, so
-- mail to the removed site's domain keeps arriving. From then on nothing said
-- whose the row was, and the same person, asking for the same inbox on a new
-- site, was refused as if the inbox were somebody else's.
--   account_id   the account whose site the row was first saved for. Written
--                once, when the row is made (worker/domain-mail.js
--                saveForward), and never changed after. Empty on a row whose
--                site was removed before this migration reached the database:
--                nothing is left there to say whose it was.
ALTER TABLE forwards ADD COLUMN account_id TEXT;
UPDATE forwards SET account_id = (SELECT account_id FROM sites WHERE sites.id = forwards.site_id) WHERE account_id IS NULL;
