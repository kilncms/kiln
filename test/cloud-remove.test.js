/**
 * S5 — removing a site from Kiln Cloud cannot leave its owner paying.
 * The real handlers run over a SQLite-backed D1 stand-in; Lemon Squeezy is a
 * fetch stand-in that records every call. The real billing API is never called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

const LS = 'https://api.lemonsqueezy.com/v1';
const post = (env, path, body, token = 'tok') => worker.fetch(new Request(`https://worker.example${path}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), env);
const sub = (status, extra = {}) => jsonRes({ data: { type: 'subscriptions', id: '77', attributes: { status, cancelled: status === 'cancelled', ends_at: status === 'cancelled' ? '2026-11-01T00:00:00.000000Z' : null, ...extra } } });
/** Lemon Squeezy with one subscription in `status`; DELETE answers with `onCancel()`. */
const lemon = (status, onCancel = () => sub('cancelled')) => async (url, init) => {
  if (url !== `${LS}/subscriptions/77`) return;
  return init.method === 'DELETE' ? onCancel() : sub(status);
};
const siteCount = (env) => env.kiln_cloud.row('SELECT COUNT(*) n FROM sites').n;
const cancels = (calls) => calls.filter(c => c.method === 'DELETE');

test('S5 remove: a site with a live subscription is cancelled at Lemon Squeezy first, then removed', { skip: d1Skip }, async () => {
  for (const status of ['active', 'on_trial', 'past_due', 'unpaid', 'paused']) {
    const env = cloudEnv(fakeKV());
    addSite(env, { ls_subscription_id: '77' });
    await withFetch(lemon(status), async (calls) => {
      const res = await post(env, '/cloud/sites/remove', { id: 'site-1' });
      assert.equal(res.status, 200, status);
      assert.deepEqual(await res.json(), { ok: true, subscription: 'cancelled', ends_at: '2026-11-01T00:00:00.000000Z' });
      assert.equal(cancels(calls).length, 1, `one cancellation for ${status}`);
      assert.equal(cancels(calls)[0].url, `${LS}/subscriptions/77`);
      assert.equal(cancels(calls)[0].headers.Authorization, 'Bearer ls_test_key');
      assert.equal(siteCount(env), 0);
    });
  }
});

test('S5 remove: when the cancellation cannot be confirmed the site stays, with Manage billing, and the answer says what to do', { skip: d1Skip }, async () => {
  const cases = {
    'Lemon Squeezy refuses the cancellation': [lemon('active', () => jsonRes({ errors: [{ detail: 'no' }] }, 422)), 'cancel_refused'],
    'Lemon Squeezy answers 200 but the subscription is still active': [lemon('active', () => sub('active')), 'cancel_refused'],
    'Lemon Squeezy is down': [async () => jsonRes({}, 503), 'billing_unreachable'],
    'the network fails': [async () => { throw new Error('connect failed'); }, 'billing_unreachable'],
    'this key cannot see the subscription (other mode)': [async () => jsonRes({ errors: [] }, 404), 'subscription_not_found'],
  };
  for (const [name, [handler, reason]] of Object.entries(cases)) {
    const env = cloudEnv(fakeKV());
    addSite(env, { ls_subscription_id: '77' });
    await withFetch(handler, async () => {
      const res = await post(env, '/cloud/sites/remove', { id: 'site-1' });
      assert.equal(res.status, 502, name);
      const body = await res.json();
      assert.equal(body.code, 'subscription_not_cancelled', name);
      assert.equal(body.reason, reason, name);
      assert.match(body.error, /was not removed/);
      assert.match(body.error, /Manage billing/);
      assert.equal(siteCount(env), 1, `${name}: the site is still there`);
      assert.equal(env.kiln_cloud.row('SELECT ls_subscription_id s FROM sites').s, '77');
    });
  }
  // Billing keys missing on this worker: nothing can be cancelled from here.
  const env = cloudEnv(fakeKV(), { LS_API_KEY: '' });
  addSite(env, { ls_subscription_id: '77' });
  await withFetch(lemon('active'), async (calls) => {
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
  await withFetch(lemon('active'), async (calls) => {
    const res = await post(trial, '/cloud/sites/remove', { id: 'site-1' });
    assert.deepEqual(await res.json(), { ok: true, subscription: 'none' });
    assert.equal(calls.length, 0, 'Lemon Squeezy is not asked at all');
    assert.equal(siteCount(trial), 0);
  });
  for (const status of ['cancelled', 'expired']) {
    const env = cloudEnv(fakeKV());
    addSite(env, { status: 'canceled', ls_subscription_id: '77' });
    await withFetch(lemon(status), async (calls) => {
      const res = await post(env, '/cloud/sites/remove', { id: 'site-1' });
      assert.equal((await res.json()).subscription, 'already_cancelled');
      assert.equal(cancels(calls).length, 0);
      assert.equal(siteCount(env), 0);
    });
  }
});

test('S5 remove: only the signed-in account\'s own site; another account\'s subscription is never touched', { skip: d1Skip }, async () => {
  const env = cloudEnv(fakeKV());
  addSite(env, { account_id: 'someone-else', ls_subscription_id: '77' });
  await withFetch(lemon('active'), async (calls) => {
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
  addSite(env, { account_id: 'someone-else', ls_subscription_id: '77' });
  await withFetch(async () => jsonRes({}, 404), async () => {
    const res = await post(env, '/admin/cloud/remove', { site_id: 'site-1' });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /cancel it in Lemon Squeezy, then remove with force/);
    assert.equal(siteCount(env), 1);
    const forced = await post(env, '/admin/cloud/remove', { site_id: 'site-1', force: true });
    assert.deepEqual(await forced.json(), { ok: true, subscription: 'forced' });
    assert.equal(siteCount(env), 0);
  });
  addSite(env, { account_id: 'someone-else', ls_subscription_id: '77' });
  await withFetch(lemon('active'), async (calls) => {
    assert.deepEqual(await (await post(env, '/admin/cloud/remove', { site_id: 'site-1' })).json(), { ok: true, subscription: 'cancelled' });
    assert.equal(cancels(calls).length, 1);
    assert.equal(siteCount(env), 0);
  });
});
