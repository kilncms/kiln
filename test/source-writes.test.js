/**
 * What POST /source/commit writes into a content file: the value that was
 * meant, in the quoting its line had, and nothing else in the file.
 *
 * Each case is a file before and the same file after, through the REAL worker
 * handler over an in-memory GitHub, and the lines that differ are exactly the
 * edited ones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import { editorEnv, withFetch, call, REPO } from './worker-harness.js';
import { fakeGitHub } from './github-fake.js';
import { typedEditProblems } from '../worker/source.js';
import { safeUrl } from '../src/engine.js';
import { checkFragment } from '../worker/sanitize-guard.js';
import { applyYamlEdits, serializeScalar } from '../src/adapters/yaml-splice.js';
import astro from '../src/adapters/astro.js';

const FILE = 'src/content/events/one.md';
const ENTRY = `---
# the public name
title: Interfaith Worship Service
date: 2026-09-20
start: '18:00'
doors: 17:30
venue: "Big Bethel AME"
seats: 150
ticketed: "150"
free: yes
tickets: https://example.org/tickets
code: Bring a candle
---

The service opens the week of remembrance.
`;

/** Line numbers (from 1) that differ between two texts of the same length in lines. */
function changedLines(before, after) {
  const a = before.split('\n'); const b = after.split('\n');
  assert.equal(b.length, a.length, `the file went from ${a.length} lines to ${b.length}`);
  return a.map((l, i) => (l === b[i] ? 0 : i + 1)).filter(Boolean);
}
const lineOf = (text, start) => text.split('\n').findIndex(l => l.startsWith(start)) + 1;

/** One publish of `edits` to a repository holding `text`; returns the answer and the file after. */
async function publish(edits, text = ENTRY, file = FILE) {
  const gh = fakeGitHub({ repo: REPO, files: { [file]: text } });
  const r = await withFetch(gh.handler, () => call(editorEnv(), 'POST', '/source/commit', { body: { repo: REPO, adapter: 'astro', file, edits } }));
  return { ...r, after: gh.read(file), commits: gh.commits.size - 1 };
}

// ─── A url is a url ──────────────────────────────────────────────────────────

test('a url field refuses words: the file is not touched, and the reason is one the editor can show', async () => {
  for (const value of ['Get tickets', 'tickets', 'www.example.org', 'example.org/tickets', 'https:', 'http://', 'mailto:', '//example.org/x', 'https://exa mple.org']) {
    const r = await publish([{ pointer: '/frontmatter/tickets', value, type: 'url' }]);
    assert.equal(r.status, 422, `should refuse ${JSON.stringify(value)}`);
    assert.equal(r.after, ENTRY, `the file is as it was after ${JSON.stringify(value)}`);
    assert.equal(r.commits, 0);
    assert.equal(r.json.skipped.length, 1);
    // An editor from before this rule reads the first words and says its own sentence about addresses.
    assert.match(r.json.skipped[0].reason, /^not a safe URL: it needs to start with http:, https:, mailto: or tel:, or be a path on this site such as \/about$/);
  }
});

test('a url field takes a web address, an email or phone link, and a path on the site: one line changes', async () => {
  for (const value of ['https://example.org/seats', 'http://example.org/', 'mailto:hello@example.org', 'tel:+14045550100', '/tickets/', '/', './tickets', '../tickets', '#tickets', '?day=2']) {
    const r = await publish([{ pointer: '/frontmatter/tickets', value, type: 'url' }]);
    assert.equal(r.status, 200, `should take ${value}: ${JSON.stringify(r.json)}`);
    assert.deepEqual(changedLines(ENTRY, r.after), [lineOf(ENTRY, 'tickets:')]);
    assert.equal(parseYaml(r.after.split('---')[1]).tickets, value);
  }
});

test('a url that would run code is still refused, with the reason it always had', () => {
  for (const value of ['javascript:alert(1)', 'JAVASCRIPT:x', 'data:text/html,x', 'vbscript:x', 'ftp://example.org/x']) {
    assert.deepEqual(typedEditProblems([{ pointer: '/frontmatter/tickets', value, type: 'url' }], { safeUrl, checkFragment }),
      [{ key: '/frontmatter/tickets', reason: 'not a safe URL' }]);
  }
});

// ─── A value keeps the quoting its line had ──────────────────────────────────

test("a time on a single-quoted line stays single-quoted: start: '18:00' becomes start: '18:30'", async () => {
  const r = await publish([{ pointer: '/frontmatter/start', value: '18:30', type: 'time' }]);
  assert.equal(r.status, 200);
  assert.equal(r.after, ENTRY.replace("start: '18:00'", "start: '18:30'"));
  assert.deepEqual(changedLines(ENTRY, r.after), [lineOf(ENTRY, 'start:')]);
});

test('a time on an unquoted line is quoted, so no reader takes 17:45 for the number 1065', async () => {
  const r = await publish([{ pointer: '/frontmatter/doors', value: '17:45', type: 'time' }]);
  assert.equal(r.after, ENTRY.replace('doors: 17:30', 'doors: "17:45"'));
  assert.deepEqual(changedLines(ENTRY, r.after), [lineOf(ENTRY, 'doors:')]);
  // A YAML 1.1 reader takes an unquoted 17:45 for sixty-based digits; quoted, it is text for both.
  assert.equal(parseYaml(r.after.split('---')[1], { version: '1.1' }).doors, '17:45');
  assert.equal(parseYaml('doors: 17:45', { version: '1.1' }).doors, 1065);
});

test('a double-quoted line stays double-quoted and an unquoted one stays unquoted', async () => {
  const r = await publish([
    { pointer: '/frontmatter/venue', value: 'Ebenezer Baptist' },
    { pointer: '/frontmatter/title', value: 'Evening Worship Service' },
    { pointer: '/frontmatter/date', value: '2026-09-21', type: 'date' },
  ]);
  assert.equal(r.after, ENTRY.replace('venue: "Big Bethel AME"', 'venue: "Ebenezer Baptist"')
    .replace('title: Interfaith Worship Service', 'title: Evening Worship Service').replace('date: 2026-09-20', 'date: 2026-09-21'));
  assert.deepEqual(changedLines(ENTRY, r.after), [lineOf(ENTRY, 'title:'), lineOf(ENTRY, 'date:'), lineOf(ENTRY, 'venue:')]);
});

test('a number on a quoted line stays quoted (the site reads it as text), and a bare one stays bare', async () => {
  const r = await publish([
    { pointer: '/frontmatter/ticketed', value: 175, type: 'number' },
    { pointer: '/frontmatter/seats', value: 175, type: 'number' },
  ]);
  assert.equal(r.after, ENTRY.replace('ticketed: "150"', 'ticketed: "175"').replace('seats: 150', 'seats: 175'));
});

test("an apostrophe on a single-quoted line is written the way YAML writes it there", () => {
  const src = "venue: 'The Gathering Spot'\n";
  const r = applyYamlEdits(src, [{ key: 'v', segs: ['venue'], value: "The People's Hall" }]);
  assert.equal(r.text, "venue: 'The People''s Hall'\n");
  assert.equal(parseYaml(r.text).venue, "The People's Hall");
  // A line break cannot stay on one single-quoted line: it is written double-quoted.
  const two = applyYamlEdits(src, [{ key: 'v', segs: ['venue'], value: 'One\nTwo' }]);
  assert.equal(two.text, 'venue: "One\\nTwo"\n');
  assert.equal(parseYaml(two.text).venue, 'One\nTwo');
});

test('text that a YAML reader could take for something else is quoted on an unquoted line', async () => {
  // A time, yes/no/on/off, a number with a leading zero, a date, and the other spellings of numbers.
  for (const value of ['18:30', '1:30:00', 'yes', 'No', 'on', 'OFF', 'y', 'N', 'true', 'null', '~', '007', '0123', '1_000', '0x1F', '0o17', '.5', '1e3', '+12', '2026-09-20', '2026-9-2', '3.14']) {
    const r = await publish([{ pointer: '/frontmatter/code', value }]);
    assert.equal(r.status, 200, value);
    assert.equal(r.after, ENTRY.replace('code: Bring a candle', `code: ${JSON.stringify(value)}`), `${value} should be quoted`);
    assert.deepEqual(changedLines(ENTRY, r.after), [lineOf(ENTRY, 'code:')]);
    for (const version of ['1.1', '1.2']) assert.equal(parseYaml(r.after.split('---')[1], { version }).code, value, `${value} read back by YAML ${version}`);
  }
  // Ordinary words stay as they are written.
  for (const value of ['Bring a friend', 'Doors at 6', 'Room 12', 'yes please', 'No. 5']) {
    const r = await publish([{ pointer: '/frontmatter/code', value }]);
    assert.equal(r.after, ENTRY.replace('code: Bring a candle', `code: ${value}`), value);
  }
});

test('text that begins with a hash is quoted: unquoted it would be a comment, and the field would be empty', async () => {
  const r = await publish([{ pointer: '/frontmatter/title', value: '#1 in Atlanta' }]);
  assert.equal(r.status, 200);
  assert.equal(r.after, ENTRY.replace('title: Interfaith Worship Service', 'title: "#1 in Atlanta"'));
  assert.equal(parseYaml(r.after.split('---')[1]).title, '#1 in Atlanta');
  assert.deepEqual(changedLines(ENTRY, r.after), [lineOf(ENTRY, 'title:')]);
});

test('inside a bracketed list a value with a comma is quoted, so the list keeps its length', () => {
  const src = 'tags: [faith, memory, city]\nmeta: { a: one, b: two }\n';
  const r = applyYamlEdits(src, [{ key: 't', segs: ['tags', '1'], value: 'memory, hope' }, { key: 'm', segs: ['meta', 'b'], value: 'two {2}' }]);
  assert.equal(r.text, 'tags: [faith, "memory, hope", city]\nmeta: { a: one, b: "two {2}" }\n');
  assert.deepEqual(parseYaml(r.text), { tags: ['faith', 'memory, hope', 'city'], meta: { a: 'one', b: 'two {2}' } });
  // Outside brackets a comma is only a comma.
  assert.equal(applyYamlEdits('venue: Hall\n', [{ key: 'v', segs: ['venue'], value: 'Hall, upstairs' }]).text, 'venue: Hall, upstairs\n');
});

test('serializeScalar: the style of the line decides, then the kind of value', () => {
  assert.equal(serializeScalar('18:30', { type: 'time', originalStyle: 'single' }), "'18:30'");
  assert.equal(serializeScalar('18:30', { type: 'time', originalStyle: 'double' }), '"18:30"');
  assert.equal(serializeScalar('18:30', { type: 'time', originalStyle: 'plain' }), '"18:30"');
  assert.equal(serializeScalar('18:30', { type: 'time' }), '"18:30"');
  assert.equal(serializeScalar('2026-09-21', { type: 'date', originalStyle: 'plain' }), '2026-09-21');
  assert.equal(serializeScalar('2026-09-21', { type: 'date', originalStyle: 'single' }), "'2026-09-21'");
  assert.equal(serializeScalar(true, { type: 'boolean', originalStyle: 'plain' }), 'true');
  assert.equal(serializeScalar(12, { type: 'number', originalStyle: 'plain' }), '12');
  assert.equal(serializeScalar(12, { type: 'number', originalStyle: 'double' }), '"12"');
  assert.equal(serializeScalar('Hall', { originalStyle: 'single' }), "'Hall'");
  assert.equal(serializeScalar('not a time\n', { type: 'time', originalStyle: 'single' }), null);
});

// ─── A body is written where the body was ────────────────────────────────────

test('writing a body keeps the blank line after the frontmatter and the end of the file: one line changes', async () => {
  const r = await publish([{ pointer: '/body', value: 'Doors open at six.' }]);
  assert.equal(r.status, 200);
  assert.equal(r.after, ENTRY.replace('The service opens the week of remembrance.', 'Doors open at six.'));
  assert.deepEqual(changedLines(ENTRY, r.after), [lineOf(ENTRY, 'The service opens')]);
});

test('a body keeps what the file had around it, whatever that was', () => {
  const body = (text, value) => astro.applyEdits(text, [{ pointer: '/body', value }], 'e.md').content;
  // No blank line after the frontmatter: none is added.
  assert.equal(body('---\ntitle: A\n---\nOld words.\n', 'New words.'), '---\ntitle: A\n---\nNew words.\n');
  // Two blank lines, and no line break at the end of the file: both kept.
  assert.equal(body('---\ntitle: A\n---\n\n\nOld words.', 'New words.'), '---\ntitle: A\n---\n\n\nNew words.');
  // Blank lines after the text are kept too.
  assert.equal(body('---\ntitle: A\n---\n\nOld words.\n\n', 'New words.'), '---\ntitle: A\n---\n\nNew words.\n\n');
  // Windows line endings around the text stay.
  assert.equal(body('---\r\ntitle: A\r\n---\r\n\r\nOld words.\r\n', 'New words.'), '---\r\ntitle: A\r\n---\r\n\r\nNew words.\r\n');
  // Blank lines sent around the new text are not added to the file's own.
  assert.equal(body('---\ntitle: A\n---\n\nOld words.\n', '\n\nNew words.\n\n'), '---\ntitle: A\n---\n\nNew words.\n');
  // A text of several paragraphs is written whole.
  assert.equal(body('---\ntitle: A\n---\n\nOld words.\n', 'One.\n\nTwo.'), '---\ntitle: A\n---\n\nOne.\n\nTwo.\n');
  // A file with no text yet gets the text and a line break, after whatever blank line it had.
  assert.equal(body('---\ntitle: A\n---\n', 'New words.'), '---\ntitle: A\n---\nNew words.\n');
  assert.equal(body('---\ntitle: A\n---\n\n', 'New words.'), '---\ntitle: A\n---\n\nNew words.\n');
  // The text taken away leaves the frontmatter and its blank line.
  assert.equal(body('---\ntitle: A\n---\n\nOld words.\n', ''), '---\ntitle: A\n---\n\n');
  // An indented first line is the text's own and is kept.
  assert.equal(body('---\ntitle: A\n---\n\nOld words.\n', '    code'), '---\ntitle: A\n---\n\n    code\n');
});

test('a field and the body in one publish: exactly their lines change', async () => {
  const r = await publish([
    { pointer: '/frontmatter/start', value: '19:00', type: 'time' },
    { pointer: '/body', value: 'Doors open at six.' },
  ]);
  assert.deepEqual(changedLines(ENTRY, r.after), [lineOf(ENTRY, 'start:'), lineOf(ENTRY, 'The service opens')]);
  assert.equal(r.after, ENTRY.replace("'18:00'", "'19:00'").replace('The service opens the week of remembrance.', 'Doors open at six.'));
});
