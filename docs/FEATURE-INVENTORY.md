# Kiln — Complete Feature Inventory

_Generated for the launch audit, 2026-07-12. Every user-facing and backend
capability across the app, worker, CLI, demo, and marketing site._

## The six user types

| Type | How they sign in | What they can do |
|---|---|---|
| **Visitor** | nothing | sees a plain static site + the ~3 KB boot shim; galleries/filters/calendars run for them |
| **Owner / admin** | GitHub (App OAuth, push access to the repo) | full editing, People & access, settings, history, schedule, everything |
| **Invited editor** | Google (added by email) | inline editing scoped to granted paths + section keys + granted menu tools; no GitHub account |
| **Member** | Google (added by email) | unlocks gated `/members/` pages, PDFs, and assets; no editing |
| **Self-hoster** | runs their own worker | deploys `kiln-auth` to their Cloudflare account; owns all data |
| **Managed / Cloud customer** | GitHub identity on app.kilncms.com | registers a site, pays via Lemon Squeezy, Kiln hosts the worker |

## 1. Visitor runtime (loaded on every page)

- `kiln.js` boot shim (~3 KB gzip): detects `/kiln`, loads editor only after sign-in, otherwise inert.
- `kiln-features.js` (lazy, ~5 KB gzip) — visitor-facing dynamic behavior driven by attributes:
  - `data-kiln-gallery` — image gallery + lightbox
  - `data-kiln-filters` — client-side filtering of card lists
  - `data-kiln-tags` — tag chips / filtering
  - `data-kiln-events` — event calendar (month / week / day views, event popovers)
  - `data-kiln-thumb` — thumbnail behavior
- Fails safe: a worker outage or bad config must never break the visitor-facing page (verify in audit).

## 2. Editable content model (`data-cms` conventions)

- `data-cms="key"` — editable rich text region
- `data-cms-plain` — plain-text-only region
- `data-cms-attr="src|href|..."` — edit an attribute (image src, link href/label)
- `data-cms-repeat="name"` — duplicatable/removable blocks (tables never auto-repeated)
- `data-cms-menu="name"` — nav managed across ALL pages at once
- `data-cms-list="name"` — blog/card list that new posts prepend into
- `data-cms-partial` — shared partial across pages

## 3. Editor UI (`kiln-editor.js`, sign-in only, ~102 KB gzip)

Toolbar / menu features (each grantable per-editor to invited editors):
- Inline click-to-edit text + rich text
- Image edit / upload / resize (Small / Medium / Large)
- Repeats: add "New item", remove, reorder
- **Page settings**
- **History & restore** (browse commits, restore a prior version)
- **Save drafts**
- **New posts & pages** (blog + new-page templates)
- **Schedule publishing** (field-level edits re-applied at fire time)
- **Edit site menu** (cross-page nav)
- **Find & replace**
- **Make things editable** (annotate elements live: "✨ Make text/images editable")
- **People & access** (owner only) — add editors/members by email, set role, expiry days, path scope, section keys, feature grants
- **Presence** — "who else is editing this page right now" (advisory, per-field merge at publish)
- Publish → GitHub commit via the worker proxy; conflict-safe per-field merge (sha-retry)

## 4. Auth worker (`auth.kilncms.com`, `worker/index.js`)

- One-time GitHub App setup via manifest flow (`/setup`) — no secret copying
- Admin GitHub App OAuth (single-repo scope, 8-hr expiring tokens, refresh tokens server-side in KV)
- Google sign-in for invited editors + members (`/google/login`, `/google/callback`, `/google/claim`)
- People allowlist (`/admin/people`) — push-verified owner writes
- GitHub API proxy (`/gh/*`) — allowlisted endpoints only, path-scoped, sensitive-path blocked, commit-diff verified, force-push blocked, subtree writes blocked, traversal blocked
- Scheduled publishing (`/schedule`, cron) — re-validates scope at fire time
- Presence (`/presence`) — 90 s TTL, per-person key
- Rate limiting (optional RL binding) on public/costly routes
- Per-origin CORS allowlist (static list + Cloud D1 lookup)

## 5. Members area (Cloudflare Pages Functions, `templates/functions/`)

- `/members/_middleware.js` — edge gate; HMAC-SHA256 signed cookie (`kiln_member`), HttpOnly/Secure/SameSite=Lax
- `/api/member-redeem-google.js` — exchanges the worker's one-time Google code for a site session cookie
- Cross-tenant guard: a member of site A can't redeem into site B (repo/origin binding)

## 6. Kiln Cloud / Managed billing (`worker/cloud.js`)

- GitHub-identity dashboard sessions (bearer token, server-side OAuth token)
- Site registration with push-access verification + app-install check
- Lemon Squeezy checkout / customer portal
- Signed webhook (`/cloud/webhook/ls`) — the only thing that flips a site to `active`; replay-guarded
- 7-day self-serve trial, clock anchored to first registration (no trial farming)
- Owner-only admin: overview (MRR/ARR/insights), grant status, diagnose, runbook
- **Pricing (backend):** Cloud **$4.99/mo**, Managed **$14.99/mo** (cloud.js:344)

## 7. CLI (`npx github:kilncms/kiln`, `cli/index.mjs`)

- `tag` — conservative auto-annotation of an existing site (headings, paragraphs, images, card lists, menu)
- Worker deploy, KV namespace creation, GitHub App manifest flow, config wiring
- `scripts/managed-onboard.mjs` — managed-customer onboarding
- `scripts/propagate-bundles.mjs` — pushes built bundles to consumer site repos on `deploy:prod`

## 8. Marketing site (`kilncms.com`)

Pages: index, pricing, docs, get-started, marketplace, privacy, terms, refund.
Redirects map legacy `/self-hosted`, `/kiln-cloud`, `/fully-managed` → product anchors.

## 9. Demo (`demo.kilncms.com`, `kiln-demo` repo)

- Sandbox mode (`sandbox: true` in kiln-config): every visitor edits a private,
  local-only, auto-resetting copy — no real commits.
- Full site: home, about, blog (index + posts), members area, `/kiln` entry.
