# JS CMS Tool — Phase 1 Spike

> A framework-agnostic, click-to-edit visual CMS for static sites.
> GitHub as the backend. Cloudflare Pages as the host. Completely free.

---

## What This Is

A proof-of-concept demonstrating the full edit loop:

**Click element on page → edit inline → save → GitHub commit → Cloudflare Pages rebuilds**

No database. No paid CMS. No framework dependency.

---

## How It Works

1. Your static site has a `content.json` file with all editable text
2. HTML elements are annotated: `<h1 data-cms="hero_headline">...</h1>`
3. A tiny Cloudflare Worker handles GitHub OAuth (the only "server" needed)
4. `cms.js` on the page handles login, editing, and writing back to GitHub

---

## File Structure

```
demo/
  index.html      — example static site with data-cms annotations
  content.json    — content values (the "database")
  cms.js          — the editor overlay

worker/
  index.js        — Cloudflare Worker for GitHub OAuth
  wrangler.toml   — Worker config
```

---

## Setup Guide (Phase 1 Spike)

### Step 1 — Create a GitHub OAuth App

1. Go to: https://github.com/settings/developers → OAuth Apps → New OAuth App
2. Fill in:
   - **Application name:** My Site CMS (or whatever)
   - **Homepage URL:** `https://yoursite.pages.dev`
   - **Authorization callback URL:** `https://your-worker-name.yourname.workers.dev/auth/callback`
3. Note your **Client ID** and generate a **Client Secret**

### Step 2 — Deploy the Cloudflare Worker

```bash
cd worker
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Deploy the Worker
wrangler deploy

# Set the secret (never commit this)
wrangler secret put GITHUB_CLIENT_SECRET
# → paste your GitHub OAuth Client Secret when prompted

# Set the other variables in Cloudflare dashboard:
#   GITHUB_CLIENT_ID   = your OAuth app client ID
#   ALLOWED_ORIGIN     = https://yoursite.pages.dev
```

After deploying, note your Worker URL (e.g. `https://cms-auth-worker.yourname.workers.dev`)

### Step 3 — Configure Your Site

Edit `demo/index.html` — update the `CMS_CONFIG` block at the bottom:

```js
window.CMS_CONFIG = {
  repo:        'yourusername/your-repo',   // GitHub repo containing this site
  branch:      'main',
  contentFile: 'content.json',             // path to your content file in the repo
  authWorker:  'https://cms-auth-worker.yourname.workers.dev',
};
```

### Step 4 — Push to GitHub + Cloudflare Pages

1. Create a GitHub repo and push your site files
2. Connect the repo to Cloudflare Pages:
   - Cloudflare Dashboard → Pages → Create a project → Connect to Git
   - Build command: (leave empty for now — plain HTML)
   - Build output directory: `demo/` (or `/` if files are at root)
3. Deploy

### Step 5 — Test the Loop

1. Visit your Cloudflare Pages URL
2. Click **"✎ Admin Login"** (bottom right)
3. Authorize with GitHub (you must be a collaborator on the repo)
4. You're in admin mode — hover over any text to see the edit outline
5. Click any text, edit it, click **Save**
6. Click **Publish Changes** in the admin bar
7. Wait ~30 seconds — Cloudflare Pages will auto-rebuild
8. Reload the page — your changes are live

---

## Annotating Elements

Any HTML element can be made editable with `data-cms="key"`:

```html
<h1 data-cms="hero_headline">Welcome</h1>
<p  data-cms="hero_body">We make great things.</p>
```

The `key` must match a key in your `content.json`:

```json
{
  "hero_headline": "Welcome",
  "hero_body": "We make great things."
}
```

---

## Limitations (Phase 1)

This is a spike — known rough edges:

- **No build step:** Content changes are written directly to HTML's data-cms values. In a real setup, a build script would inject content.json values into templates at build time.
- **HTML in content:** The editor saves `innerHTML` — includes any HTML tags in the content. Fine for now, handle carefully.
- **No image editing yet:** Coming in Phase 2.
- **Single content file:** All content in one `content.json`. Phase 2 will support nested paths.
- **No conflict resolution:** Last write wins if two admins edit simultaneously.
- **Auth is GitHub account-based:** Anyone who is a repo collaborator can log in and edit. Phase 3 will add a configurable allowlist.

---

## What's Next

- **Phase 2:** Image swap, rich text toolbar, multi-file content, cleaner UX
- **Phase 3:** `npx cms-tool init` — scaffolds everything from scratch
- **Phase 4:** Blog support (Markdown posts, post list, WYSIWYG editor)

---

## The Philosophy

The static site ecosystem is missing something obvious: a visual editor that doesn't require a specific framework, doesn't cost money, and treats Git as the source of truth. This is that thing.
