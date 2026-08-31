# Kiln Source Mode — specification

**Status:** proposed, not started
**Author:** drafted 2026-08-10 for handoff to an implementation session
**Scope:** Kiln core (`src/`, `worker/`, `cli/`) — **no customer site work**

---

## 0. How to read this

This document is self-contained. It assumes you have the Kiln repo and nothing else.

It describes **one feature**: letting Kiln edit sites whose HTML is *generated at build time*
rather than committed to the repo. Today Kiln can only edit sites where the HTML file in the
repository is the content. That excludes every static-site generator — Astro, Eleventy, Hugo,
Jekyll, Next — which is most of the market Kiln is actually trying to reach.

A real site (`1906atlantaracemassacre.org`, an Astro build) is used throughout as a **reference
case only**. Do not touch that repository. It is deliberately being held back as an independent
acceptance test to be run *after* this work reports complete. §17 defines that test; treat it as
a sealed exam paper, not a worked example.

---

## 1. The one-paragraph version

Kiln stays exactly as it is — GitHub App, commit proxy, presence, scheduling, people and access,
history. Two functions become pluggable: the one that decides **which repo file a URL came from**,
and the one that decides **how to apply an edit to that file**. An *adapter* supplies both. The
generated page carries a `data-kiln-src` attribute naming its own source file and the field inside
it, so the on-page editor knows what to write. Everything downstream is unchanged.

---

## 2. Why this, and why now

**The market.** Kiln today addresses sites whose HTML is hand-written and committed. That is a
shrinking niche. The sites that most need Kiln are the ones a developer built with a generator
and handed to a non-technical client who now needs to change a date. Those are Astro, Eleventy,
Hugo and Jekyll sites, and Kiln cannot touch a single one of them.

**The trap.** Point Kiln at a generator-built repo today and it does something worse than fail: it
finds no HTML to edit, or — if the build output happens to be committed — it edits the output, the
next build regenerates it, and the edit vanishes with no error anywhere. Silent data loss on a
customer's site is the worst possible failure mode for a CMS. This is currently unguarded.

**The asymmetry.** The hard part of Kiln is splicing into HTML at byte offsets while preserving
every surrounding byte. That problem *does not exist* for structured source: YAML frontmatter is
parse → set → serialise. Source Mode is, mechanically, the easier path.

---

## 3. What already exists (read this before designing anything)

Verified against the current tree. Do not re-invent these.

| Thing | Where | Note |
|---|---|---|
| `applyEdits(raw, edits)` | `src/engine.js:206` | Returns `{ html, applied, skipped }`. `skipped` carries a per-key `reason` string. **This is seam 1.** |
| `indexHtml(raw)` | `src/engine.js` | Builds `fields` Map keyed by `data-cms` name, with byte ranges. HTML-specific. |
| `pageFileCandidates(pathname, root)` | `src/engine.js:432` | Maps a URL to candidate repo paths (`/` → `index.html`). **This is seam 2, and it is exactly what breaks.** |
| Commit proxy | `worker/index.js` ~467–485 | GETs current file, PUTs new content with `sha`. Content-type agnostic already. |
| Scheduled publish re-applies edits | `worker/index.js:477` | Re-runs `applyEdits` against *current* source at fire time so concurrent edits survive. **Preserve this property.** |
| Editor path scoping | `worker/index.js` ~455 | `isSensitivePath()`, `pathInScope(path, p.paths)`. Already per-editor. |
| GitHub App permissions | `worker/index.js:177` | `contents: write, metadata: read, **deployments: read, statuses: read**`. The build-feedback plumbing in §12 is already permissioned. |
| Sanitizer allows `data-*` | `src/engine.js:26` | Everything except `data-cms*` passes. `data-kiln-src` therefore survives sanitisation unchanged. |
| Attribute allow-list | `src/engine.js` `attrNameAllowed`, `safeUrl`, `safeStyle` | Reuse verbatim for any adapter that writes attributes. |

**Design consequence:** auth, tokens, presence, history, scheduling, billing, people and access are
all content-agnostic. They must require **zero** changes. If your implementation touches them,
you have taken a wrong turn.

---

## 4. Core concepts

### 4.1 Mode

A site is in exactly one **mode**, recorded in its Kiln config:

| Mode | Meaning |
|---|---|
| `html` | Today's behaviour. Repo HTML is the content. **Default when unset.** |
| `source` | Repo holds sources; HTML is generated. Edits are written to sources. |

`html` must remain the default-on-absence so every existing install upgrades untouched (§13).

A site in `source` mode may still contain hand-written HTML pages. Mode is a *site-level default*;
resolution is per-field (§4.3).

### 4.2 Adapter

An adapter teaches Kiln one source format. It is a pure module — no network, no credentials.

```js
export default {
  id: 'astro',
  displayName: 'Astro',

  // Confidence 0..1 that this repo is ours. Given a shallow file listing.
  detect(files) {},

  // Which source file(s) could have produced this URL, best guess first.
  // Replaces pageFileCandidates() when mode === 'source'.
  mapRoute(pathname, config) {},

  // Parse a source file into an addressable tree.
  parse(text, path) {},

  // Read one pointer's current value. Used to prefill the editor.
  read(parsed, pointer) {},

  // Apply edits and re-serialise. MUST mirror applyEdits()'s contract:
  //   returns { content, applied: [key], skipped: [{ key, reason }] }
  // MUST NOT throw on a bad pointer — skip it with a reason.
  applyEdits(text, edits, path) {},

  // Cheap pre-commit validation. Never a substitute for the build (§12).
  validate(text, path) {},

  // What Kiln should tell the host, and what the wizard should verify.
  buildHints() {},

  // Which paths an editor may never reach, beyond the global list.
  sensitivePaths() {},
};
```

Adapters live in `src/adapters/<id>.js` and are registered in `src/adapters/index.js`.
Ship `astro` first. `eleventy`, `hugo`, `jekyll` are §16.

### 4.3 Provenance

The generated page must say where each editable value came from. One attribute:

```html
<h3 data-kiln-src="src/content/events/interfaith-worship-service.md#/frontmatter/title">
  Interfaith Worship Service
</h3>
```

**Format:** `<repo-relative-path>#<pointer>`

- Path is always repo-relative, forward slashes, no leading `./`.
- Pointer is an **RFC 6901 JSON Pointer** into the adapter's parsed representation.
  It handles nesting and arrays without inventing syntax, and it already has a spec, a test suite
  and implementations in every language.

Reserved top-level pointer segments, by convention across adapters:

| Pointer | Means |
|---|---|
| `/frontmatter/<key>` | A field in YAML/TOML frontmatter |
| `/frontmatter/<key>/0` | First element of an array field |
| `/body` | The markdown body, whole |
| `/data/<key>` | A key in a standalone data file (`.json`, `.yaml`) |

**Why not reuse `data-cms`:** `data-cms` means *"this element's inner HTML is the content; splice
it here."* `data-kiln-src` means *"this element renders a value stored elsewhere."* Conflating them
is precisely the silent-overwrite bug. They must be distinguishable at a glance, in the DOM, by a
human debugging a customer site at 11pm.

**Precedence when both appear on one element:** `data-kiln-src` wins, and Kiln logs a warning to
the editor console naming the element. Never guess silently.

**Emitting it is the site's job, not Kiln's.** For Astro that is a tiny integration (§16.1). Kiln
ships the integration as a convenience but does not require it — a developer may hand-stamp the
attribute, exactly as they hand-annotate `data-cms` today.

---

## 5. The edit pipeline, end to end

```
 ┌── browser ────────────────────────────────────────────────┐
 │ 1. editor boots, scans DOM                                │
 │      [data-cms]        → html-mode field  (today's path)  │
 │      [data-kiln-src]   → source-mode field (new)          │
 │ 2. user edits in place                                    │
 │ 3. on save, group edits by source FILE                    │
 └───────────────────────────┬───────────────────────────────┘
                             │  POST /commit  { file, edits[], mode:'source' }
 ┌── worker ─────────────────▼───────────────────────────────┐
 │ 4. authorise: session, role, pathInScope, isSensitivePath │
 │ 5. GET current file contents + sha                        │
 │ 6. adapter.applyEdits(current, edits)                     │
 │ 7. adapter.validate(next)   → reject with reasons if bad  │
 │ 8. PUT contents (sha guards against lost updates)         │
 └───────────────────────────┬───────────────────────────────┘
                             │  commit
 ┌── host ───────────────────▼───────────────────────────────┐
 │ 9. build runs, may FAIL (new failure mode — see §12)      │
 │10. deployment status polled back to the editor            │
 └───────────────────────────────────────────────────────────┘
```

**One edit may touch several files.** A single page can render values from many sources: on the
reference site, one screen shows nine event files. Group by file and commit **one commit per file**,
each with its own `sha` guard. Do not batch across files into a tree commit in v1 — partial failure
handling gets much harder and the benefit is cosmetic.

**Preserve the re-apply-at-fire-time property.** Scheduled publishing currently re-runs `applyEdits`
against current source so concurrent edits survive. Source mode must do the same through the adapter.
This is the single most important behavioural invariant to carry over.

---

## 6. Field types and editor UX

HTML mode has one interaction: click text, type. Source mode has typed fields, which is an
opportunity and an obligation — a `date` field must not be a free-text box.

Adapters declare a type per pointer, inferred from the value and, where available, the project's
own schema:

| Type | Editor control | Validation |
|---|---|---|
| `string` | inline text | length only |
| `text` | inline rich text → markdown | sanitise as today |
| `markdown` | block editor, `/body` | sanitise |
| `date` | date picker | ISO 8601 |
| `time` | time picker | `HH:MM` |
| `enum` | select | must be in list |
| `boolean` | toggle | — |
| `url` | text + validity hint | `safeUrl()` |
| `image` | existing image picker | existing pipeline |
| `array<T>` | add/remove/reorder rows | per-element |
| `object` | nested field group | per-key |

**Schema discovery (Astro).** `src/content.config.ts` defines zod schemas. Do **not** attempt to
execute or fully parse TypeScript in the worker. Two acceptable strategies, in order:

1. **Value inference** — infer type from the current value plus the pointer's declared type in
   `data-kiln-src` if the emitter supplies one (`#/frontmatter/date?type=date`). Cheap, no
   TS parsing, works everywhere.
2. **Build-time export** — the Astro integration writes `.kiln/schema.json` at build, a plain
   JSON description of each collection's fields. Kiln reads it if present. This is the good path;
   make it optional so a hand-stamped site still works.

Never block editing because a schema is missing. Degrade to `string`.

---

## 7. Choosing a mode — the UX

The single most likely way to ruin a customer's day is putting them in the wrong mode. Make it
hard to get wrong and easy to reverse.

### 7.1 Detection

On connect, list the repo shallowly and run every adapter's `detect()`.

| Signal | Verdict |
|---|---|
| `astro.config.*`, `src/pages/`, `src/content/` | Astro, high confidence |
| `.eleventy.js`, `eleventy.config.*` | Eleventy |
| `config.toml` + `content/` + `layouts/` | Hugo |
| `_config.yml` + `_posts/` | Jekyll |
| `package.json` with a `build` script **and** committed `.html` at root | **ambiguous — ask** |
| `.html` at root, no build tooling | HTML mode |

### 7.2 The dialogue

Never silently pick when confidence is split. Present it in the customer's language, not ours:

> **How is this site built?**
>
> ○ **The pages are files in the repository.** You edit the page, Kiln saves the page.
> ● **The pages are generated from content files.** *(we think this one — we found Astro)*
> You edit the page, Kiln saves the underlying content and the site rebuilds. Takes about a minute.

Show what was detected and why: *"Found `astro.config.mjs` and 63 content files."* A developer
recognises that instantly; a non-developer at least sees Kiln is not guessing blindly.

### 7.3 The guard that must exist

If mode is `html` and the repo has **build tooling plus committed build output**, refuse to edit
the output and say why:

> Kiln can see `dist/index.html`, but this site is built by Astro — that file is regenerated on
> every build and any edit here would be erased the next time the site publishes.
> Switch this site to **Source Mode** to edit the content it is built from.

This single check is the highest-value thing in the whole spec. It converts today's silent data
loss into a blocking, explanatory error.

---

## 8. Error handling

Kiln's failure surface roughly triples. Enumerate it deliberately.

### 8.1 Pointer and parse errors — never fatal

| Condition | Behaviour |
|---|---|
| Pointer resolves to nothing | `skipped: [{ key, reason: 'pointer not found in source' }]`. Other edits in the batch still apply. |
| Source file missing | Skip the whole file's batch. Editor: *"That content file no longer exists — the page may have been rebuilt since you loaded it. Reload."* |
| File is not valid YAML/TOML/markdown | Refuse to write, whole file. Never partially serialise a file you failed to parse. |
| Pointer type mismatch (string edit onto an array) | Skip with `reason: 'type mismatch'`. |
| `data-kiln-src` malformed | Field is not editable. Warn in the editor console with the element's outerHTML, once. |

**Rule: a bad pointer never aborts a batch, and a bad parse never writes a byte.**

### 8.2 Concurrency

`sha` mismatch on PUT = someone else published first. Do **not** force. Re-GET, re-apply the same
edits through the adapter, retry once. Fail with *"Someone else saved this while you were editing.
Your changes were re-applied on top of theirs."* Twice-failed → surface to the user with a diff.

### 8.3 Round-trip fidelity — the sleeper bug

A naive YAML load/dump destroys comments, key order and quoting style. On a site whose config
carries explanatory comments, that is data loss dressed as a successful save.

**Requirement:** serialisation must be **surgical**, not regenerative. Locate the value's byte range
in the original text and splice, exactly as `applyEdits()` already does for HTML. Do not
`yaml.load()` → mutate → `yaml.dump()`.

Acceptance: a file with comments, blank lines, mixed quote styles and a trailing comment on the
edited line must round-trip byte-identical except the edited value.

### 8.4 The refusal list

Kiln must refuse to write, in any mode:

- anything in `.github/`, `.git/`
- lockfiles, `package.json`, CI config
- `*.ts`, `*.js`, `*.mjs`, `*.astro`, `*.jsx`, `*.vue`, `*.svelte` — **executable or template code**
- anything matching the adapter's `sensitivePaths()`

The reference site's `src/lib/site.ts` is the canonical example: it is TypeScript, it carries
load-bearing comments, and it holds the values a customer most wants to change. **Kiln must not
edit it.** If that content should be editable, the correct answer is for the site to move those
values into a data file — not for Kiln to learn TypeScript.

---

## 9. Validation before commit

Pre-commit validation is a courtesy, not a guarantee. The build is the real check (§12).

Run in order, cheapest first:

1. **Type check** against the declared/inferred field type.
2. **Adapter `validate()`** — parses the serialised result. Catches broken YAML immediately.
3. **Schema check** if `.kiln/schema.json` exists.

Surface failures inline on the field, before saving, in plain language: *"This needs to be a date,
like 2026-09-20."* Never a stack trace, never a zod error string.

---

## 10. What the editor UI must gain

- **Field affordance parity.** A source-mode field must look and behave like an HTML-mode field.
  The customer should not know or care which they are using.
- **Provenance on demand.** A small "where does this come from?" affordance showing
  `events/interfaith-worship-service.md → title`. Invaluable in support.
- **Publish state.** HTML mode is effectively instant. Source mode is not. See §11.
- **Multi-file save summary.** *"Saving 3 changes across 2 content files."*
- **Read-only fields.** Values Kiln can see but will not write (from a refused path) render with a
  lock and a tooltip explaining why. Better than appearing editable and silently failing.

---

## 11. Publish latency

HTML mode: commit ≈ live. Source mode: commit → build → live, typically 1–2 minutes, and it can fail.

If this is not designed for, it becomes support ticket #1 (*"my change isn't showing"* is already
in the operator playbook's top five, and today's answer is "the host isn't Git-connected" — source
mode adds a second, more common cause).

**Required states**, shown on save:

```
Saved  →  Building…  →  Published ✓
                     ↘  Build failed ✕  [what happened]  [undo this change]
```

Never claim "Published" on commit success. That is a lie in source mode.

---

## 12. Build feedback — the genuinely new subsystem

This is the largest new piece of work and the one most likely to be skipped. Do not skip it.

**The GitHub App already holds `deployments: read` and `statuses: read`.** No permission change,
no new consent screen for existing installs.

**Mechanism:** after a commit, poll GitHub's commit status / deployment status for that SHA until
terminal or timeout (suggest 5 min).

- `success` → Published.
- `failure` → surface the host's log excerpt if reachable, plus **one-click revert of that commit**.
  Reverting is a normal commit; the machinery already exists.
- timeout → *"Still building. Your change is saved and will appear when the build finishes."*

**Why a revert button matters more here than in HTML mode:** in HTML mode a bad edit publishes and
looks wrong. In source mode a bad edit **fails the build**, so the *previous* site stays live and
every subsequent edit by anyone else also fails to publish until the bad one is fixed. One person's
typo silently blocks the whole team. The revert button is the release valve.

Optionally, later: host-specific adapters (Cloudflare Pages, Netlify, Vercel APIs) for richer logs.
GitHub statuses alone are enough for v1 and work everywhere.

---

## 13. Upgrades and backward compatibility

**Non-negotiable: every existing install keeps working untouched, with no customer action.**

- Absent `mode` ⇒ `html`. Never infer a mode change for an existing site.
- `src/kiln.js` and `src/editor/main.js` ship to sites by copy. New editor code must **feature-detect**:
  if no `[data-kiln-src]` exists on the page, none of the new code paths run.
- **Capability handshake:** the editor announces its version to the worker; the worker announces
  which modes it supports. An old editor against a new worker keeps working. A new editor against
  an old worker degrades to HTML mode rather than erroring.
- `applyEdits()`'s exported signature must not change. Add an optional third argument or a sibling
  export; do not break the existing import in `worker/index.js:42`.
- Add a `kiln doctor` check: *"This repo looks like a generator build, but the site is in HTML mode."*
  That surfaces existing at-risk installs without changing them.

---

## 14. Security

- The commit proxy is unchanged: still installation-token-scoped, still one repo.
- Adapters are **pure functions over text**. No network, no filesystem, no credentials. Enforce
  by review; adapters are the obvious future supply-chain target.
- Reuse `attrNameAllowed`, `safeUrl`, `safeStyle` for any adapter writing attributes.
- Markdown bodies get the same sanitisation as HTML content. Markdown can contain raw HTML;
  do not assume it is inert.
- YAML: **never** use a loader that resolves anchors/aliases or custom tags from customer content.
  A billion-laughs alias bomb in frontmatter must not take the worker down.
- Path traversal: reject any `data-kiln-src` path containing `..` or resolving outside the repo root,
  before it reaches the commit proxy. Assume the attribute is attacker-controlled — it is served
  from a page that a compromised dependency could have modified.

---

## 15. Wizard changes

Today the wizard produces a self-hosted install and warns that annotation (component 6) is manual.

Source mode changes what "annotation" means, and mostly for the better: instead of hand-annotating
every element, the developer installs an integration that emits provenance automatically.

**New wizard steps:**

1. **Detect** the generator; state what was found.
2. **Confirm mode** (§7.2).
3. **Offer to install the integration** — for Astro, add `@kilncms/astro` to `astro.config.mjs`.
   This replaces annotation for generated content and is a genuinely better onboarding story than
   HTML mode has ever had.
4. **Verify the host auto-deploys.** Already the #2 support question; in source mode a
   non-connected host means *nothing ever publishes*. Check it and fail loudly.
5. **Verify Node version** against `buildHints().minNodeVersion` — a mismatch produces a build that
   fails only after the first edit, which is a terrible first experience.

---

## 16. Adapter opportunities

### 16.1 Astro — ship first

Integration emits provenance during render. Sketch:

```js
// astro.config.mjs
import kiln from '@kilncms/astro';
export default defineConfig({ integrations: [kiln()] });
```

It should:
- stamp `data-kiln-src` on elements rendering collection entry fields
- write `.kiln/schema.json` from the collection zod schemas at build
- be a no-op in production builds if `KILN_DISABLE=1`, so provenance can be stripped if a site
  prefers not to publish its content paths

The honest hard part: knowing *which* DOM element corresponds to *which* field. A component
receives `entry.data.title` and renders it somewhere. Two viable routes:

- **Explicit** (v1) — a small helper the developer wraps values in:
  `<h3 {...kilnSrc(entry, 'title')}>{entry.data.title}</h3>`. Honest, zero magic, works today.
- **Automatic** (later) — a compiler transform tracking collection field access through the
  template. Much better UX, much more work, and it will have edge cases.

Ship explicit. It is one line per field, comparable to `data-cms` annotation, and it is the same
mental model developers already have.

### 16.2 Beyond Astro

| Adapter | Notes |
|---|---|
| **Eleventy** | Markdown + frontmatter, data cascade in `_data/`. Closest sibling to Astro. |
| **Hugo** | TOML/YAML/JSON frontmatter; large install base; very ready for this. |
| **Jekyll** | GitHub Pages native — Kiln plus GitHub Pages needs no host at all. |
| **Data-file** | No generator. Edits `.json`/`.yaml` anywhere. The universal fallback, and the smallest adapter. Consider shipping it **second**, before Eleventy — it makes Kiln useful to any site with a data file. |
| **Docusaurus / Nuxt Content / Next MDX** | Same shape, bigger audiences, more variance. |

**Strategic note:** the data-file adapter plus the build-status subsystem makes Kiln useful to
sites it currently cannot touch at all, with no generator knowledge required. That is arguably a
bigger unlock than Astro specifically.

---

## 17. Acceptance tests

### 17.1 Unit and fixture (build these yourself)

Fixture repos under `test/fixtures/`, no external dependencies:

- `astro-min/` — one collection, three entries, one page
- `astro-comments/` — frontmatter with comments, blank lines, mixed quoting → §8.3 fidelity
- `astro-broken/` — invalid YAML in one entry → must refuse to write
- `mixed/` — one hand-written HTML page **and** one generated page → per-field resolution
- `traversal/` — `data-kiln-src="../../etc/passwd#/x"` → must be rejected

Must pass:

1. Edit a frontmatter string → commit contains only that change, byte-identical elsewhere
2. Edit a field in a file with comments → comments and key order survive
3. Edit two fields in two files from one page → two commits, both correct
4. Bad pointer among good ones → good ones apply, bad one reported in `skipped`
5. Concurrent edit → sha conflict → re-apply → succeeds
6. Build fails → editor shows failure and offers revert
7. HTML-mode fixture behaves **identically to today** (regression guard)
8. Site with build tooling + committed output in HTML mode → blocked with the §7.3 message

### 17.2 The sealed test — `1906atlantaracemassacre.org`

**Do not open, clone, or modify this repository while implementing.** It is being held as an
independent test of whether this spec was implemented well, by someone who did not write it.

It is a live Astro 7 site: 27 pages, 63 content files across 5 collections, 9 events, 25 victim
entries, generated `.ics` files and JSON-LD, deployed on Cloudflare Pages Git-connected to GitHub.
It is a real customer site with a hard public deadline.

When implementation reports complete, that site's maintainer will attempt, unaided and without
reading your code:

1. Connect the repo to Kiln and be correctly identified as source mode
2. Change an event's start time from the live page and see it publish
3. Change a venue name, with the `.ics` file and JSON-LD regenerating correctly
4. Add a new event
5. Attempt an invalid date and get a comprehensible error, not a failed build
6. Attempt to edit a value in `src/lib/site.ts` and be told, clearly, that it cannot
7. Make two edits from two people at once and lose neither
8. Break the build deliberately, see the failure surfaced, and revert in one click

**Any silent data loss is an automatic fail**, regardless of how much else works.

---

## 18. Phasing

| Phase | Contents | Done when |
|---|---|---|
| **1** | Adapter interface, `data-kiln-src`, Astro adapter (explicit helper), surgical YAML splicing, refusal list, §7.3 guard | Fixture tests 1–5, 7, 8 pass |
| **2** | Build-status polling, publish states, revert button | Fixture test 6 passes |
| **3** | Wizard detection + mode dialogue + integration install | A fresh Astro site onboards without hand-editing config |
| **4** | Typed field controls, `.kiln/schema.json` | Dates use a date picker |
| **5** | Data-file adapter, then Eleventy/Hugo/Jekyll | Each ships with its own fixture |

Phases 1 and 2 together are the minimum that is safe to put in front of a customer. **Phase 1
alone is not** — without build feedback, a failed build looks to the customer exactly like a
change that did nothing.

---

## 19. Non-goals

- Editing `.astro`, `.jsx`, `.vue`, `.svelte` or any template/code file.
- Executing or type-checking TypeScript in the worker.
- Creating or deleting content files in v1 (test 17.2.4 needs creation — scope it into phase 1 as
  *duplicate an existing entry*, which is far safer than authoring one from nothing).
- Replacing HTML mode. Both modes are first-class, permanently.
- Rebuilding any customer site to suit Kiln. If a site cannot be edited, that is Kiln's gap.

---

## 20. Open questions

1. **Commit granularity** — one commit per file is specified. Is a squashed multi-file commit
   wanted later for cleaner history? It complicates partial failure; deferred deliberately.
2. **Provenance in production HTML** — `data-kiln-src` publicly reveals repo structure. Harmless for
   an open-source site, possibly unwanted elsewhere. `KILN_DISABLE=1` is proposed; should stripping
   be the default, with provenance only in preview builds? That would require the editor to run
   against preview, which is a bigger change.
3. **Explicit vs automatic Astro provenance** — shipping explicit. Worth deciding now whether the
   automatic transform is on the roadmap, since it affects how the helper's API should look.
4. **Content creation UX** — duplicate-an-entry is the safe v1. Full "new entry" needs a schema and
   a filename convention; which collections should support it first?
5. **Does the data-file adapter ship before Eleventy?** Argued yes in §16.2; wants a product call.

---

## 21. Glossary

| Term | Meaning |
|---|---|
| **Mode** | Whether a site's content lives in its HTML (`html`) or in sources that build into HTML (`source`) |
| **Adapter** | A module teaching Kiln one source format |
| **Provenance** | The `data-kiln-src` attribute linking a rendered element back to its source field |
| **Pointer** | RFC 6901 JSON Pointer identifying a value inside a parsed source file |
| **Surgical serialisation** | Splicing a value into the original text by byte range, preserving everything else |
| **Sealed test** | §17.2 — the reference site, deliberately untouched during implementation |
