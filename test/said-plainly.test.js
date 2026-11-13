/**
 * Sentences testers wrote down as wrong or not plain (0.6.3), each said
 * plainly now: src/editor/said-plainly.js, and the places they are written.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addedSectionLine, scheduleHow, scheduledWhen } from '../src/editor/said-plainly.js';
import { editCommitMessage } from '../src/editor/firstrun.js';

const src = (f) => readFileSync(new URL(`../src/editor/${f}`, import.meta.url), 'utf8');
const main = src('main.js'), suggest = src('suggest.js'), theme = src('theme.js'), sheet = src('publish-sheet.js');

test('said plainly: adding a gallery or an events list is said right for each kind', () => {
  assert.equal(addedSectionLine('events'), 'Added an events list. Click “+ Add event”, then Publish.');
  assert.equal(addedSectionLine('gallery'), 'Added a gallery. Click “+ Add photos”, then Publish.');
  assert.equal(addedSectionLine('something new'), 'Added. Publish to keep it.');
  for (const kind of ['events', 'gallery', 'x']) assert.doesNotMatch(addedSectionLine(kind), /[—–]| - |\ba events\b/);
  assert.match(main, /: addedSectionLine\(kind\), 'saved'\);/);
  assert.equal(main.includes('Added a ${kind}'), false);
});

test('said plainly: a schedule dialog says when, give or take five minutes, for one edit or several', () => {
  assert.equal(scheduleHow(1), 'Kiln publishes it at the time you pick, give or take five minutes.');
  assert.equal(scheduleHow(3), 'Kiln publishes them at the time you pick, give or take five minutes.');
  assert.equal(main.match(/\$\{scheduleHow\(/g).length, 2, 'both schedule dialogs');
  assert.doesNotMatch(main, /checks every 5 minutes/i);
});

test('said plainly: a scheduled time is said to the minute, with no dash after it', () => {
  const said = scheduledWhen(new Date(2026, 10, 12, 20, 38, 0), 'en-US');
  assert.equal(said, '11/12/2026, 8:38 PM');
  assert.equal(scheduledWhen(new Date(2026, 10, 12, 20, 38, 59).getTime(), 'en-US'), '11/12/2026, 8:38 PM');
  // The page's own schedule dialog says the time in words now, and what the page shows until then (scheduled-changes.js).
  assert.ok(main.includes('const line = scheduledLine(data.at);'));
  assert.ok(main.includes('`Scheduled for ${scheduledWhen(when)}. You can close this.`'));
  assert.doesNotMatch(main, /Scheduled for \$\{new Date/);
});

test('said plainly: a commit message names each part once, in the order it was first changed', () => {
  assert.equal(editCommitMessage('index.html', ['story_img', 'story_img', 'story_img', 'story_img']), 'Edit index.html: story_img (via Kiln)');
  assert.equal(editCommitMessage('index.html', ['a', 'b', 'a', 'c', 'b']), 'Edit index.html: a, b, c (via Kiln)');
});

test('said plainly: what is saved is called saved', () => {
  assert.doesNotMatch(main, /Committed/);
  assert.doesNotMatch(theme, /Committed/);
  assert.ok(main.includes('Saved ✓ The site is rebuilding, which usually takes under a minute.'));
  assert.ok(main.includes('Step 2 of 3 · Saved ✓ The site is rebuilding.'));
  assert.ok(main.includes("'Saved ✓ You can close this. Kiln will say when it is live.'"));
  assert.ok(main.includes("'Saved ✓ Everyone gets it once the site has rebuilt, in about a minute.'"));
  assert.ok(theme.includes("✓ Live in about a minute.`"));
  assert.ok(main.includes("'Publishing: saving to GitHub…'"));
});

test('said plainly: the suggestions dialog says what approving and declining do', () => {
  assert.ok(suggest.replace(/\s+/g, ' ').includes('Approving a suggestion publishes the suggested change on top of the page as it is now, '
    + 'saved in the name of the person who suggested it. Declining publishes nothing.'));
  assert.doesNotMatch(suggest, /Approving merges|keeps authorship|records your call/);
});

test('said plainly: the button beside each change in the publish sheet says what it does', () => {
  assert.ok(sheet.includes("el('button', 'kiln-ps-drop', 'Discard this edit')"));
  assert.ok(sheet.includes('`Discard the edit to ${item.label}`'));
  assert.ok(sheet.includes("drop.title = 'This edit is taken off the page, and that part goes back to what it said before. Your other edits stay.'"));
  assert.doesNotMatch(sheet, /'Drop'|Drop the edit/);
});

test('said plainly: no line the editor says has a dash in it', () => {
  for (const [name, text] of [['main.js', main], ['suggest.js', suggest], ['theme.js', theme], ['publish-sheet.js', sheet]]) {
    text.split('\n').forEach((line, i) => {
      if (!/setStatus\(|\.textContent = |\.innerHTML = |\.title = |notices\.push\(/.test(line)) return;
      assert.doesNotMatch(line.replace(/\/\/[^'"`]*$/, ''), /—/, `${name}:${i + 1}`);
    });
  }
});
