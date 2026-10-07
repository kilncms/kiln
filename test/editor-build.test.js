// KLR-18: which editor build each site runs. A signed-in editor says its build
// with the presence ping; the worker keeps it per repository, writing only when
// it changes (or once a day); the operator's overview shows it beside each site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { editorEnv, call, REPO, fakeKV } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';
import { readFileSync } from 'node:fs';

test('the presence ping keeps the editor build a site runs, and writes only when it changes', async () => {
  const env = editorEnv();
  let writes = 0;
  const put = env.KILN.put.bind(env.KILN);
  env.KILN.put = async (k, v, o) => { if (k.startsWith('ebuild:')) writes++; return put(k, v, o); };
  const ping = (build) => call(env, 'POST', '/presence', { body: { repo: REPO, path: '/', name: 'Sam', build } });
  assert.equal((await ping('62a8618')).status, 200);
  const kept = JSON.parse(env.KILN.map.get(`ebuild:${REPO}`));
  assert.equal(kept.build, '62a8618');
  assert.ok(kept.at > 0);
  await ping('62a8618');
  assert.equal(writes, 1, 'the same build again is not written again');
  await ping('7a3ae86');
  assert.equal(JSON.parse(env.KILN.map.get(`ebuild:${REPO}`)).build, '7a3ae86');
  assert.equal(writes, 2);
  await ping('<script>');
  await ping(undefined);
  assert.equal(JSON.parse(env.KILN.map.get(`ebuild:${REPO}`)).build, '7a3ae86', 'anything that is not a build stamp is ignored');
});

test('the editor sends its build with the ping', () => {
  const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
  assert.match(main, /ask\('\/presence', \{ method: 'POST', body: \{ repo: cfg\.repo, path: location\.pathname, name: state\.user, build: EDITOR_BUILD \} \}\)/);
  assert.match(main, /const EDITOR_BUILD = \(typeof __KILN_VERSION__ !== 'undefined'\) \? String\(__KILN_VERSION__\) : 'dev';/);
});

test('the operator\'s overview shows each site\'s editor build and when it was last seen', { skip: d1Skip }, async () => {
  const kv = fakeKV();
  const env = cloudEnv(kv, { CLOUD_ADMIN: 'ada', CLOUD_ADMIN_ID: '7' });
  kv.map.set('csess:tok', JSON.stringify({ account_id: 'acct-1', login: 'ada', uid: 7, gh: 'gho_x' }));
  addSite(env, { id: 'site-1', repo: 'ada/club' });
  addSite(env, { id: 'site-2', repo: 'ada/shop', origin: 'https://shop.example' });
  kv.map.set('ebuild:ada/club', JSON.stringify({ build: '62a8618', at: 1759860000000 }));
  const res = await worker.fetch(new Request('https://worker.example/admin/cloud/overview', { headers: { Authorization: 'Bearer tok' } }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  const by = Object.fromEntries(body.sites.map(s => [s.repo, [s.editor_build, s.editor_seen]]));
  assert.deepEqual(by, { 'ada/club': ['62a8618', 1759860000000], 'ada/shop': [null, null] });
});

test('a failed write of the editor build does not fail the presence ping', async () => {
  const env = editorEnv();
  const put = env.KILN.put.bind(env.KILN);
  env.KILN.put = async (k, v, o) => { if (k.startsWith('ebuild:')) throw new Error('KV write limit'); return put(k, v, o); };
  const res = await call(env, 'POST', '/presence', { body: { repo: REPO, path: '/', name: 'Sam', build: '62a8618' } });
  assert.equal(res.status, 200);
});
