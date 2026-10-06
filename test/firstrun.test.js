/**
 * src/editor/firstrun.js — the pure pieces behind the always-visible Publish
 * button: its label, and the commit message a publish gets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishLabel, editCommitMessage } from '../src/editor/firstrun.js';

test('publishLabel: says how many edits will go out', () => {
  assert.equal(publishLabel(0), 'Publish');                 // an upload with no field edit still publishes
  assert.equal(publishLabel(1), 'Publish 1 edit');
  assert.equal(publishLabel(3), 'Publish 3 edits');
  assert.equal(publishLabel(12), 'Publish 12 edits');
  for (const n of [0, 1, 2, 40]) assert.ok(publishLabel(n).startsWith('Publish'), 'the accessible name starts with "Publish"');
});

test('publishLabel: a suggest-mode editor proposes, and the label says so', () => {
  assert.equal(publishLabel(2, { suggest: true }), 'Suggest changes');
  assert.equal(publishLabel(0, { suggest: true }), 'Suggest changes');
  assert.equal(publishLabel(1, { suggest: false }), 'Publish 1 edit');
});

test('editCommitMessage: the message a page publish has always had', () => {
  assert.equal(editCommitMessage('index.html', ['hero_headline']), 'Edit index.html: hero_headline (via Kiln)');
  assert.equal(editCommitMessage('blog/post.html', ['post_title', 'post_body', '+gallery_1']),
    'Edit blog/post.html: post_title, post_body, +gallery_1 (via Kiln)');
  // A field with both a text and a link change is named once per change, as before.
  assert.equal(editCommitMessage('about.html', ['cta', 'cta']), 'Edit about.html: cta, cta (via Kiln)');
});
