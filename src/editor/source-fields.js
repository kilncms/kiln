/**
 * Source-mode editor logic that needs no DOM — pure functions main.js wires up.
 *
 * Everything here is unit-testable in node: scanning provenance attributes,
 * grouping staged edits into /source/commit request bodies, the publish-state
 * machine over polled build signals (§11/§12), revert-request construction, and
 * the /healthz capability handshake (§13). Of the adapters it imports
 * pointer.js ONLY — the yaml machinery must never enter the editor bundle
 * (SOURCE-MODE-IMPL.md).
 *
 * And what the person editing reads and is told: a field's name, what can be
 * typed into a date or a number, which fields are read-only and why, what the
 * worker's refusals mean, and what a publish that is still building looks
 * like after a reload.
 */

import { parseSourceRef } from '../adapters/pointer.js';
import { readableName } from './names.js';

/** Tooltip for source fields when the worker predates source mode (§13). */
export const SOURCE_LOCKED_TIP =
  "This site's Kiln worker needs an update to edit source-built content.";

/** §12 timeout copy — shown when neither status nor deployment turned terminal. */
export const STILL_BUILDING_COPY =
  'Still building. Your change is saved and will appear when the build finishes.';

/**
 * Scan the page's data-kiln-source attribute values (§4.3, §8.1).
 *
 * items: [{ ref, cms }] in DOM order — `ref` the attribute string, `cms` truthy
 * when the element ALSO carries data-cms (source wins; §4.3 precedence).
 *
 * Returns {
 *   fields:    [{ ref, parsed, indexes }]  valid refs, deduped by exact ref
 *                                          string (the state.pendingSource key),
 *                                          indexes = every item carrying it;
 *   malformed: [{ ref, indexes }]          refs parseSourceRef rejected, deduped
 *                                          by ref so the console warn fires ONCE
 *                                          per distinct bad value (§8.1);
 *   dual:      [index, ...]                items carrying both attributes — the
 *                                          caller warns once per element.
 * }
 */
export function scanSourceRefs(items) {
  const fields = new Map();     // ref → { ref, parsed, indexes }
  const malformed = new Map();  // ref → { ref, indexes }
  const dual = [];
  (items || []).forEach((item, index) => {
    const ref = item?.ref;
    if (item?.cms) dual.push(index);
    const parsed = parseSourceRef(ref);
    if (!parsed) {
      const key = String(ref);
      if (!malformed.has(key)) malformed.set(key, { ref, indexes: [] });
      malformed.get(key).indexes.push(index);
      return;
    }
    if (!fields.has(ref)) fields.set(ref, { ref, parsed, indexes: [] });
    fields.get(ref).indexes.push(index);
  });
  return { fields: [...fields.values()], malformed: [...malformed.values()], dual };
}

/**
 * Group staged source edits by FILE into /source/commit request bodies (§5 —
 * one commit per file, committed sequentially by the caller).
 *
 * pending: Map or iterable of [ref, { value, type? }] where ref is the full
 * data-kiln-source string. Each edit is sent with `key: ref` so the response's
 * applied/skipped arrays map straight back onto state.pendingSource keys (the
 * adapter echoes `e.key ?? e.pointer`).
 *
 * Returns [{ file, refs, body }] in first-seen file order; refs[i] corresponds
 * to body.edits[i]. Unparseable refs are skipped defensively (they can never be
 * staged by the editor, but a bad entry must not poison the batch — §8.1).
 */
export function groupSourceEdits(pending, { repo, branch, adapter } = {}) {
  const groups = new Map();     // path → { file, refs, body }
  const entries = pending instanceof Map ? pending.entries() : pending || [];
  for (const [ref, staged] of entries) {
    const parsed = parseSourceRef(ref);
    if (!parsed) continue;
    if (!groups.has(parsed.path)) {
      groups.set(parsed.path, {
        file: parsed.path,
        refs: [],
        body: { repo, branch, adapter, file: parsed.path, edits: [] },
      });
    }
    const g = groups.get(parsed.path);
    const type = staged?.type ?? parsed.type;
    const edit = { pointer: parsed.rawPointer, value: wireValue(staged?.value, type, parsed), key: ref };
    if (type) edit.type = type;
    g.refs.push(ref);
    g.body.edits.push(edit);
  }
  return [...groups.values()];
}

/** Refs from `group` that the commit response reports applied (by key, falling
 *  back to pointer in case a hop stripped the echoed keys). */
export function matchAppliedRefs(group, applied) {
  const got = new Set(applied || []);
  return group.refs.filter((ref, i) => got.has(ref) || got.has(group.body.edits[i].pointer));
}

/** Map(ref → reason) for the response's skipped entries, matched like applied. */
export function matchSkippedRefs(group, skipped) {
  const out = new Map();
  for (const s of skipped || []) {
    let i = group.refs.indexOf(s?.key);
    if (i === -1) i = group.body.edits.findIndex(e => e.pointer === s?.key);
    if (i !== -1) out.set(group.refs[i], s.reason || 'skipped');
  }
  return out;
}

/**
 * §11/§12 publish-state machine — one poll tick's verdict.
 *
 *   status         GET /repos/{r}/commits/{sha}/status payload (combined
 *                  status; state only counts when total_count > 0 — an empty
 *                  combined status idles at "pending" forever)
 *   deployStatuses GET /repos/{r}/deployments/{id}/statuses payload for the
 *                  NEWEST deployment on the sha (newest status first)
 *   elapsedMs / timeoutMs (default 5 min)
 *
 * Returns 'published' | 'failed' | 'timeout' | 'building'. Only success and
 * failure/error are terminal; queued/pending/in_progress/inactive keep waiting
 * (hosts skip superseded builds — the timeout copy covers the rest). A failure
 * outranks a success seen in the same tick: a failed deploy means not live.
 */
export function resolveBuildState({ status, deployStatuses, elapsedMs = 0, timeoutMs = 5 * 60 * 1000 } = {}) {
  const signals = [];
  if (status && typeof status === 'object' && (status.total_count || 0) > 0) signals.push(status.state);
  if (Array.isArray(deployStatuses) && deployStatuses.length) signals.push(deployStatuses[0]?.state);
  if (signals.some(s => s === 'failure' || s === 'error')) return 'failed';
  if (signals.some(s => s === 'success')) return 'published';
  if (elapsedMs >= timeoutMs) return 'timeout';
  return 'building';
}

/**
 * Build the POST /source/revert body for one committed file (§12's one-click
 * revert): restore the file to the commit's PARENT. Accepts the /source/commit
 * response shape ({ file, commit: { sha, parent } }) or a flattened
 * { file, parent }. Returns null when there is nothing safe to revert to.
 */
export function revertRequest(committed, { repo, branch } = {}) {
  const file = committed?.file;
  const toSha = committed?.parent ?? committed?.commit?.parent;
  if (!file || !toSha) return null;
  const body = { repo, file, toSha };
  if (branch) body.branch = branch;
  return body;
}

/**
 * Capability handshake (§13): what a /healthz body says about source support.
 * Today's shipped worker answers a plain-text 'ok' — anything that isn't a JSON
 * object with a `modes` array is an OLD worker, and source fields render
 * read-only-with-tooltip instead of erroring.
 */
export function parseSourceCapabilities(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.modes)) {
    return { legacy: true, source: false, adapters: [] };
  }
  return {
    legacy: false,
    source: body.modes.includes('source'),
    adapters: Array.isArray(body.adapters) ? body.adapters : [],
  };
}

/** §10 multi-file save summary: "Saving 3 changes across 2 content files." */
export function saveSummary(nEdits, nFiles) {
  return `Saving ${nEdits} change${nEdits === 1 ? '' : 's'} across ${nFiles} content file${nFiles === 1 ? '' : 's'}.`;
}

/**
 * §10 provenance in friendly form: 'src/content/events/e.md#/frontmatter/title'
 * → 'events/e.md → title'. Drops the conventional src/content/ prefix and the
 * frontmatter/data pointer root; deeper pointers keep their trail
 * ('tags → 0'), and '/body' reads as 'body'.
 */
export function friendlyRef(parsed) {
  if (!parsed || !parsed.path || !Array.isArray(parsed.pointer)) return '';
  const path = parsed.path.replace(/^src\/content\//, '');
  let segs = parsed.pointer;
  if (segs.length > 1 && (segs[0] === 'frontmatter' || segs[0] === 'data')) segs = segs.slice(1);
  return `${path} → ${segs.join(' → ')}`;
}

// ─── Names ───────────────────────────────────────────────────────────────────

const isBodyPointer = (parsed) => !!parsed && parsed.pointer.length === 1 && parsed.pointer[0] === 'body';

/**
 * A field's name as the person editing reads it: what it is, and which entry
 * it belongs to. 'src/content/events/spring-fair.md#/frontmatter/title' →
 * 'Title · Spring fair'. The pointer and the path stay where they are stored;
 * "Where does this come from?" still shows them (friendlyRef).
 */
export function sourceLabel(parsed) {
  if (!parsed || !parsed.path || !Array.isArray(parsed.pointer)) return '';
  let segs = parsed.pointer;
  if (segs.length > 1 && (segs[0] === 'frontmatter' || segs[0] === 'data')) segs = segs.slice(1);
  // An entry's whole text is its text; a place in a list is counted from 1.
  const what = isBodyPointer(parsed) ? 'Text' : readableName(segs.map(s => (/^\d+$/.test(s) ? String(Number(s) + 1) : s)).join(' '));
  const parts = parsed.path.split('/');
  let file = parts.pop().replace(/\.[^.]+$/, '');
  if (/^index$/i.test(file) && parts.length) file = parts.pop();
  return `${what} · ${readableName(file)}`;
}

// ─── Typed values ────────────────────────────────────────────────────────────

const TYPE_HELP = {
  date: 'This needs to be a date written like 2026-09-20.',
  time: 'This needs to be a time written like 14:30.',
  number: 'This needs to be a number, such as 120.',
  boolean: 'This needs to be yes or no.',
  url: 'This needs to be a web address, or a page of this site such as /about.',
};

/**
 * What was typed into a field of a given type, as the value to save:
 * { ok: true, value } or { ok: false, why } with a sentence that says how to
 * write it. The same rules the worker holds every edit to (worker/source.js),
 * so nobody learns at Publish what could be said at once. A number and a
 * yes/no come back as a number and as true or false: the worker takes
 * nothing else for them. Text of no particular type is whatever was typed.
 */
export function typedValue(text, type) {
  const raw = String(text ?? '');
  const t = raw.trim();
  const no = { ok: false, why: TYPE_HELP[type] };
  if (type === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    if (!m) return no;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? { ok: true, value: t } : no;
  }
  if (type === 'time') return /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? { ok: true, value: t } : no;
  if (type === 'number') return /^-?\d+(\.\d+)?$/.test(t) ? { ok: true, value: Number(t) } : no;
  if (type === 'boolean') {
    if (/^(true|yes|on)$/i.test(t)) return { ok: true, value: true };
    if (/^(false|no|off)$/i.test(t)) return { ok: true, value: false };
    return no;
  }
  if (type === 'url') return t && !/\s/.test(t) ? { ok: true, value: t } : no;
  return { ok: true, value: raw };
}

/**
 * What is staged for a field: the words as typed, except that a date, a time,
 * a number, a yes/no or an address loses the spaces typed around it (the
 * worker takes "2026-09-21" and turns " 2026-09-21" away).
 */
export function keptText(text, type) {
  return Object.hasOwn(TYPE_HELP, type || '') ? String(text ?? '').trim() : String(text ?? '');
}

const TYPE_HINT = {
  date: 'A date is typed here like 2026-09-20.',
  time: 'A time is typed here like 14:30.',
  number: 'A number is typed here in digits, such as 120.',
  boolean: 'Type yes or no here.',
  url: 'A web address is typed here, or a page of this site such as /about.',
};

/**
 * What to say when someone starts editing a typed field whose words on the
 * page are not the value itself (a date the site writes out as "September 20,
 * 2026"): how it is typed, and that the site will show it its own way.
 */
export function typeHint(type) {
  return TYPE_HINT[type] ? `${TYPE_HINT[type]} The page shows it in the site’s own way once the site has rebuilt.` : '';
}

/** The value as it goes to the worker. What is staged stays the text that was typed. */
function wireValue(value, type, parsed) {
  if (typeof value !== 'string') return value;
  if (type === 'number' || type === 'boolean') {
    const typed = typedValue(value, type);
    return typed.ok ? typed.value : value;   // a wrong one goes as typed: the worker says why
  }
  return isBodyPointer(parsed) ? markdownText(value) : value;
}

// ─── The text of an entry ────────────────────────────────────────────────────

/** Whether a reference is to an entry's whole text (its markdown body). */
export function isBody(parsed) {
  return isBodyPointer(parsed);
}

/**
 * An entry's text is markdown, and the page shows what it was made into. The
 * editor reads and writes words, so it can only take a text that IS words:
 * one paragraph with nothing inside it. Returns that paragraph, or null for
 * anything else (bold, a link, a list, a heading, a second paragraph), which
 * would come back as plain words and lose all of it.
 *
 * `el` is the element that carries the reference; only tagName, children,
 * childNodes, nodeType and nodeValue are read.
 */
export function plainBody(el) {
  const kids = [...(el?.children || [])];
  if (kids.length !== 1 || kids[0].tagName !== 'P' || (kids[0].children || []).length) return null;
  for (const n of el.childNodes || []) {
    if (n !== kids[0] && n.nodeType === 3 && String(n.nodeValue || '').trim()) return null;
  }
  return kids[0];
}

/**
 * Words typed into an entry's text, written so that markdown reads them as
 * words: "5 * 3" stays a sum and "# one" stays a line that starts with a hash.
 */
export function markdownText(text) {
  return String(text ?? '')
    .replace(/[\\`*\[\]<]/g, '\\$&')
    .replace(/(^|[^\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, (m, lead) => (lead === undefined ? '\\_' : `${lead}\\_`))
    .replace(/^([ \t]*)([#>+-])/gm, '$1\\$2')
    .replace(/^([ \t]*\d+)([.)])(?=\s)/gm, (m, n, dot) => (dot === '.' ? `${n}\\.` : m));
}

// ─── Read-only, and why ──────────────────────────────────────────────────────

// The files each adapter writes (src/adapters/<id>.js canEdit). An adapter not
// listed is not second-guessed here: the worker decides.
const EDITABLE = { astro: /\.(md|markdown|mdx)$/i };

const OWN_FILE = 'This is kept in one of the site’s own files, which Kiln never changes';
const NOT_YOURS = 'You have not been given this part of the site to edit';
const GONE = 'The site’s content no longer has this, so reload the page to see how it is now.';

/** A file path against the folders an invited editor was given (the worker's pathInScope). */
function inFolders(file, paths) {
  if (!Array.isArray(paths) || !paths.length || paths.some(p => p === '' || p === '*' || p === '**')) return true;
  const f = String(file).replace(/^\/+/, '');
  return paths.some(p => {
    const pre = String(p).replace(/^\/+/, '').replace(/\/+$/, '');
    return !pre || f === pre || f.startsWith(pre + '/');
  });
}

/**
 * Why a field on a generated page cannot be edited here, as a sentence, or
 * null when it can. Known before anyone types: the worker would refuse each
 * of these at Publish, or (a formatted text, a link's address, a picture)
 * would take words that are not the value.
 *
 *   parsed   the reference (null when the stamp is not one)
 *   tag      the element's tagName
 *   caps     what the worker said it can do (parseSourceCapabilities), or undefined when it was not asked
 *   paths    the folders this person was given (absent or [''] = the whole site)
 *   adapter  the site's adapter id
 *   plain    for an entry's text: whether it is one plain paragraph (plainBody)
 */
export function lockReason({ parsed, tag = '', caps, paths, adapter = 'astro', plain = true } = {}) {
  if (!parsed) return 'This text can’t be edited here. For the site’s owner: its data-kiln-source value is not a reference Kiln can read.';
  if (caps && !caps.source) return 'This page can’t be edited yet. The site’s owner needs to update Kiln first.';
  if (!inFolders(parsed.path, paths)) return `${NOT_YOURS}. Ask the site’s owner if it needs changing.`;
  const kinds = EDITABLE[adapter];
  if (kinds && !kinds.test(parsed.path)) return `${OWN_FILE}, so it can’t be edited here. Ask the site’s owner.`;
  const body = isBodyPointer(parsed);
  if (body && /\.mdx$/i.test(parsed.path)) return 'This text is written as code in the site’s files, so it can’t be edited here. Ask the site’s owner.';
  if (String(tag).toUpperCase() === 'IMG' || parsed.type === 'image') return 'Pictures that come from the site’s content can’t be changed here yet. Ask the site’s owner.';
  if (parsed.type === 'url' && String(tag).toUpperCase() === 'A') return 'This link’s address comes from the site’s content and can’t be changed here yet. Ask the site’s owner.';
  if (body && !plain) return 'This text has formatting (bold, links, a list or more than one paragraph). Kiln can’t edit it on the page yet without losing that, so it is left as it is. Ask the site’s owner to change it.';
  return null;
}

// ─── Not saved, and why ──────────────────────────────────────────────────────

/** Why the worker left one edit out of a commit (its `skipped[].reason`), as a sentence. */
export function skipSentence(reason) {
  const r = String(reason || '');
  if (/^needs to be a date/.test(r)) return TYPE_HELP.date;
  if (/^needs to be a time/.test(r)) return TYPE_HELP.time;
  if (/^needs to be a number/.test(r)) return TYPE_HELP.number;
  if (/^needs to be true or false/.test(r)) return TYPE_HELP.boolean;
  if (/^not a safe URL/.test(r)) return TYPE_HELP.url;
  if (/script markup/.test(r)) return 'It can’t contain code, such as a script tag.';
  if (/^pointer not found/.test(r)) return GONE;
  if (/^type mismatch|^unsupported value type/.test(r)) return 'This holds something other than words, so it can’t be changed here.';
  return 'The site did not accept it.';
}

/**
 * Why the worker turned a whole file's edits away, as a sentence, when the
 * answer is one of its own about content files. null for anything else (an
 * ended sign-in, trouble on the way), which is told the way it always is.
 */
export function refusalSentence(status, error) {
  const e = String(error || '');
  if (/^file type not editable/.test(e) || /^forbidden path/.test(e)) return `${OWN_FILE}.`;
  if (/^outside your editing scope/.test(e)) return `${NOT_YOURS}.`;
  if (status === 404 && /content file no longer exists/.test(e)) return GONE;
  if (/^suggest-mode: source edits/.test(e)) return 'You can suggest changes, but on this site a suggestion can’t yet be made to this kind of text. Ask the site’s owner to make the change.';
  if (status === 409 && /^conflict/.test(e)) return 'Someone else saved a change at the same moment, so please publish again.';
  return null;
}

// ─── Saved, building, published ──────────────────────────────────────────────

/** While the host builds: the change is saved, and that is said first. */
export const SAVED_BUILDING_COPY = 'Saved. The site is rebuilding with your change…';
export const BUILD_FAILED_COPY = 'Build failed. Your change is saved but not live.';

/** How long a build is watched, and how long a publish is remembered in this browser. */
export const BUILD_WATCH_MS = 5 * 60 * 1000;
export const BUILD_KEPT_MS = 30 * 60 * 1000;

/**
 * What is kept of a publish to content files while the site rebuilds:
 * { sha, at, files: [{ file, sha, parent, refs: [{ ref, value, was }] }] }.
 * `sha` is the last commit, the one whose build carries them all. With it a
 * reload shows the saved words on a page that has not been rebuilt yet, and
 * a failed build can still be undone.
 */
export function buildRecord(committed, now = Date.now()) {
  if (!Array.isArray(committed) || !committed.length) return null;
  return { sha: committed[committed.length - 1].sha, at: now, files: committed };
}

/** 'building' while the build is watched, 'late' until the record is dropped, then 'gone'. */
export function buildStanding(rec, now = Date.now()) {
  if (!rec || typeof rec.sha !== 'string' || !Array.isArray(rec.files) || !(rec.at > 0)) return 'gone';
  const age = now - rec.at;
  if (age > BUILD_KEPT_MS) return 'gone';
  return age > BUILD_WATCH_MS ? 'late' : 'building';
}

/**
 * After a reload: which saved values to show on a page that still has the old
 * ones. `shown(ref)` is what the page shows for a field now (undefined when
 * it is not on this page). A field that already shows the saved value needs
 * nothing; one that shows something else again is left as the page has it.
 */
export function resumePlan(rec, shown) {
  const show = [];
  for (const f of rec?.files || []) {
    for (const r of f.refs || []) {
      if (shown(r.ref) !== undefined && shown(r.ref) === r.was && r.value !== r.was) show.push(r);
    }
  }
  return { show, waiting: show.length > 0 };
}
