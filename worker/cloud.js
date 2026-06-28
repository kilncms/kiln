/**
 * Kiln Cloud — the hosted tier on top of the kiln-auth worker.
 *
 * Routes (all behind handleCloud):
 *   GET  /cloud/login            → GitHub OAuth (identity only)
 *   GET  /cloud/callback         → upsert account, set session cookie, → dashboard
 *   GET  /cloud/me               → { account, sites }
 *   POST /cloud/sites            → register a site (verify repo install) → checkout URL
 *   POST /cloud/sites/remove     → delete a site
 *   GET  /cloud/portal?site=     → Lemon Squeezy customer-portal link
 *   POST /cloud/webhook/ls       → Lemon Squeezy webhook (signed) → set site status
 *   GET  /admin/cloud/overview   → (owner only) accounts, sites, MRR
 *   POST /admin/cloud/grant      → (owner only) manually set a site's status
 *
 * Storage: D1 `kiln_cloud` (accounts, sites). KV `csess:<id>` for dashboard sessions.
 * Billing degrades gracefully: with no LS_* secrets, sites register as `trialing` and
 * checkout/portal report "billing not configured" until you add your Lemon Squeezy keys.
 */

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

const LS_STATUS = { active: 'active', on_trial: 'trialing', past_due: 'past_due', unpaid: 'past_due', cancelled: 'canceled', expired: 'canceled', paused: 'past_due' };

// Cron housekeeping: a site registers as `trialing` immediately so the owner can set up
// and preview before paying — but that grace can't be open-ended, or a site could edit
// forever without ever subscribing. Expire `trialing` sites that never started a Lemon
// Squeezy subscription once they pass the grace window; that drops them from the editable
// allowlist (originAllowed only permits active/trialing). Real LS trials carry an
// ls_subscription_id and are untouched — their lifecycle is driven entirely by webhooks.
const TRIAL_GRACE_DAYS = 7;
export async function expireStaleTrials(env) {
  if (!env.kiln_cloud) return;
  const cutoff = Date.now() - TRIAL_GRACE_DAYS * 86400 * 1000;
  await env.kiln_cloud.prepare(
    "UPDATE sites SET status = 'canceled' WHERE status = 'trialing' AND ls_subscription_id IS NULL AND created_at < ?"
  ).bind(cutoff).run();
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
    await env.KILN.put(`csess:${sid}`, JSON.stringify({ account_id: account.id, login: user.login }), { expirationTtl: 30 * 24 * 3600 });
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
    const sites = await env.kiln_cloud.prepare('SELECT id, repo, origin, plan, status, created_at FROM sites WHERE account_id = ? ORDER BY created_at DESC').bind(sess.account_id).all();
    return json({ account, sites: sites.results || [], billing: lsConfigured(env) });
  }

  if (path === '/cloud/sites' && request.method === 'POST') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    const { repo, origin, plan } = await request.json().catch(() => ({}));
    if (!repo || !origin) return json({ error: 'repo and origin required' }, 400);
    let o; try { o = new URL(origin).origin; } catch { return json({ error: 'origin must be a URL' }, 400); }
    if (!(await repoInstalled(env, repo))) {
      return json({ error: 'install the Kiln app on this repo first', install_url: 'https://github.com/apps/kiln-cms/installations/new' }, 409);
    }
    const dupe = await env.kiln_cloud.prepare('SELECT id FROM sites WHERE origin = ?').bind(o).first();
    if (dupe) return json({ error: 'that site is already registered' }, 409);
    const site = { id: uuid(), account_id: sess.account_id, repo, origin: o, plan: plan === 'managed' ? 'managed' : 'cloud', status: 'trialing', created_at: Date.now() };
    await env.kiln_cloud.prepare('INSERT INTO sites (id, account_id, repo, origin, plan, status, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(site.id, site.account_id, site.repo, site.origin, site.plan, site.status, site.created_at).run();
    const checkout = await lsCheckout(env, site);
    return json({ ok: true, site, checkout });   // checkout null until LS is configured
  }

  if (path === '/cloud/sites/remove' && request.method === 'POST') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    const { id } = await request.json().catch(() => ({}));
    await env.kiln_cloud.prepare('DELETE FROM sites WHERE id = ? AND account_id = ?').bind(id, sess.account_id).run();
    return json({ ok: true });
  }

  if (path === '/cloud/portal') {
    if (!sess) return json({ error: 'not signed in' }, 401);
    const site = await env.kiln_cloud.prepare('SELECT ls_subscription_id FROM sites WHERE id = ? AND account_id = ?').bind(url.searchParams.get('site'), sess.account_id).first();
    const portal = site ? await lsPortal(env, site.ls_subscription_id) : null;
    return portal ? json({ url: portal }) : json({ error: 'no billing portal yet' }, 404);
  }

  // Lemon Squeezy webhook — the ONLY thing that flips a site to active.
  if (path === '/cloud/webhook/ls' && request.method === 'POST') {
    const bodyText = await request.text();
    if (!(await verifyLsSignature(request, bodyText, env))) return json({ error: 'bad signature' }, 401);
    const evt = JSON.parse(bodyText);
    const siteId = evt?.meta?.custom_data?.site_id;
    const subId = evt?.data?.id;
    const lsStatus = evt?.data?.attributes?.status;
    const status = LS_STATUS[lsStatus] || 'past_due';
    if (siteId) {
      await env.kiln_cloud.prepare('UPDATE sites SET status = ?, ls_subscription_id = ? WHERE id = ?').bind(status, subId || null, siteId).run();
    } else if (subId) {
      await env.kiln_cloud.prepare('UPDATE sites SET status = ? WHERE ls_subscription_id = ?').bind(status, subId).run();
    }
    return json({ ok: true });
  }

  // ── Admin (owner only) ──
  if (path.startsWith('/admin/cloud/')) {
    if (!sess || sess.login !== (env.CLOUD_ADMIN || '')) return json({ error: 'forbidden' }, 403);
    if (path === '/admin/cloud/overview') {
      const accounts = await env.kiln_cloud.prepare('SELECT COUNT(*) n FROM accounts').first();
      const sites = await env.kiln_cloud.prepare('SELECT s.*, a.github_login FROM sites s JOIN accounts a ON a.id = s.account_id ORDER BY s.created_at DESC').all();
      const active = (sites.results || []).filter(s => s.status === 'active');
      const mrr = active.reduce((m, s) => m + (s.plan === 'managed' ? 14.99 : 4.99), 0);
      const store = await lsStoreMode(env);
      return json({ accounts: accounts.n, sites: sites.results || [], active: active.length, mrr: Number(mrr.toFixed(2)), store });
    }
    if (path === '/admin/cloud/grant' && request.method === 'POST') {
      const { site_id, status } = await request.json().catch(() => ({}));
      await env.kiln_cloud.prepare('UPDATE sites SET status = ? WHERE id = ?').bind(status || 'active', site_id).run();
      return json({ ok: true });
    }
  }

  return null;  // not a cloud route
}
