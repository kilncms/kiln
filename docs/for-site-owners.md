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
page into your site, and writes `assets/kiln-config.js`. When it's done, push, visit
`yoursite.com/kiln`, and sign in with GitHub.

There is deliberately no edit button on the site itself. `/kiln` is the only door in,
and visitors never see any of this — they get your plain site plus a ~3 KB script.

Health-check an install any time:

```bash
npx github:kilncms/kiln doctor
```

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
  posts, scheduling, the site menu, find & replace, adding sections from the
  [block library](#block-library).
- **Suggest-only publishing** (editors) — see below.

Removing someone revokes their access immediately, active session included.

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

## Publishing, drafts, scheduling, history

- **Publish** — edits stage on the page and go out together as one commit. The live
  site updates when your host finishes redeploying, typically about a minute.
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
