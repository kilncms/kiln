import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBoxEdit, draftRecord, readDraft } from '../src/editor/saved-edits.js';

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
