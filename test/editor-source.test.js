/**
 * Source-mode editor logic (src/editor/source-fields.js) — the pure half of the
 * editor workstream: provenance scanning (§4.3/§8.1), grouping staged edits
 * into /source/commit bodies (§5), the publish-state machine (§11/§12), revert
 * construction, and the /healthz capability handshake (§13). Plus the sanitize
 * allowlists that must let data-kiln-source survive.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scanSourceRefs, groupSourceEdits, matchAppliedRefs, matchSkippedRefs,
  resolveBuildState, revertRequest, parseSourceCapabilities, saveSummary,
  friendlyRef, SOURCE_LOCKED_TIP, STILL_BUILDING_COPY,
} from '../src/editor/source-fields.js';
import { parseSourceRef } from '../src/adapters/pointer.js';
import { SANITIZE, CONTAINER_SANITIZE, BLOCK_SANITIZE } from '../src/editor/sanitize.js';

const REF_TITLE = 'src/content/events/service.md#/frontmatter/title';
const REF_DATE = 'src/content/events/service.md#/frontmatter/date?type=date';
const REF_VENUE = 'src/content/venues/hall.md#/frontmatter/name';

// ─── scanSourceRefs ──────────────────────────────────────────────────────────

test('scan: valid refs parse and dedupe by exact ref string', () => {
  const r = scanSourceRefs([
    { ref: REF_TITLE }, { ref: REF_VENUE }, { ref: REF_TITLE },   // title rendered twice
  ]);
  assert.equal(r.fields.length, 2);
  assert.equal(r.malformed.length, 0);
  assert.deepEqual(r.fields[0].indexes, [0, 2]);
  assert.equal(r.fields[0].parsed.path, 'src/content/events/service.md');
  assert.deepEqual(r.fields[0].parsed.pointer, ['frontmatter', 'title']);
});

test('scan: malformed refs are reported once per distinct value, with every element index (§8.1)', () => {
  const r = scanSourceRefs([
    { ref: '../../etc/passwd#/x' },        // traversal
    { ref: 'no-pointer.md' },              // no fragment
    { ref: '../../etc/passwd#/x' },        // same bad value again — one warn
    { ref: REF_TITLE },
  ]);
  assert.equal(r.fields.length, 1);
  assert.equal(r.malformed.length, 2);
  const traversal = r.malformed.find(m => m.ref === '../../etc/passwd#/x');
  assert.deepEqual(traversal.indexes, [0, 2]);   // both elements lockable, one warn
});

test('scan: element with BOTH data-cms and data-kiln-source is flagged (source wins, §4.3)', () => {
  const r = scanSourceRefs([
    { ref: REF_TITLE, cms: 'hero_title' },
    { ref: REF_VENUE },
  ]);
  assert.deepEqual(r.dual, [0]);
  // The ref itself still scans as an editable source field.
  assert.equal(r.fields.length, 2);
});

test('scan: type hint survives into the parsed ref', () => {
  const r = scanSourceRefs([{ ref: REF_DATE }]);
  assert.equal(r.fields[0].parsed.type, 'date');
});

// ─── groupSourceEdits ────────────────────────────────────────────────────────

const OPTS = { repo: 'owner/site', branch: 'main', adapter: 'astro' };

test('group: N edits across M files → one contract-shaped body per file, in first-seen order', () => {
  const pending = new Map([
    [REF_TITLE, { value: 'New title' }],
    [REF_VENUE, { value: 'City Hall' }],
    [REF_DATE, { value: '2026-09-20' }],
  ]);
  const groups = groupSourceEdits(pending, OPTS);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].file, 'src/content/events/service.md');
  assert.equal(groups[1].file, 'src/content/venues/hall.md');
  const body = groups[0].body;
  assert.equal(body.repo, 'owner/site');
  assert.equal(body.branch, 'main');
  assert.equal(body.adapter, 'astro');
  assert.equal(body.file, 'src/content/events/service.md');
  assert.equal(body.edits.length, 2);
  assert.deepEqual(body.edits[0], { pointer: '/frontmatter/title', value: 'New title', key: REF_TITLE });
  // refs[i] ↔ edits[i] stay aligned — applied/skipped matching depends on it.
  assert.deepEqual(groups[0].refs, [REF_TITLE, REF_DATE]);
  assert.deepEqual(groups[1].refs, [REF_VENUE]);
});

test('group: ?type= hint rides along as the edit type (worker validates §9)', () => {
  const groups = groupSourceEdits(new Map([[REF_DATE, { value: '2026-09-20' }]]), OPTS);
  assert.equal(groups[0].body.edits[0].type, 'date');
  assert.equal(groups[0].body.edits[0].pointer, '/frontmatter/date');   // hint stripped from the pointer
});

test('group: a staged type overrides the ref hint; untyped edits carry no type key', () => {
  const groups = groupSourceEdits(new Map([
    [REF_DATE, { value: 'x', type: 'string' }],
    [REF_TITLE, { value: 'y' }],
  ]), OPTS);
  assert.equal(groups[0].body.edits[0].type, 'string');
  assert.ok(!('type' in groups[0].body.edits[1]));
});

test('group: an unparseable ref never poisons the batch', () => {
  const groups = groupSourceEdits(new Map([
    ['../../evil#/x', { value: 'boom' }],
    [REF_TITLE, { value: 'ok' }],
  ]), OPTS);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].body.edits.length, 1);
});

// ─── applied/skipped matching ────────────────────────────────────────────────

test('applied refs match by echoed key, and by pointer as a fallback', () => {
  const [g] = groupSourceEdits(new Map([
    [REF_TITLE, { value: 'a' }], [REF_DATE, { value: 'b' }],
  ]), OPTS);
  assert.deepEqual(matchAppliedRefs(g, [REF_TITLE]), [REF_TITLE]);          // by key
  assert.deepEqual(matchAppliedRefs(g, ['/frontmatter/date']), [REF_DATE]); // by pointer
  assert.deepEqual(matchAppliedRefs(g, []), []);
  assert.deepEqual(matchAppliedRefs(g, undefined), []);
});

test('skipped refs map back to their reasons', () => {
  const [g] = groupSourceEdits(new Map([
    [REF_TITLE, { value: 'a' }], [REF_DATE, { value: 'b' }],
  ]), OPTS);
  const m = matchSkippedRefs(g, [
    { key: REF_TITLE, reason: 'pointer not found in source' },
    { key: '/frontmatter/date', reason: 'type mismatch' },     // pointer-keyed fallback
    { key: 'unrelated', reason: 'ignored' },
  ]);
  assert.equal(m.get(REF_TITLE), 'pointer not found in source');
  assert.equal(m.get(REF_DATE), 'type mismatch');
  assert.equal(m.size, 2);
});

// ─── publish-state machine (§11/§12) ─────────────────────────────────────────

test('state machine: commit-status success → published', () => {
  assert.equal(resolveBuildState({
    status: { state: 'success', total_count: 2 }, elapsedMs: 30000,
  }), 'published');
});

test('state machine: deployment failure → failed', () => {
  assert.equal(resolveBuildState({
    status: { state: 'pending', total_count: 0 },
    deployStatuses: [{ state: 'failure' }],
    elapsedMs: 60000,
  }), 'failed');
});

test('state machine: commit-status failure/error → failed', () => {
  assert.equal(resolveBuildState({ status: { state: 'failure', total_count: 1 } }), 'failed');
  assert.equal(resolveBuildState({ status: { state: 'error', total_count: 1 } }), 'failed');
});

test('state machine: empty combined status (total_count 0) is NOT a signal', () => {
  // GitHub idles these at state "pending" forever — must not read as building CI.
  assert.equal(resolveBuildState({
    status: { state: 'pending', total_count: 0 }, elapsedMs: 1000,
  }), 'building');
});

test('state machine: both silent past the cap → timeout', () => {
  assert.equal(resolveBuildState({
    status: { state: 'pending', total_count: 0 },
    deployStatuses: [],
    elapsedMs: 5 * 60 * 1000,
  }), 'timeout');
  assert.equal(resolveBuildState({ elapsedMs: 6 * 60 * 1000 }), 'timeout');
});

test('state machine: in-flight deployment states keep building', () => {
  for (const s of ['queued', 'pending', 'in_progress', 'inactive']) {
    assert.equal(resolveBuildState({ deployStatuses: [{ state: s }], elapsedMs: 1000 }), 'building', s);
  }
});

test('state machine: a failure outranks a success in the same tick', () => {
  assert.equal(resolveBuildState({
    status: { state: 'success', total_count: 1 },
    deployStatuses: [{ state: 'failure' }],
  }), 'failed');
});

test('state machine: newest deployment status wins over older entries', () => {
  assert.equal(resolveBuildState({
    deployStatuses: [{ state: 'success' }, { state: 'in_progress' }],
  }), 'published');
});

// ─── revert construction (§12) ───────────────────────────────────────────────

test('revert: built from a /source/commit response, targeting the parent sha', () => {
  const commitRes = {
    ok: true, file: 'src/content/events/service.md',
    commit: { sha: 'abc123', parent: 'def456' },
  };
  assert.deepEqual(revertRequest(commitRes, { repo: 'owner/site', branch: 'main' }), {
    repo: 'owner/site', branch: 'main', file: 'src/content/events/service.md', toSha: 'def456',
  });
});

test('revert: flattened { file, parent } works; missing parent/file → null', () => {
  assert.deepEqual(revertRequest({ file: 'f.md', parent: 'p1' }, { repo: 'o/s' }),
    { repo: 'o/s', file: 'f.md', toSha: 'p1' });
  assert.equal(revertRequest({ file: 'f.md', commit: { sha: 'x' } }, { repo: 'o/s' }), null);
  assert.equal(revertRequest({ commit: { parent: 'p' } }, { repo: 'o/s' }), null);
  assert.equal(revertRequest(null, { repo: 'o/s' }), null);
});

// ─── capability handshake (§13) ──────────────────────────────────────────────

test("healthz: old worker (plain 'ok', null, or JSON without modes) → read-only decision", () => {
  for (const body of [null, undefined, 'ok', {}, { version: '1' }, { modes: 'source' }]) {
    const caps = parseSourceCapabilities(body);
    assert.equal(caps.legacy, true, JSON.stringify(body));
    assert.equal(caps.source, false);
  }
  assert.ok(SOURCE_LOCKED_TIP.includes('worker needs an update'));
});

test('healthz: modes without source → capable worker, source off', () => {
  const caps = parseSourceCapabilities({ modes: ['html'], adapters: [] });
  assert.equal(caps.legacy, false);
  assert.equal(caps.source, false);
});

test('healthz: modes with source → editable, adapters surfaced', () => {
  const caps = parseSourceCapabilities({ modes: ['html', 'source'], adapters: ['astro'], version: 'x' });
  assert.equal(caps.source, true);
  assert.deepEqual(caps.adapters, ['astro']);
});

// ─── copy helpers (§10/§12) ──────────────────────────────────────────────────

test('save summary pluralizes the contract line', () => {
  assert.equal(saveSummary(3, 2), 'Saving 3 changes across 2 content files.');
  assert.equal(saveSummary(1, 1), 'Saving 1 change across 1 content file.');
});

test('friendly provenance: path → pointer, src/content/ and pointer root trimmed', () => {
  assert.equal(friendlyRef(parseSourceRef(REF_TITLE)), 'events/service.md → title');
  assert.equal(friendlyRef(parseSourceRef('data/site.yaml#/data/phone')), 'data/site.yaml → phone');
  assert.equal(friendlyRef(parseSourceRef('src/content/e.md#/frontmatter/tags/0')), 'e.md → tags → 0');
  assert.equal(friendlyRef(parseSourceRef('src/content/e.md#/body')), 'e.md → body');
  assert.equal(friendlyRef(null), '');
});

test('still-building copy matches the §12 contract', () => {
  assert.equal(STILL_BUILDING_COPY,
    'Still building. Your change is saved and will appear when the build finishes.');
});

// ─── sanitize allowlists (editor workstream item 10) ─────────────────────────

test('data-kiln-source survives every DOMPurify allowlist, beside data-kiln-src', () => {
  for (const cfg of [SANITIZE, CONTAINER_SANITIZE, BLOCK_SANITIZE]) {
    assert.ok(cfg.ALLOWED_ATTR.includes('data-kiln-source'), 'missing data-kiln-source');
    assert.ok(cfg.ALLOWED_ATTR.includes('data-kiln-src'), 'data-kiln-src must stay too');
  }
});
