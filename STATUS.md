# Kiln — Project Status

_Last updated: session 1_

**Domain:** kilncms.com
**Tagline:** "Put raw content in. Get a permanent, fast, free static site out."

---

## What This Is

A framework-agnostic, click-to-edit visual CMS for static sites.
GitHub as the CMS backend. Cloudflare Pages as the host. Completely free.

**The gap it fills:** TinaCMS requires React. Decap CMS is form-based (no visual editing). CloudCannon has visual editing but is a paid host. Nothing exists that is framework-agnostic, visual, AND free. Kiln is that.

---

## Phase 1 — BUILT, NOT YET DEPLOYED

All code is written. Sitting at:
`/workspace/projects/js-cms-tool/`

**Files:**
- `worker/index.js` — Cloudflare Worker (GitHub OAuth proxy, the only "server" needed)
- `worker/wrangler.toml` — Worker deploy config
- `demo/cms.js` — the editor overlay (login, admin bar, click-to-edit, GitHub API save)
- `demo/index.html` — demo site ("Maple & Co.") with 15+ `data-cms` annotated elements
- `demo/content.json` — flat key-value content model
- `README.md` — full setup guide

**To complete Phase 1, Erik needs to:**
1. Run `wrangler login` in terminal (browser auth)
2. Run `gh auth login` in terminal (browser auth)
3. Create a GitHub OAuth App at github.com/settings/developers:
   - Callback URL: `https://cms-auth-worker.[CF_SUBDOMAIN].workers.dev/auth/callback`
   - Store the Client Secret in keychain: `security add-generic-password -a "shmergle" -s "github-oauth-cms-secret" -w "THE_SECRET"`
4. Come back and tell Rook — I'll deploy the Worker, create the GitHub repo, push everything, connect Cloudflare Pages, and test the full loop

---

## Phase Roadmap

| Phase | Status | What |
|-------|--------|------|
| 1 | ✅ Built / ⏳ Deploy pending | OAuth Worker, editor overlay, demo site, GitHub API save |
| 2 | Not started | Image swap, rich text toolbar, multi-file content, polished UX |
| 3 | Not started | `npx [name] init` CLI — scaffolds everything for a new site |
| 4 | Not started | Blog support (Markdown posts, WYSIWYG editor modal) |

---

## Name — DECIDED: Kiln ✅

**Domain:** `kilncms.com`
**Why Kiln:** Warmer than Etch. Better metaphor — raw material (your edits) goes into the kiln (the build process) and comes out as hardened, permanent static pages. Rolls off the tongue. Has aesthetic appeal.
**Why kilncms.com:** kiln.dev, kiln.app, kiln.build are all taken. kilncms.com is clean, descriptive (immediately communicates what it is), and .com is right for a product targeting small businesses. Many leading tools (Decap, Tina, Forestry) kept "cms" in their domain fine.

---

## Architecture (locked)

- **Cloudflare Pages** — free static hosting, auto-deploys on GitHub push
- **GitHub Contents API** — CMS backend (read/write content.json)
- **Cloudflare Worker** — OAuth proxy, free tier (~10 lines of code)
- **Vanilla JS** — editor overlay, zero framework dependency

**Content model:**
- `content/*.json` files = editable content
- HTML elements annotated with `data-cms="key"` attributes
- Editor writes to JSON → GitHub commit → Cloudflare rebuilds in ~30s

**Auth flow:**
- GitHub OAuth via Worker → token returned in URL fragment (#)
- Token stored in localStorage
- All API calls go browser → GitHub directly (no server after auth)

---

## Key Design Decisions

- **Vanilla JS, not React:** Framework-agnostic is the core value prop
- **Git as CMS:** Zero ops overhead, free, version-controlled content history
- **Worker for OAuth only:** Not a backend. Stateless. Handles one thing.
- **data-cms annotation:** Works with any HTML generator (Hugo, Eleventy, plain HTML, whatever)
- **JSON content files:** Separates content from markup; build step injects at deploy time

---

## Open Questions (for later)

- Auth model for client sites: GitHub collaborator only (v1), or a separate credentials system?
- Image storage: commit to repo (simplest), Cloudflare Images (free tier), or external URL
- Multi-admin conflict resolution: last write wins for v1 — document the limitation
- Non-GitHub support (GitLab, Bitbucket): design for it in Phase 3, don't build it yet
