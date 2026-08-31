/**
 * Fixture integration tests for source mode (SOURCE-MODE-SPEC §17.1).
 *
 * These drive the adapter + registry + pointer layers against real file trees
 * under test/fixtures/ — the way the worker and editor will use them — rather
 * than inline strings. Unit-level coverage of the same layers lives in
 * test/yaml-splice.test.js and test/adapter-astro.test.js; this file covers
 * the §17.1 items that need files on disk: full-file byte fidelity, page-level
 * ref scanning + group-by-file, mixed html/source repos, and traversal refs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import astro from '../src/adapters/astro.js';
import { getAdapter, detectAll, generatorSignals } from '../src/adapters/index.js';
import { detectGenerators } from '../src/adapters/detect.js';
import { parseSourceRef, formatPointer, SOURCE_ATTR } from '../src/adapters/pointer.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (...p) => readFileSync(path.join(FIX, ...p), 'utf8');
const readRepo = (fixture, repoPath) => readFileSync(path.join(FIX, fixture, ...repoPath.split('/')), 'utf8');

/** Fixture-relative file listing, forward slashes — what detect() expects. */
function walk(fixture) {
  const root = path.join(FIX, fixture);
  const out = [];
  (function go(dir, rel) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) go(path.join(dir, e.name), r);
      else out.push(r);
    }
  })(root, '');
  return out;
}

/** Pull every provenance ref off a page, the way the editor scans the DOM. */
function refsIn(html) {
  return [...html.matchAll(new RegExp(`${SOURCE_ATTR}="([^"]*)"`, 'g'))].map(m => m[1]);
}

// ── §17.1 test 1: one-field edit, byte-identical elsewhere ───────────────────

test('fixture astro-min: one frontmatter edit changes only that value (full-file compare)', () => {
  const src = readRepo('astro-min', 'src/content/events/one.md');
  const r = astro.applyEdits(src, [{ pointer: '/frontmatter/title', value: 'Evening Worship' }],
    'src/content/events/one.md');
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.applied, ['/frontmatter/title']);
  assert.equal(r.content, src.replace('Interfaith Worship Service', 'Evening Worship'));
});

// ── §17.1 test 2 / §8.3: comments, key order, quote styles survive ───────────

test('fixture astro-comments: comments, blank lines and quoting survive an edit byte-for-byte', () => {
  const file = 'src/content/events/annotated.md';
  const src = readRepo('astro-comments', file);
  const r = astro.applyEdits(src, [
    { pointer: '/frontmatter/title', value: 'Poetry & Praise Night' },          // plain, trailing comment on its line
    { pointer: '/frontmatter/venue', value: 'King Center Archives' },           // double-quoted original
  ], file);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.applied.sort(), ['/frontmatter/title', '/frontmatter/venue']);
  const expected = src
    .replace('Youth Poetry Night', 'Poetry & Praise Night')
    .replace('"Auburn Avenue Research Library"', '"King Center Archives"');
  assert.equal(r.content, expected);
  // Spell out what the byte-compare guarantees, so a fixture edit can't quietly weaken it:
  assert.ok(r.content.includes('# Schedule notes — this comment must survive every edit.'));
  assert.ok(r.content.includes('# Confirmed with the venue on 2026-08-14.'));
  assert.ok(r.content.includes('title: Poetry & Praise Night   # the public name, shown on the homepage'));
  assert.ok(r.content.includes("start: '19:30'"), 'untouched single-quoted value keeps its quotes');
  assert.ok(r.content.includes("host: 'Ms. Jordan'"));
  assert.deepEqual(r.content.match(/^(\w+):/gm), ['title:', 'date:', 'start:', 'venue:', 'host:', 'featured:']);
  assert.equal(astro.validate(r.content, file), null);
});

// ── §17.1 test 3: two fields in two files from one page ──────────────────────

test('fixture astro-min: page refs group by file; two files edited independently and correctly', () => {
  const page = read('astro-min', 'src/pages/index.astro');
  const refs = refsIn(page);
  assert.ok(refs.length >= 8, 'page should carry the full set of provenance refs');
  for (const ref of refs) assert.ok(parseSourceRef(ref), `ref must parse: ${ref}`);

  // Stage two edits from the page — one field in each of two files — then group
  // by FILE the way the editor's publish contract does (one commit per file).
  const staged = [
    { ref: 'src/content/events/one.md#/frontmatter/title', value: 'Evening Worship' },
    { ref: 'src/content/events/two.md#/frontmatter/venue', value: 'Sweet Auburn' },
  ];
  for (const s of staged) assert.ok(refs.includes(s.ref), `page must reference ${s.ref}`);

  const byFile = new Map();
  for (const s of staged) {
    const parsed = parseSourceRef(s.ref);
    const edits = byFile.get(parsed.path) || [];
    edits.push({ pointer: formatPointer(parsed.pointer), value: s.value, type: parsed.type });
    byFile.set(parsed.path, edits);
  }
  assert.equal(byFile.size, 2, 'two files → two independent commits');

  const outputs = new Map();
  for (const [file, edits] of byFile) {
    const src = readRepo('astro-min', file);
    const r = astro.applyEdits(src, edits, file);
    assert.deepEqual(r.skipped, [], file);
    assert.equal(r.applied.length, 1, file);
    outputs.set(file, { src, content: r.content });
  }
  const one = outputs.get('src/content/events/one.md');
  assert.equal(one.content, one.src.replace('Interfaith Worship Service', 'Evening Worship'));
  const two = outputs.get('src/content/events/two.md');
  assert.equal(two.content, two.src.replace('Downtown Atlanta', 'Sweet Auburn'));
  // The third entry was never staged, so it is never touched at all.
  assert.ok(!byFile.has('src/content/events/three.md'));
});

// ── §17.1 test 4: bad pointer among good ones, driven from the page ──────────

test('fixture astro-min: a page ref to a missing key skips; the good edit in the same file applies', () => {
  const page = read('astro-min', 'src/pages/index.astro');
  const refs = refsIn(page).map(parseSourceRef);
  const three = refs.filter(r => r && r.path === 'src/content/events/three.md');
  assert.equal(three.length, 2, 'fixture page stages one good and one bad ref for three.md');

  const src = readRepo('astro-min', 'src/content/events/three.md');
  const r = astro.applyEdits(src, three.map(p => ({
    pointer: formatPointer(p.pointer),
    value: p.pointer.includes('ghost') ? 'x' : 'Dinner and Stories',
  })), 'src/content/events/three.md');
  assert.deepEqual(r.applied, ['/frontmatter/title']);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].key, '/frontmatter/ghost');
  assert.match(r.skipped[0].reason, /pointer not found/);
  assert.equal(r.content, src.replace('Community Remembrance Dinner', 'Dinner and Stories'));
});

// ── typed refs off the page carry their ?type= hint through parsing ──────────

test('fixture astro-min: ?type= hints on page refs parse and validate at apply time', () => {
  const page = read('astro-min', 'src/pages/index.astro');
  const timed = refsIn(page).map(parseSourceRef).find(r => r && r.type === 'time');
  assert.ok(timed, 'page carries a ?type=time ref');
  assert.equal(timed.path, 'src/content/events/one.md');
  const src = readRepo('astro-min', timed.path);
  const good = astro.applyEdits(src, [{ pointer: formatPointer(timed.pointer), value: '19:15', type: timed.type }], timed.path);
  assert.deepEqual(good.applied, [formatPointer(timed.pointer)]);
  assert.equal(good.content, src.replace("'18:00'", '19:15'));
});

// ── fixture astro-broken: a bad parse never writes a byte ────────────────────

test('fixture astro-broken: invalid frontmatter refuses every edit and never rewrites the file', () => {
  const file = 'src/content/events/broken.md';
  const src = readRepo('astro-broken', file);
  const r = astro.applyEdits(src, [
    { pointer: '/frontmatter/title', value: 'x' },
    { pointer: '/frontmatter/date', value: '2026-09-25', type: 'date' },
  ], file);
  assert.deepEqual(r.applied, []);
  assert.equal(r.content, src, 'content must be returned untouched');
  assert.equal(r.skipped.length, 2);
  for (const s of r.skipped) assert.match(s.reason, /not valid YAML/);
  assert.match(astro.validate(src, file), /not valid YAML/);
});

// ── §17.1 test 8 material: mixed repo — generator signals + html-mode page ───

test('fixture mixed: generator + committed output detected, hand-written page stays an html-mode target', () => {
  const files = walk('mixed');
  const sig = generatorSignals(files);
  assert.equal(sig.detected[0]?.id, 'astro', JSON.stringify(sig.detected));
  assert.equal(sig.builtHtml, true, 'dist/index.html must trip the committed-output signal');
  assert.equal(sig.rootHtml, true, 'about.html at the root is a real hand-written page');
  assert.equal(detectGenerators(files)[0]?.id, 'astro');

  // about.html is annotated with data-cms only — a valid, ordinary html-mode target.
  const about = read('mixed', 'about.html');
  assert.match(about, /data-cms="/);
  assert.ok(!about.includes(SOURCE_ATTR), 'hand-written page carries no provenance refs');

  // The generated page's provenance refs parse and point at a real content file.
  const gen = refsIn(read('mixed', 'dist', 'index.html'));
  assert.equal(gen.length, 2);
  for (const ref of gen) {
    const parsed = parseSourceRef(ref);
    assert.ok(parsed, ref);
    assert.equal(parsed.path, 'src/content/notes/welcome.md');
    assert.ok(readRepo('mixed', parsed.path).length > 0);
  }
});

// ── traversal fixture: hostile refs are rejected before anything else runs ───

test('fixture traversal: every hostile ref on the page is rejected by parseSourceRef', () => {
  const refs = refsIn(read('traversal', 'page.html'));
  assert.equal(refs.length, 4, 'fixture carries four attack shapes');
  for (const ref of refs) assert.equal(parseSourceRef(ref), null, `must reject: ${ref}`);
});

// ── detection over the real fixture trees (§7.1) ─────────────────────────────

test('fixture astro-min: registry + standalone detection score the tree as Astro, high confidence', () => {
  const files = walk('astro-min');
  const viaRegistry = detectAll(files);
  assert.equal(viaRegistry[0]?.id, 'astro');
  assert.ok(viaRegistry[0].confidence >= 0.8, String(viaRegistry[0].confidence));
  assert.ok(getAdapter('astro').detect(files) >= 0.8);
  const standalone = detectGenerators(files);   // the yaml-free path the CLI/editor use
  assert.equal(standalone[0]?.id, 'astro');
  const sig = generatorSignals(files);
  assert.equal(sig.builtHtml, false, 'astro-min commits no build output');
});
