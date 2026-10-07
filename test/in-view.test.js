/**
 * Undo keeps the person where the thing comes back (src/editor/in-view.js,
 * and where main.js uses it).
 *
 * Undo after removing a block of a long list scrolled to the middle of the
 * whole list, three screens from the block that had just come back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { whereTo } from '../src/editor/in-view.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = readFileSync(path.join(ROOT, 'src', 'editor', 'main.js'), 'utf8');

test('in view: a part that is already in front of the person does not move the page', () => {
  // a card that came back in the middle of a phone's screen
  assert.equal(whereTo({ top: 300, bottom: 560 }, 844), 'stay');
  // the whole of a 5,000 px list, of which the person is looking at the part where the card came back
  assert.equal(whereTo({ top: -1200, bottom: 3800 }, 844), 'stay');
  // a heading at the very top
  assert.equal(whereTo({ top: 0, bottom: 80 }, 844), 'stay');
});

test('in view: a part cut off at an edge is nudged in, and one that is out of sight is brought to the screen', () => {
  assert.equal(whereTo({ top: 700, bottom: 960 }, 844), 'nearest');
  assert.equal(whereTo({ top: -100, bottom: 160 }, 844), 'nearest');
  assert.equal(whereTo({ top: 2000, bottom: 2260 }, 844), 'center');
  assert.equal(whereTo({ top: -900, bottom: -640 }, 844), 'center');
  // a list that begins far below: show where it begins, not its middle
  assert.equal(whereTo({ top: 3000, bottom: 9000 }, 844), 'start');
  // only a sliver of a long list at the bottom edge is not "in front of the person"
  assert.equal(whereTo({ top: 800, bottom: 6000 }, 844), 'start');
});

test('in view: what the editor\'s own buttons cover does not count as seen', () => {
  // behind Undo, Redo and Publish along the bottom of a phone
  assert.equal(whereTo({ top: 720, bottom: 840 }, 844, { bottom: 140 }), 'center');
  assert.equal(whereTo({ top: 600, bottom: 760 }, 844, { bottom: 140 }), 'center', 'half under the buttons: the edge of the screen would not show it');
  assert.equal(whereTo({ top: 560, bottom: 700 }, 844, { bottom: 140 }), 'stay');
  // behind the line of words at the top
  assert.equal(whereTo({ top: 0, bottom: 50 }, 844, { top: 56 }), 'center');
});

test('in view: Undo and Redo show the block that came back, and move the page only as far as that takes', () => {
  const show = main.slice(main.indexOf('function showChanged('), main.indexOf('function undoEdit('));
  assert.match(show, /const how = whereTo\(/);
  assert.match(show, /if \(how !== 'stay'\) el\.scrollIntoView\(\{ behavior: 'smooth', block: how \}\);/);
  const undo = main.slice(main.indexOf('function undoEdit('), main.indexOf('function updateUndoUi('));
  assert.equal((undo.match(/showChanged\(/g) || []).length, 2, 'Undo and Redo');
  assert.equal(/block: 'center'/.test(undo), false, 'neither sends the page to the middle of what changed');
  // for a list, what is shown is the block that is new on the page, not the whole list
  const apply = main.slice(main.indexOf('function applyKeyDom('), main.indexOf('function applyUndoStep('));
  assert.match(apply, /cameBack = /);
});
