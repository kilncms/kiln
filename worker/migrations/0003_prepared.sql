-- When Kiln was added to a site's repository from the dashboard (or found
-- already there), and the commit that added it. Epoch milliseconds and a git
-- commit id. NULL = not yet, or added by the setup tool and never looked at.
ALTER TABLE sites ADD COLUMN prepared_at INTEGER;
ALTER TABLE sites ADD COLUMN prepared_commit TEXT;
