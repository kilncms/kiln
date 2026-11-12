-- When a first pass at what can be edited was made on a site from the
-- dashboard (or found to have nothing left to mark), and the commit that made
-- it. Epoch milliseconds and a git commit id. NULL = not yet.
ALTER TABLE sites ADD COLUMN firstpass_at INTEGER;
ALTER TABLE sites ADD COLUMN firstpass_commit TEXT;
