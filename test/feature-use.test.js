/**
 * Feature use (worker/feature-use.js, migration 0027). Switched off, nothing
 * is counted or read and every route answers as before. Switched on, a
 * request the service answered with success adds one to its week's row for
 * its site and feature, never what was written; a refused request is not
 * counted, nor a repository that is no site on Kiln; a burst is one row; a
 * count that cannot be kept is dropped and the request answers as before; the
 * five-minute run deletes rows older than 400 days and those of sites gone; a
 * site's rows go with the site; only the operator reads the counts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { noteFeature, forgetFeatureUse, pruneFeatureUse, FEATURES } from '../worker/feature-use.js';
import { notePublish } from '../worker/cloud.js';
import { easternMonday, dayPlus } from '../worker/problems.js';
import { fakeKV, withFetch, editorEnv, call as editorCall, REPO, ORIGIN } from './worker-harness.js';
import { cloudEnv, addSite, addAccount, d1Skip } from './d1-fake.js';

const rows = (env) => env.kiln_cloud.db.prepare('SELECT site_id, feature, count FROM feature_use ORDER BY feature, site_id').all().map(r => ({ ...r }));
const total = (env) => env.kiln_cloud.row('SELECT COUNT(*) n FROM feature_use').n;
const call = async (env, path, { method = 'GET', token = 'tok', body } = {}) => {
  const res = await worker.fetch(new Request(`https://worker.example${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', Origin: 'https://app.example' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  return { status: res.status, json: await res.json().catch(() => null) };
};
const quiet = (fn) => withFetch(async () => undefined, fn);
const hushed = async (fn) => {
  const was = [console.log, console.warn, console.error];
  const said = [];
  console.log = console.warn = console.error = (s) => said.push(String(s));
  try { await fn(); } finally { [console.log, console.warn, console.error] = was; }
  return said;
};
const lines = (said, evt) => said.map(s => { try { return JSON.parse(s); } catch { return {}; } }).filter(l => l.evt === evt);

/** The operator 'ada' (token 'tok', site-1 ada/club) and a customer 'uma' (token 'tok-uma', site-2 uma/cafe). */
function world() {
  const kv = fakeKV();
  const env = cloudEnv(kv, { CLOUD_ADMIN: 'ada', FEATURE_USE: 'on' });
  addAccount(env, { id: 'acct-uma', github_login: 'uma', email: 'uma@example.com' });
  kv.map.set('csess:tok-uma', JSON.stringify({ account_id: 'acct-uma', login: 'uma', uid: 202, gh: 'gho_u' }));
  addSite(env);
  addSite(env, { id: 'site-2', account_id: 'acct-uma', repo: 'uma/cafe', origin: 'https://cafe.example' });
  return env;
}
/** An invited editor 'Sam' on the site acme/site (site-9), through the editor's door. */
function editorWorld({ on = true } = {}) {
  const base = editorEnv({ features: ['comments'] });   // a Cloud site's editor needs the comments grant
  const env = { ...cloudEnv(base.KILN, on ? { FEATURE_USE: 'on' } : {}), ALLOWED_ORIGINS: ORIGIN };
  addSite(env, { id: 'site-9', repo: REPO, origin: ORIGIN });
  return env;
}
const comment = (env, repo = REPO) => quiet(() => editorCall(env, 'POST', '/comments', { body: { repo, path: '/index.html', text: 'Typo here' } }));

test('switched off, nothing is asked of the database, whatever else the setting says', async () => {
  for (const FEATURE_USE of [undefined, 'off', 'ON', '', 'yes']) {
    const asked = [];
    const env = { kiln_cloud: { prepare: (sql) => { asked.push(sql); throw new Error('asked'); } }, ...(FEATURE_USE === undefined ? {} : { FEATURE_USE }) };
    assert.equal(await noteFeature(env, { feature: 'api', repo: 'ada/club' }), false);
    assert.equal(await forgetFeatureUse(env, 'site-1'), false);
    assert.deepEqual(await pruneFeatureUse(env), { ran: false });
    assert.deepEqual(asked, [], `FEATURE_USE=${FEATURE_USE}`);
  }
  assert.deepEqual(FEATURES, ['publish', 'publish_many', 'schedule', 'invite_editor', 'invite_member', 'comment', 'suggestion', 'writing_helper', 'api', 'api_token', 'revert', 'page_added', 'page_removed', 'history']);
  const said = await hushed(async () => assert.equal(await noteFeature({ kiln_cloud: { prepare: () => { throw new Error('asked'); } }, FEATURE_USE: 'on' }, { feature: 'looking', repo: 'ada/club' }), false));
  assert.equal(lines(said, 'feature_not_written').length, 1);
});

test('switched off, nothing is counted and the routes answer as they do switched on; switched on, a comment is one use and a refused one none', { skip: d1Skip }, async () => {
  const off = editorWorld({ on: false });
  const answeredOff = [(await comment(off)).status, (await comment(off, 'bad repo')).status];
  assert.equal(total(off), 0);
  const on = editorWorld();
  assert.deepEqual([(await comment(on)).status, (await comment(on, 'bad repo')).status], answeredOff);
  assert.deepEqual(answeredOff, [200, 400]);
  assert.deepEqual(rows(on), [{ site_id: 'site-9', feature: 'comment', count: 1 }]);
  assert.equal(on.kiln_cloud.row('SELECT week FROM feature_use').week, easternMonday(Date.now()));
  assert.ok(!JSON.stringify(on.kiln_cloud.db.prepare('SELECT * FROM feature_use').all()).includes('Typo'));
  const admin = world();
  admin.FEATURE_USE = 'off';
  assert.deepEqual((await call(admin, '/admin/cloud/features')).json, { ok: true, recording: false, features: [] });
});

test('switched on, each publish counts for its site, a repository that is no site on Kiln counts nothing, and a burst of 1,000 is one row', { skip: d1Skip }, async () => {
  const env = world();
  await notePublish(env, 'ada/club', { by: 'person' });
  await notePublish(env, 'ADA/Club', { by: 'editor', now: Date.now() + 120e3 });
  await noteFeature(env, { feature: 'api', repo: 'Uma/Cafe' });
  await noteFeature(env, { feature: 'schedule', site_id: 'site-2' });
  assert.equal(await noteFeature(env, { feature: 'api', repo: 'some/one-else' }), true);   // written, and nothing matched
  assert.deepEqual(rows(env), [
    { site_id: 'site-2', feature: 'api', count: 1 },
    { site_id: 'site-1', feature: 'publish', count: 2 },
    { site_id: 'site-2', feature: 'schedule', count: 1 },
  ]);
  let writes = 0;
  const prepare = env.kiln_cloud.prepare.bind(env.kiln_cloud);
  env.kiln_cloud.prepare = (sql) => { if (sql.startsWith('INSERT INTO feature_use')) writes++; return prepare(sql); };
  const all = await Promise.all(Array.from({ length: 1000 }, () => noteFeature(env, { feature: 'api', repo: 'ada/club' })));
  assert.ok(all.every(Boolean));
  assert.ok(writes <= 2, `written ${writes} times`);
  assert.equal(env.kiln_cloud.row("SELECT count FROM feature_use WHERE site_id = 'site-1' AND feature = 'api'").count, 1000);
});

test('a count that cannot be kept is said in the log and dropped, and the request answers as before', { skip: d1Skip }, async () => {
  const env = editorWorld();
  env.kiln_cloud.db.exec('DROP TABLE feature_use');
  let answered;
  const said = await hushed(async () => { answered = await comment(env); });
  assert.equal(answered.status, 200);
  assert.deepEqual(lines(said, 'feature_not_written').map(l => l.feature), ['comment']);
});

test('the five-minute run deletes old rows and those of sites gone; a removed site takes its rows; only the operator reads the counts, unused features included', { skip: d1Skip }, async () => {
  const env = world();
  const week = easternMonday(Date.now());
  const put = (w, site, feature, count) => env.kiln_cloud.exec('INSERT INTO feature_use (week, site_id, feature, count) VALUES (?,?,?,?)', w, site, feature, count);
  put(week, 'site-1', 'publish', 5);
  put(dayPlus(week, -7), 'site-2', 'publish', 2);
  put(dayPlus(week, -35), 'site-1', 'comment', 1);   // five weeks ago: in the last 12, not the last 4
  put(dayPlus(week, -406), 'site-1', 'api', 9);      // older than 400 days
  put(week, 'site-gone', 'api', 3);
  await quiet(() => hushed(() => worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env)));
  assert.deepEqual(rows(env).map(r => [r.site_id, r.feature]), [['site-1', 'comment'], ['site-1', 'publish'], ['site-2', 'publish']]);
  for (const token of ['tok-uma', 'nobody']) assert.equal((await call(env, '/admin/cloud/features', { token })).status, 403);
  const page = (await call(env, '/admin/cloud/features')).json;
  assert.equal(page.recording, true);
  assert.equal(page.sites, 2);
  assert.deepEqual(page.features.map(f => f.feature), FEATURES);
  const of = (f) => page.features.find(x => x.feature === f);
  assert.deepEqual(of('publish'), { feature: 'publish', sites_4: 2, count_4: 7, sites_12: 2, count_12: 7 });
  assert.deepEqual(of('comment'), { feature: 'comment', sites_4: 0, count_4: 0, sites_12: 1, count_12: 1 });
  assert.deepEqual(of('writing_helper'), { feature: 'writing_helper', sites_4: 0, count_4: 0, sites_12: 0, count_12: 0 });
  // The owner removes site-2, and the operator removes site-1: their rows go with them.
  await quiet(() => hushed(() => call(env, '/cloud/sites/remove', { method: 'POST', token: 'tok-uma', body: { id: 'site-2' } })));
  assert.deepEqual(rows(env).map(r => r.site_id), ['site-1', 'site-1']);
  await quiet(() => hushed(() => call(env, '/admin/cloud/remove', { method: 'POST', body: { site_id: 'site-1' } })));
  assert.equal(total(env), 0);
});
