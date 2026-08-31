# Source Mode — implementation contracts (phase 1+2)

Companion to SOURCE-MODE-SPEC.md. The spec says WHAT; this pins the interfaces
so worker, editor and CLI work can proceed in parallel without drift. If a
contract here must change, change this file in the same commit.

## Deviation from the spec draft (final)

The provenance attribute is **`data-kiln-source`**, not `data-kiln-src`.
`data-kiln-src` already ships as the editor's transient staged-image marker
(an `<img>` awaiting upload carries its future path there until publish). The
two meanings must be distinguishable at a glance; everything else about §4.3
(format, RFC 6901 pointers, `?type=` hint) is unchanged. `src/adapters/pointer.js`
exports `SOURCE_ATTR` — use it, never the literal string.

## Shipped core (committed, tested — build on it, do not fork it)

- `src/adapters/pointer.js` — `parseSourceRef(ref)` → `{ path, pointer, rawPointer, type }|null`;
  `safeSourcePath`, `parsePointer`, `formatPointer`, `SOURCE_ATTR`.
- `src/adapters/yaml-splice.js` — surgical YAML editing (worker-side only).
- `src/adapters/astro.js` — the adapter. `applyEdits(text, edits, path)` takes
  `edits: [{ pointer: '/frontmatter/title', value, type?, key? }]` and returns
  `{ content, applied: [key], skipped: [{ key, reason }] }`. Also `canEdit(path)`,
  `validate(text, path)` → `null | reason`, `detect`, `mapRoute`, `read`,
  `buildHints`, `sensitivePaths()`.
- `src/adapters/index.js` — `getAdapter(id)`, `adapterIds()`, `detectAll(files)`,
  `generatorSignals(files)`.
- `src/adapters/detect.js` — **yaml-free**; the ONLY adapter module the editor
  bundle may import besides pointer.js.

## Worker endpoints (owner: worker workstream)

All under the existing worker; auth = the same session resolution as `/presence`
(admin `Authorization: Bearer` GitHub token, or `X-Kiln-Session` for invited
editors). CORS like existing endpoints.

### POST /source/commit
Request:
```json
{ "repo": "owner/name", "branch": "main", "adapter": "astro",
  "file": "src/content/events/e.md",
  "edits": [{ "pointer": "/frontmatter/title", "value": "New", "type": "string" }],
  "message": "optional commit message" }
```
Rules, in order:
1. actor resolved; review-mode → 403 comment-only; suggest-mode → 403
   `"suggest-mode: source edits can’t be proposed yet"` (v1).
2. `adapter` must resolve via `getAdapter`; `file` must pass `safeSourcePath`,
   `!isSensitivePath`, `pathInScope(actor.paths)`, `adapter.canEdit(file)`, and
   not start with any `adapter.sensitivePaths()` entry (prefix match).
3. `edits` array 1..100; each pointer must `parsePointer`.
4. Typed validation before applying (§9), skip-with-reason per edit:
   `date` → `/^\d{4}-\d{2}-\d{2}$/`; `time` → `/^([01]\d|2[0-3]):[0-5]\d$/`;
   `url` → engine `safeUrl(value) === value`; `boolean` → true/false;
   `number` → finite. Every STRING-carrying value (string/text/markdown and
   untyped) additionally runs `checkFragment(value)` from sanitize-guard —
   markdown can contain raw HTML and is not inert (§14); a hit skips the edit
   with `"value may not contain script markup"`.
5. GET current file via installation token. 404 → 404
   `{ "error": "That content file no longer exists — the page may have been rebuilt since you loaded it. Reload." }`.
6. `adapter.applyEdits(current, edits, file)`; zero applied → 422 `{ skipped }`.
7. `adapter.validate(next, file)` → non-null → 422 `{ error }`. Unchanged
   content → 200 `{ ok, unchanged: true, applied, skipped }` (no commit).
8. PUT with `sha`; author attribution exactly like the /gh proxy
   (`{ name: "<actor> (via Kiln)", email: "kiln-editor@users.noreply.github.com" }`).
   On sha conflict: re-GET, re-apply the SAME edits, retry **once** (§8.2);
   second conflict → 409.
9. 200 → `{ "ok": true, "file": "...", "commit": { "sha": "...", "parent": "..." },
   "applied": [...], "skipped": [...] }` — `parent` = first parent of the new
   commit (the PUT response carries `commit.parents`), used by revert.

### POST /source/revert
`{ "repo", "branch"?, "file", "toSha" }` — actor auth + the same path rules as
/source/commit rule 2 (any adapter's canEdit OR isHtmlPath — a revert restores
whatever the failed commit touched). Fetch the file content at `toSha`
(`?ref=`), PUT it over the current head with the current sha. This is §12's
one-click revert; response mirrors /source/commit.

### POST /source/duplicate  (v1 "add an entry" = duplicate, §19)
`{ "repo", "branch"?, "file" }` — same auth/path rules. Copies the file to a
sibling path `name-copy.md` / `name-copy-2.md` (first free). Exact byte copy.
Response `{ ok, path, commit: { sha, parent } }`.

### GET /healthz — capability handshake (§13)
Extend the existing response with `"modes": ["html", "source"],
"adapters": ["astro"], "version": <existing or worker version>`. The editor
treats a healthz without `modes` as an old worker and renders source fields
read-only-with-tooltip instead of erroring.

## Editor behaviour (owner: editor workstream)

- Feature-detect: no `[data-kiln-source]` on the page → not one new code path
  runs (§13). Never import yaml-splice/astro/index from the editor — only
  `pointer.js` and `detect.js`.
- Scan `[data-kiln-source]`, `parseSourceRef`; malformed → field not editable,
  ONE console warn with the element (§8.1). Both `data-cms` and
  `data-kiln-source` on one element → source wins, console warn (§4.3).
- Capability check once per boot (healthz). Worker without source →
  lock affordance + tooltip "This site's Kiln worker needs an update to edit
  source-built content."
- Staging: same look/feel as data-cms fields (§10). Undo/redo integrate with
  the existing session history. Sandbox mode stages locally, never commits.
- Publish: group staged source edits by FILE; POST /source/commit per file,
  sequentially, one commit per file (§5). Summary line
  "Saving N changes across M content files."
- Publish states (§11/§12): `Saved → Building… → Published ✓ / Build failed ✕`.
  After the LAST commit, poll through the existing /gh proxy every ~10s for up
  to 5 min: combined commit status `GET /repos/{r}/commits/{sha}/status` AND
  deployments `GET /repos/{r}/deployments?sha={sha}` + that deployment's
  statuses (Cloudflare Pages reports via deployments). First terminal signal
  wins; timeout → "Still building. Your change is saved and will appear when
  the build finishes." Failure → surface + a revert button per committed file
  → POST /source/revert with that commit's `parent`.
- Provenance affordance: "where does this come from?" showing
  `events/e.md → title` (§10).
- §7.3 guard: html-mode boot (no source fields), fetch the repo ROOT listing
  once via the proxy (`GET /repos/{r}/contents`), run `generatorSignals`; if a
  generator is detected AND the page file Kiln resolved sits under a build-output
  dir (or `builtHtml` is true), show the blocking explanation from §7.3 instead
  of decorating fields.

## CLI + fixtures + integration (owner: cli workstream)

- Wizard: detection step via `detectGenerators` on the local file listing;
  §7.2 dialogue; source-mode selection records `mode: 'source', adapter: 'astro'`
  in the generated kiln-config; wizard's §7.3 warning when tooling + committed
  output are both present.
- `kiln doctor`: the §13 check — repo looks generator-built but config says
  html mode → warn with the §7.3 copy. Uses detect.js on the LOCAL tree.
- Self-host plumbing: generated worker package.json gains `yaml: "^2"`; the
  offline fallback copy list and cli/prepack.mjs must vendor `src/adapters/`
  and node_modules `yaml` alongside parse5/entities.
- Fixtures `test/fixtures/{astro-min,astro-comments,astro-broken,mixed,traversal}`
  + integration tests for spec §17.1 items not already covered by unit tests.
- `integrations/astro/` — `@kilncms/astro` package: the explicit `kilnSource()`
  helper stamping `data-kiln-source` (+ `?type=`), `KILN_DISABLE=1` no-op,
  README. Schema export (.kiln/schema.json) is phase 4 — document as such.

## Config surface

`window.KILN` gains optional `mode: 'html' | 'source'` (absent ⇒ 'html', §13)
and `adapter: 'astro'`. kiln-config.js remains the single site-side source of
truth.

## Out of scope for this pass (tracked, deliberate)

Suggest-mode source edits; scheduled source edits; typed field CONTROLS (date
picker etc. — §6 degrade-to-string applies, validation is worker-side); schema
discovery; data-file adapter; automatic Astro provenance transform.
