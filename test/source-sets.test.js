/**
 * Several content files written as one commit ("a set").
 *
 * POST /source/commit and POST /source/revert take { files: [...] } as a
 * second form: every file is judged as the one-file form judges it, and the
 * ones that can go are written as ONE commit on the head that was read, with
 * a branch move that is never forced. A field somebody else changed since it
 * was read stops the whole set before anything is written. The one-file form
 * is not touched (its own tests are in source-worker, source-was and others).
 *
 * The REAL worker handler over an in-memory GitHub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorEnv, withFetch, call, REPO } from './worker-harness.js';
import { fakeGitHub } from './github-fake.js';
import { planSourceSet, validateSourceSet, SOURCE_SET_MAX } from '../worker/source.js';
import { isSensitivePath, pathInScope } from '../worker/index.js';

const entry = (n) => `src/content/events/e${n}.md`;
const text = (n, title = `Event ${n}`) => `---\ntitle: ${title}\nseats: ${n * 10}\n---\n\nAbout event ${n}.\n`;
const site = (count, extra = {}) => {
  const files = { 'README.md': 'readme\n', ...extra };
  for (let n = 1; n <= count; n++) files[entry(n)] = text(n);
  return fakeGitHub({ repo: REPO, files });
};
const rename = (n, title, more = {}) => ({ file: entry(n), edits: [{ pointer: '/frontmatter/title', value: title, key: `t${n}`, ...more }] });
const postSet = (env, files, extra = {}) => call(env, 'POST', '/source/commit', { body: { repo: REPO, adapter: 'astro', files, ...extra } });

test('nine files make one commit, with the head that was read as its only parent, and the answer says what each file took', async () => {
  const gh = site(9);
  const before = gh.head();
  const files = Array.from({ length: 9 }, (_, i) => rename(i + 1, `Renamed ${i + 1}`));
  const r = await withFetch(gh.handler, () => postSet(editorEnv(), files));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.set, true);
  assert.deepEqual(r.json.commit, { sha: gh.head(), parent: before });
  assert.deepEqual(gh.commits.get(gh.head()).parents, [before], 'one commit, one parent');
  assert.equal(gh.commits.size, 2, 'the seed and the one commit');
  assert.equal(gh.commits.get(gh.head()).message, 'Kiln: update 9 files');
  assert.equal(gh.commits.get(gh.head()).author.name, 'Sam (via Kiln)');
  for (let n = 1; n <= 9; n++) assert.equal(gh.read(entry(n)), text(n, `Renamed ${n}`));
  assert.equal(gh.read('README.md'), 'readme\n');
  assert.deepEqual(r.json.files.map(f => [f.file, f.applied]), files.map((f, i) => [f.file, [`t${i + 1}`]]));
  assert.deepEqual(r.json.leftOut, []);
  // No file was written by itself, and the branch was moved without force.
  assert.equal(gh.calls.filter(c => c.method === 'PUT').length, 0);
  const moves = gh.calls.filter(c => c.method === 'PATCH');
  assert.equal(moves.length, 1);
  assert.equal(moves[0].body.force, false);
});

test('an unacceptable value is left out with its reason, a file where nothing can be applied is left out, and the rest go in the one commit', async () => {
  const gh = site(3);
  const r = await withFetch(gh.handler, () => postSet(editorEnv(), [
    { file: entry(1), edits: [{ pointer: '/frontmatter/title', value: 'Good', key: 'title1' }, { pointer: '/frontmatter/seats', value: 'many', type: 'number', key: 'seats1' }] },
    { file: entry(2), edits: [{ pointer: '/frontmatter/gone', value: 'x', key: 'gone2' }] },
    rename(3, 'Also good'),
  ]));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(gh.commits.size, 2);
  assert.equal(gh.read(entry(1)), text(1, 'Good'), 'the seats line is as it was');
  assert.equal(gh.read(entry(2)), text(2));
  assert.equal(gh.read(entry(3)), text(3, 'Also good'));
  const one = r.json.files.find(f => f.file === entry(1));
  assert.deepEqual(one.applied, ['title1']);
  assert.deepEqual(one.skipped.map(s => s.key), ['seats1']);
  assert.equal(r.json.leftOut.length, 1);
  assert.equal(r.json.leftOut[0].file, entry(2));
  assert.equal(r.json.leftOut[0].code, 'nothing_applied');
  assert.deepEqual(r.json.leftOut[0].skipped.map(s => s.key), ['gone2']);
});

test('a field somebody else changed since it was read stops the whole set before anything is written, and the answer says what the file holds now', async () => {
  const gh = site(3);
  gh.commit({ [entry(2)]: text(2, 'The owner renamed this') });
  const before = gh.head();
  const r = await withFetch(gh.handler, () => postSet(editorEnv(), [
    rename(1, 'Mine 1', { was: 'Event 1' }),
    rename(2, 'Mine 2', { was: 'Event 2' }),
    rename(3, 'Mine 3', { was: 'Event 3' }),
  ]));
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'changed_since_read');
  assert.deepEqual(r.json.changed, [{ file: entry(2), key: 't2', reason: 'changed since it was read', current: 'The owner renamed this' }]);
  assert.equal(gh.head(), before, 'nothing was committed');
  assert.equal(gh.read(entry(1)), text(1));
  assert.ok(gh.calls.every(c => c.method === 'GET' || c.method === 'HEAD'), 'GitHub was asked to write nothing');
});

test('a suggest-only session and a comment-only session are refused, and GitHub is asked nothing', async () => {
  for (const [mode, code] of [['suggest', 'suggest_mode'], ['review', 'review_mode']]) {
    const gh = site(2);
    const r = await withFetch(gh.handler, () => postSet(editorEnv({ mode }), [rename(1, 'x'), rename(2, 'y')]));
    assert.equal(r.status, 403, mode);
    assert.equal(r.json.code, code);
    assert.equal(gh.calls.length, 0, mode);
    const back = await withFetch(gh.handler, () => call(editorEnv({ mode }), 'POST', '/source/revert', { body: { repo: REPO, toSha: 'a'.repeat(40), files: [entry(1)] } }));
    assert.equal(back.status, 403, mode);
    assert.equal(back.json.code, code);
  }
});

test('one file the editor may not change refuses the whole set, by name', async () => {
  const gh = site(2);
  const r = await withFetch(gh.handler, () => postSet(editorEnv({ paths: ['src/content/events/e1.md'] }), [rename(1, 'x'), rename(2, 'y')]));
  assert.equal(r.status, 403);
  assert.deepEqual([r.json.code, r.json.file, r.json.error], ['file_refused', entry(2), 'outside your editing scope']);
  assert.equal(gh.calls.length, 0);
  const twice = await withFetch(gh.handler, () => postSet(editorEnv(), [rename(1, 'x'), rename(1, 'y')]));
  assert.deepEqual([twice.status, twice.json.code], [400, 'same_file_twice']);
});

test(`more than ${SOURCE_SET_MAX} files are refused with a code, before GitHub is asked`, async () => {
  const gh = site(1);
  const files = Array.from({ length: SOURCE_SET_MAX + 1 }, (_, i) => ({ file: `src/content/events/x${i}.md`, edits: [{ pointer: '/frontmatter/title', value: 'x' }] }));
  const r = await withFetch(gh.handler, () => postSet(editorEnv(), files));
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'too_many_files');
  assert.equal(r.json.detail, SOURCE_SET_MAX + 1);
  assert.equal(gh.calls.length, 0);
  // Exactly the most is let through the rules.
  const ok = validateSourceSet({ files: files.slice(0, SOURCE_SET_MAX), adapter: 'astro', actor: { paths: [''] } }, { isSensitivePath, pathInScope });
  assert.equal(ok.files.length, SOURCE_SET_MAX);
});

test('when the branch moves once while saving, the set is judged again on the new head and committed on it, and the other commit is kept', async () => {
  const gh = site(3);
  let theirs = null;
  gh.onWrite((api) => { if (!theirs) theirs = api.commit({ 'README.md': 'their readme\n' }, { message: 'their change' }); });
  const r = await withFetch(gh.handler, () => postSet(editorEnv(), [rename(1, 'Mine 1', { was: 'Event 1' }), rename(3, 'Mine 3')]));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.commit, { sha: gh.head(), parent: theirs });
  assert.deepEqual(gh.commits.get(gh.head()).parents, [theirs]);
  assert.equal(gh.read('README.md'), 'their readme\n', 'their commit is kept');
  assert.equal(gh.read(entry(1)), text(1, 'Mine 1'));
  assert.equal(gh.read(entry(3)), text(3, 'Mine 3'));
  assert.equal(gh.calls.filter(c => c.method === 'PATCH').length, 2);
  assert.ok(gh.calls.filter(c => c.method === 'PATCH').every(c => c.body.force === false));
});

test('when the other commit changed a field the set edits, the retry stops the set and writes nothing', async () => {
  const gh = site(2);
  let theirs = null;
  gh.onWrite((api) => { if (!theirs) theirs = api.commit({ [entry(2)]: text(2, 'Theirs') }); });
  const r = await withFetch(gh.handler, () => postSet(editorEnv(), [rename(1, 'Mine 1'), rename(2, 'Mine 2', { was: 'Event 2' })]));
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'changed_since_read');
  assert.deepEqual(r.json.changed, [{ file: entry(2), key: 't2', reason: 'changed since it was read', current: 'Theirs' }]);
  assert.equal(gh.head(), theirs);
  assert.equal(gh.read(entry(1)), text(1));
});

test('when the branch keeps moving, the set gives up after one retry and says so', async () => {
  const gh = site(1);
  let n = 0;
  gh.onWrite((api) => { if (gh.calls.at(-1).path === '/git/commits') api.commit({ 'README.md': `readme ${++n}\n` }); });
  const r = await withFetch(gh.handler, () => postSet(editorEnv(), [rename(1, 'Mine')]));
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'head_moved');
  assert.equal(gh.read(entry(1)), text(1));
  assert.equal(n, 2);
});

test('a set where every value is already there commits nothing; one where nothing can be applied is a 422', async () => {
  const gh = site(2);
  const same = await withFetch(gh.handler, () => postSet(editorEnv(), [rename(1, 'Event 1'), rename(2, 'Event 2')]));
  assert.equal(same.status, 200);
  assert.deepEqual([same.json.unchanged, same.json.commit], [true, null]);
  assert.ok(same.json.files.every(f => f.unchanged));
  const none = await withFetch(gh.handler, () => postSet(editorEnv(), [{ file: entry(1), edits: [{ pointer: '/frontmatter/nope', value: 'x' }] }]));
  assert.equal(none.status, 422);
  assert.equal(none.json.code, 'nothing_applied');
  assert.equal(gh.commits.size, 1);
});

test('a whole set is put back in one commit by /source/revert', async () => {
  const gh = site(3);
  const r = await withFetch(gh.handler, () => postSet(editorEnv(), [rename(1, 'A'), rename(2, 'B'), rename(3, 'C')]));
  assert.equal(r.status, 200);
  const back = await withFetch(gh.handler, () => call(editorEnv(), 'POST', '/source/revert', { body: { repo: REPO, toSha: r.json.commit.parent, files: [entry(1), entry(2), entry(3)] } }));
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.deepEqual(back.json.files, [entry(1), entry(2), entry(3)]);
  assert.deepEqual(gh.commits.get(gh.head()).parents, [r.json.commit.sha]);
  for (let n = 1; n <= 3; n++) assert.equal(gh.read(entry(n)), text(n));
  // Asked again, there is nothing to put back.
  const again = await withFetch(gh.handler, () => call(editorEnv(), 'POST', '/source/revert', { body: { repo: REPO, toSha: r.json.commit.parent, files: [entry(1)] } }));
  assert.deepEqual([again.status, again.json.unchanged, again.json.same], [200, true, [entry(1)]]);
});

test('/healthz says the service writes sets', async () => {
  const r = await call(editorEnv(), 'GET', '/healthz');
  assert.equal(r.json.sourceSets, true);
});

test('planSourceSet: a changed field anywhere stops the set; the other reasons leave one file out', () => {
  const ok = { file: 'a.md', path: 'a.md', moved: [], applied: ['k'], allSkipped: [], invalid: null, content: 'new', source: 'old' };
  assert.deepEqual(planSourceSet([ok]).writes, [{ file: 'a.md', content: 'new' }]);
  const stop = planSourceSet([ok, { ...ok, file: 'b.md', path: 'b.md', moved: [{ key: 'k', reason: 'changed since it was read', current: 'x' }] }]);
  assert.equal(stop.stop.status, 409);
  const out = planSourceSet([ok, { file: 'c.md', gone: true }, { ...ok, file: 'd.md', path: 'target.md' }, { ...ok, file: 'e.md', path: 'e.md', invalid: 'bad yaml' }]);
  assert.deepEqual(out.leftOut.map(l => [l.file, l.code]), [['c.md', 'file_gone'], ['d.md', 'not_a_file'], ['e.md', 'invalid']]);
  assert.equal(out.writes.length, 1);
});
