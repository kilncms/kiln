# Kiln — Project Status

_Last updated: 2026-06-10_

**Domain:** kilncms.com (not yet connected)
**Live demo:** https://kiln-demo.pages.dev (Cloudflare Pages, git-connected to erikkurtu/kiln-demo)
**Auth worker:** https://kiln-auth.erikkwilder.workers.dev (Cloudflare Workers + KV)
**GitHub App:** `kiln-cms` (id 4024142), currently private to erikkurtu — flip to public in app settings when opening to other users

---

## Where things stand

| Phase | Status | Evidence |
|-------|--------|----------|
| 1.5 — Edit loop (HTML splice → commit → deploy → live) | ✅ VERIFIED LIVE | e2e: edit + revert both observed live on kiln-demo.pages.dev |
| 2 — Images, multi-page, new posts, deploy status | ✅ BUILT; posts VERIFIED LIVE | atomic 2-file post commit f51004d; image path code-complete (browser-side canvas downscale — needs human browser test) |
| 3 — Magic-link editors (no GitHub account) | ✅ VERIFIED LIVE | invite→redeem→proxied commits as kiln-cms[bot]; proxy allowlist refused /user, foreign repos, DELETE |
| 4 — Members area + gated documents | ✅ VERIFIED LIVE | /members/ + PDF gate 302 anonymous / 200 with cookie; tampered cookie rejected; 24/24 e2e checks |

Run the proof anytime: `GH_TOKEN=$(gh auth token) node scripts/e2e.mjs`

## Architecture (as built)

- **HTML files are the content database.** No content.json. Edits are spliced into raw
  HTML at parse5 source offsets (Vite's technique) and committed via the Contents API;
  multi-file changes (new post + index card) go through the Git Data API as one commit.
- **GitHub App** (`kiln-cms`) with per-repo install; 8h expiring user tokens; refresh
  tokens server-side in KV. Registered via the manifest flow at the worker's `/setup`
  (one click, credentials captured automatically — PKCS1→PKCS8 conversion in-worker).
- **kiln-auth worker** = OAuth exchange + magic-link invites/sessions + allowlisted
  GitHub proxy holding the App installation token.
- **Members area** = Pages Functions middleware with HMAC-signed cookies
  (KILN_MEMBER_SECRET + KILN_REPO secrets on the Pages project).
- **Host:** Cloudflare Pages (commercial use allowed on free tier — Vercel Hobby is not).

## Remaining (not blockers, next session material)

1. **Human browser test of admin OAuth login** — the one leg e2e can't click:
   visit demo → ✎ → GitHub sign-in → edit → Publish. (Token refresh path also untested live.)
2. Image-swap browser test (file picker + canvas downscale + commit).
3. kilncms.com: register/connect domain → Pages custom domain; build a landing page.
4. Open the GitHub App (settings → public) + hosted-service story for other users.
5. Editor UX polish: invite manager panel (currently prompt()-based), page-settings
   panel for `<title>`/meta, undo, drag-drop image upload.
6. First real users: Claudia Maturell portfolio (admin path), Atlanta Commons (members/docs).
7. Launch prep: Show HN draft — wedge: "the edit layer for AI-generated sites."

## History

- 2026-03-11 — Phase 1 spike (content.json + classic OAuth). Never deployed.
- 2026-06-10 — Viability analysis (vault: kiln-viability-2026-06-10.md): quadrant verified
  empty; architecture redesigned (HTML-as-database, GitHub App, magic links, edge-gated members).
- 2026-06-10 — Phases 1.5–4 built, deployed, and live-verified in one session (24/24 e2e).
