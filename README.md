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
visitor   →  plain static site (~3 KB gzip boot shim, nothing else)
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
   Three ways to get these onto an existing site: run `npx github:kilncms/kiln tag`
   for a conservative first pass (headings, paragraphs, images, card lists, the menu —
   tables are never made repeatable (cell text can still be tagged); review with `git diff`, running it twice adds nothing), click
   elements in the browser with **✨ Make text/images editable** after you sign in, or
   paste **[KILN_PROMPT.md](KILN_PROMPT.md)** into Claude/v0/Lovable and let your AI
   wire the whole site. Full conventions (blog templates, new-page template, members
   area) live in that same file.
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
| `kiln.js` | boot shim every visitor loads | ~7 KB raw / ~3 KB gzip |
| `kiln-features.js` | visitor runtime for galleries/filters/calendars, loaded only on pages that use them | ~16 KB raw / ~5 KB gzip |
| `kiln-editor.js` | editor UI, loaded **only** after sign-in | ~355 KB raw / ~105 KB gzip, editors only |
| `kiln-auth` worker | sign-in (GitHub App + Google) and the commit pipeline every edit flows through | Cloudflare Workers free tier |
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

The manual path requires editing `worker/wrangler.toml` before `wrangler deploy`. The
shipped file is the maintainer's production config, so a fresh account cannot deploy it
as-is:

- **Delete the `[[routes]]` block** (the `auth.kilncms.com` custom domain — you don't
  own it, and Cloudflare will reject the deploy).
- **Delete the `[[d1_databases]]` block** (Kiln Cloud billing only; self-host never
  touches D1).
- **Set the KV namespace `id`** to one you created (`npx wrangler kv namespace create KILN`).
- **Set `ALLOWED_ORIGINS`** to your own site origin(s).

The fastest path skips all of this: `npx github:kilncms/kiln` automates the worker
deploy, KV namespace, and config wiring for you. Full walkthrough in
[docs/self-hosting.md](docs/self-hosting.md).

**2. Register your GitHub App (one click)**

Open `https://<your-worker>.workers.dev/setup` and press the button. The manifest flow
registers the app and the worker captures the credentials itself; you never copy a secret.
Then install the app on your site's repo (pick **Only select repositories**).

**3. Allow your site's origin**

Add your site URL to `ALLOWED_ORIGINS` in `worker/wrangler.toml`, redeploy.

**4. Add the script tags + `data-cms` attributes to your site** (see above), build the
assets (`npm run build`) and copy `dist/kiln.js` + `dist/kiln-editor.js` +
`dist/kiln-features.js` into your site's `/assets/` (kiln-features.js is lazy-loaded by
kiln.js for galleries/filters/calendars — omit it and those 404 for visitors), and add a
`kiln.html` entry page at your site root (the wizard does this
for you). Push, then visit `your-site.com/kiln` and sign in. There is no edit button
on the site itself; `/kiln` is the only way in.

> **Hosting note:** use Cloudflare Pages (or GitHub Pages) for business sites.
> Vercel's free Hobby tier prohibits commercial use in its ToS.

### The CLI

`npx github:kilncms/kiln` with no arguments runs the setup wizard. Three more commands
cover the rest of the lifecycle:

```bash
npx github:kilncms/kiln doctor     # health-check an install: worker, app, CORS, bundles, members gate
npx github:kilncms/kiln update     # re-copy the latest editor bundles into the site, offer to commit
npx github:kilncms/kiln add-site   # add this site to Kiln Cloud (opens the dashboard)
npx github:kilncms/kiln tag        # conservative auto-annotation pass (see above)
```

`kiln update` is the self-host upgrade path: run it from your site's repo and it finds
where `kiln.js` lives, drops the latest `kiln.js` + `kiln-editor.js` + `kiln-features.js`
next to it, and offers to commit and push. `kiln doctor` reads `assets/kiln-config.js`
if present and checks the worker, GitHub App registration and install, site liveness,
CORS, and the members gate.

## What editors can do

Click any outlined text and type. The toolbar has **bold / italic / underline / lists /
links / clear** and a **Style** menu listing the site's own CSS classes
(`window.KILN.styles`), so typography stays designed and editors pick from the palette.
Everything stages on the page and publishes together as one commit — **⌘Z / Ctrl+Z**
undoes any staged change, blocks and image swaps included.

- **Images** — click to replace (auto-compressed), write alt text, and drag the corner
  handle to resize the moment the image is added. Kiln keeps the full-resolution
  original and publishes a web-optimized copy at the chosen size, so enlarging later
  never degrades.
- **Documents** — insert a PDF or file into text as a link, a chip, or a card, and
  choose whether it opens in a new tab or downloads. Files land in `/assets/files/`
  (or the gated `/members/files/` on a members page).
- **Blocks & tables** — anything in a `data-cms-repeat` gets duplicate / reorder /
  remove / tag controls, table rows included. Tag blocks and visitors get automatic
  filter buttons.
- **Galleries & events** — add a photo gallery (multi-upload, captions, per-gallery
  thumbnail size; visitors get a full-screen viewer) or an events list (structured
  form; visitors get list + month/week/day calendar views) anywhere on a page — you
  click where the new section goes.
- **Drafts, scheduling, history** — save privately, publish at a chosen time, and
  browse every published version in plain language. Undoing always **previews on the
  page first** (keep or cancel), per section or for the whole page, and undoing a
  publish that *added* a section removes it again.
- **Site-wide** — **Site menu** edits navigation across every page in one commit;
  **Find & replace** changes a phrase everywhere at once; **Page settings** edits the
  title, description, and social image; **+ New** creates posts and pages from your
  `_templates/`.
- **Together** — editors see who else is online and on which page; conflicting edits
  to the same field get an explicit warning with both versions kept.

## Google sign-in

(a.k.a. "Editors & members without GitHub accounts")

Open **People & access** in the Kiln menu and add someone by their Google email as an
**Editor** or **Member**, with an access duration you choose (**1–360 days**, or never
expires). Editors can be scoped to specific pages and even specific sections — the picker
shows each section with the first words of its content so you know what you're granting —
and you choose which menu tools they get (drafts, history, new posts, scheduling, the site
menu, find & replace). Leave it all blank for the whole site. They sign in at `yoursite.com/kiln` with their Google account, with no GitHub account
ever and no links to leak. Removing someone revokes their access immediately, including any
active session. Editor commits are authored with their name and committed by your GitHub App's
bot, and the worker enforces a strict allowlist: that one repo, only the paths granted to them,
never CNAME/_redirects/.github, and no deletes.

There's a one-page guide you can send to people you invite:
[docs/for-editors.md](docs/for-editors.md) for editors,
[docs/for-members.md](docs/for-members.md) for members.

### Setup

Google sign-in needs a Google OAuth client on your worker (one-time, ~5 minutes):

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create
   an **OAuth 2.0 Client ID** of type **Web application** (create a project first if you
   don't have one, and configure the consent screen when prompted).
2. Add an **authorized redirect URI**: `https://YOUR-WORKER-URL/google/callback`
   (e.g. `https://kiln-auth.you.workers.dev/google/callback`).
3. Set the two secrets on the worker:
   ```bash
   cd worker
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

That's it. Open **People & access** in the Kiln menu and start adding editors and
members by email.

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
printf 'https://kiln-auth.you.workers.dev' | npx wrangler pages secret put KILN_WORKER --project-name <project>
```

Those two secrets are all the members area needs: `KILN_MEMBER_SECRET` signs the member
cookie, `KILN_WORKER` points the redeem function at your auth worker.

## Guides

- [docs/for-site-owners.md](docs/for-site-owners.md) — the admin guide: tagging, people,
  publishing, drafts, history, members, upgrades, and how to leave.
- [docs/for-editors.md](docs/for-editors.md) — send this to someone you invited as an editor.
- [docs/for-members.md](docs/for-members.md) — send this to someone you gave members access.
- [docs/self-hosting.md](docs/self-hosting.md) — the full self-host / agency deploy guide.

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
npm run build          # dist/kiln.js + dist/kiln-editor.js + dist/kiln-features.js
GH_TOKEN=$(gh auth token) node scripts/e2e.mjs   # full live-loop verification
```

Repo layout:

```
src/engine.js        the splice engine (parse5 offsets, batch edits, attr edits)
src/github.js        transports (direct / proxied), conflict-retry edits, atomic commits
src/autotag.js       the heuristic first-pass auto-tagger behind `kiln tag`
src/kiln.js          boot shim
src/features.js      visitor runtime (gallery lightbox, tag filters, event calendar)
src/editor/main.js   editor UI bundle source
cli/index.mjs        the setup wizard + doctor + tag commands
worker/              kiln-auth Cloudflare Worker (sign-in + commit pipeline)
templates/           members-area scaffolding the wizard copies into a new site
test/                engine + transport + autotag tests
scripts/             build, live e2e, managed onboarding
```

## Limitations (honest list)

- One CMS instance edits one repo per site config; monorepos work via `root`.
- Static sites only: your host must redeploy on push, and a publish takes about a
  minute to go live (that's the deploy, not Kiln).
- Editors and members sign in with Google, so each person needs a Google account.
- No media library yet — every image upload is a new file; nothing lists or prunes them.
- Renaming a page means making a new one; there's no slug-change-with-redirect.
- The auto-tagger deliberately skips tables — tag those by hand or in the browser.

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

**Kiln Cloud (hosted, paid, $4.99/mo per site):** we run the engine; you deploy
nothing. Your content still lives in YOUR repo on YOUR hosting, so you can move to
self-hosting any time. Plainly stated: Cloud holds the app token that writes to your repo,
which is what any hosted CMS backend is.

**Fully managed ($14.99/mo per site):** we set your existing site up on Kiln —
hosting, the worker, the GitHub App, and the tagging — so you touch no code. Your content
still lives in your own repo, with a guaranteed transfer-out path. Want everything
hand-tagged and configured with you, plus a revision round? Concierge setup & tagging is
a one-time $399 on any plan.

Both paid plans are self-serve with a 7-day free trial at [kilncms.com](https://kilncms.com).
