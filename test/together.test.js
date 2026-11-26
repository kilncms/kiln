// "Several pages together" as a way of working (step 4 of publishing several
// pages as one change): the choice and its reader, the Publish label across
// pages, leaving without "Leave site?" only when the saved copy is proven,
// the lifetime passed through, clearing only what was sent, and the words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  WAY_KEY, WAYS, readWay, setWay, wayOffered, wayNow, togetherLabel, leaveIsSafe, backLine, NO_ROOM_TEXT, keptFor, KEEP,
} from '../src/editor/waiting.js';
import { asksBeforeLeaving } from '../src/editor/sending.js';
import { sentKeys, withoutKeys, PAGE_CONTROLS, OTHER_TAB_TEXT, dropPageCopy } from '../src/editor/set-sheet.js';
import { keptAge } from '../src/editor/pending-files.js';
import { draftRecord, WEEK } from '../src/editor/saved-edits.js';

const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
const pendingFiles = readFileSync(new URL('../src/editor/pending-files.js', import.meta.url), 'utf8');
const between = (from, to) => { const a = main.indexOf(from); assert.ok(a >= 0, from); return main.slice(a, main.indexOf(to, a + from.length)); };

function store(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };

test('the choice is read from one key, and anything but "together" is one page at a time', () => {
  assert.equal(readWay(store()), 'one');
  assert.equal(readWay(store({ [WAY_KEY]: 'together' })), 'together');
  assert.equal(readWay(store({ [WAY_KEY]: 'TOGETHER' })), 'one');
  assert.equal(readWay(store({ [WAY_KEY]: '1' })), 'one');
  assert.equal(readWay(blocked), 'one');
  assert.equal(readWay(null), 'one');
  const s = store();
  setWay(s, 'together'); assert.equal(s.getItem(WAY_KEY), 'together');
  setWay(s, 'one'); assert.equal(s.getItem(WAY_KEY), null, 'one page at a time is kept as nothing, as before there was a choice');
  assert.doesNotThrow(() => setWay(blocked, 'together'));
});

test('the choice is not offered in the demo, nor to a person who may only suggest or only comment', () => {
  const s = store({ [WAY_KEY]: 'together' });
  assert.equal(wayOffered(), true);
  assert.equal(wayNow(s, {}), 'together');
  for (const who of [{ sandbox: true }, { suggest: true }, { review: true }]) {
    assert.equal(wayOffered(who), false);
    assert.equal(wayNow(s, who), 'one');
  }
});

test('the two options are written like the others in Settings: a name and one full sentence', () => {
  assert.deepEqual(WAYS.map(w => w.value), ['one', 'together']);
  assert.equal(WAYS[0].name, 'One page at a time');
  assert.equal(WAYS[0].line, "Publish sends this page's changes.");
  assert.equal(WAYS[1].name, 'Several pages together');
  assert.equal(WAYS[1].line, 'Changes wait in this browser while you move between pages. One Publish sends them all as one change, so the site rebuilds once.');
  for (const w of WAYS) assert.doesNotMatch(w.line, /\s[-–—]\s/);
  const settings = between('function settingsPanel()', '\n}\n');
  assert.ok(settings.includes('<h4>Your editor (this browser)</h4>'));
  assert.ok(settings.indexOf('Your editor (this browser)') < settings.indexOf('name="kiln-way"'), 'the choice sits under "Your editor (this browser)"');
  assert.ok(settings.includes('${wayOffered(wayWho()) ?'), 'shown only where it is offered');
  assert.ok(settings.includes('setWay(localStorage, wayPicked.value); refreshPublishButton();'), 'takes effect at once, with no reload');
});

test('the Publish label counts everything a set would send, and reads as today for this page alone', () => {
  assert.equal(togetherLabel({ edits: 7, pages: 3, here: true }), 'Publish 7 edits on 3 pages');
  assert.equal(togetherLabel({ edits: 2, pages: 2, here: false }), 'Publish 2 edits on 2 pages');
  assert.equal(togetherLabel({ edits: 2, pages: 1, here: true }), '', 'this page only: today\'s words');
  assert.equal(togetherLabel({ edits: 3, pages: 1, here: false }), 'Publish 3 edits on 1 other page');
  assert.equal(togetherLabel({ edits: 1, pages: 1, here: false }), 'Publish 1 edit on 1 other page');
  assert.equal(togetherLabel({ edits: 0, pages: 0 }), '');
  assert.equal(togetherLabel(), '');
});

test('"Leave site?" learns "saved", and with it left out asks exactly as before', () => {
  for (const toSignIn of [false, true]) for (const unpublished of [false, true]) for (const sending of [false, true]) {
    const before = toSignIn ? false : !!(unpublished || sending);
    assert.equal(asksBeforeLeaving({ toSignIn, unpublished, sending }), before);
    assert.equal(asksBeforeLeaving({ toSignIn, unpublished, sending, saved: false }), before);
    assert.equal(asksBeforeLeaving({ toSignIn, unpublished, sending, saved: true }), toSignIn ? false : sending, 'saved: asked only while sending');
  }
  assert.equal(asksBeforeLeaving({ unpublished: true, saved: 'yes' }), true, 'only true itself counts as proven');
  assert.equal(asksBeforeLeaving(), false);
});

const edits = new Map([['hero-title', { html: 'Fresh bread daily' }]]);
const copyOf = (m, typed = null) => JSON.parse(JSON.stringify(draftRecord(m, new Map(), 1000, typed)));
const safe = (over = {}) => ({ way: 'together', stored: copyOf(edits), edits, path: 'index.html', ...over });

test('leaving is safe only when the copy read back holds exactly what is on the page', () => {
  assert.equal(leaveIsSafe(safe()), true);
  assert.equal(leaveIsSafe(safe({ way: 'one' })), false, 'one page at a time always asks');
  assert.equal(leaveIsSafe(safe({ stored: null })), false, 'no copy could be read (no room, or storage blocked)');
  assert.equal(leaveIsSafe(safe({ stored: copyOf(new Map([['hero-title', { html: 'Fresh bread' }]])) })), false, 'the copy holds an older value');
  assert.equal(leaveIsSafe(safe({ edits: new Map([...edits, ['about', { html: 'Hi' }]]) })), false, 'an edit the copy does not hold');
  assert.equal(leaveIsSafe(safe({ edits: new Map() })), false);
  assert.equal(leaveIsSafe(safe({ typed: { where: 'note', text: 'half a line' } })), false, 'typing the copy does not hold');
  const typed = { where: 'note', text: 'half a line' };
  assert.equal(leaveIsSafe(safe({ typed, stored: copyOf(edits, typed) })), true, 'typing the copy does hold');
});

test('leaving asks for anything a set cannot carry, and for a picture not yet kept', () => {
  assert.equal(leaveIsSafe(safe({ structural: 1 })), false, 'an added or removed section, or a part made editable');
  assert.equal(leaveIsSafe(safe({ restoring: true })), false, 'a whole-page restore');
  assert.equal(leaveIsSafe(safe({ source: new Map([['posts/a.md#title', { value: 'x' }]]) })), false, 'a content-file edit');
  assert.equal(leaveIsSafe(safe({ path: null })), false, 'the page\'s file is not known');
  assert.equal(leaveIsSafe(safe({ pictures: ['images/loaf.jpg'] })), false);
  assert.equal(leaveIsSafe(safe({ pictures: ['images/loaf.jpg'], kept: new Set(['images/loaf.jpg']) })), true);
});

test('the editor proves the copy before it skips the question, and one page at a time is untouched', () => {
  const leave = between("window.addEventListener('beforeunload'", '\n  });');
  assert.ok(leave.includes('saved = unpublished && leaveProven(edits);'));
  assert.ok(leave.includes(': asksBeforeLeaving({ toSignIn: leavingToSignIn, unpublished, sending: state.sending.any });'), 'the call of before, when not proven');
  const proven = between('function leaveProven(edits)', '\n}\n');
  assert.ok(proven.includes("if (way() !== 'together' || !keptReady) return false;"));
  assert.ok(proven.includes('JSON.parse(localStorage.getItem(pendingStorageKey()))'), 'read back, not assumed');
  assert.ok(proven.includes('kept: keptSure'), 'pictures count only once the store said it holds them');
});

test('coming back: put back without the question, by the same steps as "Restore edits"', () => {
  const offer = between('function offerPendingRestore()', '\n}\n');
  // With what the edits were made against (before.js) carried along as the fifth argument.
  assert.ok(offer.indexOf("if (way() === 'together' && saved.count) { restoreSaved(saved, kept, false, true, prior); return; }") > offer.indexOf('if (back)'));
  assert.ok(offer.indexOf("restoreSaved(saved, kept, false, true, prior)") < offer.indexOf('<h3>Pick up where you left off?</h3>'));
  assert.equal(backLine(2), 'Your 2 waiting edits on this page are back. Not published yet.');
  assert.equal(backLine(1), 'Your waiting edit on this page is back. Not published yet.');
  assert.equal(backLine(3, 1), 'Your 3 waiting edits on this page are back. Not published yet. 1 of them could not be shown on the page, because it holds code Kiln does not put back by itself.');
  assert.match(backLine(3, 2), /2 of them could not be shown on the page, because they hold code/);
});

test('thirty days in "Several pages together", passed to the copies, the list and the pictures; a week otherwise', () => {
  assert.equal(keptFor('together'), KEEP.together);
  assert.equal(KEEP.together, 30 * 24 * 3600 * 1000);
  assert.equal(keptFor('one'), WEEK);
  assert.ok(main.includes('saved = readDraft(stored, { keep: keptFor(way()),'), 'the copy on arrival');
  assert.ok(between('function otherWaiting()', '\n}\n').includes('keep: keptFor(way())'), 'the list of other pages');
  assert.ok(between('function keptFiles(page)', '\n}\n').includes('keptFilesFor(page, Date.now(), keptFor(way()))'), 'the pictures');
  assert.equal(keptAge(), WEEK, 'the week stays the default');
  assert.equal(keptAge(KEEP.together), KEEP.together);
  for (const bad of [0, -1, NaN, 'x', null]) assert.equal(keptAge(bad), WEEK);
  assert.ok(pendingFiles.includes('export async function keptFiles(page, now = Date.now(), maxAge = MAX_AGE)'));
});

test('no room: said once per page load, in the words of the design', () => {
  assert.equal(NO_ROOM_TEXT, 'This browser has no room to keep these edits. Publish this page before you leave it.');
  const said = between('function noRoom()', '\n}\n');
  assert.ok(said.includes("if (noRoom.said || way() !== 'together') return;"));
  assert.ok(between('function savePendingToStorage()', '\n}\n').includes('noRoom();'));
});

test('clearing after a set: only a part whose kept value is still the one sent', () => {
  const sent = { edits: { a: { html: 'One' }, b: { html: 'Two' }, c: { attrs: { href: '/x' } } } };
  const now = { ts: 2, edits: { a: { html: 'One' }, b: { html: 'Two, edited in another tab' }, c: { attrs: { href: '/x' } }, d: { html: 'new' } } };
  assert.deepEqual(sentKeys(now, sent, ['a', 'b', 'c']), ['a', 'c']);
  assert.deepEqual(sentKeys(now, sent, ['d']), [], 'not sent');
  assert.deepEqual(sentKeys(null, sent, ['a']), []);
  assert.deepEqual(sentKeys({ edits: {} }, sent, ['a']), [], 'already gone');
  assert.deepEqual(withoutKeys(now, sentKeys(now, sent, ['a', 'b', 'c'])).edits, { b: { html: 'Two, edited in another tab' }, d: { html: 'new' } });
  const after = between('async function afterSet(', '\n}\n');
  assert.ok(after.includes('const keys = sentKeys(now, e.copy, clear.get(e.path) || []);'));
});

test('"Discard", not "Drop", for a page\'s waiting changes', () => {
  assert.equal(PAGE_CONTROLS.drop, 'Discard');
  assert.equal(dropPageCopy(2, 'About us').title, 'Discard these changes?');
  assert.equal(dropPageCopy(1, 'About us').title, 'Discard this change?');
  assert.equal(OTHER_TAB_TEXT.dropped, 'These were discarded in another tab.');
  assert.equal(OTHER_TAB_TEXT.published, 'These were published from another tab.');
  assert.doesNotMatch(main, /dropped in another tab/);
});

test('the top bar has "Waiting on other pages", shown by the same rule as the round button\'s menu', () => {
  const bar = between('function renderTopBar()', '\n}\n');
  assert.ok(bar.includes('<button id="kiln-waiting" class="kiln-btn-ghost" style="display:none">Waiting on other pages</button>'));
  assert.ok(bar.includes("bar.querySelector('#kiln-waiting').onclick = () => openWaitingSheet();"));
  const refresh = between('function refreshPublishButton()', '\nfunction disablePublish(');
  assert.ok(refresh.includes("const waitingBtn = document.getElementById('kiln-waiting');"), 'one rule for both layouts');
});

test('Publish with "Several pages together": the set sheet, or the set at once without the preview', () => {
  const req = between('function requestPublish()', '\n}\n');
  assert.ok(req.indexOf('if (together) return publishTogether();') < req.indexOf('if (previewOff(localStorage)) return publish();'));
  assert.ok(req.includes("const together = way() === 'together' && otherWaiting().length > 0;"));
  const go = between('function publishTogether()', '\n}\n');
  assert.ok(go.includes('if (!previewOff(localStorage) || (hereHasAnything() && !thisPageJoins()) || setLimitLine()) return openWaitingSheet();'));
  assert.ok(go.includes('stop: (text, next = null) => openWaitingSheet({ text, next })'), 'a stop opens the sheet to say so');
  const refresh = between('function refreshPublishButton()', '\nfunction disablePublish(');
  assert.ok(refresh.includes("const across = !closed && way() === 'together' ? acrossNow() : null;"));
  assert.ok(refresh.includes('const label = across?.label || today;'));
  assert.ok(refresh.includes('const live = anything || !!across;'));
});

// A picture waiting with a page's edits lasts as long as those edits can be offered back in any way of
// working, so edits brought back days after the picture was chosen never point at a file that was thrown away.
test('waiting pictures last as long as the longest offer of their edits', async () => {
  const { keptLasts, LONGEST_OFFER } = await import('../src/editor/pending-files.js');
  assert.equal(LONGEST_OFFER, KEEP.together, 'the same thirty days as "Several pages together"');
  assert.equal(keptLasts(), KEEP.together, 'one page at a time: a picture chosen before the last edit is still there');
  assert.equal(keptLasts(WEEK), KEEP.together);
  assert.equal(keptLasts(KEEP.together), KEEP.together);
  for (const bad of [0, -1, NaN, 'x', null]) assert.equal(keptLasts(bad), KEEP.together);
  assert.ok(pendingFiles.includes('const age = keptLasts(maxAge);'), 'keptFiles uses it for what it drops and what it gives back');
});
