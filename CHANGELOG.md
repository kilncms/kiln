# Changelog

All notable changes to Kiln are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
  Not followed: comment threads, suggestions, scheduled posts and API tokens
  made under the old name stay under it.
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
