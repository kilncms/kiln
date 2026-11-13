/**
 * What a person types counts as an edit while they type it
 * (src/editor/typing-counts.js).
 *
 * A tester typed a sentence into a heading and did not click anywhere else:
 * no count on the Kiln button, "Publish" and not "Publish 1 edit", and no
 * "Leave site?" when the tab was closed. The first half of this file tests
 * the pure parts. The second half reads main.js and pins each line the fix
 * stands on: take one away and the assertion that names it fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TYPING_PAUSE, afterLastKey } from '../src/editor/typing-counts.js';
import { openBoxEdit, openListEdit, draftRecord, readDraft } from '../src/editor/saved-edits.js';
import { countChanges } from '../src/editor/publish-sheet.js';

// ─── The short moment after the last key ─────────────────────────────────────

/** Timers a test moves by hand. */
function clock() {
  let at = 0, id = 0;
  const due = new Map();
  return {
    set: (fn, ms) => { due.set(++id, { fn, when: at + ms }); return id; },
    clear: (t) => { due.delete(t); },
    pass(ms) {
      at += ms;
      for (const [t, d] of [...due]) if (d.when <= at) { due.delete(t); d.fn(); }
    },
  };
}

test('the short moment is about 400 milliseconds', () => {
  assert.equal(TYPING_PAUSE, 400);
});

test('the count is brought up to date once, a short moment after the last key', () => {
  const c = clock();
  let runs = 0;
  const pause = afterLastKey(() => { runs++; }, TYPING_PAUSE, c);
  pause.key();
  c.pass(399);
  assert.equal(runs, 0, 'not before the moment has passed');
  c.pass(1);
  assert.equal(runs, 1);
  c.pass(5000);
  assert.equal(runs, 1, 'once, not again and again');
  assert.equal(pause.waiting, false);
});

test('every key starts the wait again, so a sentence typed without stopping is taken in once', () => {
  const c = clock();
  let runs = 0;
  const pause = afterLastKey(() => { runs++; }, TYPING_PAUSE, c);
  for (let i = 0; i < 30; i++) { pause.key(); c.pass(120); }
  assert.equal(runs, 0, 'nothing while the keys keep coming');
  assert.equal(pause.waiting, true);
  c.pass(400);
  assert.equal(runs, 1);
});

test('when the page is about to go it is done at once, and the wait that was on is ended', () => {
  const c = clock();
  let runs = 0;
  const pause = afterLastKey(() => { runs++; }, TYPING_PAUSE, c);
  pause.key();
  c.pass(100);
  pause.now();
  assert.equal(runs, 1, 'at once, although the short moment had not passed');
  c.pass(1000);
  assert.equal(runs, 1, 'and not a second time when the moment would have passed');
  pause.now();
  assert.equal(runs, 2, 'with no key waiting it is still done when asked');
});

// ─── What the count reads while a part is open ───────────────────────────────

/** The rows the publish sheet would list for these edits: one for each part that holds an edit. */
const rows = (edits) => [...edits.keys()].map(() => ({ parts: [{ type: 'text' }] }));

test('words typed into a part are one edit, and typing more in it is still that one edit', () => {
  const staged = new Map();
  const first = openBoxEdit(staged, 'headline', 'Fresh pickles. Hello', 'Fresh pickles.');
  assert.equal(countChanges(rows(first)), 1);
  const more = openBoxEdit(staged, 'headline', 'Fresh pickles. Hello there', 'Fresh pickles.');
  assert.equal(countChanges(rows(more)), 1, 'never two edits for one part');
  assert.equal(more.get('headline').html, 'Fresh pickles. Hello there');
  assert.equal(staged.size, 0, 'nothing is staged by typing: the part is staged once, when it is left');
});

test('words put back exactly as they were are no edit, and nothing is kept for them', () => {
  const staged = new Map();
  const back = openBoxEdit(staged, 'headline', 'Fresh pickles.', 'Fresh pickles.');
  assert.equal(back, staged);
  assert.equal(countChanges(rows(back)), 0);
  assert.equal(draftRecord(back, new Map(), 1), null);
});

test('a part typed in beside an edit staged earlier makes two, and the copy kept in the browser remembers that number', () => {
  const staged = new Map([['intro', { html: 'Staged before' }]]);
  const typed = openBoxEdit(staged, 'headline', 'New words', 'Old words');
  const n = countChanges(rows(typed));
  assert.equal(n, 2);
  const kept = draftRecord(typed, new Map(), 1000, null, n);
  assert.equal(kept.n, 2);
  assert.equal(readDraft(kept, { now: 2000 }).count, 2, 'the offer to bring the edits back says the number the button showed');
  assert.deepEqual(Object.keys(kept.edits).sort(), ['headline', 'intro']);
});

test('a part inside a list counts as its list, once, and not at all when its words are as they were', () => {
  const staged = new Map();
  const typed = openListEdit(staged, 'products', { now: 'New', before: 'Old', listHtml: '<article><h3 data-cms="t">New</h3></article>' });
  assert.equal(countChanges(rows(typed)), 1);
  assert.equal(openListEdit(staged, 'products', { now: 'Old', before: 'Old', listHtml: null }), staged);
});

// ─── The wiring in main.js ───────────────────────────────────────────────────

const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
const part = (from, to) => {
  const a = main.indexOf(from);
  assert.ok(a !== -1, `not found: ${from}`);
  const b = main.indexOf(to, a + from.length);
  assert.ok(b !== -1, `not found after it: ${to}`);
  return main.slice(a, b);
};
/** `first` is in `src`, and `then` comes after it. */
const inOrder = (src, first, then, why) => {
  const a = src.indexOf(first);
  assert.ok(a !== -1, `${why}: not found: ${first}`);
  assert.ok(src.indexOf(then, a + first.length) !== -1, `${why}: not found after it: ${then}`);
};

test('a short moment after a key in the open part, the count is drawn again', () => {
  const typing = part('const typingPause', "window.addEventListener('pagehide'");
  assert.ok(typing.includes('afterLastKey(() => { if (state.active) refreshPublishButton(); }, TYPING_PAUSE)'));
  assert.ok(typing.includes('typingPause.key();'));
  assert.ok(typing.includes('const saveTypingNow = () => { if (state.active) typingPause.now(); };'));
});

test('only a key in the part that is open counts: not one in a dialog of the editor, a toolbar or a part edited through a box', () => {
  const typing = part('const typingPause', "window.addEventListener('pagehide'");
  inOrder(typing, 'if (!state.active || !state.active.contains(e.target)) return;', 'typingPause.key();', 'the key is checked before it counts');
  const open = part('function withOpenBox(', 'function openListHtml(');
  assert.ok(open.includes('if (!key || el.hasAttribute(SOURCE_ATTR)) return pending;'), 'a part of a content file, edited through its own box, is not read here');
});

test('the number on every Publish control reads the open part as if it had been left', () => {
  const items = part('function publishItems(', '\nfunction ');
  assert.ok(items.includes('for (const [key, v] of withOpenBox(state.pending)) {'));
  assert.ok(!/of state\.pending\)/.test(items), 'the rows are read from the staged edits alone again');
  assert.match(main, /function changeCount\(\) \{\s*\n\s*try \{ return countChanges\(publishItems\(\{ light: true \}\)\); \}/);
});

test('drawing the count writes the copy kept in the browser, with the open part and the number shown', () => {
  const draw = part('function refreshPublishButton() {', '\nfunction disablePublish(');
  inOrder(draw, 'const n = changeCount();', 'state.shownCount = n;', 'the number shown is the one kept');
  inOrder(draw, 'state.shownCount = n;', 'savePendingToStorage();', 'the copy is written after the number is known');
  const save = part('function savePendingToStorage() {', '\nfunction withOpenBox(');
  assert.ok(save.includes('draftRecord(withOpenBox(state.pending), state.pendingSource, Date.now(), state.typed, state.shownCount)'));
});

test('typing stages nothing and gives Undo no step', () => {
  const typing = part('const typingPause', "window.addEventListener('pagehide'");
  assert.doesNotMatch(typing, /stagePending\(|stageContainer\(|pushUndoEntry\(|commitEdit\(|state\.pending\.(set|delete)\(/);
  const open = part('function withOpenBox(', 'let keptReady');
  assert.doesNotMatch(open, /stagePending\(|stageContainer\(|pushUndoEntry\(|state\.pending\.(set|delete)\(/);
});

test('this is why: a part staged a second time gets a step that goes back only to the first', () => {
  const stage = part('function stagePending(key, patch, opts = {}) {', '\nlet cameBack');
  assert.ok(stage.includes('step.beforeHtml = prev?.html !== undefined ? prev.html : state.undoBase.get(key);'));
  // and Undo, asked for while a part is open, leaves the part first, so its one step holds all that was typed
  const undo = part('function undoEdit() {', 'const entry = editHistory.undo.pop();');
  assert.ok(undo.includes("if (state.active) commitEdit(state.active, state.active.getAttribute('data-cms'));"));
});

test('"Leave site?" counts the part the person is in, and the copy is written before the page goes', () => {
  const leave = part("window.addEventListener('beforeunload'", 'e.returnValue');
  inOrder(leave, 'saveTypingNow();', 'edits = withOpenBox(state.pending);', 'the count and the copy are brought up to date first');
  inOrder(leave, 'edits = withOpenBox(state.pending);', 'const unpublished = !!(edits.size || state.pendingBinaries.size', 'the open part is asked about');
  assert.ok(leave.includes('asksBeforeLeaving({ toSignIn: leavingToSignIn, unpublished, sending: state.sending.any })'));
});

test('a part that is being left is not read as open, so leaving it never counts it twice', () => {
  const open = part('function withOpenBox(', 'function openListHtml(');
  assert.ok(open.includes("if (el.contentEditable !== 'true') return pending;"));
  const commit = part('function commitEdit(el, key) {', '\nfunction committedHtml(');
  inOrder(commit, "el.contentEditable = 'false';", 'stageContainer(repeat', 'the part is closed before a list is staged');
  inOrder(commit, "el.contentEditable = 'false';", 'stagePending(key, { html });', 'the part is closed before its words are staged');
});

test('the count goes back down when a part is left with its words as they were, or given up with Esc', () => {
  const unchanged = part('  if (unchanged) {', '    return;\n  }');
  inOrder(unchanged, 'state.active = null;', 'refreshPublishButton();', 'left unchanged');
  assert.equal(unchanged.split('refreshPublishButton();').length - 1, 1, 'drawn once, whether or not a staged edit went');
  const esc = part('function cancelEditing() {', '\nfunction stagePending(');
  inOrder(esc, 'state.active = null;', 'refreshPublishButton();', 'given up with Esc');
});

test('the demo guide still follows the staged edits, which typing does not change', () => {
  const reads = main.split('unpublished: () => state.pending.size + state.pendingSource.size + state.pendingBinaries.size + state.pendingStructural.length').length - 1;
  assert.equal(reads, 2);
});
