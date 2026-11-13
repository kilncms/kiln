# The command-line tool

Back to the [README](../README.md). `npx github:kilncms/kiln#release --help` prints every command with its options.

## Commands

`npx github:kilncms/kiln#release` with no arguments runs the setup wizard. Six more commands
cover the rest of the lifecycle (`--help` lists them with their options). `#release`
fetches the tool as it was last released, which is also what the editor and
`kiln doctor` mean by "latest":

```bash
npx github:kilncms/kiln#release doctor     # health-check an install: worker, app, CORS, bundles, members gate
npx github:kilncms/kiln#release update     # re-copy the latest editor bundles into the site, offer to commit
npx github:kilncms/kiln#release update --worker   # self-hosted: bring the worker in kiln-worker/ up to date, offer to deploy
npx github:kilncms/kiln#release add-site   # add this site to Kiln Cloud (opens the dashboard)
npx github:kilncms/kiln#release tag        # conservative auto-annotation pass (see above)
npx github:kilncms/kiln#release new        # scaffold a fresh site from a template repo, wizard-ready
npx github:kilncms/kiln#release rescue URL # crawl your builder-hosted site into a clean static copy
npx github:kilncms/kiln#release rescue URL --render   # the same for a site drawn by JavaScript (Lovable, v0, Bolt)
```

## Copying a site out of a website builder

`kiln rescue` is the escape hatch from Squarespace/Wix/WordPress: it crawls the
live site you own, localizes the assets, strips the builder's runtime scripts
(fixing the lazy-loaded images that depend on them), auto-tags the result, and
writes a report — a folder ready to push, host free, and edit with Kiln.

Pages are found by following links and by reading the sitemap, including the
sitemap *indexes* WordPress and Yoast publish (`sitemap.xml`,
`sitemap_index.xml`, `wp-sitemap.xml`). Files are copied up to 20 MB each and
250 MB in all; `--max-asset-mb` and `--max-total-mb` raise those limits (keep
one file under 25 MB, the most Cloudflare Pages accepts). A file that is not
copied still shows, loaded from the old site at its full address, and the
report lists it under **Files not copied** with the command that copies it:
those files disappear when the old site is switched off. The report has a section named **What to check**: the
contact and search forms that posted into the CMS and now send nowhere, the
comment threads that are kept as shown, and any links to the old sign-in, so
nothing stops silently.

## If your AI built a React app

Lovable, v0 and Bolt usually build a React app. The file the server sends is
an empty shell and the words are added by script, so there is no HTML for
Kiln to edit and plain `rescue` copies nothing useful. Freeze it first:

```bash
npm install playwright-core            # small, downloads no browser
npx github:kilncms/kiln#release rescue https://your-site.lovable.app --render --menu-shim
```

`--render` opens every page in a browser already on your machine (Chrome,
Edge, Brave or Chromium; `--browser /path` picks one), waits for it to finish,
scrolls to the end so lazy pictures load, and saves what it sees as plain
HTML. Pages are found from the links on screen, `sitemap.xml` and the routes
the app moves to. The app's own scripts are removed, the styles are kept, and
every page gets Kiln's two script tags. Add `--try` to serve the folder and
click a word straight away, with nothing published.

What it costs: the copy is a picture of the app at one moment. Anything the
app did with script afterwards stops: forms that were sent by script, sign-in,
search, carts, filters, tabs, carousels, counters, anything read from a
database when the page loads. `RESCUE-REPORT.md` lists every form and control
that stopped, and every page that came out differently on a second visit.
`--menu-shim` adds one small script so the phone menu still opens. After
freezing, the site is edited in Kiln, not in the AI builder: a new export from
the builder would have to be frozen again.

## Keeping a site up to date

`kiln update` is the self-host upgrade path: run it from your site's repo and it finds
where `kiln.js` lives, drops the latest `kiln.js` + `kiln-editor.js` + `kiln-features.js`
next to it, and offers to commit and push. `kiln doctor` reads `assets/kiln-config.js`
if present and checks the worker, GitHub App registration and install, site liveness,
CORS, and the members gate. It also fails when the repo has been renamed or moved on
GitHub and the config still has the old name. Correct the config and the worker
brings along everything it stores for the site (people, comments, suggestions,
scheduled posts, API tokens): it knows a repository by its GitHub id, not its name.
