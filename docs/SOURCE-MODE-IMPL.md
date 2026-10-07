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
   `url` → engine `safeUrl(value) === value`, and (since 2026-10) the shape
   of an address, `isAddress`; `boolean` → true/false;
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

### Pinned while implementing the worker (shipped in worker/source.js + index.js)

Where the contract above left room, these are the decisions now in code:

- **Rule 2 applies to every actor, admins included.** A source endpoint never
  writes config/code, whoever asks; an admin who really must can use their own
  GitHub token. (Precedent split: the /gh proxy exempts admins, /schedule does
  not — source follows /schedule, fail closed.)
- **Mode refusals (rule 1) also gate /source/revert and /source/duplicate** —
  both are direct writes to the live branch; letting a suggest/review session
  through would sidestep the suggest guard exactly like scheduling would.
- **`checkFragment` runs on EVERY string value not pinned by a stricter shape**
  — declared `enum`/`image`/unknown types included, not just
  string/text/markdown/untyped. `type` rides in from an attacker-controllable
  attribute, and `type: 'enum'` on a `/body` pointer must not smuggle raw HTML
  past the §14 markdown check.
- **Values must be scalars** (string | number | boolean); anything else skips
  that edit with `unsupported value type` (yaml-splice only addresses scalars).
- **healthz was plain-text `ok`**, not JSON; it now returns
  `{ ok: true, modes, adapters, version }` (same 200 — status probes keep
  working; the runbook's curl line was updated). CORS-wrapped so the editor can
  actually read it cross-origin. `version` is a worker constant kept in step
  with package.json.
- **Revert/duplicate refuse the UNION of every registered adapter's
  `sensitivePaths()`** (prefix match), since no single adapter is named.
- **Revert edges:** file missing at `toSha` → 404 with a clear error; file
  identical at head → `{ ok, unchanged: true }`, no commit; file deleted at
  head → the PUT (no sha) recreates it.
- **Default commit messages:** `Kiln: update <file>`,
  `Kiln: revert <file> to <sha7>`, `Kiln: duplicate <file>`.
- **For the CLI workstream:** cli/prepack.mjs's vendored worker file list needs
  `worker/source.js` (new import of worker/index.js — a self-host deploy fails
  without it, same failure mode sanitize-guard.js had).

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

### Pinned while implementing the editor (shipped in src/editor/source-fields.js + main.js)

Where the contract above left room, these are the decisions now in code:

- **Every /source/commit edit carries `key: <full data-kiln-source ref>`** (the
  `state.pendingSource` key). Worker + adapter already echo `e.key ?? e.pointer`
  into `applied`/`skipped`, so responses map straight back onto staged fields;
  the editor also falls back to pointer matching if a hop ever strips keys.
  Don't repurpose `edit.key` for anything else.
- **A 404 from page resolution is non-fatal when `cfg.mode === 'source'` or the
  page carries `[data-kiln-source]`** — source-mode URLs usually have no
  committed HTML file, so the editor boots with an empty page index instead of
  dying (HTML-only features degrade; source editing works). Everything else
  keeps today's fatal handling.
- **v1 source fields stage the element's textContent** (contenteditable,
  plaintext-only where supported) — §6's degrade-to-string, until typed
  controls land. `type=image` refs and `<img>` elements render read-only with
  a lock rather than staging garbage.
- **Terminal build signals are ONLY `success` and `failure`/`error`**; an empty
  combined status (`total_count: 0`) is not a signal, and
  queued/pending/in_progress/inactive keep polling until the 5-min timeout
  copy. A failure seen in the same tick as a success wins (a failed deploy
  means not live).
- **Suggest-mode Publish with staged source edits POSTs /source/commit anyway**
  and surfaces the worker's 403 copy verbatim (no client-side pre-block, per
  §13's server-enforcement rule); staged HTML edits still reroute to
  suggestions. (Replaced in 2026-10: see "Nothing overwritten unasked" below.)
- **The §7.3 guard caches the root-listing verdict in
  `sessionStorage["kiln_srcguard:<repo>"]`** ({ gen, builtHtml }); the
  page-path condition re-evaluates per page. A listing failure never blocks.
- **Client-side path/section scope is not applied to source fields** (their
  edits target FILES, not the current page) — the worker's
  `pathInScope`/sensitive-path rules are the enforcement, and skipped-edit
  reasons surface on the field. Review-mode seats stay read-only client-side.

### Changed after the editor was first watched on built pages (2026-10)

The first time the editor was driven in a browser on pages Astro built, as an
invited editor, these were put right. Where one replaces a line above, this is
the contract now. All of it is `src/editor/source-fields.js` plus its wiring in
main.js; nothing changes in what the worker is asked or answers.

- **A field's words are staged, except where the words are not the value.**
  `/body` is staged only when it renders as ONE plain paragraph (one `<p>` with
  no element inside): the paragraph is the editing surface, and the value goes
  out with markdown's own characters escaped (`markdownText`). Any other body
  is read-only: its textContent would be committed as the whole body, without
  its formatting. An `<a>` stamped `type=url` is read-only (its words are a
  label, and were being saved as the address), like `<img>` and `type=image`.
- **`number` and `boolean` go to the worker as a number and a boolean**
  (`typedValue`, applied in `groupSourceEdits`); what is staged and saved in the
  browser stays the text typed. They went as strings, which the worker refuses,
  so neither could ever be saved from the page.
- **Typed values are checked when the field is left**, by the worker's own rules
  (rule 4): a wrong one is not staged, the words that were there come back, and
  the status line says how to write it. A field whose words on the page are not
  a value of its type (a date the template writes out) says so when it is
  opened. The worker's check is unchanged and still the one that counts.
- **Read-only is decided at decoration** (`lockReason`): a worker without source
  mode, a path outside the folders this person was given (this REPLACES "client
  side path scope is not applied to source fields"; the worker's `pathInScope`
  is still the enforcement), a file the adapter does not write (for `astro`:
  anything but `.md`, `.markdown`, `.mdx`), an `.mdx` body, and the three cases
  above. The sentence is the element's title, and a click puts it in the status
  line.
- **Skipped and refused edits are listed** in their own box (`#kiln-srcskip`)
  with a sentence each (`skipSentence`, `refusalSentence`); the reason is no
  longer only the field's title. A 403 from `/source/commit` (scope, a
  forbidden path, suggest-mode) is listed there too, not shown in the
  "your sign-in does not allow this" dialog. Suggest-mode still POSTs and
  still shows the worker's answer, as a sentence.
- **Names**: the publish sheet, the saved-edits question and Copy my text use
  `sourceLabel` ("Title · Spring fair"). `friendlyRef` stays for "Where does
  this come from?" and for the owner's hover hint.
- **States**: the line while the build is watched is "Saved. The site is
  rebuilding with your change…". "Published ✓" is still said only on a success
  signal. A publish is kept in `localStorage["kiln_building:<repo>"]`
  (`buildRecord`: the commits, and each field's value before and after) for 30
  minutes: after a reload the saved values are shown on a page that still has
  the old ones and the build goes on being watched, and after a failed build
  "Undo this change" re-stages that file's edits.
- **A page with no file of its own** (`state.page.path === ''`): History and
  Page settings open a sentence, not a list of the repository's commits and a
  form that cannot be saved; no draft is looked for.

Still open, and written down rather than patched: a formatted body edited on
the page, a control for pictures and for link addresses, History for content
files, adding and removing entries (`/source/duplicate` has no button), and
what a click on template text should say.

### Nothing overwritten unasked, nothing offered that cannot be done (2026-10)

What changed in the contract after that round. The worker changed here, so
each point says what an older editor or an older worker does.

- **An edit may say what its field held when the editor read it**: `was`, a
  string, number or boolean, beside `value`. In `/source/commit`, after the
  typed checks and before `applyEdits`, `changedSinceRead` reads each such
  field from the current file (`adapter.read`) and, when it no longer says
  `was` and does not already say `value`, leaves that edit out with
  `{ key, reason: "changed since it was read", current }`. `current` is the
  file's value as read (a body trimmed). The rest of the edits are applied as
  before; none applied is still a 422 with `skipped`. The check runs again on
  the retry after a sha conflict, against the file as it is then. A field that
  is gone, or holds a list, is left to `applyEdits` and its own reasons.
  To write over the other change knowingly the editor sends the same edit with
  `was` set to the `current` it was given.
- **Compared as a reader sees it** (`sameAsRead`): runs of white space are one
  space and the ends are trimmed (a template may put the value on a line of
  its own); a number is a number however written; a yes/no likewise; `/body`
  is compared as its words, since the file holds markdown and the page shows
  it without the backslash escapes and with typeset quotes, dashes and dots.
- **Compatibility.** No `was` on an edit, no check: an editor from before this
  is written as it always was. A worker from before this ignores `was` and
  writes; the editor then has nothing to ask. `/healthz` gains
  `"sourceWas": true` so a script can tell which worker it is talking to
  (`scripts/e2e-source.mjs` says so when its case fails).
- **What the editor sends as `was`** (`readAs`, `sourceWas` in main.js): what
  the field's first place on the page showed when the page was read, when that
  is the value itself; for a typed field, the first place whose words are a
  value of that type (a date written out as "September 20, 2026" is not, and
  then nothing is sent). After a publish from the page, what was published.
  After "Use mine", the `current` the worker gave.
- **What the person sees** (`changedRefs`, `theirsOrMine`, `askWhich`): such an
  edit is not in the "not saved" box. One dialog per field, "Someone else
  changed this", with Theirs and Yours, **Keep theirs** (the edit is dropped;
  the page shows their value, or for a body says to reload once the site has
  rebuilt and takes no edit meanwhile) and **Use mine** (published again with
  `was: current`). Put away without an answer, the edit stays staged.
- **A `url` is an address** (`isAddress`, in the worker and, by the same rule,
  in the editor's `typedValue`): `http://` or `https://` and something after
  it, `mailto:`, `tel:`, or a place on the site (`/…` but not `//…`, `./`,
  `../`, `#…`, `?…`), with no white space. Words are skipped with
  `"not a safe URL: it needs to start with http:, https:, mailto: or tel:, or
  be a path on this site such as /about"`; the first three words are what an
  older editor matches, so it says its own sentence about addresses. An
  unsafe scheme keeps the bare `"not a safe URL"`. An empty value is still
  taken (it clears the field).
- **A value is written the way its line was** (`serializeScalar`): a line that
  was single- or double-quoted stays so, whatever the type (an apostrophe on a
  single-quoted line is doubled; a line break moves it to double quotes). On
  an unquoted line, or a key with no value: `boolean`, `number` and `date` are
  bare; `time` is double-quoted; other text is bare only when YAML 1.2 and 1.1
  both read it back as the same text and it is none of yes/no/on/off/y/n,
  true/false, null, a number in any spelling, sixty-based digits, a date. A
  leading `#` is quoted (it was written bare, as a comment). Inside `[ ]` or
  `{ }` a value with a comma or a bracket is quoted.
- **A body is written where the body was** (`astro.applyEdits`): the blank
  lines between the frontmatter and the text, and whatever ends the file, stay;
  blank lines sent around the new text are not added to them.
- **Suggest-only and comment-only editors.** This REPLACES "Suggest-mode
  Publish with staged source edits POSTs /source/commit anyway": for a
  suggest-only editor every source field is read-only at decoration
  (`lockReason`, `seat: 'suggest'`), and on a page with no file the menu has
  no Suggest button. The worker's 403 is unchanged and is still what counts.
  The first line (`startLine` in grants.js) says what this person can do on
  this page. Comments are filed under the page's file, so on a page with no
  file `initComments` is not started and the Comments button is hidden, for
  everyone: the worker answers 400 to every comment there.
- **Search & jump on a generated site** (`site-pages.js`): the list is not the
  repository's `.html` files. Candidates are the adapter's routes (for
  `astro`: files under `src/pages` that are one page each, and `public/*.html`
  except the sign-in page), the same-site links on the page and on every page
  found, and the sitemap's addresses. Each is fetched from the built site and
  listed only if it answers with HTML that is not what the site answers for an
  address that cannot exist. At most 60 addresses are asked for. The words
  fetched are what "Search site text" searches.

Still open after this: a field whose stored value the page does not show (a
date written out) is saved without the question; suggestions and comments for
content files and generated pages.

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
