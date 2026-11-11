import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openBoxEdit, openListEdit, draftRecord, readDraft } from '../src/editor/saved-edits.js';

test('words typed in a box still open are in the saved copy, and offered back', () => {
  const pending = new Map();
  const kept = draftRecord(openBoxEdit(pending, 'hero_headline', 'Kind of a big dill. Hello', 'Kind of a big dill.'), new Map(), 1000);
  assert.ok(kept, 'the old saved copy left the open box out: nothing was kept');
  assert.equal(kept.edits.hero_headline.html, 'Kind of a big dill. Hello');
  const back = readDraft(kept, { now: 2000 });
  assert.ok(back);
  assert.equal(pending.size, 0, 'the staged edits themselves are not changed');
});

test('a box opened and not changed adds nothing', () => {
  const pending = new Map();
  assert.equal(openBoxEdit(pending, 'k', 'Same', 'Same'), pending);
  assert.equal(draftRecord(openBoxEdit(pending, 'k', 'Same', 'Same'), new Map(), 1), null);
});

test('typing over an edit staged earlier keeps its other parts', () => {
  const pending = new Map([['k', { html: 'One', attrs: { href: '/a' } }], ['j', { html: 'Other' }]]);
  const out = openBoxEdit(pending, 'k', 'One more', 'Base');
  assert.deepEqual(out.get('k'), { html: 'One more', attrs: { href: '/a' } });
  assert.deepEqual(out.get('j'), { html: 'Other' });
  assert.deepEqual(pending.get('k'), { html: 'One', attrs: { href: '/a' } });
});

test('words typed in a box inside a list are kept as the whole list, and offered back', () => {
  const pending = new Map([['hero_headline', { html: 'Hi' }]]);
  const list = '<article><h3 data-cms="name">Dill pickles, now</h3></article>';
  const kept = draftRecord(openListEdit(pending, 'products', { now: 'Dill pickles, now', before: 'Dill pickles', listHtml: list }), new Map(), 1000);
  assert.ok(kept, 'nothing was kept for a box inside a list');
  assert.equal(kept.edits.products.html, list);
  assert.equal(kept.edits.hero_headline.html, 'Hi');
  assert.ok(readDraft(kept, { now: 2000 }));
  assert.equal(pending.has('products'), false, 'the staged edits themselves are not changed');
});

test('a box in a list opened and not changed, or a list that could not be made safely, adds nothing', () => {
  const pending = new Map();
  assert.equal(openListEdit(pending, 'products', { now: 'Same', before: 'Same', listHtml: '<p>x</p>' }), pending);
  assert.equal(openListEdit(pending, 'products', { now: 'New', before: 'Old', listHtml: null }), pending);
});

test('the editor keeps an open box inside a list too', () => {
  const src = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function withOpenBox('), src.indexOf('let typingSaveTimer'));
  assert.doesNotMatch(fn, /closest\('\[data-cms-repeat\]'\) \|\|/);
  assert.match(fn, /openListEdit\(/);
});
