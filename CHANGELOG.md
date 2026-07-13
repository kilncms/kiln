# Changelog

All notable changes to Kiln are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
