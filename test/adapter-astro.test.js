import { test } from 'node:test';
import assert from 'node:assert/strict';
import astro from '../src/adapters/astro.js';
import { getAdapter, detectAll, generatorSignals } from '../src/adapters/index.js';

const ENTRY = `---
# schedule notes live here
title: Interfaith Worship Service
date: 2026-09-20
start: '18:00'
venue: "Big Bethel AME"
tags:
  - faith
  - memory
---

The service opens the week of remembrance.

Doors at **5:30pm**.
`;

test('spec test 1: one frontmatter edit, byte-identical elsewhere', () => {
  const r = astro.applyEdits(ENTRY, [{ pointer: '/frontmatter/title', value: 'Evening Worship' }], 'src/content/events/e.md');
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.applied, ['/frontmatter/title']);
  assert.equal(r.content, ENTRY.replace('Interfaith Worship Service', 'Evening Worship'));
});

test('spec test 2: comments and key order survive an edit', () => {
  const r = astro.applyEdits(ENTRY, [{ pointer: '/frontmatter/venue', value: 'Ebenezer Baptist' }], 'e.md');
  assert.ok(r.content.includes('# schedule notes live here'));
  assert.ok(r.content.includes('venue: "Ebenezer Baptist"'));
  const keys = r.content.match(/^(\w+):/gm);
  assert.deepEqual(keys, ['title:', 'date:', 'start:', 'venue:', 'tags:']);
});

test('spec test 4: bad pointer among good ones — good applies, bad in skipped', () => {
  const r = astro.applyEdits(ENTRY, [
    { pointer: '/frontmatter/date', value: '2026-09-21', type: 'date' },
    { pointer: '/frontmatter/ghost', value: 'x' },
    { pointer: '/attic/thing', value: 'x' },
  ], 'e.md');
  assert.deepEqual(r.applied, ['/frontmatter/date']);
  assert.equal(r.skipped.length, 2);
  const reasons = r.skipped.map(s => s.reason).sort().join(' | ');
  assert.match(reasons, /pointer not found/);
  assert.match(reasons, /unsupported pointer root/);
});

test('body edit replaces the markdown, keeps fences + final newline', () => {
  const r = astro.applyEdits(ENTRY, [{ pointer: '/body', value: '\nNew body text.' }], 'e.md');
  assert.deepEqual(r.applied, ['/body']);
  assert.ok(r.content.startsWith('---\n# schedule notes'));
  assert.ok(r.content.endsWith('New body text.\n'));
  assert.ok(!r.content.includes('Doors at'));
});

test('frontmatter + body edited together in one batch', () => {
  const r = astro.applyEdits(ENTRY, [
    { pointer: '/frontmatter/title', value: 'Both' },
    { pointer: '/body', value: 'Short.' },
  ], 'e.md');
  assert.deepEqual(r.applied.sort(), ['/body', '/frontmatter/title']);
  assert.ok(r.content.includes('title: Both'));
  assert.ok(r.content.endsWith('Short.\n'));
});

test('MDX: frontmatter editable, body refused as code (§8.4)', () => {
  const r = astro.applyEdits(ENTRY, [
    { pointer: '/frontmatter/title', value: 'Fine' },
    { pointer: '/body', value: 'nope' },
  ], 'src/content/e.mdx');
  assert.deepEqual(r.applied, ['/frontmatter/title']);
  assert.match(r.skipped[0].reason, /MDX body is code/);
});

test('non-content file types are refused wholesale', () => {
  const r = astro.applyEdits(ENTRY, [{ pointer: '/frontmatter/title', value: 'x' }], 'src/lib/site.ts');
  assert.deepEqual(r.applied, []);
  assert.match(r.skipped[0].reason, /not editable/);
  assert.equal(r.content, ENTRY);
});

test('spec test astro-broken: invalid frontmatter YAML refuses to write', () => {
  const broken = '---\ntitle: [unclosed\n---\nBody.\n';
  const r = astro.applyEdits(broken, [{ pointer: '/frontmatter/title', value: 'x' }], 'e.md');
  assert.deepEqual(r.applied, []);
  assert.match(r.skipped[0].reason, /not valid YAML/);
  assert.equal(r.content, broken);
  assert.match(astro.validate(broken, 'e.md'), /not valid YAML/);
  assert.equal(astro.validate(ENTRY, 'e.md'), null);
});

test('file without frontmatter: fm edits skip, body is the whole file', () => {
  const plain = 'Just markdown.\n';
  const r = astro.applyEdits(plain, [
    { pointer: '/frontmatter/title', value: 'x' },
    { pointer: '/body', value: 'Replaced.' },
  ], 'e.md');
  assert.deepEqual(r.applied, ['/body']);
  assert.match(r.skipped[0].reason, /no frontmatter/);
  assert.equal(r.content, 'Replaced.\n');
});

test('read() prefills frontmatter values and the body', () => {
  const parsed = astro.parse(ENTRY, 'e.md');
  assert.equal(astro.read(parsed, '/frontmatter/title'), 'Interfaith Worship Service');
  assert.equal(astro.read(parsed, '/frontmatter/tags/1'), 'memory');
  assert.ok(astro.read(parsed, '/body').includes('Doors at'));
  assert.equal(astro.read(parsed, '/frontmatter/ghost'), undefined);
});

test('detect() scores an Astro listing high and a plain-HTML listing zero', () => {
  const high = astro.detect(['astro.config.mjs', 'src/content/events/a.md', 'src/pages/index.astro', 'package.json']);
  assert.ok(high >= 0.8, String(high));
  assert.equal(astro.detect(['index.html', 'about.html', 'assets/kiln.js']), 0);
});

test('registry: getAdapter + detectAll + generator signals (§7.3 raw material)', () => {
  assert.equal(getAdapter('astro').id, 'astro');
  assert.equal(getAdapter('nope'), null);
  const d = detectAll(['astro.config.mjs', 'src/pages/index.astro']);
  assert.equal(d[0].id, 'astro');
  const sig = generatorSignals(['astro.config.mjs', 'dist/index.html', 'src/pages/index.astro']);
  assert.equal(sig.detected[0].id, 'astro');
  assert.equal(sig.builtHtml, true);
});

test('CRLF frontmatter fences are handled', () => {
  const crlf = '---\r\ntitle: Hello\r\n---\r\nBody.\r\n';
  const r = astro.applyEdits(crlf, [{ pointer: '/frontmatter/title', value: 'Hi there' }], 'e.md');
  assert.deepEqual(r.applied, ['/frontmatter/title']);
  assert.ok(r.content.includes('title: Hi there\r\n'));
  assert.ok(r.content.endsWith('Body.\r\n'));
});
