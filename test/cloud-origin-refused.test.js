/**
 * Signing in on an address the worker does not serve.
 *
 * A customer whose free trial ran out, or whose plan ended, opens
 * yoursite.com/kiln and is sent here. The page used to say "Origin not
 * allowed … ALLOWED_ORIGINS", which tells a customer nothing. It now says what
 * happened and what to do, and only someone who runs the worker themselves is
 * told about ALLOWED_ORIGINS. The status stays 403 in every case (`kiln
 * doctor` reads it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { cloudOriginStanding } from '../worker/cloud.js';
import { fakeKV } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

const DASH = 'https://app.example';
const creds = (kv) => kv.map.set('app:creds', JSON.stringify({ app_id: 1, slug: 'kiln-cms', client_id: 'cid', client_secret: 'sec' }));
async function signIn(env, origin, path = '/auth/login') {
  const res = await worker.fetch(new Request(`https://worker.example${path}?origin=${encodeURIComponent(origin)}&return_to=%2F&repo=ada%2Fclub`), env);
  return { status: res.status, text: await res.text(), location: res.headers.get('Location') };
}
const cloud = (extra = {}) => { const kv = fakeKV(); creds(kv); return cloudEnv(kv, { CLOUD_DASHBOARD: DASH, GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 's', ...extra }); };

test('a site whose free trial ran out: the page says so, and sends the owner to Subscribe', { skip: d1Skip }, async () => {
  const env = cloud();
  addSite(env, { status: 'canceled', ls_subscription_id: null });
  for (const path of ['/auth/login', '/google/login']) {
    const r = await signIn(env, 'https://club.example', path);
    assert.equal(r.status, 403, path);
    assert.match(r.text, /<title>This site’s free trial has ended · Kiln<\/title>/, path);
    assert.match(r.text, /until its owner subscribes\./);
    assert.match(r.text, /everything already published, are untouched/);
    assert.match(r.text, new RegExp(`href="${DASH}"`));
    assert.doesNotMatch(r.text, /ALLOWED_ORIGINS|Origin not allowed/);
  }
});

test('a site whose paid plan ended: the page says the plan ended, and that subscribing again brings editing back', { skip: d1Skip }, async () => {
  const env = cloud();
  addSite(env, { status: 'canceled', ls_subscription_id: '77' });
  const r = await signIn(env, 'https://club.example');
  assert.equal(r.status, 403);
  assert.match(r.text, /This site’s Kiln plan has ended/);
  assert.match(r.text, /until its owner subscribes again\./);
  assert.doesNotMatch(r.text, /ALLOWED_ORIGINS/);
});

test('an address nobody added: the page says to add it with exactly this address, www or not', { skip: d1Skip }, async () => {
  const env = cloud();
  addSite(env, { status: 'active', origin: 'https://club.example' });
  const r = await signIn(env, 'https://www.club.example');
  assert.equal(r.status, 403);
  assert.match(r.text, /This site is not on Kiln Cloud yet/);
  assert.match(r.text, /<strong>https:\/\/www\.club\.example<\/strong>/);
  assert.match(r.text, /two different addresses/);
  assert.doesNotMatch(r.text, /ALLOWED_ORIGINS/);
});

test('a site that may be edited is not refused at all', { skip: d1Skip }, async () => {
  const env = cloud();
  addSite(env, { status: 'trialing' });
  const r = await signIn(env, 'https://club.example');
  assert.equal(r.status, 302);
  assert.match(r.location, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
});

test('a worker someone runs themselves keeps the hint about ALLOWED_ORIGINS, in plain words, and escapes the address', async () => {
  const kv = fakeKV(); creds(kv);
  const env = { KILN: kv, ALLOWED_ORIGINS: 'https://mine.example' };
  const r = await signIn(env, 'https://other.example/"><script>x</script>');
  assert.equal(r.status, 403);
  assert.match(r.text, /This address is not on the list/);
  assert.match(r.text, /ALLOWED_ORIGINS/);
  assert.doesNotMatch(r.text, /<script>x<\/script>/);
});

test('cloudOriginStanding: null without a database, and when the database cannot be read', async () => {
  assert.equal(await cloudOriginStanding({}, 'https://club.example'), null);
  assert.equal(await cloudOriginStanding({ kiln_cloud: { prepare() { throw new Error('down'); } } }, 'https://club.example'), null);
  assert.equal(await cloudOriginStanding({ kiln_cloud: {} }, ''), null);
});

async function standing(env, origin) {
  const res = await worker.fetch(new Request(`https://worker.example/standing?origin=${encodeURIComponent(origin)}`), env);
  return { status: res.status, acao: res.headers.get('Access-Control-Allow-Origin'), json: await res.json() };
}

test('/standing: tells the editor whether an address may be edited, and when it may not, whether a trial or a plan ended', { skip: d1Skip }, async () => {
  const env = cloud();
  addSite(env, { id: 'a', origin: 'https://live.example', status: 'trialing' });
  addSite(env, { id: 'b', origin: 'https://trial-over.example', status: 'canceled', ls_subscription_id: null });
  addSite(env, { id: 'c', origin: 'https://plan-over.example', status: 'canceled', ls_subscription_id: '77' });
  const live = await standing(env, 'https://live.example');
  assert.equal(live.status, 200);
  assert.equal(live.acao, '*', 'readable from a page whose address may not be edited');
  assert.deepEqual(live.json, { editable: true });
  assert.deepEqual((await standing(env, 'https://trial-over.example')).json, { editable: false, reason: 'trial_ended', dashboard: DASH });
  assert.deepEqual((await standing(env, 'https://plan-over.example/some/page')).json, { editable: false, reason: 'plan_ended', dashboard: DASH });
  assert.deepEqual((await standing(env, 'https://nobody.example')).json, { editable: false, reason: 'unknown' });
  assert.deepEqual((await standing(env, 'not an address')).json, { editable: false, reason: 'unknown' });
});

test('/standing on a worker someone runs themselves: the allowed list is the whole answer', async () => {
  const env = { KILN: fakeKV(), ALLOWED_ORIGINS: 'https://mine.example' };
  assert.deepEqual((await standing(env, 'https://mine.example')).json, { editable: true });
  assert.deepEqual((await standing(env, 'https://other.example')).json, { editable: false, reason: 'unknown' });
});
