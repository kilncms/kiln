-- A site that Astro builds, on Kiln's hosting (worker/hosting.js). Its
-- repository holds source, and the pages exist only after a build, so Kiln
-- copies the branch a build in the customer's own repository pushes the pages
-- to (kiln-built) where it copies the default branch of a plain site.
--
--   built             1 for a site that is published from that branch
--   built_sha         the commit of that branch that is up now
--   build_tool        'npm' or 'pnpm': which of the two the build file installs with
--   build_state       'needs_file' while the repository has no build file,
--                     'failed' when the build of the commit below stopped,
--                     and nothing otherwise
--   build_wanted_sha  the commit the owner last pushed to the default branch
--                     that has not shown up in a build yet
--   build_wanted_at   when Kiln first saw that commit (ms). Fifteen minutes
--                     later with no build, the dashboard says the build is late.
--
-- A database this migration has not reached keeps hosting plain sites as
-- before: every query that names these columns asks again without them.
ALTER TABLE hosting ADD COLUMN built INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hosting ADD COLUMN built_sha TEXT;
ALTER TABLE hosting ADD COLUMN build_tool TEXT;
ALTER TABLE hosting ADD COLUMN build_state TEXT;
ALTER TABLE hosting ADD COLUMN build_wanted_sha TEXT;
ALTER TABLE hosting ADD COLUMN build_wanted_at INTEGER;
