/**
 * A field someone else changed is not written over.
 *
 * An edit to a content file may say what the field held when the editor read
 * it (`was`). POST /source/commit leaves that one edit out when the file no
 * longer says that, and answers with what the file says now, so the editor
 * can show both and let the person choose. Edits to other fields of the file
 * still go through. An edit that says nothing is written as it always was.
 *
 * The REAL worker handler over an in-memory GitHub: each case is the file
 * before and the file after.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorEnv, withFetch, call, REPO } from './worker-harness.js';
import { fakeGitHub } from './github-fake.js';
import { changedSinceRead, sameAsRead, CHANGED_SINCE_READ, validateSourceRequest } from '../worker/source.js';
import { isSensitivePath, pathInScope } from '../worker/index.js';
import astro from '../src/adapters/astro.js';

const FILE = 'src/content/events/one.md';
const BUILT = `---
title: Interfaith Worship Service
date: 2026-09-20
start: '18:00'
venue: "Big Bethel AME"
seats: 150
free: true
---

The service opens the week of remembrance.
`;
// What the owner pushed after the page was built.
const RENAMED = BUILT.replace('title: Interfaith Worship Service', 'title: The owner renamed this');

const post = (env, edits) => call(env, 'POST', '/source/commit', { body: { repo: REPO, adapter: 'astro', file: FILE, edits } });
const repoWith = (text) => fakeGitHub({ repo: REPO, files: { [FILE]: text } });

test('the same field, changed by someone else since the page was built: the edit is left out and the file is not touched', async () => {
  const gh = repoWith(RENAMED);
  const r = await withFetch(gh.handler, () => post(editorEnv(), [
    { pointer: '/frontmatter/title', value: 'The editor renamed this', was: 'Interfaith Worship Service', key: 'title' },
  ]));
  assert.equal(r.status, 422);
  assert.equal(r.json.error, 'no edits could be applied');
  assert.deepEqual(r.json.skipped, [{ key: 'title', reason: 'changed since it was read', current: 'The owner renamed this' }]);
  assert.equal(gh.read(FILE), RENAMED, 'their change is still there');
  assert.equal(gh.commits.size, 1, 'nothing was committed');
});

test('edits to other fields of the same file still go through, in one commit that changes only their lines', async () => {
  const gh = repoWith(RENAMED);
  const r = await withFetch(gh.handler, () => post(editorEnv(), [
    { pointer: '/frontmatter/title', value: 'The editor renamed this', was: 'Interfaith Worship Service', key: 'title' },
    { pointer: '/frontmatter/venue', value: 'Ebenezer Baptist', was: 'Big Bethel AME', key: 'venue' },
    { pointer: '/frontmatter/start', value: '18:30', type: 'time', was: '18:00', key: 'start' },
  ]));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.applied.sort(), ['start', 'venue']);
  assert.deepEqual(r.json.skipped, [{ key: 'title', reason: 'changed since it was read', current: 'The owner renamed this' }]);
  assert.equal(gh.read(FILE), RENAMED.replace('venue: "Big Bethel AME"', 'venue: "Ebenezer Baptist"').replace("start: '18:00'", "start: '18:30'"));
  assert.equal(gh.commits.size, 2);
});

test('the person chose their own words: the edit says what the file holds now, and is written', async () => {
  const gh = repoWith(RENAMED);
  const r = await withFetch(gh.handler, () => post(editorEnv(), [
    { pointer: '/frontmatter/title', value: 'The editor renamed this', was: 'The owner renamed this', key: 'title' },
  ]));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.skipped, []);
  assert.equal(gh.read(FILE), RENAMED.replace('The owner renamed this', 'The editor renamed this'));
});

test('an editor from before this check says nothing about what it read, and its edit is written as it always was', async () => {
  const gh = repoWith(RENAMED);
  const r = await withFetch(gh.handler, () => post(editorEnv(), [
    { pointer: '/frontmatter/title', value: 'The editor renamed this', key: 'title' },
  ]));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.applied, ['title']);
  assert.deepEqual(r.json.skipped, []);
  assert.equal(gh.read(FILE), RENAMED.replace('The owner renamed this', 'The editor renamed this'));
});

test('nobody changed it: an edit that says what it read is written, and exactly its line changes', async () => {
  const gh = repoWith(BUILT);
  const r = await withFetch(gh.handler, () => post(editorEnv(), [
    { pointer: '/frontmatter/title', value: 'Evening Worship', was: 'Interfaith Worship Service', key: 'title' },
    { pointer: '/frontmatter/seats', value: 175, type: 'number', was: 150, key: 'seats' },
    { pointer: '/frontmatter/free', value: false, type: 'boolean', was: true, key: 'free' },
    { pointer: '/frontmatter/date', value: '2026-09-21', type: 'date', was: '2026-09-20', key: 'date' },
    { pointer: '/body', value: 'Doors open at six.', was: 'The service opens the week of remembrance.', key: 'body' },
  ]));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.skipped, []);
  assert.equal(gh.read(FILE), BUILT.replace('Interfaith Worship Service', 'Evening Worship').replace('seats: 150', 'seats: 175')
    .replace('free: true', 'free: false').replace('2026-09-20', '2026-09-21').replace('The service opens the week of remembrance.', 'Doors open at six.'));
});

test('a number, a yes/no, a time and a text someone else changed are each left out, with what the file says now', async () => {
  const theirs = BUILT.replace('seats: 150', 'seats: 200').replace('free: true', 'free: false').replace("'18:00'", "'17:00'")
    .replace('The service opens the week of remembrance.', 'The owner wrote **new** words.');
  const gh = repoWith(theirs);
  const r = await withFetch(gh.handler, () => post(editorEnv(), [
    { pointer: '/frontmatter/seats', value: 175, type: 'number', was: 150, key: 'seats' },
    { pointer: '/frontmatter/free', value: true, type: 'boolean', was: true, key: 'free' },
    { pointer: '/frontmatter/start', value: '18:30', type: 'time', was: '18:00', key: 'start' },
    { pointer: '/body', value: 'Doors open at six.', was: 'The service opens the week of remembrance.', key: 'body' },
  ]));
  assert.equal(r.status, 422);
  assert.deepEqual(r.json.skipped, [
    { key: 'seats', reason: 'changed since it was read', current: 200 },
    { key: 'free', reason: 'changed since it was read', current: false },
    { key: 'start', reason: 'changed since it was read', current: '17:00' },
    { key: 'body', reason: 'changed since it was read', current: 'The owner wrote **new** words.' },
  ]);
  assert.equal(gh.read(FILE), theirs);
});

test('a change that lands between the read and the write is not written over either', async () => {
  const gh = repoWith(BUILT);
  let raced = false;
  const handler = async (url, init) => {
    // The owner's push arrives after the worker read the file and before it writes.
    if (init.method === 'PUT' && !raced) { raced = true; gh.commit({ [FILE]: RENAMED }); }
    return gh.handler(url, init);
  };
  const r = await withFetch(handler, () => post(editorEnv(), [
    { pointer: '/frontmatter/title', value: 'The editor renamed this', was: 'Interfaith Worship Service', key: 'title' },
    { pointer: '/frontmatter/venue', value: 'Ebenezer Baptist', was: 'Big Bethel AME', key: 'venue' },
  ]));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.applied, ['venue']);
  assert.deepEqual(r.json.skipped, [{ key: 'title', reason: 'changed since it was read', current: 'The owner renamed this' }]);
  assert.equal(gh.read(FILE), RENAMED.replace('venue: "Big Bethel AME"', 'venue: "Ebenezer Baptist"'));
});

test('both made the same change: there is nothing to ask', async () => {
  const gh = repoWith(RENAMED);
  const r = await withFetch(gh.handler, () => post(editorEnv(), [
    { pointer: '/frontmatter/title', value: 'The owner renamed this', was: 'Interfaith Worship Service', key: 'title' },
  ]));
  assert.equal(r.status, 200);
  assert.equal(r.json.unchanged, true);
  assert.deepEqual(r.json.skipped, []);
  assert.equal(gh.read(FILE), RENAMED);
});

test('a field that is gone is said to be gone, as before, whatever the edit read', async () => {
  const gh = repoWith(BUILT.replace('venue: "Big Bethel AME"\n', ''));
  const r = await withFetch(gh.handler, () => post(editorEnv(), [
    { pointer: '/frontmatter/venue', value: 'Ebenezer Baptist', was: 'Big Bethel AME', key: 'venue' },
  ]));
  assert.equal(r.status, 422);
  assert.deepEqual(r.json.skipped, [{ key: 'venue', reason: 'pointer not found in source' }]);
});

test('what was read is compared as a reader sees it: spacing does not count, and a text is read as its words', () => {
  // A template may put the value on a line of its own.
  assert.equal(sameAsRead('Big Bethel AME', '\n    Big Bethel AME\n  ', {}), true);
  assert.equal(sameAsRead('Line one\nline two\n', 'Line one line two', {}), true);
  assert.equal(sameAsRead('Big Bethel AME', 'Big Bethel', {}), false);
  assert.equal(sameAsRead('big bethel ame', 'Big Bethel AME', {}), false);
  // A field with no value yet reads as nothing.
  assert.equal(sameAsRead(null, '', {}), true);
  assert.equal(sameAsRead(null, 'something', {}), false);
  // A number and a yes/no, however the file or the page writes them.
  assert.equal(sameAsRead(150, '150', { type: 'number' }), true);
  assert.equal(sameAsRead('150', 150, { type: 'number' }), true);
  assert.equal(sameAsRead(150, 151, { type: 'number' }), false);
  assert.equal(sameAsRead(true, 'yes', { type: 'boolean' }), true);
  assert.equal(sameAsRead(false, true, { type: 'boolean' }), false);
  // An entry's text is markdown, and the page shows what the site made of it:
  // the escapes are gone, and quotes, dashes and dots are the typeset ones.
  const body = { pointer: '/body' };
  assert.equal(sameAsRead('\nIt\'s "free" to come -- bring a friend...\n', 'It’s “free” to come – bring a friend…', body), true);
  assert.equal(sameAsRead('\n2 \\* 3 is \\_six\\_ &amp; so on\n', '2 * 3 is _six_ & so on', body), true);
  assert.equal(sameAsRead('\nOne line\nand the next.\n', 'One line and the next.', body), true);
  assert.equal(sameAsRead('\nIt is free to come.\n', 'It’s free to come.', body), false);
  // In a field the same marks are the value itself.
  assert.equal(sameAsRead('It\'s here', 'It’s here', {}), false);
});

test('changedSinceRead: only edits that say what they read are looked at, and only single values', () => {
  const edits = [
    { pointer: '/frontmatter/title', value: 'x', key: 'said nothing' },
    { pointer: '/frontmatter/title', value: 'x', was: 'Interfaith Worship Service', key: 'same' },
    { pointer: '/frontmatter/title', value: 'x', was: 'Something else', key: 'moved' },
    { pointer: '/frontmatter/ghost', value: 'x', was: 'Something else', key: 'gone' },
    { pointer: '/attic/thing', value: 'x', was: 'y', key: 'no such place' },
  ];
  assert.deepEqual(changedSinceRead(astro, BUILT, FILE, edits), [{ key: 'moved', reason: CHANGED_SINCE_READ, current: 'Interfaith Worship Service' }]);
  // A list where a value was: the adapter says "type mismatch", as before.
  assert.deepEqual(changedSinceRead(astro, '---\ntitle:\n  - a\n  - b\n---\n', FILE, [{ pointer: '/frontmatter/title', value: 'x', was: 'y', key: 'k' }]), []);
  // A file that cannot be read as YAML is never written; that is said by the adapter too.
  assert.deepEqual(changedSinceRead(astro, '---\ntitle: [unclosed\n---\n', FILE, [{ pointer: '/frontmatter/title', value: 'x', was: 'y', key: 'k' }]), []);
});

test('validateSourceRequest: `was` is kept when it is a single value, and dropped when it is anything else', () => {
  const deps = { isSensitivePath, pathInScope };
  const actor = { name: 'Sam', paths: [''], mode: null };
  const edits = [
    { pointer: '/frontmatter/a', value: 'x', was: 'y' },
    { pointer: '/frontmatter/b', value: 1, was: 0, type: 'number' },
    { pointer: '/frontmatter/c', value: true, was: false, type: 'boolean' },
    { pointer: '/frontmatter/d', value: 'x', was: '' },
    { pointer: '/frontmatter/e', value: 'x', was: null },
    { pointer: '/frontmatter/f', value: 'x', was: { a: 1 } },
    { pointer: '/frontmatter/g', value: 'x' },
  ];
  const v = validateSourceRequest({ adapter: 'astro', file: FILE, edits, actor }, deps);
  assert.deepEqual(v.cleanEdits.map(e => ('was' in e ? e.was : '(none)')), ['y', 0, false, '', '(none)', '(none)', '(none)']);
});

test('/healthz says this worker checks what an edit read', async () => {
  const r = await call(editorEnv(), 'GET', '/healthz', { session: null });
  assert.equal(r.status, 200);
  assert.equal(r.json.sourceWas, true);
  assert.deepEqual(r.json.modes, ['html', 'source']);
});
