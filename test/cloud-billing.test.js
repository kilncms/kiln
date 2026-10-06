/**
 * S6 / KLR-14 — what each Lemon Squeezy subscription state does to a site's
 * editing access. The promise on the website: cancelling keeps access to the
 * end of the paid period. Signed webhooks are sent to the real handler over a
 * SQLite-backed D1 stand-in; "can this site edit?" is asked the way a browser
 * does, with a CORS preflight from the site's origin.
 *
 *   active, on_trial   editing on
 *   cancelled          editing on until ends_at, then off
 *   expired            editing off
 *   past_due, unpaid,  editing on for 7 days from the first such event, then
 *   paused             off; a later one of the three does not restart the days
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../worker/index.js';
import { siteHasAccess, cloudSiteForOrigin, PAST_DUE_GRACE_DAYS } from '../worker/cloud.js';
import { fakeKV } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

const ORIGIN = 'https://club.example';
const DAY = 86400e3;
const iso = (ms) => new Date(ms).toISOString();

/** Send one signed subscription webhook. `at` is the event's updated_at. */
async function hook(env, status, { at = Date.now(), ends_at = null, event = 'subscription_updated', site = 'site-1', sub = '77', secret = 'whsec', type = 'subscriptions' } = {}) {
  const body = JSON.stringify({
    meta: { event_name: event, ...(site ? { custom_data: { site_id: site } } : {}) },
    data: { type, id: sub, attributes: { status, updated_at: iso(at), ends_at: ends_at === null ? null : iso(ends_at) } },
  });
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  const res = await worker.fetch(new Request('https://worker.example/cloud/webhook/ls', { method: 'POST', headers: { 'X-Signature': sig }, body }), env);
  return { status: res.status, json: await res.json() };
}
/** Would the worker let this site's editor talk to it right now? */
async function canEdit(env, origin = ORIGIN) {
  const res = await worker.fetch(new Request('https://worker.example/auth/refresh', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } }), env);
  return res.headers.get('Access-Control-Allow-Origin') === origin;
}
const row = (env) => env.kiln_cloud.row('SELECT status, access_until, ls_subscription_id FROM sites WHERE id = ?', 'site-1');
const fresh = (site = { status: 'trialing' }) => { const env = cloudEnv(fakeKV()); addSite(env, site); return env; };

test('S6 active and on_trial: editing is on, and any earlier end date is cleared', { skip: d1Skip }, async () => {
  for (const [ls, status] of [['active', 'active'], ['on_trial', 'trialing']]) {
    const env = fresh({ status: 'canceled' });
    env.kiln_cloud.exec('UPDATE sites SET access_until = ?', Date.now() - DAY);
    assert.equal(await canEdit(env), false);
    assert.equal((await hook(env, ls, { event: 'subscription_created' })).status, 200);
    assert.deepEqual({ ...row(env) }, { status, access_until: null, ls_subscription_id: '77' });
    assert.equal(await canEdit(env), true, ls);
  }
});

test('S6 cancelled: editing stays on until the paid period ends, then stops by itself', { skip: d1Skip }, async () => {
  const env = fresh({ status: 'active', ls_subscription_id: '77' });
  const paidUntil = Date.now() + 20 * DAY;
  await hook(env, 'cancelled', { ends_at: paidUntil, event: 'subscription_cancelled' });
  assert.equal(row(env).status, 'canceled');
  assert.equal(row(env).access_until, paidUntil);
  assert.equal(await canEdit(env), true, 'cancelled on day 10 of 30: still editing');
  // The same row, looked at just before and just after the period ends.
  assert.ok(await cloudSiteForOrigin(env, ORIGIN, paidUntil - 1000));
  assert.equal(await cloudSiteForOrigin(env, ORIGIN, paidUntil + 1000), null);
  assert.equal(siteHasAccess(row(env), paidUntil - 1000), true);
  assert.equal(siteHasAccess(row(env), paidUntil + 1000), false);
});

test('S6 cancelled with a period that is already over, or with no end date at all, has no access', { skip: d1Skip }, async () => {
  const past = fresh({ status: 'active', ls_subscription_id: '77' });
  await hook(past, 'cancelled', { ends_at: Date.now() - DAY });
  assert.equal(await canEdit(past), false);
  const none = fresh({ status: 'active', ls_subscription_id: '77' });
  await hook(none, 'cancelled', { ends_at: null });
  assert.equal(row(none).access_until, null);
  assert.equal(await canEdit(none), false);
});

test('S6 cancelled then resumed: back to active, nothing left to run out', { skip: d1Skip }, async () => {
  const env = fresh({ status: 'active', ls_subscription_id: '77' });
  const t = Date.now();
  await hook(env, 'cancelled', { at: t, ends_at: t + 5 * DAY });
  await hook(env, 'active', { at: t + 1000, event: 'subscription_resumed' });
  assert.deepEqual({ ...row(env) }, { status: 'active', access_until: null, ls_subscription_id: '77' });
  assert.equal(await cloudSiteForOrigin(env, ORIGIN, t + 60 * DAY) !== null, true);
});

test('S6 expired: the only state that ends access outright, even inside a period that was paid', { skip: d1Skip }, async () => {
  const env = fresh({ status: 'active', ls_subscription_id: '77' });
  const t = Date.now();
  await hook(env, 'cancelled', { at: t, ends_at: t + 20 * DAY });
  assert.equal(await canEdit(env), true);
  await hook(env, 'expired', { at: t + 1000, ends_at: t + 20 * DAY, event: 'subscription_expired' });
  assert.deepEqual({ ...row(env) }, { status: 'canceled', access_until: null, ls_subscription_id: '77' });
  assert.equal(await canEdit(env), false);
});

test(`S6 past_due, unpaid and paused: ${PAST_DUE_GRACE_DAYS} days of grace from the event, then off`, { skip: d1Skip }, async () => {
  assert.equal(PAST_DUE_GRACE_DAYS, 7);
  for (const ls of ['past_due', 'unpaid', 'paused']) {
    const env = fresh({ status: 'active', ls_subscription_id: '77' });
    const failedAt = Date.now() - 2 * DAY;   // the webhook arrives late: the grace runs from the event
    await hook(env, ls, { at: failedAt });
    assert.equal(row(env).status, 'past_due', ls);
    assert.equal(row(env).access_until, new Date(iso(failedAt)).getTime() + 7 * DAY, ls);
    assert.equal(await canEdit(env), true, `${ls}: day 2 of 7`);
    assert.ok(await cloudSiteForOrigin(env, ORIGIN, failedAt + 7 * DAY - 1000));
    assert.equal(await cloudSiteForOrigin(env, ORIGIN, failedAt + 7 * DAY + 1000), null, `${ls}: day 7 has passed`);
  }
});

test('S6 grace is given once: a second failed charge, or unpaid after past_due, does not restart the seven days', { skip: d1Skip }, async () => {
  const env = fresh({ status: 'active', ls_subscription_id: '77' });
  const t = Date.now() - 6 * DAY;
  await hook(env, 'past_due', { at: t });
  const first = row(env).access_until;
  await hook(env, 'past_due', { at: t + 3 * DAY });
  await hook(env, 'unpaid', { at: t + 5 * DAY });
  await hook(env, 'paused', { at: t + 5.5 * DAY });
  assert.equal(row(env).access_until, first);
  // Paid again, then a new failure months later: that is a new grace.
  await hook(env, 'active', { at: t + 5.8 * DAY });
  assert.equal(row(env).access_until, null);
  await hook(env, 'past_due', { at: t + 5.9 * DAY });
  assert.equal(row(env).access_until, new Date(iso(t + 5.9 * DAY)).getTime() + 7 * DAY);
});

test('S6 a renewal of a subscription the site row does not name is matched by subscription id', { skip: d1Skip }, async () => {
  const env = fresh({ status: 'active', ls_subscription_id: '77' });
  const until = Date.now() + 3 * DAY;
  await hook(env, 'cancelled', { site: null, ends_at: until });
  assert.equal(row(env).access_until, until);
  await hook(env, 'cancelled', { site: null, sub: '999', at: Date.now() + 5, ends_at: 1 });   // someone else's subscription
  assert.equal(row(env).access_until, until);
});

test('S6 webhook hygiene is unchanged: bad signature, payment events, unknown states and replays change nothing', { skip: d1Skip }, async () => {
  const env = fresh({ status: 'active', ls_subscription_id: '77' });
  const t = Date.now();
  assert.equal((await hook(env, 'expired', { secret: 'wrong' })).status, 401);
  assert.match((await hook(env, 'paid', { event: 'subscription_payment_success', type: 'subscription-invoices' })).json.ignored, /subscription_payment_success/);
  assert.match((await hook(env, 'paid', { event: 'order_created', type: 'orders' })).json.ignored, /order_created/);
  assert.match((await hook(env, 'refunded')).json.ignored, /unknown status/);
  assert.match((await hook(env, 'constructor')).json.ignored, /unknown status/);
  assert.deepEqual({ ...row(env) }, { status: 'active', access_until: null, ls_subscription_id: '77' });
  await hook(env, 'cancelled', { at: t, ends_at: t + DAY });
  await hook(env, 'active', { at: t + 1000 });
  assert.equal((await hook(env, 'cancelled', { at: t, ends_at: t + DAY })).json.replayed, true, 'the captured cancellation is not applied again');
  assert.equal(row(env).status, 'active');
});

test('S6 the rest of the product agrees: the dashboard list, a trial that ran out, and the operator\'s grant', { skip: d1Skip }, async () => {
  const env = fresh({ status: 'active', ls_subscription_id: '77' });
  const until = Date.now() + 9 * DAY;
  await hook(env, 'cancelled', { ends_at: until });
  const me = await (await worker.fetch(new Request('https://worker.example/cloud/me', { headers: { Authorization: 'Bearer tok' } }), env)).json();
  assert.equal(me.sites[0].status, 'canceled');
  assert.equal(me.sites[0].access_until, until);
  assert.equal(me.sites[0].editable, true);
  // The operator sets a status by hand: it means exactly that, with no date left behind.
  const admin = { ...env, CLOUD_ADMIN: 'ada' };
  const grant = (status) => worker.fetch(new Request('https://worker.example/admin/cloud/grant', { method: 'POST', headers: { Authorization: 'Bearer tok' }, body: JSON.stringify({ site_id: 'site-1', status }) }), admin);
  await grant('canceled');
  assert.equal(row(env).access_until, null);
  assert.equal(await canEdit(env), false);
  await grant('active');
  assert.equal(await canEdit(env), true);
  // A free trial that never subscribed still ends at seven days, with no allowance.
  const trial = fresh({ status: 'trialing', created_at: Date.now() - 8 * DAY });
  assert.equal(await canEdit(trial), true);
  await worker.scheduled({}, trial);
  assert.equal(row(trial).status, 'canceled');
  assert.equal(await canEdit(trial), false);
});

test('S6 a worker deployed before the migration keeps paying sites working (and the webhook still lands)', { skip: d1Skip }, async () => {
  const env = cloudEnv(fakeKV(), { d1: { upTo: 1 } });   // the database has only 0001: no access_until column
  addSite(env, { status: 'active', ls_subscription_id: '77' });
  assert.equal(await canEdit(env), true);
  assert.equal((await hook(env, 'cancelled', { ends_at: Date.now() + DAY })).status, 200);
  assert.equal(env.kiln_cloud.row('SELECT status FROM sites').status, 'canceled', 'the old behaviour, not an error');
  assert.equal(await canEdit(env), false);
  const me = await worker.fetch(new Request('https://worker.example/cloud/me', { headers: { Authorization: 'Bearer tok' } }), env);
  assert.equal(me.status, 200);
  assert.equal((await me.json()).sites[0].editable, false);
});
