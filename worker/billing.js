/**
 * Kiln Cloud's billing: whether somebody can pay here, and the calls this
 * service makes to Stripe.
 *
 * Stripe Managed Payments is the one billing company this service sells
 * through. Once `STRIPE_SECRET_KEY` is set, Stripe is the seller of record,
 * its hosted Checkout page takes the payment, and Link sends the receipts.
 * Without that key nobody can pay, and the free days work as they always have.
 *
 * A site that is paid for carries its subscription's id in
 * `sites.stripe_subscription_id`. subscriptionOf reads it from any row, and
 * subscriptionSql is the same thing for a query.
 *
 * No Stripe library: fetch, form-encoded bodies, and the API version pinned in
 * the Stripe-Version header, so what Stripe answers does not change under us.
 */

export const STRIPE = 'https://api.stripe.com/v1';
export const STRIPE_VERSION = '2025-03-31.basil';

/** 'stripe' where Stripe's secret key is set, and null where it is not: nobody can pay there. */
export function billingProvider(env) {
  return env && env.STRIPE_SECRET_KEY ? 'stripe' : null;
}
/** True when somebody can pay here at all. */
export const billingOn = (env) => billingProvider(env) !== null;
/** The company's name, for the operator's notes and the admin page. */
export const providerName = (p) => (p === 'stripe' ? 'Stripe' : 'the billing company');

/**
 * The subscription a site is paid for by, from any row of `sites`: a row read
 * with `subscriptionSql(...) AS subscription_id`, or a whole row. Null when
 * the site has never been paid for.
 */
export function subscriptionOf(row) {
  if (!row) return null;
  return row.subscription_id || row.stripe_subscription_id || null;
}
/** Which company a site's subscription is with: 'stripe', or null when the site has none. */
export function subscriptionProvider(row) {
  return row && row.stripe_subscription_id ? 'stripe' : null;
}

// The SQL for "the subscription this site is paid by", for a WHERE or a
// SELECT: the Stripe column. A database migration 0017 has not reached has no
// such column, and no site in it was ever paid for through Stripe. There the
// answer is the literal NULL, which is valid SQL wherever the column would
// stand and means "no subscription", so every query that uses it still runs.
const hasStripeColumns = new WeakSet();
export async function subscriptionSql(env, t = '') {
  const column = `${t}stripe_subscription_id`;
  const db = env && env.kiln_cloud;
  if (!db) return 'NULL';
  try { if (hasStripeColumns.has(db)) return column; } catch { /* not an object: asked below */ }
  try { await db.prepare('SELECT stripe_subscription_id FROM sites LIMIT 1').first(); }
  catch { return 'NULL'; }
  try { hasStripeColumns.add(db); } catch { /* asked again next time */ }
  return column;
}

// ─── Stripe ──────────────────────────────────────────────────────────────────

/** True when the plan with hosting is sold by the year as well (STRIPE_PRICE_MANAGED_YEARLY). */
export const stripeYearlyOn = (env) => !!(env && env.STRIPE_PRICE_MANAGED_YEARLY && env.STRIPE_PRICE_MANAGED);
/** True when the plan without hosting is sold by the year as well (STRIPE_PRICE_CLOUD_YEARLY). */
export const stripeCloudYearlyOn = (env) => !!(env && env.STRIPE_PRICE_CLOUD_YEARLY && env.STRIPE_PRICE_CLOUD);

/** The price id for a plan and a period; the monthly one where no yearly price is set. */
export function stripePrice(env, plan, period = 'month') {
  if (plan === 'managed') return (period === 'year' && stripeYearlyOn(env) ? env.STRIPE_PRICE_MANAGED_YEARLY : env.STRIPE_PRICE_MANAGED) || null;
  return (period === 'year' && stripeCloudYearlyOn(env) ? env.STRIPE_PRICE_CLOUD_YEARLY : env.STRIPE_PRICE_CLOUD) || null;
}
/** Each price this service sells: [plan, period, id], for the ones that are set. */
export function stripePrices(env) {
  return [
    ['cloud', 'month', env.STRIPE_PRICE_CLOUD], ['cloud', 'year', stripeCloudYearlyOn(env) ? env.STRIPE_PRICE_CLOUD_YEARLY : null],
    ['managed', 'month', env.STRIPE_PRICE_MANAGED], ['managed', 'year', stripeYearlyOn(env) ? env.STRIPE_PRICE_MANAGED_YEARLY : null],
  ].filter(([, , id]) => !!id).map(([plan, period, id]) => [plan, period, String(id)]);
}
/** Which plan a Stripe price is, or null for a price this service does not sell. */
export function planForPrice(env, priceId) {
  if (!priceId) return null;
  return stripePrices(env).find(([, , id]) => id === String(priceId))?.[0] || null;
}
/** Whether a Stripe price is paid by the 'month' or by the 'year', or null. */
export function periodForPrice(env, priceId) {
  if (!priceId) return null;
  return stripePrices(env).find(([, , id]) => id === String(priceId))?.[1] || null;
}

/** An object as Stripe's form encoding: { a: { b: 1 } } → a[b]=1. */
export function formBody(obj) {
  const out = new URLSearchParams();
  const walk = (value, key) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${key}[${i}]`)); return; }
    if (typeof value === 'object') { for (const [k, v] of Object.entries(value)) walk(v, key ? `${key}[${k}]` : k); return; }
    out.append(key, String(value));
  };
  walk(obj, '');
  return out.toString();
}

/** One call to Stripe. Answers { ok, status, body }; never throws. */
export async function stripeCall(env, method, path, params = null) {
  const headers = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': STRIPE_VERSION };
  if (params) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  try {
    const r = await fetch(`${STRIPE}${path}`, { method, headers, ...(params ? { body: formBody(params) } : {}) });
    let body = null;
    try { body = await r.json(); } catch { body = null; }
    return { ok: r.ok, status: r.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const backTo = (env, siteId) => {
  let back = env.CLOUD_DASHBOARD || 'https://app.kilncms.com', after = back;
  try { const u = new URL(back); u.searchParams.set('subscribed', siteId); after = u.toString(); back = new URL(back).toString(); } catch { /* a dashboard address that is no URL: sent as it is */ }
  return { back, after };
};

/**
 * A Checkout Session for one site: the one price of the site's plan and
 * period, Managed Payments on, and the customer sent back to the dashboard.
 * The free days are Kiln's own and need no card, so no Stripe trial is asked
 * for. The site's id rides on the session and on the subscription, which is
 * how the webhook knows which site was paid for. `customer` (an account that
 * has paid before) is used in place of the address. Answers the page's
 * address, or null.
 */
export async function stripeCheckout(env, site, { email = null, customer = null, period = 'month' } = {}) {
  const price = stripePrice(env, site.plan, period);
  if (!env.STRIPE_SECRET_KEY || !price) return null;
  const { back, after } = backTo(env, site.id);
  const paidPeriod = periodForPrice(env, price) || 'month';
  const tags = { site_id: site.id, plan: site.plan === 'managed' ? 'managed' : 'cloud', period: paidPeriod };
  const params = {
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    managed_payments: { enabled: 'true' },
    success_url: after,
    cancel_url: back,
    client_reference_id: site.id,
    metadata: tags,
    subscription_data: { metadata: tags },
    ...(customer ? { customer } : typeof email === 'string' && EMAIL.test(email) ? { customer_email: email } : {}),
  };
  const r = await stripeCall(env, 'POST', '/checkout/sessions', params);
  return r.ok ? (r.body && r.body.url) || null : null;
}

/** A Billing Portal session for a Stripe customer, returning to the dashboard. Answers its address, or null. */
export async function stripePortal(env, customer) {
  if (!env.STRIPE_SECRET_KEY || !customer) return null;
  const r = await stripeCall(env, 'POST', '/billing_portal/sessions', { customer, return_url: backTo(env, '').back });
  return r.ok ? (r.body && r.body.url) || null : null;
}

/**
 * End a Stripe subscription before its site is forgotten. The answer is
 * `{ ok, state, ends_at }`. `ok` is true only when no further charge can
 * follow: the site never had a subscription (`none`), Stripe says it has
 * already ended (`already_cancelled`), or Stripe confirmed the cancellation
 * just now (`cancelled`). `ends_at` is then the time it ended, where Stripe
 * gives one. Anything else is "not known to be cancelled": no Stripe key here
 * (`billing_not_configured`), Stripe not answering (`billing_unreachable`),
 * a subscription this key cannot see (`subscription_not_found`), or Stripe
 * refusing (`cancel_refused`). The caller then keeps the site, so the
 * customer can still reach Manage billing.
 */
export async function stripeCancel(env, subscriptionId) {
  if (!subscriptionId) return { ok: true, state: 'none' };
  if (!env.STRIPE_SECRET_KEY) return { ok: false, state: 'billing_not_configured' };
  const ended = (s) => !!s && (s.status === 'canceled' || s.status === 'incomplete_expired');
  const endsAt = (s) => (s && Number(s.ended_at) ? new Date(Number(s.ended_at) * 1000).toISOString() : null);
  const id = encodeURIComponent(subscriptionId);
  const cur = await stripeCall(env, 'GET', `/subscriptions/${id}`);
  // 404 is not "nothing to cancel": a key for the other mode (test or live) cannot see a subscription that is still charging.
  if (!cur.ok) return { ok: false, state: cur.status === 404 ? 'subscription_not_found' : 'billing_unreachable' };
  if (ended(cur.body)) return { ok: true, state: 'already_cancelled', ends_at: endsAt(cur.body) };
  const res = await stripeCall(env, 'DELETE', `/subscriptions/${id}`);
  if (!res.ok) return { ok: false, state: res.status === 0 ? 'billing_unreachable' : 'cancel_refused' };
  return ended(res.body) ? { ok: true, state: 'cancelled', ends_at: endsAt(res.body) } : { ok: false, state: 'cancel_refused' };
}

/**
 * Was this request signed by Stripe with our endpoint's secret? The header is
 * `t=<seconds>,v1=<hex>[,v1=<hex>]`; the signature is HMAC-SHA256 of
 * `<t>.<body>`. A timestamp more than five minutes away is refused, so a
 * captured delivery cannot be sent again later.
 */
export const STRIPE_TOLERANCE_SECONDS = 300;
export async function verifyStripeSignature(header, bodyText, secret, now = Date.now()) {
  if (!header || !secret || typeof bodyText !== 'string') return false;
  let t = null; const sigs = [];
  for (const part of String(header).split(',')) {
    const i = part.indexOf('='); if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') t = v; else if (k === 'v1' && v) sigs.push(v.toLowerCase());
  }
  if (!t || !/^\d+$/.test(t) || !sigs.length) return false;
  if (Math.abs(now / 1000 - Number(t)) > STRIPE_TOLERANCE_SECONDS) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${bodyText}`));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  let good = false;
  for (const sig of sigs) {
    if (sig.length !== expected.length) continue;
    let diff = 0; for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    if (diff === 0) good = true;
  }
  return good;
}

/**
 * Where the Stripe account stands, for the store line on the admin page:
 * `mode` is 'live', 'test', 'unknown' or 'unconfigured'.
 * Besides: whether charges are enabled, and for each price that is set whether
 * Stripe has it and it is active, with its amount and how often it is paid.
 * `ready` is true when all of that is so.
 */
export async function stripeStoreMode(env) {
  if (!env.STRIPE_SECRET_KEY) return { mode: 'unconfigured', provider: 'stripe' };
  const key = String(env.STRIPE_SECRET_KEY);
  const keyMode = /^(sk|rk)_live_/.test(key) ? 'live' : /^(sk|rk)_test_/.test(key) ? 'test' : 'unknown';
  const acct = await stripeCall(env, 'GET', '/account');
  if (!acct.ok) return { mode: 'unknown', provider: 'stripe', charges_enabled: null, prices: [], ready: false };
  const prices = [];
  for (const [plan, period, id] of stripePrices(env)) {
    const p = await stripeCall(env, 'GET', `/prices/${encodeURIComponent(id)}`);
    const b = p.ok ? p.body || {} : null;
    prices.push({
      plan, period, id, found: !!b, active: !!(b && b.active),
      amount: b && Number.isFinite(Number(b.unit_amount)) ? Number(b.unit_amount) / 100 : null,
      currency: (b && b.currency) || null, interval: (b && b.recurring && b.recurring.interval) || null,
    });
  }
  const charges = !!(acct.body && acct.body.charges_enabled);
  const missing = ['cloud', 'managed'].filter(plan => !prices.some(p => p.plan === plan && p.period === 'month'));
  return {
    mode: keyMode, provider: 'stripe', charges_enabled: charges, prices,
    ready: charges && !missing.length && prices.every(p => p.found && p.active),
  };
}

/** What a site on a plan, paid by a period, brings in a month, from the prices read by stripeStoreMode; null when not known. */
export function monthlyFromPrices(store, plan, period) {
  const p = (store && store.prices || []).find(x => x.plan === plan && x.period === (period === 'year' ? 'year' : 'month') && x.amount !== null);
  if (!p) return null;
  return p.interval === 'year' ? p.amount / 12 : p.amount;
}
