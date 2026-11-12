/**
 * What a customer meets on the way to paying, and after.
 *
 *   · The checkout sends them back to the dashboard once they have paid. Left
 *     alone, Lemon Squeezy keeps them on its own page with no way back.
 *   · The checkout offers one plan: the one the site was added with. A product
 *     with two variants otherwise lets a person pick the smaller price for the
 *     larger plan on the payment page.
 *   · The plan on record follows the plan that is paid for, and the operator
 *     is told when the two differed.
 *   · The dashboard is told when a free trial runs out, so it can say so.
 *
 * The real handlers run over a SQLite-backed D1 stand-in; Lemon Squeezy is a
 * fetch stand-in that records every call. The real billing API is never called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../worker/index.js';
import { planForVariant } from '../worker/cloud.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

const LS = 'https://api.lemonsqueezy.com/v1';
const DAY = 86400e3;
const get = (env, path, token = 'tok') => worker.fetch(new Request(`https://worker.example${path}`, { headers: { Authorization: `Bearer ${token}` } }), env);
/** Lemon Squeezy answering a checkout request with a link. */
const lemon = async (url, init) => {
  if (url === `${LS}/checkouts` && init.method === 'POST') return jsonRes({ data: { attributes: { url: 'https://kiln.lemonsqueezy.com/checkout/custom/abc' } } }, 201);
};
const sent = (calls) => calls.find(c => c.url === `${LS}/checkouts`).body.data;   // the harness has already parsed the body

async function hook(env, attributes, { event = 'subscription_updated', site = 'site-1', sub = '77' } = {}) {
  const body = JSON.stringify({
    meta: { event_name: event, ...(site ? { custom_data: { site_id: site } } : {}) },
    data: { type: 'subscriptions', id: sub, attributes: { updated_at: new Date().toISOString(), ends_at: null, ...attributes } },
  });
  const sig = createHmac('sha256', 'whsec').update(body).digest('hex');
  const res = await worker.fetch(new Request('https://worker.example/cloud/webhook/ls', { method: 'POST', headers: { 'X-Signature': sig }, body }), env);
  return res.status;
}
/** A NOTIFY binding that keeps what it is asked to send. */
const mailbox = () => { const out = []; return { out, binding: { send: async (m) => { out.push(String(m.raw || '')); } } }; };

test('checkout: the customer comes back to the dashboard after paying, and the receipt links there too', { skip: d1Skip }, async () => {
  const env = cloudEnv(fakeKV(), { CLOUD_DASHBOARD: 'https://app.example' });
  addSite(env, { status: 'trialing' });
  await withFetch(lemon, async (calls) => {
    const res = await get(env, '/cloud/checkout?site=site-1');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { url: 'https://kiln.lemonsqueezy.com/checkout/custom/abc' });
    const { attributes, relationships } = sent(calls);
    assert.equal(attributes.product_options.redirect_url, 'https://app.example/?subscribed=site-1');
    assert.equal(attributes.product_options.receipt_link_url, 'https://app.example/');
    assert.equal(attributes.product_options.receipt_button_text, 'Open your Kiln dashboard');
    // Seven free days in all: the payment company's own trial is never added on top.
    assert.deepEqual(attributes.checkout_options, { skip_trial: true });
    // What ties the payment to the site, and the store and plan, are as before.
    assert.deepEqual(attributes.checkout_data.custom, { site_id: 'site-1' });
    assert.equal(relationships.store.data.id, '1');
    assert.equal(relationships.variant.data.id, '11');
  });
});

test('checkout: only the plan the site was added with can be bought on the payment page', { skip: d1Skip }, async () => {
  for (const [plan, variant] of [['cloud', 11], ['managed', 22]]) {
    const env = cloudEnv(fakeKV(), { LS_VARIANT_MANAGED: '22' });
    addSite(env, { status: 'trialing', plan });
    await withFetch(lemon, async (calls) => {
      assert.equal((await get(env, '/cloud/checkout?site=site-1')).status, 200);
      const { attributes, relationships } = sent(calls);
      assert.deepEqual(attributes.product_options.enabled_variants, [variant], plan);
      assert.equal(relationships.variant.data.id, String(variant), plan);
    });
  }
});

test('checkout: the account\'s email is filled in when there is one, and left out when there is none or it is no address', { skip: d1Skip }, async () => {
  for (const [stored, expected] of [['ada@example.com', 'ada@example.com'], [null, undefined], ['not an address', undefined]]) {
    const env = cloudEnv(fakeKV());
    env.kiln_cloud.exec('UPDATE accounts SET email = ?', stored);
    addSite(env, { status: 'trialing' });
    await withFetch(lemon, async (calls) => {
      assert.equal((await get(env, '/cloud/checkout?site=site-1')).status, 200);
      assert.equal(sent(calls).attributes.checkout_data.email, expected, String(stored));
    });
  }
});

test('planForVariant: names the plan a variant is, and nothing for a variant this worker does not sell', () => {
  const env = { LS_VARIANT_CLOUD: '11', LS_VARIANT_MANAGED: '22' };
  assert.equal(planForVariant(env, 11), 'cloud');
  assert.equal(planForVariant(env, '22'), 'managed');
  assert.equal(planForVariant(env, 33), null);
  assert.equal(planForVariant(env, null), null);
  assert.equal(planForVariant({ LS_VARIANT_CLOUD: '11' }, undefined), null);
  assert.equal(planForVariant({}, 11), null);
});

test('webhook: the plan on record becomes the plan that is paid for, and the operator is told', { skip: d1Skip }, async () => {
  const mail = mailbox();
  const env = cloudEnv(fakeKV(), { LS_VARIANT_MANAGED: '22', NOTIFY: mail.binding, NOTIFY_TO: 'owner@example.com' });
  addSite(env, { status: 'trialing', plan: 'managed' });
  // Added on the plan with hosting, but the subscription that arrives is the Kiln Cloud one.
  assert.equal(await hook(env, { status: 'active', variant_id: 11 }, { event: 'subscription_created' }), 200);
  assert.deepEqual({ ...env.kiln_cloud.row('SELECT plan, status FROM sites WHERE id = ?', 'site-1') }, { plan: 'cloud', status: 'active' });
  assert.equal(mail.out.length, 1);
  assert.match(mail.out[0], /Plan: now cloud \(was managed\)/);
});

test('webhook: a plan that already matches, an unknown variant and a missing variant leave the plan alone and say nothing of it', { skip: d1Skip }, async () => {
  for (const variant_id of [11, 99, undefined]) {
    const mail = mailbox();
    const env = cloudEnv(fakeKV(), { LS_VARIANT_MANAGED: '22', NOTIFY: mail.binding, NOTIFY_TO: 'owner@example.com' });
    addSite(env, { status: 'trialing', plan: 'cloud' });
    assert.equal(await hook(env, { status: 'active', ...(variant_id === undefined ? {} : { variant_id }) }, { event: 'subscription_created' }), 200);
    assert.deepEqual({ ...env.kiln_cloud.row('SELECT plan, status FROM sites WHERE id = ?', 'site-1') }, { plan: 'cloud', status: 'active' }, String(variant_id));
    assert.equal(mail.out.length, 1);
    assert.doesNotMatch(mail.out[0], /Plan:/, String(variant_id));
  }
});

test('dashboard list: a free trial says when it runs out; a subscription says it exists and never shows its id', { skip: d1Skip }, async () => {
  const env = cloudEnv(fakeKV());
  const added = Date.now() - 2 * DAY;
  addSite(env, { id: 'trial', origin: 'https://one.example', status: 'trialing', created_at: added });
  addSite(env, { id: 'paid', origin: 'https://two.example', status: 'active', ls_subscription_id: '77' });
  addSite(env, { id: 'ended', origin: 'https://three.example', status: 'canceled', created_at: Date.now() - 30 * DAY });
  const res = await get(env, '/cloud/me');
  assert.equal(res.status, 200);
  const by = Object.fromEntries((await res.json()).sites.map(s => [s.id, s]));
  assert.equal(by.trial.trial_ends, added + 7 * DAY);
  assert.equal(by.trial.subscribed, false);
  assert.equal(by.trial.editable, true);
  assert.equal(by.paid.trial_ends, null);
  assert.equal(by.paid.subscribed, true);
  assert.equal(by.ended.trial_ends, null);
  assert.equal(by.ended.editable, false);
  for (const s of Object.values(by)) assert.equal('ls_subscription_id' in s, false, 'the subscription id stays on the server');
});
