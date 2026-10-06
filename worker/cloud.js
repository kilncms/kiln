/**
 * Kiln Cloud — the hosted tier on top of the kiln-auth worker.
 *
 * Routes (all behind handleCloud):
 *   GET  /cloud/login            → GitHub OAuth (identity only)
 *   GET  /cloud/callback         → upsert account, set session cookie, → dashboard
 *   GET  /cloud/me               → { account, sites }
 *   POST /cloud/sites            → register a site (verify repo install) → checkout URL
 *   POST /cloud/sites/remove     → cancel its subscription, then delete a site
 *   GET  /cloud/portal?site=     → Lemon Squeezy customer-portal link
 *   POST /cloud/webhook/ls       → Lemon Squeezy webhook (signed) → set site status
 *   GET  /admin/cloud/overview   → (owner only) accounts, sites, MRR
 *   POST /admin/cloud/grant      → (owner only) manually set a site's status
 *
 * Storage: D1 `kiln_cloud` (accounts, sites). KV `csess:<id>` for dashboard sessions.
 * Billing degrades gracefully: with no LS_* secrets, sites register as `trialing` and
 * checkout/portal report "billing not configured" until you add your Lemon Squeezy keys.
 */

import { RUNBOOK_HTML } from './runbook.js';

const GH = 'https://api.github.com';
const LS = 'https://api.lemonsqueezy.com/v1';
const UA = 'kiln-cloud';

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const uuid = () => crypto.randomUUID();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ─── GitHub identity (reuses the GitHub App's OAuth client) ───────────────────

async function creds(env) { return JSON.parse(await env.KILN.get('app:creds')); }

async function ghUser(token) {
  const r = await fetch(`${GH}/user`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': UA } });
  return r.ok ? r.json() : null;
}

async function appJwt(c) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const body = b64url(new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: c.app_id })));
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(c.pk8), s => s.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

/** Is the Kiln app installed on this repo, AND does this user have access to it? */
async function repoInstalled(env, repo) {
  const c = await creds(env);
  const jwt = await appJwt(c);
  const r = await fetch(`${GH}/repos/${repo}/installation`, { headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': UA } });
  return r.ok;
}

/** Does the signed-in user (via their stored OAuth token) have push on the repo? */
async function userCanPush(userToken, repo) {
  if (!userToken) return false;
  try {
    const r = await fetch(`${GH}/repos/${repo}`, { headers: { Authorization: `Bearer ${userToken}`, Accept: 'application/vnd.github+json', 'User-Agent': UA } });
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j.permissions && (j.permissions.push || j.permissions.admin || j.permissions.maintain));
  } catch { return false; }
}

// ─── Dashboard sessions (KV) ──────────────────────────────────────────────────

// Bearer-token sessions (the dashboard lives on a different origin than this API,
// so cookies aren't usable — the token rides in the OAuth-return fragment, the
// dashboard stores it, and sends it as Authorization: Bearer on every call).
function bearer(request) {
  const a = request.headers.get('Authorization') || '';
  return a.startsWith('Bearer ') ? a.slice(7).trim() : null;
}
async function session(request, env) {
  const sid = bearer(request);
  if (!sid) return null;
  const raw = await env.KILN.get(`csess:${sid}`);
  return raw ? JSON.parse(raw) : null;
}

// ─── Accounts + sites (D1) ────────────────────────────────────────────────────

async function upsertAccount(env, login, email) {
  const existing = await env.kiln_cloud.prepare('SELECT * FROM accounts WHERE github_login = ?').bind(login).first();
  if (existing) return existing;
  const id = uuid();
  await env.kiln_cloud.prepare('INSERT INTO accounts (id, github_login, email, created_at) VALUES (?,?,?,?)')
    .bind(id, login, email || null, Date.now()).run();
  return { id, github_login: login, email, ls_customer_id: null };
}

// ─── Lemon Squeezy ────────────────────────────────────────────────────────────

function lsConfigured(env) { return !!(env.LS_API_KEY && env.LS_STORE_ID); }

function lsVariant(env, plan) { return plan === 'managed' ? env.LS_VARIANT_MANAGED : env.LS_VARIANT_CLOUD; }

// Live/test mode of the LS store, inferred from whether the Cloud variant is published
// (variants sit `pending` until the store is activated for live payments, then `published`).
async function lsStoreMode(env) {
  if (!lsConfigured(env) || !env.LS_VARIANT_CLOUD) return { mode: 'unconfigured' };
  try {
    const r = await fetch(`${LS}/variants/${env.LS_VARIANT_CLOUD}`, {
      headers: { Authorization: `Bearer ${env.LS_API_KEY}`, Accept: 'application/vnd.api+json' },
    });
    if (!r.ok) return { mode: 'unknown' };
    const status = (await r.json())?.data?.attributes?.status || 'unknown';
    return { mode: status === 'published' ? 'live' : 'test', variant_status: status };
  } catch { return { mode: 'unknown' }; }
}

async function lsCheckout(env, site) {
  const variant = lsVariant(env, site.plan);
  if (!lsConfigured(env) || !variant) return null;
  const body = {
    data: {
      type: 'checkouts',
      attributes: { checkout_data: { custom: { site_id: site.id } } },
      relationships: {
        store: { data: { type: 'stores', id: String(env.LS_STORE_ID) } },
        variant: { data: { type: 'variants', id: String(variant) } },
      },
    },
  };
  const r = await fetch(`${LS}/checkouts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.LS_API_KEY}`, 'Content-Type': 'application/vnd.api+json', Accept: 'application/vnd.api+json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.data?.attributes?.url || null;
}

async function lsPortal(env, subscriptionId) {
  if (!lsConfigured(env) || !subscriptionId) return null;
  const r = await fetch(`${LS}/subscriptions/${subscriptionId}`, {
    headers: { Authorization: `Bearer ${env.LS_API_KEY}`, Accept: 'application/vnd.api+json' },
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.data?.attributes?.urls?.customer_portal || null;
}

/**
 * End a subscription before its site is forgotten. `ok` is true only when no
 * further charge can follow: the site never had a subscription, Lemon Squeezy
 * says it has already ended, or Lemon Squeezy confirmed the cancellation just
 * now. Anything else (billing not configured here, Lemon Squeezy not
 * answering, a subscription this key cannot see) is "not known to be
 * cancelled", and the caller keeps the site so the customer can still reach
 * Manage billing.
 */
export async function lsCancel(env, subscriptionId) {
  if (!subscriptionId) return { ok: true, state: 'none' };
  if (!lsConfigured(env)) return { ok: false, state: 'billing_not_configured' };
  const headers = { Authorization: `Bearer ${env.LS_API_KEY}`, Accept: 'application/vnd.api+json' };
  const ended = (a) => !!a && (a.status === 'cancelled' || a.status === 'expired');
  try {
    const cur = await fetch(`${LS}/subscriptions/${subscriptionId}`, { headers });
    // 404 is not "nothing to cancel": a key for the other mode (test/live)
    // cannot see a subscription that is still charging.
    if (!cur.ok) return { ok: false, state: cur.status === 404 ? 'subscription_not_found' : 'billing_unreachable' };
    const before = (await cur.json())?.data?.attributes;
    if (ended(before)) return { ok: true, state: 'already_cancelled', ends_at: before.ends_at || null };
    const res = await fetch(`${LS}/subscriptions/${subscriptionId}`, { method: 'DELETE', headers });
    if (!res.ok) return { ok: false, state: 'cancel_refused' };
    const after = (await res.json())?.data?.attributes;
    return ended(after) ? { ok: true, state: 'cancelled', ends_at: after.ends_at || null } : { ok: false, state: 'cancel_refused' };
  } catch {
    return { ok: false, state: 'billing_unreachable' };
  }
}

const NOT_CANCELLED = 'This site has a subscription that could not be cancelled just now, so the site was not removed and nothing changed. '
  + 'Open Manage billing, cancel the subscription there, then remove the site.';

async function verifyLsSignature(request, bodyText, env) {
  const sig = request.headers.get('X-Signature');
  if (!sig || !env.LS_WEBHOOK_SECRET) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.LS_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(bodyText));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  // constant-time-ish compare
  if (expected.length !== sig.length) return false;
  let diff = 0; for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// What each Lemon Squeezy subscription status means for a site.
//   status   what the dashboard and the admin page show
//   access   'yes'    editing is on
//            'until'  cancelled, and paid up to `ends_at`: editing stays on until then
//            'grace'  a charge failed (or billing is paused): editing stays on for
//                     PAST_DUE_GRACE_DAYS from the first such event, while Lemon
//                     Squeezy retries the card
//            'no'     the subscription is over: editing is off
// Only `expired` ends access outright.
export const PAST_DUE_GRACE_DAYS = 7;
const LS_STATE = {
  active:    { status: 'active',   access: 'yes' },
  on_trial:  { status: 'trialing', access: 'yes' },
  cancelled: { status: 'canceled', access: 'until' },
  expired:   { status: 'canceled', access: 'no' },
  past_due:  { status: 'past_due', access: 'grace' },
  unpaid:    { status: 'past_due', access: 'grace' },
  paused:    { status: 'past_due', access: 'grace' },
};

// A site may be edited while it is active or trialing, or, after that, until
// its `access_until` passes. One rule, in SQL for the request path and in JS
// for the admin page.
const ACCESS_SQL = "(status IN ('active','trialing') OR (status IN ('canceled','past_due') AND access_until > ?))";
export function siteHasAccess(site, now = Date.now()) {
  if (!site) return false;
  if (site.status === 'active' || site.status === 'trialing') return true;
  return (site.status === 'canceled' || site.status === 'past_due') && Number(site.access_until) > now;
}

// `access_until` arrives with migration 0002, which is applied before this
// worker is deployed. Should the worker ever run against a database without
// it, every statement that names the column falls back to the one that does
// not, so sites that are paid up keep working either way.
async function withAccessUntil(run, fallback) {
  try { return await run(); }
  catch (e) {
    if (/access_until/.test(String((e && e.message) || e))) return fallback();
    throw e;
  }
}

/** The site row for an origin that may be edited right now, or null. */
export async function cloudSiteForOrigin(env, origin, now = Date.now()) {
  if (!env.kiln_cloud || !origin) return null;
  return withAccessUntil(
    () => env.kiln_cloud.prepare(`SELECT repo, status, access_until FROM sites WHERE origin = ? AND ${ACCESS_SQL} LIMIT 1`).bind(origin, now).first(),
    () => env.kiln_cloud.prepare("SELECT repo, status FROM sites WHERE origin = ? AND status IN ('active','trialing') LIMIT 1").bind(origin).first(),
  );
}

// Cron housekeeping: a site registers as `trialing` immediately so the owner can set up
// and preview before paying — but that grace can't be open-ended, or a site could edit
// forever without ever subscribing. Expire `trialing` sites that never started a Lemon
// Squeezy subscription once they pass the grace window; that drops them from the editable
// allowlist (a canceled site with no access_until has no access). Real LS trials carry an
// ls_subscription_id and are untouched — their lifecycle is driven entirely by webhooks.
const TRIAL_GRACE_DAYS = 7;
export async function expireStaleTrials(env) {
  if (!env.kiln_cloud) return;
  const cutoff = Date.now() - TRIAL_GRACE_DAYS * 86400 * 1000;
  await env.kiln_cloud.prepare(
    "UPDATE sites SET status = 'canceled' WHERE status = 'trialing' AND ls_subscription_id IS NULL AND created_at < ?"
  ).bind(cutoff).run();
}

/**
 * Is this dashboard session the operator? Identity is GitHub's numeric user
 * id (CLOUD_ADMIN_ID): a login can be renamed, and the old name is then free
 * for anyone to register. The login (CLOUD_ADMIN) is compared only when no id
 * is configured, so a worker set up before this keeps working until it is.
 * With an id configured, a session that carries none (signed in before the id
 * was recorded) is not the operator: sign in again.
 */
export function isCloudAdmin(sess, env) {
  if (!sess) return false;
  const id = String(env.CLOUD_ADMIN_ID || '').trim();
  if (id) return /^\d+$/.test(id) && sess.uid != null && String(sess.uid) === id;
  return !!env.CLOUD_ADMIN && sess.login === env.CLOUD_ADMIN;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export async function handleCloud(request, env, url, path) {
  const dash = env.CLOUD_DASHBOARD || 'https://app.kilncms.com';

  // GitHub OAuth — identity only.
  if (path === '/cloud/login') {
    const c = await creds(env);
    const nonce = uuid();
    await env.KILN.put(`cstate:${nonce}`, '1', { expirationTtl: 600 });
    const params = new URLSearchParams({ client_id: c.client_id, redirect_uri: `${url.origin}/cloud/callback`, state: nonce });
    return Response.redirect(`https://github.com/login/oauth/authorize?${params}`, 302);
  }

  if (path === '/cloud/callback') {
    const code = url.searchParams.get('code'), state = url.searchParams.get('state');
    if (!code || !state || !(await env.KILN.get(`cstate:${state}`))) return json({ error: 'bad oauth state' }, 400);
    await env.KILN.delete(`cstate:${state}`);
    const c = await creds(env);
    const tokRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: c.client_id, client_secret: c.client_secret, code }),
    });
    const tok = await tokRes.json();
    const user = tok.access_token ? await ghUser(tok.access_token) : null;
    if (!user) return json({ error: 'github sign-in failed' }, 401);
    const account = await upsertAccount(env, user.login, user.email);
    const sid = uuid();
    // Keep the user's OAuth token server-side (never sent to the browser) so
    // /cloud/sites can verify the signer actually has push on the repo they're
    // registering — installation-existence is not authorization.
    // `uid` is GitHub's numeric user id: unlike the login, it cannot be
    // renamed away or registered by someone else later.
    await env.KILN.put(`csess:${sid}`, JSON.stringify({ account_id: account.id, login: user.login, uid: user.id ?? null, gh: tok.access_token || null }), { expirationTtl: 30 * 24 * 3600 });
    return Response.redirect(`${dash}#kc_token=${sid}`, 302);   // dashboard reads + stores this
  }

  // Everything below needs a dashboard session (Authorization: Bearer <token>).
  const sess = await session(request, env);

  if (path === '/cloud/logout' && request.method === 'POST') {
    const sid = bearer(request);
    if (sid) await env.KILN.delete(`csess:${sid}`);
    return json({ ok: true });
  }

  if (path === '/cloud/me') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    const account = await env.kiln_cloud.prepare('SELECT id, github_login, email, ls_customer_id FROM accounts WHERE id = ?').bind(sess.account_id).first();
    const sites = await withAccessUntil(
      () => env.kiln_cloud.prepare('SELECT id, repo, origin, plan, status, access_until, created_at FROM sites WHERE account_id = ? ORDER BY created_at DESC').bind(sess.account_id).all(),
      () => env.kiln_cloud.prepare('SELECT id, repo, origin, plan, status, created_at FROM sites WHERE account_id = ? ORDER BY created_at DESC').bind(sess.account_id).all(),
    );
    // `editable` is the worker's own answer, so the dashboard never has to
    // work out for itself what a status plus a date means.
    const now = Date.now();
    const rows = (sites.results || []).map(r => ({ ...r, editable: siteHasAccess(r, now) }));
    return json({ account, sites: rows, billing: lsConfigured(env) });
  }

  if (path === '/cloud/sites' && request.method === 'POST') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    const { repo, origin, plan } = await request.json().catch(() => ({}));
    if (!repo || !origin) return json({ error: 'repo and origin required' }, 400);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: 'repo must be owner/name' }, 400);
    let o; try { o = new URL(origin).origin; } catch { return json({ error: 'origin must be a URL' }, 400); }
    // Ownership: the signer must actually own/push this repo. Installation
    // existence is NOT authorization. A repo under the signer's own account
    // (owner === their login) is theirs by definition; otherwise (an org repo)
    // verify push via their token. The owner-match first means an expired user
    // token can't wrongly block someone registering their own personal repo.
    const owner = repo.split('/')[0].toLowerCase();
    const ownsIt = owner === String(sess.login || '').toLowerCase() || await userCanPush(sess.gh, repo);
    if (!ownsIt) {
      return json({ error: 'you need push access to this repo to register it' }, 403);
    }
    if (!(await repoInstalled(env, repo))) {
      return json({ error: 'install the Kiln app on this repo first', install_url: 'https://github.com/apps/kiln-cms/installations/new' }, 409);
    }
    const dupe = await env.kiln_cloud.prepare('SELECT id FROM sites WHERE origin = ?').bind(o).first();
    if (dupe) return json({ error: 'that site is already registered' }, 409);
    // Anti-abuse: the 7-day self-serve trial clock is anchored to the FIRST time
    // this origin was ever registered, so removing + re-adding a site can't farm
    // a fresh trial indefinitely. (First registration records the timestamp.)
    const firstSeenKey = `firstseen:${o}`;
    let createdAt = Date.now();
    const prior = await env.KILN.get(firstSeenKey);
    if (prior) createdAt = Number(prior) || createdAt;
    else await env.KILN.put(firstSeenKey, String(createdAt));   // no TTL — permanent trial marker
    const site = { id: uuid(), account_id: sess.account_id, repo, origin: o, plan: plan === 'managed' ? 'managed' : 'cloud', status: 'trialing', created_at: createdAt };
    await env.kiln_cloud.prepare('INSERT INTO sites (id, account_id, repo, origin, plan, status, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(site.id, site.account_id, site.repo, site.origin, site.plan, site.status, site.created_at).run();
    const checkout = await lsCheckout(env, site);
    return json({ ok: true, site, checkout });   // checkout null until LS is configured
  }

  if (path === '/cloud/sites/remove' && request.method === 'POST') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    const { id } = await request.json().catch(() => ({}));
    const site = await env.kiln_cloud.prepare('SELECT id, ls_subscription_id FROM sites WHERE id = ? AND account_id = ?').bind(id || '', sess.account_id).first();
    if (!site) return json({ ok: true });   // not theirs, or already gone
    // Removing the site removes Manage billing with it, so the subscription
    // is cancelled first, and the site stays if that cannot be confirmed.
    const cancel = await lsCancel(env, site.ls_subscription_id);
    if (!cancel.ok) return json({ error: NOT_CANCELLED, code: 'subscription_not_cancelled', reason: cancel.state }, 502);
    await env.kiln_cloud.prepare('DELETE FROM sites WHERE id = ? AND account_id = ?').bind(site.id, sess.account_id).run();
    return json({ ok: true, subscription: cancel.state, ...(cancel.ends_at ? { ends_at: cancel.ends_at } : {}) });
  }

  if (path === '/cloud/portal') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    const site = await env.kiln_cloud.prepare('SELECT ls_subscription_id FROM sites WHERE id = ? AND account_id = ?').bind(url.searchParams.get('site'), sess.account_id).first();
    const portal = site ? await lsPortal(env, site.ls_subscription_id) : null;
    return portal ? json({ url: portal }) : json({ error: 'no billing portal yet' }, 404);
  }

  // Fresh checkout link for a site that has no live subscription yet (trial,
  // abandoned checkout, or canceled) — so a customer can pay without having to
  // remove and re-add the site (which would re-anchor their trial clock).
  if (path === '/cloud/checkout') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    const site = await env.kiln_cloud.prepare('SELECT * FROM sites WHERE id = ? AND account_id = ?').bind(url.searchParams.get('site'), sess.account_id).first();
    if (!site) return json({ error: 'no such site' }, 404);
    if (site.ls_subscription_id) return json({ error: 'already subscribed — use Manage billing' }, 409);
    const checkout = await lsCheckout(env, site);
    return checkout ? json({ url: checkout }) : json({ error: 'billing not configured' }, 503);
  }

  // Lemon Squeezy webhook — the ONLY thing that flips a site to active.
  if (path === '/cloud/webhook/ls' && request.method === 'POST') {
    const bodyText = await request.text();
    if (!(await verifyLsSignature(request, bodyText, env))) return json({ error: 'bad signature' }, 401);
    const evt = JSON.parse(bodyText);
    // Act ONLY on subscription lifecycle events. Order/invoice events
    // (order_created, subscription_payment_success) carry status "paid", which
    // is not a subscription status — mapping it would wrongly flip a paying site
    // to past_due on its first purchase and every renewal, and would store an
    // order id in ls_subscription_id (breaking the portal lookup).
    const eventName = evt?.meta?.event_name || '';
    const isSubscription = eventName.startsWith('subscription_')
      && !eventName.startsWith('subscription_payment_')
      && evt?.data?.type === 'subscriptions';
    if (!isSubscription) return json({ ok: true, ignored: eventName || 'non-subscription' });

    const siteId = evt?.meta?.custom_data?.site_id;
    const subId = evt?.data?.id;   // a real subscription id, given the guard above
    const lsStatus = evt?.data?.attributes?.status;
    // Ignore unknown statuses rather than downgrading a paying site to past_due.
    const state = Object.prototype.hasOwnProperty.call(LS_STATE, lsStatus) ? LS_STATE[lsStatus] : null;
    if (!state) return json({ ok: true, ignored: `unknown status ${lsStatus}` });
    const status = state.status;
    const attrs = evt.data.attributes;
    const ms = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : null; };
    // Cancelled: paid up to ends_at. A grace runs from the event's own time, so
    // a delivery that arrives late, or again, cannot stretch it.
    const until = state.access === 'until' ? ms(attrs.ends_at)
      : state.access === 'grace' ? (ms(attrs.updated_at) ?? Date.now()) + PAST_DUE_GRACE_DAYS * 86400 * 1000
      : null;
    // A site already in its grace keeps the date it was given: a second failed
    // charge (past_due → unpaid) does not start the seven days again.
    const setUntil = state.access === 'grace'
      ? "access_until = CASE WHEN status = 'past_due' AND access_until IS NOT NULL THEN access_until ELSE ? END"
      : 'access_until = ?';
    // Replay guard: a captured valid delivery could otherwise be re-POSTed to
    // flip a re-subscribed customer back to canceled. Dedupe on a stable id
    // (updated_at makes the same subscription's DISTINCT transitions unique,
    // while a byte-identical replay is rejected).
    const evtKey = `lsevt:${subId || siteId}:${evt?.data?.attributes?.updated_at || ''}:${lsStatus}`;
    if (await env.KILN.get(evtKey)) return json({ ok: true, replayed: true });
    // Apply the state change FIRST, then record the dedupe key — otherwise a D1
    // failure would leave the key set and silently drop LS's retry of this event.
    if (siteId) {
      await withAccessUntil(
        () => env.kiln_cloud.prepare(`UPDATE sites SET ${setUntil}, status = ?, ls_subscription_id = ? WHERE id = ?`).bind(until, status, subId || null, siteId).run(),
        () => env.kiln_cloud.prepare('UPDATE sites SET status = ?, ls_subscription_id = ? WHERE id = ?').bind(status, subId || null, siteId).run(),
      );
    } else if (subId) {
      await withAccessUntil(
        () => env.kiln_cloud.prepare(`UPDATE sites SET ${setUntil}, status = ? WHERE ls_subscription_id = ?`).bind(until, status, subId).run(),
        () => env.kiln_cloud.prepare('UPDATE sites SET status = ? WHERE ls_subscription_id = ?').bind(status, subId).run(),
      );
    }
    await env.KILN.put(evtKey, '1', { expirationTtl: 7 * 24 * 3600 });
    return json({ ok: true });
  }

  // ── Admin (owner only) ──
  if (path.startsWith('/admin/cloud/')) {
    if (!isCloudAdmin(sess, env)) return json({ error: 'forbidden' }, 403);
    // The operator's playbook — served ONLY to the authenticated super-admin, so
    // the ops details never sit in public HTML. The dashboard opens it in a tab.
    if (path === '/admin/cloud/runbook') {
      return new Response(RUNBOOK_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } });
    }
    if (path === '/admin/cloud/overview') {
      const accounts = await env.kiln_cloud.prepare('SELECT COUNT(*) n FROM accounts').first();
      const sites = await env.kiln_cloud.prepare('SELECT s.*, a.github_login, a.email FROM sites s JOIN accounts a ON a.id = s.account_id ORDER BY s.created_at DESC').all();
      const rows = sites.results || [];
      const active = rows.filter(s => s.status === 'active');
      const price = (p) => p === 'managed' ? 14.99 : 4.99;
      const mrr = active.reduce((m, s) => m + price(s.plan), 0);
      const store = await lsStoreMode(env);
      const insights = buildInsights(rows, accounts.n, price);
      return json({ accounts: accounts.n, sites: rows, active: active.length, mrr: Number(mrr.toFixed(2)), store, insights });
    }
    if (path === '/admin/cloud/grant' && request.method === 'POST') {
      const { site_id, status } = await request.json().catch(() => ({}));
      if (!['active', 'trialing', 'past_due', 'canceled'].includes(status)) return json({ error: 'bad status' }, 400);
      // The operator's word is final: no leftover date keeps a site open (or shut).
      await withAccessUntil(
        () => env.kiln_cloud.prepare('UPDATE sites SET status = ?, access_until = NULL WHERE id = ?').bind(status, site_id).run(),
        () => env.kiln_cloud.prepare('UPDATE sites SET status = ? WHERE id = ?').bind(status, site_id).run(),
      );
      return json({ ok: true });
    }
    if (path === '/admin/cloud/remove' && request.method === 'POST') {
      const { site_id, force } = await request.json().catch(() => ({}));
      const site = await env.kiln_cloud.prepare('SELECT id, ls_subscription_id FROM sites WHERE id = ?').bind(site_id || '').first();
      if (!site) return json({ ok: true });
      // Same rule as the customer's own Remove. `force` is for the operator who
      // has already ended the subscription in Lemon Squeezy by hand.
      const cancel = force ? { ok: true, state: 'forced' } : await lsCancel(env, site.ls_subscription_id);
      if (!cancel.ok) {
        return json({ error: `subscription ${site.ls_subscription_id} could not be cancelled (${cancel.state}); cancel it in Lemon Squeezy, then remove with force`, code: 'subscription_not_cancelled', reason: cancel.state }, 502);
      }
      await env.kiln_cloud.prepare('DELETE FROM sites WHERE id = ?').bind(site.id).run();
      return json({ ok: true, subscription: cancel.state });
    }
    // Per-site troubleshooting: app-install check, live-site reachability, /kiln
    // entry check, editability (is the origin actually in the active/trialing
    // allowlist), and live Lemon Squeezy subscription status.
    if (path === '/admin/cloud/diagnose') {
      const id = url.searchParams.get('site');
      const site = await env.kiln_cloud.prepare('SELECT s.*, a.github_login, a.email FROM sites s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?').bind(id).first();
      if (!site) return json({ error: 'not found' }, 404);
      const checks = [];
      const add = (name, ok, detail) => checks.push({ name, ok, detail });

      const installed = await repoInstalled(env, site.repo);
      add('GitHub App installed on repo', installed,
        installed ? `kiln-cms is installed on ${site.repo}` : `Not installed — customer must add it at github.com/apps/kiln-cms`);

      const until = Number(site.access_until) ? ` and access runs until ${new Date(Number(site.access_until)).toISOString().slice(0, 10)}` : '';
      add('Site editable (allowlisted)', siteHasAccess(site),
        `Status is "${site.status}"${until} — editing is on for active and trialing sites, to the end of the paid period after a cancellation, and for ${PAST_DUE_GRACE_DAYS} days after a failed payment`);

      let reachable = false, reachDetail = 'no response';
      try {
        const r = await fetch(site.origin, { method: 'HEAD', redirect: 'manual' });
        reachable = r.status < 500;
        reachDetail = `HTTP ${r.status}`;
      } catch (e) { reachDetail = String(e.message || e); }
      add('Live site reachable', reachable, `${site.origin} → ${reachDetail}`);

      let kilnEntry = false, entryDetail = 'not found';
      try {
        const r = await fetch(site.origin.replace(/\/$/, '') + '/kiln', { method: 'HEAD' });
        kilnEntry = r.ok;
        entryDetail = `HTTP ${r.status}`;
      } catch (e) { entryDetail = String(e.message || e); }
      add('/kiln sign-in page present', kilnEntry, `${site.origin}/kiln → ${entryDetail}`);

      if (site.ls_subscription_id) {
        try {
          const r = await fetch(`${LS}/subscriptions/${site.ls_subscription_id}`,
            { headers: { Authorization: `Bearer ${env.LS_API_KEY}`, Accept: 'application/vnd.api+json' } });
          const d = r.ok ? await r.json() : null;
          const st = d?.data?.attributes?.status;
          add('Lemon Squeezy subscription', st === 'active' || st === 'on_trial', `LS status: ${st || 'unknown'}`);
        } catch (e) { add('Lemon Squeezy subscription', false, String(e.message || e)); }
      } else {
        add('Lemon Squeezy subscription', false, 'No subscription yet (trial or comped)');
      }
      return json({ site, checks });
    }
  }

  return null;  // not a cloud route
}

/** Revenue + lifecycle breakdowns computed from the sites table (no history table needed). */
function buildInsights(rows, accountCount, price) {
  const byStatus = { active: 0, trialing: 0, past_due: 0, canceled: 0 };
  const byPlan = { cloud: 0, managed: 0 };
  let mrrCloud = 0, mrrManaged = 0;
  const now = Date.now();
  const day = 86400 * 1000;
  let signups30 = 0, signups7 = 0;
  const trialsExpiring = [];
  for (const s of rows) {
    if (byStatus[s.status] !== undefined) byStatus[s.status]++;
    if (byPlan[s.plan] !== undefined) byPlan[s.plan]++;
    if (s.status === 'active') { if (s.plan === 'managed') mrrManaged += price('managed'); else mrrCloud += price('cloud'); }
    if (now - s.created_at < 30 * day) signups30++;
    if (now - s.created_at < 7 * day) signups7++;
    // Self-serve trials (no LS subscription) auto-expire 7 days after creation.
    if (s.status === 'trialing' && !s.ls_subscription_id) {
      const daysLeft = Math.ceil((s.created_at + 7 * day - now) / day);
      trialsExpiring.push({ id: s.id, repo: s.repo, github_login: s.github_login, daysLeft });
    }
  }
  const paying = byStatus.active;
  const everConverted = paying + byStatus.past_due + byStatus.canceled; // rough denominator
  const conversion = everConverted ? Math.round((paying / everConverted) * 100) : null;
  return {
    byStatus, byPlan,
    mrrCloud: Number(mrrCloud.toFixed(2)), mrrManaged: Number(mrrManaged.toFixed(2)),
    arr: Number(((mrrCloud + mrrManaged) * 12).toFixed(2)),
    signups30, signups7,
    trialsExpiring: trialsExpiring.sort((a, b) => a.daysLeft - b.daysLeft),
    conversion,
  };
}
