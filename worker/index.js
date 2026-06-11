/**
 * kiln-auth — the one tiny server Kiln needs.
 *
 * What it does:
 *   1. One-time setup: registers Kiln as a GitHub App via the manifest flow
 *      (you click one button; credentials land in KV automatically).
 *   2. GitHub App OAuth for admins (single-repo scope, 8-hour expiring tokens,
 *      refresh tokens held server-side in KV — never shipped to the browser).
 *   3. Magic-link editor sessions: admins mint invite links; editors redeem
 *      them and commit through the /gh/* proxy using the App's installation
 *      token. Editors never need a GitHub account.
 *
 * Routes:
 *   GET  /setup            one-time GitHub App registration page
 *   GET  /setup/callback   manifest conversion (GitHub redirects here)
 *   GET  /setup/status     {configured, slug, app_id}
 *   GET  /auth/login       ?origin=&return_to= → GitHub authorize
 *   GET  /auth/callback    code+state → tokens → redirect w/ #fragment
 *   POST /auth/refresh     {sid} → fresh access token
 *   POST /auth/logout      {sid}
 *   POST /admin/invite     Bearer <gh token> + {repo,name,role,days}
 *   POST /editor/redeem    {invite} → editor session
 *   ANY  /gh/*             session-scoped GitHub API proxy (editors)
 *
 * KV (binding: KILN):
 *   app:creds   {app_id, slug, client_id, client_secret, pk8}
 *   state:<n>   OAuth state nonce            (TTL 10 min)
 *   sid:<id>    {refresh_token}              (TTL 180 days, rotated)
 *   inv:<id>    {repo,name,role}             (TTL = invite expiry, single-use)
 *   esess:<id>  {repo,name,role}             (TTL 30 days)
 *   itok:<repo> cached installation token    (TTL 50 min)
 *
 * Env vars: ALLOWED_ORIGINS — comma-separated site origins allowed to use auth.
 */

const GH = 'https://api.github.com';
const UA = 'kiln-auth-worker';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === 'OPTIONS') return cors(env, request, new Response(null, { status: 204 }));

      if (path === '/healthz') return new Response('ok');
      if (path === '/setup') return setupPage(url, env);
      if (path === '/setup/callback') return setupCallback(url, env);
      if (path === '/setup/status') return setupStatus(env);
      if (path === '/setup/install-check') {
        const repo = url.searchParams.get('repo') || '';
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: 'bad repo' }, 400);
        const tok = await installationToken(env, repo);
        return json({ repo, installed: !!tok });
      }
      if (path === '/auth/login') return authLogin(url, env);
      if (path === '/auth/callback') return authCallback(url, env);
      if (path === '/auth/refresh' && request.method === 'POST') return cors(env, request, await authRefresh(request, env));
      if (path === '/auth/logout' && request.method === 'POST') return cors(env, request, await authLogout(request, env));
      if (path === '/admin/invite' && request.method === 'POST') return cors(env, request, await adminInvite(request, env));
      if (path === '/admin/invites' && request.method === 'GET') return cors(env, request, await adminListInvites(request, env, url));
      if (path === '/admin/revoke' && request.method === 'POST') return cors(env, request, await adminRevoke(request, env));
      if (path === '/editor/redeem' && request.method === 'POST') return cors(env, request, await editorRedeem(request, env));
      if (path.startsWith('/gh/')) return cors(env, request, await ghProxy(request, env, path.slice(3) + url.search));

      return new Response('kiln-auth: not found', { status: 404 });
    } catch (err) {
      console.error('[kiln-auth]', err.stack || err);
      return cors(env, request, json({ error: 'internal', message: String(err.message || err) }, 500));
    }
  },
};

// ─── CORS ────────────────────────────────────────────────────────────────────

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function cors(env, request, response) {
  const origin = request.headers.get('Origin');
  const ok = origin && allowedOrigins(env).includes(origin);
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
  if (!allowedOrigins(env).includes(origin)) {
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

// ─── Magic-link editors ──────────────────────────────────────────────────────

async function adminInvite(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^(token|Bearer)\s+/i, '');
  if (!token) return json({ error: 'missing Authorization' }, 401);

  const { repo, name, role = 'editor', days = 14 } = await request.json().catch(() => ({}));
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: 'bad repo' }, 400);
  if (!name || name.length > 64) return json({ error: 'bad name' }, 400);
  if (!['editor', 'member'].includes(role)) return json({ error: 'bad role' }, 400);

  // Only someone who can already push to the repo may mint invites for it.
  const res = await fetch(`${GH}/repos/${repo}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': UA },
  });
  if (!res.ok) return json({ error: 'repo check failed', status: res.status }, 403);
  const repoInfo = await res.json();
  if (!repoInfo.permissions || !repoInfo.permissions.push) {
    return json({ error: 'you need push access to invite' }, 403);
  }

  const id = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  // `days` = how long the ACCESS lasts once redeemed (1–360). The unredeemed
  // link itself also expires after the same period.
  const sessionDays = Math.min(Math.max(Number(days) || 30, 1), 360);
  const ttl = sessionDays * 24 * 3600;
  await env.KILN.put(`inv:${id}`,
    JSON.stringify({ repo, name, role, sessionDays, created: Date.now(), exp: Date.now() + ttl * 1000 }),
    { expirationTtl: ttl });
  return json({ invite: id, role, days: sessionDays });
}

/** Anyone with push access can see + revoke the invites/sessions for that repo. */
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

async function adminListInvites(request, env, url) {
  const repo = url.searchParams.get('repo') || '';
  if (!(await requirePush(request, repo))) return json({ error: 'forbidden' }, 403);

  async function collect(prefix) {
    const out = [];
    let cursor;
    do {
      const page = await env.KILN.list({ prefix, cursor });
      for (const k of page.keys) {
        const v = await env.KILN.get(k.name, 'json');
        if (v && v.repo === repo) out.push({ id: k.name.slice(prefix.length), ...v });
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    return out;
  }

  return json({ invites: await collect('inv:'), sessions: await collect('esess:') });
}

async function adminRevoke(request, env) {
  const { repo, kind, id } = await request.json().catch(() => ({}));
  if (!(await requirePush(request, repo))) return json({ error: 'forbidden' }, 403);
  if (!['invite', 'session'].includes(kind) || !/^[a-f0-9]{64}$/.test(id || '')) return json({ error: 'bad request' }, 400);
  const key = (kind === 'invite' ? 'inv:' : 'esess:') + id;
  const existing = await env.KILN.get(key, 'json');
  if (!existing || existing.repo !== repo) return json({ error: 'not found' }, 404);
  await env.KILN.delete(key);
  return json({ ok: true });
}

async function editorRedeem(request, env) {
  const { invite } = await request.json().catch(() => ({}));
  if (!invite || !/^[a-f0-9]{64}$/.test(invite)) return json({ error: 'bad invite' }, 400);
  const inv = await env.KILN.get(`inv:${invite}`, 'json');
  if (!inv) return json({ error: 'invite expired or already used' }, 404);
  await env.KILN.delete(`inv:${invite}`); // single use

  const session = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const days = Math.min(Math.max(Number(inv.sessionDays) || 30, 1), 360);
  const exp = Date.now() + days * 24 * 3600 * 1000;
  await env.KILN.put(`esess:${session}`,
    JSON.stringify({ ...inv, created: Date.now(), exp }),
    { expirationTtl: days * 24 * 3600 });
  return json({ session, name: inv.name, repo: inv.repo, role: inv.role, exp });
}

// ─── GitHub proxy for editor sessions ────────────────────────────────────────

const PROXY_RULES = [
  { methods: ['GET'], path: r => `/repos/${r}` },
  { methods: ['GET', 'PUT'], path: r => `/repos/${r}/contents/` },
  { methods: ['GET'], path: r => `/repos/${r}/commits` },
  { methods: ['GET'], path: r => `/repos/${r}/deployments` },
  { methods: ['GET'], path: r => `/repos/${r}/git/` },
  { methods: ['POST'], path: r => `/repos/${r}/git/blobs` },
  { methods: ['POST'], path: r => `/repos/${r}/git/trees` },
  { methods: ['POST'], path: r => `/repos/${r}/git/commits` },
  { methods: ['POST', 'PATCH'], path: r => `/repos/${r}/git/refs` },
];

function proxyAllowed(method, path, repo) {
  return PROXY_RULES.some(rule => {
    const p = rule.path(repo);
    const match = p.endsWith('/') ? path.startsWith(p) : (path === p || path.startsWith(p + '/') || path.startsWith(p + '?'));
    return match && rule.methods.includes(method);
  });
}

async function ghProxy(request, env, ghPath) {
  const sessId = request.headers.get('X-Kiln-Session') || '';
  if (!/^[a-f0-9]{64}$/.test(sessId)) return json({ error: 'missing session' }, 401);
  const sess = await env.KILN.get(`esess:${sessId}`, 'json');
  if (!sess) return json({ error: 'session expired' }, 401);
  if (sess.role !== 'editor') return json({ error: 'not an editor session' }, 403);

  if (!proxyAllowed(request.method, ghPath, sess.repo)) {
    return json({ error: 'path not allowed', path: ghPath }, 403);
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
