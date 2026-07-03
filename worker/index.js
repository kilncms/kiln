/**
 * kiln-auth — the one tiny server Kiln needs.
 *
 * What it does:
 *   1. One-time setup: registers Kiln as a GitHub App via the manifest flow
 *      (you click one button; credentials land in KV automatically).
 *   2. GitHub App OAuth for admins (single-repo scope, 8-hour expiring tokens,
 *      refresh tokens held server-side in KV — never shipped to the browser).
 *   3. Invited editors & members: the owner adds people by email in People &
 *      access; they sign in with Google and commit through the /gh/* proxy using
 *      the App's installation token, scoped to the paths granted to them. No
 *      GitHub account needed.
 *
 * Routes:
 *   GET  /setup            one-time GitHub App registration page
 *   GET  /setup/callback   manifest conversion (GitHub redirects here)
 *   GET  /setup/status     {configured, slug, app_id}
 *   GET  /auth/login       ?origin=&return_to= → GitHub authorize
 *   GET  /auth/callback    code+state → tokens → redirect w/ #fragment
 *   POST /auth/refresh     {sid} → fresh access token
 *   POST /auth/logout      {sid}
 *   GET/POST /admin/people People allowlist (push-verified): add/remove editors & members
 *   GET  /google/login     ?origin=&return_to=&repo= → Google authorize (invited people)
 *   POST /google/claim     {code} → member session exchange
 *   ANY  /gh/*             session + path-scoped GitHub API proxy (editors)
 *
 * KV (binding: KILN):
 *   app:creds   {app_id, slug, client_id, client_secret, pk8}
 *   state:<n>   OAuth state nonce            (TTL 10 min)
 *   sid:<id>    {refresh_token}              (TTL 180 days, rotated)
 *   people:<repo> [{email,name,role,days,paths?}]  editor/member allowlist
 *   esess:<id>  {repo,name,role,email,paths}  (TTL = person.days)
 *   itok:<repo> cached installation token    (TTL 50 min)
 *
 * Env vars: ALLOWED_ORIGINS — comma-separated site origins allowed to use auth.
 */

const GH = 'https://api.github.com';
const UA = 'kiln-auth-worker';

import { handleCloud, expireStaleTrials } from './cloud.js';
import { applyEdits } from '../src/engine.js';

// UTF-8-safe base64 (GitHub content is base64; edits re-applied at cron time).
function utf8FromB64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function b64FromUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export default {
  async scheduled(_event, env) {
    await runDueSchedules(env);
    await expireStaleTrials(env);
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === 'OPTIONS') return await cors(env, request, new Response(null, { status: 204 }));
      if (path.startsWith('/cloud/') || path.startsWith('/admin/cloud/')) {
        const r = await handleCloud(request, env, url, path);
        if (r) return await cors(env, request, r);
      }

      if (path === '/healthz') return new Response('ok');
      if (path === '/setup') return setupPage(url, env);
      if (path === '/setup/callback') return setupCallback(url, env);
      if (path === '/setup/status') return setupStatus(env);
      if (path === '/setup/install-check') {
        const limited = await rateLimited(request, env);
        if (limited) return limited;
        const repo = url.searchParams.get('repo') || '';
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: 'bad repo' }, 400);
        const tok = await installationToken(env, repo);
        return json({ repo, installed: !!tok });
      }
      if (path === '/auth/login') return authLogin(url, env);
      if (path === '/auth/callback') return authCallback(url, env);
      if (path === '/auth/refresh' && request.method === 'POST') return await cors(env, request, await authRefresh(request, env));
      if (path === '/auth/logout' && request.method === 'POST') return await cors(env, request, await authLogout(request, env));
      if (path === '/admin/people' && request.method === 'GET') return await cors(env, request, await peopleList(request, env, url));
      if (path === '/admin/people' && request.method === 'POST') return await cors(env, request, await peopleUpsert(request, env));
      if (path === '/admin/people/remove' && request.method === 'POST') return await cors(env, request, await peopleRemove(request, env));
      if (path === '/schedule' && request.method === 'POST') return await cors(env, request, await scheduleCreate(request, env));
      if (path === '/schedules' && request.method === 'GET') return await cors(env, request, await scheduleList(request, env, url));
      if (path === '/schedule/cancel' && request.method === 'POST') return await cors(env, request, await scheduleCancel(request, env));
      if (path === '/presence' && request.method === 'POST') return await cors(env, request, await presencePing(request, env));
      if (path === '/google/login') return (await rateLimited(request, env)) || googleLogin(url, env);
      if (path === '/google/callback') return googleCallback(url, env);
      if (path === '/google/claim' && request.method === 'POST') return (await rateLimited(request, env)) || googleClaim(request, env);
      // The commit proxy runs on the shared App installation token — throttle it
      // (per IP) so one editor can't exhaust the owner's GitHub quota and DoS
      // everyone else's editing. No-op unless the RL binding is configured.
      if (path.startsWith('/gh/')) return (await rateLimited(request, env)) || await cors(env, request, await ghProxy(request, env, path.slice(3) + url.search));

      return new Response('kiln-auth: not found', { status: 404 });
    } catch (err) {
      console.error('[kiln-auth]', err.stack || err);
      return await cors(env, request, json({ error: 'internal', message: String(err.message || err) }, 500));
    }
  },
};

// ─── CORS ────────────────────────────────────────────────────────────────────

async function originAllowed(env, origin) {
  if (!origin) return false;
  const envList = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (envList.includes(origin)) return true;          // static: demo, self-host, localhost
  if (env.kiln_cloud) {                               // Kiln Cloud: a paid (or trialing) site
    try {
      const row = await env.kiln_cloud.prepare(
        "SELECT 1 FROM sites WHERE origin = ? AND status IN ('active','trialing') LIMIT 1"
      ).bind(origin).first();
      if (row) return true;
    } catch (e) { /* fail-safe: if D1 is unreachable, fall back to the static list */ }
  }
  return false;
}

async function cors(env, request, response) {
  const origin = request.headers.get('Origin');
  const ok = await originAllowed(env, origin);
  const h = new Headers(response.headers);
  if (ok) {
    h.set('Access-Control-Allow-Origin', origin);
    h.set('Vary', 'Origin');
    h.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
    h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Kiln-Session');
    h.set('Access-Control-Max-Age', '86400');
  }
  return new Response(response.body, { status: response.status, headers: h });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

// ─── Rate limiting (graceful) ────────────────────────────────────────────────
// No-op unless the optional [[unsafe.bindings]] ratelimit binding `RL` is
// configured (see wrangler.toml). Keyed by client IP. Returns a CORS-wrapped
// 429 when over the limit, or null to continue.
async function rateLimited(request, env) {
  if (!env.RL) return null;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.RL.limit({ key: ip });
  if (success) return null;
  return await cors(env, request, json({ error: 'rate limited, slow down' }, 429));
}

// ─── One-time GitHub App setup (manifest flow) ──────────────────────────────

async function setupPage(url, env) {
  const existing = await env.KILN.get('app:creds', 'json');
  if (existing) {
    return html(`
      <h1>Kiln is already configured ✓</h1>
      <p>GitHub App: <strong>${esc(existing.slug)}</strong> (id ${existing.app_id})</p>
      <p><a class="btn" href="https://github.com/apps/${esc(existing.slug)}/installations/new">Install / manage on your repos →</a></p>`);
  }
  const manifest = {
    name: 'Kiln CMS',
    url: 'https://kilncms.com',
    redirect_url: `${url.origin}/setup/callback`,
    callback_urls: [`${url.origin}/auth/callback`],
    public: false,
    request_oauth_on_install: false,
    default_permissions: { contents: 'write', metadata: 'read', deployments: 'read', statuses: 'read' },
    default_events: [],
  };
  return html(`
    <h1>Set up Kiln's GitHub App</h1>
    <p>This registers <strong>Kiln CMS</strong> as a GitHub App under your account.
       Everything is pre-filled — GitHub will show you a confirmation page with one green button.</p>
    <p>If the name "Kiln CMS" is taken, just edit the name on GitHub's page before confirming.</p>
    <form action="https://github.com/settings/apps/new" method="post">
      <input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}">
      <button class="btn" type="submit">Create the Kiln GitHub App →</button>
    </form>
    <p class="dim">After you confirm, GitHub sends you straight back here and the credentials
       are captured automatically. You never copy a secret.</p>`);
}

async function setupCallback(url, env) {
  const code = url.searchParams.get('code');
  if (!code) return html('<h1>Missing code</h1><p>Start again at <a href="/setup">/setup</a>.</p>', 400);
  const existing = await env.KILN.get('app:creds', 'json');
  if (existing) return Response.redirect(`${url.origin}/setup`, 302);

  const res = await fetch(`${GH}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA },
  });
  if (!res.ok) {
    const body = await res.text();
    return html(`<h1>GitHub rejected the conversion (${res.status})</h1><pre>${esc(body)}</pre>
      <p>The code may have expired (1 hour limit). <a href="/setup">Try again</a>.</p>`, 502);
  }
  const app = await res.json();
  const pk8 = bufToB64(pkcs1PemToPkcs8Der(app.pem));
  await env.KILN.put('app:creds', JSON.stringify({
    app_id: app.id,
    slug: app.slug,
    client_id: app.client_id,
    client_secret: app.client_secret,
    pk8,
  }));
  return html(`
    <h1>Kiln GitHub App created ✓</h1>
    <p>App <strong>${esc(app.slug)}</strong> (id ${app.id}) is registered and its credentials are stored.</p>
    <h2>Last step: install it on your site's repo</h2>
    <p><a class="btn" href="https://github.com/apps/${esc(app.slug)}/installations/new">Install on a repository →</a></p>
    <p class="dim">Pick "Only select repositories" and choose your site repo. That's the whole point:
       Kiln only ever touches the repos you explicitly select.</p>`);
}

async function setupStatus(env) {
  const creds = await env.KILN.get('app:creds', 'json');
  return json(creds
    ? { configured: true, slug: creds.slug, app_id: creds.app_id, client_id: creds.client_id }
    : { configured: false });
}

// ─── Admin OAuth (GitHub App user flow) ──────────────────────────────────────

async function authLogin(url, env) {
  const creds = await env.KILN.get('app:creds', 'json');
  if (!creds) return html('<h1>Kiln is not set up yet</h1><p>Visit <a href="/setup">/setup</a> first.</p>', 503);

  const origin = url.searchParams.get('origin') || '';
  const returnTo = url.searchParams.get('return_to') || '/';
  if (!(await originAllowed(env, origin))) {
    return html(`<h1>Origin not allowed</h1><p><code>${esc(origin)}</code> is not in this worker's ALLOWED_ORIGINS.</p>`, 403);
  }
  if (!returnTo.startsWith('/')) return html('<h1>Bad return_to</h1>', 400);

  const nonce = crypto.randomUUID();
  await env.KILN.put(`state:${nonce}`, JSON.stringify({ origin, returnTo }), { expirationTtl: 600 });

  const params = new URLSearchParams({
    client_id: creds.client_id,
    redirect_uri: `${url.origin}/auth/callback`,
    state: nonce,
  });
  return Response.redirect(`https://github.com/login/oauth/authorize?${params}`, 302);
}

async function authCallback(url, env) {
  const code = url.searchParams.get('code');
  const nonce = url.searchParams.get('state');
  if (!code || !nonce) return html('<h1>Missing code/state</h1>', 400);

  const stateKey = `state:${nonce}`;
  const state = await env.KILN.get(stateKey, 'json');
  if (!state) return html('<h1>Login expired or replayed</h1><p>Go back to your site and try again.</p>', 400);
  await env.KILN.delete(stateKey); // single use

  const creds = await env.KILN.get('app:creds', 'json');
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ client_id: creds.client_id, client_secret: creds.client_secret, code }),
  });
  const tok = await res.json();
  if (tok.error || !tok.access_token) {
    return html(`<h1>GitHub OAuth error</h1><pre>${esc(tok.error_description || JSON.stringify(tok))}</pre>`, 400);
  }

  const frag = new URLSearchParams({ 'kiln-token': tok.access_token });
  if (tok.expires_in) frag.set('kiln-exp', String(Date.now() + tok.expires_in * 1000));
  if (tok.refresh_token) {
    const sid = crypto.randomUUID();
    await env.KILN.put(`sid:${sid}`, JSON.stringify({ refresh_token: tok.refresh_token }),
      { expirationTtl: 180 * 24 * 3600 });
    frag.set('kiln-sid', sid);
  }
  return Response.redirect(`${state.origin}${state.returnTo}#${frag}`, 302);
}

async function authRefresh(request, env) {
  const { sid } = await request.json().catch(() => ({}));
  if (!sid) return json({ error: 'missing sid' }, 400);
  const sess = await env.KILN.get(`sid:${sid}`, 'json');
  if (!sess) return json({ error: 'unknown session' }, 401);

  const creds = await env.KILN.get('app:creds', 'json');
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      grant_type: 'refresh_token',
      refresh_token: sess.refresh_token,
    }),
  });
  const tok = await res.json();
  if (tok.error || !tok.access_token) {
    await env.KILN.delete(`sid:${sid}`);
    return json({ error: 'refresh_failed', detail: tok.error_description || tok.error }, 401);
  }
  if (tok.refresh_token) {
    await env.KILN.put(`sid:${sid}`, JSON.stringify({ refresh_token: tok.refresh_token }),
      { expirationTtl: 180 * 24 * 3600 });
  }
  return json({ token: tok.access_token, exp: tok.expires_in ? Date.now() + tok.expires_in * 1000 : null });
}

async function authLogout(request, env) {
  const { sid } = await request.json().catch(() => ({}));
  if (sid) await env.KILN.delete(`sid:${sid}`);
  return json({ ok: true });
}

// ─── Access control ──────────────────────────────────────────────────────────

/** True if the bearer GitHub token has push access to the repo (the site owner). */
async function requirePush(request, repo) {
  const auth = (request.headers.get('Authorization') || '').replace(/^(token|Bearer)\s+/i, '');
  if (!auth || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return false;
  const res = await fetch(`${GH}/repos/${repo}`, {
    headers: { Authorization: `Bearer ${auth}`, Accept: 'application/vnd.github+json', 'User-Agent': UA },
  });
  if (!res.ok) return false;
  const info = await res.json();
  return !!info.permissions?.push;
}

/** Whether a file path is within an editor's granted paths. Empty / '**' = whole site. */
function pathInScope(filePath, paths) {
  const f = String(filePath).replace(/^\/+/, '');
  if (f.split('/').some(s => s === '..' || s === '.')) return false; // traversal is never in scope
  if (!Array.isArray(paths) || paths.length === 0) return true;
  if (paths.some(p => p === '' || p === '**' || p === '*')) return true;
  return paths.some(p => {
    const pre = String(p).replace(/^\/+/, '').replace(/\/+$/, '');
    return !pre || f === pre || f.startsWith(pre + '/');
  });
}

/** Normalize the `paths` field from the People form into a clean prefix array. */
function normalizePaths(paths) {
  let arr = paths;
  if (typeof arr === 'string') arr = arr.split(',');
  if (!Array.isArray(arr)) return [''];
  arr = arr.map(p => String(p).trim().replace(/^\/+/, '').replace(/\/+$/, '')).filter(Boolean).slice(0, 50);
  return arr.length ? arr : [''];
}

// Exported for unit tests (test/worker.test.js); the Workers runtime uses only the default export.
export { pathInScope, isSensitivePath, normalizePaths };

// ─── Scheduled publishing ────────────────────────────────────────────────────
// sched:<id> → { repo, path, branch, content(b64), message, at, desc, by }
// A cron tick commits every due entry using the App installation token.

async function authActor(request, env, repo) {
  // Either an admin's GitHub token (push access) or an editor session for this repo.
  const sess = request.headers.get('X-Kiln-Session');
  if (sess && /^[a-f0-9]{64}$/.test(sess)) {
    const e = await env.KILN.get(`esess:${sess}`, 'json');
    if (e && (!e.exp || e.exp >= Date.now()) && e.repo === repo && e.role === 'editor') return { name: e.name, email: e.email, paths: e.paths || [''], admin: false };
  }
  if (await requirePush(request, repo)) return { name: 'admin', admin: true };
  return null;
}

async function scheduleCreate(request, env) {
  const { repo, path, branch = 'main', edits, content, message, at, desc } = await request.json().catch(() => ({}));
  // Prefer field-level `edits` (re-applied against fresh source at fire time so
  // interim edits aren't clobbered). `content` (a full-page snapshot) is still
  // accepted for backward compatibility but is the lossy path.
  if (!repo || !path || (!edits && !content) || !at) return json({ error: 'missing fields' }, 400);
  if (edits && (!Array.isArray(edits) || edits.length > 500)) return json({ error: 'bad edits' }, 400);
  const actor = await authActor(request, env, repo);
  if (!actor) return json({ error: 'forbidden' }, 403);
  if (!actor.admin && (isSensitivePath(path) || !pathInScope(path, actor.paths))) {
    return json({ error: 'outside your editing scope' }, 403);
  }
  const when = Date.parse(at);
  if (!when || when < Date.now() - 60000 || when > Date.now() + 366 * 24 * 3600 * 1000) {
    return json({ error: 'bad time' }, 400);
  }
  const id = crypto.randomUUID().replaceAll('-', '');
  await env.KILN.put(`sched:${id}`,
    JSON.stringify({ repo, path, branch, edits: edits || null, content: edits ? null : content, message: message || 'Scheduled publish (via Kiln)', at: when, desc: desc || path, by: actor.name, byEmail: actor.email }),
    { expirationTtl: Math.ceil((when - Date.now()) / 1000) + 14 * 24 * 3600 });
  return json({ ok: true, id, at: when });
}

async function scheduleList(request, env, url) {
  const repo = url.searchParams.get('repo') || '';
  const actor = await authActor(request, env, repo);
  if (!actor) return json({ error: 'forbidden' }, 403);
  const out = [];
  let cursor;
  do {
    const page = await env.KILN.list({ prefix: 'sched:', cursor });
    for (const k of page.keys) {
      const v = await env.KILN.get(k.name, 'json');
      if (v && v.repo === repo) out.push({ id: k.name.slice(6), at: v.at, desc: v.desc, path: v.path, by: v.by });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return json({ schedules: out.sort((a, b) => a.at - b.at) });
}

async function scheduleCancel(request, env) {
  const { repo, id } = await request.json().catch(() => ({}));
  const actor = await authActor(request, env, repo);
  if (!actor || !/^[a-f0-9]{32}$/.test(id || '')) return json({ error: 'forbidden' }, 403);
  const v = await env.KILN.get(`sched:${id}`, 'json');
  if (!v || v.repo !== repo) return json({ error: 'not found' }, 404);
  await env.KILN.delete(`sched:${id}`);
  return json({ ok: true });
}

async function runDueSchedules(env) {
  let cursor;
  do {
    const page = await env.KILN.list({ prefix: 'sched:', cursor });
    for (const k of page.keys) {
      const v = await env.KILN.get(k.name, 'json');
      if (!v || v.at > Date.now()) continue;
      try {
        const itok = await installationToken(env, v.repo);
        if (!itok) continue;
        const h = { Authorization: `Bearer ${itok}`, Accept: 'application/vnd.github+json', 'User-Agent': UA, 'Content-Type': 'application/json' };
        const cur = await fetch(`${GH}/repos/${v.repo}/contents/${encodeURIComponent(v.path)}?ref=${v.branch}`, { headers: h });
        const curJson = cur.ok ? await cur.json() : null;
        const sha = curJson ? curJson.sha : undefined;
        // Field-level edits: re-apply against the CURRENT source so anything
        // published in the meantime survives (same merge model as live editing).
        // A raw `content` snapshot is the legacy, lossy path.
        let content = v.content;
        if (v.edits) {
          if (!curJson) continue;   // page vanished — leave the schedule for the next tick
          const source = utf8FromB64(curJson.content);
          const { html } = applyEdits(source, v.edits);
          content = b64FromUtf8(html);
        }
        const res = await fetch(`${GH}/repos/${v.repo}/contents/${encodeURIComponent(v.path)}`, {
          method: 'PUT', headers: h,
          body: JSON.stringify({ message: v.message, content, branch: v.branch, sha,
            author: { name: `${v.by} (via Kiln, scheduled)`, email: 'kiln-editor@users.noreply.github.com' } }),
        });
        if (res.ok || res.status === 409) await env.KILN.delete(k.name);
      } catch (err) {
        console.error('[kiln-cron]', k.name, err);
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

// ─── Presence (who else is editing this page right now) ─────────────────────
// pres:<repo>:<path>:<name> → { name, role, ts }   (TTL 90s; client pings every 30s)
//
// Advisory only: Kiln merges concurrent edits per-field at publish time (see
// editFile's sha-conflict retry), so presence exists to make humans AWARE of
// each other — the editor shows "Susan is also editing this page" and gates
// same-field overwrites behind a confirm at publish.

/** requirePush with a short KV cache — presence pings every 30s, and burning a
 *  GitHub API call per ping per admin adds up. Cache hits only apply here, never
 *  to the people/schedule admin routes. */
async function requirePushCached(request, env, repo) {
  const auth = (request.headers.get('Authorization') || '').replace(/^(token|Bearer)\s+/i, '');
  if (!auth || !repo) return false;
  const digest = bufToB64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${auth}:${repo}`)));
  const cacheKey = `pauth:${digest}`;
  if (await env.KILN.get(cacheKey)) return true;
  if (!(await requirePush(request, repo))) return false;
  await env.KILN.put(cacheKey, '1', { expirationTtl: 300 });
  return true;
}

async function presencePing(request, env) {
  const { repo, path: pagePath, name } = await request.json().catch(() => ({}));
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || typeof pagePath !== 'string' || !pagePath.startsWith('/')) {
    return json({ error: 'bad request' }, 400);
  }
  // Editor session, or admin token (cached push check).
  let who = null, role = null, scope = null;
  const sess = request.headers.get('X-Kiln-Session');
  if (sess && /^[a-f0-9]{64}$/.test(sess)) {
    const e = await env.KILN.get(`esess:${sess}`, 'json');
    if (e && (!e.exp || e.exp >= Date.now()) && e.repo === repo && e.role === 'editor') {
      who = e.name; role = 'editor';
      scope = { paths: e.paths || [''], keys: e.keys || [], features: e.features || null };  // editor UI uses this to gate handles + menu
    }
  }
  if (!who && (await requirePushCached(request, env, repo))) {
    who = String(name || 'Owner').slice(0, 64);
    role = 'owner';
  }
  if (!who) return json({ error: 'forbidden' }, 403);

  // Colons delimit the KV key, so strip them from the (partly client-supplied)
  // name and page before composing pres:<repo>:<page>:<name> — otherwise a
  // crafted value could shadow another user's presence key. The trusted `role`
  // is server-derived above, so display-name spoofing is the whole ceiling here.
  const safe = (s, n) => String(s).replaceAll(':', ' ').slice(0, n);
  const page = safe(pagePath, 200);
  const nameKey = safe(who, 64);
  const myKey = `pres:${repo}:${page}:${nameKey}`;
  // Store the real (unsafened) path so the "who's online" list can show it.
  await env.KILN.put(myKey,
    JSON.stringify({ name: nameKey, role, page: String(pagePath).slice(0, 200), ts: Date.now() }),
    { expirationTtl: 90 });

  // `others` = people on THIS page; `online` = everyone editing the site right now.
  const others = [], online = [];
  const list = await env.KILN.list({ prefix: `pres:${repo}:` });
  for (const k of list.keys) {
    if (k.name === myKey) continue;
    const v = await env.KILN.get(k.name, 'json');
    if (!v) continue;
    online.push({ name: v.name, role: v.role, page: v.page || '' });
    if (v.page === String(pagePath)) others.push({ name: v.name, role: v.role });
  }
  return json({ ok: true, others, online, scope });
}

// ─── People (Google sign-in allowlist) ───────────────────────────────────────
// people:{repo} → [{ email, name, role: 'editor'|'member', days, paths? }]
// `paths` (editors only) limits which file prefixes they may write; [''] = whole site.

async function getPeople(env, repo) {
  return (await env.KILN.get(`people:${repo}`, 'json')) || [];
}

async function peopleList(request, env, url) {
  const repo = url.searchParams.get('repo') || '';
  if (!(await requirePush(request, repo))) return json({ error: 'forbidden' }, 403);
  return json({ people: await getPeople(env, repo), googleConfigured: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) });
}

// Menu features an admin can grant an editor. People/settings stay owner-only.
const GRANTABLE_FEATURES = ['menu', 'findreplace', 'newpost', 'pagesettings', 'history', 'schedule', 'draft', 'makeeditable'];

async function peopleUpsert(request, env) {
  const { repo, email, name, role, days, paths, keys, features } = await request.json().catch(() => ({}));
  if (!(await requirePush(request, repo))) return json({ error: 'forbidden' }, 403);
  const addr = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return json({ error: 'bad email' }, 400);
  if (!['editor', 'member'].includes(role)) return json({ error: 'bad role' }, 400);
  const person = {
    email: addr,
    name: String(name || addr.split('@')[0]).slice(0, 64),
    role,
    days: Number(days) === 0 ? 0 : Math.min(Math.max(Number(days) || 30, 1), 360),  // 0 = never expires
  };
  if (role === 'editor') {
    person.paths = normalizePaths(paths);
    // Section scope: data-cms key prefixes this editor may edit (advisory — the
    // editor UI greys out everything else; file writes are still gated by paths).
    const k = normalizePaths(keys).filter(x => x !== '');
    if (k.length) person.keys = k.slice(0, 50);
    // Per-editor feature grants (which menu tools they can use). Sanitized to the
    // known-grantable set; empty/undefined → a sensible default applied client-side.
    if (Array.isArray(features)) person.features = features.filter(f => GRANTABLE_FEATURES.includes(f));
  }
  const people = (await getPeople(env, repo)).filter(p => p.email !== addr);
  people.push(person);
  await env.KILN.put(`people:${repo}`, JSON.stringify(people));
  return json({ ok: true, person });
}

async function peopleRemove(request, env) {
  const { repo, email } = await request.json().catch(() => ({}));
  if (!(await requirePush(request, repo))) return json({ error: 'forbidden' }, 403);
  const addr = String(email || '').trim().toLowerCase();
  const people = (await getPeople(env, repo)).filter(p => p.email !== addr);
  await env.KILN.put(`people:${repo}`, JSON.stringify(people));
  // Revoke any active editor sessions for this person immediately (not just future sign-ins).
  let cursor;
  do {
    const page = await env.KILN.list({ prefix: 'esess:', cursor });
    for (const k of page.keys) {
      const v = await env.KILN.get(k.name, 'json');
      if (v && v.repo === repo && v.email === addr) await env.KILN.delete(k.name);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  // Also drop any pending scheduled posts this person created.
  let scur;
  do {
    const page = await env.KILN.list({ prefix: 'sched:', cursor: scur });
    for (const k of page.keys) {
      const v = await env.KILN.get(k.name, 'json');
      if (v && v.repo === repo && v.byEmail === addr) await env.KILN.delete(k.name);
    }
    scur = page.list_complete ? null : page.cursor;
  } while (scur);
  return json({ ok: true });
}

// ─── Google sign-in ──────────────────────────────────────────────────────────

function googleReady(env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

async function googleLogin(url, env) {
  if (!googleReady(env)) {
    return html(`<h1>Google sign-in isn't set up yet</h1>
      <p>The site owner needs to add <code>GOOGLE_CLIENT_ID</code> and
      <code>GOOGLE_CLIENT_SECRET</code> to this worker. See the Kiln README.</p>`, 503);
  }
  const origin = url.searchParams.get('origin') || '';
  const returnTo = url.searchParams.get('return_to') || '/';
  const repo = url.searchParams.get('repo') || '';
  if (!(await originAllowed(env, origin))) return html('<h1>Origin not allowed</h1>', 403);
  if (!returnTo.startsWith('/') || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return html('<h1>Bad request</h1>', 400);

  const nonce = crypto.randomUUID();
  await env.KILN.put(`gstate:${nonce}`, JSON.stringify({ origin, returnTo, repo }), { expirationTtl: 600 });
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state: nonce,
    prompt: 'select_account',
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
}

async function googleCallback(url, env) {
  const code = url.searchParams.get('code');
  const nonce = url.searchParams.get('state');
  if (!code || !nonce) return html('<h1>Missing code/state</h1>', 400);
  const state = await env.KILN.get(`gstate:${nonce}`, 'json');
  if (!state) return html('<h1>Sign-in expired</h1><p>Go back to the site and try again.</p>', 400);
  await env.KILN.delete(`gstate:${nonce}`);

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  const tok = await tokenRes.json();
  if (!tok.id_token) return html(`<h1>Google sign-in failed</h1><pre>${esc(tok.error_description || tok.error || '?')}</pre>`, 400);

  // Google validates the token's signature for us; we check it's OUR token.
  const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tok.id_token)}`);
  const info = await infoRes.json();
  if (!infoRes.ok || info.aud !== env.GOOGLE_CLIENT_ID || info.email_verified !== 'true') {
    return html('<h1>Could not verify your Google account</h1>', 403);
  }

  const email = String(info.email).toLowerCase();
  const person = (await getPeople(env, state.repo)).find(p => p.email === email);
  if (!person) {
    return html(`<h1>You're not on the list (yet)</h1>
      <p>You signed in as <strong>${esc(email)}</strong>, but the owner of this site
      hasn't added that address. Ask them to add you under <em>People</em> in their
      Kiln admin bar, then try again.</p>
      <p><a class="btn" href="${esc(state.origin + state.returnTo)}">Back to the site</a></p>`, 403);
  }

  const displayName = person.name || info.name || email.split('@')[0];
  if (person.role === 'editor') {
    const session = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    const exp = person.days ? Date.now() + person.days * 24 * 3600 * 1000 : null;  // days:0 = never
    await env.KILN.put(`esess:${session}`,
      JSON.stringify({ repo: state.repo, name: displayName, role: 'editor', email, paths: person.paths || [''], keys: person.keys || [], features: person.features || null, created: Date.now(), exp }),
      person.days ? { expirationTtl: person.days * 24 * 3600 } : undefined);
    const fp = { 'kiln-esession': session, 'kiln-name': displayName, 'kiln-repo': state.repo };
    if (exp) fp['kiln-exp'] = String(exp);
    const frag = new URLSearchParams(fp);
    return Response.redirect(`${state.origin}${state.returnTo}#${frag}`, 302);
  }

  // Member: hand the site a one-time code it can exchange for its own cookie.
  // The code is BOUND to the repo whose member-list authorized it and the origin
  // it was minted for — googleClaim re-derives the authoritative repo for that
  // origin and rejects a mismatch, so a member of repo A can't mint a code and
  // have it redeemed as a member of an unrelated paid site B (cross-tenant bypass).
  const gcode = crypto.randomUUID().replaceAll('-', '');
  await env.KILN.put(`gcode:${gcode}`,
    JSON.stringify({ name: displayName, days: person.days, repo: state.repo, origin: state.origin }),
    { expirationTtl: 300 });
  const dest = state.returnTo.startsWith('/members') ? state.returnTo : '/members/';
  return Response.redirect(
    `${state.origin}/members-login.html?to=${encodeURIComponent(dest)}#kiln-gcode=${gcode}`, 302);
}

/**
 * The repo that authoritatively owns a member-facing origin. Cloud sites map
 * origin→repo in D1; the canonical instance's static sites are listed here.
 * Returns null when unknown (single-tenant self-host worker — no cross-tenant risk).
 */
async function repoForOrigin(env, origin) {
  if (env.kiln_cloud) {
    try {
      const row = await env.kiln_cloud.prepare(
        "SELECT repo FROM sites WHERE origin = ? AND status IN ('active','trialing') LIMIT 1"
      ).bind(origin).first();
      if (row) return row.repo;
    } catch { /* D1 unreachable — fall through */ }
  }
  const STATIC = { 'https://npu-i.pages.dev': 'erikkurtu/npu-i' };
  return STATIC[origin] || null;
}

async function googleClaim(request, env) {
  const { code } = await request.json().catch(() => ({}));
  if (!/^[a-f0-9]{32}$/.test(code || '')) return json({ error: 'bad code' }, 400);
  const data = await env.KILN.get(`gcode:${code}`, 'json');
  if (!data) return json({ error: 'expired' }, 404);
  await env.KILN.delete(`gcode:${code}`);   // single use, regardless of outcome
  // Cross-tenant guard: the code's repo must be the repo that authoritatively
  // owns the origin it was minted for. (Older codes with no repo/origin bound
  // pass through unchanged for backward compatibility.)
  if (data.repo && data.origin) {
    const authRepo = await repoForOrigin(env, data.origin);
    if (authRepo && authRepo !== data.repo) {
      return json({ error: 'sign-in not valid for this site' }, 403);
    }
  }
  return json({ ok: true, name: data.name, days: data.days });
}

// ─── GitHub proxy for editor sessions ────────────────────────────────────────

// Paths an invited editor must never be allowed to write: domain/redirect
// config and CI workflow files. Blocking these is defense-in-depth against a
// redeemed (non-GitHub) editor overwriting CNAME, _redirects, _headers, or
// .github/* to hijack the domain or inject Actions. Admins (direct GitHub
// token) are unaffected — this only gates PROXIED editor writes.
function isSensitivePath(p) {
  const path = String(p || '').replace(/^\/+/, '');
  if (path.split('/').some(s => s === '..' || s === '.')) return true; // never let traversal through
  const lower = path.toLowerCase();
  // Domain/redirect/header config.
  if (/^\.github\//.test(path) || /^cname$/i.test(path) || /^_redirects$/i.test(path) || /^_headers$/i.test(path)) return true;
  // Code that a host EXECUTES at the edge or at build time — an editor writing
  // any of these escalates from content into running code / deploy hijack.
  // Matched at ANY path depth (not just root) so nested build dirs can't slip by.
  //   Cloudflare Pages Functions, advanced-mode worker, Jekyll plugins.
  if (/(^|\/)functions\//.test(lower) || /(^|\/)_worker\.js$/i.test(lower) || /(^|\/)_plugins\//.test(lower)) return true;
  //   Host build/deploy config (Netlify, Vercel, Cloudflare, GitLab, Docker, npm scripts, Jekyll…)
  if (/(^|\/)(netlify\.toml|vercel\.json|wrangler\.toml|dockerfile|procfile|package\.json|package-lock\.json|_config\.ya?ml|gemfile|now\.json|render\.yaml)$/i.test(lower)) return true;
  //   Any CI/workflow YAML, and dotfiles that change tooling.
  if (/(^|\/)\.[^/]+\.ya?ml$/i.test(lower) || /workflows\/[^/]+\.ya?ml$/i.test(lower) || /(^|\/)\.npmrc$/i.test(lower)) return true;
  return false;
}

// Allowlist of the exact GitHub endpoints the editor/admin frontend uses.
// `exact` rules match the path verbatim (after stripping any querystring);
// `prefix` rules match the path or anything beneath it. The repo-root rule is
// EXACT-only so it can never act as a catch-all wildcard over /repos/<r>/*.
const PROXY_RULES = [
  // Repo root (metadata) — exact match only.
  { methods: ['GET'], exact: r => `/repos/${r}` },
  // File contents (read + write a single path, and list a directory).
  { methods: ['GET', 'PUT'], prefix: r => `/repos/${r}/contents/` },
  { methods: ['GET'], exact: r => `/repos/${r}/contents` },
  // Commit list + per-commit combined status.
  { methods: ['GET'], exact: r => `/repos/${r}/commits` },
  { methods: ['GET'], prefix: r => `/repos/${r}/commits/` },
  // Deployments + their statuses.
  { methods: ['GET'], exact: r => `/repos/${r}/deployments` },
  { methods: ['GET'], prefix: r => `/repos/${r}/deployments/` },
  // Low-level git data (refs, commits/<sha>, trees) — reads.
  { methods: ['GET'], prefix: r => `/repos/${r}/git/` },
  // Low-level git data — writes for the "+ New post" flow.
  { methods: ['POST'], exact: r => `/repos/${r}/git/blobs` },
  { methods: ['POST'], exact: r => `/repos/${r}/git/trees` },
  { methods: ['POST'], exact: r => `/repos/${r}/git/commits` },
  { methods: ['POST', 'PATCH'], exact: r => `/repos/${r}/git/refs` },
  { methods: ['POST', 'PATCH'], prefix: r => `/repos/${r}/git/refs/` },
];

function proxyAllowed(method, path, repo) {
  const clean = path.split('?')[0]; // strip querystring before matching
  return PROXY_RULES.some(rule => {
    if (!rule.methods.includes(method)) return false;
    if (rule.exact) return clean === rule.exact(repo);
    if (rule.prefix) return clean.startsWith(rule.prefix(repo));
    return false;
  });
}

async function ghProxy(request, env, ghPath) {
  const sessId = request.headers.get('X-Kiln-Session') || '';
  if (!/^[a-f0-9]{64}$/.test(sessId)) return json({ error: 'missing session' }, 401);
  const sess = await env.KILN.get(`esess:${sessId}`, 'json');
  if (!sess) return json({ error: 'session expired' }, 401);
  // Trust the stored expiry, not only KV's TTL.
  if (sess.exp && sess.exp < Date.now()) return json({ error: 'session expired' }, 401);
  if (sess.role !== 'editor') return json({ error: 'not an editor session' }, 403);

  if (!proxyAllowed(request.method, ghPath, sess.repo)) {
    return json({ error: 'path not allowed', path: ghPath }, 403);
  }

  // Defense-in-depth + per-editor scope: editors may not write domain/redirect/CI
  // config, nor anything outside the paths granted to them in People & access.
  const cleanPath = ghPath.split('?')[0];
  if (request.method === 'PUT' && cleanPath.includes('/contents/')) {
    const filePath = decodeURIComponent(cleanPath.split('/contents/')[1] || '');
    if (isSensitivePath(filePath)) return json({ error: 'forbidden path for editor' }, 403);
    if (!pathInScope(filePath, sess.paths)) return json({ error: 'outside your editing scope', path: filePath }, 403);
  }
  if (request.method === 'POST' && /\/git\/trees$/.test(cleanPath)) {
    const peek = await request.clone().text();
    try {
      const parsed = JSON.parse(peek);
      if (Array.isArray(parsed.tree)) {
        if (parsed.tree.some(e => e && isSensitivePath(e.path))) {
          return json({ error: 'forbidden path for editor' }, 403);
        }
        if (parsed.tree.some(e => e && (!e.path || !pathInScope(e.path, sess.paths)))) {
          return json({ error: 'outside your editing scope' }, 403);
        }
      }
    } catch { /* non-JSON body — allowlist already gated the route */ }
  }

  const itok = await installationToken(env, sess.repo);
  if (!itok) return json({ error: 'app not installed on repo', repo: sess.repo }, 503);

  const headers = {
    Authorization: `Bearer ${itok}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': UA,
  };
  let body;
  if (!['GET', 'HEAD'].includes(request.method)) {
    headers['Content-Type'] = 'application/json';
    body = await request.text();
    // Attribute the change to the human editor (committer stays the Kiln bot).
    if (body && (ghPath.includes('/contents/') || ghPath.includes('/git/commits'))) {
      try {
        const parsed = JSON.parse(body);
        parsed.author = { name: `${sess.name} (via Kiln)`, email: 'kiln-editor@users.noreply.github.com' };
        body = JSON.stringify(parsed);
      } catch { /* pass through untouched */ }
    }
  }
  const res = await fetch(`${GH}${ghPath}`, { method: request.method, headers, body });
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' } });
}

async function installationToken(env, repo) {
  const cached = await env.KILN.get(`itok:${repo}`);
  if (cached) return cached;

  const creds = await env.KILN.get('app:creds', 'json');
  if (!creds) return null;
  const jwt = await appJwt(creds);
  const ghHeaders = { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': UA };

  const instRes = await fetch(`${GH}/repos/${repo}/installation`, { headers: ghHeaders });
  if (!instRes.ok) return null;
  const inst = await instRes.json();

  const tokRes = await fetch(`${GH}/app/installations/${inst.id}/access_tokens`, { method: 'POST', headers: ghHeaders });
  if (!tokRes.ok) return null;
  const tok = await tokRes.json();

  await env.KILN.put(`itok:${repo}`, tok.token, { expirationTtl: 50 * 60 });
  return tok.token;
}

// ─── GitHub App JWT (RS256 via WebCrypto) ────────────────────────────────────

async function appJwt(creds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: creds.app_id }));
  const key = await crypto.subtle.importKey(
    'pkcs8', b64ToBuf(creds.pk8),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(sig)}`;
}

/** GitHub manifests return PKCS#1 PEM; WebCrypto wants PKCS#8 DER. Wrap it. */
function pkcs1PemToPkcs8Der(pem) {
  const b64 = pem.replace(/-----(BEGIN|END) RSA PRIVATE KEY-----/g, '').replace(/\s/g, '');
  const pkcs1 = new Uint8Array(b64ToBuf(b64));
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgId = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  const octet = derWrap(0x04, pkcs1);
  return derWrap(0x30, concatBytes(version, rsaAlgId, octet));
}

function derWrap(tag, content) {
  let len;
  if (content.length < 128) len = Uint8Array.of(content.length);
  else {
    const bytes = [];
    let n = content.length;
    while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
    len = Uint8Array.of(0x80 | bytes.length, ...bytes);
  }
  return concatBytes(Uint8Array.of(tag), len, content);
}

function concatBytes(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

function b64url(input) {
  const b = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  return bufToB64(b).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// ─── Tiny HTML chrome for setup pages ────────────────────────────────────────

function esc(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function html(body, status = 200) {
  return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Kiln setup</title>
<style>
  body{font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#2c2c2c;background:#faf9f7;
       max-width:560px;margin:8vh auto;padding:0 24px}
  h1{font-size:1.5rem} h2{font-size:1.1rem;margin-top:2em}
  .btn{display:inline-block;background:#1a1a2e;color:#fff;border:0;padding:12px 22px;border-radius:8px;
       font-size:15px;cursor:pointer;text-decoration:none}
  .dim{color:#888;font-size:14px} pre{background:#eee;padding:12px;border-radius:6px;overflow:auto}
  code{background:#eee;padding:1px 5px;border-radius:4px}
</style></head><body>${body}</body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
