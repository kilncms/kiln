// Entries through the real worker, over an in-memory GitHub: added from their
// fields, copied, removed and brought back, read whole and by version, and
// content-file edits published on a schedule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { editorEnv, withFetch, call, REPO } from './worker-harness.js';
import { fakeGitHub } from './github-fake.js';

const DIR = 'src/content/posts';
const FAIR = `---
# the fair
title: Spring fair
date: 2026-05-02
draft: false
order: 1
---

The fair is on the green.
`;
const GRANTED = { features: ['newpost', 'history', 'schedule'] };

async function run(gh, method, path, body, session = GRANTED) {
  return withFetch(gh.handler, () => call(editorEnv(session), method, path, { body: { repo: REPO, adapter: 'astro', ...body } }));
}

test('/healthz says the worker adds, copies, removes and schedules entries', async () => {
  assert.equal((await call(editorEnv(), 'GET', '/healthz')).json.sourceEntries, true);
});

test('a new entry is a new file made from its fields, and a file that is there is never written over', async () => {
  const gh = fakeGitHub({ repo: REPO, files: { [`${DIR}/spring-fair.md`]: FAIR } });
  const r = await run(gh, 'POST', '/source/create', { file: `${DIR}/autumn-walk.md`, fields: { title: 'Autumn walk', date: '2026-10-20', draft: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.file, `${DIR}/autumn-walk.md`);
  assert.match(r.json.commit.sha, /^[0-9a-f]{40}$/);
  assert.equal(gh.read(`${DIR}/autumn-walk.md`), '---\ntitle: Autumn walk\ndate: 2026-10-20\ndraft: true\n---\n');
  const again = await run(gh, 'POST', '/source/create', { file: `${DIR}/spring-fair.md`, fields: { title: 'Spring fair' } });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'a file with that name is already there');
  assert.equal(gh.read(`${DIR}/spring-fair.md`), FAIR);
});

test('a copy keeps the entry and writes the fields given over it', async () => {
  const gh = fakeGitHub({ repo: REPO, files: { [`${DIR}/spring-fair.md`]: FAIR } });
  const r = await run(gh, 'POST', '/source/create', { file: `${DIR}/spring-fair-2027.md`, copyOf: `${DIR}/spring-fair.md`, fields: { title: 'Spring fair 2027', draft: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(gh.read(`${DIR}/spring-fair-2027.md`), FAIR.replace('title: Spring fair', 'title: Spring fair 2027').replace('draft: false', 'draft: true'));
  assert.equal(gh.read(`${DIR}/spring-fair.md`), FAIR);
});

test('who may add and what may go in: the grant, the folder, no code, nothing that runs', async () => {
  const gh = fakeGitHub({ repo: REPO, files: { [`${DIR}/spring-fair.md`]: FAIR } });
  const ungranted = await run(gh, 'POST', '/source/create', { file: `${DIR}/a.md`, fields: { title: 'A' } }, {});
  assert.equal(ungranted.status, 403);
  assert.equal(ungranted.json.code, 'grant_required');
  const scoped = await run(gh, 'POST', '/source/create', { file: 'src/content/pages/a.md', fields: { title: 'A' } }, { ...GRANTED, paths: [DIR] });
  assert.equal(scoped.status, 403);
  assert.equal((await run(gh, 'POST', '/source/create', { file: 'src/pages/a.astro', fields: { title: 'A' } })).status, 400);
  assert.equal((await run(gh, 'POST', '/source/create', { file: 'astro.config.mjs', fields: { title: 'A' } })).status, 403);
  assert.equal((await run(gh, 'POST', '/source/create', { file: `${DIR}/b.md`, fields: { title: '<script>x()</script>' } })).status, 422);
  assert.equal((await run(gh, 'POST', '/source/create', { file: `${DIR}/b.md`, fields: { title: 'B' }, body: '[go](javascript:alert(1))' })).status, 422);
  assert.equal((await run(gh, 'POST', '/source/create', { file: `${DIR}/b.md`, fields: { 'bad name': 'B' } })).status, 400);
  assert.deepEqual(gh.paths(), [`${DIR}/spring-fair.md`]);
});

test('a removed entry is one commit, and its history brings it back', async () => {
  const gh = fakeGitHub({ repo: REPO, files: { [`${DIR}/spring-fair.md`]: FAIR } });
  const ungranted = await run(gh, 'POST', '/source/remove', { file: `${DIR}/spring-fair.md` }, {});
  assert.equal(ungranted.status, 403);
  const r = await run(gh, 'POST', '/source/remove', { file: `${DIR}/spring-fair.md` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(gh.read(`${DIR}/spring-fair.md`), null);
  const h = await run(gh, 'POST', '/source/history', { file: `${DIR}/spring-fair.md` });
  assert.equal(h.status, 200);
  assert.equal(h.json.versions[0].what, `Kiln: remove ${DIR}/spring-fair.md`);
  assert.equal(h.json.versions[0].who, 'Sam');
  // …and the collection's folder says what was removed from it
  const folder = await run(gh, 'POST', '/source/history', { folder: DIR });
  assert.equal(folder.status, 200);
  assert.equal(folder.json.versions[0].what, `Kiln: remove ${DIR}/spring-fair.md`);
  assert.equal((await run(gh, 'POST', '/source/history', { folder: '../etc' })).status, 400);
  assert.equal((await run(gh, 'POST', '/source/history', { folder: '.kiln' })).status, 403);
  assert.equal((await run(gh, 'POST', '/source/history', { folder: DIR }, { ...GRANTED, paths: ['src/content/people'] })).status, 403);
  const back = await run(gh, 'POST', '/source/revert', { file: `${DIR}/spring-fair.md`, toSha: h.json.versions[0].parent });
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.equal(gh.read(`${DIR}/spring-fair.md`), FAIR);
});

test('an entry read whole, now and as it was at a commit', async () => {
  const gh = fakeGitHub({ repo: REPO, files: { [`${DIR}/spring-fair.md`]: FAIR } });
  const first = gh.head();
  gh.commit({ [`${DIR}/spring-fair.md`]: FAIR.replace('Spring fair', 'Spring fair and fete') });
  const now = await run(gh, 'POST', '/source/fields', { file: `${DIR}/spring-fair.md` });
  assert.equal(now.status, 200);
  assert.deepEqual(now.json.fields, { title: 'Spring fair and fete', date: '2026-05-02', draft: false, order: 1 });
  assert.equal(now.json.format, 'yaml');
  assert.equal(now.json.body, '\nThe fair is on the green.\n');
  const then = await run(gh, 'POST', '/source/fields', { file: `${DIR}/spring-fair.md`, at: first });
  assert.equal(then.json.fields.title, 'Spring fair');
  assert.equal((await run(gh, 'POST', '/source/fields', { file: `${DIR}/spring-fair.md`, at: 'main' })).status, 400);
  const hist = await run(gh, 'POST', '/source/history', { file: `${DIR}/spring-fair.md` });
  assert.deepEqual(hist.json.versions.map(v => v.what), ['outside change', 'site']);
});

test('an edit that adds a field the entry does not have yet: a draft mark', async () => {
  const gh = fakeGitHub({ repo: REPO, files: { [`${DIR}/a.md`]: '---\ntitle: A\n---\n' } });
  const r = await run(gh, 'POST', '/source/commit', { file: `${DIR}/a.md`, edits: [{ pointer: '/frontmatter/draft', value: true, type: 'boolean', key: 'd', add: true }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(gh.read(`${DIR}/a.md`), '---\ntitle: A\ndraft: true\n---\n');
});

test('content-file edits on a schedule: checked when made, applied to the file as it is when they fire', async () => {
  const gh = fakeGitHub({ repo: REPO, files: { [`${DIR}/spring-fair.md`]: FAIR } });
  // The editor is on the site's list of people: a schedule is checked against it again when it fires.
  const env = editorEnv(GRANTED, { [`people:${REPO}`]: [{ email: 'sam@example.com', name: 'Sam', role: 'editor', paths: [''], features: GRANTED.features }] });
  const at = new Date(Date.now() + 3600e3).toISOString();
  const make = (body) => withFetch(gh.handler, () => call(env, 'POST', '/schedule', { body: { repo: REPO, at, ...body } }));
  const bad = await make({ source: { adapter: 'astro', file: `${DIR}/spring-fair.md`, edits: [{ pointer: '/frontmatter/date', value: 'soon', type: 'date' }] } });
  assert.equal(bad.status, 422);
  const ok = await make({ desc: 'Spring fair goes live', source: { adapter: 'astro', file: `${DIR}/spring-fair.md`, edits: [{ pointer: '/frontmatter/draft', value: false, type: 'boolean', key: 'd', was: 'true' }] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const list = await withFetch(gh.handler, () => call(env, 'GET', `/schedules?repo=${REPO}`));
  assert.deepEqual(list.json.schedules.map(s => [s.desc, s.kind]), [['Spring fair goes live', 'source']]);
  // Someone publishes another change before it fires; the schedule keeps it.
  gh.commit({ [`${DIR}/spring-fair.md`]: FAIR.replace('draft: false', 'draft: true').replace('order: 1', 'order: 5') });
  const key = [...env.KILN.map.keys()].find(k => k.startsWith('sched:'));
  env.KILN.map.set(key, JSON.stringify({ ...JSON.parse(env.KILN.map.get(key)), at: Date.now() - 1000 }));
  await withFetch(gh.handler, () => worker.scheduled({}, env));
  assert.equal(gh.read(`${DIR}/spring-fair.md`), FAIR.replace('order: 1', 'order: 5'));
  assert.equal(env.KILN.map.has(key), false);
});
