/**
 * The editor's side of "someone else changed this field": what it says it
 * read, how it recognises the worker's answer, and what it asks the person.
 * Pure functions (src/editor/source-fields.js, own-dialogs.js), and the two
 * sides together: the editor's own request bodies sent to the REAL worker
 * handler over an in-memory GitHub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readAs, groupSourceEdits, changedRefs, matchSkippedRefs, matchAppliedRefs, theirsText, theirsOrMine,
  typedValue, skipSentence,
} from '../src/editor/source-fields.js';
import { isAddress } from '../worker/source.js';
import { editorEnv, withFetch, call, REPO } from './worker-harness.js';
import { fakeGitHub } from './github-fake.js';

const ONE = 'src/content/events/one.md';
const TITLE = `${ONE}#/frontmatter/title`;
const VENUE = `${ONE}#/frontmatter/venue`;
const SEATS = `${ONE}#/frontmatter/seats?type=number`;
const DATE = `${ONE}#/frontmatter/date?type=date`;
const where = { repo: REPO, branch: 'main', adapter: 'astro' };

test('readAs: what a field held is the first place that shows the value itself', () => {
  // Words are the value wherever they are shown.
  assert.equal(readAs(['Interfaith Worship Service'], undefined), 'Interfaith Worship Service');
  assert.equal(readAs(['\n  Big Bethel AME\n'], 'string'), '\n  Big Bethel AME\n');
  // A date written out is not the value; the place that shows it as stored is.
  assert.equal(readAs(['September 20, 2026', '2026-09-20'], 'date'), '2026-09-20');
  assert.equal(readAs(['September 20, 2026'], 'date'), undefined);
  // A number and a yes/no are read as what they are.
  assert.equal(readAs([' 150 '], 'number'), 150);
  assert.equal(readAs(['150 seats'], 'number'), undefined);
  assert.equal(readAs(['Yes'], 'boolean'), true);
  assert.equal(readAs(['18:00'], 'time'), '18:00');
  assert.equal(readAs(['6pm'], 'time'), undefined);
  assert.equal(readAs(['https://example.org/t'], 'url'), 'https://example.org/t');
  assert.equal(readAs(['Get tickets'], 'url'), undefined);
  // A read-only place is passed as null and is not looked at; no place at all says nothing.
  assert.equal(readAs([null, 'Hall'], undefined), 'Hall');
  assert.equal(readAs([], undefined), undefined);
  assert.equal(readAs(undefined, 'date'), undefined);
  // Nothing shown is still something read: the field was empty.
  assert.equal(readAs([''], undefined), '');
});

test('groupSourceEdits: each edit says what its field held, when that is known', () => {
  const pending = new Map([[TITLE, { value: 'New title' }], [SEATS, { value: '175', type: 'number' }], [DATE, { value: '2026-09-21', type: 'date' }]]);
  const read = new Map([[TITLE, 'Interfaith Worship Service'], [SEATS, 150]]);
  const [g] = groupSourceEdits(pending, { ...where, was: (ref) => read.get(ref) });
  assert.deepEqual(g.body.edits, [
    { pointer: '/frontmatter/title', value: 'New title', key: TITLE, was: 'Interfaith Worship Service' },
    { pointer: '/frontmatter/seats', value: 175, key: SEATS, type: 'number', was: 150 },
    { pointer: '/frontmatter/date', value: '2026-09-21', key: DATE, type: 'date' },   // the page wrote the date out: nothing is said
  ]);
  // Asked for nothing, it sends what it always sent.
  assert.equal('was' in groupSourceEdits(pending, where)[0].body.edits[0], false);
});

test('changedRefs: the edits the worker left out because someone else changed the field, with what the file says now', () => {
  const [g] = groupSourceEdits(new Map([[TITLE, { value: 'Mine' }], [VENUE, { value: 'Hall' }], [SEATS, { value: '175', type: 'number' }]]), where);
  const skipped = [
    { key: TITLE, reason: 'changed since it was read', current: 'The owner renamed this' },
    { key: SEATS, reason: 'changed since it was read', current: 200 },
    { key: VENUE, reason: 'pointer not found in source' },
  ];
  assert.deepEqual([...changedRefs(g, skipped)], [[TITLE, 'The owner renamed this'], [SEATS, 200]]);
  // The others are still told as "not saved", with their own reasons.
  assert.equal(matchSkippedRefs(g, skipped).get(VENUE), 'pointer not found in source');
  // Matched by pointer when a hop stripped the keys.
  assert.deepEqual([...changedRefs(g, [{ key: '/frontmatter/title', reason: 'changed since it was read', current: 'x' }])], [[TITLE, 'x']]);
  // An answer that does not say what the file holds cannot be asked about.
  assert.equal(changedRefs(g, [{ key: TITLE, reason: 'changed since it was read' }]).size, 0);
  assert.equal(changedRefs(g, undefined).size, 0);
  assert.equal(skipSentence('changed since it was read'), 'Someone else changed this. Reload the page to see how it is now.');
});

test('theirsOrMine: both versions, and what each button does, in plain words', () => {
  const q = theirsOrMine({ label: 'Title · One', theirs: 'The owner renamed this', mine: 'The editor renamed this' });
  assert.deepEqual(q, {
    title: 'Someone else changed this',
    body: 'Title · One was changed on the site after this page was made. Publishing yours would replace theirs.',
    theirs: 'The owner renamed this',
    mine: 'The editor renamed this',
    keep: 'Keep theirs',
    use: 'Use mine',
    note: 'Keep theirs drops your edit. Use mine publishes yours in its place.',
  });
  for (const line of Object.values(q)) assert.doesNotMatch(line, /[!—–]| - /, line);
  // A yes/no reads as the person types it, an emptied field says so, a long text is cut.
  assert.equal(theirsOrMine({ label: 'Free · One', theirs: false, mine: 'yes' }).theirs, 'no');
  assert.equal(theirsText(true), 'yes');
  assert.equal(theirsText(200), '200');
  assert.equal(theirsOrMine({ label: 'Venue · One', theirs: '', mine: 'Hall' }).theirs, '(nothing)');
  assert.equal(theirsOrMine({ label: 'Text · One', theirs: 'x'.repeat(900), mine: 'y' }).theirs.length, 601);
});

test('a url is checked in the editor by the rule the worker holds it to', () => {
  for (const v of ['https://example.org/x', 'http://example.org', 'mailto:a@example.org', 'tel:+14045550100', '/about', '/', './about', '../about', '#top', '?day=2',
    'Get tickets', 'tickets', 'www.example.org', 'example.org/x', 'https:', 'mailto:', '//example.org', 'javascript:alert(1)', 'data:text/html,x', 'ftp://example.org', 'https://exa mple.org']) {
    assert.equal(typedValue(v, 'url').ok, isAddress(v), v);
  }
  assert.equal(typedValue('Get tickets', 'url').why, 'This needs to be a web address that starts with https://, or a page of this site such as /about.');
  assert.deepEqual(typedValue('  /about ', 'url'), { ok: true, value: '/about' });
  assert.equal(typedValue('', 'url').ok, false);
});

// ─── Both sides together ─────────────────────────────────────────────────────

const BUILT = `---
title: Interfaith Worship Service
date: 2026-09-20
start: '18:00'
venue: "Big Bethel AME"
seats: 150
---

The service opens the week of remembrance.
`;
const RENAMED = BUILT.replace('title: Interfaith Worship Service', 'title: The owner renamed this');
const post = (body) => call(editorEnv(), 'POST', '/source/commit', { body });
// What the page built from BUILT showed for each field.
const shown = new Map([[TITLE, 'Interfaith Worship Service'], [VENUE, 'Big Bethel AME'], [SEATS, '150']]);
const typeOf = (ref) => /\?type=(\w+)/.exec(ref)?.[1];

test('this editor and this worker: the owner renamed the event; the editor is asked, and each answer does what it says', async () => {
  const gh = fakeGitHub({ repo: REPO, files: { [ONE]: RENAMED } });
  const pending = new Map([[TITLE, { value: 'The editor renamed this' }], [VENUE, { value: 'Ebenezer Baptist' }]]);
  const theirs = new Map();
  const was = (ref) => (theirs.has(ref) ? theirs.get(ref) : readAs([shown.get(ref)], typeOf(ref)));

  // Publish: the venue is saved, the title is left out with the owner's words.
  let [g] = groupSourceEdits(pending, { ...where, was });
  let r = await withFetch(gh.handler, () => post(g.body));
  assert.equal(r.status, 200);
  assert.deepEqual(matchAppliedRefs(g, r.json.applied), [VENUE]);
  const changed = changedRefs(g, r.json.skipped);
  assert.deepEqual([...changed], [[TITLE, 'The owner renamed this']]);
  assert.equal(gh.read(ONE), RENAMED.replace('"Big Bethel AME"', '"Ebenezer Baptist"'), 'their title is untouched; the venue line changed');
  pending.delete(VENUE);

  // "Use mine": the same edit, now saying what the file holds. It is written.
  theirs.set(TITLE, changed.get(TITLE));
  [g] = groupSourceEdits(pending, { ...where, was });
  assert.equal(g.body.edits[0].was, 'The owner renamed this');
  r = await withFetch(gh.handler, () => post(g.body));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.skipped, []);
  assert.equal(gh.read(ONE), RENAMED.replace('"Big Bethel AME"', '"Ebenezer Baptist"').replace('The owner renamed this', 'The editor renamed this'));
});

test('this editor and this worker: only the changed field was edited, so nothing is saved until the person answers', async () => {
  const gh = fakeGitHub({ repo: REPO, files: { [ONE]: RENAMED } });
  const [g] = groupSourceEdits(new Map([[TITLE, { value: 'The editor renamed this' }]]), { ...where, was: (ref) => shown.get(ref) });
  const r = await withFetch(gh.handler, () => post(g.body));
  assert.equal(r.status, 422);
  assert.deepEqual([...changedRefs(g, r.json.skipped)], [[TITLE, 'The owner renamed this']]);
  assert.equal(matchSkippedRefs(g, r.json.skipped).get(TITLE), 'changed since it was read');
  assert.equal(gh.read(ONE), RENAMED);
  assert.equal(gh.commits.size, 1);
});

test('this editor and a worker from before the check: the worker ignores what was read and saves, and the editor has nothing to ask', () => {
  // What such a worker answers: applied, no skipped entry (it never looked at `was`).
  const [g] = groupSourceEdits(new Map([[TITLE, { value: 'The editor renamed this' }]]), { ...where, was: (ref) => shown.get(ref) });
  const answer = { ok: true, file: ONE, commit: { sha: 'c'.repeat(40), parent: 'p'.repeat(40) }, applied: [TITLE], skipped: [] };
  assert.equal(changedRefs(g, answer.skipped).size, 0);
  assert.deepEqual(matchAppliedRefs(g, answer.applied), [TITLE]);
});

test('an editor from before the check and this worker: it says nothing about what it read, and is saved as it always was', async () => {
  const gh = fakeGitHub({ repo: REPO, files: { [ONE]: RENAMED } });
  const [g] = groupSourceEdits(new Map([[TITLE, { value: 'The editor renamed this' }]]), where);   // no `was`
  const r = await withFetch(gh.handler, () => post(g.body));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.skipped, []);
  assert.equal(gh.read(ONE), RENAMED.replace('The owner renamed this', 'The editor renamed this'));
});

test('a number the page showed as text is compared as a number, and a field shown on a line of its own as its words', async () => {
  const gh = fakeGitHub({ repo: REPO, files: { [ONE]: BUILT } });
  const pending = new Map([[SEATS, { value: '175', type: 'number' }], [VENUE, { value: 'Ebenezer Baptist' }]]);
  const page = new Map([[SEATS, ' 150 '], [VENUE, '\n      Big Bethel AME\n    ']]);
  const [g] = groupSourceEdits(pending, { ...where, was: (ref) => readAs([page.get(ref)], typeOf(ref)) });
  const r = await withFetch(gh.handler, () => post(g.body));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.skipped, []);
  assert.equal(gh.read(ONE), BUILT.replace('seats: 150', 'seats: 175').replace('"Big Bethel AME"', '"Ebenezer Baptist"'));
});
