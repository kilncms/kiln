/**
 * One number for the unpublished edits (src/editor/edit-count.js).
 *
 * A tester saw "Discard 2 edits" on the button, "Discard 1 unpublished edit?"
 * in the dialog it opened, and "1 edit restored" on the line just before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { editsWord, discardLabel, discardQuestion, unpublishedHeading, restoredLine } from '../src/editor/edit-count.js';
import { draftRecord, readDraft } from '../src/editor/saved-edits.js';

const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
const between = (from, to) => main.slice(main.indexOf(from), main.indexOf(to, main.indexOf(from)));

test('edit count: the button, its question, the Done question and the restored line say the same number', () => {
  for (const n of [1, 2, 7]) {
    const said = [discardLabel(n), discardQuestion(n), unpublishedHeading(n), restoredLine(n), restoredLine(n, 2)];
    for (const line of said) {
      assert.equal(line.match(/\d+/)[0], String(n), line);
      assert.equal(/\bedits\b/.test(line), n !== 1, line);
      assert.doesNotMatch(line, /—/);
    }
  }
  assert.equal(discardLabel(2), 'Discard 2 edits');
  assert.equal(discardQuestion(2), 'Discard 2 unpublished edits?');
  assert.equal(discardQuestion(1), 'Discard 1 unpublished edit?');
  assert.equal(restoredLine(2), '2 edits restored. Publish when ready.');
  assert.equal(restoredLine(1, 1), '1 edit restored, with the files they added. Publish when ready.');
  assert.equal(editsWord(1), '1 edit');
});

test('edit count: with only an uploaded file waiting, nothing claims a number', () => {
  assert.equal(discardLabel(0), 'Discard edits');
  assert.equal(discardQuestion(0), 'Discard what is not published yet?');
  assert.equal(unpublishedHeading(0), 'You have changes that are not published yet');
});

test('edit count: the saved copy remembers the number the Publish button showed', () => {
  // one picture, with a new file and a new description: one part of the page, two things in the publish sheet
  const pending = new Map([['story_img', { attrs: { src: '/assets/uploads/img-1.webp', alt: 'A red square' } }]]);
  const kept = JSON.parse(JSON.stringify(draftRecord(pending, new Map(), 1000, null, 2)));
  assert.equal(kept.n, 2);
  assert.equal(readDraft(kept, { now: 2000 }).count, 2, 'the offer to bring it back says 2, as the button did');
  // a copy saved by an older editor has no number: its parts are counted, as before
  assert.equal(readDraft(JSON.parse(JSON.stringify(draftRecord(pending, new Map(), 1000))), { now: 2000 }).count, 1);
  assert.equal('n' in draftRecord(pending, new Map(), 1000), false);
  // an edit left behind (its field is not on this page any more) makes the kept number wrong: the parts are counted
  const both = draftRecord(pending, new Map([['posts/a.md#title', { value: 'T' }]]), 1000, null, 3);
  assert.equal(readDraft(JSON.parse(JSON.stringify(both)), { now: 2000 }).count, 3);
  assert.equal(readDraft(JSON.parse(JSON.stringify(both)), { now: 2000, known: () => false }).count, 1);
  // nothing staged, only words being typed: no number
  assert.equal(readDraft({ ts: 1000, edits: {}, n: 4, typed: null }, { now: 2000 }), null);
  for (const bad of [0, -1, 1.5, '2', null]) assert.equal(readDraft({ ...kept, n: bad }, { now: 2000 }).count, 1);
});

test('edit count: the editor counts in one way in all four places', () => {
  const discard = between('function discardEdits()', 'function positionToolbar(');
  assert.match(discard, /const nAll = changeCount\(\);/);
  assert.match(discard, /<h3>\$\{discardQuestion\(nAll\)\}<\/h3>/);
  assert.doesNotMatch(discard, /state\.pending\.size \+ state\.pendingSource\.size/);
  const button = between('function refreshPublishButton()', '// Draft + Schedule + Share preview');
  assert.match(button, /const n = changeCount\(\);/);
  assert.match(button, /discard\.textContent = discardLabel\(n\);/);
  const done = between('function doneEditing()', 'Keep editing');
  assert.match(done, /const nDone = changeCount\(\);/);
  assert.match(done, /unpublishedHeading\(nDone\)/);
  const back = between('async function restoreSaved(', '// What was typed into a panel is put back');
  assert.match(back, /const nBack = saved\.count \? changeCount\(\) \|\| saved\.count : 0;/);
  assert.match(back, /setStatus\(restoredLine\(nBack, files\.length\), 'saved'\)/);
  assert.match(back, /backAfterSignIn\(nBack, files\.length, typedName\)/);
  assert.doesNotMatch(main, /edit\$\{saved\.count > 1 \? 's' : ''\} restored/);
  assert.match(main, /draftRecord\(withOpenBox\(state\.pending\), state\.pendingSource, Date\.now\(\), state\.typed, state\.shownCount\)/);
});
