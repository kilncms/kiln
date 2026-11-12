/**
 * A picture inside a paragraph can be described
 * (src/editor/describe-picture.js, and where main.js uses it).
 *
 * A stand-alone picture has a box for its description on its toolbar, and is
 * asked about when it is replaced. A picture put inside a paragraph had a
 * small bar with widths and a remove button and nothing else, so it went
 * live with no description and there was no way to give it one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeCopy, describeOwnCopy, describeButton, DESCRIBE_BUTTON, describeHint, describedWords } from '../src/editor/describe-picture.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = readFileSync(path.join(ROOT, 'src', 'editor', 'main.js'), 'utf8');
const module_ = readFileSync(path.join(ROOT, 'src', 'editor', 'describe-picture.js'), 'utf8');

test('the dialog for a picture that is already there speaks of this picture, not of one that was replaced', () => {
  const c = describeOwnCopy('  A jar of   dills ');
  assert.equal(c.title, 'Describe this picture');
  assert.equal(c.value, 'A jar of dills');
  assert.match(c.before, /^The words in the box are what this picture says now\./);
  assert.equal(c.cancel, 'Cancel');
  assert.equal(describeOwnCopy('').before, 'This picture has no description yet.');
  assert.equal(describeOwnCopy(null).value, '');
  // what is the same for both: why to describe it, the label, and when to leave it empty
  const replaced = describeCopy('x'), own = describeOwnCopy('x');
  assert.equal(own.body, replaced.body);
  assert.equal(own.label, replaced.label);
  assert.equal(own.empty, replaced.empty);
  for (const s of [c.title, c.before, describeOwnCopy('').before]) assert.doesNotMatch(s, /new picture|was here before/);
});

test('the main button says what it will do, as it does for a replaced picture', () => {
  assert.equal(describeButton('A jar of dills', 'A jar of dills'), 'Keep this description');
  assert.equal(describeButton('A red jar', ''), 'Use this description');
  assert.equal(describeButton('', 'A jar'), 'Save with no description');
});

test('the bar\'s button says whether the picture is described, and the status line what happened', () => {
  assert.equal(DESCRIBE_BUTTON, 'Describe');
  assert.match(describeHint(''), /^This picture has no description\. Press to say what it shows/);
  assert.match(describeHint('  A jar of dills '), /^This picture is described as “A jar of dills”\./);
  assert.match(describedWords('A jar of dills'), /^The picture has its description\./);
  assert.match(describedWords(''), /^The picture has no description, as you chose\./);
  for (const s of [describeHint(''), describeHint('x'), describedWords('x'), describedWords('')]) {
    assert.doesNotMatch(s, /—|alt text|\balt\b|attribute/i);
  }
});

test('askDescription takes the words to show, and by default asks as it always did', () => {
  assert.match(module_, /export function askDescription\(modal, oldAlt, copy = describeCopy\(oldAlt\)\) \{/);
  assert.doesNotMatch(module_, /const copy = describeCopy\(oldAlt\);/);
});

test('main.js: the small bar of a picture inside a paragraph has Describe, and the answer is kept with the paragraph', () => {
  const bar = main.slice(main.indexOf('async function describeInline('), main.indexOf('function markGalleryPhoto('));
  // the button, between the widths and remove, saying what the picture says now
  assert.match(bar, /data-describe="1" title="\$\{escapeHtml\(describeHint\(img\.getAttribute\('alt'\)\)\)\}">\$\{DESCRIBE_BUTTON\}<\/button>\s*<button class="kiln-tb-fmt" data-x="1"/);
  assert.match(bar, /if \(b\.dataset\.describe\) \{ describeInline\(img\); return; \}/);
  // pressed before the width and remove branches can run for it
  assert.ok(bar.indexOf('b.dataset.describe') < bar.indexOf('b.dataset.x)'));
  // the dialog is the editor's own, with this picture's words, and does not end the paragraph's editing
  assert.match(bar, /askDescription\(ask, was, describeOwnCopy\(was\)\)/);
  assert.match(bar, /m\.classList\.add\('kiln-keeps-edit'\)/);
  // put away unanswered, or the picture gone meanwhile: nothing changes
  assert.match(bar, /if \(typed === null \|\| !img\.isConnected\) return;/);
  assert.match(bar, /img\.setAttribute\('alt', typed\)/);
  // a paragraph that is no longer being edited is committed, so the description is staged
  assert.match(bar, /if \(field && !state\.active\) commitEdit\(field, field\.getAttribute\('data-cms'\)\)/);
  assert.match(bar, /setStatus\(describedWords\(typed\), 'saved'\)/);
});

test('a replaced stand-alone picture is still asked in the words it had', () => {
  assert.match(main, /const typed = await askDescription\(modal, oldAlt\);/);
  assert.equal(describeCopy('x').title, 'Describe the new picture');
});
