# Kiln feature plan — what the editor landscape teaches us (2026-08)

> **Status 2026-08-19:** Tracks 1–4 SHIPPED as v0.4.0, same day — all fifteen
> features (review loop, guardrails, AI surfaces, big bets incl. `kiln rescue`
> and phone-first editing). See CHANGELOG 0.4.0. Track 0 (Source Mode) remains
> the next committed project, per SOURCE-MODE-SPEC.md. Item 15 (Figma bridge)
> stays parked.

_Working doc, drafted 2026-08-19 from a Mobbin survey of Figma (incl. Figma Sites),
Framer, Webflow, Canva, Squarespace, Wix, v0, Lovable, and the review-tool cluster
(Air, ClickUp, Ditto, Sketch, Mural). Companion to [SOURCE-MODE-SPEC.md](SOURCE-MODE-SPEC.md)
and [API-VISION.md](API-VISION.md) — this doc sequences around both, it does not
replace them._

## 1. The one-screen version

Every serious editor has converged on the same six comforts: **section-based
composition**, **brand/style guardrails**, **comment-and-resolve review**,
**preview-before-publish confidence**, **scoped AI assist**, and **named
versions**. All of them deliver those comforts inside a walled garden that owns
your site.

Kiln's play is not to become a design tool. It is to deliver those same six
comforts **on a site you own in git** — and to add three things the gardens
structurally cannot: a **migration escape hatch** out of them, **suggest-mode
publishing** (every change a reviewable commit), and **safe agent write access**.
The design stays in code, where the developer or the AI put it. Kiln edits
content, tokens, and structure-within-guardrails.

Priorities in one line: **Source Mode stays #1** (it opens the SSG market and
fixes the silent-data-loss trap) → then the **review loop** (comments, suggest
mode, previews) → then **guardrailed comfort** (blocks, brand kit) → then **AI
surfaces** (MCP + field assist) → two **big bets** (`kiln rescue`, phone-first
editing) behind them.

## 2. What the survey actually showed (evidence, not vibes)

**Figma / Figma Sites.** Sites is a real webpages product now: a Webpages panel,
publish to `*.figma.site`, and — the important part — **named color styles and
text styles** ("Section Header 14/140", `marketingBackground`) driving the whole
site, plus variables. Version history has **named versions** with grouped
autosaves and per-version restore/duplicate/copy-link. Dev Mode has annotation
categories (Development, Interaction, Accessibility, Content) and "ready for
dev" states. Insert panel is **blocks-first**: Pages / Navigation / Heroes /
Features / Embeds.
Lesson: tokens-not-CSS is how non-designers are given design control; blocks are
the unit of composition; versions get names.

**Framer.** The right rail is now an **Agent chat** (model picker, credits,
"Added 8 layers, edited 1", inspectable steps) that builds and edits pages.
Page context menu ships **A/B test** and **View Analytics** per page. **New CMS
Page** is a first-class page type. Site-wide **text search** jumps to any string
on any page. Publish is a two-click popover: free `*.framer.app` URL, "No
changes" state, Add Domain, published toast. Canvas has comment pins.
Lesson: agentic editing is here; publish must feel like nothing; text search and
per-page analytics are table stakes for multi-page sites.

**Webflow.** The class/style panel and element navigator remain the ceiling of
complexity a client should never see. In-editor **template chooser** with
categories and free/paid. Link settings popover handles URL/page/section/email/
phone as one control.
Lesson: this is the tool clients get locked out of — Kiln's anti-persona. Steal
the link-settings ergonomics; refuse the style panel.

**Canva.** The **Brand Kit** is the killer guardrail: logos, named palette
("Artisan Dream"), Heading/Subheading/Body fonts, brand templates, and "**32
on-brand suggestions**". Template-first creation everywhere ("Apply all 6
pages", "Add template as new page? / Replace current page"). Magic Studio edits
images in place (BG remover/generator, eraser). **Mobile (iOS): full editing via
bottom sheets** — Format sheet, Font sheet surfacing the Brand Kit, Effects —
proof that real editing works on a phone when the toolbar becomes a sheet.
Lesson: brand kit + templates is how non-designers stay on-brand; mobile editing
is a solved interaction pattern that no static-site CMS has copied.

**Squarespace.** The closest analog to Kiln's on-page model: click text, get a
floating rich-text toolbar on the live page. **Section chrome**: hover
boundaries show "ADD SECTION" between sections; each section gets Edit / View
Layouts / duplicate / move / remove. Per-block design popover (background,
radius, padding S/M/L). Device-preview toggle in the top bar. Template gallery
filtered by *capability* (Store, Memberships, Scheduling, Donations) and a
"Blueprint AI" builder. Forms are just another block.
Lesson: section chrome is the expected grammar of page editing; capability-first
templates convert; forms are table stakes.

**Wix.** Template gallery with "best match" sort; **Content AI on selected
text** → prompt → **Replace Text / Insert Below**. That two-button pattern is
the right minimal AI-assist UI.

**v0 / Lovable.** Chat-left, preview-right; every AI edit is a **restore
point** ("Visual edit in Lovable — Restore / Preview"); v0's publish popover
shows **domain + source branch + commit sha**. Lovable's dashboard has a
Templates tab.
Lesson: the AI-site generation, wave already trains users to see commits and
restore points — Kiln's git story is native to them, not alien.

**Review cluster (Air, ClickUp, Ditto, Sketch, Mural, Framer).** Identical
grammar everywhere: **pin → thread → @mention → resolve**, a sidebar of
open/resolved, status badges ("Needs Review"), ClickUp adds assignment. **Ditto**
does it per text string with **suggestions and variants** — the copy-review
workflow, string by string.
Lesson: this is the single biggest thing Kiln lacks and the one clients ask
agencies for. Ditto's per-string suggestion model maps 1:1 onto Kiln fields.

## 3. Positioning: same comforts, no garden

| The gardens have | Kiln's version | Why ours is different |
|---|---|---|
| Section-based editing | Block library from the repo | dev/AI authors the blocks → brand-safe by construction |
| Brand kit / styles | Theme tokens = CSS custom properties | it's just a stylesheet commit; works on any site |
| Comments & review | Pins on the live page + suggest-mode publishing | the "approve" button is a git merge; full audit trail |
| Preview before publish | Branch previews on the host (CF Pages etc.) | free, real infrastructure, no proprietary staging |
| AI assist | Field-scoped assist + MCP agent access | sanitized, path/field-scoped, every edit a revertible commit |
| Named versions | Git tags with a friendly UI + visual restore | history is already perfect; expose it |
| Templates to start | Template repos + `create-kiln` | you own the repo on day one |
| — (no escape) | **`kiln rescue <url>`** | the gardens can't build the exit door; we can |

**What we deliberately do not build:** a style panel, arbitrary drag-drop
layout, CSS class editing, interactions/animation timelines, hosted-only
anything. The moment Kiln edits *design*, it competes with Webflow on Webflow's
terms and loses its "can't break the site" guarantee. Design belongs to the
developer/AI in code; Kiln edits content, tokens, and dev-defined structure.

## 4. The plan

### Track 0 — Source Mode (phases 1+2 SHIPPED 2026-08-31 — adapter/worker/editor/wizard, Astro first; phases 3+ per spec)
Per [SOURCE-MODE-SPEC.md](SOURCE-MODE-SPEC.md). Everything below assumes it:
the SSG audience it unlocks (Astro/Eleventy/Hugo/Jekyll handoff sites) is
exactly the audience that needs the review loop and guardrails. Framer's "CMS
page" is the walled-garden version of this; `data-kiln-source` is the open one.

### Track 1 — The review loop (the wedge; agency/client killer feature)
The biggest gap vs. every tool surveyed, and the highest-leverage new work.
All three reuse existing plumbing (KV presence pattern, drafts/branches, the
already-granted `deployments:read` / `statuses:read` app permissions).

1. **Publish confidence** (S) — after publish, poll the host's deploy status via
   the GitHub deployments/statuses API and flip the toast to "**Live ✓ — view
   site**" (Framer/Lovable pattern). Kills the "did it work?" minute. No new
   permissions needed.
2. **Comment pins** (M) — pin → thread → @mention (people already have emails)
   → resolve, on the live page, per element/field. Worker + KV, same shape as
   presence; email notify via the existing magic-link mailer path. Sidebar of
   open/resolved per page; "needs review" badge per page. Members can be granted
   comment-only — that's a *reviewer* role, a brand-new cheap seat type.
3. **Suggest mode** (M–L) — an invited editor's Publish becomes a **suggestion**:
   commits go to a `kiln/suggest-<person>` branch; the owner gets a review queue
   with per-field before/after and one-click **Approve & publish** (merge) or
   decline-with-comment. Google-Docs suggesting, for websites. Decap's
   "editorial workflow" is the clunky form-based ancestor; nobody has it inline.
4. **Preview links** (S–M) — "Share preview" publishes the draft/suggestion
   branch and returns the host's branch-preview URL (CF Pages previews are free
   and automatic). Client sees the real site at a real URL before it's live.

### Track 2 — Guardrailed comfort (parity with the gardens, Kiln-style)
5. **Block library + section chrome** (M–L) — hover boundaries between
   top-level sections show "+ Add section" (Squarespace grammar); the picker is
   populated from `_blocks/*.html` in the repo — snippets the developer or AI
   authored, with `data-cms` tags inside. Insert = splice at offsets (same
   engine). Editors compose pages **only from dev-approved sections**, so a
   volunteer can't produce an off-brand page. `kiln tag` learns to propose
   blocks from repeated markup; KILN_PROMPT.md teaches AIs to emit `_blocks/`.
6. **Theme tokens / Brand Kit** (M) — a panel that edits declared CSS custom
   properties: colors (named, like Figma's styles), font pairs (Google Fonts
   swap), logo image. Declaration via a tiny manifest (`kiln-theme.json`) or
   `/* @kiln-token */` comments in the stylesheet; the write is a normal
   stylesheet commit through the same pipeline. Canva's Brand Kit, but the
   "kit" is the site's own CSS variables.
7. **Named versions + visual restore** (S–M) — "Name this version" on any
   commit (lightweight git tag via the existing proxy), a versions timeline,
   and restore preview that renders before/after side by side (two iframes,
   `srcdoc` from the two blobs) instead of a commit-message list. Figma's
   version UX on top of git's actual history.
8. **Cmd+K palette + site-wide text search** (S) — jump to page / field /
   action; find any string across the repo's pages (Framer Text Search).
   Find & replace already exists — this is its discoverable, faster face.

### Track 3 — AI, scoped and safe (API-VISION's surfaces, sequenced)
9. **kiln-mcp** (M, after API Phase 0) — unchanged from API-VISION Phase 1,
   elevated: it is the marketing wedge. Framer sells an in-house agent on
   credits; Kiln's counter is *bring your own agent, scoped to fields,
   sanitized, every edit a commit you can revert*. Demo: "Claude, mark us
   closed on the 4th" → commit link.
10. **Field AI assist** (M) — select a field → Improve / Shorten / Fix tone /
    Translate / **Generate alt text** → diff preview → **Replace / Insert
    below** (the Wix two-button pattern). BYO key self-host; metered on Cloud.
    Alt-text generation doubles as the accessibility story.
11. **Template-fill on new page/post** (S, after 9) — "New page from template"
    gains "draft the content for me": AI fills the template's fields from a one
    line brief. Layout untouched by construction — the safe version of
    Squarespace Blueprint/Wix ADI.

### Track 4 — Big bets (bold, sequenced last, each its own spec before build)
12. **`kiln rescue <url>`** (L) — the escape hatch: crawl a live Squarespace/
    Wix/WordPress/Google-Sites site → clean static HTML + localized assets →
    `kiln tag` → new GitHub repo → Pages deploy → editable in Kiln. Even 90%
    fidelity beats $192–$420/yr rent. The gardens structurally cannot ship
    this; it is Kiln's most differentiated possible feature and a
    self-contained CLI project. ("Your site, out of the garden, in an
    afternoon.")
13. **Phone-first editing** (M–L) — the editor already lives on the page;
    reshape it for touch: bottom-sheet toolbars (Canva iOS grammar), big
    handles for repeats/images, publish from the phone. "Update your hours
    from the parking lot." No static-site CMS does mobile editing at all.
14. **Start-from-template onboarding** (M) — capability-filtered gallery
    (Squarespace's Store/Memberships/Donations filter, not industry vibes) of
    template repos: pick → repo created on your GitHub → Pages connected →
    Kiln pre-wired → editing in under 10 minutes. Fixes the cold start for
    people who *don't* already have a site; feeds the marketplace page.
15. **Figma content bridge** (exploratory only) — Ditto-style: map Figma text
    layers to `data-cms` keys so approved copy flows design→site as a commit.
    Park until pulled; revisit after Source Mode ships.

## 5. Sequencing & monetization

```
Source Mode ───────────────► (committed, first)
Track 1: 1 → 4 → 2 → 3      (confidence → previews → comments → suggest mode)
Track 2: 8 → 7 → 6 → 5      (cheap wins first, blocks last)
Track 3: API Phase 0 → 9 → 10 → 11
Track 4: 14 → 12 → 13       (each gets a spec + Erik go/no-go first)
```

- Tracks 1–2 are mostly editor+worker work with no new external dependencies;
  items 1, 4, 7, 8 are each roughly weekend-sized; 2, 5, 6 are week-sized;
  3 spans both.
- **Free/self-host:** everything in Tracks 1–2 (the open-core comforts).
- **Cloud/Managed differentiators:** metered AI assist (10), hosted MCP tokens
  (9), comment email digests, `kiln rescue` as a service ("we migrate you"),
  priority templates. This gives the $4.99/$14.99 tiers real teeth beyond
  hosting the worker.
- Marketing beats fall out in order: "your client can finally *suggest*, not
  break" (Track 1) → "on-brand by construction" (Track 2) → "safe AI writes"
  (Track 3) → "leave Squarespace in an afternoon" (12).

## 6. Mobbin reference links

Figma Sites styles/webpages: mobbin.com/screens/2cc8606c-ae91-49e8-89cb-f9683b76220a ·
Figma named versions: mobbin.com/screens/e024e911-7e57-48af-904e-61283e8d63fc ·
Framer Agent: mobbin.com/screens/7546f939-f146-40e6-847a-1ded79d61d30 ·
Framer page menu (A/B, analytics, CMS page): mobbin.com/screens/6d1bb466-ab82-46fb-8a86-bc0dc5d3492f ·
Framer publish popover: flow f5cddb75 ·
Canva Brand Kit: mobbin.com/screens/80951c78-8625-432f-a8a7-ecde0afd8dd0 ·
Canva mobile text-styles sheet: mobbin.com/screens/11532e13-1b67-4148-a0f5-cda29f4d89be ·
Squarespace section chrome: mobbin.com/screens/838e0605-ad1c-4cff-983b-44e263558e14 ·
Squarespace inline toolbar: mobbin.com/screens/6e3f50e8-7bed-460d-9ad5-3e7629eae05d ·
Wix Content AI replace/insert: mobbin.com/screens/196c29ac-a4fd-4712-a5c5-07dd319fe41e ·
v0 publish w/ commit sha: flow 465c501a · Lovable restore points: flow 41a0f02c ·
Ditto per-string comments/suggestions: mobbin.com/screens/4dc11b3b-de81-47af-88fb-53e732ed1671 ·
ClickUp proofing: mobbin.com/screens/857d1c1c-f536-4b75-bd53-6c14a8e41613 ·
Air needs-review states: mobbin.com/screens/2edb1d3b-2514-4ed3-9fa2-0b0d8e03117f
