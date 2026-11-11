import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCopy, describeButton, describedAlt, LATER_WORDS } from '../src/editor/describe-picture.js';

test('the new picture is asked about with the old description as a start', () => {
  const c = describeCopy('  A jar of   dills ');
  assert.equal(c.value, 'A jar of dills');
  assert.match(c.body, /^Describe this picture for people who cannot see it\./);
  assert.match(c.before, /Keep them if they still fit, change them, or clear the box\./);
  assert.match(describeCopy('').before, /had no description/);
  assert.equal(describeCopy(null).value, '');
});

test('the button says what it will do with the words in the box', () => {
  assert.equal(describeButton('A jar of dills', 'A jar of dills'), 'Keep this description');
  assert.equal(describeButton(' A jar  of dills', 'A jar of dills'), 'Keep this description');
  assert.equal(describeButton('A red jar', 'A jar of dills'), 'Use this description');
  assert.equal(describeButton('   ', 'A jar of dills'), 'Save with no description');
  assert.equal(describeButton('', ''), 'Save with no description');
});

test('the description is written as one tidy line', () => {
  assert.equal(describedAlt('  A red\njar  '), 'A red jar');
  assert.equal(describedAlt(''), '');
});

test('nothing a person reads about describing a picture says "alt text"', () => {
  const c = describeCopy('x');
  const all = [c.title, c.body, c.before, c.label, c.empty, c.cancel, LATER_WORDS,
    describeButton('', 'x'), describeButton('x', 'x'), describeButton('y', 'x')].join(' ');
  assert.doesNotMatch(all, /alt text|\balt\b/i);
});
