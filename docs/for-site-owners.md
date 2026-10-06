# Kiln for site owners

This is the admin guide: everything you do with a Kiln site over its life, from setup
to handing out access to (if it comes to it) leaving. For the pitch and architecture,
see the [README](../README.md). For the deploy details, see
[self-hosting.md](self-hosting.md).

## What you're running

Kiln makes a static HTML site editable in the browser. Your site's HTML files are the
content database; every edit becomes a Git commit to your repo, and your host
redeploys. There are three pieces:

- your repo on GitHub (the content, with full history),
- your static host (Cloudflare Pages, GitHub Pages, etc.),
- a small Cloudflare Worker (`kiln-auth`) that handles sign-in and pushes commits.

Three ways to run it:

| Route | Price | Who runs the worker |
|---|---|---|
| Self-host | free | you (about 10 minutes of setup, [guide](self-hosting.md)) |
| Kiln Cloud | $4.99/mo per site | we do; your content stays in your repo and host |
| Fully managed | $14.99/mo per site | we set up everything: hosting, worker, app, tagging |

All three run the same open-source (AGPL-3.0) engine. Nothing is gated or crippled in
the free version, and you can move between routes because the content never leaves
your repo.

## Getting started

```bash
cd your-site-repo
npx github:kilncms/kiln
```

The wizard deploys the worker (or points you at Kiln Cloud), creates the KV
namespace, registers the GitHub App, copies the editor bundles and the `/kiln` entry
page into your site, writes `assets/kiln-config.js`, and adds a `_headers` file with
a few [security headers](#security-headers) if the site has none. When it's done,
push, visit `yoursite.com/kiln`, and sign in with GitHub.

There is deliberately no edit button on the site itself. `/kiln` is the only door in,
and visitors never see any of this — they get your plain site plus a ~3 KB script.

Health-check an install any time:

```bash
npx github:kilncms/kiln doctor
```

If you rename the repo or move it to another account, run it again. Editor access is
stored under the repo's exact name and does not follow a rename, so `doctor` fails
that check and tells you what to change.

### If your AI built a React app

Kiln edits HTML files. A site made with Lovable, v0 or Bolt is usually a React
app: its HTML file is an empty shell and the words are added by script in the
visitor's browser. To use Kiln on a site like that, freeze it into HTML first:

```bash
npm install playwright-core
npx github:kilncms/kiln rescue https://your-site.lovable.app --render --menu-shim --try
```

This opens each page in a browser you already have (Chrome, Edge, Brave or
Chromium), lets the app finish, and saves the finished page as plain HTML with
its pictures and styles. The app's scripts are left out, so the page can no
longer redraw itself over your edits. `--try` lets you serve the folder and
click a word at once, with nothing published. When you are happy, delete
`assets/kiln-config.js`, push the folder to GitHub and run the wizard above.

What you give up, said plainly:

- **Anything that needed the app to keep running.** Forms sent by script,
  sign-in, search, shopping carts, filters, tabs, carousels, animated counters,
  and anything loaded from a database. They are still drawn and no longer work.
  `RESCUE-REPORT.md` in the folder lists each one, page by page.
- **The phone menu**, unless you pass `--menu-shim`, which adds one small
  script (`assets/kiln-menu.js`) that opens and closes it.
- **The way back.** From here on the site is changed in Kiln or by editing the
  HTML. If you go back to the AI builder and export again, you freeze again and
  your Kiln edits are not in the new export.
- **Pages that are different every time** (a random headline, a live number)
  keep whatever the first visit showed. The report names them.

Good fits: a brochure site, a portfolio, a landing page, a restaurant or a
trades site. Poor fits: anything with accounts, a cart, a dashboard, or content
that comes from a database.

## Making things editable

Kiln only lets people edit elements that carry a `data-cms` annotation. Three ways to
add them, from least to most effort:

1. **Auto-tag**: `npx github:kilncms/kiln tag` takes a conservative first pass —
   headings, paragraphs, images, card lists, the nav menu. Review with `git diff`,
   undo with `git checkout -- .`. It never makes tables repeatable and running it
   twice adds nothing.
2. **Click-to-tag**: sign in, open **✨ Make text/images editable** in the Kiln menu,
   and click elements on the page. Kiln writes the annotations into the repo file for
   you — text, plain text, image, repeat block, gallery, events. This is also how you
   un-tag something.
3. **AI bulk-tag**: paste [KILN_PROMPT.md](../KILN_PROMPT.md) into Claude, Cursor, v0,
   or whatever built your site, along with the site. It teaches the tool every Kiln
   convention (blog templates, menus, partials, galleries, the members area) and wires
   the whole thing.

Most sites end up using a mix: auto-tag first, then click-to-tag the stragglers.

## Theme tokens

Open **Theme** in the Kiln menu (under *Whole site*) and your site's design system —
brand colors, font choices, key sizes — becomes a control panel. No setup file: Kiln
reads the CSS custom properties your stylesheets declare on `:root`, which most
hand-written and AI-generated sites already have. If yours doesn't, add one block:

```css
:root {
  --brand-primary: #b8472a;
  --brand-ink: #1c1c28;
  --font-display: 'Fraunces', serif;
  --space-hero: 6rem;
}
```

…and use the variables in your rules (`color: var(--brand-primary)`). The panel then
shows a color picker per color, a font menu per font (offering fonts the page already
loads — to introduce a brand-new font, add its `<link>`/`@font-face` to the site
first), and a unit-preserving input per size. Values it can't safely edit as a single
control — `var()` references, gradients, `url()`s, shadows — are listed read-only.

Changes preview live on the page as you drag. **Apply** commits them to the
stylesheet file itself — one commit per touched stylesheet, byte-exact around the
edited values — and the status line reports when the live site has picked it up.
Because the stylesheet is the source of truth, your CSS *is* the brand kit: nothing
to keep in sync, and every change is in your git history like any other edit.

Invited editors don't get the panel by default — grant **Theme (colors & fonts)** in
People & access (their stylesheet writes stay inside their page scope, like
everything else).

## Inviting people

Open **People & access** in the Kiln menu. Add a person by their Google email and
pick a role:

- **Editor** — edits content inline, publishes. No GitHub account needed; they sign
  in with Google at `yoursite.com/kiln`.
- **Member** — no editing; unlocks your gated `/members/` pages and files.

For each person you also set:

- **Access duration** — 1 to 360 days, or never expires. When it lapses they just
  see the login screen again; re-add or renew them in this panel.
- **Page scope** (editors) — limit them to specific pages. Everything else shows as
  read-only for them, with a note saying which pages they do have.
- **Section scope** (editors) — within a page, limit them to specific sections. The
  picker shows each section with the first words of its content, so you know exactly
  what you're granting. Leave it blank for the whole page.
- **Feature grants** (editors) — which menu tools they get: drafts, history, new
  posts, scheduling, the site menu, find & replace, AI assist, theme tokens,
  adding sections from the [block library](#block-library).
- **Suggest-only publishing** (editors) — see below.

Removing someone ends their access, including a sign-in they already hold. An
editor is signed out at once. A member is turned away from the members area
within about five minutes: the gate on your site asks Kiln whether each
signed-in member is still on the list at most once every five minutes. If Kiln
cannot be reached, the last answer stands for up to an hour, then the members
area closes until it can be. A members area set up with an earlier version of
Kiln does not do this until you run `npx github:kilncms/kiln update` and
deploy; `kiln doctor` tells you which one a site has.

### Suggest-mode editors

Tick **Suggest-only publishing** on a person and their Publish button becomes
**Suggest changes**: instead of committing to the live site, their edits arrive in
your **Suggestions** panel (Kiln menu → Whole site) with their name, the page, and an
optional note. You see a per-section before/after, then **Approve** or **Decline**.

Approving merges the suggestion into the *current* page — their edits re-apply
section by section on top of anything published since, so approving an old
suggestion doesn't wipe newer work — and the commit carries their name as author.
Declining records your call (with an optional note); nothing changes on the site.
It's Google-Docs "suggesting" for your website, and the worker enforces it: a
suggest-mode session physically cannot write to your live branch. They can still
save drafts; scheduling is off for them (a schedule would publish directly).

### Preview links

Add one line to your `window.KILN` config and Kiln can hand out links to a built
preview of unpublished work:

```js
preview: 'https://{branch}.<project>.pages.dev',   // Cloudflare Pages
```

On Netlify it's `preview: 'https://{branch}--<site>.netlify.app'` — and branch
deploys must be enabled for the site (Site configuration → Build & deploy → Branches).
`{branch}` is replaced with the branch's URL-safe alias.

With it configured: **Share a preview link** (under *Your unpublished edits*) saves a
draft and gives you a link to send around, and each suggestion also lands on its own
`kiln/suggest-<name>` branch so the review panel offers **Open preview** — the real
page, built by your host, before you approve.

One prerequisite: Google sign-in needs a one-time OAuth client setup on your worker
(two secrets, about five minutes). See
[Google sign-in setup](../README.md#google-sign-in) in the README. Kiln Cloud and
managed sites have this done already.

Send invitees the matching one-pager so you don't have to explain anything:
[for-editors.md](for-editors.md) or [for-members.md](for-members.md).

### The trust model, honestly

An invited editor can edit content within the scope you gave them, and their changes
commit to your repo (authored with their name, committed by your GitHub App's bot).
Scoping controls where they can write, not how good their writing is — invite people
you'd trust with the keys to those pages.

What they cannot do, regardless of scope: touch your domain or deploy configuration.
The worker enforces a hard allowlist on every editor commit — that one repo only, only
the paths granted to them, and never CNAME, `_redirects`, `.github/`, `functions/`, or
other sensitive files. No deletes, no force-pushes. And because every edit is a
commit, anything they do is visible in your repo history and reversible.

### What editors can upload

An editor writes content, never code, and the worker holds them to a short list of
file types:

- pages (`.html`) and stylesheets (`.css`), which is what the editor itself saves;
- pictures: JPG, PNG, GIF, WebP, AVIF, ICO;
- PDFs;
- Word, Excel and PowerPoint files (`.docx`, `.xlsx`, `.pptx`) and their OpenDocument
  equivalents;
- fonts (WOFF, WOFF2, TTF, OTF);
- audio and video (MP3, M4A, MP4, MOV, WebM, OGG, WAV).

Each file can be up to 15 MB, and an upload has to be what its name says: the worker
looks at the first bytes of the file, so a script saved as `photo.png` is refused.
Everything else is refused too, with a plain message in the editor. That includes
SVG, XML and XSL files and `.xhtml` pages (a browser can run script from all of them),
Markdown and other content files a generator builds from (those are edited through
source mode, not uploaded), and older `.doc`, `.xls` and `.ppt` files.

None of this applies to you. As the owner you commit with your own GitHub sign-in,
straight to GitHub, so you can still add an SVG logo or any other file, from the
editor or from git.

## AI assist (optional)

Bring your own Anthropic API key and Kiln adds three small AI surfaces to the
editor: a ✨ menu on the text toolbar (**Improve · Shorten · Change tone… ·
Translate… · Custom…**, always with a before/after preview), **✨ Alt text** on
the image toolbar, and an optional one-line brief on **＋ New post or page**
that drafts the template's content for you.

Setup is one command on your auth worker — the key is stored as a secret and
never reaches the browser:

```bash
npx wrangler secret put AI_API_KEY
```

Two things worth knowing:

- **Who sees it** — you (the owner) always have it once the key is set. Invited
  editors only get the ✨ buttons if you grant them the **AI assist** feature in
  People & access; each call spends your API credit, so the grant is opt-in.
  Optionally set an `AI_MODEL` var on the worker to override the default
  small/fast Claude model.
- **Same rules as human edits** — AI output is treated exactly like typing: it
  renders through the editor's sanitizer, stages like any edit, and publishes
  through the same commit pipeline and server-side content guard. The AI can
  suggest words; it can't sneak in scripts, and nothing goes live until you hit
  Publish.

## Publishing, drafts, scheduling, history

- **Publish** — edits stage on the page and go out together as one commit. As soon as
  something is staged, a **Publish** button showing the number of edits appears beside
  the pencil (it is also the first item in the pencil's menu). The live site updates
  when your host finishes redeploying, typically about a minute.
- **Drafts** — save work privately without publishing; come back to it later.
- **Scheduling** — publish at a chosen time. The worker re-applies the edits at fire
  time (and re-checks the author still has access).
- **History & restore** — browse every published version in plain language and
  restore any of them. Restores preview on the page first (keep or cancel), per
  section or whole page. Undoing a publish that added a section removes it again.
- **Site-wide tools** — the **Site menu** edits navigation across every page in one
  commit; **Find & replace** changes a phrase everywhere; **Page settings** edits
  title, description, and social image; **+ New** creates posts and pages from your
  `_templates/`.

If two people edit at once, each sees who else is on the page, and publishing warns
before overwriting a field the other person changed. Different fields merge cleanly.

## Block library

Hover the gap between two sections of a page and Kiln shows a slim **+ Add section**
divider (plus one at the end of the page). Clicking it opens a picker of your site's
**blocks** — ready-made sections that live as plain HTML files in a `_blocks/` folder
at the repo root. Each file is one block: a single top-level element (typically a
`<section>`) with normal `data-cms` annotations inside, optionally named by a
first-line comment:

```html
<!-- kiln-block: {"title":"Feature cards","description":"A heading with three editable cards."} -->
<section class="features">…</section>
```

No manifest → the filename becomes the title (`feature-cards.html` → "Feature
cards"). The picker previews each block wearing the page's own stylesheets, so what
you see is what lands. Inserting stages the section like any other edit — nothing is
live until Publish — and Kiln renames any `data-cms` key that would collide with one
already on the page. Hovering a section Kiln added also offers **✕ Remove section**.

Because editors can only insert what's in `_blocks/`, the library is how you keep
pages on-brand: have whoever built the site (or an AI given
[KILN_PROMPT.md](../KILN_PROMPT.md)) write a handful of approved sections once, and
everyone composes from those. With no `_blocks/` folder yet, the picker explains the
convention and offers to commit a starter block for you.

Two things to know:

- **The feature grant** — admins always have the block chrome. Invited editors need
  the **Add sections (blocks)** tool ticked in People & access (off by default).
- **Blocks are content-only** — `<script>` tags and event handler attributes are
  stripped when a block is inserted (and the worker refuses them server-side on
  editor publishes). Style blocks with your site's stylesheet; keep behavior in your
  site's own JS, keyed off classes.

## The members area

Anything under `/members/` — pages and files like PDFs — can be gated behind a member
sign-in, checked at the edge before the file is served. No database, no per-seat
pricing; members are just entries in your People list.

Setup is copying one directory of Cloudflare Pages Functions into your site and
setting two secrets; the [README section](../README.md#members-area--gated-documents)
has the exact steps. After that, add members by email in People & access and point
them at [for-members.md](for-members.md).

Gated pages and files are sent with `Cache-Control: private, no-store`, so neither a
shared cache nor the browser keeps a copy after a member signs out. If you set up the
members area before this was added, copy `templates/functions/` into your site again
to pick it up.

## Security headers

New sites get a small `_headers` file from the setup wizard. Cloudflare Pages and
Netlify read it and send these headers with every page and file:

| Header | What it does |
|---|---|
| `X-Content-Type-Options: nosniff` | The browser trusts the file type your host declares and does not guess. |
| `Referrer-Policy: strict-origin-when-cross-origin` | Other sites learn which site a visitor came from, not which page. |
| `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` | Only your own site can show your pages inside a frame. This stops another site from framing your pages, editor included, to trick a signed-in editor into clicking something. |
| `Strict-Transport-Security: max-age=31536000` | A browser that has visited once uses HTTPS for the next year. |

The wizard never overwrites a `_headers` file you already have. To add these lines to
an existing one, copy them from [`templates/_headers`](../templates/_headers). On a
site a generator builds, put the file in the folder that is published as-is (for
Astro, `public/`). GitHub Pages does not read `_headers`; there the headers have to
come from a proxy in front of the site, such as Cloudflare.

Two lines you may need to change:

- If you show your own pages inside a frame on another site of yours, name that site:
  `frame-ancestors 'self' https://other.example`, and delete the `X-Frame-Options`
  line (it can only say "same site").
- If part of your domain still needs plain HTTP, delete the
  `Strict-Transport-Security` line before you publish. Once a browser has seen it, it
  holds for the stated time.

### Adding a Content-Security-Policy

Kiln does not ship a policy that limits scripts. Only you know which scripts, fonts
and embeds your site loads, and a policy that is too tight breaks pages for visitors.
If you write one, this is what Kiln itself needs allowed:

| Directive | Needs | Why |
|---|---|---|
| `script-src` | `'self'` | `kiln-config.js`, `kiln.js` and the editor are files on your own site. Kiln uses no inline script and no `eval`. |
| `style-src` | `'self' 'unsafe-inline'` | The editor, and the gallery, filter and calendar features, style themselves from script. |
| `img-src` | `'self' data: blob:` | Previews of images you have picked but not published yet. |
| `connect-src` | `'self' data: blob:`, your worker's address, `https://api.github.com`, `https://raw.githubusercontent.com` | Sign-in and publishing go to the worker (`worker` in `kiln-config.js`; `https://auth.kilncms.com` on Kiln Cloud). The owner's edits go straight to GitHub, and the editor asks GitHub whether a newer version exists. |
| `frame-src` | `'self'` | The side-by-side restore preview and the block previews. |

A starting point, with your own worker's address in place of the example:

```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' data: blob: https://kiln-auth.you.workers.dev https://api.github.com https://raw.githubusercontent.com; frame-src 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'
```

Put it on the one `Content-Security-Policy` line, keeping `frame-ancestors 'self'` in
it, and add whatever your own pages load (analytics, web fonts, video embeds). Then
sign in at `/kiln`, edit, publish, and watch the browser console: anything the policy
blocks is reported there by name.

One thing to know if you use the members area: `members-login.html` carries its
sign-in script inline, and `script-src 'self'` blocks inline script. Move that script
into a file of its own (for example `/assets/members-login.js`) before you turn the
policy on.

## Keeping the editor up to date

Self-hosters update on their own schedule:

```bash
cd your-site-repo
npx github:kilncms/kiln update
```

It copies the latest `kiln.js`, `kiln-editor.js`, and `kiln-features.js` into your
site wherever the current ones live, and offers to commit and push. That's the whole
upgrade. Cloud and managed sites receive updates automatically.

## Leaving

Kiln is designed to be easy to walk away from. Your content is not "in" Kiln — it's
plain HTML in your repo, right now, already. To remove Kiln entirely:

1. Delete the two script tags from your pages
   (`kiln-config.js` and `kiln.js`).
2. Optionally delete the Kiln files themselves (`assets/kiln*.js`, `kiln.html`) and
   uninstall the GitHub App from the repo.

The site keeps working, with every edit anyone ever made intact. Nothing to export,
no lock-in to unwind.
