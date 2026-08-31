# Changelog

All notable changes to Kiln are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
