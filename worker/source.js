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
    cleanEdits.push({ pointer: e.pointer, value: e.value, type: e.type, key: e.key ?? e.pointer });
  }
  return { adapter, file: p.file, cleanEdits };
}

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
      if (typeof value !== 'string' || safeUrl(value) !== value) skips.push({ key, reason: 'not a safe URL' });
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
