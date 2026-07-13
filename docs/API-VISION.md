# Kiln API — vision and plan

_Working doc. Where a programmatic Kiln API is useful, what it looks like, why
Kiln is unusually well-placed to ship one, and a phased plan._

## The core insight: Kiln is already 70% an API

Kiln's internals are already a read/write content API — they just aren't exposed
as one:

- **Read** — `engine.indexHtml()` / `readValues()` turn a page's `data-cms`
  annotations into a structured `key → value` map. No schema step: the page's own
  markup IS the schema.
- **Write** — `engine.applyEdits(source, [{key, html} | {key, attr, value}])`
  splices field-level edits at exact source offsets and produces a commit. The
  worker already imports `applyEdits` and the `/schedule` endpoint already accepts
  field-level edits from a non-browser caller with a session token.
- **Safety** — the hard part is done: server-side sanitize-guard (no script
  injection), path scoping, sensitive-path denylist, commit-diff verification,
  force-push block, field/section scoping, per-person expiry. An API token is
  essentially a headless, scoped editor session.

So an API is mostly **exposing existing internals behind a token**, not new
machinery. That's the "we can ship this fast" point.

## What makes it differentiated (the moat)

1. **Schema-free.** Point the API at a page URL, get its editable fields as JSON.
   No content modeling, no migration. Extends the "the page is the database"
   thesis to programmatic access.
2. **Every write is a reviewable git commit** with attribution, history, and
   one-click rollback. An "AI changed this" edit is a first-class, revertible
   artifact — not a silent DB mutation.
3. **It's the missing WRITE half of the AI-website wave.** AIs generate sites
   (v0 / Lovable / Bolt / Claude Artifacts); Kiln already edits them by hand. An
   API lets agents *keep them updated*. Kiln owns the maintenance half of the
   lifecycle, which is the recurring, sticky half.
4. **Field-level scoping is a real AI-safety story.** Hand an agent a token scoped
   to only `data-cms="specials"` on one page. Even a hallucinating or compromised
   agent can't touch anything else, can't inject scripts (server-sanitized), and
   every action is a reversible commit. "AI write access you can actually trust."

## Where it's useful (use cases, ranked by pull)

1. **Recurring "set-and-forget" content updates** — the killer one. "Every Monday,
   update the specials board from this Google Sheet." Too small to hire for, too
   frequent to do by hand. An agent reads the source, writes one field, commits;
   the owner reviews or auto-publishes.
2. **Sync from a source of truth** — events from Google Calendar / Eventbrite into
   a `data-cms-repeat`, products from Airtable/Shopify into a card list. Kiln is
   the presentation layer that stays in sync, no DB, no build step.
3. **MCP server → any AI can edit a Kiln site.** The marketable wedge. Claude /
   Cursor / ChatGPT-with-tools list a site's fields and commit edits, human
   approves via git. "Give your AI assistant safe write access to your website."
4. **Scriptable bulk ops** painful in the UI — "add this promo banner to all 40
   location pages," seasonal swaps, targeted reviewable batches.
5. **Programmatic publishing from other tools** — Zapier/Make/n8n node, a webhook
   that updates a field on form submit, a CI step that stamps a badge.
6. **Headless read API** — a native app, a second site, or an email newsletter
   consumes a page's fields as JSON without scraping. The page is both the site
   and the JSON source.

## API surface (layered — different consumers, different ergonomics)

**A. HTTP REST (the foundation)** — new authenticated endpoints on the worker,
reusing the engine + all existing guards:

```
GET   /api/v1/sites/:repo/pages/*path/fields      → { key: {value, kind, tag} }
PATCH /api/v1/sites/:repo/pages/*path             → { edits:[{key,html}|{key,attr,value}] } → commit
GET   /api/v1/sites/:repo/pages/*path/history     → commits touching the page
GET   /api/v1/sites/:repo/pages                    → list pages / list templates
POST  /api/v1/sites/:repo/pages                    → new page from a template
GET   /api/v1/sites/:repo/pages/*path/repeats/:name → array of blocks (structured)
PUT   /api/v1/sites/:repo/pages/*path/repeats/:name → replace/append blocks
```

- **Auth**: per-site API tokens issued from the dashboard, scoped exactly like
  invited editors (path scope, field/key scope, read-only vs read-write, expiry).
  A token is a headless editor session. Rate-limited (reuse `RL`).
- **Writes go through the same pipeline** as the editor: sanitize-guard, path
  scope, sensitive-path denylist, commit-diff. Non-negotiable — the API is a
  superset of editor power, so it must inherit every guard.
- **Human-in-the-loop modes**: auto-commit to main · commit to a `kiln-agent`
  branch or draft for review · open a PR. The draft/branch machinery exists.

**B. SDK** (`@kiln/client` npm + a Python package) — thin ergonomic wrapper:
`kiln.page(url).fields()` · `kiln.page(url).set('specials', html).publish()`.

**C. MCP server** (`kiln-mcp`) — the AI-native surface and the demo. Tools:
`list_fields`, `read_field`, `edit_field`, `list_pages`, `add_repeat_item`,
`page_history`. Every edit returns the commit URL. The demo: "Claude, mark us
closed on the 4th" → it edits the hours field → shows the commit.

**D. Integrations** on top of the REST API — Zapier/Make node, GitHub Action,
webhook receiver.

## Honest caveats / risks

- **Not real-time.** Writes are commits → host rebuild (~1 min to live). Position
  as *content*, not a data feed. Fine for specials/events/copy; wrong for stock
  tickers.
- **GitHub rate limits** on the shared installation token — agent/bulk writes need
  throttling and batching (the git-data tree-commit path already batches multiple
  files into one commit).
- **Concurrency** — field-level re-apply (already built) merges concurrent
  human+agent edits gracefully. Good story, keep it.
- **Scope discipline** — resist becoming a general database. Stay "structured
  content that lives on a page."
- **Abuse/cost** — API access is a natural paid tier; meter by writes or seats.

## Marketing angles

- "The write API for the web your AI built." / "AI builds it. Kiln keeps it current."
- "Give your AI safe write access to your website — scoped to fields, sanitized,
  every change a reviewable commit, one-click rollback."
- "A headless CMS with no schema and no database. The API is your page."
- **MCP-first launch**: ship `kiln-mcp`, list it in the MCP directory — that's
  where agent-builders shop, and it rides the agent wave for free.

## Phased plan

- **Phase 0 — spike (days).** `GET fields` + `PATCH edits` on the worker behind an
  API token, reusing engine + guards. Prove the loop with curl against a real site.
- **Phase 1 — the wedge.** `kiln-mcp` over that REST API. Demo Claude editing a
  live site end to end. Ship it, list it in the MCP directory. This is both the
  wedge and the marketing asset.
- **Phase 2 — reach.** JS + Python SDKs, docs, two flagship recipes
  (sync-from-Sheet, sync-from-Calendar).
- **Phase 3 — monetize.** Dashboard-issued scoped tokens, usage metering, a paid
  API tier. Zapier node + GitHub Action.
- **Phase 4 — ecosystem.** A recipes/templates marketplace (ties into the existing
  marketplace page): "specials from a sheet," "events from a calendar," etc.

## Why now

The agent wave needs a *safe write target for real websites*. Generation is
crowded; nobody owns safe, reviewable, scoped **maintenance**. Kiln already has
the engine, the commit pipeline, the scoping, and (as of this week) the
server-side sanitization that makes exposing write access defensible. The API is
mostly plumbing over parts that already exist.
