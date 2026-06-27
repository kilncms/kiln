# Kiln

[![CI](https://github.com/kilncms/kiln/actions/workflows/ci.yml/badge.svg)](https://github.com/kilncms/kiln/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
![No build step](https://img.shields.io/badge/build-not%20required-success)

> Click-to-edit CMS for static sites. GitHub is the backend, and a free static host
> serves the site. No database, no server, no monthly bill.
>
> **Live demo:** [demo.kilncms.com](https://demo.kilncms.com) · **[kilncms.com](https://kilncms.com)**

Kiln turns any static HTML site into an editable one. Sign in, click the text on the
page, change it, and hit **Publish**. The edit becomes a Git commit and your host rebuilds.
The site IS the database.

```
visitor   →  plain static site (~2.7 KB gzip boot shim, nothing else)
admin     →  visits yoursite.com/kiln → GitHub sign-in → edits inline → commit → live in ~1 min
editor    →  added by email → signs in with Google at /kiln (no GitHub account!) → same editing
member    →  added by email → signs in with Google → gated /members/ pages and documents unlock
```

## Why

Every alternative fails on one axis: TinaCMS needs React, Decap/Sveltia/Pages CMS are
form-dashboards rather than on-page editing, CloudCannon costs $45+/mo, Netlify Visual
Editor locks you to Netlify, and WordPress needs a database and patches. Kiln is
framework-agnostic, inline, git-backed, and free. That includes sites built by AI: if you
generated a site with Claude, v0, Lovable, or Bolt and pushed it to GitHub, Kiln is the
edit layer your client was missing.

## How it works

1. Annotate editable elements in your HTML:
   ```html
   <h1 data-cms="hero_headline">Welcome</h1>
   <p  data-cms="tagline" data-cms-plain>Plain text only</p>
   <img data-cms="hero_img" data-cms-attr="src" src="/assets/img/hero.jpg">
   <a  data-cms="cta" href="/contact.html">Editable label AND destination</a>

   <div data-cms-repeat="services"> <!-- duplicatable/removable blocks --> </div>
   <div data-cms-menu="main"> <!-- nav managed across ALL pages at once --> </div>
   <div data-cms-list="post_list"> <!-- blog cards are prepended here --> </div>
   ```
   Full conventions (incl. blog templates, new-page template, members area):
   **[KILN_PROMPT.md](KILN_PROMPT.md)**, written so you can paste it straight into
   Claude/v0/Lovable and have your AI wire up an existing site.
2. Create `/assets/kiln-config.js`:
   ```js
   window.KILN = {
     repo:   'you/your-site-repo',
     branch: 'main',
     worker: 'https://kiln-auth.you.workers.dev',
     styles: [],
   };
   ```
   Then drop two scripts at the end of `<body>` on every page:
   ```html
   <script src="/assets/kiln-config.js"></script>
   <script src="/assets/kiln.js" defer></script>
   ```
3. There is no step 3. No build pipeline, no content files. When someone signs in and
   edits, Kiln fetches the page's own HTML from GitHub, splices the change at exact
   source offsets (parse5 source locations, the same technique Vite uses), and commits.
   Diffs are minimal; your hand-written formatting survives untouched.

### The pieces

| Piece | What | Size / cost |
|---|---|---|
| `kiln.js` | boot shim every visitor loads | ~6.7 KB raw / ~2.7 KB gzip |
| `kiln-editor.js` | editor UI, loaded **only** after sign-in | ~266 KB raw / ~205 KB gzip, admins only |
| `kiln-auth` worker | GitHub App OAuth + Google sign-in + commit proxy | Cloudflare Workers free tier |
| your repo | the content database (with full version history) | free |
| Cloudflare Pages | hosting + members-area functions | free, commercial use allowed |

## Setup (self-host, ~10 minutes)

**1. Deploy the auth worker**

```bash
git clone https://github.com/kilncms/kiln && cd kiln   # (or your fork)
npm install
cd worker
npx wrangler kv namespace create KILN     # put the id in wrangler.toml
npx wrangler deploy
```

The manual path requires editing `worker/wrangler.toml`: set `ALLOWED_ORIGINS` and the
KV namespace `id` to YOUR values. The fastest path skips all of this. `npx github:kilncms/kiln`
automates the worker deploy, KV namespace, and config wiring for you.

**2. Register your GitHub App (one click)**

Open `https://<your-worker>.workers.dev/setup` and press the button. The manifest flow
registers the app and the worker captures the credentials itself; you never copy a secret.
Then install the app on your site's repo (pick **Only select repositories**).

**3. Allow your site's origin**

Add your site URL to `ALLOWED_ORIGINS` in `worker/wrangler.toml`, redeploy.

**4. Add the script tags + `data-cms` attributes to your site** (see above), build the
assets (`npm run build`) and copy `dist/kiln.js` + `dist/kiln-editor.js` into your site's
`/assets/`, and add a `kiln.html` entry page at your site root (the wizard does this
for you). Push, then visit `your-site.com/kiln` and sign in. There is no edit button
on the site itself; `/kiln` is the only way in.

> **Hosting note:** use Cloudflare Pages (or GitHub Pages) for business sites.
> Vercel's free Hobby tier prohibits commercial use in its ToS.

## What editors can do

Click any outlined text and type. The toolbar offers **bold / italic / underline / links /
clear**, an **insert image** button (uploads, downscales, commits), and a **Style…**
dropdown listing the site's own CSS classes (`window.KILN.styles`), so typography stays
designed and editors pick from the palette. Repeatable blocks (`data-cms-repeat`) get
duplicate/remove controls. Links get an href field plus a 📎 **attach file** upload
(files land in `/assets/files/`, or in `/members/files/`, auto-gated, when you're on a
members page). **+ New…** creates blog posts or standalone pages from your `_templates/`.
**Menu…** edits the navigation across every page of the site in one atomic commit.

## Editors & members without GitHub accounts (Google sign-in)

Open **People & access** in the admin bar and add someone by their Google email as an
**Editor** or **Member**, with an access duration you choose (**1 to 360 days**). For editors
you can also limit which pages they may touch (e.g. just `blog`); leave it blank for the whole
site. They sign in at `yoursite.com/kiln` with their Google account, with no GitHub account
ever and no links to leak. Removing someone revokes their access immediately, including any
active session. Editor commits are authored with their name and committed by your GitHub App's
bot, and the worker enforces a strict allowlist: that one repo, only the paths granted to them,
never CNAME/_redirects/.github, and no deletes.

## Blog posts with no build step

Put two files in your repo, `_templates/post.html` (a full page using
`data-cms="post_title|post_date|post_body"`) and `_templates/post-card.html` (the list
card with `{{title}}/{{href}}/{{date}}` placeholders), and give your blog index a
`data-cms-list="post_list"` container. The **+ New post** button clones the template and
splices a card into the index as ONE atomic commit (Git Data API), so the site never
deploys half-written. The new post page is itself click-editable.

## Members area & gated documents

Static sites can have private sections. Everything under `/members/`, pages **and**
files like PDFs, is gated at the edge by a Cloudflare Pages Function
(`functions/members/_middleware.js`) checking an HMAC-signed cookie. Members are added by
email in **People & access** (verified by GitHub push access) and sign in with Google at
`/members-login.html`. No database, no per-seat pricing. Copy the ENTIRE `templates/functions/`
directory (3 files: `_kiln.js`, `members/_middleware.js`, `api/member-redeem-google.js`)
into your site's `functions/`, then:

```bash
openssl rand -hex 32 | npx wrangler pages secret put KILN_MEMBER_SECRET --project-name <project>
printf 'you/your-repo'  | npx wrangler pages secret put KILN_REPO --project-name <project>
printf 'https://kiln-auth.you.workers.dev' | npx wrangler pages secret put KILN_WORKER --project-name <project>
```

> `KILN_WORKER` is only needed if you enable Google member sign-in.

## Security model

- **GitHub App, not OAuth app:** installed per-repo; an admin sign-in grants access to
  the selected repos only, with 8-hour expiring tokens. Refresh tokens never reach the
  browser (held server-side in Workers KV; the browser holds an opaque session id).
- **Google-sign-in editors** never hold GitHub credentials at all; the worker
  proxies their commits through the App installation token behind a method+path allowlist
  (contents read/write, git-data create, deploy status; one repo only, scoped to the paths
  granted to that editor, never CNAME/_redirects/.github, no deletes).
- OAuth `state` nonces are single-use with a 10-minute TTL; abuse-prone sign-in routes are
  rate-limited per IP; member cookies are HMAC-signed, HttpOnly, Secure.
- Rich-text edits are sanitized with DOMPurify before they touch the repo;
  `data-cms-plain` fields are entity-escaped plain text.

## Development

```bash
npm install
npm test               # splice engine + transport suite (node --test)
npm run build          # dist/kiln.js + dist/kiln-editor.js
GH_TOKEN=$(gh auth token) node scripts/e2e.mjs   # full live-loop verification
```

Repo layout:

```
src/engine.js        the splice engine (parse5 offsets, batch edits, attr edits)
src/github.js        transports (direct / proxied), 409-retry edits, atomic commits
src/kiln.js          boot shim
src/editor/main.js   editor UI bundle source
worker/              kiln-auth Cloudflare Worker
templates/           members-area scaffolding the wizard copies into a new site
test/                engine + transport tests
scripts/             build + live e2e
```

## Limitations (honest list)

- One CMS instance edits one repo per site config; monorepos work via `root`.
- Editing happens per-page; site-wide find-replace is not a thing (yet).
- `<title>`/`<head>` content isn't click-editable (no DOM affordance); a page-settings panel is planned.
- Editors and members are added by email (Google sign-in), so each person needs a Google account.
- Concurrent edits to the *same* field: last write wins (different fields merge cleanly).

## License

Kiln is open source under the [GNU AGPL-3.0](LICENSE): free to use, self-host, modify, and
build on, including for commercial and client work. If you run a *modified* version of Kiln as
a public network service, the AGPL asks you to make your source changes available to its users.

## Free vs. Cloud: the same editor, two ways to run the engine

**Kiln Open Source (self-host):** self-host the small auth engine, your own Cloudflare
worker plus your own GitHub App. One `wrangler deploy`, one click, and the setup wizard
(`npx github:kilncms/kiln`) walks you through all of it. The price of free is about 10 minutes
of configuration. You trust only yourself. The entire engine, editor, worker, and CLI in this
repo are open source (AGPL-3.0) and never gated or crippled; Kiln Cloud is optional paid
hosting of that exact same engine.

**Kiln Cloud (hosted, paid, currently invite-only beta):** we run the engine; you deploy
nothing. Your content still lives in YOUR repo on YOUR hosting, so you can move to
self-hosting any time. Plainly stated: Cloud holds the app token that writes to your repo,
which is what any hosted CMS backend is. A fully-managed tier (we run the repo and hosting
too, with a guaranteed transfer-out path) is planned.
