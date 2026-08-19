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
 *   GET/POST /admin/api-tokens  scoped API tokens (push-verified); POST /admin/api-tokens/revoke
 *   GET  /google/login     ?origin=&return_to=&repo= → Google authorize (invited people)
 *   POST /google/claim     {code} → member session exchange
 *   ANY  /gh/*             session + path-scoped GitHub API proxy (editors)
 *   GET  /api/v1/pages     list editable pages            (Bearer API token)
 *   GET  /api/v1/fields    read a page's fields as JSON   (Bearer API token)
 *   PATCH /api/v1/edits    apply field edits → one commit (Bearer API token)
 *   GET  /comments         ?repo=&path= → a page's comment threads
 *   GET  /comments/counts  ?repo= → open-thread count per page (badge)
 *   POST /comments         new thread ({path,text,anchor?}) or reply ({path,thread,text})
 *   POST /comments/resolve {path,thread,resolved} → resolve / reopen
 *   POST /comments/delete  {path,thread} → delete a thread (admin only)
 *   GET  /suggestions      ?repo= → suggestions (admins: all; editors: their own)
 *   POST /suggestions      editor submits {path,edits,note?,branch?,baseSha?}
 *   POST /suggestions/decide {id,approve,note?} → approve (server-side merge) / decline (admin only)
 *
 * KV (binding: KILN):
 *   app:creds   {app_id, slug, client_id, client_secret, pk8}
 *   state:<n>   OAuth state nonce            (TTL 10 min)
 *   sid:<id>    {refresh_token}              (TTL 180 days, rotated)
 *   people:<repo> [{email,name,role,days,paths?}]  editor/member allowlist
 *   esess:<id>  {repo,name,role,email,paths}  (TTL = person.days)
 *   atok:<sha>  {id,repo,name,paths,keys,readonly,created,exp}  API token, keyed by SHA-256(secret)  (TTL = days)
 *   itok:<repo> cached installation token    (TTL 50 min)
 *   cmt:<repo>:<encodeURIComponent(page)>:<threadId>  comment thread
 *               {id,page,status,anchor,created,resolved,messages}  (no TTL — kept until deleted)
 *   sug:<repo>:<12hex>  suggestion {id,page,by,email,ts,note,edits:[{key,html}|{key,attr,value}],
 *               branch|null,baseSha|null,status:'open'|'approved'|'declined',
 *               decided:{by,ts,note?}|null,commit:{sha,url}|null}  (no TTL — the review trail persists)
 *
 * Env vars: ALLOWED_ORIGINS — comma-separated site origins allowed to use auth.
 */

const GH = 'https://api.github.com';
const UA = 'kiln-auth-worker';

import { handleCloud, expireStaleTrials } from './cloud.js';
import { applyEdits, indexHtml, readValues, pageFileCandidates } from '../src/engine.js';
import { checkDocumentWrite, checkFragment, isHtmlPath } from './sanitize-guard.js';

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
      if (path === '/admin/api-tokens' && request.method === 'GET') return (await rateLimited(request, env)) || await cors(env, request, await apiTokenList(request, env, url));
      if (path === '/admin/api-tokens' && request.method === 'POST') return (await rateLimited(request, env)) || await cors(env, request, await apiTokenCreate(request, env));
      if (path === '/admin/api-tokens/revoke' && request.method === 'POST') return (await rateLimited(request, env)) || await cors(env, request, await apiTokenRevoke(request, env));
      if (path === '/api/v1/pages' && request.method === 'GET') return (await rateLimited(request, env)) || await cors(env, request, await apiPages(request, env, url));
      if (path === '/api/v1/fields' && request.method === 'GET') return (await rateLimited(request, env)) || await cors(env, request, await apiFields(request, env, url));
      if (path === '/api/v1/edits' && request.method === 'PATCH') return (await rateLimited(request, env)) || await cors(env, request, await apiEdits(request, env));
      if (path === '/schedule' && request.method === 'POST') return await cors(env, request, await scheduleCreate(request, env));
      if (path === '/schedules' && request.method === 'GET') return await cors(env, request, await scheduleList(request, env, url));
      if (path === '/schedule/cancel' && request.method === 'POST') return await cors(env, request, await scheduleCancel(request, env));
      if (path === '/presence' && request.method === 'POST') return (await rateLimited(request, env)) || await cors(env, request, await presencePing(request, env));
      if (path === '/comments' && request.method === 'GET') return await cors(env, request, await commentList(request, env, url));
      if (path === '/comments' && request.method === 'POST') return (await rateLimited(request, env)) || await cors(env, request, await commentPost(request, env));
      if (path === '/comments/counts' && request.method === 'GET') return await cors(env, request, await commentCounts(request, env, url));
      if (path === '/comments/resolve' && request.method === 'POST') return (await rateLimited(request, env)) || await cors(env, request, await commentResolve(request, env));
      if (path === '/comments/delete' && request.method === 'POST') return (await rateLimited(request, env)) || await cors(env, request, await commentDelete(request, env));
      if (path === '/suggestions' && request.method === 'GET') return await cors(env, request, await suggestionList(request, env, url));
      if (path === '/suggestions' && request.method === 'POST') return (await rateLimited(request, env)) || await cors(env, request, await suggestionCreate(request, env));
      if (path === '/suggestions/decide' && request.method === 'POST') return (await rateLimited(request, env)) || await cors(env, request, await suggestionDecide(request, env));
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
export { pathInScope, isSensitivePath, normalizePaths, keyInScope, apiPageFilter, apiFieldsFor, apiPageCandidates, validateApiEdits, validateCommentInput, commentKey, normalizePagePath, validateSuggestionInput, suggestWriteViolation };

// ─── Scheduled publishing ────────────────────────────────────────────────────
// sched:<id> → { repo, path, branch, content(b64), message, at, desc, by }
// A cron tick commits every due entry using the App installation token.

async function authActor(request, env, repo) {
  // Either an admin's GitHub token (push access) or an editor session for this repo.
  const sess = request.headers.get('X-Kiln-Session');
  if (sess && /^[a-f0-9]{64}$/.test(sess)) {
    const e = await env.KILN.get(`esess:${sess}`, 'json');
    if (e && (!e.exp || e.exp >= Date.now()) && e.repo === repo && e.role === 'editor') return { name: e.name, email: e.email, paths: e.paths || [''], keys: e.keys || [], mode: e.mode || null, admin: false };
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
  // A schedule fires as a DIRECT commit (runDueSchedules, installation token) —
  // letting a suggest-mode editor schedule would sidestep the proxy's
  // suggest guard entirely. Same door, same lock.
  if (!actor.admin && (actor.mode === 'suggest' || actor.mode === 'review')) {
    return json({ error: actor.mode === 'review' ? 'review-mode: comment-only access' : 'suggest-mode: publish goes through suggestions' }, 403);
  }
  if (!actor.admin && (isSensitivePath(path) || !pathInScope(path, actor.paths))) {
    return json({ error: 'outside your editing scope' }, 403);
  }
  // Content guard for non-admin editors: scheduled field edits are re-applied
  // raw against live source at fire time (runDueSchedules → applyEdits), so
  // sanitize them at creation. Reject any executable markup in a field's HTML,
  // and refuse full-page `content` snapshots from editors (they can't be diffed
  // safely — editors schedule field-level `edits`, which the UI always sends).
  if (!actor.admin) {
    if (content && !edits) return json({ error: 'editors must schedule field edits, not a full page' }, 403);
    if (Array.isArray(edits)) {
      for (const e of edits) {
        if (e && e.html !== undefined) {
          const bad = checkFragment(e.html);
          if (bad) return json({ error: 'scheduled edit contains disallowed markup', detail: bad }, 403);
        }
      }
    }
  }
  const when = Date.parse(at);
  if (!when || when < Date.now() - 60000 || when > Date.now() + 366 * 24 * 3600 * 1000) {
    return json({ error: 'bad time' }, 400);
  }
  const id = crypto.randomUUID().replaceAll('-', '');
  await env.KILN.put(`sched:${id}`,
    JSON.stringify({ repo, path, branch, edits: edits || null, content: edits ? null : content, message: message || 'Scheduled publish (via Kiln)', at: when, desc: desc || path, by: actor.name, byEmail: actor.email, admin: !!actor.admin }),
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
      // Re-validate scope at fire time. A non-admin editor's access may have been
      // narrowed or their scope changed since they scheduled this (peopleUpsert
      // purges live sessions but leaves schedules); enforce the CURRENT scope so a
      // revoked path can't still publish. `admin === false` is stored explicitly;
      // legacy records without the field are left alone (can't retro-check).
      if (v.admin === false) {
        const people = await getPeople(env, v.repo);
        const p = people.find(x => x.email === v.byEmail && x.role === 'editor');
        if (!p || isSensitivePath(v.path) || !pathInScope(v.path, p.paths)) {
          await env.KILN.delete(k.name);
          continue;
        }
      }
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
      scope = { paths: e.paths || [''], keys: e.keys || [], features: e.features || null, mode: e.mode || null };  // editor UI uses this to gate handles + menu + suggest-mode publish
    }
  }
  if (!who && (await requirePushCached(request, env, repo))) {
    who = String(name || 'Owner').slice(0, 64);
    role = 'owner';
  }
  if (!who) return json({ error: 'forbidden' }, 403);

  // Colons delimit the KV key, so strip them from the (partly client-supplied)
  // name before composing pres:<repo>:<name> — otherwise a crafted value could
  // shadow another user's presence key. The trusted `role` is server-derived
  // above, so display-name spoofing is the whole ceiling here.
  const safe = (s, n) => String(s).replaceAll(':', ' ').slice(0, n);
  const nameKey = safe(who, 64);
  // ONE presence entry per person (keyed by name, not name+page): each ping
  // overwrites the last, so the entry follows them as they navigate instead of
  // leaving a stale "editing /about" row behind for every page they visited.
  const myKey = `pres:${repo}:${nameKey}`;
  await env.KILN.put(myKey,
    JSON.stringify({ name: nameKey, role, page: String(pagePath).slice(0, 200), ts: Date.now() }),
    { expirationTtl: 90 });

  // `others` = people on THIS page; `online` = everyone editing the site right
  // now. Dedupe by name (keep the freshest) so entries written under the old
  // per-page key format can't produce duplicate rows while they age out.
  const byName = new Map();
  const list = await env.KILN.list({ prefix: `pres:${repo}:` });
  for (const k of list.keys) {
    if (k.name === myKey) continue;
    const v = await env.KILN.get(k.name, 'json');
    if (!v || v.name === nameKey) continue;
    const prev = byName.get(v.name);
    if (!prev || (v.ts || 0) > (prev.ts || 0)) byName.set(v.name, v);
  }
  const online = [...byName.values()].map(v => ({ name: v.name, role: v.role, page: v.page || '' }));
  const others = online.filter(v => v.page === String(pagePath)).map(({ name, role }) => ({ name, role }));
  return json({ ok: true, others, online, scope });
}

// ─── Comments (review threads pinned to pages) ──────────────────────────────
// cmt:<repo>:<encodeURIComponent(page)>:<threadId> → thread record. Comments are
// plain-text DATA returned as JSON — never written into site HTML, so the
// sanitizers don't apply; escaping at render time is the editor UI's job.
// Author identity always comes from the auth actor, never the body (no spoofing).
// No TTL: threads persist until an admin deletes them. Read-modify-write on
// replies is last-write-wins (same as people/presence) — acceptable for review
// chatter, not a ledger.

/** Page paths are opaque strings: trim, drop leading slashes, cap at 300 chars,
 *  refuse empty / `..`. Returns the normalized page or null. */
function normalizePagePath(path) {
  if (typeof path !== 'string') return null;
  const p = path.trim().replace(/^\/+/, '');
  if (!p || p.length > 300 || p.includes('..')) return null;
  return p;
}

/** KV key for one thread. The page is URI-encoded so a page containing `:` (or
 *  anything else) can't forge the key's delimiters — repo is [\w.-/] only, so
 *  splitting on `:` stays unambiguous. */
function commentKey(repo, page, id) {
  return `cmt:${repo}:${encodeURIComponent(page)}:${id}`;
}

/** Validate a comment write. Returns { error } or the normalized { page, text, anchor }.
 *  `anchor` is an opaque client hint ({key?, sel?, x?, y?}) — stored as sent, but
 *  size-capped so a hostile client can't stuff arbitrary payloads into KV. */
function validateCommentInput({ path, text, anchor } = {}) {
  const page = normalizePagePath(path);
  if (!page) return { error: 'bad path' };
  if (typeof text !== 'string' || !text.trim()) return { error: 'missing text' };
  const t = text.trim();
  if (t.length > 4000) return { error: 'text too long' };
  let a = null;
  if (anchor !== undefined && anchor !== null) {
    if (typeof anchor !== 'object' || Array.isArray(anchor)) return { error: 'bad anchor' };
    let ser;
    try { ser = JSON.stringify(anchor); } catch { return { error: 'bad anchor' }; }
    if (typeof ser !== 'string' || ser.length > 600) return { error: 'bad anchor' };
    for (const k of ['key', 'sel'])
      if (anchor[k] !== undefined && (typeof anchor[k] !== 'string' || anchor[k].length > 200)) return { error: 'bad anchor' };
    for (const k of ['x', 'y'])
      if (anchor[k] !== undefined && !(typeof anchor[k] === 'number' && Number.isFinite(anchor[k]) && anchor[k] >= 0 && anchor[k] <= 100)) return { error: 'bad anchor' };
    a = anchor;
  }
  return { page, text: t, anchor: a };
}

async function commentList(request, env, url) {
  const repo = url.searchParams.get('repo') || '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: 'bad repo' }, 400);
  const actor = await authActor(request, env, repo);
  if (!actor) return json({ error: 'unauthorized' }, 401);
  const page = normalizePagePath(url.searchParams.get('path') || '');
  if (!page) return json({ error: 'bad path' }, 400);
  const threads = [];
  let truncated = false, cursor;
  do {
    const batch = await env.KILN.list({ prefix: commentKey(repo, page, ''), cursor });
    for (const k of batch.keys) {
      if (threads.length >= 300) { truncated = true; break; }
      const v = await env.KILN.get(k.name, 'json');
      if (v) threads.push(v);
    }
    cursor = truncated || batch.list_complete ? null : batch.cursor;
  } while (cursor);
  threads.sort((a, b) => (b.created || 0) - (a.created || 0));
  return json(truncated ? { threads, truncated: true } : { threads });
}

async function commentCounts(request, env, url) {
  const repo = url.searchParams.get('repo') || '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: 'bad repo' }, 400);
  const actor = await authActor(request, env, repo);
  if (!actor) return json({ error: 'unauthorized' }, 401);
  // Null-prototype map: a page literally named "__proto__" must stay plain data.
  const counts = Object.create(null);
  let total = 0, seen = 0, truncated = false, cursor;
  do {
    const batch = await env.KILN.list({ prefix: `cmt:${repo}:`, cursor });
    for (const k of batch.keys) {
      if (seen >= 1000) { truncated = true; break; }
      seen++;
      const v = await env.KILN.get(k.name, 'json');
      if (!v || v.status !== 'open') continue;
      counts[v.page] = (counts[v.page] || 0) + 1;
      total++;
    }
    cursor = truncated || batch.list_complete ? null : batch.cursor;
  } while (cursor);
  return json(truncated ? { counts, total, truncated: true } : { counts, total });
}

async function commentPost(request, env) {
  const { repo, path, thread, text, anchor } = await request.json().catch(() => ({}));
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) return json({ error: 'bad repo' }, 400);
  const actor = await authActor(request, env, repo);
  if (!actor) return json({ error: 'unauthorized' }, 401);
  // Anchors belong to new threads only; on a reply the field is ignored.
  const v = validateCommentInput({ path, text, anchor: thread == null ? anchor : undefined });
  if (v.error) return json({ error: v.error }, 400);
  const msg = { by: actor.name, email: actor.email, ts: Date.now(), text: v.text };
  if (thread != null) {
    if (!/^[a-f0-9]{12}$/.test(String(thread))) return json({ error: 'bad thread' }, 400);
    const key = commentKey(repo, v.page, thread);
    const t = await env.KILN.get(key, 'json');
    if (!t) return json({ error: 'not found' }, 404);
    if ((t.messages || []).length >= 200) return json({ error: 'thread full' }, 413);
    t.messages = [...(t.messages || []), msg];
    // Replying to a resolved thread does NOT reopen it — reopening is explicit.
    await env.KILN.put(key, JSON.stringify(t));
    return json({ thread: t });
  }
  const id = [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
  const t = { id, page: v.page, status: 'open', anchor: v.anchor, created: Date.now(), resolved: null, messages: [msg] };
  await env.KILN.put(commentKey(repo, v.page, id), JSON.stringify(t));
  return json({ thread: t });
}

async function commentResolve(request, env) {
  const { repo, path, thread, resolved } = await request.json().catch(() => ({}));
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) return json({ error: 'bad repo' }, 400);
  const actor = await authActor(request, env, repo);
  if (!actor) return json({ error: 'unauthorized' }, 401);
  const page = normalizePagePath(path);
  if (!page || !/^[a-f0-9]{12}$/.test(String(thread || '')) || typeof resolved !== 'boolean') {
    return json({ error: 'bad request' }, 400);
  }
  const key = commentKey(repo, page, thread);
  const t = await env.KILN.get(key, 'json');
  if (!t) return json({ error: 'not found' }, 404);
  t.status = resolved ? 'resolved' : 'open';
  t.resolved = resolved ? { by: actor.name, ts: Date.now() } : null;
  await env.KILN.put(key, JSON.stringify(t));
  return json({ thread: t });
}

async function commentDelete(request, env) {
  const { repo, path, thread } = await request.json().catch(() => ({}));
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) return json({ error: 'bad repo' }, 400);
  const actor = await authActor(request, env, repo);
  if (!actor) return json({ error: 'unauthorized' }, 401);
  // Deletion is destructive and unscoped — owner only; editors (incl. reviewers) get 403.
  if (!actor.admin) return json({ error: 'admin only' }, 403);
  const page = normalizePagePath(path);
  if (!page || !/^[a-f0-9]{12}$/.test(String(thread || ''))) return json({ error: 'bad request' }, 400);
  await env.KILN.delete(commentKey(repo, page, thread));
  return json({ ok: true });
}

// ─── Suggestions (suggest-mode publishing: propose → review → merge) ────────
// sug:<repo>:<12hex> → suggestion record (see the KV block above). A suggestion
// is a DEFERRED editor write: the same field-level {key,html}|{key,attr,value}
// edits a live publish sends, held in KV until an admin decides. Approval runs
// the identical server-side merge as PATCH /api/v1/edits — re-apply by key
// against the CURRENT page, content-guard, PUT with the fresh sha — so interim
// publishes to other fields survive and nothing executable can ride in. Edits
// are validated at submission time (shape, fragment guard, section keys) AND
// content-guarded again at approval; the suggester keeps commit authorship
// while the decide record keeps the approver. No TTL: the trail persists.

/** Validate a suggestion submission against the SESSION's section keys.
 *  Returns { error, status, detail? } to reject, or the normalized
 *  { page, edits, note, branch, baseSha }. Per-edit rules are validateApiEdits'
 *  — a suggestion inherits exactly the checks a live API write gets. */
function validateSuggestionInput({ path, edits, note, branch, baseSha } = {}, keys) {
  const page = normalizePagePath(path);
  if (!page) return { error: 'bad path', status: 400 };
  const invalid = validateApiEdits(edits, keys);
  if (invalid) return { error: invalid.error, status: invalid.status, ...(invalid.detail !== undefined && { detail: invalid.detail }) };
  let n = '';
  if (note !== undefined && note !== null) {
    if (typeof note !== 'string' || note.length > 500) return { error: 'bad note', status: 400 };
    n = note.trim();
  }
  // The optional preview branch must be a kiln scratch branch (the only heads a
  // suggest-mode session may create — see suggestWriteViolation); it is stored
  // for the admin's "Open preview" link, never dereferenced server-side.
  let b = null;
  if (branch !== undefined && branch !== null && branch !== '') {
    if (typeof branch !== 'string' || branch.includes('..') || !/^kiln[/-][\w./-]{1,80}$/.test(branch)) {
      return { error: 'bad branch', status: 400 };
    }
    b = branch;
  }
  let base = null;
  if (baseSha !== undefined && baseSha !== null && baseSha !== '') {
    if (!/^[a-f0-9]{40}$/.test(String(baseSha))) return { error: 'bad baseSha', status: 400 };
    base = baseSha;
  }
  return { page, edits, note: n, branch: b, baseSha: base };
}

async function suggestionCreate(request, env) {
  const { repo, path, edits, note, branch, baseSha } = await request.json().catch(() => ({}));
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) return json({ error: 'bad repo' }, 400);
  const actor = await authActor(request, env, repo);
  if (!actor) return json({ error: 'unauthorized' }, 401);
  // An admin's suggestion would have no reviewer above them — they publish directly.
  if (actor.admin) return json({ error: 'admins publish directly' }, 400);
  if (actor.mode === 'review') return json({ error: 'review-mode: comment-only access' }, 403);
  const v = validateSuggestionInput({ path, edits, note, branch, baseSha }, actor.keys);
  if (v.status) return json({ error: v.error, ...(v.detail !== undefined && { detail: v.detail }) }, v.status);
  // Same write scope as a live publish: the session's path grants + the
  // sensitive denylist. A suggestion an admin approves must never reach a page
  // the suggester couldn't have touched themselves.
  if (isSensitivePath(v.page) || !pathInScope(v.page, actor.paths)) {
    return json({ error: 'outside your editing scope' }, 403);
  }
  const id = [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
  const sug = {
    id, page: v.page, by: actor.name, email: actor.email, ts: Date.now(), note: v.note,
    edits: v.edits, branch: v.branch, baseSha: v.baseSha, status: 'open', decided: null, commit: null,
  };
  await env.KILN.put(`sug:${repo}:${id}`, JSON.stringify(sug));
  return json({ suggestion: sug });
}

async function suggestionList(request, env, url) {
  const repo = url.searchParams.get('repo') || '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: 'bad repo' }, 400);
  const actor = await authActor(request, env, repo);
  if (!actor) return json({ error: 'unauthorized' }, 401);
  const suggestions = [];
  let truncated = false, cursor;
  do {
    const batch = await env.KILN.list({ prefix: `sug:${repo}:`, cursor });
    for (const k of batch.keys) {
      if (suggestions.length >= 300) { truncated = true; break; }
      const v = await env.KILN.get(k.name, 'json');
      if (!v) continue;
      // Editors see only their own submissions; admins review everything.
      if (!actor.admin && v.email !== actor.email) continue;
      suggestions.push(v);
    }
    cursor = truncated || batch.list_complete ? null : batch.cursor;
  } while (cursor);
  suggestions.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const counts = { open: suggestions.filter(s => s.status === 'open').length };
  return json(truncated ? { suggestions, counts, truncated: true } : { suggestions, counts });
}

async function suggestionDecide(request, env) {
  const { repo, id, approve, note } = await request.json().catch(() => ({}));
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) return json({ error: 'bad repo' }, 400);
  const actor = await authActor(request, env, repo);
  if (!actor) return json({ error: 'unauthorized' }, 401);
  // Deciding lands (or buries) someone else's words on the live site — owner only.
  if (!actor.admin) return json({ error: 'admin only' }, 403);
  if (!/^[a-f0-9]{12}$/.test(String(id || '')) || typeof approve !== 'boolean') return json({ error: 'bad request' }, 400);
  const key = `sug:${repo}:${id}`;
  const sug = await env.KILN.get(key, 'json');
  if (!sug) return json({ error: 'not found' }, 404);
  if (sug.status !== 'open') return json({ error: 'already decided' }, 409);
  const decided = { by: actor.name, ts: Date.now() };
  if (typeof note === 'string' && note.trim()) decided.note = note.trim().slice(0, 500);

  if (!approve) {
    sug.status = 'declined';
    sug.decided = decided;
    await env.KILN.put(key, JSON.stringify(sug));
    return json({ suggestion: sug });
  }

  // Approve = the same merge as PATCH /api/v1/edits: fetch the CURRENT page,
  // re-apply the suggestion's edits by key, content-guard fail-closed, PUT with
  // the fresh sha, ONE refetch-and-retry on a sha conflict. On conflict or a
  // guard rejection the suggestion STAYS open so the admin can retry/decline.
  const itok = await installationToken(env, repo);
  if (!itok) return json({ error: 'app not installed on repo', repo }, 503);
  const h = { Authorization: `Bearer ${itok}`, Accept: 'application/vnd.github+json', 'User-Agent': UA, 'Content-Type': 'application/json' };
  const readPage = async () => {
    const res = await fetch(`${GH}/repos/${repo}/contents/${encodeURIComponent(sug.page)}`, { headers: h });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`read ${res.status}`);
    const cur = await res.json();
    if (typeof cur.content !== 'string') throw new Error('unreadable content');
    return cur;
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await readPage();
      if (!cur) return json({ error: 'page not found' }, 404);
      const source = utf8FromB64(cur.content);
      const { html, applied, skipped } = applyEdits(source, sug.edits);
      if (!applied.length) return json({ error: 'no edits could be applied', skipped }, 422);
      if (html === source) {
        // The page already says this (perhaps the admin made the same edit) —
        // nothing to commit, but the suggestion is honored.
        sug.status = 'approved';
        sug.decided = decided;
        await env.KILN.put(key, JSON.stringify(sug));
        return json({ suggestion: sug, unchanged: true });
      }
      // Same server-side content guard as every editor write path: the merged
      // document may introduce nothing executable. Fails closed.
      const bad = checkDocumentWrite(source, html);
      if (bad) return json({ error: 'blocked: suggestion would add scripts or executable markup', detail: bad }, 422);
      const put = await fetch(`${GH}/repos/${repo}/contents/${encodeURIComponent(sug.page)}`, {
        method: 'PUT', headers: h,
        body: JSON.stringify({
          message: `Suggestion by ${sug.by}: ${sug.note || sug.page}`,
          content: b64FromUtf8(html), sha: cur.sha,
          // The SUGGESTER keeps authorship of their words; the decide record
          // (stored above) is where the approver is remembered.
          author: { name: `${sug.by} (via Kiln)`, email: 'kiln-editor@users.noreply.github.com' },
        }),
      });
      if (put.ok) {
        const out = await put.json();
        sug.status = 'approved';
        sug.decided = decided;
        sug.commit = { sha: out.commit?.sha, url: out.commit?.html_url };
        await env.KILN.put(key, JSON.stringify(sug));
        return json({ suggestion: sug, applied, skipped });
      }
      const err = await put.json().catch(() => ({}));
      const conflict = put.status === 409 || (put.status === 422 && /sha/i.test(err.message || ''));
      if (!conflict) return json({ error: 'commit failed', detail: err.message || String(put.status) }, 502);
    }
    return json({ error: 'conflict: the page changed while approving — try again' }, 409);
  } catch {
    return json({ error: 'could not apply the suggestion safely' }, 502);
  }
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
const GRANTABLE_FEATURES = ['menu', 'findreplace', 'newpost', 'pagesettings', 'history', 'schedule', 'draft', 'makeeditable', 'comments', 'blocks'];

async function peopleUpsert(request, env) {
  const { repo, email, name, role, days, paths, keys, features, mode } = await request.json().catch(() => ({}));
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
    // Suggest-mode: this editor's Publish becomes a suggestion an admin reviews
    // (enforced by the /gh proxy — see suggestWriteViolation). Review-mode: a
    // comment-only seat — every proxy write is refused. Only these two literals
    // are stored; any other value means normal direct publishing.
    if (mode === 'suggest' || mode === 'review') person.mode = mode;
  }
  const people = (await getPeople(env, repo)).filter(p => p.email !== addr);
  people.push(person);
  await env.KILN.put(`people:${repo}`, JSON.stringify(people));
  // Purge this person's live editor sessions so a scope/role/feature change
  // takes effect immediately — the frozen `paths` in an old esess would
  // otherwise keep their previous access until it expired (up to 360 days).
  await purgeEditorSessions(env, repo, addr);
  return json({ ok: true, person });
}

/** Delete every live esess for one person on one repo (scope change / removal). */
async function purgeEditorSessions(env, repo, addr) {
  let cursor;
  do {
    const page = await env.KILN.list({ prefix: 'esess:', cursor });
    for (const k of page.keys) {
      const v = await env.KILN.get(k.name, 'json');
      if (v && v.repo === repo && v.email === addr) await env.KILN.delete(k.name);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
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
      JSON.stringify({ repo: state.repo, name: displayName, role: 'editor', email, paths: person.paths || [''], keys: person.keys || [], features: person.features || null, mode: person.mode === 'suggest' || person.mode === 'review' ? person.mode : null, created: Date.now(), exp }),
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
  const { code, origin } = await request.json().catch(() => ({}));
  if (!/^[a-f0-9]{32}$/.test(code || '')) return json({ error: 'bad code' }, 400);
  const data = await env.KILN.get(`gcode:${code}`, 'json');
  if (!data) return json({ error: 'expired' }, 404);
  await env.KILN.delete(`gcode:${code}`);   // single use, regardless of outcome
  // PRIMARY cross-tenant guard: the site redeeming this code must be the same
  // origin it was minted for. A member of site A signs in and gets a code bound
  // to A; only A can redeem it. This is what stops a member of one site minting
  // a code and POSTing it to a DIFFERENT site's redeem endpoint to be issued
  // that site's member cookie. It does NOT depend on knowing origin→repo, so it
  // protects self-host and static-allowlisted origins too. All codes minted by
  // googleCallback carry `origin`; a code without one is rejected rather than
  // trusted.
  if (!data.origin || !origin || origin !== data.origin) {
    return json({ error: 'sign-in not valid for this site' }, 403);
  }
  // SECONDARY (defense in depth): the code's origin must map to the code's repo
  // where that mapping is known (Cloud/static).
  if (data.repo) {
    const authRepo = await repoForOrigin(env, data.origin);
    if (authRepo && authRepo !== data.repo) {
      return json({ error: 'sign-in not valid for this site' }, 403);
    }
  }
  return json({ ok: true, name: data.name, days: data.days });
}

// ─── API tokens (headless scoped access — Phase 0 of the REST API) ──────────
// atok:<sha256hex(secret)> → { id, repo, name, paths, keys, readonly, created, exp }
// An API token is a headless, scoped editor session: the owner mints a 64-hex
// secret and hands it to a script/agent; every call rides the App installation
// token but inherits the same guards as an invited editor (path scope,
// sensitive-path denylist, sanitize-guard, section keys). Only the secret's
// SHA-256 is stored — a KV dump can't be replayed as bearer tokens.

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function apiTokenCreate(request, env) {
  const { repo, name, paths, keys, readonly, days } = await request.json().catch(() => ({}));
  if (!(await requirePush(request, repo))) return json({ error: 'forbidden' }, 403);
  const label = String(name || '').trim().slice(0, 60);
  if (!label) return json({ error: 'missing name' }, 400);
  const d = Math.min(Math.max(Number(days) || 0, 0), 3650);   // 0 / absent = never expires
  const secret = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const record = {
    id: crypto.randomUUID().replaceAll('-', '').slice(0, 8),
    repo,
    name: label,
    paths: normalizePaths(paths),
    keys: normalizePaths(keys).filter(k => k !== '').slice(0, 50),
    readonly: !!readonly,
    created: Date.now(),
    exp: d ? Date.now() + d * 24 * 3600 * 1000 : null,
  };
  await env.KILN.put(`atok:${await sha256Hex(secret)}`, JSON.stringify(record),
    d ? { expirationTtl: d * 24 * 3600 } : undefined);
  // The secret appears in this response ONCE and is never recoverable again.
  return json({ ok: true, token: secret, record });
}

async function apiTokenList(request, env, url) {
  const repo = url.searchParams.get('repo') || '';
  if (!(await requirePush(request, repo))) return json({ error: 'forbidden' }, 403);
  const tokens = [];
  let cursor;
  do {
    const page = await env.KILN.list({ prefix: 'atok:', cursor });
    for (const k of page.keys) {
      const v = await env.KILN.get(k.name, 'json');
      if (v && v.repo === repo) tokens.push(v);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return json({ tokens: tokens.sort((a, b) => (b.created || 0) - (a.created || 0)) });
}

async function apiTokenRevoke(request, env) {
  const { repo, id } = await request.json().catch(() => ({}));
  if (!(await requirePush(request, repo))) return json({ error: 'forbidden' }, 403);
  if (!/^[a-f0-9]{8}$/.test(id || '')) return json({ error: 'bad id' }, 400);
  let cursor;
  do {
    const page = await env.KILN.list({ prefix: 'atok:', cursor });
    for (const k of page.keys) {
      const v = await env.KILN.get(k.name, 'json');
      if (v && v.repo === repo && v.id === id) {
        await env.KILN.delete(k.name);
        return json({ ok: true });
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return json({ error: 'not found' }, 404);
}

/** Resolve the API bearer secret to its stored token record, or null. */
async function apiTokenAuth(request, env) {
  const secret = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!/^[a-f0-9]{64}$/.test(secret)) return null;
  const tok = await env.KILN.get(`atok:${await sha256Hex(secret)}`, 'json');
  // Trust the stored expiry, not only KV's TTL.
  if (!tok || (tok.exp && tok.exp < Date.now())) return null;
  return tok;
}

/** Section-key scope — same semantics as the editor's keyInScope: exact or prefix. */
function keyInScope(key, keys) {
  if (!Array.isArray(keys) || !keys.length) return true;
  return keys.some(p => key === p || String(key).startsWith(p));
}

/** Filter a recursive git tree listing down to the HTML pages a token may see. */
function apiPageFilter(tree, paths) {
  const pages = [];
  for (const e of tree || []) {
    if (!e || e.type !== 'blob' || typeof e.path !== 'string') continue;
    if (!isHtmlPath(e.path)) continue;
    if (e.path.startsWith('_templates/') || e.path.startsWith('functions/')) continue;
    if (isSensitivePath(e.path) || !pathInScope(e.path, paths)) continue;
    pages.push(e.path);
    if (pages.length >= 500) break;
  }
  return pages;
}

/** A page's fields as {key: {value, kind}}, limited to the token's section keys. */
function apiFieldsFor(raw, keys) {
  const { fields } = indexHtml(raw);
  const values = readValues(raw);
  const out = {};
  for (const [key, f] of fields) {
    if (!keyInScope(key, keys)) continue;
    out[key] = { value: values[key], kind: f.kind };
  }
  return out;
}

/**
 * Map the API's `path` (URL-ish or a repo file path) to the candidate repo
 * files the token may touch: '/' → index.html, '/about/' → about/index.html,
 * '/about' → about.html then about/index.html (engine.pageFileCandidates).
 * Sensitive / out-of-scope candidates are dropped. {error: 400} = not an HTML
 * page path; {error: 403} = nothing left in this token's scope.
 */
function apiPageCandidates(path, paths) {
  let candidates;
  try { candidates = pageFileCandidates(String(path || '/')); } catch { return { error: 400 }; }
  if (!candidates.every(isHtmlPath)) return { error: 400 };
  const ok = candidates.filter(c => !isSensitivePath(c) && pathInScope(c, paths));
  return ok.length ? { candidates: ok } : { error: 403 };
}

/**
 * Validate a PATCH /api/v1/edits batch before it touches GitHub. Shape checks
 * plus the per-fragment content guard; the engine's attrNameAllowed stays the
 * authority on WHICH attributes may be written (disallowed ones come back in
 * `skipped`) — this only rejects values that aren't even attribute-shaped.
 * Returns {status, error, detail?} to short-circuit, or null when acceptable.
 */
function validateApiEdits(edits, keys) {
  if (!Array.isArray(edits) || !edits.length || edits.length > 500) return { status: 400, error: 'bad edits' };
  for (const e of edits) {
    if (!e || typeof e.key !== 'string' || !e.key) return { status: 400, error: 'every edit needs a key' };
    if (!keyInScope(e.key, keys)) return { status: 403, error: "key outside this token's scope", detail: e.key };
    const hasHtml = e.html !== undefined, hasAttr = e.attr !== undefined;
    if (hasHtml === hasAttr) return { status: 400, error: 'each edit is {key,html} or {key,attr,value}', detail: e.key };
    if (hasAttr) {
      if (!/^[a-z][a-z-]*$/i.test(String(e.attr)) || e.value === undefined) {
        return { status: 400, error: 'bad attr edit', detail: e.key };
      }
    } else {
      const bad = checkFragment(String(e.html));
      if (bad) return { status: 422, error: 'edit contains disallowed markup', detail: bad };
    }
  }
  return null;
}

async function apiPages(request, env, url) {
  const tok = await apiTokenAuth(request, env);
  if (!tok) return json({ error: 'unauthorized' }, 401);
  const itok = await installationToken(env, tok.repo);
  if (!itok) return json({ error: 'app not installed on repo', repo: tok.repo }, 503);
  const h = { Authorization: `Bearer ${itok}`, Accept: 'application/vnd.github+json', 'User-Agent': UA };
  let ref = url.searchParams.get('ref') || '';
  if (ref && !/^[\w./-]{1,100}$/.test(ref)) return json({ error: 'bad ref' }, 400);
  try {
    if (!ref) {
      const repoRes = await fetch(`${GH}/repos/${tok.repo}`, { headers: h });
      if (!repoRes.ok) return json({ error: 'could not read repo' }, 502);
      ref = (await repoRes.json()).default_branch || 'main';
    }
    const treeRes = await fetch(`${GH}/repos/${tok.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { headers: h });
    if (treeRes.status === 404) return json({ error: 'ref not found' }, 404);
    if (!treeRes.ok) return json({ error: 'could not list pages' }, 502);
    const tree = await treeRes.json();
    const out = { pages: apiPageFilter(tree.tree, tok.paths) };
    if (tree.truncated) out.truncated = true;   // repo too big for one listing — pages is partial
    return json(out);
  } catch {
    return json({ error: 'could not list pages' }, 502);
  }
}

async function apiFields(request, env, url) {
  const tok = await apiTokenAuth(request, env);
  if (!tok) return json({ error: 'unauthorized' }, 401);
  const resolved = apiPageCandidates(url.searchParams.get('path'), tok.paths);
  if (resolved.error === 400) return json({ error: 'not an HTML page path' }, 400);
  if (resolved.error) return json({ error: "outside this token's path scope" }, 403);
  const itok = await installationToken(env, tok.repo);
  if (!itok) return json({ error: 'app not installed on repo', repo: tok.repo }, 503);
  const h = { Authorization: `Bearer ${itok}`, Accept: 'application/vnd.github+json', 'User-Agent': UA };
  for (const candidate of resolved.candidates) {
    let res;
    try { res = await fetch(`${GH}/repos/${tok.repo}/contents/${encodeURIComponent(candidate)}`, { headers: h }); }
    catch { return json({ error: 'could not read page' }, 502); }
    if (res.status === 404) continue;
    if (!res.ok) return json({ error: 'could not read page' }, 502);
    const cur = await res.json();
    if (typeof cur.content !== 'string') return json({ error: 'could not read page' }, 502);
    return json({ path: candidate, fields: apiFieldsFor(utf8FromB64(cur.content), tok.keys) });
  }
  return json({ error: 'page not found' }, 404);
}

async function apiEdits(request, env) {
  const tok = await apiTokenAuth(request, env);
  if (!tok) return json({ error: 'unauthorized' }, 401);
  if (tok.readonly) return json({ error: 'read-only token' }, 403);
  const { path, edits, message } = await request.json().catch(() => ({}));
  const resolved = apiPageCandidates(path, tok.paths);
  if (resolved.error === 400) return json({ error: 'not an HTML page path' }, 400);
  if (resolved.error) return json({ error: "outside this token's path scope" }, 403);
  const invalid = validateApiEdits(edits, tok.keys);
  if (invalid) return json({ error: invalid.error, ...(invalid.detail !== undefined && { detail: invalid.detail }) }, invalid.status);
  const itok = await installationToken(env, tok.repo);
  if (!itok) return json({ error: 'app not installed on repo', repo: tok.repo }, 503);
  const h = { Authorization: `Bearer ${itok}`, Accept: 'application/vnd.github+json', 'User-Agent': UA, 'Content-Type': 'application/json' };

  const readPage = async (p) => {
    const res = await fetch(`${GH}/repos/${tok.repo}/contents/${encodeURIComponent(p)}`, { headers: h });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`read ${res.status}`);
    const cur = await res.json();
    if (typeof cur.content !== 'string') throw new Error('unreadable content');
    return cur;
  };

  try {
    // Resolve to the first candidate that exists, then fetch → apply → guard →
    // PUT, with ONE refetch-and-retry on a sha conflict (same merge model as the
    // editor's editFile: edits re-locate fields by key against the fresh source,
    // so concurrent edits to different fields merge cleanly).
    let filePath = null, cur = null;
    for (const candidate of resolved.candidates) {
      cur = await readPage(candidate);
      if (cur) { filePath = candidate; break; }
    }
    if (!filePath) return json({ error: 'page not found' }, 404);

    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) {
        cur = await readPage(filePath);
        if (!cur) return json({ error: 'page not found' }, 404);
      }
      const source = utf8FromB64(cur.content);
      const { html, applied, skipped } = applyEdits(source, edits);
      if (!applied.length) return json({ error: 'no edits could be applied', skipped }, 422);
      if (html === source) return json({ ok: true, unchanged: true, commit: null, applied, skipped });
      // Same server-side content guard as editor writes: the new document may
      // introduce nothing executable that isn't already committed. Fails closed.
      const bad = checkDocumentWrite(source, html);
      if (bad) return json({ error: 'blocked: edits cannot add scripts or executable markup', detail: bad }, 422);
      const put = await fetch(`${GH}/repos/${tok.repo}/contents/${encodeURIComponent(filePath)}`, {
        method: 'PUT', headers: h,
        body: JSON.stringify({
          message: (typeof message === 'string' && message.trim()) ? message : `Kiln API: update ${filePath}`,
          content: b64FromUtf8(html), sha: cur.sha,
          author: { name: `${tok.name} (via Kiln API)`, email: 'kiln-api@users.noreply.github.com' },
        }),
      });
      if (put.ok) {
        const out = await put.json();
        return json({ ok: true, commit: { sha: out.commit?.sha, url: out.commit?.html_url }, applied, skipped });
      }
      const err = await put.json().catch(() => ({}));
      const conflict = put.status === 409 || (put.status === 422 && /sha/i.test(err.message || ''));
      if (!conflict) return json({ error: 'commit failed', detail: err.message || String(put.status) }, 502);
    }
    return json({ error: 'conflict: page changed while editing, try again' }, 409);
  } catch {
    return json({ error: 'could not apply edits safely' }, 502);
  }
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
  //   Executable/script assets — an editor writes content, never code. Blocking
  //   these stops a scoped editor committing JS/WASM the page could load (which
  //   would run with the site's full privileges) and complements the HTML
  //   content guard (checkDocumentWrite) below.
  if (/\.(m?js|cjs|jsx|tsx?|wasm)$/i.test(lower)) return true;
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

// Suggest-mode publish guard: a suggest-mode editor edits normally but cannot
// land anything on the live branch — their Publish goes through /suggestions,
// and the only DIRECT writes allowed are to kiln scratch branches (kiln-… /
// kiln/…, e.g. kiln-drafts and kiln/suggest-* previews). Enforced fail-closed:
//   • PUT /contents: the body's `branch` must name a kiln branch. An absent
//     branch means the repo default — blocked, as is main/master/anything else.
//   • PATCH /git/refs/heads/<b>: only kiln heads may move.
//   • POST /git/refs: may only create refs/heads/kiln* heads. Tag refs are left
//     to the existing rules (named versions are feature-gated away from suggest
//     editors, so no extra machinery here).
// Reads are untouched, as are the git-data POSTs (blobs/trees/commits) — those
// become visible only when a ref points at them, and refs are guarded above.
// `body` is the request's parsed JSON body (null when absent/non-JSON, which
// for PUT /contents means no branch → blocked). Exported for unit tests.
const KILN_BRANCH_RE = /^kiln[/-]/;
function suggestWriteViolation(method, path, body) {
  const deny = 'suggest-mode: publish goes through suggestions';
  let clean = String(path).split('?')[0];
  // Decode before matching: GitHub's router accepts %2F-encoded refs, so
  // `/git/refs/heads%2Fmain` must be judged as `/git/refs/heads/main`.
  try { clean = decodeURIComponent(clean); } catch { /* malformed — judge raw */ }
  if (method === 'PUT' && clean.includes('/contents/')) {
    const branch = body && typeof body.branch === 'string' ? body.branch : '';
    if (!KILN_BRANCH_RE.test(branch)) return deny;
  }
  const heads = /\/git\/refs\/heads\/(.+)$/.exec(clean);
  if (method === 'PATCH' && heads && !KILN_BRANCH_RE.test(heads[1])) return deny;
  if (method === 'POST' && /\/git\/refs$/.test(clean)) {
    const ref = body && typeof body.ref === 'string' ? body.ref : '';
    if (ref.startsWith('refs/heads/') && !KILN_BRANCH_RE.test(ref.slice('refs/heads/'.length))) return deny;
  }
  return null;
}

async function ghProxy(request, env, ghPath) {
  const sessId = request.headers.get('X-Kiln-Session') || '';
  if (!/^[a-f0-9]{64}$/.test(sessId)) return json({ error: 'missing session' }, 401);
  const sess = await env.KILN.get(`esess:${sessId}`, 'json');
  if (!sess) return json({ error: 'session expired' }, 401);
  // Trust the stored expiry, not only KV's TTL.
  if (sess.exp && sess.exp < Date.now()) return json({ error: 'session expired' }, 401);
  if (sess.role !== 'editor') return json({ error: 'not an editor session' }, 403);

  // Path traversal guard (ALL methods): the allowlist matches on the raw path,
  // but GitHub's fetch collapses `..` — so `/repos/OWNER/A/contents/../../B/…`
  // passes the `startsWith` prefix yet lands on repo B (same installation token).
  // Reject any `..` segment, decoded, before it can slip past the allowlist.
  {
    let decoded = ghPath;
    try { decoded = decodeURIComponent(ghPath); } catch { /* keep raw */ }
    if (/(^|[/\\])\.\.([/\\]|$)/.test(decoded) || /%2e%2e/i.test(ghPath)) {
      return json({ error: 'bad path' }, 400);
    }
  }

  if (!proxyAllowed(request.method, ghPath, sess.repo)) {
    return json({ error: 'path not allowed', path: ghPath }, 403);
  }

  // Defense-in-depth + per-editor scope: editors may not write domain/redirect/CI
  // config, nor anything outside the paths granted to them in People & access.
  const cleanPath = ghPath.split('?')[0];

  // Suggest-mode sessions: direct writes may only touch kiln scratch branches —
  // publishing to the live branch goes through the suggestions queue. Checked
  // FIRST so a misdirected publish gets the intentional 403 before we spend
  // GitHub calls on content verification.
  // Review-mode sessions are comment-only: the proxy is read-only for them.
  if (sess.mode === 'review' && !['GET', 'HEAD'].includes(request.method)) {
    return json({ error: 'review-mode: comment-only access' }, 403);
  }
  if (sess.mode === 'suggest' && !['GET', 'HEAD'].includes(request.method)) {
    let sbody = null;
    try { sbody = JSON.parse(await request.clone().text()); } catch { /* non-JSON → treated as branch-less */ }
    const deny = suggestWriteViolation(request.method, ghPath, sbody);
    if (deny) return json({ error: deny }, 403);
  }

  if (request.method === 'PUT' && cleanPath.includes('/contents/')) {
    const filePath = decodeURIComponent(cleanPath.split('/contents/')[1] || '');
    if (isSensitivePath(filePath)) return json({ error: 'forbidden path for editor' }, 403);
    if (!pathInScope(filePath, sess.paths)) return json({ error: 'outside your editing scope', path: filePath }, 403);
    // Content guard (C2): an editor session bypasses the browser's DOMPurify by
    // PUTting raw markup here. For HTML pages, refuse any write that INTRODUCES
    // executable markup (script/handlers/dangerous URLs/framing) not already in
    // the committed version. Fails CLOSED — a guard error blocks the write.
    if (isHtmlPath(filePath)) {
      let newHtml, curSha;
      try { const b = JSON.parse(await request.clone().text()); newHtml = utf8FromB64(b.content); curSha = b.sha; }
      catch { return json({ error: 'unreadable write body' }, 400); }
      if (newHtml === undefined) return json({ error: 'write needs content' }, 400);
      let oldHtml = null;
      if (curSha) {
        try {
          const itok0 = await installationToken(env, sess.repo);
          const blob = await fetch(`${GH}/repos/${sess.repo}/git/blobs/${curSha}`,
            { headers: { Authorization: `Bearer ${itok0}`, Accept: 'application/vnd.github+json', 'User-Agent': UA } });
          if (blob.ok) oldHtml = utf8FromB64((await blob.json()).content);
          else return json({ error: 'could not verify page content safely' }, 502);
        } catch { return json({ error: 'could not verify page content safely' }, 502); }
      }
      const bad = checkDocumentWrite(oldHtml, newHtml);
      if (bad) return json({ error: 'blocked: editors cannot add scripts or executable markup to a page', detail: bad }, 403);
    }
  }
  if (request.method === 'POST' && /\/git\/trees$/.test(cleanPath)) {
    const peek = await request.clone().text();
    try {
      const parsed = JSON.parse(peek);
      if (Array.isArray(parsed.tree)) {
        // A subtree entry (type:"tree") pulls in a whole subtree we can't see —
        // editors must submit blob-level entries only, each individually scoped.
        if (parsed.tree.some(e => e && e.type === 'tree')) {
          return json({ error: 'editors may not submit subtree entries' }, 403);
        }
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

  // Git-data write scope (C1): `git/trees` is peeked above, but `git/commits`
  // and `git/refs` could otherwise point main at ANY tree/commit — bypassing
  // path scope (rollback the whole site, swap in an out-of-scope tree, inject
  // .github). Two guards make the whole Git-data write chain safe:
  //   • ref writes: forbid `force` (GitHub then enforces fast-forward-only, so a
  //     scoped editor can only ADVANCE the branch, never rewrite/rollback it);
  //   • commit creates: diff the proposed tree against its parent and require
  //     every changed path to be in-scope and non-sensitive.
  if (!sess.admin && (request.method === 'POST' || request.method === 'PATCH')
      && /\/git\/refs(\/|$)/.test(cleanPath)) {
    try { if (JSON.parse(await request.clone().text())?.force) return json({ error: 'editors may not force-update refs' }, 403); }
    catch { /* non-JSON — allowlist gated the route */ }
  }
  if (!sess.admin && request.method === 'POST' && /\/git\/commits$/.test(cleanPath)) {
    const scopeErr = await commitDiffInScope(env, itok, sess, await request.clone().text());
    if (scopeErr) return scopeErr;
  }

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

/**
 * Reject a proposed commit whose diff (vs its first parent) touches any path
 * outside the editor's scope or any sensitive path. Returns a 403 Response to
 * short-circuit, or null when the commit is in-scope. Fails CLOSED on any error.
 */
async function commitDiffInScope(env, itok, sess, bodyText) {
  let tree, parents;
  try { const b = JSON.parse(bodyText); tree = b.tree; parents = b.parents; }
  catch { return json({ error: 'unreadable commit body' }, 400); }
  if (!tree) return json({ error: 'commit needs a tree' }, 400);
  const gh = async (p) => {
    const r = await fetch(`${GH}${p}`, { headers: { Authorization: `Bearer ${itok}`, Accept: 'application/vnd.github+json', 'User-Agent': UA } });
    if (!r.ok) throw new Error(`gh ${p} ${r.status}`);
    return r.json();
  };
  try {
    const newTree = await gh(`/repos/${sess.repo}/git/trees/${tree}?recursive=1`);
    // A truncated tree means we can only see PART of it — an out-of-scope change
    // beyond the cutoff would go unchecked, so refuse rather than fail open.
    const before = new Map();
    const parentSha = Array.isArray(parents) ? parents[0] : null;
    if (parentSha) {
      const pc = await gh(`/repos/${sess.repo}/git/commits/${parentSha}`);
      const pt = await gh(`/repos/${sess.repo}/git/trees/${pc.tree.sha}?recursive=1`);
      if (pt.truncated) return json({ error: 'repo too large to verify commit scope safely' }, 413);
      for (const e of pt.tree || []) if (e.type === 'blob') before.set(e.path, e.sha);
    }
    if (newTree.truncated) return json({ error: 'commit too large to verify scope safely' }, 413);
    const after = new Map();
    for (const e of newTree.tree || []) if (e.type === 'blob') after.set(e.path, e.sha);
    // Every path whose blob changed, was added, or was removed must be in scope.
    const changed = new Set();
    for (const [p, sha] of after) if (before.get(p) !== sha) changed.add(p);
    for (const p of before.keys()) if (!after.has(p)) changed.add(p);
    for (const p of changed) {
      if (isSensitivePath(p)) return json({ error: 'commit touches a forbidden path', path: p }, 403);
      if (!pathInScope(p, sess.paths)) return json({ error: 'commit touches a path outside your scope', path: p }, 403);
    }
    // Content guard on the git-data write path (new post / multi-file commit):
    // for every changed HTML blob, diff its markup against the parent version and
    // refuse any newly-introduced executable content. Fails CLOSED on any error.
    const blobText = async (sha) => {
      const r = await fetch(`${GH}/repos/${sess.repo}/git/blobs/${sha}`, { headers: { Authorization: `Bearer ${itok}`, Accept: 'application/vnd.github+json', 'User-Agent': UA } });
      if (!r.ok) throw new Error(`blob ${sha} ${r.status}`);
      return utf8FromB64((await r.json()).content);
    };
    for (const p of changed) {
      if (!isHtmlPath(p) || !after.has(p)) continue; // removals need no content check
      const newHtml = await blobText(after.get(p));
      const oldHtml = before.has(p) ? await blobText(before.get(p)) : null;
      const bad = checkDocumentWrite(oldHtml, newHtml);
      if (bad) return json({ error: 'blocked: editors cannot add scripts or executable markup to a page', path: p, detail: bad }, 403);
    }
    return null;
  } catch (err) {
    return json({ error: 'could not verify commit scope', detail: String(err.message || err) }, 502);
  }
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
