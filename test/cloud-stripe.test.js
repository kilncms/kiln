/**
 * Kiln Cloud's billing through Stripe Managed Payments (worker/billing.js and
 * the Stripe routes in worker/cloud.js).
 *
 *   · Stripe sells once STRIPE_SECRET_KEY is set; without it nobody can pay,
 *     whatever settings of an older billing company are still there.
 *   · Subscribe opens a Checkout Session for the site's one price, with
 *     Managed Payments on, no Stripe trial, and the site's id on it.
 *   · Only a notice signed with the endpoint's secret, and fresh, changes a
 *     site; the same notice twice changes it once.
 *   · Each subscription status comes to a status for the site and to how
 *     long it can still be edited, and the plan on record follows the price
 *     paid for.
 *   · Manage billing opens Stripe's Billing Portal; Remove cancels the
 *     subscription first.
 *
 * The real handlers run over a SQLite-backed D1 stand-in; Stripe is a fetch
 * stand-in that records every call. Stripe itself is never called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../worker/index.js';
import { billingProvider, billingOn, verifyStripeSignature, formBody, planForPrice, periodForPrice, subscriptionOf, subscriptionProvider, subscriptionSql } from '../worker/billing.js';
import { stripeStateFor, PAST_DUE_GRACE_DAYS } from '../worker/cloud.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip, schemaFiles } from './d1-fake.js';

const API = 'https://api.stripe.com/v1';
const DAY = 86400e3;
const SECRET = 'whsec_stripe_endpoint';
const PRICES = { STRIPE_PRICE_CLOUD: 'price_cloud_m', STRIPE_PRICE_CLOUD_YEARLY: 'price_cloud_y', STRIPE_PRICE_MANAGED: 'price_managed_m', STRIPE_PRICE_MANAGED_YEARLY: 'price_managed_y' };
/** A Cloud env where Stripe sells both plans, by the month and by the year. */
const stripeEnv = (extra = {}) => cloudEnv(fakeKV(), { STRIPE_SECRET_KEY: 'sk_test_kiln', STRIPE_WEBHOOK_SECRET: SECRET, CLOUD_DASHBOARD: 'https://app.example', ...PRICES, ...extra });

const ask = (env, path, { method = 'GET', body } = {}) => worker.fetch(new Request(`https://worker.example${path}`, {
  method, headers: { Authorization: 'Bearer tok', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
}), env);
const form = (call) => Object.fromEntries(new URLSearchParams(call.body));
const toStripe = (calls) => calls.filter(c => c.url.startsWith(API));

/** Stripe answering the calls this service makes. `over` replaces an answer by "METHOD path". */
const stripe = (over = {}) => async (url, init) => {
  if (!url.startsWith(API)) return undefined;
  const key = `${init.method} ${url.slice(API.length)}`;
  if (key in over) return over[key]();
  if (key === 'POST /checkout/sessions') return jsonRes({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
  if (key === 'POST /billing_portal/sessions') return jsonRes({ id: 'bps_1', url: 'https://billing.stripe.com/p/session/bps_1' });
  if (key === 'GET /subscriptions/sub_1') return jsonRes({ id: 'sub_1', status: 'active' });
  if (key === 'DELETE /subscriptions/sub_1') return jsonRes({ id: 'sub_1', status: 'canceled', ended_at: Math.floor(Date.now() / 1000) });
  return undefined;
};

const sign = (body, { secret = SECRET, t = Math.floor(Date.now() / 1000) } = {}) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
let seq = 0;
const event = (type, object, { created = Math.floor(Date.now() / 1000), id = `evt_${++seq}` } = {}) => JSON.stringify({ id, object: 'event', type, created, data: { object } });
async function deliver(env, body, header = sign(body)) {
  const res = await worker.fetch(new Request('https://worker.example/cloud/webhook/stripe', { method: 'POST', headers: { 'Stripe-Signature': header }, body }), env);
  return { status: res.status, json: await res.json() };
}
const END = Math.floor((Date.now() + 30 * DAY) / 1000);   // the end of the paid period, as Stripe gives it (seconds)
const subscription = (over = {}) => ({
  id: 'sub_1', object: 'subscription', customer: 'cus_1', status: 'active', cancel_at_period_end: false, cancel_at: null, ended_at: null,
  metadata: { site_id: 'site-1' }, items: { data: [{ current_period_end: END, price: { id: 'price_cloud_m' } }] }, ...over,
});
const row = (env) => env.kiln_cloud.row("SELECT * FROM sites WHERE id = 'site-1'");
const paidThroughStripe = (env, over = {}) => {
  addSite(env, { status: 'active', ...over });
  env.kiln_cloud.exec("UPDATE sites SET stripe_subscription_id = 'sub_1', stripe_customer_id = 'cus_1' WHERE id = 'site-1'");
};
const mailbox = () => { const out = []; return { out, binding: { send: async (m) => { out.push(String(m.raw || '')); } } }; };

// What a service that once sold through the older billing company may still have set. None of it is read.
const OLD_SETTINGS = { LS_API_KEY: 'ls_key', LS_STORE_ID: '1', LS_VARIANT_CLOUD: '11', LS_VARIANT_MANAGED: '22', LS_VARIANT_CLOUD_YEARLY: '44', LS_VARIANT_MANAGED_YEARLY: '33', LS_WEBHOOK_SECRET: 'whsec' };

test('billingProvider: Stripe once its secret key is set, and nothing without it, whatever an older billing company left set', () => {
  assert.equal(billingProvider({ STRIPE_SECRET_KEY: 'sk' }), 'stripe');
  assert.equal(billingProvider({ STRIPE_SECRET_KEY: 'sk', ...OLD_SETTINGS }), 'stripe');
  assert.equal(billingProvider(OLD_SETTINGS), null);
  assert.equal(billingOn(OLD_SETTINGS), false);
  assert.equal(billingProvider({ ...PRICES, STRIPE_WEBHOOK_SECRET: SECRET }), null, 'prices and a webhook secret without the key sell nothing');
  assert.equal(billingProvider({}), null);
  assert.equal(billingProvider(undefined), null);
  // A site's subscription is its Stripe one. An id left in the older company's column is not read.
  assert.equal(subscriptionOf({ stripe_subscription_id: 'sub_1' }), 'sub_1');
  assert.equal(subscriptionOf({ subscription_id: 'sub_2' }), 'sub_2');
  assert.equal(subscriptionOf({ subscription_id: null, stripe_subscription_id: null }), null);
  assert.equal(subscriptionOf({ ls_subscription_id: '77' }), null);
  assert.equal(subscriptionProvider({ stripe_subscription_id: 'sub_1' }), 'stripe');
  assert.equal(subscriptionProvider({ ls_subscription_id: '77' }), null);
  assert.equal(subscriptionProvider(null), null);
  assert.equal(formBody({ a: [{ b: 1 }], c: { d: 'x y' }, e: null }), 'a%5B0%5D%5Bb%5D=1&c%5Bd%5D=x+y');
});

test('subscriptionSql: the Stripe column, and the word NULL on a database that has no such column yet, so every query that uses it still runs', { skip: d1Skip }, async () => {
  const today = stripeEnv();
  assert.equal(await subscriptionSql(today), 'stripe_subscription_id');
  assert.equal(await subscriptionSql(today, 's.'), 's.stripe_subscription_id');
  assert.equal(await subscriptionSql({}), 'NULL', 'no database at all');
  // A database migration 0017 has not reached: no Stripe columns.
  const before = schemaFiles().findIndex(f => f.endsWith('0017_stripe.sql'));
  assert.ok(before > 0);
  const old = cloudEnv(fakeKV(), { d1: { upTo: before }, STRIPE_SECRET_KEY: 'sk_test_kiln', CLOUD_ADMIN: 'ada' });
  assert.throws(() => old.kiln_cloud.row('SELECT stripe_subscription_id FROM sites'));
  addSite(old, { status: 'trialing', created_at: Date.now() - 8 * DAY });
  // An id left by the older billing company counts for nothing: nobody on this database has a subscription.
  old.kiln_cloud.exec("INSERT INTO sites (id, account_id, repo, origin, plan, status, ls_subscription_id, created_at) VALUES ('site-2', 'acct-1', 'ada/two', 'https://two.example', 'cloud', 'active', '77', 1)");
  assert.equal(await subscriptionSql(old), 'NULL');
  assert.equal(await subscriptionSql(old, 's.'), 'NULL');
  // In a SELECT and in a WHERE, as the worker writes them.
  const paidBy = await subscriptionSql(old, 's.');
  assert.deepEqual(old.kiln_cloud.db.prepare(`SELECT s.id, ${paidBy} AS subscription_id FROM sites s WHERE ${paidBy} IS NULL ORDER BY s.id`).all().map(r => ({ ...r })), [{ id: 'site-1', subscription_id: null }, { id: 'site-2', subscription_id: null }]);
  assert.equal(old.kiln_cloud.db.prepare(`SELECT COUNT(*) n FROM sites s WHERE ${paidBy} IS NOT NULL`).get().n, 0);
  // The dashboard, the five-minute job and the admin page all answer there.
  const me = await ask(old, '/cloud/me');
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json()).sites.map(x => [x.id, x.subscribed]).sort(), [['site-1', false], ['site-2', false]]);
  await worker.scheduled({}, old);
  assert.equal(old.kiln_cloud.row("SELECT status FROM sites WHERE id = 'site-1'").status, 'canceled', 'a free trial past its days is ended, as on any database');
  assert.equal(old.kiln_cloud.row("SELECT status FROM sites WHERE id = 'site-2'").status, 'active');
});

test('the plan and period of a Stripe price, and nothing for a price this service does not sell or a yearly one not set', () => {
  const env = { ...PRICES };
  assert.deepEqual([planForPrice(env, 'price_cloud_m'), periodForPrice(env, 'price_cloud_m')], ['cloud', 'month']);
  assert.deepEqual([planForPrice(env, 'price_cloud_y'), periodForPrice(env, 'price_cloud_y')], ['cloud', 'year']);
  assert.deepEqual([planForPrice(env, 'price_managed_y'), periodForPrice(env, 'price_managed_y')], ['managed', 'year']);
  assert.deepEqual([planForPrice(env, 'price_other'), periodForPrice(env, 'price_other')], [null, null]);
  const noYearly = { STRIPE_PRICE_MANAGED: 'price_managed_m', STRIPE_PRICE_MANAGED_YEARLY: 'price_managed_y' };
  delete noYearly.STRIPE_PRICE_MANAGED;
  assert.equal(planForPrice(noYearly, 'price_managed_y'), null, 'a yearly price without its monthly one is not sold');
});

test('the signature: Stripe\'s own header form, any of several v1 values, and nothing old, unsigned or signed with another secret', async () => {
  const body = '{"id":"evt_x"}';
  const t = Math.floor(Date.now() / 1000);
  const good = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
  assert.equal(await verifyStripeSignature(`t=${t},v1=${good}`, body, SECRET), true);
  assert.equal(await verifyStripeSignature(`t=${t},v1=${'0'.repeat(64)},v1=${good},v0=abc`, body, SECRET), true, 'a second v1 while the secret is rolled');
  assert.equal(await verifyStripeSignature(`t=${t},v1=${good}`, body + ' ', SECRET), false, 'a changed body');
  assert.equal(await verifyStripeSignature(`t=${t},v1=${good}`, body, 'whsec_other'), false);
  assert.equal(await verifyStripeSignature(`t=${t - 301},v1=${createHmac('sha256', SECRET).update(`${t - 301}.${body}`).digest('hex')}`, body, SECRET), false, 'older than five minutes');
  assert.equal(await verifyStripeSignature(`v1=${good}`, body, SECRET), false);
  assert.equal(await verifyStripeSignature('', body, SECRET), false);
  assert.equal(await verifyStripeSignature(`t=${t},v1=${good}`, body, ''), false, 'no secret set: nothing is trusted');
});

test('Subscribe: one Checkout Session for the site\'s price, plan and period, Managed Payments on, no Stripe trial, back to the dashboard', { skip: d1Skip }, async () => {
  for (const [plan, period, price] of [['cloud', 'month', 'price_cloud_m'], ['cloud', 'year', 'price_cloud_y'], ['managed', 'month', 'price_managed_m'], ['managed', 'year', 'price_managed_y']]) {
    const env = stripeEnv();
    addSite(env, { status: 'trialing', plan });
    await withFetch(stripe(), async (calls) => {
      const res = await ask(env, `/cloud/checkout?site=site-1${period === 'year' ? '&period=year' : ''}`);
      assert.equal(res.status, 200, `${plan} ${period}`);
      assert.deepEqual(await res.json(), { url: 'https://checkout.stripe.com/c/pay/cs_1' });
      assert.equal(calls.length, 1, 'one call, to Stripe');
      const [call] = toStripe(calls);
      assert.equal(call.url, `${API}/checkout/sessions`);
      assert.equal(call.method, 'POST');
      assert.equal(call.headers.Authorization, 'Bearer sk_test_kiln');
      assert.equal(call.headers['Stripe-Version'], '2025-03-31.basil');
      assert.equal(call.headers['Content-Type'], 'application/x-www-form-urlencoded');
      assert.deepEqual(form(call), {
        mode: 'subscription',
        'line_items[0][price]': price,
        'line_items[0][quantity]': '1',
        'managed_payments[enabled]': 'true',
        success_url: 'https://app.example/?subscribed=site-1',
        cancel_url: 'https://app.example/',
        client_reference_id: 'site-1',
        'metadata[site_id]': 'site-1', 'metadata[plan]': plan, 'metadata[period]': period,
        'subscription_data[metadata][site_id]': 'site-1', 'subscription_data[metadata][plan]': plan, 'subscription_data[metadata][period]': period,
        customer_email: 'ada@example.com',
      }, `${plan} ${period}: exactly these fields, and no trial among them`);
    });
  }
});

test('Subscribe: a yearly asking with no yearly price set gets the monthly one; an account that paid before keeps its Stripe customer', { skip: d1Skip }, async () => {
  const env = stripeEnv({ STRIPE_PRICE_CLOUD_YEARLY: '' });
  addSite(env, { status: 'trialing' });
  env.kiln_cloud.exec("UPDATE accounts SET stripe_customer_id = 'cus_9' WHERE id = 'acct-1'");
  await withFetch(stripe(), async (calls) => {
    assert.equal((await ask(env, '/cloud/checkout?site=site-1&period=year')).status, 200);
    const f = form(toStripe(calls)[0]);
    assert.equal(f['line_items[0][price]'], 'price_cloud_m');
    assert.equal(f['metadata[period]'], 'month');
    assert.equal(f.customer, 'cus_9');
    assert.equal('customer_email' in f, false, 'the customer is named instead of the address');
  });
  // No address on the account, and no customer: neither is sent.
  const bare = stripeEnv();
  bare.kiln_cloud.exec("UPDATE accounts SET email = NULL WHERE id = 'acct-1'");
  addSite(bare, { status: 'trialing' });
  await withFetch(stripe(), async (calls) => {
    assert.equal((await ask(bare, '/cloud/checkout?site=site-1')).status, 200);
    const f = form(toStripe(calls)[0]);
    assert.equal('customer_email' in f || 'customer' in f, false);
  });
  // Stripe refusing: the customer reads the same sentence as before, and nothing was charged.
  const down = stripeEnv();
  addSite(down, { status: 'trialing' });
  await withFetch(stripe({ 'POST /checkout/sessions': () => jsonRes({ error: { message: 'no' } }, 400) }), async () => {
    const res = await ask(down, '/cloud/checkout?site=site-1');
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'billing_not_configured');
  });
});

test('with no Stripe key billing is off, whatever an older billing company left set: no payment page, nobody asked, and the dashboard\'s answer keeps its shape', { skip: d1Skip }, async () => {
  const env = cloudEnv(fakeKV(), { CLOUD_DASHBOARD: 'https://app.example', ...PRICES, ...OLD_SETTINGS, STRIPE_SECRET_KEY: '' });
  addSite(env, { status: 'trialing' });
  await withFetch(async () => jsonRes({ url: 'https://pay.example/never' }, 201), async (calls) => {
    const res = await ask(env, '/cloud/checkout?site=site-1');
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'billing_not_configured');
    assert.equal(calls.length, 0, 'no billing company is asked for a payment page');
  });
  const me = await (await ask(env, '/cloud/me')).json();
  assert.equal(me.billing, false);
  assert.equal(me.yearly, undefined, 'yearly prices mean nothing while nobody can pay');
  assert.equal(me.yearly_cloud, undefined);
  // The store line on the admin page says so too.
  const o = await (await ask({ ...env, CLOUD_ADMIN: 'ada' }, '/admin/cloud/overview')).json();
  assert.equal(o.store.mode, 'unconfigured');
  const s = await (await ask(stripeEnv(), '/cloud/me')).json();
  assert.deepEqual([s.billing, s.yearly, s.yearly_cloud], [true, true, true]);
});

test('the older billing company\'s webhook address is gone: a notice signed its way gets what any unknown /cloud address gets, and changes nothing', { skip: d1Skip }, async () => {
  const env = stripeEnv(OLD_SETTINGS);
  paidThroughStripe(env);
  const body = JSON.stringify({
    meta: { event_name: 'subscription_expired', custom_data: { site_id: 'site-1' } },
    data: { type: 'subscriptions', id: 'sub_1', attributes: { status: 'expired', updated_at: new Date().toISOString(), ends_at: null } },
  });
  const signed = createHmac('sha256', OLD_SETTINGS.LS_WEBHOOK_SECRET).update(body).digest('hex');
  const gone = await worker.fetch(new Request('https://worker.example/cloud/webhook/ls', { method: 'POST', headers: { 'X-Signature': signed }, body }), env);
  const unknown = await worker.fetch(new Request('https://worker.example/cloud/no-such-address', { method: 'POST', body }), env);
  assert.equal(gone.status, 404);
  assert.deepEqual([gone.status, await gone.text()], [unknown.status, await unknown.text()]);
  assert.deepEqual([row(env).status, row(env).access_until, row(env).stripe_subscription_id], ['active', null, 'sub_1']);
});

test('the dashboard\'s account carries no customer id, of Stripe or of the older billing company', { skip: d1Skip }, async () => {
  const env = stripeEnv();
  paidThroughStripe(env);
  env.kiln_cloud.exec("UPDATE accounts SET ls_customer_id = 'old-9', stripe_customer_id = 'cus_1' WHERE id = 'acct-1'");
  const text = await (await ask(env, '/cloud/me')).text();
  const me = JSON.parse(text);
  assert.deepEqual(me.account, { id: 'acct-1', github_login: 'ada', email: 'ada@example.com', name: null, google: false, by_email: false });
  assert.equal('ls_customer_id' in me.account, false);
  assert.equal(/old-9|cus_1/.test(text), false);
});

test('webhook: a paid checkout ties the site to its customer and subscription and makes it active; a bad or old signature changes nothing', { skip: d1Skip }, async () => {
  const env = stripeEnv();
  addSite(env, { status: 'trialing' });
  const body = event('checkout.session.completed', {
    id: 'cs_1', object: 'checkout.session', mode: 'subscription', payment_status: 'paid', client_reference_id: 'site-1',
    metadata: { site_id: 'site-1' }, customer: 'cus_1', subscription: 'sub_1', customer_details: { email: 'paid@example.com' },
  });
  for (const header of [sign(body, { secret: 'whsec_other' }), sign(body, { t: Math.floor(Date.now() / 1000) - 600 }), '', 't=1,v1=zz']) {
    const r = await deliver(env, body, header);
    assert.equal(r.status, 400);
    assert.equal(row(env).status, 'trialing', 'nothing changed');
    assert.equal(row(env).stripe_subscription_id, null);
  }
  assert.equal((await deliver(env, body)).status, 200);
  const r = row(env);
  assert.deepEqual([r.status, r.access_until, r.stripe_subscription_id, r.stripe_customer_id, r.ls_subscription_id], ['active', null, 'sub_1', 'cus_1', null]);
  assert.equal(env.kiln_cloud.row("SELECT stripe_customer_id FROM accounts WHERE id = 'acct-1'").stripe_customer_id, 'cus_1');
  // The dashboard says the site is subscribed, without the id.
  const me = await (await ask(env, '/cloud/me')).json();
  assert.equal(me.sites[0].subscribed, true);
  assert.equal(JSON.stringify(me).includes('sub_1'), false);
});

test('webhook: the same event twice changes the site once, and an older change arriving late is left out', { skip: d1Skip }, async () => {
  const env = stripeEnv();
  const box = mailbox();
  env.NOTIFY = box.binding; env.NOTIFY_TO = 'ops@example.com';
  paidThroughStripe(env);
  const now = Math.floor(Date.now() / 1000);
  const failed = event('customer.subscription.updated', subscription({ status: 'past_due' }), { created: now, id: 'evt_same' });
  assert.equal((await deliver(env, failed)).status, 200);
  const first = row(env).access_until;
  const again = await deliver(env, failed);
  assert.deepEqual([again.status, again.json.replayed], [200, true]);
  assert.equal(row(env).access_until, first);
  assert.equal(box.out.length, 1, 'the operator is told once');
  // A change from before the last one (Stripe does not promise the order) does not undo it.
  const late = await deliver(env, event('customer.subscription.updated', subscription({ status: 'active' }), { created: now - 60 }));
  assert.equal(late.status, 200);
  assert.equal(row(env).status, 'past_due');
});

test('webhook: each Stripe status comes to the site\'s status and to how long it can still be edited', { skip: d1Skip }, async () => {
  const at = Math.floor(Date.now() / 1000) - 3600;
  // Paid and active: editing on, the paid period on record.
  let env = stripeEnv();
  paidThroughStripe(env, { status: 'trialing' });
  await deliver(env, event('customer.subscription.created', subscription(), { created: at }));
  assert.deepEqual([row(env).status, row(env).access_until, row(env).billing_period, row(env).paid_until], ['active', null, 'month', END * 1000]);
  // A payment failed: past_due, with the grace counted from the event, and a second failure does not start it again.
  await deliver(env, event('customer.subscription.updated', subscription({ status: 'past_due' }), { created: at + 1 }));
  assert.equal(row(env).status, 'past_due');
  assert.equal(row(env).access_until, (at + 1) * 1000 + PAST_DUE_GRACE_DAYS * DAY);
  await deliver(env, event('invoice.payment_failed', { id: 'in_1', object: 'invoice', parent: { subscription_details: { subscription: 'sub_1', metadata: { site_id: 'site-1' } } } }, { created: at + 2 }));
  assert.equal(row(env).access_until, (at + 1) * 1000 + PAST_DUE_GRACE_DAYS * DAY, 'the grace keeps its first day');
  // Set to cancel at the period's end: canceled, and editing stays on until that day.
  await deliver(env, event('customer.subscription.updated', subscription({ cancel_at_period_end: true }), { created: at + 3 }));
  assert.deepEqual([row(env).status, row(env).access_until, row(env).paid_until], ['canceled', END * 1000, END * 1000]);
  const me = await (await ask(env, '/cloud/me')).json();
  assert.equal(me.sites[0].editable, true);
  // Deleted: over, with no access.
  await deliver(env, event('customer.subscription.deleted', subscription({ status: 'canceled', ended_at: at + 4 }), { created: at + 4 }));
  assert.equal(row(env).status, 'canceled');
  assert.ok(row(env).access_until <= Date.now());
  assert.equal((await (await ask(env, '/cloud/me')).json()).sites[0].editable, false);

  // A first payment that has not gone through changes nothing: the site keeps its free days.
  env = stripeEnv();
  addSite(env, { status: 'trialing' });
  const r = await deliver(env, event('customer.subscription.created', subscription({ status: 'incomplete' })));
  assert.equal(r.json.ignored, 'status incomplete');
  assert.equal(row(env).status, 'trialing');
  // The mapping on its own.
  assert.deepEqual(stripeStateFor({ status: 'unpaid' }), { status: 'past_due', access: 'grace' });
  assert.deepEqual(stripeStateFor({ status: 'paused' }), { status: 'past_due', access: 'grace' });
  assert.deepEqual(stripeStateFor({ status: 'active', cancel_at: 123 }), { status: 'canceled', access: 'until' });
  assert.equal(stripeStateFor({ status: 'incomplete_expired' }), null);
});

test('webhook: the plan on record follows the price paid for, and the operator is told', { skip: d1Skip }, async () => {
  const env = stripeEnv();
  const box = mailbox();
  env.NOTIFY = box.binding; env.NOTIFY_TO = 'ops@example.com';
  paidThroughStripe(env, { plan: 'cloud' });
  const yearlyHosting = subscription({ items: { data: [{ current_period_end: END, price: { id: 'price_managed_y' } }] } });
  assert.equal((await deliver(env, event('customer.subscription.updated', yearlyHosting))).status, 200);
  assert.deepEqual([row(env).plan, row(env).billing_period], ['managed', 'year']);
  assert.match(box.out.join('\n'), /Plan: now managed \(was cloud\), because that is the plan the subscription pays for\./);
  // A price this service does not sell leaves the plan and period alone.
  await deliver(env, event('customer.subscription.updated', subscription({ items: { data: [{ current_period_end: END, price: { id: 'price_other' } }] } })));
  assert.deepEqual([row(env).plan, row(env).billing_period], ['managed', 'year']);
  // A subscription the site no longer pays by cannot end it.
  const old = await deliver(env, event('customer.subscription.deleted', subscription({ id: 'sub_0', status: 'canceled' })));
  assert.equal(old.json.ignored, 'not the subscription this site is paid by now');
  assert.equal(row(env).status, 'active');
});

test('Manage billing opens Stripe\'s Billing Portal for the site\'s customer, back to the dashboard', { skip: d1Skip }, async () => {
  const env = stripeEnv();
  paidThroughStripe(env);
  await withFetch(stripe(), async (calls) => {
    const res = await ask(env, '/cloud/portal?site=site-1');
    assert.deepEqual(await res.json(), { url: 'https://billing.stripe.com/p/session/bps_1' });
    const [call] = toStripe(calls);
    assert.equal(call.url, `${API}/billing_portal/sessions`);
    assert.deepEqual(form(call), { customer: 'cus_1', return_url: 'https://app.example/' });
  });
  // A site with no subscription has no billing page.
  const none = stripeEnv();
  addSite(none, { status: 'trialing' });
  await withFetch(stripe(), async (calls) => {
    assert.equal((await ask(none, '/cloud/portal?site=site-1')).status, 404);
    assert.equal(calls.length, 0);
  });
});

test('Remove cancels the site\'s Stripe subscription first, and keeps the site when Stripe cannot confirm it', { skip: d1Skip }, async () => {
  const env = stripeEnv();
  paidThroughStripe(env);
  await withFetch(stripe(), async (calls) => {
    const res = await ask(env, '/cloud/sites/remove', { method: 'POST', body: { id: 'site-1' } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).subscription, 'cancelled');
    assert.ok(toStripe(calls).some(c => c.method === 'DELETE' && c.url === `${API}/subscriptions/sub_1`));
    assert.equal(row(env), null);
  });
  const stuck = stripeEnv();
  paidThroughStripe(stuck);
  await withFetch(stripe({ 'DELETE /subscriptions/sub_1': () => jsonRes({ error: {} }, 500) }), async () => {
    const res = await ask(stuck, '/cloud/sites/remove', { method: 'POST', body: { id: 'site-1' } });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, 'subscription_not_cancelled');
    assert.ok(row(stuck), 'the site stays, so Manage billing stays');
  });
  // An id left in the older billing company's column is not a subscription any more: the site is removed, and nobody is asked.
  const old = stripeEnv();
  addSite(old, { status: 'active' });
  old.kiln_cloud.exec("UPDATE sites SET ls_subscription_id = '77' WHERE id = 'site-1'");
  await withFetch(stripe(), async (calls) => {
    const res = await ask(old, '/cloud/sites/remove', { method: 'POST', body: { id: 'site-1' } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).subscription, 'none');
    assert.equal(calls.length, 0);
    assert.equal(row(old), null);
  });
});

test('the admin page: Stripe\'s state in the store line, and a yearly price counted as a twelfth of it each month', { skip: d1Skip }, async () => {
  const env = stripeEnv({ CLOUD_ADMIN: 'ada' });
  addSite(env, { id: 'site-1', status: 'active', plan: 'cloud' });
  addSite(env, { id: 'site-2', origin: 'https://two.example', status: 'active', plan: 'managed' });
  env.kiln_cloud.exec("UPDATE sites SET billing_period = 'year' WHERE id = 'site-1'");
  const price = (amount, interval) => () => jsonRes({ active: true, unit_amount: amount, currency: 'usd', recurring: { interval } });
  const answers = {
    'GET /account': () => jsonRes({ id: 'acct_1', charges_enabled: true }),
    'GET /prices/price_cloud_m': price(499, 'month'), 'GET /prices/price_cloud_y': price(4900, 'year'),
    'GET /prices/price_managed_m': price(1499, 'month'), 'GET /prices/price_managed_y': price(14900, 'year'),
  };
  await withFetch(stripe(answers), async () => {
    const o = await (await ask(env, '/admin/cloud/overview')).json();
    assert.equal(o.store.mode, 'test');
    assert.equal(o.store.provider, 'stripe');
    assert.equal(o.store.charges_enabled, true);
    assert.equal(o.store.ready, true);
    assert.equal(o.store.prices.length, 4);
    assert.equal(o.mrr, Number((49 / 12 + 14.99).toFixed(2)));
  });
  await withFetch(stripe({ ...answers, 'GET /prices/price_managed_y': () => jsonRes({ error: {} }, 404) }), async () => {
    const o = await (await ask(env, '/admin/cloud/overview')).json();
    assert.equal(o.store.ready, false);
    assert.deepEqual(o.store.prices.find(p => p.id === 'price_managed_y'), { plan: 'managed', period: 'year', id: 'price_managed_y', found: false, active: false, amount: null, currency: null, interval: null });
  });
});
