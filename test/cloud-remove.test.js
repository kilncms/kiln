/**
 * S5 — removing a site from Kiln Cloud cannot leave its owner paying.
 * The real handlers run over a SQLite-backed D1 stand-in; Stripe is a fetch
 * stand-in that records every call. The real billing API is never called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

const API = 'https://api.stripe.com/v1';
const ENDED = '2026-11-01T00:00:00.000Z';   // when the cancelled subscription ended; Stripe gives it in seconds
const post = (env, path, body, token = 'tok') => worker.fetch(new Request(`https://worker.example${path}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), env);
const sub = (status, extra = {}) => jsonRes({ id: 'sub_77', object: 'subscription', status, ended_at: status === 'canceled' ? Date.parse(ENDED) / 1000 : null, ...extra });
/** Stripe with one subscription in `status`; DELETE answers with `onCancel()`. */
const stripe = (status, onCancel = () => sub('canceled')) => async (url, init) => {
  if (url !== `${API}/subscriptions/sub_77`) return;
  return init.method === 'DELETE' ? onCancel() : sub(status);
};
const siteCount = (env) => env.kiln_cloud.row('SELECT COUNT(*) n FROM sites').n;
const cancels = (calls) => calls.filter(c => c.method === 'DELETE');

test('S5 remove: a site with a live subscription is cancelled at Stripe first, then removed', { skip: d1Skip }, async () => {
  for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'paused']) {
    const env = cloudEnv(fakeKV());
    addSite(env, { stripe_subscription_id: 'sub_77' });
    await withFetch(stripe(status), async (calls) => {
      const res = await post(env, '/cloud/sites/remove', { id: 'site-1' });
      assert.equal(res.status, 200, status);
      assert.deepEqual(await res.json(), { ok: true, subscription: 'cancelled', ends_at: ENDED });
      assert.equal(cancels(calls).length, 1, `one cancellation for ${status}`);
      assert.equal(cancels(calls)[0].url, `${API}/subscriptions/sub_77`);
      assert.equal(cancels(calls)[0].headers.Authorization, 'Bearer sk_test_key');
      assert.equal(siteCount(env), 0);
    });
  }
});

test('S5 remove: when the cancellation cannot be confirmed the site stays, with Manage billing, and the answer says what to do', { skip: d1Skip }, async () => {
  const cases = {
    'Stripe refuses the cancellation': [stripe('active', () => jsonRes({ error: { message: 'no' } }, 400)), 'cancel_refused'],
    'Stripe answers 200 but the subscription is still active': [stripe('active', () => sub('active')), 'cancel_refused'],
    'Stripe is down': [async () => jsonRes({}, 503), 'billing_unreachable'],
    'the network fails': [async () => { throw new Error('connect failed'); }, 'billing_unreachable'],
    'this key cannot see the subscription (it is for the other mode, test or live)': [async () => jsonRes({ error: {} }, 404), 'subscription_not_found'],
  };
  for (const [name, [handler, reason]] of Object.entries(cases)) {
    const env = cloudEnv(fakeKV());
    addSite(env, { stripe_subscription_id: 'sub_77' });
    await withFetch(handler, async () => {
      const res = await post(env, '/cloud/sites/remove', { id: 'site-1' });
      assert.equal(res.status, 502, name);
      const body = await res.json();
      assert.equal(body.code, 'subscription_not_cancelled', name);
      assert.equal(body.reason, reason, name);
      assert.match(body.error, /was not removed/);
      assert.match(body.error, /Manage billing/);
      assert.equal(siteCount(env), 1, `${name}: the site is still there`);
      assert.equal(env.kiln_cloud.row('SELECT stripe_subscription_id s FROM sites').s, 'sub_77');
    });
  }
  // Stripe's key missing on this worker: nothing can be cancelled from here.
  const env = cloudEnv(fakeKV(), { STRIPE_SECRET_KEY: '' });
  addSite(env, { stripe_subscription_id: 'sub_77' });
  await withFetch(stripe('active'), async (calls) => {
    const res = await post(env, '/cloud/sites/remove', { id: 'site-1' });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).reason, 'billing_not_configured');
    assert.equal(calls.length, 0);
    assert.equal(siteCount(env), 1);
  });
});

test('S5 remove: no subscription, or one that has already ended, is removed without a cancellation call', { skip: d1Skip }, async () => {
  const trial = cloudEnv(fakeKV());
  addSite(trial, { status: 'trialing' });
  await withFetch(stripe('active'), async (calls) => {
    const res = await post(trial, '/cloud/sites/remove', { id: 'site-1' });
    assert.deepEqual(await res.json(), { ok: true, subscription: 'none' });
    assert.equal(calls.length, 0, 'Stripe is not asked at all');
    assert.equal(siteCount(trial), 0);
  });
  for (const status of ['canceled', 'incomplete_expired']) {
    const env = cloudEnv(fakeKV());
    addSite(env, { status: 'canceled', stripe_subscription_id: 'sub_77' });
    await withFetch(stripe(status), async (calls) => {
      const res = await post(env, '/cloud/sites/remove', { id: 'site-1' });
      assert.equal((await res.json()).subscription, 'already_cancelled');
      assert.equal(cancels(calls).length, 0);
      assert.equal(siteCount(env), 0);
    });
  }
});

test('S5 remove: only the signed-in account\'s own site; another account\'s subscription is never touched', { skip: d1Skip }, async () => {
  const env = cloudEnv(fakeKV());
  addSite(env, { account_id: 'someone-else', stripe_subscription_id: 'sub_77' });
  await withFetch(stripe('active'), async (calls) => {
    assert.equal((await post(env, '/cloud/sites/remove', { id: 'site-1' })).status, 200);
    assert.equal(calls.length, 0);
    assert.equal(siteCount(env), 1);
    assert.equal((await post(env, '/cloud/sites/remove', { id: 'site-1' }, 'not-a-session')).status, 401);
    assert.equal((await post(env, '/cloud/sites/remove', {})).status, 200);
    assert.equal(siteCount(env), 1);
  });
});

test('S5 admin remove: the operator is held to the same rule, and can force it after cancelling by hand', { skip: d1Skip }, async () => {
  const env = cloudEnv(fakeKV(), { CLOUD_ADMIN: 'ada' });
  addSite(env, { account_id: 'someone-else', stripe_subscription_id: 'sub_77' });
  await withFetch(async () => jsonRes({}, 404), async () => {
    const res = await post(env, '/admin/cloud/remove', { site_id: 'site-1' });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /cancel it in Stripe, then remove with force/);
    assert.equal(siteCount(env), 1);
    const forced = await post(env, '/admin/cloud/remove', { site_id: 'site-1', force: true });
    assert.deepEqual(await forced.json(), { ok: true, subscription: 'forced' });
    assert.equal(siteCount(env), 0);
  });
  addSite(env, { account_id: 'someone-else', stripe_subscription_id: 'sub_77' });
  await withFetch(stripe('active'), async (calls) => {
    assert.deepEqual(await (await post(env, '/admin/cloud/remove', { site_id: 'site-1' })).json(), { ok: true, subscription: 'cancelled' });
    assert.equal(cancels(calls).length, 1);
    assert.equal(siteCount(env), 0);
  });
});

test('admin remove: for a site Kiln keeps the files of, the operator gets the same note about its repository as when its owner removes it', { skip: d1Skip }, async () => {
  const notes = [];
  const env = cloudEnv(fakeKV(), { CLOUD_ADMIN: 'ada', NOTIFY: { send: async (m) => { notes.push(m.raw); } }, NOTIFY_TO: 'ops@example.com' });
  addSite(env, { account_id: 'someone-else', repo: 'kiln-sites/oak-bakery-1a2b3c4d', origin: 'https://oak.example' });
  env.kiln_cloud.exec("UPDATE sites SET kept = 1 WHERE id = 'site-1'");
  await withFetch(async () => jsonRes({}, 404), async () => {
    assert.deepEqual(await (await post(env, '/admin/cloud/remove', { site_id: 'site-1' })).json(), { ok: true, subscription: 'none' });
  });
  assert.equal(siteCount(env), 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /kiln-sites\/oak-bakery-1a2b3c4d/);
  assert.match(notes[0], /from the admin page/);
  assert.ok(await env.KILN.get('cloudgone:kiln-sites/oak-bakery-1a2b3c4d'), 'the site is marked as gone, as after its owner\'s own Remove');
  // A site in its owner's own repository sends no such note.
  addSite(env, { account_id: 'someone-else' });
  await withFetch(async () => jsonRes({}, 404), async () => { await post(env, '/admin/cloud/remove', { site_id: 'site-1' }); });
  assert.equal(notes.length, 1);
});
