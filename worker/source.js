/**
 * Source-mode decision logic (SOURCE-MODE-SPEC §5, §8, §9, §14 and
 * SOURCE-MODE-IMPL "Worker endpoints").
 *
 * Everything here is PURE — no fetch, no env, no KV — so the refusal and
 * validation rules behind POST /source/commit|revert|duplicate unit-test
 * without a GitHub call in sight; worker/index.js keeps only the fetch glue.
 * The worker's own path guards (isSensitivePath, pathInScope) and the safety
 * primitives (engine.safeUrl, sanitize-guard.checkFragment) are injected at
 * the call site rather than re-implemented — single source of truth.
 */

import { getAdapter, adapterIds } from '../src/adapters/index.js';
import { safeSourcePath, parsePointer } from '../src/adapters/pointer.js';
import { isHtmlPath } from './sanitize-guard.js';

/** Per-request edit cap (IMPL contract rule 3: 1..100). */
export const SOURCE_EDITS_MAX = 100;

/** Exact copy for a vanished content file (IMPL contract rule 5). */
export const SOURCE_FILE_GONE =
  'That content file no longer exists — the page may have been rebuilt since you loaded it. Reload.';

/**
 * Rule 1: who may source-edit at all. Suggest-mode has no source pipeline yet
 * (v1 — SOURCE-MODE-IMPL "Out of scope"), and review-mode is comment-only
 * everywhere. Applies to commit AND revert/duplicate: all three are direct
 * writes to the live branch — same door, same lock as /schedule.
 * Returns { status, error } to refuse, or null to proceed.
 */
export function sourceModeRefusal(actor) {
  if (!actor) return { status: 401, error: 'unauthorized' };
  if (actor.mode === 'review') return { status: 403, error: 'review-mode: comment-only access' };
  if (actor.mode === 'suggest') return { status: 403, error: 'suggest-mode: source edits can’t be proposed yet' };
  return null;
}

/**
 * Rule 2: the path gauntlet, in contract order — safeSourcePath (the attribute
 * is attacker-controlled, §14), the worker's sensitive denylist, the actor's
 * path scope, adapter.canEdit, and the adapter's own sensitivePaths() by
 * prefix. Applied to every actor, admins included — a source endpoint never
 * writes config/code, whoever asks.
 *
 * `adapter`: the resolved adapter for /source/commit. For revert/duplicate
 * pass `anyEditable: true` instead — the file must be editable by ANY
 * registered adapter or be an HTML page (a revert restores whatever the failed
 * commit touched), and the UNION of every adapter's sensitivePaths() applies
 * (fail closed).
 *
 * Returns { status, error } to refuse, or { file } (normalized) to proceed.
 */
export function refuseSourcePath(file, actor, { isSensitivePath, pathInScope }, { adapter = null, anyEditable = false } = {}) {
  const clean = safeSourcePath(file);
  if (!clean) return { status: 400, error: 'bad file path' };
  if (isSensitivePath(clean)) return { status: 403, error: 'forbidden path for editor' };
  if (!pathInScope(clean, actor && actor.paths)) return { status: 403, error: 'outside your editing scope' };
  const adapters = adapter ? [adapter] : adapterIds().map(getAdapter);
  if (anyEditable) {
    const editable = isHtmlPath(clean) || adapters.some(a => { try { return !!a.canEdit(clean); } catch { return false; } });
    if (!editable) return { status: 400, error: 'file type not editable' };
  } else if (!adapter.canEdit(clean)) {
    return { status: 400, error: 'file type not editable by this adapter' };
  }
  for (const a of adapters) {
    let sens;
    try { sens = a.sensitivePaths() || []; } catch { return { status: 403, error: 'forbidden path for editor' }; }
    if (sens.some(p => p && clean.startsWith(p))) return { status: 403, error: 'forbidden path for editor' };
  }
  return { file: clean };
}

/**
 * Rules 1–3 of POST /source/commit: actor mode, adapter resolution, the path
 * gauntlet, edit-count cap, and per-edit pointer parseability. Returns
 * { status, error, detail? } to refuse the whole request, or
 * { adapter, file, cleanEdits: [{ pointer, value, type, key }] } to proceed
 * (key defaults to the pointer, mirroring adapter.applyEdits).
 */
export function validateSourceRequest({ file, edits, adapter: adapterId, actor } = {}, deps) {
  const refuse = sourceModeRefusal(actor);
  if (refuse) return refuse;
  const adapter = getAdapter(adapterId);
  if (!adapter) return { status: 400, error: 'unknown adapter', detail: String(adapterId || '') };
  const p = refuseSourcePath(file, actor, deps, { adapter });
  if (p.error) return { status: p.status, error: p.error };
  if (!Array.isArray(edits) || !edits.length || edits.length > SOURCE_EDITS_MAX) {
    return { status: 400, error: 'bad edits' };
  }
  const cleanEdits = [];
  for (const e of edits) {
    if (!e || typeof e !== 'object' || typeof e.pointer !== 'string' || !parsePointer(e.pointer)) {
      return { status: 400, error: 'bad pointer', detail: String((e && e.pointer) ?? '') };
    }
    const clean = { pointer: e.pointer, value: e.value, type: e.type, key: e.key ?? e.pointer };
    // What the field held when the editor read it, when the editor says so (changedSinceRead).
    if (isSingleValue(e.was)) clean.was = e.was;
    cleanEdits.push(clean);
  }
  return { adapter, file: p.file, cleanEdits };
}

const isSingleValue = (v) => ['string', 'number', 'boolean'].includes(typeof v);

// ─── A field someone else changed is not written over ────────────────────────
// An edit may say what its field held when the editor read it (`was`: what
// the built page showed). When the file no longer says that, somebody changed
// the field since the page was built, and writing the edit would replace
// their change without anyone having seen it. That one edit is left out, with
// what the file says now, so the editor can show both and let the person
// choose. An edit that says nothing is written as it always was: that is how
// an editor from before this check keeps working.

/** The skip reason for an edit whose field no longer says what the editor read. */
export const CHANGED_SINCE_READ = 'changed since it was read';

const spaced = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * An entry's text as the page shows it. The file holds markdown and the page
 * what the site made of it: a backslash before a mark is gone, the common
 * entities are their characters, and quotes, dashes and dots may have been
 * typeset. Both sides are brought to the same plain form before comparing.
 */
function proseWords(text) {
  return spaced(String(text)
    .replace(/\\([\\`*_{}[\]()#+\-.!<>~|])/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/\u2026/g, '...').replace(/[\u2013\u2014]|-{2,3}/g, '-'));
}

const YES = /^(true|yes|on)$/i;
const NO = /^(false|no|off)$/i;

/**
 * Does the file's value say what was read? Compared as a reader sees it:
 * spacing does not count (a template may put the value on a line of its own),
 * a number is a number however it is written, and an entry's text is its
 * words (proseWords).
 */
export function sameAsRead(current, was, { pointer, type } = {}) {
  if (current === null || current === undefined) return spaced(was) === '';
  if (pointer === '/body') return proseWords(current) === proseWords(was);
  if (typeof current === 'boolean' || type === 'boolean') {
    const truth = (v) => (typeof v === 'boolean' ? v : YES.test(spaced(v)) ? true : NO.test(spaced(v)) ? false : null);
    return truth(current) !== null && truth(current) === truth(was);
  }
  if (typeof current === 'number' || type === 'number') {
    const n = (v) => (spaced(v) === '' ? NaN : Number(spaced(v)));
    if (!Number.isNaN(n(current)) || !Number.isNaN(n(was))) return n(current) === n(was);
  }
  return spaced(current) === spaced(was);
}

/**
 * The edits whose field no longer says what the editor read, as skip entries
 * with what the file says now: [{ key, reason, current }]. Looked at only when
 * an edit says what it read, and only for a single value: a field that is
 * gone, or holds a list, is the adapter's to refuse, with its own reason. An
 * edit that would write what the file already says is nobody's to ask about.
 */
export function changedSinceRead(adapter, text, file, edits) {
  const out = [];
  let parsed = null;
  for (const e of edits || []) {
    if (!isSingleValue(e.was)) continue;
    let current;
    try {
      parsed = parsed || adapter.parse(text, file);
      current = adapter.read(parsed, e.pointer);
    } catch { continue; }
    if (current === undefined || (current !== null && typeof current === 'object')) continue;
    if (sameAsRead(current, e.was, e) || sameAsRead(current, e.value, e)) continue;
    out.push({ key: e.key ?? e.pointer, reason: CHANGED_SINCE_READ, current: typeof current === 'string' ? current.trim() : (current ?? '') });
  }
  return out;
}

/**
 * What a `url` field holds: a web address, an email or a phone link, or a
 * place on this site (a path from its root, a path from here, a place on the
 * page). Nothing with a space in it, and no words: "Get tickets" is a label.
 * An empty value is let through: it clears the field.
 */
export function isAddress(value) {
  const v = String(value);
  if (v === '') return true;
  if (/[\s\u0000-\u001f\u007f]/.test(v)) return false;
  return /^(?:https?:\/\/.|mailto:.|tel:.|\/(?!\/)|\.\.?\/|[#?])/i.test(v);
}

/**
 * The reason for words in a url field. It begins the way the reason for an
 * unsafe scheme does, so an editor from before this rule says its own
 * sentence about addresses.
 */
export const NOT_AN_ADDRESS =
  'not a safe URL: it needs to start with http:, https:, mailto: or tel:, or be a path on this site such as /about';

/**
 * Rule 4: typed validation before applying (§9), per-edit and never fatal
 * (§8.1 — a bad value skips its edit, the rest of the batch still lands).
 * Returns [{ key, reason }] for the edits the commit must skip.
 *
 * Every string value that is not pinned down by a stricter shape (the
 * date/time regexes, safeUrl) runs checkFragment — markdown can contain raw
 * HTML and is not inert (§14), and a client-declared type is
 * attacker-controlled, so unknown/enum/image types fail closed into the same
 * markup check rather than skipping it.
 */
export function typedEditProblems(edits, { safeUrl, checkFragment }) {
  const skips = [];
  for (const e of edits || []) {
    const key = e.key ?? e.pointer;
    const { value, type } = e;
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      skips.push({ key, reason: 'unsupported value type' });
      continue;
    }
    if (type === 'date') {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) skips.push({ key, reason: 'needs to be a date, like 2026-09-20' });
      continue;
    }
    if (type === 'time') {
      if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) skips.push({ key, reason: 'needs to be a time, like 14:30' });
      continue;
    }
    if (type === 'url') {
      // A scheme that could run code, as always; then words that are no address at all.
      if (typeof value !== 'string' || safeUrl(value) !== value) skips.push({ key, reason: 'not a safe URL' });
      else if (!isAddress(value)) skips.push({ key, reason: NOT_AN_ADDRESS });
      continue;
    }
    if (type === 'boolean') {
      if (typeof value !== 'boolean') skips.push({ key, reason: 'needs to be true or false' });
      continue;
    }
    if (type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) skips.push({ key, reason: 'needs to be a number' });
      continue;
    }
    // string / text / markdown / untyped / unrecognized: markup check.
    if (typeof value === 'string' && checkFragment(value)) {
      skips.push({ key, reason: 'value may not contain script markup' });
    }
  }
  return skips;
}

/**
 * Sibling names for /source/duplicate (§19: v1 "add an entry" = duplicate).
 * 'a/e.md' → ['a/e-copy.md', 'a/e-copy-2.md', … 'a/e-copy-10.md']; the caller
 * probes in order and takes the first free name. Capped so a pathological
 * directory can't turn one request into unbounded GETs.
 */
export function duplicateCandidates(file, max = 10) {
  const m = /^(.*?)(\.[^./]+)$/.exec(String(file || ''));
  if (!m) return [];
  const [, stem, ext] = m;
  const out = [`${stem}-copy${ext}`];
  for (let i = 2; out.length < max; i++) out.push(`${stem}-copy-${i}${ext}`);
  return out;
}
