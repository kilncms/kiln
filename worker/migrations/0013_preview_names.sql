-- A preview's Worker has a name no other preview has, whichever site it
-- belongs to. The name is made of the start of the site's id and the branch
-- (worker/hosting.js previewName), so two sites whose ids begin with the same
-- eight characters would otherwise share every preview name, and one site's
-- draft would show at the other's preview address. With this index the
-- database refuses the second row of a name, and the service leaves that
-- preview unmade (worker/hosted.js putPreview, the log line
-- preview_name_taken). A site's own Worker can never have a preview's name:
-- no site name begins with "pv-" (worker/hosting.js siteName).
CREATE UNIQUE INDEX IF NOT EXISTS previews_name ON previews (name);
