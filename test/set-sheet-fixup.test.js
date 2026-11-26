// The set sheet's five fixes: the done line and the "going live" line after a
// set, the title's count, a held-back row, the conflict question's own words,
// and Cancel while the set is being sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setDeployName, setGoingLine, SET_DONE_STAYS, setTheirsOrMine, HELD_TEXT } from '../src/editor/set-sheet.js';
import { setSheetTitle } from '../src/editor/publish-sheet.js';
import { goingLiveLabel } from '../src/editor/firstrun.js';
import { theirsOrMine } from '../src/editor/source-fields.js';

const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
const sheet = readFileSync(new URL('../src/editor/publish-sheet.js', import.meta.url), 'utf8');

test('after a set the "going live" line names the pages, and a one-page publish is unchanged', () => {
  assert.equal(setDeployName(2), 'Your 2 pages');
  assert.equal(setDeployName(1), 'Your page');
  assert.equal(setGoingLine(2), 'Your 2 pages are going live… usually under a minute');
  assert.equal(setGoingLine(1), 'Your page is going live… usually under a minute');
  assert.equal(goingLiveLabel([{ desc: setDeployName(3), going: setGoingLine(3) }]), 'Your 3 pages are going live… usually under a minute');
  assert.equal(goingLiveLabel([{ desc: 'Your page edit' }]), '“Your page edit” is going live… usually under a minute');
  assert.equal(goingLiveLabel([{ desc: 'a', going: 'x' }, { desc: 'b' }]), '2 changes are going live… usually under a minute');
});

test('after a set the done line is left to be read before the "going live" line', () => {
  assert.ok(SET_DONE_STAYS >= 3000);
  assert.match(main, /watchDeploy\(res\.commit\.sha, file\.text, setDeployName\(res\.files\.length\), \{ going: setGoingLine\(res\.files\.length\), stays: SET_DONE_STAYS \}\)/);
  assert.match(main, /if \(keep\.length && !failed && !keep\.every\(e => Number\(e\.quiet\) > Date\.now\(\)\)\)/);
  // A one-page publish passes no set: no quiet, no line of its own.
  assert.match(main, /watchDeploy\(result\?\.commit\?\.sha, result\?\.text, record\.restoring \? RESTORE_DEPLOY_NAME : undefined\)/);
});

test('the set sheet title counts each waiting change once, a held-back one included', () => {
  const text = { type: 'text', before: 'a', after: 'b' };
  const held = { type: 'note', tone: 'remove', text: HELD_TEXT };
  assert.equal(setSheetTitle([{ here: true, items: [{ parts: [text] }] }, { items: [{ parts: [held] }] }]), '2 changes on 2 pages');
  // A row of another page with a text and a link change is one part of the copy: one change.
  assert.equal(setSheetTitle([{ items: [{ parts: [text, text] }] }]), '1 change on 1 page');
  assert.equal(setSheetTitle([{ here: true, items: [{ parts: [text, text] }] }]), '2 changes on 1 page');
});

test('a held-back row shows its name and the held line, never a before or after', () => {
  const at = main.indexOf('function savedRows(');
  const body = main.slice(at, main.indexOf('\n}\n', at));
  assert.match(body, /if \(held\.includes\(key\)\) \{\s*\n\s*rows\.push\(\{[^\n]*parts: \[\{ type: 'note', tone: 'remove', text: HELD_TEXT \}\][^\n]*\n\s*continue;/);
});

test('the set conflict question has its own words; the generated-site one is unchanged', () => {
  const c = setTheirsOrMine({ part: 'About headline', page: 'Our story', theirs: 'Theirs words', mine: 'Mine words' });
  assert.equal(c.body, 'About headline on “Our story” was changed by someone else since you edited it.');
  assert.equal(c.note, 'Keep theirs discards your edit. Use mine publishes yours in its place.');
  assert.deepEqual([c.title, c.keep, c.use, c.theirs, c.mine], ['Someone else changed this', 'Keep theirs', 'Use mine', 'Theirs words', 'Mine words']);
  assert.doesNotMatch(JSON.stringify(c), /drops|after this page was made/);
  assert.equal(setTheirsOrMine({ part: 'Headline', page: null, theirs: '', mine: 'x' }).body, 'Headline on this page was changed by someone else since you edited it.');
  assert.equal(setTheirsOrMine({ part: 'H', page: 'P', theirs: '', mine: 'x' }).theirs, '(nothing)');
  assert.ok(setTheirsOrMine({ part: 'H', page: 'P', theirs: 'y'.repeat(700), mine: 'x' }).theirs.endsWith('…'));
  assert.match(theirsOrMine({ label: 'X', theirs: 'a', mine: 'b' }).body, /after this page was made/);
  assert.match(main, /askWhich\(modal, setTheirsOrMine\(\{ part: readableName\(c\.key\), page,/);
});

test('while a set is being sent Cancel and the close button do nothing', () => {
  assert.match(sheet, /for \(const b of \[go, only, \.\.\.shut\]\) b\.disabled = on;/);
  assert.match(sheet, /finally \{ if \(busy\) sending\(false\); \}/);
  assert.match(main, /if \(wrap\.dataset\.busy\) return;/);
  assert.match(main, /if \(e\.key === 'Escape'\) \{ e\.stopPropagation\(\); if \(!wrap\.dataset\.busy\) close\(\); return; \}/);
});

test('a tab with edits of its own hears that another tab published them, even with nothing waiting elsewhere', () => {
  assert.match(main, /if \(others\.length \|\| \(anything && mayPublishSet\(\)\)\) hearOtherTabs\(\);/);
});
