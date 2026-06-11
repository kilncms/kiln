# Kiln

> Click-to-edit CMS for static sites. GitHub is the backend. Free hosting is the host.
> No database, no server, no monthly bill.
>
> **Live demo:** [kiln-demo.pages.dev](https://kiln-demo.pages.dev) · **kilncms.com**

Kiln turns any static HTML site into an editable one. Sign in, click the text on the
page, change it, hit **Publish** — the edit becomes a Git commit and your host rebuilds.
The site IS the database.

```
visitor   →  plain static site (2.7 KB boot shim, nothing else)
admin     →  clicks ✎ → GitHub sign-in → edits inline → commit → live in ~1 min
editor    →  opens a magic link (no GitHub account!) → same editing → commits as the Kiln bot
member    →  opens an invite link → gated /members/ pages and documents unlock
```

## Why

Every alternative fails on one axis: TinaCMS needs React, Decap/Sveltia/Pages CMS are
form-dashboards not on-page editing, CloudCannon costs $45+/mo, Netlify Visual Editor
locks you to Netlify, WordPress needs a database and patches. Kiln is framework-agnostic,
truly inline, git-backed, and free — including for the AI era: if you generated a site
with Claude, v0, Lovable, or Bolt and pushed it to GitHub, Kiln is the edit layer your
client was missing.

## How it works

1. Annotate editable elements in your HTML:
   ```html
   <h1 data-cms="hero_headline">Welcome</h1>
   <p  data-cms="tagline" data-cms-plain>Plain text only</p>
   <img data-cms="hero_img" data-cms-attr="src" src="/assets/img/hero.jpg">
   <a  data-cms="cta" href="/contact.html">Editable label AND destination</a>

   <div data-cms-repeat="services"> <!-- duplicatable/removable blocks --> </div>
   <div data-cms-menu="main"> <!-- nav managed across ALL pages at once --> </div>
   ```
   Full conventions (incl. blog templates, new-page template, members area):
   **[KILN_PROMPT.md](KILN_PROMPT.md)** — written so you can paste it straight into
   Claude/v0/Lovable and have your AI wire up an existing site.
2. Drop two scripts at the end of `<body>`:
   ```html
   <script>
     window.KILN = {
       repo:   'you/your-site-repo',
       branch: 'main',
       worker: 'https://kiln-auth.you.workers.dev',
     };
   </script>
   <script src="/assets/kiln.js" defer></script>
   ```
3. There is no step 3. No build pipeline, no content files. When someone signs in and
   edits, Kiln fetches the page's own HTML from GitHub, splices the change at exact
   source offsets (parse5 source locations — the same technique Vite uses), and commits.
   Diffs are minimal; your hand-written formatting survives untouched.

### The pieces

| Piece | What | Size / cost |
|---|---|---|
| `kiln.js` | boot shim every visitor loads | 2.7 KB |
| `kiln-editor.js` | editor UI, loaded **only** after sign-in | ~205 KB, admins only |
| `kiln-auth` worker | GitHub App OAuth + magic-link sessions + commit proxy | Cloudflare Workers free tier |
| your repo | the content database (with full version history) | free |
| Cloudflare Pages | hosting + members-area functions | free, commercial use allowed |

## Setup (self-host, ~10 minutes)

**1. Deploy the auth worker**

```bash
git clone https://github.com/erikkurtu/kiln && cd kiln
npm install
cd worker
npx wrangler kv namespace create KILN     # put the id in wrangler.toml
npx wrangler deploy
```

**2. Register your GitHub App — one click**

Open `https://<your-worker>.workers.dev/setup` and press the button. The manifest flow
registers the app and the worker captures the credentials itself; you never copy a secret.
Then install the app on your site's repo (pick **Only select repositories**).

**3. Allow your site's origin**

Add your site URL to `ALLOWED_ORIGINS` in `worker/wrangler.toml`, redeploy.

**4. Add the script tags + `data-cms` attributes to your site** (see above), build the
assets (`npm run build`) and copy `dist/kiln.js` + `dist/kiln-editor.js` into your site's
`/assets/`. Push. Done — visit your site and click ✎.

> **Hosting note:** use Cloudflare Pages (or GitHub Pages) for business sites.
> Vercel's free Hobby tier prohibits commercial use in its ToS.

## What editors can do

Click any outlined text and type. The toolbar offers **bold / italic / underline / links /
clear**, an **insert image** button (uploads, downscales, commits), and a **Style…**
dropdown listing the site's own CSS classes (`window.KILN.styles`) — typography stays
designed, editors pick from the palette. Repeatable blocks (`data-cms-repeat`) get
duplicate/remove controls. Links get an href field plus a 📎 **attach file** upload
(files land in `/assets/files/`, or `/members/files/` — auto-gated — when you're on a
members page). **+ New…** creates blog posts or standalone pages from your `_templates/`.
**Menu…** edits the navigation across every page of the site in one atomic commit.

## Editors without GitHub accounts (magic links)

Admins click **Invite…** in the admin bar → a one-time link is minted (e.g. for a client
or teammate) with an access duration you choose (**1–360 days**). Opening it grants an
editing session — no GitHub account, ever.
Their commits land authored with their name, committed by your GitHub App's bot, and the
worker enforces a strict allowlist: that one repo, content paths only, no deletes.

## Blog posts with no build step

Put two files in your repo — `_templates/post.html` (a full page using
`data-cms="post_title|post_date|post_body"`) and `_templates/post-card.html` (the list
card with `{{title}}/{{href}}/{{date}}` placeholders) — and give your blog index a
`data-cms="post_list"` container. The **+ New post** button clones the template and
splices a card into the index as ONE atomic commit (Git Data API), so the site never
deploys half-written. The new post page is itself click-editable.

## Members area & gated documents

Static sites can have private sections. Everything under `/members/` — pages **and**
files like PDFs — is gated at the edge by a Cloudflare Pages Function
(`functions/members/_middleware.js`) checking an HMAC-signed cookie. Invites are minted
by admins (verified by GitHub push access), redeemed at `/members-login.html`. No
database, no auth provider, no per-seat pricing. See `demo/functions/` for the three
small files, then:

```bash
openssl rand -hex 32 | npx wrangler pages secret put KILN_MEMBER_SECRET --project-name <project>
printf 'you/your-repo'  | npx wrangler pages secret put KILN_REPO --project-name <project>
```

## Security model

- **GitHub App, not OAuth app** — installed per-repo; an admin sign-in grants access to
  the selected repos only, with 8-hour expiring tokens. Refresh tokens never reach the
  browser (held server-side in Workers KV; the browser holds an opaque session id).
- **Magic-link editors** never hold GitHub credentials at all; the worker proxies their
  commits through the App installation token behind a method+path allowlist
  (contents read/write, git-data create, deploy status — nothing else, one repo only).
- OAuth `state` nonces are single-use with a 10-minute TTL; editor invites are single-use;
  member cookies are HMAC-signed, HttpOnly, Secure.
- Rich-text edits are sanitized with DOMPurify before they touch the repo;
  `data-cms-plain` fields are entity-escaped plain text.

## Development

```bash
npm install
npm test               # splice engine + transport suite (node --test)
npm run build          # dist/kiln.js + dist/kiln-editor.js (+ demo/assets sync)
GH_TOKEN=$(gh auth token) node scripts/e2e.mjs   # full live-loop verification
```

Repo layout:

```
src/engine.js        the splice engine (parse5 offsets, batch edits, attr edits)
src/github.js        transports (direct / proxied), 409-retry edits, atomic commits
src/kiln.js          boot shim
src/editor/main.js   editor UI bundle source
worker/              kiln-auth Cloudflare Worker
demo/                the Maple & Co. demo site (deployed to kiln-demo.pages.dev)
test/                engine + transport tests
scripts/             build + live e2e
```

## Limitations (honest list)

- One CMS instance edits one repo per site config; monorepos work via `root`.
- Editing happens per-page; site-wide find-replace is not a thing (yet).
- `<title>`/`<head>` content isn't click-editable (no DOM affordance) — planned via a page-settings panel.
- Member invite links are bearer tokens until redeemed — send them over a private channel.
- Concurrent edits to the *same* field: last write wins (different fields merge cleanly).

## License

MIT

## Free vs. Cloud — the same editor, two ways to run the engine

**Kiln Open Source (free forever):** self-host the small auth engine — your own Cloudflare
worker + your own GitHub App. One `wrangler deploy`, one click, and the setup wizard
(`npx github:erikkurtu/kiln`) walks you through all of it. The price of free is ~10 minutes
of configuration. You trust only yourself.

**Kiln Cloud (hosted, paid — currently invite-only beta):** we run the engine; you deploy
nothing. Your content still lives in YOUR repo on YOUR hosting, so you can move to
self-hosting any time. Plainly stated: Cloud holds the app token that writes to your repo —
that's what any hosted CMS backend is. A fully-managed tier (we run the repo and hosting
too, with a guaranteed transfer-out path) is planned. See docs/INTEGRATIONS.md.
