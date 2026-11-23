/**
 * What a customer meets on the way to paying, and after.
 *
 *   · The payment page is opened with the account's email filled in, when Kiln
 *     has an address for the account that it may use.
 *   · The plan on record follows the plan that is paid for, and the operator
 *     is told of it only when the two differed.
 *   · The dashboard is told when a free trial runs out, so it can say so, and
 *     whether a site is subscribed, never the subscription's id.
 *
 * What the Checkout Session itself asks for (one price, the way back to the
 * dashboard, no trial of Stripe's own) is pinned in cloud-stripe.test.js.
 *
 * The real handlers run over a SQLite-backed D1 stand-in; Stripe is a fetch
 * stand-in that records every call. The real billing API is never called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../worker/index.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

const API = 'https://api.stripe.com/v1';
const DAY = 86400e3;
const get = (env, path, token = 'tok') => worker.fetch(new Request(`https://worker.example${path}`, { headers: { Authorization: `Bearer ${token}` } }), env);
/** Stripe answering a request for a Checkout Session with the page's address. */
const stripe = async (url, init) => {
  if (url === `${API}/checkout/sessions` && init.method === 'POST') return jsonRes({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
};
const sent = (calls) => Object.fromEntries(new URLSearchParams(calls.find(c => c.url === `${API}/checkout/sessions`).body));

let seq = 0;
/** One signed notice that the site's subscription is active, paid for by `price` (none when left out). */
async function hook(env, price) {
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    id: `evt_pay_${++seq}`, object: 'event', type: 'customer.subscription.created', created: now,
    data: { object: {
      id: 'sub_77', object: 'subscription', customer: 'cus_1', status: 'active', cancel_at_period_end: false, cancel_at: null, ended_at: null,
      metadata: { site_id: 'site-1' }, items: { data: [{ current_period_end: now + 30 * 86400, ...(price ? { price: { id: price } } : {}) }] },
    } },
  });
  const header = `t=${now},v1=${createHmac('sha256', 'whsec').update(`${now}.${body}`).digest('hex')}`;
  const res = await worker.fetch(new Request('https://worker.example/cloud/webhook/stripe', { method: 'POST', headers: { 'Stripe-Signature': header }, body }), env);
  return res.status;
}
/** A NOTIFY binding that keeps what it is asked to send. */
const mailbox = () => { const out = []; return { out, binding: { send: async (m) => { out.push(String(m.raw || '')); } } }; };

test('checkout: the account\'s email is filled in when there is one, and left out when there is none or it is no address', { skip: d1Skip }, async () => {
  for (const [stored, expected] of [['ada@example.com', 'ada@example.com'], [null, undefined], ['not an address', undefined]]) {
    const env = cloudEnv(fakeKV());
    env.kiln_cloud.exec('UPDATE accounts SET email = ?', stored);
    addSite(env, { status: 'trialing' });
    await withFetch(stripe, async (calls) => {
      const res = await get(env, '/cloud/checkout?site=site-1');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { url: 'https://checkout.stripe.com/c/pay/cs_1' });
      assert.equal(sent(calls).customer_email, expected, String(stored));
      assert.equal(sent(calls)['line_items[0][price]'], 'price_cloud');
    });
  }
});

test('webhook: a plan that already matches, a price this service does not sell and a missing price leave the plan alone and say nothing of it', { skip: d1Skip }, async () => {
  for (const price of ['price_cloud', 'price_unknown', undefined]) {
    const mail = mailbox();
    const env = cloudEnv(fakeKV(), { STRIPE_PRICE_MANAGED: 'price_managed', NOTIFY: mail.binding, NOTIFY_TO: 'owner@example.com' });
    addSite(env, { status: 'trialing', plan: 'cloud' });
    assert.equal(await hook(env, price), 200);
    assert.deepEqual({ ...env.kiln_cloud.row('SELECT plan, status FROM sites WHERE id = ?', 'site-1') }, { plan: 'cloud', status: 'active' }, String(price));
    assert.equal(mail.out.length, 1);
    assert.doesNotMatch(mail.out[0], /Plan:/, String(price));
  }
  // The other way round, for contrast: paid for with the hosting plan's price, the plan changes and the note says so.
  const mail = mailbox();
  const env = cloudEnv(fakeKV(), { STRIPE_PRICE_MANAGED: 'price_managed', NOTIFY: mail.binding, NOTIFY_TO: 'owner@example.com' });
  addSite(env, { status: 'trialing', plan: 'cloud' });
  assert.equal(await hook(env, 'price_managed'), 200);
  assert.equal(env.kiln_cloud.row('SELECT plan FROM sites WHERE id = ?', 'site-1').plan, 'managed');
  assert.match(mail.out[0], /Plan: now managed \(was cloud\)/);
});

test('dashboard list: a free trial says when it runs out; a subscription says it exists and never shows its id', { skip: d1Skip }, async () => {
  const env = cloudEnv(fakeKV());
  const added = Date.now() - 2 * DAY;
  addSite(env, { id: 'trial', origin: 'https://one.example', status: 'trialing', created_at: added });
  addSite(env, { id: 'paid', origin: 'https://two.example', status: 'active', stripe_subscription_id: 'sub_77' });
  addSite(env, { id: 'ended', origin: 'https://three.example', status: 'canceled', created_at: Date.now() - 30 * DAY });
  const res = await get(env, '/cloud/me');
  assert.equal(res.status, 200);
  const text = await res.text();
  const by = Object.fromEntries(JSON.parse(text).sites.map(s => [s.id, s]));
  assert.equal(by.trial.trial_ends, added + 7 * DAY);
  assert.equal(by.trial.subscribed, false);
  assert.equal(by.trial.editable, true);
  assert.equal(by.paid.trial_ends, null);
  assert.equal(by.paid.subscribed, true);
  assert.equal(by.ended.trial_ends, null);
  assert.equal(by.ended.editable, false);
  for (const s of Object.values(by)) assert.equal('stripe_subscription_id' in s || 'subscription_id' in s, false, 'the subscription id stays on the server');
  assert.equal(text.includes('sub_77'), false);
});
