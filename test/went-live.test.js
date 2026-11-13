/**
 * What the editor says after Publish (src/editor/went-live.js): "live" only
 * when the page has come back holding the change several times in a row, a
 * line that stays and can be found afterwards, and never "not published"
 * about a change whose commit was made.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stillThere, restLine, withLastLive, lineLeaves, clockTime, LIVE_ANSWERS, LIVE_ANSWER_GAP, LIVE_STAYS, LIVE_STAYS_PHONE,
  PUBLISHED_NOT_SEEN, PUBLISHED_NOT_WATCHED, SHARED_NOT_PUBLISHED } from '../src/editor/went-live.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = readFileSync(path.join(ROOT, 'src/editor/main.js'), 'utf8');

test('live is said only when the page holds the change three times in a row, a little apart', async () => {
  assert.ok(LIVE_ANSWERS >= 3 && LIVE_ANSWER_GAP >= 1500);
  const waits = [];
  let asked = 0;
  const ok = await stillThere(async () => { asked++; return true; }, { wait: async (ms) => { waits.push(ms); } });
  assert.equal(ok, true);
  assert.equal(asked, LIVE_ANSWERS - 1, 'the first good answer was the caller\'s; the rest are asked here');
  assert.deepEqual(waits, Array(LIVE_ANSWERS - 1).fill(LIVE_ANSWER_GAP));
});

test('one copy of the site still serving the old page: not live yet', async () => {
  const answers = [true, false, true];
  let asked = 0;
  assert.equal(await stillThere(async () => answers[asked++], { answers: 4, wait: async () => {} }), false);
  assert.equal(asked, 2, 'it stops at the miss and goes on waiting');
  assert.equal(await stillThere(async () => { throw new Error('offline'); }, { wait: async () => {} }), false, 'a request that fails is not a good answer');
});

test('the line stays long enough to be read, and the line the editor rests on says when the publish went live', () => {
  assert.ok(LIVE_STAYS >= 30000 && LIVE_STAYS_PHONE >= 8000);
  assert.equal(restLine('rosa', null), 'Signed in as rosa');
  const at = new Date(2026, 10, 12, 15, 52).getTime();
  assert.equal(clockTime(at, 'en-US'), '3:52 PM');
  assert.equal(restLine('rosa', { at }, { locale: 'en-US' }), 'Signed in as rosa. Your last publish went live at 3:52 PM.');
  // the owner's own line, which ends in a full stop, and is shown again and again: said once, with the newest time
  const once = withLastLive('Signed in as rosa. Click any outlined text to edit.', { at }, { locale: 'en-US' });
  assert.equal(once, 'Signed in as rosa. Click any outlined text to edit. Your last publish went live at 3:52 PM.');
  assert.equal(withLastLive(once, { at: at + 5 * 60000 }, { locale: 'en-US' }), 'Signed in as rosa. Click any outlined text to edit. Your last publish went live at 3:57 PM.');
  assert.equal(withLastLive(withLastLive('Signed in as rosa', { at }, { locale: 'en-US' }), { at }, { locale: 'en-US' }), 'Signed in as rosa. Your last publish went live at 3:52 PM.');
  assert.equal(withLastLive('Signed in as rosa', null), 'Signed in as rosa');
});

test('what is said when the editor cannot tell is plain, says the change is saved, and says how to check', () => {
  for (const said of [PUBLISHED_NOT_SEEN, PUBLISHED_NOT_WATCHED]) {
    assert.match(said, /^Published/);
    assert.match(said, /cannot tell/);
    assert.match(said, /Reload/);
    assert.match(said, /History/);
    assert.ok(!/—|not published/i.test(said));
  }
  assert.match(SHARED_NOT_PUBLISHED, /^The changes to this page are published\./);
  assert.ok(!SHARED_NOT_PUBLISHED.includes('—'));
});

test('the editor asks several times before it says live, keeps the line, and never calls a made commit a failed publish', () => {
  assert.match(main, /live = await served\(\) && await stillThere\(served\);/);
  assert.match(main, /state\.lastLive = \{ at: Date\.now\(\)/);
  assert.match(main, /setStatus\(`\$\{e\.desc\}: live ✓`, 'saved', \{ hold, rest: true \}\)/);
  assert.match(main, /const hold = isMobileEditor\(\) \? LIVE_STAYS_PHONE : LIVE_STAYS;/);
  assert.match(main, /setStatus\(restLine\(state\.user, state\.lastLive, \{ limits: limitsHere\(\) \}\), 'idle', state\.lastLive \? \{ hold: LIVE_STAYS \} : undefined\)/);
  assert.match(main, /if \(leaves\.then === 'sign-in'\) setStatus\(withLastLive\(signInLine\[0\], state\.lastLive\), signInLine\[1\], signInLine\[2\]\);/);
  // in publish(): a stop after the commit goes nowhere near publishFailed
  assert.match(main, /if \(!committed\) \{ publishFailed\(err, opts\); return; \}/);
  assert.match(main, /if \(result && !result\.unchanged\) committed = result;/);
  assert.ok(!main.includes('taking longer than usual to appear; it will'), 'no promise the editor cannot keep');
});

test('how long a line stays and what follows it: "live ✓" is followed by the resting line', () => {
  assert.deepEqual(lineLeaves({ kind: 'saved', hold: LIVE_STAYS, rest: true }), { after: 30000, then: 'rest' });
  assert.deepEqual(lineLeaves({ kind: 'saved', hold: LIVE_STAYS_PHONE, rest: true, phone: true }), { after: 10000, then: 'away' }, 'on a phone the line lies over the page: it is put away');
  // every other line, as it was
  assert.deepEqual(lineLeaves({ kind: 'saved' }), { after: 6000, then: 'away' });
  assert.deepEqual(lineLeaves({ kind: 'idle', phone: true }), { after: 4000, then: 'away' });
  assert.deepEqual(lineLeaves({ kind: 'saved', hold: 10000, phone: true }), { after: 10000, then: 'away' }, 'a line with something to press says how long it stays ("Removed. Undo")');
  assert.deepEqual(lineLeaves({ kind: 'idle', hold: LIVE_STAYS }), { after: 30000, then: 'away' }, 'the resting line itself');
  assert.equal(lineLeaves({ kind: 'saving' }), null, 'work under way stays until there is news');
  assert.equal(lineLeaves({ kind: 'error' }), null);
  assert.equal(lineLeaves({ kind: 'saved', sticky: true, offer: true }), null, '"Published. Undo" has its own ten seconds');
  // once the sign-in has ended its line comes back after any other news, and that line itself stays
  assert.equal(lineLeaves({ kind: 'error', sticky: true, signIn: true, signInWaiting: true }), null);
  assert.deepEqual(lineLeaves({ kind: 'saved', hold: LIVE_STAYS, rest: true, signInWaiting: true }), { after: 30000, then: 'sign-in' });
  assert.deepEqual(lineLeaves({ kind: 'saving', signInWaiting: true }), { after: 6000, then: 'sign-in' });
  assert.equal(lineLeaves({ kind: 'saved', sticky: true, offer: true, signInWaiting: true }), null);
});

/**
 * The status line as main.js keeps it, on a clock the test moves: setStatus
 * (a line said while "Published. Undo" is on is kept back and shown when its
 * ten seconds end), offerUndo, and the timer of setStatusIdle, which shows
 * the resting line only if no other line has been shown since it was set.
 * `own`: the line's own timer follows lineLeaves, as setStatus now does;
 * without it, it only puts the line away, as it did before.
 */
function statusLine({ own, phone = false }) {
  let now = 0, shown = 0, offer = null, timer = null;
  const timers = [], seen = [];
  const later = (ms, run) => { const t = { at: now + ms, run }; timers.push(t); return t; };
  const say = (text, kind, opts = {}) => {
    if (offer && !opts.offer) { offer.held = [text, kind, opts]; return; }
    seen.push(`${now / 1000}s ${text}`);
    shown++;
    if (timer) timer.run = () => {};
    timer = null;
    const leaves = lineLeaves({ kind, hold: opts.hold, sticky: opts.sticky, offer: opts.offer, rest: own && opts.rest, phone });
    if (leaves) timer = later(leaves.after, () => (leaves.then === 'rest' ? rest() : seen.push(`${now / 1000}s (put away)`)));
  };
  const rest = () => say('Signed in as rosa. Your last publish went live at 3:52 PM.', 'idle', { hold: LIVE_STAYS });
  return {
    seen, say,
    offerUndo() { offer = { held: null }; say('Published.', 'saved', { offer: true, sticky: true }); later(10000, () => { const held = offer.held; offer = null; if (held) say(...held); }); },
    idleIn(ms) { const then = shown; later(ms, () => { if (shown === then && !phone) rest(); }); },
    at(ms, run) { later(ms - now, run); },
    runTo(ms) { for (;;) { const next = timers.filter(t => t.at <= ms).sort((a, b) => a.at - b.at)[0]; if (!next) break; timers.splice(timers.indexOf(next), 1); now = next.at; next.run(); } now = ms; },
  };
}
/** A publish that the site shows `liveAt` ms later; the editor stops watching at its next look, as runJournal does. */
function publish(line, { undo, liveAt, phone = false }) {
  const hold = phone ? LIVE_STAYS_PHONE : LIVE_STAYS;
  if (undo) line.offerUndo(); else line.say('Going live…', 'saving');
  line.at(liveAt, () => line.say('Your page edit: live ✓', 'saved', { hold, rest: true }));
  const stop = Math.ceil((liveAt + 1) / 6000) * 6000;
  line.at(stop, () => line.idleIn(Math.max(4000, hold - (stop - liveAt))));
  line.runTo(5 * 60000);
  return line.seen;
}

test('after an ordinary publish the line moves on from "live ✓" to the resting line, however quick the site was', () => {
  const RESTS = 'Signed in as rosa. Your last publish went live at 3:52 PM.';
  // New post, Find & replace: no "Published. Undo", and the line always moved on
  assert.deepEqual(publish(statusLine({ own: false }), { undo: false, liveAt: 4500 }), ['0s Going live…', '4.5s Your page edit: live ✓', '34.5s (put away)', `34.5s ${RESTS}`, '64.5s (put away)'],
    'two timers went off together there: one put "live ✓" away and the other showed the resting line');
  // an ordinary publish, live while "Published. Undo" still had the line: before, the resting line never came
  assert.deepEqual(publish(statusLine({ own: false }), { undo: true, liveAt: 4500 }), ['0s Published.', '10s Your page edit: live ✓', '40s (put away)'],
    'the fault: the timer for the resting line was set at 6s, saw a newer line when it went off, and did nothing');
  // now "live ✓" moves on by itself, thirty seconds after it is really shown
  assert.deepEqual(publish(statusLine({ own: true }), { undo: true, liveAt: 4500 }), ['0s Published.', '10s Your page edit: live ✓', `40s ${RESTS}`, '70s (put away)']);
  // and on every other path it is as it was: said once, at the same moment
  assert.deepEqual(publish(statusLine({ own: true }), { undo: false, liveAt: 4500 }), ['0s Going live…', '4.5s Your page edit: live ✓', `34.5s ${RESTS}`, '64.5s (put away)']);
  assert.deepEqual(publish(statusLine({ own: true }), { undo: true, liveAt: 47000 }), ['0s Published.', '47s Your page edit: live ✓', `77s ${RESTS}`, '107s (put away)']);
  // a phone: ten seconds, then the line is put away and rests on nothing
  assert.deepEqual(publish(statusLine({ own: true, phone: true }), { undo: true, liveAt: 4500, phone: true }), ['0s Published.', '10s Your page edit: live ✓', '20s (put away)']);
});

test('the editor settles what follows a line where the line is shown, and says "live ✓" with what follows it', () => {
  const set = main.slice(main.indexOf('\nfunction setStatus(text, kind, opts) {'), main.indexOf('// ─── Crash-proof pending edits'));
  assert.match(set, /const leaves = lineLeaves\(\{ kind, hold: opts\?\.hold, sticky: !!opts\?\.sticky, signIn: !!opts\?\.signIn, offer: !!opts\?\.offer, rest: !!opts\?\.rest,\n    phone: isMobileEditor\(\), signInWaiting: !!signInLine \}\);/);
  assert.match(set, /else if \(leaves\.then === 'rest'\) restStatus\(\);\n    else el\.hidden = true;\n  \}, leaves\.after\);/);
  // a line kept back by "Published. Undo" has no timer until it is shown: the offer returns before any is set
  assert.ok(set.indexOf('undoOffer.held = [text, kind, opts]; return;') < set.indexOf('const leaves = lineLeaves('));
  assert.match(main, /setStatus\('Live ✓ View site', 'saved', \{ href: e\.target, hold, rest: true \}\);/);
  assert.match(main, /function restStatus\(\) \{\n  setStatus\(restLine\(state\.user, state\.lastLive, \{ limits: limitsHere\(\) \}\), 'idle', state\.lastLive \? \{ hold: LIVE_STAYS \} : undefined\);\n\}/);
});
