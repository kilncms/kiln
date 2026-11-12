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
import { stillThere, restLine, withLastLive, clockTime, LIVE_ANSWERS, LIVE_ANSWER_GAP, LIVE_STAYS, LIVE_STAYS_PHONE,
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
  assert.match(main, /setStatus\(`\$\{e\.desc\} — live ✓`, 'saved', \{ hold \}\)/);
  assert.match(main, /const hold = isMobileEditor\(\) \? LIVE_STAYS_PHONE : LIVE_STAYS;/);
  assert.match(main, /setStatus\(restLine\(state\.user, state\.lastLive\), 'idle', state\.lastLive \? \{ hold: LIVE_STAYS \} : undefined\)/);
  assert.match(main, /setStatus\(withLastLive\(signInLine\[0\], state\.lastLive\), signInLine\[1\], signInLine\[2\]\), opts\?\.hold \|\| 6000\)/);
  // in publish(): a stop after the commit goes nowhere near publishFailed
  assert.match(main, /if \(!committed\) \{ publishFailed\(err, opts\); return; \}/);
  assert.match(main, /if \(result && !result\.unchanged\) committed = result;/);
  assert.ok(!main.includes('taking longer than usual to appear; it will'), 'no promise the editor cannot keep');
});
