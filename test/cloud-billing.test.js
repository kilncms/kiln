/**
 * S6 / KLR-14 — what each state of a Stripe subscription does to a site's
 * editing access. The promise on the website: cancelling keeps access to the
 * end of the paid period. Signed notices are sent to the real webhook over a
 * SQLite-backed D1 stand-in; "can this site edit?" is asked the way a browser
 * does, with a CORS preflight from the site's origin.
 *
 *   active, trialing    editing on
 *   set to end          editing on until the day it ends, then off
 *   ended               editing off
 *   past_due, unpaid,   editing on for 7 days from the first such event, then
 *   paused              off; a later one of the three does not restart the days
 *
 * Stripe counts time in whole seconds, so every time here is a whole second.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../worker/index.js';
import { siteHasAccess, cloudSiteForOrigin, hostingEndsAt, PAST_DUE_GRACE_DAYS } from '../worker/cloud.js';
import { fakeKV } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

const ORIGIN = 'https://club.example';
const DAY = 86400e3, HOUR = 3600e3;
const sec = (ms) => Math.floor(ms / 1000);
const NOW = sec(Date.now()) * 1000;   // this run's "now", on a whole second
const SUB = 'sub_77';

let seq = 0;
/**
 * Send one signed notice about a subscription. `at` is the time Stripe gives
 * the event (milliseconds here, sent as seconds). `site: null` leaves the
 * site's id off the subscription, as on one made by hand in Stripe. Anything
 * else is put on the subscription itself.
 */
async function hook(env, status, { at = NOW, type = 'customer.subscription.updated', site = 'site-1', sub = SUB, secret = 'whsec', id = `evt_s6_${++seq}`, ...more } = {}) {
  const body = JSON.stringify({
    id, object: 'event', type, created: sec(at),
    data: { object: {
      id: sub, object: 'subscription', customer: 'cus_1', status, cancel_at_period_end: false, cancel_at: null, ended_at: null,
      metadata: site ? { site_id: site } : {}, items: { data: [{ current_period_end: sec(at + 30 * DAY), price: { id: 'price_cloud' } }] }, ...more,
    } },
  });
  const t = sec(Date.now());
  const header = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  const res = await worker.fetch(new Request('https://worker.example/cloud/webhook/stripe', { method: 'POST', headers: { 'Stripe-Signature': header }, body }), env);
  return { status: res.status, json: await res.json() };
}
/** The customer set the subscription to end on `until`: Stripe keeps it active, with the day on it. */
const setToEnd = (env, until, more = {}) => hook(env, 'active', { cancel_at_period_end: true, cancel_at: until === null ? null : sec(until), ...more });
/** The subscription is over. `ended_at` is the moment Stripe says it ended; the event's own time where it is left out. */
const ended = (env, { at = NOW, ...more } = {}) => hook(env, 'canceled', { at, type: 'customer.subscription.deleted', ended_at: sec(at), ...more });
/** Would the worker let this site's editor talk to it right now? */
async function canEdit(env, origin = ORIGIN) {
  const res = await worker.fetch(new Request('https://worker.example/auth/refresh', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } }), env);
  return res.headers.get('Access-Control-Allow-Origin') === origin;
}
const row = (env) => env.kiln_cloud.row('SELECT status, access_until, stripe_subscription_id FROM sites WHERE id = ?', 'site-1');
const fresh = (site = { status: 'trialing' }) => { const env = cloudEnv(fakeKV()); addSite(env, site); return env; };
const paidFor = () => fresh({ status: 'active', stripe_subscription_id: SUB });
const me = (env) => worker.fetch(new Request('https://worker.example/cloud/me', { headers: { Authorization: 'Bearer tok' } }), env);

test('S6 active and trialing: editing is on, and any earlier end date is cleared', { skip: d1Skip }, async () => {
  for (const status of ['active', 'trialing']) {
    const env = fresh({ status: 'canceled' });
    env.kiln_cloud.exec('UPDATE sites SET access_until = ?', Date.now() - DAY);
    assert.equal(await canEdit(env), false);
    assert.equal((await hook(env, status, { type: 'customer.subscription.created' })).status, 200);
    assert.deepEqual({ ...row(env) }, { status, access_until: null, stripe_subscription_id: SUB });
    assert.equal(await canEdit(env), true, status);
  }
});

test('S6 set to end: editing stays on until the paid period ends, then stops by itself', { skip: d1Skip }, async () => {
  const env = paidFor();
  const paidUntil = NOW + 20 * DAY;
  await setToEnd(env, paidUntil);
  assert.equal(row(env).status, 'canceled');
  assert.equal(row(env).access_until, paidUntil);
  assert.equal(await canEdit(env), true, 'cancelled on day 10 of 30: still editing');
  // The same row, looked at just before and just after the period ends.
  assert.ok(await cloudSiteForOrigin(env, ORIGIN, paidUntil - 1000));
  assert.equal(await cloudSiteForOrigin(env, ORIGIN, paidUntil + 1000), null);
  assert.equal(siteHasAccess(row(env), paidUntil - 1000), true);
  assert.equal(siteHasAccess(row(env), paidUntil + 1000), false);
  // With no day of its own on it, a subscription set to end with its period ends when the period does.
  const period = paidFor();
  await hook(period, 'active', { cancel_at_period_end: true });
  assert.equal(row(period).access_until, NOW + 30 * DAY);
});

test('S6 set to end with a period that is already over, or with no end date at all, has no access', { skip: d1Skip }, async () => {
  const past = paidFor();
  await setToEnd(past, NOW - DAY);
  assert.equal(await canEdit(past), false);
  const none = paidFor();
  await setToEnd(none, null, { items: { data: [{ price: { id: 'price_cloud' } }] } });
  assert.deepEqual({ ...row(none) }, { status: 'canceled', access_until: null, stripe_subscription_id: SUB });
  assert.equal(await canEdit(none), false);
});

test('S6 set to end then resumed: back to active, nothing left to run out', { skip: d1Skip }, async () => {
  const env = paidFor();
  await setToEnd(env, NOW + 5 * DAY, { at: NOW - 2000 });
  await hook(env, 'active', { at: NOW - 1000 });
  assert.deepEqual({ ...row(env) }, { status: 'active', access_until: null, stripe_subscription_id: SUB });
  assert.equal(await cloudSiteForOrigin(env, ORIGIN, NOW + 60 * DAY) !== null, true);
});

test('S6 ended: the only state that ends access outright, even inside a period that was paid', { skip: d1Skip }, async () => {
  const env = paidFor();
  await setToEnd(env, NOW + 20 * DAY, { at: NOW - 2000 });
  assert.equal(await canEdit(env), true);
  await ended(env, { at: NOW - 1000 });
  // The day on the row is the moment it ended, not the end of the period that was paid.
  assert.deepEqual({ ...row(env) }, { status: 'canceled', access_until: NOW - 1000, stripe_subscription_id: SUB });
  assert.equal(await canEdit(env), false);
});

test('S6 ended: the day editing stopped stays on the row, so a hosted site has a day to count its thirty days from', { skip: d1Skip }, async () => {
  const paid = (env) => ({ ...row(env), created_at: NOW - 300 * DAY });
  // Set to end, the paid time ran out two days ago, and only now is the subscription over: the day is kept as it was.
  let env = paidFor();
  const paidUntil = NOW - 2 * DAY;
  await setToEnd(env, paidUntil, { at: NOW - 10 * DAY });
  await ended(env);
  assert.deepEqual({ ...row(env) }, { status: 'canceled', access_until: paidUntil, stripe_subscription_id: SUB });
  assert.equal(await canEdit(env), false);
  assert.equal(hostingEndsAt(paid(env), NOW), paidUntil + 30 * DAY);
  // A failed payment whose grace ran out long ago, then given up on: the day the grace ran out is kept.
  env = paidFor();
  await hook(env, 'past_due', { at: NOW - 20 * DAY });
  const graceEnd = row(env).access_until;
  assert.equal(graceEnd, NOW - 20 * DAY + 7 * DAY);
  await ended(env);
  assert.deepEqual({ ...row(env) }, { status: 'canceled', access_until: graceEnd, stripe_subscription_id: SUB });
  // Given up on while the grace still ran: editing stops then, and that moment is the day.
  env = paidFor();
  await hook(env, 'past_due', { at: NOW - 2 * DAY });
  assert.equal(await canEdit(env), true);
  await ended(env, { at: NOW - DAY });
  assert.equal(row(env).access_until, NOW - DAY);
  assert.equal(await canEdit(env), false);
  // No day on the row and none in the event but its own time: that time.
  env = paidFor();
  await ended(env, { at: NOW - 3 * DAY, ended_at: null });
  assert.equal(row(env).access_until, NOW - 3 * DAY);
  assert.equal(hostingEndsAt(paid(env), NOW), row(env).access_until + 30 * DAY);
  // Subscribed again, which in Stripe is a new subscription: the day is cleared, and the site is paid by the new one.
  await hook(env, 'active', { at: NOW - DAY, sub: 'sub_78', type: 'customer.subscription.created' });
  assert.deepEqual({ ...row(env) }, { status: 'active', access_until: null, stripe_subscription_id: 'sub_78' });
});

test(`S6 past_due, unpaid and paused: ${PAST_DUE_GRACE_DAYS} days of grace from the event, then off`, { skip: d1Skip }, async () => {
  assert.equal(PAST_DUE_GRACE_DAYS, 7);
  for (const status of ['past_due', 'unpaid', 'paused']) {
    const env = paidFor();
    const failedAt = NOW - 2 * DAY;   // the notice arrives late: the grace runs from the event
    await hook(env, status, { at: failedAt });
    assert.equal(row(env).status, 'past_due', status);
    assert.equal(row(env).access_until, failedAt + 7 * DAY, status);
    assert.equal(await canEdit(env), true, `${status}: day 2 of 7`);
    assert.ok(await cloudSiteForOrigin(env, ORIGIN, failedAt + 7 * DAY - 1000));
    assert.equal(await cloudSiteForOrigin(env, ORIGIN, failedAt + 7 * DAY + 1000), null, `${status}: day 7 has passed`);
  }
});

test('S6 grace is given once: a second failed charge, or unpaid after past_due, does not restart the seven days', { skip: d1Skip }, async () => {
  const env = paidFor();
  const t = NOW - 6 * DAY;
  await hook(env, 'past_due', { at: t });
  const first = row(env).access_until;
  await hook(env, 'past_due', { at: t + 3 * DAY });
  await hook(env, 'unpaid', { at: t + 5 * DAY });
  await hook(env, 'paused', { at: t + 132 * HOUR });
  assert.equal(row(env).access_until, first);
  // Paid again, then a new failure later: that is a new grace.
  await hook(env, 'active', { at: t + 139 * HOUR });
  assert.equal(row(env).access_until, null);
  await hook(env, 'past_due', { at: t + 142 * HOUR });
  assert.equal(row(env).access_until, t + 142 * HOUR + 7 * DAY);
});

test('S6 a change to a subscription that does not name its site is matched by the subscription\'s id', { skip: d1Skip }, async () => {
  const env = paidFor();
  const until = NOW + 3 * DAY;
  await setToEnd(env, until, { site: null });
  assert.equal(row(env).access_until, until);
  const other = await setToEnd(env, NOW + DAY, { site: null, sub: 'sub_999', at: NOW + 5000 });   // someone else's subscription
  assert.equal(other.json.ignored, 'unknown site');
  assert.equal(row(env).access_until, until);
});

test('S6 webhook hygiene: a bad signature, events that are not about a subscription, unknown states and replays change nothing', { skip: d1Skip }, async () => {
  const env = paidFor();
  assert.equal((await ended(env, { secret: 'wrong' })).status, 400);
  assert.equal((await hook(env, 'active', { type: 'invoice.paid' })).json.ignored, 'invoice.paid');
  assert.equal((await hook(env, 'canceled', { type: 'charge.refunded' })).json.ignored, 'charge.refunded');
  assert.equal((await hook(env, 'refunded')).json.ignored, 'status refunded');
  assert.equal((await hook(env, 'constructor')).json.ignored, 'status constructor');
  assert.deepEqual({ ...row(env) }, { status: 'active', access_until: null, stripe_subscription_id: SUB });
  const cancellation = { at: NOW - 2000, id: 'evt_s6_captured' };
  await setToEnd(env, NOW + DAY, cancellation);
  await hook(env, 'active', { at: NOW - 1000 });
  assert.equal((await setToEnd(env, NOW + DAY, cancellation)).json.replayed, true, 'the captured cancellation is not applied again');
  assert.equal(row(env).status, 'active');
});

test('S6 the rest of the product agrees: the dashboard list, a trial that ran out, and the operator\'s grant', { skip: d1Skip }, async () => {
  const env = paidFor();
  const until = NOW + 9 * DAY;
  await setToEnd(env, until);
  const seen = await (await me(env)).json();
  assert.equal(seen.sites[0].status, 'canceled');
  assert.equal(seen.sites[0].access_until, until);
  assert.equal(seen.sites[0].editable, true);
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
  // The same job leaves a trialing site that has a subscription alone: only Stripe's notices change it.
  const subscribed = fresh({ status: 'trialing', created_at: Date.now() - 8 * DAY, stripe_subscription_id: SUB });
  await worker.scheduled({}, subscribed);
  assert.equal(row(subscribed).status, 'trialing');
  assert.equal(await canEdit(subscribed), true);
});

test('S6 a worker deployed before the migrations keeps sites working: on a database with only the first one, a site is edited and the dashboard answers', { skip: d1Skip }, async () => {
  const env = cloudEnv(fakeKV(), { d1: { upTo: 1 } });   // the database has only 0001: no access_until column, and no Stripe columns
  addSite(env, { status: 'active' });
  assert.equal(await canEdit(env), true);
  let seen = await me(env);
  assert.equal(seen.status, 200);
  assert.deepEqual((({ editable, subscribed }) => ({ editable, subscribed }))((await seen.json()).sites[0]), { editable: true, subscribed: false });
  env.kiln_cloud.exec("UPDATE sites SET status = 'canceled'");
  assert.equal(await canEdit(env), false, 'the old behaviour, not an error');
  seen = await me(env);
  assert.equal(seen.status, 200);
  assert.equal((await seen.json()).sites[0].editable, false);
});
