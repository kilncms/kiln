/**
 * Source-mode worker decision logic (worker/source.js) — the pure rules behind
 * POST /source/commit|revert|duplicate (SOURCE-MODE-IMPL "Worker endpoints").
 * The injected deps are the REAL worker/engine guards, so these tests exercise
 * the exact policy the endpoints enforce; only the GitHub fetch glue is out of
 * frame (that's the point of the pure-module split).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sourceModeRefusal, validateSourceRequest, refuseSourcePath, typedEditProblems,
  duplicateCandidates, SOURCE_EDITS_MAX, SOURCE_FILE_GONE,
} from '../worker/source.js';
import { isSensitivePath, pathInScope } from '../worker/index.js';
import { safeUrl } from '../src/engine.js';
import { checkFragment } from '../worker/sanitize-guard.js';

const deps = { isSensitivePath, pathInScope };
const typedDeps = { safeUrl, checkFragment };
const editor = (over = {}) => ({ name: 'Sam', email: 's@x.com', paths: [''], keys: [], mode: null, admin: false, ...over });
const admin = { name: 'admin', admin: true };
const edit = (over = {}) => ({ pointer: '/frontmatter/title', value: 'New', type: 'string', ...over });
const commitReq = (over = {}) => ({ adapter: 'astro', file: 'src/content/events/e.md', edits: [edit()], actor: editor(), ...over });

// ─── Rule 1: who may source-edit ─────────────────────────────────────────────

test('sourceModeRefusal: no actor → 401, review/suggest → 403, editor/admin pass', () => {
  assert.deepEqual(sourceModeRefusal(null), { status: 401, error: 'unauthorized' });
  assert.deepEqual(sourceModeRefusal(editor({ mode: 'review' })),
    { status: 403, error: 'review-mode: comment-only access' });
  assert.deepEqual(sourceModeRefusal(editor({ mode: 'suggest' })),
    { status: 403, error: 'suggest-mode: source edits can’t be proposed yet' });
  assert.equal(sourceModeRefusal(editor()), null);
  assert.equal(sourceModeRefusal(admin), null);
});

test('validateSourceRequest: mode refusals fire before anything else', () => {
  const v = validateSourceRequest(commitReq({ actor: editor({ mode: 'suggest' }), adapter: 'nope', file: '../x' }), deps);
  assert.equal(v.status, 403);
  assert.match(v.error, /^suggest-mode/);
  assert.equal(validateSourceRequest(commitReq({ actor: null }), deps).status, 401);
});

// ─── Rule 2: adapter + the path gauntlet ─────────────────────────────────────

test('validateSourceRequest: happy path resolves the adapter and normalizes edits', () => {
  const v = validateSourceRequest(commitReq(), deps);
  assert.equal(v.error, undefined);
  assert.equal(v.adapter.id, 'astro');
  assert.equal(v.file, 'src/content/events/e.md');
  assert.deepEqual(v.cleanEdits, [{ pointer: '/frontmatter/title', value: 'New', type: 'string', key: '/frontmatter/title' }]);
});

test('validateSourceRequest: a supplied edit key is kept for reporting', () => {
  const v = validateSourceRequest(commitReq({ edits: [edit({ key: 'title' })] }), deps);
  assert.equal(v.cleanEdits[0].key, 'title');
});

test('validateSourceRequest: unknown adapter → 400', () => {
  const v = validateSourceRequest(commitReq({ adapter: 'hugo' }), deps);
  assert.deepEqual(v, { status: 400, error: 'unknown adapter', detail: 'hugo' });
  assert.equal(validateSourceRequest(commitReq({ adapter: undefined }), deps).status, 400);
});

test('validateSourceRequest: traversal and malformed paths → 400 (attribute is attacker-controlled)', () => {
  for (const file of ['../secrets.md', 'src/../../x.md', '/etc/x.md', 'a\\b.md', '', 'https://evil.com/x.md']) {
    const v = validateSourceRequest(commitReq({ file }), deps);
    assert.deepEqual({ status: v.status, error: v.error }, { status: 400, error: 'bad file path' }, `should refuse: ${file}`);
  }
  // ./-prefixed is normalized, not refused.
  assert.equal(validateSourceRequest(commitReq({ file: './src/content/e.md' }), deps).file, 'src/content/e.md');
});

test('validateSourceRequest: worker sensitive paths → 403, admins included', () => {
  for (const actor of [editor(), admin]) {
    const v = validateSourceRequest(commitReq({ file: '.github/README.md', actor }), deps);
    assert.deepEqual({ status: v.status, error: v.error }, { status: 403, error: 'forbidden path for editor' });
  }
});

test('validateSourceRequest: adapter sensitivePaths refused by prefix', () => {
  const v = validateSourceRequest(commitReq({ file: '.kiln/notes.md' }), deps);
  assert.deepEqual({ status: v.status, error: v.error }, { status: 403, error: 'forbidden path for editor' });
});

test('validateSourceRequest: path scope honors the actor grants', () => {
  const scoped = editor({ paths: ['src/content'] });
  assert.equal(validateSourceRequest(commitReq({ actor: scoped }), deps).error, undefined);
  const out = validateSourceRequest(commitReq({ file: 'pages/about.md', actor: scoped }), deps);
  assert.deepEqual({ status: out.status, error: out.error }, { status: 403, error: 'outside your editing scope' });
  // Admins have no paths — whole repo (minus the denylists).
  assert.equal(validateSourceRequest(commitReq({ file: 'pages/about.md', actor: admin }), deps).error, undefined);
});

test('validateSourceRequest: only adapter-editable file types', () => {
  for (const file of ['index.html', 'astro.config.mjs.bak', 'data.json']) {
    assert.equal(validateSourceRequest(commitReq({ file }), deps).status, 400, `should refuse: ${file}`);
  }
  // The §8.4 canonical example: executable/template code. The worker's global
  // denylist catches it (403) before the adapter's canEdit ever gets asked.
  const ts = validateSourceRequest(commitReq({ file: 'src/lib/site.ts' }), deps);
  assert.deepEqual({ status: ts.status, error: ts.error }, { status: 403, error: 'forbidden path for editor' });
  // An .md name under an adapter-sensitive prefix passes canEdit, then trips
  // the prefix match.
  assert.equal(validateSourceRequest(commitReq({ file: 'src/content/config.ts.md' }), deps).status, 403);
  assert.equal(validateSourceRequest(commitReq({ file: 'src/content/e.mdx' }), deps).error, undefined);
  assert.equal(validateSourceRequest(commitReq({ file: 'notes/n.markdown' }), deps).error, undefined);
});

// ─── Rule 3: edit shape ──────────────────────────────────────────────────────

test('validateSourceRequest: edit-count cap 1..100', () => {
  for (const edits of [undefined, 'nope', [], Array.from({ length: SOURCE_EDITS_MAX + 1 }, () => edit())]) {
    const v = validateSourceRequest(commitReq({ edits }), deps);
    assert.deepEqual({ status: v.status, error: v.error }, { status: 400, error: 'bad edits' });
  }
  assert.equal(validateSourceRequest(commitReq({ edits: Array.from({ length: SOURCE_EDITS_MAX }, () => edit()) }), deps).error, undefined);
});

test('validateSourceRequest: every pointer must parse (RFC 6901)', () => {
  for (const pointer of ['frontmatter/title', '', '/bad~2escape', 42, undefined]) {
    const v = validateSourceRequest(commitReq({ edits: [edit(), { pointer, value: 'x' }] }), deps);
    assert.equal(v.status, 400, `should refuse pointer: ${String(pointer)}`);
    assert.equal(v.error, 'bad pointer');
  }
  assert.equal(validateSourceRequest(commitReq({ edits: [null] }), deps).error, 'bad pointer');
});

// ─── Rule 4: typed validation (per-edit, never fatal) ────────────────────────

test('typedEditProblems: date/time formats', () => {
  assert.deepEqual(typedEditProblems([edit({ type: 'date', value: '2026-09-20' })], typedDeps), []);
  for (const value of ['2026-9-20', 'tomorrow', '2026-09-20T10:00', 20260920]) {
    const skips = typedEditProblems([edit({ type: 'date', value })], typedDeps);
    assert.equal(skips.length, 1, `should skip date: ${value}`);
    assert.equal(skips[0].reason, 'needs to be a date, like 2026-09-20');
  }
  assert.deepEqual(typedEditProblems([edit({ type: 'time', value: '14:30' })], typedDeps), []);
  assert.deepEqual(typedEditProblems([edit({ type: 'time', value: '00:00' })], typedDeps), []);
  for (const value of ['24:00', '9:30', '14:3', '14:30:00']) {
    assert.equal(typedEditProblems([edit({ type: 'time', value })], typedDeps).length, 1, `should skip time: ${value}`);
  }
});

test('typedEditProblems: url must survive safeUrl unchanged', () => {
  for (const value of ['/events/', 'https://example.com/x', 'mailto:hi@x.com', '#top', '?q=1']) {
    assert.deepEqual(typedEditProblems([edit({ type: 'url', value })], typedDeps), [], `should pass url: ${value}`);
  }
  for (const value of ['javascript:alert(1)', 'JAVASCRIPT:x', 'java\tscript:x', 'data:text/html,x', 'vbscript:x']) {
    const skips = typedEditProblems([edit({ type: 'url', value })], typedDeps);
    assert.deepEqual(skips, [{ key: '/frontmatter/title', reason: 'not a safe URL' }], `should skip url: ${value}`);
  }
});

test('typedEditProblems: boolean and number are real scalars, not strings', () => {
  assert.deepEqual(typedEditProblems([edit({ type: 'boolean', value: true })], typedDeps), []);
  assert.deepEqual(typedEditProblems([edit({ type: 'boolean', value: false })], typedDeps), []);
  for (const value of ['true', 1, 'yes']) {
    assert.equal(typedEditProblems([edit({ type: 'boolean', value })], typedDeps)[0].reason, 'needs to be true or false');
  }
  assert.deepEqual(typedEditProblems([edit({ type: 'number', value: 3.14 })], typedDeps), []);
  for (const value of [NaN, Infinity, '5']) {
    assert.equal(typedEditProblems([edit({ type: 'number', value })], typedDeps)[0].reason, 'needs to be a number');
  }
});

test('typedEditProblems: script markup in string values is skipped (real checkFragment)', () => {
  for (const value of ['<script>alert(1)</script>', 'hi <img src=x onerror=alert(1)>', '<a href="javascript:x">go</a>', '<iframe src=//evil></iframe>']) {
    for (const type of ['string', 'text', 'markdown', undefined]) {
      const skips = typedEditProblems([edit({ type, value })], typedDeps);
      assert.deepEqual(skips, [{ key: '/frontmatter/title', reason: 'value may not contain script markup' }],
        `should skip ${type ?? 'untyped'}: ${value}`);
    }
  }
  // Benign markup and plain text pass — same policy as HTML-mode fragments.
  for (const value of ['Fall Festival', '**bold** _md_', '<b>hi</b> & <em>there</em>', 'a < b']) {
    assert.deepEqual(typedEditProblems([edit({ value })], typedDeps), [], `should pass: ${value}`);
  }
});

test('typedEditProblems: a client-declared type never dodges the markup check', () => {
  // `type` comes from an attacker-controllable attribute — enum/image/unknown
  // string values still run checkFragment (fail closed).
  for (const type of ['enum', 'image', 'wat']) {
    const skips = typedEditProblems([edit({ type, value: '<script>x</script>' })], typedDeps);
    assert.equal(skips.length, 1, `type ${type} must not bypass`);
    assert.equal(skips[0].reason, 'value may not contain script markup');
  }
});

test('typedEditProblems: non-scalar values are skipped, batch survives', () => {
  const edits = [
    edit({ key: 'ok' }),
    edit({ key: 'obj', value: { a: 1 } }),
    edit({ key: 'arr', value: [1] }),
    edit({ key: 'null', value: null }),
    edit({ key: 'undef', value: undefined }),
  ];
  const skips = typedEditProblems(edits, typedDeps);
  assert.deepEqual(skips.map(s => s.key), ['obj', 'arr', 'null', 'undef']);
  for (const s of skips) assert.equal(s.reason, 'unsupported value type');
});

// ─── Revert/duplicate path rules ─────────────────────────────────────────────

test('refuseSourcePath anyEditable: any adapter file or html page, denylists still apply', () => {
  assert.deepEqual(refuseSourcePath('src/content/e.md', editor(), deps, { anyEditable: true }), { file: 'src/content/e.md' });
  assert.deepEqual(refuseSourcePath('blog/post.html', editor(), deps, { anyEditable: true }), { file: 'blog/post.html' });
  assert.equal(refuseSourcePath('style.css', editor(), deps, { anyEditable: true }).status, 400);
  assert.equal(refuseSourcePath('.kiln/x.html', editor(), deps, { anyEditable: true }).status, 403);   // adapter union
  assert.equal(refuseSourcePath('.github/x.html', editor(), deps, { anyEditable: true }).status, 403); // worker denylist
  assert.equal(refuseSourcePath('a/../b.md', editor(), deps, { anyEditable: true }).status, 400);
  assert.equal(refuseSourcePath('pages/x.md', editor({ paths: ['blog'] }), deps, { anyEditable: true }).status, 403);
});

test('duplicateCandidates: -copy then -copy-N siblings, extension kept, capped', () => {
  const c = duplicateCandidates('src/content/events/e.md');
  assert.equal(c[0], 'src/content/events/e-copy.md');
  assert.equal(c[1], 'src/content/events/e-copy-2.md');
  assert.equal(c.length, 10);
  assert.equal(c[9], 'src/content/events/e-copy-10.md');
  assert.equal(duplicateCandidates('a/e.mdx')[0], 'a/e-copy.mdx');
  assert.equal(duplicateCandidates('a.b.md')[0], 'a.b-copy.md');
  assert.equal(duplicateCandidates('page.html')[0], 'page-copy.html');
  assert.deepEqual(duplicateCandidates('Makefile'), []);   // no extension → nothing to offer
  assert.equal(duplicateCandidates('x.md', 3).length, 3);
});

test('SOURCE_FILE_GONE matches the contract copy', () => {
  assert.equal(SOURCE_FILE_GONE, 'That content file no longer exists — the page may have been rebuilt since you loaded it. Reload.');
});
