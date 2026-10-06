/**
 * A list that is written again keeps the blocks it had (src/editor/keep-blocks.js).
 *
 * Undo used to write a list's earlier HTML back with innerHTML. Every block
 * became a new element the site's own scripts had never seen, and on a site
 * whose blocks fade in on scroll the whole list stayed invisible. These tests
 * hold the plan (which element each block of the list is) and what a new
 * element is given; the browser checks are in scripts/ui-check.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { planBlocks, carriedClass } from '../src/editor/keep-blocks.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = readFileSync(path.join(ROOT, 'src', 'editor', 'main.js'), 'utf8');

const live = (at) => ({ from: 'live', at });
const kept = (at) => ({ from: 'kept', at });
const fresh = (like = null) => ({ from: 'new', like });

test('keep-blocks: Undo of a removed block keeps the blocks on the page and puts back the one that was taken off', () => {
  // the list held A B C; B was removed with ✕ and kept aside; Undo asks for A B C again
  assert.deepEqual(planBlocks(['A', 'B', 'C'], ['A', 'C'], ['B']), [live(0), kept(0), live(1)]);
  // and Redo takes B off again without touching A and C
  assert.deepEqual(planBlocks(['A', 'C'], ['A', 'B', 'C'], []), [live(0), live(2)]);
});

test('keep-blocks: Undo and Redo of an added block', () => {
  // "+ Add block" copied C; Undo: the three that were there stay, the copy leaves
  assert.deepEqual(planBlocks(['A', 'B', 'C'], ['A', 'B', 'C', 'C'], []), [live(0), live(1), live(2)]);
  // Redo: the copy that left is the one that comes back
  assert.deepEqual(planBlocks(['A', 'B', 'C', 'C'], ['A', 'B', 'C'], ['C']), [live(0), live(1), live(2), kept(0)]);
});

test('keep-blocks: Undo and Redo of a duplicated block keep the original where it is', () => {
  // B was duplicated: A B B C. Undo: the first B stays, the second leaves
  assert.deepEqual(planBlocks(['A', 'B', 'C'], ['A', 'B', 'B', 'C'], []), [live(0), live(1), live(3)]);
  assert.deepEqual(planBlocks(['A', 'B', 'B', 'C'], ['A', 'B', 'C'], ['B']), [live(0), live(1), kept(0), live(2)]);
});

test('keep-blocks: a reorder moves the blocks that are there, in both directions', () => {
  assert.deepEqual(planBlocks(['A', 'C', 'B'], ['A', 'B', 'C'], []), [live(0), live(2), live(1)]);
  assert.deepEqual(planBlocks(['A', 'B', 'C'], ['A', 'C', 'B'], []), [live(0), live(2), live(1)]);
  // nothing is made new, and nothing is taken from the blocks kept aside
  for (const p of planBlocks(['C', 'B', 'A'], ['A', 'B', 'C'], ['A', 'B', 'C'])) assert.equal(p.from, 'live');
});

test('keep-blocks: a block whose words changed is new, and stands in for the one it replaces', () => {
  // Undo of an edit to B: the old words are not on the page, so that block is written, in B's place
  assert.deepEqual(planBlocks(['A', 'B', 'C'], ['A', 'B edited', 'C'], []), [live(0), fresh(1), live(2)]);
  // Redo: the edited block was kept aside when Undo replaced it, and is the one that comes back
  assert.deepEqual(planBlocks(['A', 'B edited', 'C'], ['A', 'B', 'C'], ['B edited']), [live(0), kept(0), live(2)]);
});

test('keep-blocks: a block that is on the page nowhere and kept nowhere is new, with nothing to stand in for', () => {
  // an earlier version from History had a fourth block
  assert.deepEqual(planBlocks(['A', 'B', 'C', 'D'], ['A', 'B', 'C'], []), [live(0), live(1), live(2), fresh(null)]);
  // an empty page of the list: everything is new
  assert.deepEqual(planBlocks(['A', 'B'], [], []), [fresh(null), fresh(null)]);
  // and a list emptied: nothing is asked for
  assert.deepEqual(planBlocks([], ['A', 'B'], ['C']), []);
});

test('keep-blocks: of several blocks kept aside that read the same, the one taken off last comes back first', () => {
  assert.deepEqual(planBlocks(['A', 'B'], ['A'], ['B', 'X', 'B']), [live(0), kept(2)]);
  assert.deepEqual(planBlocks(['B', 'B'], [], ['B', 'X', 'B']), [kept(2), kept(0)]);
});

test('keep-blocks: a block that could not be read is never matched', () => {
  assert.deepEqual(planBlocks([null, 'B'], [null, 'B'], [null]), [fresh(0), live(1)]);
});

test('keep-blocks: each element is used once', () => {
  const plan = planBlocks(['A', 'A', 'A'], ['A'], ['A']);
  assert.deepEqual(plan, [live(0), kept(0), fresh(null)]);
});

test('keep-blocks: a new element takes the classes the site\'s scripts gave the one it stands in for', () => {
  // the case that blanked the list: the earlier HTML has no "is-inview", the block on the page has
  assert.equal(carriedClass('fact-line reveal', 'fact-line reveal kiln-repeat-item is-inview'), 'fact-line reveal is-inview');
  // nothing to take
  assert.equal(carriedClass('fact-line reveal is-inview', 'fact-line reveal is-inview kiln-repeat-item'), null);
  assert.equal(carriedClass('card', ''), null);
  assert.equal(carriedClass(null, null), null);
  // the editor's own classes are never carried into a block
  assert.equal(carriedClass('card', 'card kiln-field kiln-modified kiln-flash'), null);
  // a block of another kind is left as it was written
  assert.equal(carriedClass('card featured', 'card is-inview'), null);
  // an element with no class of its own takes what was added to the other
  assert.equal(carriedClass('', 'is-inview'), 'is-inview');
});

test('keep-blocks: a new block between two neighbours takes only what both were given', () => {
  assert.equal(carriedClass('slide reveal', 'slide reveal is-inview active', 'slide reveal is-inview'), 'slide reveal is-inview');
  assert.equal(carriedClass('slide', 'slide active', 'slide'), null);
  // one neighbour of another kind: nothing is taken
  assert.equal(carriedClass('slide', 'slide is-inview', 'banner is-inview'), null);
});

test('keep-blocks: the editor writes a list\'s HTML through writeBlocks, never with innerHTML', () => {
  // every place that puts a list's HTML on the page: Undo, Redo, Drop, History's preview, a draft, the saved copy, the demo's own
  assert.equal(/\b(rep|cont|container)\.innerHTML\s*=/.test(main), false, 'a list is written with innerHTML');
  const apply = main.slice(main.indexOf('function applyKeyDom('), main.indexOf('function applyUndoStep('));
  assert.match(apply, /writeBlocks\(rep, html, tidyBlocks\)/);
  const demo = main.slice(main.indexOf('function applySandboxEdits('), main.indexOf('function restoreSandboxPage('));
  assert.match(demo, /writeBlocks\(el, v\.html, tidyBlocks\)/);
  // the ✕ on a block keeps the block, so that Undo puts the same one back
  assert.match(main, /item\.remove\(\);\s*\n\s*keepAside\(container, item\)/);
  // a field keeps one click handler however often its list is written, and is still marked as editable each time
  const decorate = main.slice(main.indexOf('function decorateField('), main.indexOf('function fieldHint('));
  assert.match(decorate, /if \(decorated\.has\(el\)\) return;\s*\n\s*decorated\.add\(el\);\s*\n\s*el\.addEventListener\('click'/);
  assert.ok(decorate.indexOf("el.classList.add('kiln-field');") < decorate.indexOf('if (decorated.has(el)) return;'), 'marked before the guard');
  // the handler reads the field's name when it is pressed: a part un-made and made editable again under another name works, and an un-made one is left alone
  assert.match(decorate, /const key = el\.getAttribute\('data-cms'\);\s*\n\s*if \(!key\) return;/);
});
