/**
 * A failure is told in a sentence, never as the text of an exception
 * (src/editor/plain-failure.js). "Draft failed: Cannot read properties of
 * null (reading 'request')" is what a visitor to the demo was shown. The
 * editor's sources are read here to show that no error's own message is put
 * in front of a person anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { whyNot, notDone, said } from '../src/editor/plain-failure.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EDITOR = path.join(ROOT, 'src', 'editor');
const sources = () => readdirSync(EDITOR).filter(f => f.endsWith('.js')).map(f => ({ file: f, lines: readFileSync(path.join(EDITOR, f), 'utf8').split('\n') }));

const answer = (status, data = {}, message = `GitHub ${status}: Something`) => Object.assign(new Error(message), { status, data });

function assertPlain(text) {
  assert.equal(/!/.test(text), false, `an exclamation mark in: ${text}`);
  assert.equal(/[—–]|\s-\s/.test(text), false, `a dash as punctuation in: ${text}`);
  assert.equal(/Cannot read|undefined|null|TypeError|GitHub \d|\bfetch\b/.test(text), false, `an exception's own words in: ${text}`);
  assert.match(text, /\.$/, `ends as a sentence: ${text}`);
}

test('plain failure: a fault inside the editor is never printed', () => {
  // what the demo showed for Save as draft
  const fault = new TypeError("Cannot read properties of null (reading 'request')");
  const line = notDone('The draft was not saved.', fault);
  assert.equal(line, 'The draft was not saved. Kiln had a problem of its own, so please reload the page and try again.');
  assertPlain(line);
  assertPlain(whyNot(new RangeError('Maximum call stack size exceeded')));
  assertPlain(whyNot(undefined));
  assertPlain(whyNot({}));
});

test('plain failure: an answer from the site is told by what it means, not by its number and GitHub\'s words', () => {
  assert.equal(whyNot(answer(404, { message: 'Not Found' })), 'The site could not find it.');
  assert.equal(whyNot(answer(422, { message: 'Reference already exists' })), 'The site did not accept it. It may have changed while you were working, so please reload the page and try again.');
  assert.equal(whyNot(answer(409, { message: 'is at abc but expected def' })), whyNot(answer(422)));
  assert.equal(whyNot(answer(413)), 'It is too large for the site to take.');
  assert.equal(whyNot(answer(400, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' })), 'The site did not accept it.');
  for (const s of [400, 404, 409, 413, 422]) assertPlain(whyNot(answer(s, { message: 'Validation Failed' })));
});

test('plain failure: the worker\'s own words are passed on, as what the site answered', () => {
  const err = answer(400, { error: 'that time is in the past' }, 'that time is in the past');
  assert.equal(whyNot(err), 'The site did not accept it. The answer was: that time is in the past.');
});

test('plain failure: trouble on the way, a refusal and an ended sign-in are said in the editor\'s usual words', () => {
  assert.equal(whyNot(new TypeError('Failed to fetch')), 'The site could not be reached, so please check your connection and try again.');
  assert.equal(whyNot(answer(502)), 'The site had a problem just now, so please try again in a moment.');
  assert.equal(whyNot(answer(429)), 'Too much was asked of the site just now, so please try again in a minute.');
  assert.equal(whyNot(answer(403, { error: 'editors cannot add scripts' })), 'The site did not allow it. The answer was: editors cannot add scripts.');
  assert.equal(whyNot(answer(403)), 'The site did not allow it.');
  assert.equal(whyNot(answer(401)), 'Your sign-in has ended.');
});

test('plain failure: an explanation the editor gives itself reaches the person as written', () => {
  assert.equal(whyNot(said('/about.html is already a page on this site, so please pick another title')), '/about.html is already a page on this site, so please pick another title.');
  assert.equal(notDone('Nothing was created.', said('The blog page has no list for posts to go into.')), 'Nothing was created. The blog page has no list for posts to go into.');
  // the one the file reader gives for a page that is not UTF-8
  const notUtf8 = Object.assign(new Error('This page isn’t UTF-8 encoded, so Kiln won’t edit it.'), { code: 'NOT_UTF8' });
  assert.equal(whyNot(notUtf8), 'This page isn’t UTF-8 encoded, so Kiln won’t edit it.');
  // an ordinary Error with a message is not one of those
  assert.equal(whyNot(new Error('lost track of the element')), 'Kiln had a problem of its own, so please reload the page and try again.');
});

test('plain failure: no error\'s own message is shown to a person anywhere in the editor', () => {
  // worker-call.js makes the error objects, sign-in-ended.js and plain-failure.js read them: those three may touch .message
  const reads = new Set(['worker-call.js', 'sign-in-ended.js', 'plain-failure.js']);
  const found = [];
  for (const { file, lines } of sources()) {
    if (reads.has(file)) continue;
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      const code = line.replace(/console\.(error|warn|log)\([^;]*;/g, '');
      // an error variable's .message put into a string, a status line or the page
      if (/\b(err|error|e|e2|ex)\.message\b/.test(code)) found.push(`${file}:${i + 1}: ${line.trim().slice(0, 110)}`);
      if (/see (the )?console/i.test(code)) found.push(`${file}:${i + 1}: ${line.trim().slice(0, 110)}`);
    });
  }
  assert.deepEqual(found, [], 'an exception\'s text, or "see console", reaches a person');
});

test('plain failure: the sentences the editor leads with are whole sentences', () => {
  const leads = [];
  for (const { lines } of sources()) {
    for (const line of lines) for (const m of line.matchAll(/notDone\((['`])((?:(?!\1).)*)\1,/g)) leads.push(m[2]);
  }
  assert.ok(leads.length >= 25, `only ${leads.length} found`);
  for (const lead of leads) {
    assert.match(lead, /^[A-Z].*\.$/, lead);
    assert.equal(/!|[—–]|\bfailed\b|\bFailed\b/.test(lead), false, lead);
  }
});
