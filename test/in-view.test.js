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
import { whereTo, coveredBy, nudge } from '../src/editor/in-view.js';

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

// ── a block's opened buttons on a phone ──────────────────────────────────────
// On a phone a block's buttons open in a row at the foot of the block. With a
// card 578 px tall whose top was halfway down the screen, the row opened below
// the screen and the tap on "more" seemed to do nothing; with the card a
// quarter of the way down, it opened under the demo's banner, the guide's tip
// and Publish.

test('opened buttons: what stays along the top and the bottom of the screen is measured, each thing for its nearer edge', () => {
  // a phone after one edit in the demo: the pencil, Undo Redo Publish, the banner over them, the guide's tip, the line of words at the top
  const own = [{ top: 772, bottom: 828 }, { top: 778, bottom: 822 }, { top: 716, bottom: 760 }, { top: 714, bottom: 766 }, { top: 87, bottom: 123 }];
  assert.deepEqual(coveredBy(own, 844), { top: 123, bottom: 130 });
  // nothing there
  assert.deepEqual(coveredBy([], 844), { top: 0, bottom: 0 });
  assert.deepEqual(coveredBy(undefined, 844), { top: 0, bottom: 0 });
  // a sheet that fills most of the screen is not a strip along an edge; neither is something off the screen or with no height
  assert.deepEqual(coveredBy([{ top: 200, bottom: 844 }, { top: 900, bottom: 960 }, { top: -80, bottom: -20 }, { top: 400, bottom: 400 }, null], 844), { top: 0, bottom: 0 });
});

test('opened buttons: the page moves the least that shows them whole, clear of what covers the screen', () => {
  const covered = { top: 123, bottom: 130 };
  // under the tip, the banner and Publish: up the page until the row ends 8 px over them
  assert.equal(nudge({ top: 732, bottom: 784 }, 844, covered), 78);
  // below the screen altogether (the card's top was halfway down)
  assert.equal(nudge({ top: 943, bottom: 995 }, 844, covered), 289);
  // under the line of words at the top: back down the page
  assert.equal(nudge({ top: 100, bottom: 152 }, 844, covered), -31);
  // with nothing along the edges, only the edge of the screen counts
  assert.equal(nudge({ top: 800, bottom: 852 }, 844), 16);
  assert.equal(nudge({ top: -20, bottom: 32 }, 844), -28);
});

test('opened buttons: a row that already shows leaves the page where it is', () => {
  const covered = { top: 123, bottom: 130 };
  assert.equal(nudge({ top: 400, bottom: 452 }, 844, covered), 0);
  assert.equal(nudge({ top: 654, bottom: 706 }, 844, covered), 0, 'just clear of the bottom');
  assert.equal(nudge({ top: 131, bottom: 183 }, 844, covered), 0, 'just clear of the top');
  assert.equal(nudge({ top: 300, bottom: 352 }, 844), 0);
});

test('opened buttons: something taller than the room on the screen shows where it begins', () => {
  assert.equal(nudge({ top: 500, bottom: 1400 }, 844, { top: 56, bottom: 90 }), 436);
  assert.equal(nudge({ top: 64, bottom: 964 }, 844, { top: 56, bottom: 90 }), 0);
});

test('opened buttons: the editor shows a bar when it opens, and only then', () => {
  const tap = main.slice(main.indexOf('more.onclick = '), main.indexOf('ctl.prepend(more);'));
  assert.match(tap, /if \(open\) showOpenedBar\(ctl\);/);
  const show = main.slice(main.indexOf('function showOpenedBar('), main.indexOf('function closeItemControls('));
  assert.match(show, /coveredBy\(own, window\.innerHeight\)/);
  assert.match(show, /siteBarsBottom\(\)/, 'the site\'s own bar at the top counts too');
  assert.match(show, /const by = nudge\(/);
  assert.match(show, /if \(by\) window\.scrollBy\(\{ top: by, behavior: 'smooth' \}\);/);
  // the guide's first tip rides the page: only what is fixed, or inside something fixed, stays on the screen
  assert.match(show, /position === 'fixed'/);
  for (const id of ['#kiln-fab-wrap', '#kiln-quick', '#kiln-sandbox-banner', '#kiln-status', '#kiln-guide']) assert.ok(show.includes(id), id);
});
