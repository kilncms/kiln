/**
 * Nothing is offered that will be refused.
 *
 * A suggest-only editor on a page the site builds from content files could
 * type into a field, was offered "Suggest changes", and was then told no. A
 * comment-only editor was told to click any outlined text, with nothing
 * outlined. Each now reads, first, what they can do on the page they are on
 * (grants.js startLine), and the fields say why before anyone types
 * (source-fields.js lockReason).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLine } from '../src/editor/grants.js';
import { lockReason } from '../src/editor/source-fields.js';
import { parseSourceRef } from '../src/adapters/pointer.js';
import { sourceModeRefusal } from '../worker/source.js';

const sam = { user: 'Sam', touch: false, scopeMode: null, comments: false, pageFile: true };

test('startLine: someone who publishes or suggests on a page of its own is told to click the outlined text', () => {
  assert.equal(startLine(sam), 'Signed in as Sam. Click any outlined text to edit.');
  assert.equal(startLine({ ...sam, touch: true }), 'Signed in as Sam. Tap any outlined text to edit.');
  assert.equal(startLine({ ...sam, scopeMode: 'suggest' }), 'Signed in as Sam. Click any outlined text to edit.');
  // On a generated page, someone who publishes still edits the outlined fields.
  assert.equal(startLine({ ...sam, pageFile: false }), 'Signed in as Sam. Click any outlined text to edit.');
});

test('startLine: a comment-only editor is told about comments, never about outlines', () => {
  const reviewer = { ...sam, scopeMode: 'review', comments: true };
  assert.equal(startLine(reviewer), 'Signed in as Sam. You can comment on this page. Comments is in the menu.');
  assert.equal(startLine({ ...reviewer, pageFile: false }), 'Signed in as Sam. Comments can’t be left here yet, because the site builds this page from its content files.');
  assert.equal(startLine({ ...reviewer, comments: false }), 'Signed in as Sam. You can read this page. Nothing on it can be changed with this sign-in.');
  for (const who of [reviewer, { ...reviewer, pageFile: false }, { ...reviewer, comments: false }, { ...reviewer, touch: true }]) {
    assert.doesNotMatch(startLine(who), /outlined|edit\./);
  }
});

test('startLine: a suggest-only editor on a generated page is told that suggestions cannot be made there', () => {
  assert.equal(startLine({ ...sam, scopeMode: 'suggest', pageFile: false }),
    'Signed in as Sam. Suggestions can’t be made here yet, because the site builds this page from its content files.');
});

test('every first line is plain: no exclamation mark, no dash as punctuation', () => {
  for (const scopeMode of [null, 'suggest', 'review']) for (const pageFile of [true, false]) for (const comments of [true, false]) {
    assert.doesNotMatch(startLine({ ...sam, scopeMode, pageFile, comments }), /[!—–]| - /);
  }
});

test('lockReason: for a suggest-only editor every content field is read-only before anyone types, and says why', () => {
  const title = parseSourceRef('src/content/events/one.md#/frontmatter/title');
  const body = parseSourceRef('src/content/events/one.md#/body');
  const caps = { legacy: false, source: true, adapters: ['astro'] };
  const why = 'A suggestion can’t be made to this text yet, because it comes from the site’s content files. Ask the site’s owner to change it.';
  assert.equal(lockReason({ parsed: title, tag: 'H3', caps, seat: 'suggest' }), why);
  assert.equal(lockReason({ parsed: body, tag: 'DIV', caps, seat: 'suggest', plain: true }), why);
  // Someone who publishes edits the same fields.
  assert.equal(lockReason({ parsed: title, tag: 'H3', caps }), null);
  assert.equal(lockReason({ parsed: title, tag: 'H3', caps, seat: null }), null);
  // A worker from before source mode is the first thing to say, to anyone.
  assert.match(lockReason({ parsed: title, tag: 'H3', caps: { legacy: true, source: false, adapters: [] }, seat: 'suggest' }), /needs to update Kiln first/);
  assert.doesNotMatch(why, /[!—–]| - /);
});

test('the worker refuses exactly what the editor no longer offers: a source edit from a suggest-only or a comment-only editor', () => {
  assert.equal(sourceModeRefusal({ name: 'Sam', mode: 'suggest' }).status, 403);
  assert.equal(sourceModeRefusal({ name: 'Sam', mode: 'review' }).status, 403);
  assert.equal(sourceModeRefusal({ name: 'Sam', mode: null }), null);
});
