/**
 * A block's buttons (move, duplicate, tags, remove) when the block is a link.
 *
 * A card is often one <a> around a picture and a title. Its buttons sit inside
 * that link, and their handlers only stopped the click on its way up the page,
 * which does not stop the browser from following the link: pressing "Move
 * down" on a product card also opened the product's page in a new tab. The
 * browser check is in scripts/ui-check.mjs; this holds the line that does it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = readFileSync(path.join(ROOT, 'src', 'editor', 'main.js'), 'utf8');
const controls = main.slice(main.indexOf('function attachItemControls('), main.indexOf('function closeItemControls('));

test('block controls: a click anywhere in a block\'s control bar never follows the link the block is', () => {
  // in the capture phase, so that it runs before each button's own handler stops the click
  assert.match(controls, /ctl\.addEventListener\('click', \(e\) => e\.preventDefault\(\), true\);/);
  // and it is set up before the buttons are given their handlers
  assert.ok(controls.indexOf("ctl.addEventListener('click'") < controls.indexOf('up.onclick'), 'set before the buttons');
});

test('block controls: every button of the bar is inside it', () => {
  // the "more" button of a phone is put into the same bar, so the one listener covers it
  assert.match(controls, /ctl\.prepend\(more\);/);
  // and the bar is what is put into the block (or into a table row's own cell)
  assert.match(controls, /item\.appendChild\(ctl\);/);
  assert.match(controls, /cell\.appendChild\(ctl\);/);
});

test('block controls: removing a block asks nothing in the browser\'s own box, and offers its own way back', () => {
  // the box read "Remove this block? (You can still Cancel by leaving without publishing.)"
  assert.equal(/confirm\([^)]*Remove this block/.test(main), false, 'the browser\'s box is still asked');
  assert.equal(/leaving without publishing/.test(main), false);
  const del = controls.slice(controls.indexOf('del.onclick'), controls.indexOf('// Phones: five thumb-sized buttons'));
  assert.equal(/\bconfirm\(|\bprompt\(|\balert\(/.test(del), false);
  // gone at once, kept aside for Undo, staged, and said with a button: in that order
  const order = ['item.remove();', 'keepAside(container, item);', 'stageContainer(container, key);', "setStatus('Removed.', 'saved', { hold: 10000, tag: 'removed', action: { label: 'Undo'"];
  let at = -1;
  for (const step of order) { const i = del.indexOf(step); assert.ok(i > at, step); at = i; }
  assert.match(del, /run: undoEdit \}/);
  // a block taken off with its buttons open comes back with them folded away
  assert.ok(del.indexOf('closeItemControls();') !== -1 && del.indexOf('closeItemControls();') < del.indexOf('item.remove();'));
});

test('block controls: "Removed. Undo" is put away once another change is made, so its button never undoes the wrong thing', () => {
  const push = main.slice(main.indexOf('function pushUndoEntry('), main.indexOf('/** A publish, a draft, a schedule'));
  assert.match(push, /if \(line\?\.dataset\.tag === 'removed'\) line\.hidden = true;/);
  assert.ok(push.indexOf("dataset.tag === 'removed'") < push.indexOf('editHistory.undo.push(entry)'));
  // the line says how long it stays, and any other line clears the mark
  const status = main.slice(main.indexOf('function setStatus('), main.indexOf('// ─── Crash-proof pending edits'));
  assert.match(status, /if \(opts\?\.tag\) el\.dataset\.tag = opts\.tag; else delete el\.dataset\.tag;/);
  assert.match(status, /opts\?\.hold \|\| \(isMobileEditor\(\) \? 4000 : 6000\)/);
});
