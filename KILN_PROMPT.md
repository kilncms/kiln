# Make this site Kiln-ready

> Paste this whole file into your AI tool (Claude, v0, Lovable, Bolt, Cursor…) along with
> your static site, or hand it to a developer. It teaches them Kiln's conventions so the
> site's owner can edit everything in the browser afterwards — no rebuild pipeline, no CMS
> dashboard, no database. Kiln commits edits straight to the site's GitHub repo.

## What you're wiring up

Kiln is a click-to-edit layer for static HTML sites. The HTML files ARE the content
database. You only need to (1) annotate which parts are editable, (2) add two script
tags, (3) optionally add templates for blog posts/pages and a members area.

## 1. Annotate editable content

Add these attributes to existing elements — do not restructure the page:

```html
<!-- Rich text (bold/italic/links/images allowed when edited): -->
<h1 data-cms="hero_headline">Welcome</h1>
<div data-cms="intro_body"><p>Any block of content.</p></div>

<!-- Plain text only (emails, phone numbers, prices): -->
<span data-cms="contact_email" data-cms-plain>hi@example.com</span>

<!-- Swappable image (click to upload a replacement): -->
<img data-cms="hero_img" data-cms-attr="src" src="/assets/img/hero.jpg" alt="...">

<!-- Editable link/button (label AND destination editable): -->
<a data-cms="cta" href="/contact.html">Get in touch</a>
```

Rules: every `data-cms` key must be unique within its page (except inside repeats, below).
Don't nest one `data-cms` element inside another. Don't put `data-cms` on `<title>` or
elements inside `<head>`.

For a swappable image, point `data-cms` at a plain `<img>` — Kiln replaces its `src`. If the
image uses `<picture>` with `<source srcset>`, the `<source>` keeps showing the old file after a
swap, so serve any editable image as a single `<img>` (a modern `.webp` src works in every current
browser). Don't tag content that JavaScript rewrites at runtime — the edit will be overwritten.

## 2. Repeatable blocks (cards, galleries, document lists)

Wrap any "list of similar things" in `data-cms-repeat`. Editors get duplicate (＋) and
remove (✕) controls on each direct child. Keys inside repeated items don't need to be unique.

```html
<div class="card-grid" data-cms-repeat="services">
  <div class="card">
    <h3 data-cms="card_title">Service A</h3>
    <p data-cms="card_desc">Description…</p>
  </div>
  <!-- more cards… -->
</div>
```

Repeats work inside tables too — put `data-cms-repeat` on the `<tbody>` and annotate
the cells:

```html
<tbody data-cms-repeat="schedule">
  <tr><td data-cms="row_date">Jan 21</td><td data-cms="row_note"></td></tr>
</tbody>
```

### Tags & filters (any repeat)

Editors can tag any block (🏷 on its hover controls) with comma-separated tags, e.g.
`new, used, upcoming`. As soon as one block has tags, visitors automatically get filter
pills above the list — “All” plus one per tag. You can also pre-tag blocks in HTML with
`data-kiln-tags="new, upcoming"` on the repeat's direct children. No extra markup needed.

### Photo gallery

Add `data-kiln-gallery` next to `data-cms-repeat` to turn a repeat into a gallery:
editors get a multi-photo uploader (“+ Add photos”), visitors get a responsive grid and
a lightbox with paging, keyboard arrows, captions, and swipe:

```html
<div data-cms-repeat="photos" data-kiln-gallery>
  <figure>
    <img src="/assets/img/one.jpg" alt="" loading="lazy">
    <figcaption data-cms="gallery_caption">First photo</figcaption>
  </figure>
</div>
```

### Events with calendar views

Add `data-kiln-events` next to `data-cms-repeat` for an event list. Editors add/edit
events through a structured form (title, date, start/end time, location, link); visitors
get List / Month / Week / Day view buttons rendered from the same markup. Each event is
a block whose first `<time datetime>` is the start (a second one is the end):

```html
<div data-cms-repeat="events" data-kiln-events>
  <article class="kiln-event">
    <h3 class="kiln-ev-title" data-cms="ev_title">Board meeting</h3>
    <p class="kiln-ev-when"><time datetime="2026-07-15T18:00">Jul 15 · 6:00 PM</time></p>
    <p class="kiln-ev-loc" data-cms="ev_loc">Rec Center</p>
  </article>
</div>
```

Tags, galleries, and events are powered by `kiln-features.js` (copied alongside
`kiln.js`); the boot shim loads it only on pages that use one of these, and everything
degrades to the plain markup without JavaScript.

## 3. Managed menu (optional but recommended)

Mark the nav links container on EVERY page (and in templates) identically. Kiln's menu
editor then adds/removes/reorders items across all pages in one commit:

```html
<div class="nav-links" data-cms-menu="main">
  <a href="/">Home</a>
  <a href="/about.html">About</a>
</div>
```

The container can hold either a flat set of `<a href>` elements, or a list —
`<ul><li><a>…</a></li></ul>` with `data-cms-menu` on the `<ul>`. Kiln preserves whichever
structure it finds when it rewrites the menu, so your existing nav markup and CSS keep working.

## Shared partials (footer, header — optional)

Wrap any block that repeats across pages (a footer, a header) in `data-cms-partial`,
then annotate the editable bits inside it with `data-cms` as usual:

```html
<footer data-cms-partial="footer">
  <p data-cms="footer_motto">Where love of community…</p>
  <p data-cms="footer_contact">hello@example.com</p>
</footer>
```

Editing any field inside a partial fans the change out to **every page** that carries
the same partial, in one commit — exactly like the menu. Use the same `data-cms` keys
for the partial on every page (and in templates).

## 4. Blog (optional)

Three pieces, all plain HTML:

- `blog/index.html` — the journal page, with a list container:
  ```html
  <div class="post-list" data-cms-list="post_list">
    <!-- post cards get prepended here -->
  </div>
  ```
- `_templates/post.html` — a full post page using `{{title}}` in `<title>`, plus
  `data-cms="post_title"`, `data-cms="post_date"`, and `data-cms="post_body"` elements.
- `_templates/post-card.html` — the card inserted into the index, using `{{title}}`,
  `{{href}}`, `{{date}}` placeholders.

"+ New… → Blog post" then creates the post page and index card as one atomic commit.

## 5. New pages (optional)

Add `_templates/page.html`: a full page using `{{title}}` in `<title>` plus
`data-cms="page_title"` and `data-cms="page_body"`. "+ New… → Page" creates `/slug.html`.

## 6. Members-only area (optional, Cloudflare Pages)

Anything under `/members/` (pages AND files like PDFs) becomes members-gated (Google sign-in):

1. Copy the ENTIRE `demo/functions/` directory (3 files: `_kiln.js`,
   `members/_middleware.js`, `api/member-redeem-google.js`) into the site's
   `functions/` directory, and
   `demo/members-login.html` to the site root.
2. Set secrets on the Cloudflare Pages project:
   ```bash
   openssl rand -hex 32 | npx wrangler pages secret put KILN_MEMBER_SECRET --project-name <project>
   printf 'owner/repo'  | npx wrangler pages secret put KILN_REPO --project-name <project>
   printf 'https://YOUR-KILN-AUTH.workers.dev' | npx wrangler pages secret put KILN_WORKER --project-name <project>
   ```
   (`KILN_WORKER` is only needed if you enable Google member sign-in.)
Admins add members by email in People &amp; access; they sign in with Google (1–360 days access).

## 7. Site config + scripts

Create `/assets/kiln-config.js`:

```js
window.KILN = {
  repo:   'OWNER/REPO',          // the site's GitHub repo
  branch: 'main',
  worker: 'https://YOUR-KILN-AUTH.workers.dev',
  // Optional: text styles editors may apply (classes from your CSS):
  styles: [
    { label: 'Accent', class: 'accent' },
  ],
};
```

At the end of `<body>` on EVERY page (and in templates):

```html
<script src="/assets/kiln-config.js"></script>
<script src="/assets/kiln.js" defer></script>
```

Copy `kiln.js`, `kiln-editor.js`, and `kiln-features.js` (from the Kiln repo's `dist/`)
into `/assets/`. (`kiln-features.js` powers tag filters, galleries, and event calendars;
the shim only loads it on pages that use them.)

Also add a `kiln.html` entry page at the **site root** (this is what `yoursite.com/kiln`
serves — the sign-in screen; there is no edit button anywhere on the site):

```html
<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Sign in · Kiln</title>
</head><body>
<script src="/assets/kiln-config.js"></script>
<script src="/assets/kiln.js" defer></script>
</body></html>
```

## 8. Hosting

Use Cloudflare Pages (free tier allows commercial sites; connect the GitHub repo with NO
build command, output directory `/`). Don't use Vercel's free Hobby tier for business
sites — its ToS forbids commercial use. The site owner installs the Kiln GitHub App on
this one repo and signs in at `yoursite.com/kiln`.

## Checklist before you're done

- [ ] Every page has the two script tags and `/assets/kiln-config.js` exists
- [ ] A `kiln.html` entry page exists at the site root (serves `yoursite.com/kiln`)
- [ ] Editable text/images/links annotated; keys unique per page; nothing nested
- [ ] Card grids / doc lists wrapped in `data-cms-repeat` (tables: on the `<tbody>`)
- [ ] Galleries marked `data-kiln-gallery`, event lists `data-kiln-events` (both alongside `data-cms-repeat`)
- [ ] `/assets/kiln-features.js` copied alongside `kiln.js`
- [ ] Nav marked `data-cms-menu="main"` identically on every page and template
- [ ] (Blog) `blog/index.html` + `_templates/post.html` + `_templates/post-card.html`
- [ ] (Pages) `_templates/page.html`
- [ ] (Members) `functions/` + `members-login.html` copied; secrets set
