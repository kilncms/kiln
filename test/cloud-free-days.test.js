// Fair use of the free days: they cannot be started again and again.
//
// A site's seven free days are counted from the EARLIEST of three marks kept
// in KV for good: the address as it was typed (`firstseen:<address>`), the
// repository by GitHub's permanent number (`firstseen:repo:<number>`) and the
// GitHub account by its permanent number (`firstseen:gh:<number>`, counted
// only for an account that pays for no site). A site added when its days are
// over is written `canceled` at once, and the answer says why in `free_days`.
// A domain has a mark of its own (`firstseen:domain:<name>`), written when a
// site that is not paid for goes live on it.
//
// Time passes here by writing a mark back in time: the service has no clock
// to turn. A site is taken off by deleting its row, which is all of Remove
// that touches the free days (Remove leaves every `firstseen:` mark alone).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../worker/index.js';
import { freeDayClock, domainFreeDays } from '../worker/cloud.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

const DAY = 86400 * 1000;
const APP_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const REPO_OVER = "This repository has had its free days on Kiln, and they are over, so this site has none. Subscribe on the site's row to edit it.";
const ACCOUNT_OVER = "Your free days began with the first site you added here, and they are over, so this site has none. Subscribe on the site's row to edit it.";
const left = (much) => `Your free days began with the first site you added here, so this site has ${much} left. Subscribe on the site's row before they end to keep editing it.`;
const domainOver = (d) => `${d} has had its free days on Kiln, and they are over. Subscribe on the site's row to keep this site up at ${d}.`;

/**
 * A service with Ada (GitHub's number 101, token 'ada') and Bo (202, token
 * 'bo') signed in, and Ada once more on a session from before the number was
 * kept (token 'tok'). GitHub knows each repository in `numbers` by its number.
 */
function world(numbers = { 'ada/club': 4242 }) {
  const env = cloudEnv(fakeKV(), { CLOUD_DASHBOARD: 'https://app.example', LS_API_KEY: '' });
  env.KILN.map.set('app:creds', JSON.stringify({ app_id: 1, slug: 'kiln-cms', client_id: 'cid', client_secret: 'sec', pk8: APP_KEY }));
  env.kiln_cloud.exec("INSERT INTO accounts (id, github_login, email, created_at) VALUES ('acct-2', 'bo', 'bo@example.com', 1)");
  env.KILN.map.set('csess:ada', JSON.stringify({ account_id: 'acct-1', login: 'ada', uid: 101, gh: 'gho_a' }));
  env.KILN.map.set('csess:bo', JSON.stringify({ account_id: 'acct-2', login: 'bo', uid: 202, gh: 'gho_b' }));
  const handler = async (url) => {
    const m = /^https:\/\/api\.github\.com\/repos\/([\w.-]+\/[\w.-]+?)(\/installation)?$/.exec(url);
    if (!m) return undefined;
    if (m[2]) return jsonRes({ id: 1 });
    return m[1] in numbers ? jsonRes({ id: numbers[m[1]], full_name: m[1], permissions: { push: true } }) : undefined;
  };
  return { env, handler, numbers };
}
const add = (w, token, repo, origin) => withFetch(w.handler, async () => {
  const res = await worker.fetch(new Request('https://worker.example/cloud/sites', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ repo, origin, plan: 'cloud' }) }), w.env);
  return { status: res.status, json: await res.json().catch(() => null) };
});
const added = async (w, token, repo, origin) => { const a = await add(w, token, repo, origin); assert.equal(a.status, 200, JSON.stringify(a.json)); return a.json; };
const row = (env, id) => env.kiln_cloud.prepare('SELECT status, created_at FROM sites WHERE id = ?').bind(id).first();
const remove = (env, id) => env.kiln_cloud.exec('DELETE FROM sites WHERE id = ?', id);
const ago = (env, days, ...keys) => { const t = Date.now() - days * DAY; for (const k of keys) env.KILN.map.set(k, String(t)); return t; };
const marks = (env) => [...env.KILN.map.keys()].filter(k => k.startsWith('firstseen:')).sort();
const CLUB = ['firstseen:gh:101', 'firstseen:https://club.example', 'firstseen:repo:4242'];

test('free days: a first site has its seven days, and the address, the repository and the account are each marked once', { skip: d1Skip }, async () => {
  const w = world();
  const t0 = Date.now();
  const a = await added(w, 'ada', 'ada/club', 'https://club.example');
  assert.equal(a.site.status, 'trialing');
  assert.ok(a.site.created_at >= t0);
  assert.equal('free_days' in a, false, 'nothing to say: the days start with this site');
  assert.deepEqual(marks(w.env), CLUB);
  for (const k of CLUB) assert.equal(Number(w.env.KILN.map.get(k)), a.site.created_at);
});

test('free days: removing a site and adding its repository again at a new address keeps the old clock, and says how many days are left', { skip: d1Skip }, async () => {
  const w = world();
  const first = await added(w, 'ada', 'ada/club', 'https://club.example');
  const began = ago(w.env, 3, ...CLUB);
  remove(w.env, first.site.id);
  const again = await added(w, 'ada', 'ada/club', 'https://www.club.example');
  assert.deepEqual([again.site.status, again.site.created_at], ['trialing', began]);
  assert.equal(again.free_days, left('4 free days'));
  assert.equal(Number(w.env.KILN.map.get('firstseen:repo:4242')), began, 'a mark is never written again');
  // part of a day is a day, and the last day is "less than one"
  ago(w.env, 6.5, ...CLUB);
  remove(w.env, again.site.id);
  const last = await added(w, 'ada', 'ada/club', 'https://club-ada.pages.example');
  assert.equal(last.site.status, 'trialing');
  assert.equal(last.free_days, left('less than one free day'));
});

test('free days: a repository whose days are over is written as ended at once, never as on trial, and the answer says why', { skip: d1Skip }, async () => {
  const w = world();
  const first = await added(w, 'ada', 'ada/club', 'https://club.example');
  const began = ago(w.env, 8, ...CLUB);
  remove(w.env, first.site.id);
  const again = await added(w, 'ada', 'ada/club', 'https://www.club.example');
  assert.equal(again.free_days, REPO_OVER);
  assert.deepEqual([again.site.status, again.site.created_at], ['canceled', began]);
  assert.deepEqual({ ...(await row(w.env, again.site.id)) }, { status: 'canceled', created_at: began }, 'the row itself, with no sweep in between');
});

test('free days: another account adding the same repository, under a new name and address, keeps the repository\'s clock', { skip: d1Skip }, async () => {
  const w = world({ 'ada/club': 4242, 'bo/club-moved': 4242 });
  const first = await added(w, 'ada', 'ada/club', 'https://club.example');
  remove(w.env, first.site.id);
  // two days in: Bo has what is left of them, and nothing is said, since his own account is new here
  const began = ago(w.env, 2, 'firstseen:repo:4242');
  const bo = await added(w, 'bo', 'bo/club-moved', 'https://club-moved.example');
  assert.deepEqual([bo.site.status, bo.site.created_at, 'free_days' in bo], ['trialing', began, false]);
  assert.ok(w.env.KILN.map.has('firstseen:gh:202'), "Bo's account is marked too");
  // eight days in: none
  remove(w.env, bo.site.id);
  ago(w.env, 8, 'firstseen:repo:4242');
  const late = await added(w, 'bo', 'bo/club-moved', 'https://club-again.example');
  assert.deepEqual([late.site.status, late.free_days], ['canceled', REPO_OVER]);
});

test('free days: an account that pays for nothing has them once, so a new repository after they are over has none', { skip: d1Skip }, async () => {
  const w = world({ 'ada/club': 4242, 'ada/shop': 777 });
  await added(w, 'ada', 'ada/club', 'https://club.example');
  ago(w.env, 9, 'firstseen:gh:101');
  const shop = await added(w, 'ada', 'ada/shop', 'https://shop.example');
  assert.deepEqual([shop.site.status, shop.free_days], ['canceled', ACCOUNT_OVER]);
  assert.equal((await row(w.env, shop.site.id)).status, 'canceled');
});

test('free days: an account that pays for a site gets fresh days on a new repository, and is held to its mark again once it pays for nothing', { skip: d1Skip }, async () => {
  const w = world({ 'ada/shop': 777, 'ada/blog': 778 });
  addSite(w.env, { id: 'paid', repo: 'ada/paid', origin: 'https://paid.example', status: 'active', ls_subscription_id: 'sub-1', created_at: 1 });
  ago(w.env, 30, 'firstseen:gh:101');
  const t0 = Date.now();
  const shop = await added(w, 'ada', 'ada/shop', 'https://shop.example');
  assert.equal(shop.site.status, 'trialing');
  assert.ok(shop.site.created_at >= t0, 'seven days from now');
  assert.equal('free_days' in shop, false);
  w.env.kiln_cloud.exec("UPDATE sites SET status = 'canceled' WHERE id = 'paid'");
  const blog = await added(w, 'ada', 'ada/blog', 'https://blog.example');
  assert.deepEqual([blog.site.status, blog.free_days], ['canceled', ACCOUNT_OVER]);
});

test('free days: a session from before the account\'s number was kept still adds a site, and only the other marks count', { skip: d1Skip }, async () => {
  const w = world({ 'ada/club': 4242, 'ada/shop': 777 });
  ago(w.env, 30, 'firstseen:gh:101');
  const t0 = Date.now();
  const shop = await added(w, 'tok', 'ada/shop', 'https://shop.example');
  assert.equal(shop.site.status, 'trialing');
  assert.ok(shop.site.created_at >= t0);
  assert.equal('free_days' in shop, false);
  assert.deepEqual(marks(w.env), ['firstseen:gh:101', 'firstseen:https://shop.example', 'firstseen:repo:777'], 'no account mark is written without the number');
  // the repository's mark holds for that session as for any other
  ago(w.env, 8, 'firstseen:repo:4242');
  const club = await added(w, 'tok', 'ada/club', 'https://club.example');
  assert.deepEqual([club.site.status, club.free_days], ['canceled', REPO_OVER]);
});

test('free days: when GitHub does not give the repository\'s number the site is added all the same, on the address alone', { skip: d1Skip }, async () => {
  const w = world({});
  const a = await added(w, 'tok', 'ada/club', 'https://club.example');
  assert.equal(a.site.status, 'trialing');
  assert.deepEqual(marks(w.env), ['firstseen:https://club.example']);
  // the same address again after its days: ended at once, as for any site whose days are over
  const began = ago(w.env, 8, 'firstseen:https://club.example');
  remove(w.env, a.site.id);
  const again = await added(w, 'tok', 'ada/club', 'https://club.example');
  assert.deepEqual([again.site.status, again.site.created_at, 'free_days' in again], ['canceled', began, false]);
});

test('free days: the clock starts at the earliest mark, whichever it is', { skip: d1Skip }, async () => {
  const env = cloudEnv(fakeKV());
  const now = Date.now();
  env.KILN.map.set('firstseen:https://a.example', String(now - 1 * DAY));
  env.KILN.map.set('firstseen:repo:5', String(now - 5 * DAY));
  env.KILN.map.set('firstseen:gh:9', String(now - 3 * DAY));
  const ask = (over = {}) => freeDayClock(env, { accountId: 'acct-1', origin: 'https://a.example', repoId: 5, ghId: 9, now, ...over });
  assert.deepEqual(await ask(), { began: now - 5 * DAY, over: false, sentence: null });
  assert.deepEqual(await ask({ repoId: null }), { began: now - 3 * DAY, over: false, sentence: left('4 free days') });
  assert.deepEqual(await ask({ repoId: null, ghId: null }), { began: now - 1 * DAY, over: false, sentence: null });
  // both the repository's days and the account's are over: the repository is named
  env.KILN.map.set('firstseen:repo:5', String(now - 20 * DAY));
  env.KILN.map.set('firstseen:gh:9', String(now - 20 * DAY));
  assert.deepEqual(await ask(), { began: now - 20 * DAY, over: true, sentence: REPO_OVER });
  assert.deepEqual(await ask({ repoId: null }), { began: now - 20 * DAY, over: true, sentence: ACCOUNT_OVER });
});

test('free days: a domain is marked when a site that is not paid for goes live on it, and a later site on that domain gets no fresh days', { skip: d1Skip }, async () => {
  const env = cloudEnv(fakeKV());
  const now = Date.now();
  const KEY = 'firstseen:domain:oakbakery.test';
  addSite(env, { id: 's1', repo: 'k/s1', origin: 'https://s1.example', status: 'trialing', created_at: now - 2 * DAY });
  // setting a domain up only reads; going live writes when that site's free days began, under the name in lower case
  assert.equal(await domainFreeDays(env, 's1', 'OakBakery.Test', { now }), null);
  assert.equal(env.KILN.map.has(KEY), false);
  assert.equal(await domainFreeDays(env, 's1', 'OakBakery.Test', { now, goesLive: true }), null);
  assert.equal(env.KILN.map.get(KEY), String(now - 2 * DAY));
  assert.deepEqual({ ...(await row(env, 's1')) }, { status: 'trialing', created_at: now - 2 * DAY });
  // a day later, a new site on the same domain: its days are the domain's, with six left of them
  addSite(env, { id: 's3', repo: 'k/s3', origin: 'https://s3.example', status: 'trialing', created_at: now + DAY });
  assert.equal(await domainFreeDays(env, 's3', 'oakbakery.test', { now: now + DAY, goesLive: true }), null);
  assert.deepEqual({ ...(await row(env, 's3')) }, { status: 'trialing', created_at: now - 2 * DAY });
  // six days later the domain's days are over: a new site is brought in line at once, and its owner is told
  const later = now + 6 * DAY;
  addSite(env, { id: 's2', repo: 'k/s2', origin: 'https://s2.example', status: 'trialing', created_at: later });
  assert.equal(await domainFreeDays(env, 's2', 'oakbakery.test', { now: later }), domainOver('oakbakery.test'));
  assert.deepEqual({ ...(await row(env, 's2')) }, { status: 'canceled', created_at: now - 2 * DAY });
  // a site that is paid for is left alone, and writes no mark
  addSite(env, { id: 's4', repo: 'k/s4', origin: 'https://s4.example', status: 'active', ls_subscription_id: 'sub-4', created_at: later });
  assert.equal(await domainFreeDays(env, 's4', 'oakbakery.test', { now: later, goesLive: true }), null);
  assert.deepEqual({ ...(await row(env, 's4')) }, { status: 'active', created_at: later });
  assert.equal(await domainFreeDays(env, 's4', 'paid.test', { now: later, goesLive: true }), null);
  assert.equal(env.KILN.map.has('firstseen:domain:paid.test'), false);
  assert.equal(env.KILN.map.get(KEY), String(now - 2 * DAY), 'the mark is never written again');
});
