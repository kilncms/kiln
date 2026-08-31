/**
 * Source-mode editor logic that needs no DOM — pure functions main.js wires up.
 *
 * Everything here is unit-testable in node: scanning provenance attributes,
 * grouping staged edits into /source/commit request bodies, the publish-state
 * machine over polled build signals (§11/§12), revert-request construction, and
 * the /healthz capability handshake (§13). Imports pointer.js ONLY — the yaml
 * machinery must never enter the editor bundle (SOURCE-MODE-IMPL.md).
 */

import { parseSourceRef } from '../adapters/pointer.js';

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
    const edit = { pointer: parsed.rawPointer, value: staged?.value, key: ref };
    const type = staged?.type ?? parsed.type;
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
