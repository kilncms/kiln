/**
 * When a Kiln Cloud plan ends, a site's API tokens and scheduled publishes
 * stop with its editing (Erik, 2026-10-22). A paying or trialing site is
 * untouched, and so is a repository with no Cloud site at all (self-hosted,
 * or listed by hand), and so is every site when the database cannot be read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker from '../worker/index.js';
import { repoPlanEnded } from '../worker/cloud.js';
import { fakeKV, withFetch } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

const DAY = 86400e3;
const SECRET = 'a'.repeat(64);
const ATOK = `atok:${createHash('sha256').update(SECRET).digest('hex')}`;
const token = (repo) => ({ id: 'abcd1234', repo, name: 'newsletter script', paths: [''], keys: [], readonly: false, created: 5, exp: null });
const offline = async () => { throw new Error('no network in this test'); };
const readFields = (env) => worker.fetch(new Request('https://worker.example/api/v1/fields?path=/', { headers: { Authorization: `Bearer ${SECRET}` } }), env);

test('repoPlanEnded: ended only when every Cloud site for the repository has lost access', { skip: d1Skip }, async () => {
  const env = cloudEnv(fakeKV());
  assert.equal(await repoPlanEnded(env, 'ada/club'), false, 'no Cloud site: not ended');
  addSite(env, { status: 'canceled' });
  assert.equal(await repoPlanEnded(env, 'ada/club'), true, 'canceled with no paid time left');
  assert.equal(await repoPlanEnded(env, 'ADA/Club'), true, 'GitHub names ignore case');
  env.kiln_cloud.exec('UPDATE sites SET access_until = ?', Date.now() + 3 * DAY);
  assert.equal(await repoPlanEnded(env, 'ada/club'), false, 'canceled, but paid to the end of the month');
  env.kiln_cloud.exec("UPDATE sites SET status = 'past_due', access_until = ?", Date.now() - DAY);
  assert.equal(await repoPlanEnded(env, 'ada/club'), true, 'failed payment past its grace');
  addSite(env, { id: 'site-2', origin: 'https://www.club.example', status: 'active' });
  assert.equal(await repoPlanEnded(env, 'ada/club'), false, 'any one paying site keeps the repository on');
});

test('repoPlanEnded: no database, or a database that fails, never stops a site', async () => {
  assert.equal(await repoPlanEnded({}, 'ada/club'), false);
  const broken = { kiln_cloud: { prepare: () => { throw new Error('D1 down'); } } };
  assert.equal(await repoPlanEnded(broken, 'ada/club'), false);
});

test('API tokens: refused with a plain reason once the plan has ended; working while it is paid', { skip: d1Skip }, async () => {
  await withFetch(offline, async () => {
    const ended = cloudEnv(fakeKV({ [ATOK]: token('ada/club') }));
    addSite(ended, { status: 'canceled' });
    const res = await readFields(ended);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'plan_ended');
    assert.match(body.error, /plan has ended/);
    assert.ok(ended.KILN.map.has(ATOK), 'the token is kept, so renewing brings it back');

    const paid = cloudEnv(fakeKV({ [ATOK]: token('ada/club') }));
    addSite(paid, { status: 'active' });
    const ok = await readFields(paid);
    assert.notEqual(ok.status, 401);
    assert.notEqual((await ok.json().catch(() => ({}))).code, 'plan_ended');
  });
});

test('scheduled publishes: held, not published or deleted, once the plan has ended', { skip: d1Skip }, async () => {
  const due = { repo: 'ada/club', path: 'index.html', branch: 'main', edits: [{ key: 't', html: 'New' }], content: null, message: 'Scheduled', at: Date.now() - 1000, desc: 'index', by: 'Ada', byEmail: 'ada@example.com', admin: true };
  await withFetch(offline, async (calls) => {
    const ended = cloudEnv(fakeKV({ 'sched:one': due, 'itok:ada/club': 'ghs_in_hand' }));
    addSite(ended, { status: 'canceled' });
    await worker.scheduled({}, ended);
    assert.ok(ended.KILN.map.has('sched:one'), 'held');
    assert.equal(calls.filter(c => /api\.github\.com/.test(c.url)).length, 0, 'nothing sent to GitHub');
  });
  await withFetch(offline, async (calls) => {
    const paid = cloudEnv(fakeKV({ 'sched:one': due, 'itok:ada/club': 'ghs_in_hand' }));
    addSite(paid, { status: 'active' });
    await worker.scheduled({}, paid);
    assert.ok(calls.some(c => /api\.github\.com/.test(c.url)), 'a paying site goes on to publish');
  });
});

test('an editor session used from outside a browser cannot publish once the plan has ended', { skip: d1Skip }, async () => {
  const SESS = 'b'.repeat(64);
  const editor = { repo: 'ada/club', name: 'Sam', role: 'editor', email: 'sam@example.com', paths: [''], keys: [], features: null, mode: null, created: 1, exp: null };
  const ask = (env) => worker.fetch(new Request('https://worker.example/gh/repos/ada/club/contents/index.html?ref=main', { headers: { 'X-Kiln-Session': SESS } }), env);
  await withFetch(offline, async () => {
    const ended = cloudEnv(fakeKV({ [`esess:${SESS}`]: editor }));
    addSite(ended, { status: 'canceled' });
    const res = await ask(ended);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'plan_ended');
    const paid = cloudEnv(fakeKV({ [`esess:${SESS}`]: editor }));
    addSite(paid, { status: 'active' });
    const ok = await ask(paid);
    assert.notEqual((await ok.json().catch(() => ({}))).code, 'plan_ended');
  });
});

const cloudCall = (env, method, pathname, body) => worker.fetch(new Request(`https://worker.example${pathname}`, {
  method, headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
}), env);

test('after Remove, the repository counts as ended (tokens and schedules stay stopped); adding it again clears that', { skip: d1Skip }, async () => {
  await withFetch(async () => new Response('{}', { status: 404 }), async () => {
    const env = cloudEnv(fakeKV());
    addSite(env, { status: 'trialing' });
    assert.equal(await repoPlanEnded(env, 'ada/club'), false);
    const res = await cloudCall(env, 'POST', '/cloud/sites/remove', { id: 'site-1' });
    assert.equal(res.status, 200);
    assert.equal(await repoPlanEnded(env, 'ada/club'), true, 'removed: still stopped');
    assert.equal(await repoPlanEnded(env, 'someone/else'), false, 'a repository never on Cloud is unaffected');
  });
});

test('renewing: a subscription that has run out can be replaced; one still paid up is resumed, not paid twice', { skip: d1Skip }, async () => {
  const ls = async (url) => url.includes('/checkouts')
    ? new Response(JSON.stringify({ data: { attributes: { url: 'https://pay.example/c' } } }), { status: 201 })
    : undefined;
  await withFetch(ls, async () => {
    const ended = cloudEnv(fakeKV());
    addSite(ended, { status: 'canceled', ls_subscription_id: '77' });
    const r1 = await cloudCall(ended, 'GET', '/cloud/checkout?site=site-1');
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).url, 'https://pay.example/c');

    const paidUp = cloudEnv(fakeKV());
    addSite(paidUp, { status: 'canceled', ls_subscription_id: '77' });
    paidUp.kiln_cloud.exec('UPDATE sites SET access_until = ?', Date.now() + 5 * DAY);
    const r2 = await cloudCall(paidUp, 'GET', '/cloud/checkout?site=site-1');
    assert.equal(r2.status, 409);
    assert.match((await r2.json()).error, /resume it under Manage billing/);

    const active = cloudEnv(fakeKV());
    addSite(active, { status: 'active', ls_subscription_id: '77' });
    assert.equal((await cloudCall(active, 'GET', '/cloud/checkout?site=site-1')).status, 409);
  });
});

test('a members sign-in is no longer good once the site’s plan has ended', { skip: d1Skip }, async () => {
  const SID = 'c'.repeat(32);
  const member = { repo: 'ada/club', email: 'm@example.com', origin: 'https://club.example' };
  const people = [{ email: 'm@example.com', name: 'M', role: 'member', days: 30 }];
  const check = (env) => worker.fetch(new Request('https://worker.example/members/check', { method: 'POST', body: JSON.stringify({ sid: SID, origin: 'https://club.example' }) }), env).then(r => r.json());
  await withFetch(offline, async () => {
    const paid = cloudEnv(fakeKV({ [`msess:${SID}`]: member, 'people:ada/club': people }));
    addSite(paid, { status: 'active' });
    assert.equal((await check(paid)).ok, true);
    const ended = cloudEnv(fakeKV({ [`msess:${SID}`]: member, 'people:ada/club': people }));
    addSite(ended, { status: 'canceled' });
    assert.equal((await check(ended)).ok, false);
  });
});
