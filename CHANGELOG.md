# Changelog

All notable changes to Kiln are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Formatted text on a site Astro builds.** An entry's body, formatted or
  not, is edited on the page with the same toolbar as a plain HTML site: bold,
  italic, links, lists (nested too), headings, quotes, line breaks. The editor
  reads the entry's Markdown (`POST /source/read`), matches each block on the
  page to its block in the file by what it says, and writes back only what
  changed, in the file's own style: a block nobody touched keeps every byte, a
  changed word rewrites that word, and a reference link, a hard break or a
  wrapped line stays as the file wrote it. Pictures in the text go back as the
  file wrote them (Astro shows its optimised copies at other addresses). A
  table, a code block, raw HTML, and in MDX a component or an expression, stay
  as they render, take no typing and say why when clicked. MDX prose is
  editable; the worker takes an MDX edit only when every import, export,
  component and expression is as it was, with none added. A field stamped
  `{ type: 'markdown' }` is edited the same way, and a YAML block (`|`) stays a
  block. A text that no longer says what the file says (someone changed it
  since the page was built) is not offered until the site has rebuilt. Needs a
  worker whose `/healthz` says `sourceMarkdown`; with an older one a formatted
  text stays read-only, as before.
- **TOML front matter** (`+++`) is read and written like YAML: comments, quoting
  and key order stay. JSON front matter and data files are read and written the
  same way (`src/adapters/json-splice.js`), for the generators to come.
- **Markdown keeps its markup and adds none.** A change to a Markdown body or
  field may keep the scripts, frames and embeds the field already holds (an
  owner's video embed survives an edit to another paragraph) and may add none,
  including a link or a picture whose address would run code (`javascript:`
  and the like), which the old check could not see in Markdown.
- **Pictures and link addresses on a site Astro builds.** A picture stamped
  `kilnSource(entry, 'cover', { type: 'image', alt: 'coverAlt' })` is replaced
  from the device and described from its toolbar. The picture is made
  web-sized (WebP, or JPEG where the browser cannot write WebP), checked
  against the upload limits, put in the folder the field's picture is already
  in (beside the entry for a path `image()` checks, under `public/` for an
  address), committed before the entry, and named in the field in the file's
  own style. A picture inside an entry's text is replaced the same way and only
  its line changes. A link's address (`opts.href`, or `{ type: 'url' }` on an
  `<a>`) is typed in the toolbar beside its words. The worker writes a picture
  path only when the picture is in the repository, and refuses a new picture in
  Markdown that is not there (`/healthz` says `sourceMedia`; with an older
  worker these stay read-only).
- **Entries on a site Astro builds.** `kilnEntry(entry)` marks a card or an
  entry's article, and the editor gives it an Entry button: make it a draft or
  put it on the site, put a draft on the site later with the worker's
  scheduler, move it up or down by the collection's order field, copy it, see
  its History, remove it (asked first in the editor's own box; a commit that
  History undoes). **New post or page** adds an entry from the collection's
  schema: the box asks for the title and each required field, the file is named
  from the title and never written over. **Entries & drafts** lists a
  collection with its drafts first. Drafts follow `draft: true`, or the field
  `kiln-config.js` names (`draftField`, `draftValue`). New worker routes:
  `/source/create`, `/source/remove`, `/source/fields`, `/source/history`, and
  `/schedule` with `source` edits; `/healthz` says `sourceEntries`.
- **History and Page settings on a generated page.** History lists the
  versions of the page's entry file with a preview and **Go back to this**, and
  the entries removed from the page's collections with **Bring it back**. Page
  settings changes the entry's title, description and social picture in its
  front matter. **Schedule for later…** takes staged content-file edits.
- **A field an entry does not have yet** can be added by an edit that asks for
  it (`add: true`), in YAML, TOML or JSON front matter: a draft mark, an
  order, a description.
- **The site's own schema, before the build.** `kiln()` in `astro.config.mjs`
  publishes the collections' schemas at `/kiln-schema.json` at the end of each
  build, from what Astro writes in `.astro/collections/`. The editor reads it
  and refuses, with a sentence, a value the next build would reject (too long,
  not a full web address where the schema wants one, empty where it is
  required, not one of an enum's words). References made by the helpers carry
  the entry's collection (`?c=posts`).


- **The release runs the end-to-end tests itself.** With the two test
  repositories named (`KILN_E2E_REPO`, `KILN_E2E_SOURCE_REPO`),
  `npm run deploy:test` runs both tests on staging after the deploy, and
  `npm run deploy:prod` runs them on staging again before production is
  touched. Without them the output says the tests did not run. The migrations
  step is asked once more when Cloudflare refuses it the first time.
- **`kiln update --worker`** — for self-hosters. Brings the worker the setup
  wizard made (`kiln-worker/`) up to the current version: it lists the files
  that differ, asks, replaces them, adds any dependency the worker now needs,
  and asks again before running `npx wrangler deploy`. After a deploy it reads
  the version back from the worker. `wrangler.toml`, secrets and stored data
  are never touched. Until now the only way was to copy the files by hand.

- **`kiln rescue --render`** — freezes a site that is drawn by JavaScript (what
  Lovable, v0 and Bolt usually build) into HTML that Kiln can edit. Each page is
  opened in a browser already on the machine (Chrome, Edge, Brave, Chromium; or
  `--browser <path>`), left to finish, scrolled to the end so lazy pictures
  load, and saved as it looks. Pages are found from the links on screen,
  `sitemap.xml` and the routes the app moves to. The app's scripts are removed,
  styles that existed only in memory are written into the page, and
  `RESCUE-REPORT.md` lists what stopped working: every form, every control
  that needed script, every page that came out differently on a second visit.
  `--menu-shim` adds one small script so the phone menu still opens, and
  `--try` writes a try-out config so the copy can be served and edited at
  once. `playwright-core` is an optional peer, looked up only for `--render`;
  nothing is downloaded. Rescued pages now also carry Kiln's two script tags.
- **Publish sheet** — every Publish control first shows what will change: each
  edit as before and after in the page's own words (text word by word, pictures
  as two thumbnails, added and removed blocks named), a control to drop one
  edit, a one-line note that becomes the commit message, and warnings that do
  not block (a picture with no description, a link that goes nowhere, an empty
  heading). A bottom sheet on phones; Ctrl/Cmd+Enter publishes. Suggest-only
  editors get the same sheet ending in **Send for review**. **Settings →
  Publish without the preview** turns it off in one browser.
- **Undo after publishing** — the confirmation reads "Published. Undo" for ten
  seconds. Undo is one more ordinary commit that puts the page file back
  exactly as it was, written against the file as it stands, and the edits come
  back as unpublished. If someone else has published to the file since, nothing
  is written and History is offered instead.
- **"From this site"** — replacing a picture now offers the pictures the site's
  repository already holds, beside Upload: names, folders and sizes, a search
  box, the pictures on the current page first. Choosing one commits no new
  file. An editor limited to certain folders sees only pictures in them.
- **Help** in the Kiln menu, the top bar and Search, opening the guide for
  whoever is signed in.
- **First-session guide for invited editors** — the demo's three steps (edit a
  heading, publish it, what happened), shown once to an editor who can publish.

- **Source-mode worker endpoints** — the worker can now edit the content files
  a generator-built site is rendered from, not just finished HTML.
  `POST /source/commit` applies typed, per-field edits to a content file
  through a source adapter (Astro first): frontmatter values are spliced
  surgically (comments, quoting, and key order survive byte-identical), each
  edit is validated for its declared type (date, time, url, boolean, number)
  plus a markup guard on every text value, bad edits are skipped individually
  instead of failing the batch, and a concurrent save re-applies your edits
  once on top — the same merge model HTML publishes use. `POST /source/revert`
  restores a file to its content at any commit, the one-click release valve
  when a bad edit breaks the site's build. `POST /source/duplicate` copies an
  entry to the first free `-copy` sibling ("add another event" in v1).
- **`GET /healthz` capability handshake** — now answers
  `{ ok, modes, adapters, version }` so editors can feature-detect source
  support; an old worker (or old editor) degrades gracefully instead of
  erroring.
- **Wizard: "How is this site built?"** — setup now detects generator-built
  repos (Astro, Eleventy, Hugo, Jekyll signals) from the local tree, shows
  what it found ("Found astro.config.mjs and 63 content files"), and asks the
  mode question in plain language. Choosing source mode writes
  `mode: 'source', adapter: 'astro'` into the generated kiln-config.js and
  prints the remaining source-mode steps (install `@kilncms/astro`, verify the
  host auto-deploys, check the build's Node version). Choosing HTML mode over
  committed build output gets the guard warning: edits to `dist/` are erased
  on the next build. Self-hosted workers generated by the wizard now carry
  `src/adapters/` and the `yaml` dependency (added to existing installs on
  re-run) so they can serve source commits.
- **`kiln doctor` source-mode checks** — warns when a repo looks like a
  generator build but the site is in HTML mode (the silent-data-loss trap),
  and in source mode verifies the worker's `/healthz` advertises source
  support — an older worker warns instead of failing.
- **Source-mode editing in the editor** — pages carrying `data-kiln-source`
  provenance are editable in place, exactly like `data-cms` fields: click the
  text, type, Publish. Edits are grouped by content file and committed one
  file at a time ("Saving 3 changes across 2 content files."), with the honest
  §11 publish states — **Saved → Building… → Published ✓ / Build failed ✕** —
  driven by the commit's real status and deployment polls; a failed build gets
  a banner with one-click **Undo this change** per committed file (reverts to
  the commit's parent). Fields show "Where does this come from?"
  (`events/e.md → title`), a worker without source support renders them
  read-only with a lock and tooltip, malformed provenance warns once and locks
  the field, and an element carrying both `data-cms` and `data-kiln-source`
  edits its source (with a console warning). Undo/redo, the modified markers,
  the Publish count, sandbox previewing, and suggest/review gating all treat
  source edits as first-class. HTML-mode sites that resolve a page inside
  committed build output now get the §7.3 blocking explanation instead of
  silently-erased edits.
- **`@kilncms/astro`** (`integrations/astro/`) — provenance helpers for Astro
  sites: `{...kilnSource(entry, 'title')}` / `{...kilnBody(entry)}` stamp
  `data-kiln-source` on rendered fields, one line per field. Helpers never
  throw, and `KILN_DISABLE=1` strips provenance from a build. The `kiln()`
  integration is a documented no-op in v1; automatic stamping and schema
  export land under the same entry point later.
- **A Publish button beside the pencil** — as soon as there is an unpublished
  edit, a labelled button ("Publish 1 edit", "Publish 3 edits") appears with
  Undo and Redo above the pencil, at every screen size. It runs the same
  publish as the menu item, which stays. Publishing while still typing in a
  field now includes that field.
- **Editable fields show themselves** — when editing starts, every editable
  field shows its outline for a moment and fades back. On touch screens a faint
  outline stays, since there is no hover to find fields with.
  `prefers-reduced-motion` gets the outlines without the fade.
- **A first-run guide in the demo** (sandbox mode only, once per browser,
  skippable) — points at the first heading ("Click this and type."), then at
  Publish ("Now publish it."), then shows a card titled "That was a Git commit"
  with the text before and after and the commit message a real site would get.
- **Keyboard support for the pencil menu** — Enter or Space opens and closes
  it, the arrow keys move through its items, Escape closes it and returns
  focus to the pencil.
- **`templates/_headers`** — new sites get a small `_headers` file from the
  wizard: `X-Content-Type-Options: nosniff`, a referrer policy,
  `frame-ancestors 'self'` (so another site cannot frame the editor) and HSTS.
  An existing `_headers` is never touched. No script-restricting
  Content-Security-Policy is shipped; `docs/for-site-owners.md` explains how to
  add one and what Kiln needs allowed.
- **`scripts/ui-check.mjs`** — a browser check of the first minute of editing
  against a locally served sandbox site, at three screen sizes: Publish is
  visible after one edit, nothing of the editor covers another part of it, the
  page never scrolls sideways. Needs Playwright (`PLAYWRIGHT_DIR`); not part of
  `npm test`.
- **Member sign-ins can be ended** — removing a member, or changing their
  entry, now ends a sign-in they already hold. The members gate asks the
  worker (`POST /members/check`) at most every five minutes whether each
  signed-in member is still on the list; if the worker cannot be reached the
  last answer stands for up to an hour, then the gate closes. Sites set up
  earlier get the new gate with `kiln update` (their worker must be current
  first: `/healthz` reports `memberSessions`), and their members sign in once
  more. `kiln doctor` fails on a site that still has the old gate.
- **A release path** — `npm run deploy:prod` is now `scripts/release.mjs`, the
  only way to production. It refuses, with one sentence saying what to do,
  unless the commit is on `main`, pushed, green in CI, matches `dist/`, and is
  already running on staging; then it applies database migrations, tags
  `prod-YYYY-MM-DD`, deploys, and checks. `--dry-run` changes nothing.
- **Version reporting** — `/healthz` adds `build` (the commit the worker was
  deployed from). `kiln doctor` prints site bundle, worker and latest release
  on one line. `KILN_BUILD_VERSION` fixes the build stamp, so a release
  deploys the bytes it built.
- **Database migrations** — the Kiln Cloud schema lives in
  `worker/migrations/` and is applied with `wrangler d1 migrations apply`.
- **The setup wizard adds the two script tags** — it lists the pages that do
  not load the editor and offers to add the tags before `</body>`. A page that
  already loads `kiln.js` is never touched and a second run changes nothing.
  `kiln doctor` fails when the home page does not load `kiln.js`.
- **`kiln --help`** — one line per command, the options each takes, and the
  five words a newcomer meets. `--help` with a command runs nothing; an unknown
  command prints the help and exits 2; an option a command does not have is
  refused by name; `--version` prints one line.
- **`/healthz?deep=1`** — asks KV, the database and GitHub, and answers 503
  naming the part that failed. A plain `/healthz` is unchanged.
- **Backups** — `scripts/backup-cloud.mjs` copies the Kiln Cloud database and
  the KV keys that cannot be recreated into one owner-only archive outside the
  repository (14 kept); `scripts/restore-kv.mjs` puts KV back and refuses
  production without `--i-mean-production`. A launchd template runs it nightly.
- **`worker/wrangler.example.toml`** — a complete configuration for a
  self-hosted worker, with the three values to change marked.
- **CI on every push** — tests on Node 20 and 22, a rebuild that fails when
  `dist/` does not match the sources, the worker bundled in every
  configuration, `npm audit`, and a markdown link check. A monitor workflow
  checks the production worker and the demo sites every 30 minutes.
- **`docs/PUBLISHING.md`** — the three npm packages are one command from
  publishable; nothing is published yet.

### Changed

- **A repository is its GitHub id, not its name.** The worker now records the
  id of every repository it meets. When a repository is renamed or moved to
  another account and the site's config is corrected, the people list and a
  Kiln Cloud registration move to the new name the first time anyone uses it;
  until then a site that still has the old name keeps working. If the old name
  later answers as a different repository, that repository gets none of the
  people stored for the first one: owner requests under the name are refused
  with the reason. Member sign-in compares repositories by id, so an origin
  registered under the new name accepts a site whose config has the old one.
  `kiln doctor` asks the worker and fails on a rename (private repositories
  included) and on a name that changed hands. Backups include the new records.
- **Everything a site stores follows a renamed repository.** Not the people
  list alone: comment threads, suggestions, scheduled posts, API tokens and
  members' sign-ins move to the new name too, the first time anyone uses it.
  A large site is moved in steps (about a dozen threads a request, about a
  hundred every five minutes by the cron) and nothing is hidden or counted
  twice meanwhile. Editors sign in once more; members stay signed in. A site
  that still has the old name keeps reading and writing the same things. A
  post scheduled before the rename is published once, to the repository it
  was made for. If the old name later answers as a different repository, that
  repository gets none of it: comments, suggestions, schedules and tokens are
  held under the name exactly as the people list was. `kiln doctor` says that
  changing `repo` is safe and what follows. A repository followed by the
  release before this one has the rest follow on its next request.
- **"Latest" means released, everywhere.** The editor's "a newer Kiln editor is
  available" notice now reads the build stamp on the `release` branch, which
  each production release moves, as `kiln doctor` already did. Work on `main`
  that has not been released is no longer offered as an update. The guides and
  every message the tool prints now say `npx github:kilncms/kiln#release`, so
  the tool that is fetched is the released one too.

- **The "Make things editable" grant now does something** — its two tools were
  drawn for the owner only. An editor granted it in People & access sees them
  (not a suggest-only editor or a reviewer, and not on a page outside their
  folders).
- **"+ Add section" dividers on phones** — only the two around the section
  last touched are shown, and at every size a divider hides while it is under
  the Undo, Redo and Publish row, the pencil or the demo banner.
- **`kiln rescue`** follows the first page to the site's real address (a
  builder's subdomain that forwards to the owner's domain), names an error
  page that was answered as a normal one, and `--max-pages 6` (with a space)
  is now read as 6.
- A picture's description is part of what Undo restores.

- **Invited editors can upload a fixed list of file types** — pictures (JPG,
  PNG, GIF, WebP, AVIF, ICO), PDF, Word / Excel / PowerPoint and OpenDocument
  files, fonts, audio and video, up to 15 MB each, and the file's first bytes
  must match its name. Everything else is refused with a plain message, in the
  editor when the file is picked and by the worker on every write path. SVG is
  refused outright. The owner, who commits with a GitHub sign-in, is not
  affected.
- **`.xhtml` pages are no longer editable by invited editors or API tokens** —
  they are parsed as XML, where the HTML content guard cannot vouch for them.
- **Scheduled edits and suggestions from editors are for HTML pages only.**
- **Comments follow an editor's page scope** — an editor limited to some pages
  reads, counts, posts and resolves comment threads on those pages only.
- **`kiln doctor` fails on a renamed or transferred repo** — it used to warn
  and still report "healthy". It also no longer reports Google sign-in as
  configured when the worker does not answer.
- **On phones a block's controls open from one "more" button** per block,
  instead of five buttons on every card.
- **The status line wraps** instead of cutting a long message off, and on a
  phone it leaves after four seconds or on a tap.
- Editor bundle grows to ~484 KB raw / ~146 KB gzip (still loaded only after
  sign-in; the visitor shim is unchanged at ~3 KB gzip).
- **`worker/wrangler.toml`** — production moved under `[env.production]`. The
  top level is a local-development configuration with placeholder ids, so
  `npx wrangler deploy` with no `--env` cannot reach production.
  **Self-hosters who edit this file by hand:** set `name`, the KV id and
  `ALLOWED_ORIGINS` at the top and delete the D1 block; there is no route
  block to delete any more. Sites set up with the wizard are not affected.
- **Bundle propagation is two steps** — `npm run propagate` updates the
  canary (the demo) only. Customer sites are a second, explicit
  `npm run propagate -- --customers`, refused unless the canary's live
  `kiln.js` carries the new build. The run stops at the first failure, sends
  only a released build, never publishes a checkout's own unpushed commits,
  and prints the revert command for every commit it pushes. It is no longer
  part of `deploy:prod`; `deploy:worker` is removed.
- **Kiln Cloud: cancelling keeps editing until the paid period ends** — a
  cancelled subscription used to switch editing off at once. The site now
  edits until the end of the period already paid for. After a failed charge
  (or paused billing) editing continues for 7 days while the card is retried.
  Only an expired subscription ends access outright.
- **Kiln Cloud: removing a site cancels its subscription** — in the same
  request, before the site is removed. If the cancellation cannot be
  confirmed, the site is kept and the answer says to cancel in Manage billing.
- **Tool grants are enforced by the worker** — an editor without the Theme
  grant cannot write a stylesheet, without New post cannot add a page to a
  published branch, without Drafts cannot write to `kiln-drafts`, without
  Schedule cannot schedule, and without Comments cannot comment (a review
  seat still can). These were hidden buttons before; a refused write answers
  403 with `code: "grant_required"`.
- **Presence writes** — an open editor wrote to KV every 30 seconds, enough to
  use up a free Cloudflare account's 1,000 daily writes in one working day and
  stop sign-in. It now writes on arrival, on a page change and every five
  minutes. Someone who leaves is listed for up to six and a half minutes.
- **`scripts/e2e.mjs`** — runs against the staging worker and a marked test
  repository, as invited editors, and puts the repository back as it found
  it. It no longer touches the public demo or the production worker.
- **dompurify 3.4.16** (from 3.4.9, inside the range of published
  advisories), now listed under `dependencies`. wrangler 4.147.

### Fixed

- **On a phone the editor's controls are one row.** Undo and Redo (as icons,
  named for screen readers), Publish and the Kiln button sit side by side at the
  bottom, where they used to be two floating rows over the bottom of the page.
- **Which editor each site runs.** The editor says its build with its presence
  ping; the worker keeps it per repository (`ebuild:<repo>`, written when it
  changes or once a day) and the operator's overview (`/admin/cloud/overview`)
  carries `editor_build` and `editor_seen` for each site.
- **Security headers for sites set up before Kiln wrote them.** `kiln update`
  on a site with no `_headers` file offers Kiln's (asked first); a site's own
  file is never touched.
- **A written procedure for deleting what Kiln keeps**
  ([docs/deleting-data.md](docs/deleting-data.md)): what the worker stores about
  people and sites, what deletes each part, and the steps for an invited person
  and for a whole account.
- **On an Eleventy, Hugo or Jekyll site nothing suggests a source mode that
  does not exist for it.** The editor's "This page is build output" box, the
  setup wizard and `kiln doctor` say that Kiln can't edit that generator's
  content files yet (Astro is the one it edits) and what HTML mode does there,
  instead of telling the owner to switch to source mode.
- `kiln update` on an Astro site whose `src/lib/kiln-astro.mjs` is an older
  copy of Kiln's helper says so and offers the newer one (asked first; a file
  that is not Kiln's is left alone).
- A formatted text from a content file, saved in the browser and brought back
  after a reload, is published as Markdown again (it was sent as plain words),
  and a picture put in it or in a picture field comes back with its file.
- **Undo could leave what it restored invisible, and a publish wrote one
  visit's state into the page file.** The editor copied each field's markup as
  it started, while the site was still animating in. On a site whose headline
  slides in, Undo put back the start of the slide, which cannot be seen, and so
  did "Drop" in the publish sheet and History's "Undo this change" in try-out
  mode, which then published it. A field's HTML was also read off the live
  page, so a publish wrote whatever the site's scripts had put there: an
  animation library's `opacity` and `transform` on a headline's lines, the
  class a fade-in adds to a paragraph.
  - What Undo goes back to is taken when the person begins to change a part (a
    press on it, its toolbar opening, a press on one of a list's buttons), for
    as long as no change to it is waiting. A link's address and a picture's
    address, description and size have a baseline the same way, so a picture
    a lazy loader has put in place is the one Undo returns to.
  - A field is published as the page's file would hold it. An element the file
    has inside the field keeps the file's `class` and `style`, plus what the
    person changed while editing; what a script added is not written, and a
    class or style the file has is not lost when a script takes it off. The
    same holds inside the fields of a list's blocks, and for the size a
    picture is dragged to.
  - Undo, Redo, Esc, "Drop", History's two ways back, a draft and "Pick up
    where you left off?" no longer write a field with `innerHTML`. The
    elements that are there stay, with whatever the site's scripts are doing
    to them; one that was typed away comes back as itself; a new one is given
    what the scripts gave another of its kind. A part that fades in on scroll
    still does after a draft is put back on it.
  - A field counts as unchanged when it reads as its baseline does, so an
    animation that moved on while the field was open is not an edit.
  - Undo of a link's new address, or of a picture's new size, puts the old one
    back on the page; it used to leave the new one there with nothing staged.
  - Try-out mode: a demo stored by the editor that had the fault is mended once
    per page as it opens, so a headline that was stored invisible shows again.
  Not covered: words a script splits into pieces of its own inside a field, a
  class or style a script first sets on an element while it is being edited,
  and the address of an editable picture that a lazy loader also changes.
  Those are published as they are on the page, as before.
- **The publish sheet hid a change, and the number on Publish did not follow
  what was done.** A price changed in a list, then an item added to the same
  list: the sheet said only "Added", and the button stayed at "Publish 2
  edits" through an add, a move and a removal. Every change to a list is named
  now: each item added and removed, a change of order, and each item that was
  changed, by its name, with its words (or its picture) before and after. The
  number on every Publish control, the sheet's title and the menu's badge is
  the number of things the sheet lists.
- **A tap on a copy of an editable part did nothing a person could read.** A
  page often shows one thing twice and only one of the two was marked as
  editable. Where the editor can tell (the same words inside a link to the
  same address as one editable part, or words only one editable part has), a
  click on the unmarked copy says "This copy can't be changed here. The same
  words can, in Products." with **Show me**, and its link is not followed
  (Ctrl or ⌘ and a click still follows it). A picture or a line nobody marked,
  inside a block whose other parts are editable, says so. Nothing is made
  editable that was not, and a link in a `nav`, `header` or `footer` is never
  taken over.
- **The menu, the search panel and the toolbars were see-through** where a
  browser does not draw the blur behind them: the page's own words showed
  sharply through. Their background is solid enough to read on its own.
- **A photograph was stored as PNG by a browser that cannot write WebP**
  (Safari), ten times the size it should be, under a `.webp` name. Such a
  browser writes JPEG now, or PNG for a picture with see-through parts, and the
  file is named for what it is. In try-out mode this is why a normal photo
  would not publish on a phone ("This browser has no room left for the demo").
  The demo also no longer keeps a second, full-size copy of each picture in the
  browser, refuses a picture larger than 1 MB after it is made web-sized with
  its size and the limit, before anything is kept, and "no room" points at
  dropping a picture before "Start over". Undo or Drop of a new picture frees
  the full-size original it brought with it.
- **Undo after removing a list item ran the page to the middle of the list**,
  screens away from the item that had come back. Undo and Redo show the block
  that came back and move the page only as far as it takes to see it.
- **"Removed. Undo" could vanish after a second or two.** In try-out mode the
  first status line's timer was lost while the editor started and went off on
  whatever line was showing four seconds into the visit; and after a publish
  the return of "Signed in as…" replaced a newer line. The line has its ten
  seconds, the same as "Published. Undo".
- **"Start over" and "Delete draft" acted at once.** Each asks first, in the
  editor's own dialog, and says what would be lost.
- **Small things.** "Add event" and "Add person" pressed with an empty form
  say what is missing. Advice about keys ("Esc cancels", the hints under
  Search & jump, "hover for the menu") is shown only where there is a
  keyboard, and choosing a place for a new section has a Cancel button. Search
  & jump searches all of a part's words, not its first 42 characters, shows
  the words around what it found and goes to the item that holds them; lists
  the pages this page links to where there is no repository to list (try-out
  mode); finds words on the page that are in no editable part and says they
  are not editable; and no longer lists a part because its name happens to
  contain the typed letters in order. "Schedule these 1 edit" reads "Schedule
  this edit". A note typed under "What changed?" survives a try-out publish
  that did not fit. The demo calls its visitor "You", not "You · editor". On a
  phone the line of words sits below the site's own header, and at the top of
  the page below its banner, not on the logo. An events list or gallery added
  from the menu has its heading in the site's own heading type and each event
  set apart (on a site with no styles of its own for `.kiln-event`; the
  section is marked `kiln-plain`). People & access says what it means in an
  owner's words, its help text is larger, and the AI assist box is not offered
  when the worker says the site has no AI key (`aiConfigured: false` from
  `/admin/people`; a worker that says nothing leaves the box as it was).
- **The worker says whether it has an AI key.** `GET /admin/people` now
  answers `aiConfigured` beside `googleConfigured`, so People & access does not
  offer "AI assist" on a worker with no `AI_API_KEY`. The key itself is never
  sent. Self-hosters get it with `kiln update --worker`.
- **On a site a generator builds, nothing is written over unasked and nothing
  is offered that cannot be done** (source mode):
  - A field someone else changed since the page was built was written over
    without a question: the owner renames an event, an editor whose page still
    shows the old name publishes another, and the owner's is gone. An edit now
    says what its field showed when the page was read, the worker leaves that
    one edit out when the content file no longer says that, and the editor asks
    **Someone else changed this**, showing Theirs and Yours, with **Keep
    theirs** and **Use mine**. The other edits of the same publish are saved.
    An editor from before this sends nothing about what it read and is saved
    as before; this editor against a worker from before this is saved without
    the question, as before. `/healthz` says `sourceWas: true`.
  - A `url` field took any words ("Get tickets" was saved as an address). It
    takes a web address (`http:`, `https:`), `mailto:`, `tel:`, or a place on
    the site (`/about`, `./about`, `#top`), and the editor says so when the
    field is left.
  - An edited value lost the quotes its line had: `start: '18:00'` became
    `start: 18:30`, which a YAML 1.1 reader takes for the number 1110. A quoted
    line stays quoted, in its own quotes, and on an unquoted line a time and
    any text a reader could take for something else (yes, no, on, off, a
    number with a leading zero, a date) is quoted. Text beginning with `#` was
    written unquoted, which made it a comment and the field empty; it is
    quoted. Inside a bracketed list a value with a comma is quoted.
  - Saving an entry's text removed the blank line after the frontmatter. The
    file stays as it was around the text.
  - Search & jump listed `/public/kiln.html`, the sign-in page under an address
    that does not exist, as the site's only page. It lists the site's real
    pages: from the adapter's routes, the links on the pages and the sitemap,
    each checked against the built site before it is listed. "Search site
    text" searches those pages, and "On this page" lists the fields that can
    be edited.
  - A suggest-only editor could type into a field, was offered "Suggest
    changes", and was then told no. Those fields are read-only for them from
    the start and say why. A comment-only editor was told "Click any outlined
    text to edit." with nothing outlined, and Comments on a generated page
    opened, and every comment written there was then refused (a comment is
    filed under the page's file, and such a page has none): Comments is not
    offered there.
    The first line each person reads says what they can do on that page.
- **A comment-only editor saw a greyed Publish** at the top of the menu, on any
  site, and a "This page" heading over nothing. Neither is shown.
- **On a phone, three bars lay on the status line**: the failed-build banner,
  the box that lists what was not saved, and the bar a History preview shows,
  which was a narrow box over the site's own header. They share one column,
  above the pencil and its buttons, as wide as the screen. The History bar
  read "Keep — then Publish"; it says "Nothing is live yet. Keep it, then
  press Publish.", with Cancel and Keep.
- **The first tip of a first session lay on the paragraph under the heading.**
  It goes beside the heading's words when there is a paragraph under it and no
  room over it. (On a phone, with a heading as wide as the screen at the very
  top of the page, it is under the heading still.)
- **The last two questions asked in the browser's own box** are the editor's:
  a preview link that could not be copied is shown selected in its dialog, and
  making text editable whose words in the page's file differ from those on
  screen is asked in one dialog that shows both.
- **Editing a page a generator built** (source mode), watched in a browser for
  the first time, as an invited editor on pages Astro built:
  - An entry's text was saved as the plain words on the page, so changing one
    word of a description wrote it back without its bold, its links, its list
    and its paragraphs. A text with formatting is now read-only on the page
    and says why; a text that is one plain paragraph is edited in place, and
    what is typed is saved as words.
  - A number or a yes/no could never be saved (the editor sent words, the
    worker takes a number and true or false). A date, a time, a number or a
    web address of the wrong kind was staged without a word and refused at
    Publish with the reason in a tooltip. The line now says how to write it
    when the field is left, and before that when the page shows the value in
    the site's own way.
  - A link stamped with its address was edited by its label, and the label was
    saved as the address. It is read-only, like a picture. Anything the worker
    would turn away for what it is (the site's own files, a folder this person
    was not given) is read-only before anyone types. A click on a read-only
    part says why in the status line, where a phone can see it.
  - The publish sheet, "Pick up where you left off?" and Copy my text named
    fields by pointer ("/Frontmatter/Title"). They say "Title · Spring fair".
  - What a publish left out is listed with its reason in a box of its own; the
    worker's answers are told as sentences ("file type not editable by this
    adapter" was shown as it came).
  - While the host builds, the line reads "Saved. The site is rebuilding with
    your change…". The first-session guide went back to "Click this and type."
    after a publish; it now ends with a card that says saved, not published. A
    reload during the build showed the old page and said nothing; it shows what
    was saved and goes on watching. After a failed build, "Undo this change"
    left words on the page that were neither saved nor unpublished; they come
    back as an unpublished edit.
  - History listed every commit in the repository as the page's versions, and
    each way back ended in "That version could not be read"; Page settings
    showed an empty form that could not be saved. Both now say that they
    cannot show a generated page yet.
- **A published list carried what the site's own scripts had done to it.** A
  block that had faded in was written to the page file with the class the
  fade-in adds, and a list staged while a filter was on carried the filter's
  `display:none`. A list is now published as the file has each block, plus
  what the editor changed: outside the editable fields every attribute is the
  file's (except a block's tags), and on a field only its link, its picture
  and the picture's description and size are taken from the page. Left as they
  are on the page: elements a script added or removed, and words a script
  changed outside a field.
- **History showed a restore side by side in two frames with the scripts
  off**, where a site that fades its sections in showed them blank. "Undo this
  change" and "Go back to this" now show the result on the page itself, with
  Cancel and Keep, as the demo already did.
- **Four more questions were asked in the browser's own box**: deleting a
  comment thread, deleting a page (two boxes), signing out with edits waiting,
  and the note for declining a suggestion. Each is one dialog of the editor's
  own, whose buttons say what they do. Signing out now also asks when the only
  thing waiting is an edit to a content file, an upload or a section.
- **A block's buttons showed on top of a site's sticky header** while the block
  scrolled under it. They are hidden for as long as any part of them is under
  a bar the site keeps at the top of the screen.
- **Undo in a list could make the whole list invisible.** On a site whose
  blocks fade in as they scroll into view, Undo after removing, adding, moving
  or duplicating a block, or after changing a word in one, left the list on
  the page and out of sight, and so did "Drop" in the publish sheet and
  History's preview. The editor wrote the list's earlier HTML back as new
  elements, which the site's own script had never seen and so never showed.
  A list is now written block by block: a block that is on the page stays the
  element it is, a block that was taken off is the one put back, and a block
  that is new takes the classes the site gave the block it stands in for.
- **A block's buttons followed the link when the block was one.** On a card
  that is a link, pressing Move, Duplicate, Tags or Remove also opened the
  card's address in a new tab.
- **Failures were shown as the text of an exception.** "Draft failed: Cannot
  read properties of null (reading 'request')", "Failed: GitHub 422: Reference
  already exists", "Publish failed — see console". Every such place now says
  what was not done and why, in a sentence. The exception goes to the console.
- **The demo's safety net.** In try-out mode (`sandbox: true`): Save as draft
  failed, and now keeps the draft in the visitor's browser and offers it back;
  an edit that was not published was gone after a reload, and is now offered
  back with "Pick up where you left off?"; "Schedule for later" printed the
  worker's "forbidden", and now says what a real site does; and there was no
  History, where there is now one of this browser's publishes, with "Undo this
  change" and "Go back to this" working. New post or page, Page settings, Site
  menu, Find & replace and People & access are shown in the demo's menu, each
  opening its own dialog and saying what a real site does where it would act.
  The ✨ button says what it is beside the button instead of doing nothing
  visible.
- **A saved draft could take the place of "Pick up where you left off?"**, on a
  real site, when a page had both: the question about the draft opened over the
  other one, and the unpublished edits were lost with the next change. The
  draft is now asked about afterwards. Edits thrown away with "Discard & exit"
  are no longer offered back.
- **Removing a block asked in the browser's own box**, which told people the
  way back was to leave the page. It is immediate, with "Removed. Undo".
- **The link button asked in the browser's own box too.** It opens the
  editor's dialog: one box for the address, "Add link" or, with the cursor in a
  link, "Change link" and "Remove link". Enter submits, Escape cancels, and the
  cursor and the selection come back to the field either way. What an address
  may be is unchanged.
- **The demo lost its one link to Kiln when the card after a first publish
  closed.** Once a visitor has published, the demo's pill carries "Put Kiln on
  my site" whenever that card is not on screen, for as long as the demo's
  state lasts.
- **On a phone the saved draft's four choices** were in one row, with "Resume
  draft" on two lines and, on a small phone, "Later" off the edge. They are two
  to a row, each on one line.
- **Developer names shown to the person editing.** The toolbar, the hover
  hint, Search & jump, the publish sheet and "Pick up where you left off?"
  show a readable name made from the field's name ("Hero headline", "Hero
  picture"; the stored name is the label's title). Search & jump no longer
  matches a scatter of letters ("history" found "hero img"). Theme says "The
  site's colours and type sizes" and names its settings in words, with the
  stylesheet's names as small print for the owner.
- **On a phone** the first tip lay on the page's own buttons, the pencil on
  the last items of the menu, and a block's opened buttons on the next block's
  words; none does now. Choosing "Top bar" in Settings no longer leaves the
  first lines of the page under the bar (laptop too), and a full menu no longer
  runs off a small laptop's screen. The first-session guide's last card puts
  itself away after twenty seconds.

- **An editor whose sign-in the worker had ended was left with an editor that
  did not start, and no way back to the sign-in.** A 401 for the stored
  sign-in (someone taken off People and added back, a repository renamed, a
  session the worker no longer has) went to the console; the sign-in stayed in
  the browser, so `/kiln` sent the person back to the same silent page. The
  editor now drops that sign-in and the page says "Your sign-in to edit this
  site has ended, so please sign in again with Google.", with a button to the
  sign-in that returns to the same page. When the worker says the owner has
  something to correct (`code: "repo_changed"`), the sentence says to ask them
  and shows the worker's message. The owner is told the same way, with GitHub,
  when the token cannot be renewed. It reads only what every worker's answer
  carries, so an older self-hosted worker needs no change.
- **Publish with an ended sign-in said "Publish failed — see console".** A
  dialog now says that nothing was published and that the edits are saved in
  this browser. After **Sign in again** they are back on the page without a
  question, and Publish sends them. What the saved copy cannot hold (parts
  made editable, sections added or removed, or everything when the browser
  cannot save) is said before the person leaves, with **Copy my text**. A 403
  keeps the edits too: it says the sign-in does not allow the change, shows
  the answer's reason and offers the copy. The owner's page is no longer
  reloaded under their edits.
- **No answer, a 5xx or a 429 is not a sign-out.** None of them drops a
  sign-in or an edit. On page load, where the editor used to fail without a
  word, the page says editing could not start and that the person is still
  signed in; at Publish the status line says nothing was lost and to try
  again. GitHub's rate limit, and a token that ran out while the worker could
  not be reached, no longer sign the owner out.
- **Source mode: an unpublished edit to a content file was lost on any
  reload.** The copy of unpublished edits the browser keeps now holds them
  beside page edits, and "Pick up where you left off?" offers them back. An
  ended sign-in at Publish (the worker's `/source/commit` answering 401) gets
  the same dialog as a page edit, where it used to say "unauthorized".
- **An ended sign-in was said only on page load and at Publish.** History and
  going back to a version, naming a version, Save as draft, Schedule and its
  cancel, comments, suggestions, the list of the site's pictures, AI assist,
  page settings, the site menu, a new page, find and replace, Theme, People
  and the undo after a publish each showed a line of their own ("Failed:
  GitHub 401", "Comment failed: unauthorized", "Failed: forbidden") or
  nothing. Each now opens the dialog Publish shows, naming what was not done
  ("Nothing was scheduled."); a 403 says the sign-in does not allow it, with
  the answer's reason; no answer, a 5xx and a 429 say nothing was lost and to
  try again. When the editor finds out by itself (asking who else is editing),
  one line in the status bar says so and offers **Sign in again**. Schedules,
  presence and People answer 403 to someone the worker does not know, so a
  403 from those is checked once against the route that answers 401 on every
  worker: an older self-hosted worker needs no change.
- **What was being typed when a sign-in ended went with the panel it was typed
  in.** The dialog now opens over the panel and gives it back as it was. A
  comment, a reply, the note under "What changed?", the time for a schedule
  and the name for a version are also kept in the browser beside the
  unpublished edits, and are back in their boxes after **Sign in again**: the
  comment where it was pinned, the schedule panel open with the time. For
  boxes that cannot be kept (page settings, the site menu, a new page, find
  and replace) the dialog says they will need typing again and puts **Copy my
  text** first. A new page that did not go through keeps its form.
- **A sign-in that ran out by the browser's own clock left the plain site,
  with no word of why the editor was gone.** The next page now says "Your
  sign-in to edit this site has ended, so please sign in again with Google."
  once, in the same card. The sentence is in the editor's bundle; the script
  every visitor loads grows by 82 bytes (36 gzipped) for the marker.
- **For the owner, People said Google sign-in was not set up once the GitHub
  token was eight hours old**, and schedules, comments and suggestions failed
  until a reload. The editor renewed the token for GitHub but not for the
  worker's own routes. It now renews it for those too and sends the request
  again.
- **The setup wizard told Astro owners to `npm install @kilncms/astro`**, a
  package that is not on npm. It now adds the helper to the project as one
  file, `src/lib/kiln-astro.mjs`, and shows the import to use.
- **On an Astro site the setup wizard put Kiln's files where the build never
  looked.** It wrote `assets/` and `kiln.html` at the top of the repository and
  printed a hint. It now writes the editor, the config (`mode: 'source',
  adapter: 'astro'`), the sign-in page and `_headers` under `public/` (or the
  `publicDir` named in `astro.config`), says so, and offers to add the two
  script tags to each template that closes `<body>`, written with `is:inline`
  so Astro does not try to bundle them. Settings from an earlier run are
  copied across and the old copies are named, not deleted. `kiln doctor` reads
  the config from `public/`, and `kiln update` refreshes the editor there
  (it used to stop with "No page here loads kiln.js").
- **The status line went from "Published." back to "Publishing…"** while the
  host was building. The wait now reads "“Your page edit” is going live…
  usually under a minute".
- **After Undo, the guide's last card still said the change was committed.**
  Pressing Undo while "That was a Git commit" (or, for an invited editor,
  "That is published") was on screen left it up. The card now says the edit is
  back, not published, and closes once that edit is published again or
  dropped.
- **On a phone the demo banner covered the pencil and the editing toolbar** —
  the menu could not be opened and the tap that tried hit "Start over". The
  banner is now a one-line pill beside the pencil, and steps aside while the
  toolbar or the menu sheet is open.
- **Clicking the pencil after hovering it closed the menu** that the hover had
  just opened. The click now keeps it open.
- **The status pill never went away** on sites whose own CSS does not reset the
  `hidden` attribute.
- **A block's control bar ran off the left edge of the screen** on a two-column
  phone grid and overlapped its neighbour's. It now stays inside its block.
  Table rows' controls, invisible on touch screens, are visible again.
- **The image resize handle made the page scroll sideways** on a full-width
  image, and could be left behind on the page after its toolbar closed.
- **`kiln update` wrote wherever the page's script tag pointed**, a folder
  above the site included, and made a folder named `https:` for a page that
  loads `kiln.js` from another address. It now writes only inside the site
  and says why when it will not.
- **`kiln update` ran its git commands through a shell** with a folder name
  read from the site's own HTML; a name with a space broke the commit. git now
  gets its arguments directly.
- When input ends while the CLI is waiting for an answer it exits 1 instead of
  a quiet 0.
- `kiln rescue --max-pages 5` (with a space) crawled one page.
- `kiln new` started a site on the editor its template last shipped; it now
  uses the current one.
- One CLI message told users to run `npx kiln doctor`, which is someone else's
  package on npm.
- The two scheduled jobs shared one unguarded call: a failure in the first
  silently skipped the second.

### Security

- **An address a site has left is trusted nowhere.** The hosted worker still
  answered the address one site moved away from, and its built-in map tied
  that old address, not the new one, to the site's repository. A Pages
  address that is given up can be registered by anyone. The old address is
  out of the production origin list and the map names where the site is now.
- **Invited editors could commit SVG, XML and XSL files**, which skip the HTML
  content guard and run script in the site's origin, where the owner's GitHub
  token is stored. Editor writes are now limited to an explicit list of inert
  file types on every write path: the commit proxy, multi-file commits (regular
  files only, no symlinks), scheduled edits, suggestions, API tokens and source
  reverts. A source revert by an editor can no longer bring back a version that
  adds scripts.
- **Editor uploads had no server-side size or content check.** There is now a
  15 MB ceiling, enforced before an oversized body is buffered, and uploads are
  checked by their leading bytes.
- **The AI-assist image fetch followed redirects to private addresses.** Every
  redirect hop is now screened, and the screen covers IPv6, carrier-grade NAT,
  reserved ranges and every spelling of an IPv4 address.
- **Comment threads were readable and writable outside an editor's page
  scope.**
- **Gated members pages and files are now served `private, no-store`** with
  `Vary: Cookie`, so no cache keeps a copy.
- **A branch can only move to a commit the worker checked** — an editor
  session could fast-forward a branch to any commit: another branch's head, or
  one never created through the worker. A branch now moves only to a single
  commit made on top of its current head through that session, and the commit
  is checked again (paths, file types, page content) at that moment. A new
  branch or tag must point at a commit the site already has.
- **Editor sessions cannot delete files** — the "no deletes" rule held for
  single files but not for multi-file commits, where a tree could drop any
  file in the editor's paths. Refused at the tree, the commit and the branch
  update.
- **The Kiln Cloud operator is identified by numeric GitHub id** — set
  `CLOUD_ADMIN_ID`; the login is compared only when no id is configured.
- **A session or a token works only for the repository it was made for** — a
  site that never corrected its config after a rename kept reaching GitHub by
  the old name. If another repository then took that name, with Kiln's App
  installed, the site's editors and API tokens committed into it. Editor
  sessions, members' sign-ins and API tokens now carry the repository's id,
  and every use checks that the name still answers as that repository: one
  more KV read, from the answer the worker already remembers for ten minutes.
  If it answers as another, an editor session gets 401 `session expired`, a
  token gets 403 with `code: "repo_changed"` and a sentence, a member is
  signed out, and a new sign-in is refused with a page that says why. Nothing
  is sent to the other repository. They work again once `repo` is corrected.
  Sessions and tokens from before keep working: tokens and members' sign-ins
  take the id the first time they are used, editor sessions at the next
  sign-in.

## [0.4.0] - 2026-08-19

The review-loop release: the comforts of the walled-garden site builders —
sections, brand controls, comments, suggestions, previews, AI — on a site you
own in git.

### Added

- **Comment pins** (`💬 Comments`) — Figma-style review on the live page: pin a
  comment to any element, threads with @who-said-what, resolve/reopen, a
  sidebar per page, and open-count badges. A **Reviewer preset** in People &
  access creates a true comment-only seat (`mode: review`) — the worker refuses
  every write for those sessions.
- **Suggest mode** — tick *Suggest-only publishing* on an editor and their
  Publish becomes **Suggest changes**: field-level suggestions land in an admin
  review queue with per-field before/after, Approve (conflict-safe re-apply onto
  the current page, suggester keeps authorship) or Decline. Enforced server-side:
  suggest-mode sessions cannot write to the live branch, schedule, or bypass via
  the proxy.
- **Preview links** — one `preview: 'https://{branch}.<project>.pages.dev'`
  config line turns drafts and suggestions into real, shareable branch-preview
  URLs built by your host.
- **Named versions & visual restore** — name any publish (git tags under
  `kiln/`), and every restore now shows a sandboxed side-by-side "Now vs. this
  version" preview before anything is staged.
- **Deploy-aware publish status** — "Live ✓ — view site" driven by your host's
  real deployment status (with content-probe confirmation), and "Build failed —
  open commit" when it isn't.
- **⌘K palette** — jump to any page, field, or tool; site-wide text search with
  in-context snippets, scope-aware for invited editors.
- **Block library + section chrome** — "+ Add section" between sections, fed by
  dev/AI-authored `_blocks/*.html` snippets; editors compose pages only from
  approved, brand-safe sections. Sections with a repeat key get a ✕ remove.
- **Theme panel** — the site's `:root` CSS custom properties become a brand kit:
  color pickers, font menus, size inputs, live preview, byte-exact stylesheet
  commits. No schema; the CSS is the source of truth.
- **AI assist** (BYO key) — Improve / Shorten / Tone / Translate / Custom on any
  field with a before/after preview, one-tap **alt text** for images, and
  "draft the content" on new posts — via a new `/ai/assist` worker endpoint
  (`wrangler secret put AI_API_KEY`). Same sanitizer and commit pipeline as
  human edits; grant-gated per editor.
- **REST API + scoped tokens** — `GET /api/v1/pages`, `GET /api/v1/fields`,
  `PATCH /api/v1/edits` behind owner-minted tokens scoped by path, section
  keys, read-only, and expiry. Every write is sanitized and committed with
  attribution.
- **kiln-mcp** (`mcp/`) — an MCP server over that API: give Claude or any MCP
  client safe, scoped write access to your site; every edit returns its commit.
- **`kiln rescue <url>`** — the escape hatch: crawl your Squarespace / Wix /
  WordPress site into a clean, self-contained static copy (assets localized,
  builder runtime stripped, lazy images fixed) and auto-tag it for Kiln.
- **`kiln new [dir]`** — scaffold a fresh site from a template repo
  (`--from owner/repo`), de-personalized, git-initialized, wizard-ready.
- **Phone-first editing** — the editor reshapes into bottom sheets with
  thumb-sized targets and a keyboard-aware toolbar on phones; desktop unchanged.

### Changed

- Editor bundle grows to ~426 KB raw / ~128 KB gzip (still loaded only after
  sign-in; the visitor shim is unchanged at ~3 KB gzip).
- Suggestion and API commits are authored with the person's or token's name and
  the `kiln-editor`/`kiln-api` noreply address — real emails never enter git
  history.

## [0.3.0] - 2026-07-12

### Added

- **Tag filters** — editors tag any repeat block (🏷 on its hover controls); tagged
  lists show visitors filter pills ("All" plus one per tag).
- **Photo galleries** (`data-kiln-gallery`) — multi-photo upload for editors,
  per-gallery thumbnail size; visitors get a grid and a lightbox with paging,
  captions, keyboard, and swipe.
- **Events with calendar views** (`data-kiln-events`) — structured add/edit form
  (date, time, location, link); visitors switch between List, Month, Week, and Day.
- **`kiln-features.js`** — a small dependency-free visitor runtime powering the three
  features above plus document chips and cards; the boot shim lazy-loads it only on
  pages that use them.
- **Make things editable** (admin) — pick any element on the page and Kiln splices the
  `data-cms` annotations into the repo file itself (text, plain text, image, repeat,
  gallery, events), or removes them again. No hand-editing HTML.
- **Image display size and resampling** — the image toolbar sets display width
  (25–100%) and can re-encode the file at a smaller max dimension; images inside
  rich-text fields get per-image size and remove controls.
- **Inline document upload** — upload a PDF or doc from the text toolbar and insert it
  as a text link, a chip, or a card; files land in the repo (`assets/files/`, or the
  gated `members/files/` on members pages).
- **Multi-editor presence** — people editing the same page see each other; publishing
  warns before overwriting a field someone else changed since you loaded the page
  (different fields still merge cleanly).
- **Per-page and per-section access** — "People & access" gains a page picker and
  optional section scoping per editor; the editor UI greys out everything outside an
  editor's scope and marks out-of-scope pages read-only.
- Editor toolbar is draggable and repositions itself so it never covers the text being
  edited on small screens; Settings (floating button vs top bar) is now visible to
  invited editors, not just admins.

### Fixed

- **Repeat blocks built from tables were destroyed on edit.** Sanitizing a
  `<tbody data-cms-repeat>` flattened rows to bare text (table tags missing from the
  allowlist, and DOMPurify's string mode re-parsing the fragment outside table
  context). Container sanitizing now runs in place on the real node with a wider
  structural allowlist, and a structure-loss guard refuses to stage any edit that
  would flatten a block. Repeat controls are table-aware (the add button parks after
  the table, item controls anchor in the row's last cell).
- **Images inserted inline vanished on "Done".** DOMPurify's default URI allowlist
  stripped `blob:` preview URLs (and sandbox `data:image/…` URLs). Both are now
  explicitly allowed; committed HTML still swaps in the real repo path.

### Changed

- Relicensed from MIT to **GNU AGPL-3.0**: free for any use, including commercial and
  client work; running a modified version as a public network service requires
  sharing your changes.
- Documentation corrections across the README and setup docs.

### Security

- Tightened the commit-proxy allowlist in the `kiln-auth` worker.
- Fixed an attribute-edit XSS in the splice engine.
- Removed magic-link invites entirely. Access is authenticated-only: editors and
  members are added by email and sign in with Google. Added per-editor path scoping
  and default-on rate limiting for the sign-in routes.

## [0.2.0]

Initial public release.

### Added

- **HTML-as-database splice engine** — edits are spliced back into the page's
  own source at exact parse5 source offsets and committed to Git; hand-written
  formatting survives untouched.
- **GitHub App authentication** — per-repo install, 8-hour expiring tokens,
  refresh tokens held server-side in Workers KV.
- **Invited editors & members** — added by email and signed in with Google (no
  GitHub account); editor commits are proxied through the App installation token
  behind a strict, path-scoped allowlist.
- **Members area** — `/members/` pages and files gated at the edge by an
  HMAC-signed cookie, with a Google-verified people allowlist.
