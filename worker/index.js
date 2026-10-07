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
 *   POST /members/check    {sid, origin} → is this member sign-in still on the list
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
 *   POST /ai/assist        scoped BYO-key AI: revise text / alt text / template fill
 *                          (needs the AI_API_KEY secret; editors need the 'ai' feature)
 *   GET  /healthz          capability handshake: {ok, modes, adapters, version}
 *   POST /source/commit    source mode: typed edits → one commit on a content file
 *   POST /source/read      source mode: what one field of a content file holds now (a Markdown body, before it is edited)
 *   POST /source/revert    source mode: restore a file to its content at a given sha
 *   POST /source/duplicate source mode: copy a content file to a free -copy sibling
 *
 * KV (binding: KILN):
 *   app:creds   {app_id, slug, client_id, client_secret, pk8}
 *   state:<n>   OAuth state nonce            (TTL 10 min)
 *   sid:<id>    {refresh_token}              (TTL 180 days, rotated)
 *   people:<repo> [{email,name,role,days,paths?}]  editor/member allowlist
 *   rid:<id>      {id,name,was?,at,from?,moved?}  a repository by its GitHub id: the name its data is
 *                 filed under, and (from) the names a move is still bringing data from
 *   rname:<repo>  {id,at}            which repository a name is (lowercased); see "Repository identity"
 *   rsee:<repo>   {id,name}          GitHub's last answer for a name  (TTL 10 min)
 *   rmove:<id>    {id,to,at,done,cursor?}  how far an unfinished move has got; gone when it is done
 *   msess:<sid>   {repo,email,origin,rid?}  a member's sign-in on a site, so removal can end it
 *   esess:<id>  {repo,name,role,email,paths,rid?}  (TTL = person.days; rid = the id of the repository it is for)
 *   atok:<sha>  {id,repo,name,paths,keys,readonly,created,exp,rid?}  API token, keyed by SHA-256(secret)  (TTL = days)
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
// Reported by /healthz for the editor's capability handshake (§13). Keep in
// step with package.json "version" when cutting a release.
const WORKER_VERSION = '0.4.0';

import { handleCloud, expireStaleTrials, cloudSiteForOrigin } from './cloud.js';
import { applyEdits, indexHtml, readValues, pageFileCandidates, safeUrl } from '../src/engine.js';
import { checkDocumentWrite, checkFragment, checkFragmentWrite, isHtmlPath } from './sanitize-guard.js';
import { adapterIds } from '../src/adapters/index.js';
import { sourceModeRefusal, validateSourceRequest, refuseSourcePath, typedEditProblems, changedSinceRead, markdownProblems, duplicateCandidates, SOURCE_FILE_GONE } from './source.js';
import { uploadProblem, editorFileKind, isUploadKind, base64Bytes, base64Head, UPLOAD_MAX_BYTES, FILE_MESSAGES } from '../src/file-policy.js';

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
    // Each job on its own: one failing must not stop the other, and a failure
    // must leave a line someone can find (Workers Logs, when observability is on).
    await cronJob('schedules', () => runDueSchedules(env));
    await cronJob('trials', () => expireStaleTrials(env));
    // After the schedules: that pass is what files scheduled publishes under a
    // repository's new name, and a move can only finish once it has.
    await cronJob('moves', () => continueMoves(env));
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

      // Capability handshake (SOURCE-MODE-SPEC §13): the editor reads `modes`
      // to decide whether this worker can edit generator sources — a healthz
      // without it means an old worker and source fields render read-only.
      // Still a 200 that says ok, so status-probing monitors keep working.
      if (path === '/healthz') {
        // `renameMovesAll` tells `kiln doctor` that this worker brings everything a
        // site stores along when its repository is renamed, not the people list alone.
        // `sourceWas`: an edit to a content file that says what its field held is
        // left out when the file no longer says that (worker/source.js changedSinceRead).
        // `sourceMarkdown`: a formatted Markdown body (and MDX prose) may be written,
        // keeping the markup and the code it holds (markdownProblems, astro sameCode).
        const basic = { ok: true, modes: ['html', 'source'], adapters: adapterIds(), version: WORKER_VERSION, memberSessions: true, renameMovesAll: true, sourceWas: true, sourceMarkdown: true, ...deployedBuild(env) };
        // ?deep=1 asks the things publishing depends on. A plain GET stays a
        // constant 200 that touches nothing, as every editor and monitor expects.
        if (url.searchParams.get('deep') === '1') {
          const limited = await rateLimited(request, env);
          if (limited) return limited;
          const deep = await deepHealth(env);
          return await cors(env, request, json({ ...basic, ok: deep.failed.length === 0, checks: deep.checks, failed: deep.failed }, deep.failed.length ? 503 : 200));
        }
        return await cors(env, request, json(basic));
      }
      if (path === '/setup') return setupPage(url, env);
      if (path === '/setup/callback') return setupCallback(url, env);
      if (path === '/setup/status') return setupStatus(env);
      if (path === '/setup/install-check') {
        const limited = await rateLimited(request, env);
        if (limited) return limited;
        const repo = url.searchParams.get('repo') || '';
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: 'bad repo' }, 400);
        const tok = await installationToken(env, repo);
        // For `kiln doctor`: does GitHub still know this repository by this
        // name, and is it the repository the worker has on record for it?
        // Booleans only: the current name of a private repository is not
        // handed to whoever asks about an old one.
        return json({ repo, installed: !!tok, ...(tok ? await repoStanding(env, repo) : {}) });
      }
      if (path === '/auth/login') return authLogin(url, env);
      if (path === '/auth/callback') return authCallback(url, env);
      if (path === '/auth/refresh' && request.method === 'POST') return await cors(env, request, await authRefresh(request, env));
      if (path === '/auth/logout' && request.method === 'POST') return await cors(env, request, await authLogout(request, env));
      if (path === '/members/check' && request.method === 'POST') return await memberCheck(request, env);
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
      if (path === '/ai/assist' && request.method === 'POST') return (await rateLimited(request, env)) || await cors(env, request, await aiAssist(request, env));
      if (path === '/source/commit' && request.method === 'POST') return (await rateLimited(request, env)) || await cors(env, request, await sourceCommit(request, env));
      if (path === '/source/read' && request.method === 'POST') return (await rateLimited(request, env)) || await cors(env, request, await sourceReadField(request, env));
      if (path === '/source/revert' && request.method === 'POST') return (await rateLimited(request, env)) || await cors(env, request, await sourceRevert(request, env));
      if (path === '/source/duplicate' && request.method === 'POST') return (await rateLimited(request, env)) || await cors(env, request, await sourceDuplicate(request, env));
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

/** Run one scheduled job, and say in one structured line how it went. Never throws. */
async function cronJob(job, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(JSON.stringify({ evt: 'cron', job, ok: true, ms: Date.now() - t0 }));
  } catch (err) {
    console.error(JSON.stringify({ evt: 'cron', job, ok: false, ms: Date.now() - t0, error: String((err && err.message) || err).slice(0, 300) }));
  }
}

/**
 * The deep health check: can this worker do what publishing needs right now?
 *   kv    the KV namespace answers
 *   d1    the Kiln Cloud database answers (only where one is bound)
 *   app   the GitHub App's credentials are there, its key can sign, and GitHub
 *         accepts what it signs
 * Each is 'ok', 'failed' or 'not configured'. Only those words leave here:
 * never an error message, a key or an id.
 */
async function deepHealth(env) {
  const checks = {};
  let creds = null;
  try { creds = await env.KILN.get('app:creds', 'json'); checks.kv = 'ok'; }
  catch { checks.kv = 'failed'; }
  if (env.kiln_cloud) {
    try { await env.kiln_cloud.prepare('SELECT 1 AS up').first(); checks.d1 = 'ok'; }
    catch { checks.d1 = 'failed'; }
  } else checks.d1 = 'not configured';
  if (checks.kv === 'failed') checks.app = 'failed';
  else if (!creds) checks.app = 'not configured';   // a worker nobody has run /setup on cannot publish
  else {
    try {
      const jwt = await appJwt(creds);
      const res = await fetch(`${GH}/app`, { headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': UA } });
      checks.app = res.ok ? 'ok' : 'failed';
    } catch { checks.app = 'failed'; }
  }
  const failed = Object.keys(checks).filter(k => checks[k] === 'failed' || (k === 'app' && checks[k] === 'not configured'));
  return { checks, failed };
}

/**
 * Which build is this? `build` is the commit the worker was deployed from,
 * passed at deploy time (scripts/release.mjs: --var KILN_BUILD:<sha>), and
 * `deploy` is Cloudflare's own record of the upload when that binding exists.
 * Both are absent on a worker deployed by hand; neither is a secret.
 */
function deployedBuild(env) {
  const out = {};
  if (typeof env.KILN_BUILD === 'string' && /^[\w.-]{1,40}$/.test(env.KILN_BUILD)) out.build = env.KILN_BUILD;
  const meta = env.CF_VERSION_METADATA;
  if (meta && typeof meta === 'object' && meta.id) out.deploy = { id: String(meta.id), tag: String(meta.tag || ''), at: String(meta.timestamp || '') };
  return out;
}

// ─── CORS ────────────────────────────────────────────────────────────────────

async function originAllowed(env, origin) {
  if (!origin) return false;
  const envList = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (envList.includes(origin)) return true;          // static: demo, self-host, localhost
  if (env.kiln_cloud) {
    // Kiln Cloud: a site that is paying or trialing, or still inside what it
    // paid for after cancelling, or inside the grace after a failed charge.
    try {
      if (await cloudSiteForOrigin(env, origin)) return true;
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

/**
 * True if the bearer GitHub token has push access to the repo (the site owner).
 *
 * GitHub's answer also carries the repository's id, which never changes. With
 * `env` given, that id is put on record for the name, and a name that is on
 * record as a DIFFERENT repository with people stored under it is refused:
 * push access to whatever now answers to an old name is not ownership of the
 * site that used to have it (KLR-08). See "Repository identity" below.
 */
async function requirePush(request, repo, env) {
  const auth = (request.headers.get('Authorization') || '').replace(/^(token|Bearer)\s+/i, '');
  if (!auth || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return false;
  const res = await fetch(`${GH}/repos/${repo}`, {
    headers: { Authorization: `Bearer ${auth}`, Accept: 'application/vnd.github+json', 'User-Agent': UA },
  });
  if (!res.ok) return false;
  const info = await res.json();
  if (!info.permissions?.push) return false;
  if (env && Number.isInteger(info.id)) {
    const seen = { id: info.id, name: typeof info.full_name === 'string' ? info.full_name : repo };
    if (!(await admitRepo(env, repo, seen))) { pushRefusal.set(request, REPO_CHANGED); return false; }
  }
  return true;
}

// Why requirePush said no, when the reason is worth telling the person asking.
const pushRefusal = new WeakMap();
const REPO_CHANGED = 'This name now belongs to a different repository than the one these people were added to, so their list is not shown or changed here. If the repository was renamed or moved, set repo in kiln-config.js to its current owner/name. If it was deleted and made again, run kiln doctor: it says how to start a new list.';

/** The answer to an owner request that requirePush turned down. */
function forbidden(request) {
  const why = pushRefusal.get(request);
  return json(why ? { error: why, code: 'repo_changed' } : { error: 'forbidden' }, 403);
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
// (Functions only: the runtime refuses to start a worker with any other kind of named export.)
export { pathInScope, isSensitivePath, normalizePaths, keyInScope, apiPageFilter, apiFieldsFor, apiPageCandidates, validateApiEdits, validateCommentInput, commentKey, normalizePagePath, validateSuggestionInput, suggestWriteViolation, validateAiAssist, aiHostBlocked, moveBounds };

// ─── Scheduled publishing ────────────────────────────────────────────────────
// sched:<id> → { repo, path, branch, content(b64), message, at, desc, by }
// A cron tick commits every due entry using the App installation token.

async function authActor(request, env, repo) {
  // Either an admin's GitHub token (push access) or an editor session for this repo.
  const sess = request.headers.get('X-Kiln-Session');
  if (sess && /^[a-f0-9]{64}$/.test(sess)) {
    const e = await env.KILN.get(`esess:${sess}`, 'json');
    // A session is on a repository, not on a spelling: a site whose config
    // still has the name from before a rename or a transfer is the same site.
    // And not on a name either: if the name asked with now answers as another
    // repository than the session's, this is no session for it.
    if (e && (!e.exp || e.exp >= Date.now()) && e.role === 'editor' && (e.repo === repo || await sameOnRecord(env, e.repo, repo)) && !(await answersAsAnother(env, repo, e.rid))) return { name: e.name, email: e.email, paths: e.paths || [''], keys: e.keys || [], mode: e.mode || null, features: e.features || null, admin: false };
  }
  if (await requirePush(request, repo, env)) return { name: 'admin', admin: true };
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
  // The Schedule grant, held here as well as in the editor's menu.
  if (!hasGrant(actor, 'schedule')) return grantRefusal('schedule');
  // Content guard for non-admin editors: scheduled field edits are re-applied
  // raw against live source at fire time (runDueSchedules → applyEdits), so
  // sanitize them at creation. Reject any executable markup in a field's HTML,
  // and refuse full-page `content` snapshots from editors (they can't be diffed
  // safely — editors schedule field-level `edits`, which the UI always sends).
  if (!actor.admin) {
    // The fragment check below reads markup the way an HTML page is parsed; a
    // file served as XML (.xhtml, .svg, …) would read the same bytes differently.
    if (!isHtmlPath(path)) return json({ error: 'editors can only schedule edits to HTML pages' }, 403);
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
  // Filed under the name the repository's things are under, which is not
  // always the one this site's config has (a renamed repository).
  const { home } = await shelf(env, repo);
  await env.KILN.put(`sched:${id}`,
    JSON.stringify({ repo: home, path, branch, edits: edits || null, content: edits ? null : content, message: message || 'Scheduled publish (via Kiln)', at: when, desc: desc || path, by: actor.name, byEmail: actor.email, admin: !!actor.admin }),
    { expirationTtl: Math.ceil((when - Date.now()) / 1000) + 14 * 24 * 3600 });
  return json({ ok: true, id, at: when });
}

async function scheduleList(request, env, url) {
  const repo = url.searchParams.get('repo') || '';
  const actor = await authActor(request, env, repo);
  if (!actor) return json({ error: 'forbidden' }, 403);
  const mine = new Set([repo, ...(await shelf(env, repo)).names]);
  const out = [];
  let cursor;
  do {
    const page = await env.KILN.list({ prefix: 'sched:', cursor });
    for (const k of page.keys) {
      const v = await env.KILN.get(k.name, 'json');
      if (v && mine.has(v.repo)) out.push({ id: k.name.slice(6), at: v.at, desc: v.desc, path: v.path, by: v.by });
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
  if (!v || (v.repo !== repo && !(await shelf(env, repo)).names.includes(v.repo))) return json({ error: 'not found' }, 404);
  await env.KILN.delete(`sched:${id}`);
  return json({ ok: true });
}

/**
 * The name to reach a repository by when the worker publishes on its own: the
 * one GitHub has for it now, so a publish scheduled before a rename lands in
 * the renamed repository without leaning on a redirect. null when the stored
 * name has become a different repository: that one is never published to.
 * A name the worker has no id on record for is used as it is, as before.
 * (The rule itself is whoAnswers.)
 */
async function publishName(env, repo) {
  const { id, seen, other } = await whoAnswers(env, repo);
  if (id === null || !seen) return repo;   // GitHub cannot be asked: the publish below waits for the next run by itself
  return other ? null : seen.name;
}

async function runDueSchedules(env) {
  // Repositories whose things are moving to a new name. A scheduled publish
  // that still names the old one is filed under the new one HERE, in the only
  // place that also publishes and deletes schedules: one pass reads each
  // schedule once, so it can be moved and published, never published twice.
  const moving = await movesUnderWay(env);
  let cursor;
  do {
    const page = await env.KILN.list({ prefix: 'sched:', cursor });
    for (const k of page.keys) {
      let v = await env.KILN.get(k.name, 'json');
      if (!v) continue;
      const move = moving.get(v.repo);
      if (move) {
        v = { ...v, repo: move.to };
        const keep = keepExpiry(k);
        if (keep !== null) await env.KILN.put(k.name, JSON.stringify(v), keep);
      }
      if (v.at > Date.now()) continue;
      // Whatever answers to the stored name now must be the repository the
      // schedule was made for. If the name has changed hands, the schedule
      // waits where it is: for its site to say where the repository went, or
      // for its expiry.
      let target;
      try { target = await publishName(env, v.repo); } catch { continue; }
      if (!target) { console.log(`[kiln-cron] ${k.name} not published: its repository's name now answers as another repository`); continue; }
      // Re-validate scope at fire time. A non-admin editor's access may have been
      // narrowed or their scope changed since they scheduled this (peopleUpsert
      // purges live sessions but leaves schedules); enforce the CURRENT scope so a
      // revoked path can't still publish. `admin === false` is stored explicitly;
      // legacy records without the field are left alone (can't retro-check).
      if (v.admin === false) {
        const people = await getPeople(env, v.repo);
        const p = people.find(x => x.email === v.byEmail && x.role === 'editor');
        if (!p || isSensitivePath(v.path) || !pathInScope(v.path, p.paths) || !isHtmlPath(v.path)) {
          await env.KILN.delete(k.name);
          continue;
        }
      }
      try {
        const itok = await installationToken(env, target);
        if (!itok) continue;
        const h = { Authorization: `Bearer ${itok}`, Accept: 'application/vnd.github+json', 'User-Agent': UA, 'Content-Type': 'application/json' };
        const cur = await fetch(`${GH}/repos/${target}/contents/${encodeURIComponent(v.path)}?ref=${v.branch}`, { headers: h });
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
        const res = await fetch(`${GH}/repos/${target}/contents/${encodeURIComponent(v.path)}`, {
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
  // Every schedule has been read once: none names an old name any more.
  for (const [id, to] of new Map([...moving.values()].map(m => [m.id, m.to]))) {
    const mv = await env.KILN.get(`rmove:${id}`, 'json');
    if (mv && mv.to === to && !(mv.done && mv.done.sched)) {
      await env.KILN.put(`rmove:${id}`, JSON.stringify({ ...mv, done: { ...(mv.done || {}), sched: true } }));
    }
  }
}

// ─── Presence (who else is editing this page right now) ─────────────────────
// pres:<repo>:<path>:<name> → { name, role, ts }   (TTL 90s; client pings every 30s)
//
// Filed under the name the site asks with and gone within minutes, so it is
// the one thing that does not follow a renamed repository: for a few minutes
// after the config changes, people on pages loaded before and after it do not
// see each other.
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
  if (!(await requirePush(request, repo, env))) return false;
  await env.KILN.put(cacheKey, '1', { expirationTtl: 300 });
  return true;
}

// A presence entry is rewritten at most this often while nothing changes, and
// lives a little longer than that, so a person stays listed between writes.
// The cost: someone who closes the editor is shown for up to six and a half
// minutes, not ninety seconds.
const PRESENCE_REWRITE_MS = 5 * 60 * 1000;
const PRESENCE_TTL_S = 390;

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
    if (e && (!e.exp || e.exp >= Date.now()) && e.role === 'editor' && (e.repo === repo || await sameOnRecord(env, e.repo, repo)) && !(await answersAsAnother(env, repo, e.rid))) {
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
  // The editor pings every 30 seconds. Writing each ping would spend a free
  // account's whole day of KV writes (1,000) in one person's working day, and
  // then nobody can sign in. So the entry is written when the person arrives
  // or moves to another page, and otherwise once every five minutes.
  const page = String(pagePath).slice(0, 200);
  const now = Date.now();
  let mine = null;
  try { mine = await env.KILN.get(myKey, 'json'); } catch { /* treat as absent */ }
  if (!(mine && mine.page === page && mine.role === role && now - (mine.ts || 0) < PRESENCE_REWRITE_MS)) {
    await env.KILN.put(myKey, JSON.stringify({ name: nameKey, role, page, ts: now }), { expirationTtl: PRESENCE_TTL_S });
  }

  // `others` = people on THIS page; `online` = everyone editing the site right
  // now. Dedupe by name (keep the freshest) so entries written under the old
  // per-page key format can't produce duplicate rows while they age out.
  const byName = new Map();
  const list = await env.KILN.list({ prefix: `pres:${repo}:` });
  for (const k of list.keys) {
    if (k.name === myKey) continue;
    const v = await env.KILN.get(k.name, 'json');
    if (!v || v.name === nameKey) continue;
    if (now - (v.ts || 0) > PRESENCE_TTL_S * 1000) continue;   // left; the entry has not expired yet
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

/**
 * Comments follow the same path grants as editing: an editor (a comment-only
 * reviewer included) reads and writes threads only on pages inside the paths
 * they were given. The owner sees every page.
 */
/** Writing comments takes the Comments grant; a review seat is comment-only by definition. */
function canComment(actor) {
  return actor.mode === 'review' || hasGrant(actor, 'comments');
}
function commentInScope(actor, page) {
  return !!actor.admin || pathInScope(page, actor.paths);
}

async function commentList(request, env, url) {
  const repo = url.searchParams.get('repo') || '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: 'bad repo' }, 400);
  const actor = await authActor(request, env, repo);
  if (!actor) return json({ error: 'unauthorized' }, 401);
  const page = normalizePagePath(url.searchParams.get('path') || '');
  if (!page) return json({ error: 'bad path' }, 400);
  if (!commentInScope(actor, page)) return json({ error: 'outside your editing scope' }, 403);
  const { names } = await shelf(env, repo);
  const { entries, truncated } = await shelfEntries(env, names, name => commentKey(name, page, ''), 300);
  const threads = [];
  for (const entry of entries) {
    const v = await shelfRead(env, entry);
    if (v) threads.push(v);
  }
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
  let total = 0;
  // The badge asks on every page load and reads up to a thousand threads, so
  // this is the one reader that leaves an unfinished move to the others.
  const { names } = await shelf(env, repo, { step: false });
  const { entries, truncated } = await shelfEntries(env, names, name => `cmt:${name}:`, 1000);
  for (const entry of entries) {
    const v = await shelfRead(env, entry);
    if (!v || v.status !== 'open') continue;
    // Out-of-scope pages are left out entirely — not even their names.
    if (!commentInScope(actor, v.page)) continue;
    counts[v.page] = (counts[v.page] || 0) + 1;
    total++;
  }
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
  if (!commentInScope(actor, v.page)) return json({ error: 'outside your editing scope' }, 403);
  if (!canComment(actor)) return grantRefusal('comments');
  const msg = { by: actor.name, email: actor.email, ts: Date.now(), text: v.text };
  // New threads are filed under the name the repository's things are under; a
  // thread that has not yet moved there after a rename is found where it is.
  const { names } = await shelf(env, repo);
  if (thread != null) {
    if (!/^[a-f0-9]{12}$/.test(String(thread))) return json({ error: 'bad thread' }, 400);
    const found = await shelfFind(env, names, name => commentKey(name, v.page, thread));
    if (!found) return json({ error: 'not found' }, 404);
    const t = found.value;
    if ((t.messages || []).length >= 200) return json({ error: 'thread full' }, 413);
    t.messages = [...(t.messages || []), msg];
    // Replying to a resolved thread does NOT reopen it — reopening is explicit.
    await found.save(t);
    return json({ thread: t });
  }
  const id = [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
  const t = { id, page: v.page, status: 'open', anchor: v.anchor, created: Date.now(), resolved: null, messages: [msg] };
  await env.KILN.put(commentKey(names[0], v.page, id), JSON.stringify(t));
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
  if (!canComment(actor)) return grantRefusal('comments');
  if (!commentInScope(actor, page)) return json({ error: 'outside your editing scope' }, 403);
  const { names } = await shelf(env, repo);
  const found = await shelfFind(env, names, name => commentKey(name, page, thread));
  if (!found) return json({ error: 'not found' }, 404);
  const t = found.value;
  t.status = resolved ? 'resolved' : 'open';
  t.resolved = resolved ? { by: actor.name, ts: Date.now() } : null;
  await found.save(t);
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
  // Under every name it may be filed under, or an unfinished move would bring it back.
  for (const name of (await shelf(env, repo)).names) await env.KILN.delete(commentKey(name, page, thread));
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
  // Suggestions are field edits to an HTML page; approval guards them as HTML.
  if (!isHtmlPath(v.page)) return json({ error: 'suggestions are for HTML pages' }, 400);
  const id = [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
  const sug = {
    id, page: v.page, by: actor.name, email: actor.email, ts: Date.now(), note: v.note,
    edits: v.edits, branch: v.branch, baseSha: v.baseSha, status: 'open', decided: null, commit: null,
  };
  await env.KILN.put(`sug:${(await shelf(env, repo)).home}:${id}`, JSON.stringify(sug));
  return json({ suggestion: sug });
}

async function suggestionList(request, env, url) {
  const repo = url.searchParams.get('repo') || '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: 'bad repo' }, 400);
  const actor = await authActor(request, env, repo);
  if (!actor) return json({ error: 'unauthorized' }, 401);
  const suggestions = [];
  let truncated = false;
  const { names } = await shelf(env, repo);
  const { entries } = await shelfEntries(env, names, name => `sug:${name}:`, Infinity);
  for (const entry of entries) {
    if (suggestions.length >= 300) { truncated = true; break; }
    const v = await shelfRead(env, entry);
    if (!v) continue;
    // Editors see only their own submissions; admins review everything.
    if (!actor.admin && v.email !== actor.email) continue;
    suggestions.push(v);
  }
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
  const found = await shelfFind(env, (await shelf(env, repo)).names, name => `sug:${name}:${id}`);
  if (!found) return json({ error: 'not found' }, 404);
  const sug = found.value;
  if (sug.status !== 'open') return json({ error: 'already decided' }, 409);
  const decided = { by: actor.name, ts: Date.now() };
  if (typeof note === 'string' && note.trim()) decided.note = note.trim().slice(0, 500);

  if (!approve) {
    sug.status = 'declined';
    sug.decided = decided;
    await found.save(sug);
    return json({ suggestion: sug });
  }

  // Approve = the same merge as PATCH /api/v1/edits: fetch the CURRENT page,
  // re-apply the suggestion's edits by key, content-guard fail-closed, PUT with
  // the fresh sha, ONE refetch-and-retry on a sha conflict. On conflict or a
  // guard rejection the suggestion STAYS open so the admin can retry/decline.
  // (A stored suggestion aimed at anything but an HTML page is never applied:
  // the content guard below only speaks for HTML.)
  if (!isHtmlPath(sug.page)) return json({ error: 'suggestions are for HTML pages' }, 422);
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
        await found.save(sug);
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
        await found.save(sug);
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

// ─── AI assist (BYO-key, scoped) ─────────────────────────────────────────────
// POST /ai/assist — small, bounded AI surfaces for the editor: revise a text
// field, describe an image (alt text), or draft a new page's fields from a
// one-line brief. The Anthropic key is the SELF-HOSTER'S (wrangler secret
// AI_API_KEY) and never leaves this worker; the browser only ever talks to us.
// AI output is DATA on the same footing as human typing — the editor renders it
// through DOMPurify and stages it through the normal publish pipeline, and the
// server-side sanitize-guard still vets the resulting write. Editors need the
// 'ai' feature grant (it spends the owner's API credit); admins always may.

const AI_API = 'https://api.anthropic.com/v1/messages';
// The small/fast Claude model — right for copy-editing latency and cost.
// Self-hosters can override with the AI_MODEL env var.
const AI_DEFAULT_MODEL = 'claude-haiku-4-5';
const AI_TEXT_KINDS = ['improve', 'shorten', 'tone', 'translate', 'custom'];
// Instruction-bearing kinds: the extra line ("warmer", "Spanish", …) is required.
const AI_INSTRUCTED = ['tone', 'translate', 'custom'];
// Image types the vision API accepts as-is; anything else (avif, svg, …) is 415.
const AI_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
// The system prompt is server-side and non-negotiable — a client can pick the
// task, never the rules the revision plays by.
const AI_SYSTEM = 'You revise website copy. Return ONLY the revised text with no preamble, explanation, or'
  + ' commentary. Preserve any inline HTML tags present in the input. Never introduce scripts, styles, or'
  + " event handlers. Keep the author's meaning and approximate length unless the instruction asks otherwise.";

/** Parse one WHATWG-style IPv4 part: decimal, 0x hex, or 0-prefixed octal. */
function ipv4Part(part) {
  if (/^0x[0-9a-f]*$/i.test(part)) return part.length > 2 ? parseInt(part.slice(2), 16) : 0;
  if (/^0\d+$/.test(part)) return /^0[0-7]+$/.test(part) ? parseInt(part, 8) : NaN;   // "08" is not a number
  if (/^\d+$/.test(part)) return parseInt(part, 10);
  return NaN;
}

/**
 * A host as a 32-bit IPv4 number, the way a URL parser reads it: 1–4 parts,
 * each decimal / hex / octal, the last one filling whatever bytes are left
 * (so 2130706433, 0x7f000001, 017700000001 and 127.1 are all 127.0.0.1).
 * Returns null when the host is not an IPv4 address at all, NaN when it looks
 * like one (its last part is a number) but does not parse.
 */
function ipv4Number(host) {
  const parts = host.split('.');
  if (Number.isNaN(ipv4Part(parts[parts.length - 1]))) return null;   // a name, not an address
  if (parts.length > 4) return NaN;
  const nums = parts.map(ipv4Part);
  if (nums.some(n => Number.isNaN(n))) return NaN;
  const last = nums.pop();
  if (nums.some(n => n > 255) || last >= 256 ** (4 - nums.length)) return NaN;
  return nums.reduce((acc, n, i) => acc + n * 256 ** (3 - i), last);
}

/** IPv6 text (no brackets) as eight 16-bit groups, or null if malformed. */
function ipv6Groups(text) {
  let s = text;
  // A dotted IPv4 tail (::ffff:10.0.0.1) is two groups.
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const v4 = ipv4Number(tail[2]);
    if (v4 === null || Number.isNaN(v4)) return null;
    s = `${tail[1]}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (half) => (half === '' ? [] : half.split(':'));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : null;
  if (rest !== null && head.length + rest.length > 7) return null;   // "::" stands for at least one group
  const all = rest === null ? head : [...head, ...Array(8 - head.length - rest.length).fill('0'), ...rest];
  if (all.length !== 8) return null;
  if (!all.every(g => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return all.map(g => parseInt(g, 16));
}

/**
 * SSRF screen for the one URL this worker fetches on a caller's say-so (the
 * alt-text image). True = do NOT fetch. Only public hosts pass:
 *   • names: never localhost, a single-label name, or a private-use suffix
 *   • IPv4 literals in ANY spelling (dotted, decimal, hex, octal, short):
 *     never loopback, RFC 1918, link-local, carrier-grade NAT, or a reserved,
 *     documentation, multicast or broadcast range
 *   • IPv6 literals: global unicast only — so loopback, unique-local (fc00::/7),
 *     link-local (fe80::/10), multicast and every form that wraps an IPv4
 *     address (mapped, NAT64, 6to4, Teredo) are all out
 * Applied to the URL the caller sends AND to every redirect hop. A public name
 * that RESOLVES to a private address is beyond what a URL check can see.
 */
function aiHostBlocked(hostname) {
  let h = String(hostname || '').trim().toLowerCase().replace(/\.+$/, '');
  if (!h) return true;
  if (h.startsWith('[') || h.includes(':')) {
    const g = ipv6Groups(h.replace(/^\[|\]$/g, ''));
    if (!g) return true;                                    // malformed, or carries a zone id
    if ((g[0] & 0xe000) !== 0x2000) return true;           // outside global unicast 2000::/3
    if (g[0] === 0x2002) return true;                       // 6to4 wraps an IPv4 address
    if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0x0db8 || (g[1] & 0xfff0) === 0x0010)) return true;   // Teredo, documentation, ORCHID
    return false;
  }
  const v4 = ipv4Number(h);
  if (v4 !== null) {
    if (Number.isNaN(v4)) return true;
    const inRange = (base, bits) => Math.floor(v4 / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits));
    const ip = (a, b, c, d) => ((a * 256 + b) * 256 + c) * 256 + d;
    return [[ip(0, 0, 0, 0), 8], [ip(10, 0, 0, 0), 8], [ip(100, 64, 0, 0), 10], [ip(127, 0, 0, 0), 8],
      [ip(169, 254, 0, 0), 16], [ip(172, 16, 0, 0), 12], [ip(192, 0, 0, 0), 24], [ip(192, 0, 2, 0), 24],
      [ip(192, 88, 99, 0), 24], [ip(192, 168, 0, 0), 16], [ip(198, 18, 0, 0), 15], [ip(198, 51, 100, 0), 24],
      [ip(203, 0, 113, 0), 24], [ip(224, 0, 0, 0), 4], [ip(240, 0, 0, 0), 4]].some(([base, bits]) => inRange(base, bits));
  }
  if (!h.includes('.')) return true;                        // "intranet", "router"
  return /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa)$/.test(h);
}

/**
 * Validate an /ai/assist body. Pure (no env, no fetch); exported for unit
 * tests. Returns { error } to reject (always a 400), or the normalized
 * request: { kind, text, instruction } | { kind, imageUrl } |
 * { kind, brief, fields:[{key, hint?}] }.
 */
function validateAiAssist(body = {}) {
  const { kind } = body || {};
  if (AI_TEXT_KINDS.includes(kind)) {
    const { text, instruction } = body;
    if (typeof text !== 'string' || !text.trim()) return { error: 'missing text' };
    if (text.length > 8000) return { error: 'text too long' };
    if (AI_INSTRUCTED.includes(kind) && (typeof instruction !== 'string' || !instruction.trim())) {
      return { error: `${kind} needs an instruction` };
    }
    if (instruction !== undefined && instruction !== null
      && (typeof instruction !== 'string' || instruction.length > 200)) {
      return { error: 'bad instruction' };
    }
    return { kind, text, instruction: String(instruction || '').trim() };
  }
  if (kind === 'alt') {
    const raw = body.imageUrl;
    if (typeof raw !== 'string' || !raw || raw.length > 2000) return { error: 'bad imageUrl' };
    let url;
    try { url = new URL(raw); } catch { return { error: 'bad imageUrl' }; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'imageUrl must be http(s)' };
    // SSRF hygiene: this worker fetches the URL — never let it aim at loopback,
    // a private network, or the link-local metadata range. Public image hosts only.
    if (aiHostBlocked(url.hostname)) return { error: 'imageUrl host not allowed' };
    return { kind, imageUrl: url.href };
  }
  if (kind === 'fill') {
    const { brief, fields } = body;
    if (typeof brief !== 'string' || !brief.trim()) return { error: 'missing brief' };
    if (brief.length > 2000) return { error: 'brief too long' };
    if (!Array.isArray(fields) || !fields.length || fields.length > 20) return { error: 'bad fields' };
    const out = [];
    const seen = new Set();
    for (const f of fields) {
      if (!f || typeof f.key !== 'string' || !f.key || f.key.length > 200) return { error: 'every field needs a key' };
      if (seen.has(f.key)) return { error: 'duplicate field key' };
      seen.add(f.key);
      if (f.hint !== undefined && f.hint !== null && (typeof f.hint !== 'string' || f.hint.length > 200)) {
        return { error: 'bad hint' };
      }
      out.push(f.hint ? { key: f.key, hint: f.hint } : { key: f.key });
    }
    return { kind, brief: brief.trim(), fields: out };
  }
  return { error: 'unknown kind' };
}

/** Models wrap answers in fences/quotes when they shouldn't — unwrap the whole-output cases only. */
function aiStripWrapping(s) {
  let t = String(s).trim();
  const fence = /^```[\w-]*\r?\n([\s\S]*?)\r?\n?```$/.exec(t);
  if (fence) t = fence[1].trim();
  if (t.length > 1 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/**
 * One Anthropic Messages call. Returns { text } on success or { status, error }
 * to relay (401→502 'ai key invalid', 429→429, anything else→502). Provider
 * bodies/headers are NEVER echoed to the client — they can restate request
 * metadata — and the key itself never appears in a log or response.
 * `upstream` rides along so a caller can retry a 400 (e.g. a model override
 * that lacks structured outputs) with a simpler payload.
 */
async function aiMessage(env, payload) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('timeout'), 60000);
  let res;
  try {
    res = await fetch(AI_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.AI_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: env.AI_MODEL || AI_DEFAULT_MODEL, ...payload }),
      signal: ctl.signal,
    });
  } catch {
    return { status: 502, error: 'ai request failed' };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.status === 401) return { status: 502, error: 'ai key invalid', upstream: 401 };
    if (res.status === 429) return { status: 429, error: 'ai rate limited — try again in a moment', upstream: 429 };
    return { status: 502, error: 'ai request failed', upstream: res.status };
  }
  const data = await res.json().catch(() => null);
  if (!data || !Array.isArray(data.content)) return { status: 502, error: 'ai request failed' };
  // Safety refusal comes back as HTTP 200 with stop_reason 'refusal'.
  if (data.stop_reason === 'refusal') return { status: 502, error: 'ai declined this request' };
  // Join TEXT blocks only — thinking-enabled model overrides interleave other block types.
  const text = aiStripWrapping(data.content.filter(b => b && b.type === 'text').map(b => b.text).join(''));
  if (!text) return { status: 502, error: 'ai returned nothing' };
  return { text };
}

/**
 * Fetch an image for the vision call: 10s timeout, 3 MB cap, image/* only, and
 * redirects are followed by hand (max 3) so every hop stays on https — a
 * redirect is not allowed to walk the fetch off to plain http or a data: URL —
 * and every hop's host passes the same screen as the URL the caller sent, so a
 * public address cannot bounce the fetch onto a private one.
 * Returns { mediaType, b64 } or { error: 502|415|'host' }.
 */
async function aiFetchImage(imageUrl) {
  const MAX_BYTES = 3 * 1024 * 1024;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('timeout'), 10000);
  try {
    let url = imageUrl;
    let res = null;
    for (let hop = 0; hop < 4; hop++) {
      if (aiHostBlocked(new URL(url).hostname)) return { error: 'host' };
      res = await fetch(url, { redirect: 'manual', signal: ctl.signal });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('Location');
        if (!loc) return { error: 502 };
        const next = new URL(loc, url);
        if (next.protocol !== 'https:') return { error: 502 };   // no redirects off-https
        url = next.href;
        res = null;
        continue;
      }
      break;
    }
    if (!res || !res.ok) return { error: 502 };
    const type = (res.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) return { error: 415 };
    if (!AI_IMAGE_TYPES.includes(type)) return { error: 415 };
    if (Number(res.headers.get('Content-Length') || 0) > MAX_BYTES) return { error: 502 };
    // Read incrementally and bail at the cap — never buffer an oversized body
    // whole just to measure it.
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        try { await reader.cancel(); } catch { /* already closed */ }
        return { error: 502 };
      }
      chunks.push(value);
    }
    if (!total) return { error: 502 };
    return { mediaType: type, b64: bufToB64(concatBytes(...chunks)) };
  } catch {
    return { error: 502 };
  } finally {
    clearTimeout(timer);
  }
}

async function aiAssist(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!/^[\w.-]+\/[\w.-]+$/.test(body.repo || '')) return json({ error: 'bad repo' }, 400);
  const actor = await authActor(request, env, body.repo);
  if (!actor) return json({ error: 'unauthorized' }, 401);
  // `features: null` means the client-side default set, which never includes
  // 'ai' — spending the owner's API credit takes an explicit grant.
  if (!actor.admin && !(Array.isArray(actor.features) && actor.features.includes('ai'))) {
    return json({ error: "the 'AI assist' feature is not enabled for your account" }, 403);
  }
  if (!env.AI_API_KEY) return json({ error: 'ai not configured', hint: 'wrangler secret put AI_API_KEY' }, 501);
  const v = validateAiAssist(body);
  if (v.error) return json({ error: v.error }, 400);

  if (AI_TEXT_KINDS.includes(v.kind)) {
    const ask = {
      improve: 'Improve this website copy:',
      shorten: 'Shorten this website copy while keeping its key points:',
      tone: `Rewrite this website copy in this tone: ${v.instruction}`,
      translate: `Translate this website copy to ${v.instruction}:`,
      custom: v.instruction,
    }[v.kind];
    const r = await aiMessage(env, {
      max_tokens: 16000,
      system: AI_SYSTEM,
      messages: [{ role: 'user', content: `${ask}\n\n${v.text}` }],
    });
    if (r.error) return json({ error: r.error }, r.status);
    return json({ text: r.text });
  }

  if (v.kind === 'alt') {
    const img = await aiFetchImage(v.imageUrl);
    if (img.error === 'host') return json({ error: 'imageUrl host not allowed' }, 400);
    if (img.error === 415) return json({ error: 'that URL is not a supported image' }, 415);
    if (img.error) return json({ error: 'could not fetch the image' }, 502);
    const r = await aiMessage(env, {
      max_tokens: 1024,
      system: 'You write alt text for website images.',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.b64 } },
          { type: 'text', text: 'Write one concise alt text for this image: plain text only, at most 125 characters, and no "image of" / "picture of" prefix. Describe what matters.' },
        ],
      }],
    });
    if (r.error) return json({ error: r.error }, r.status);
    // Alt is an ATTRIBUTE value: force plain text, one line, sanely bounded.
    const alt = r.text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!alt) return json({ error: 'ai returned nothing' }, 502);
    return json({ alt });
  }

  // kind === 'fill' — draft every field of a new page from a one-line brief.
  // Structured outputs pin the response to exactly the requested keys; the
  // prompt also demands bare JSON so a model override without structured-output
  // support still answers usably on the one retry without the format.
  const schema = { type: 'object', properties: {}, required: v.fields.map(f => f.key), additionalProperties: false };
  for (const f of v.fields) schema.properties[f.key] = { type: 'string' };
  const fillPayload = {
    max_tokens: 16000,
    system: 'You draft the text content for a new web page. Respond with ONLY a JSON object mapping each'
      + ' requested field key to its text. Values are plain text — no HTML tags, no markdown. Match each'
      + " field's role: headlines short and punchy, body copy a sentence or three.",
    messages: [{
      role: 'user',
      content: `Brief: ${v.brief}\n\nFields to write:\n${v.fields.map(f => `- ${f.key}${f.hint ? ` (${f.hint})` : ''}`).join('\n')}`,
    }],
  };
  let r = await aiMessage(env, { ...fillPayload, output_config: { format: { type: 'json_schema', schema } } });
  if (r.error && r.upstream === 400) r = await aiMessage(env, fillPayload);   // model without structured outputs
  if (r.error) return json({ error: r.error }, r.status);
  let parsed = null;
  try { parsed = JSON.parse(r.text); } catch {
    const m = /\{[\s\S]*\}/.exec(r.text);   // prose around the object — dig it out
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* unparseable */ } }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return json({ error: 'ai returned unusable output' }, 502);
  }
  // Requested keys only, string values only. Null-prototype: a field literally
  // named "__proto__" must stay plain data (same rule as commentCounts).
  const fields = Object.create(null);
  for (const f of v.fields) {
    const val = Object.prototype.hasOwnProperty.call(parsed, f.key) ? parsed[f.key] : undefined;
    if (typeof val === 'string' && val.trim()) fields[f.key] = aiStripWrapping(val).slice(0, 8000);
  }
  if (!Object.keys(fields).length) return json({ error: 'ai returned unusable output' }, 502);
  return json({ fields });
}

// ─── Source mode (generator-built sites) ─────────────────────────────────────
// POST /source/commit|revert|duplicate — the editor edits a rendered value and
// the worker writes the CONTENT FILE it was built from, through a source
// adapter (SOURCE-MODE-SPEC §5; contracts in docs/SOURCE-MODE-IMPL.md). All
// decision logic is pure in worker/source.js; this section is fetch glue only.
// Same actor resolution as /presence, same commit authorship as the /gh proxy,
// same one-retry sha-conflict merge as PATCH /api/v1/edits — a conflict
// re-applies the SAME edits against the re-fetched source (§8.2), so
// concurrent edits to other fields survive.

/** Read one file's contents record at a ref. Returns the JSON, null on 404. */
async function sourceRead(h, repo, file, ref) {
  const res = await fetch(`${GH}/repos/${repo}/contents/${encodeURIComponent(file)}?ref=${ref}`, { headers: h });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`read ${res.status}`);
  const cur = await res.json();
  if (typeof cur.content !== 'string') throw new Error('unreadable content');
  return cur;
}

async function sourceCommit(request, env) {
  const { repo, branch = 'main', adapter, file, edits, message } = await request.json().catch(() => ({}));
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) return json({ error: 'bad repo' }, 400);
  if (!/^[\w./-]{1,100}$/.test(branch)) return json({ error: 'bad ref' }, 400);
  const actor = await authActor(request, env, repo);
  // Rules 1–3 (actor mode, adapter, path gauntlet, edit shape) — pure.
  const v = validateSourceRequest({ file, edits, adapter, actor }, { isSensitivePath, pathInScope });
  if (v.error) return json({ error: v.error, ...(v.detail !== undefined && { detail: v.detail }) }, v.status);
  // Rule 4: typed validation skips a bad edit, never the batch (§8.1/§9).
  const typedSkips = typedEditProblems(v.cleanEdits, { safeUrl, checkFragment });
  const badKeys = new Set(typedSkips.map(s => s.key));
  const runnable = v.cleanEdits.filter(e => !badKeys.has(e.key));

  const itok = await installationToken(env, repo);
  if (!itok) return json({ error: 'app not installed on repo', repo }, 503);
  const h = { Authorization: `Bearer ${itok}`, Accept: 'application/vnd.github+json', 'User-Agent': UA, 'Content-Type': 'application/json' };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await sourceRead(h, repo, v.file, branch);
      if (!cur) return json({ error: SOURCE_FILE_GONE }, 404);
      const source = utf8FromB64(cur.content);
      // A field that no longer says what the editor read was changed by
      // someone else: that edit is left out, with what the file says now, and
      // the rest go through. Looked at again on the retry, against the file
      // as it is then.
      const moved = changedSinceRead(v.adapter, source, v.file, runnable);
      // Markdown may keep the markup it holds and add none (rule 4, second half).
      let parsed = null;
      const marked = markdownProblems(runnable.filter(e => !moved.some(m => m.key === e.key)), (e) => {
        parsed = parsed || v.adapter.parse(source, v.file);
        return v.adapter.read(parsed, e.pointer);
      }, { checkFragmentWrite, mdx: /\.mdx$/i.test(v.file) });
      const leftOut = new Set([...moved, ...marked].map(s => s.key));
      const { content, applied, skipped } = v.adapter.applyEdits(source, runnable.filter(e => !leftOut.has(e.key)), v.file);
      const allSkipped = [...typedSkips, ...moved, ...marked, ...skipped];
      if (!applied.length) return json({ error: 'no edits could be applied', skipped: allSkipped }, 422);
      // Cheap pre-commit parse check (§9) — the build is the real judge (§12).
      const invalid = v.adapter.validate(content, v.file);
      if (invalid) return json({ error: invalid }, 422);
      if (content === source) return json({ ok: true, unchanged: true, applied, skipped: allSkipped });
      const put = await fetch(`${GH}/repos/${repo}/contents/${encodeURIComponent(v.file)}`, {
        method: 'PUT', headers: h,
        body: JSON.stringify({
          message: (typeof message === 'string' && message.trim()) ? message : `Kiln: update ${v.file}`,
          content: b64FromUtf8(content), branch, sha: cur.sha,
          author: { name: `${actor.name} (via Kiln)`, email: 'kiln-editor@users.noreply.github.com' },
        }),
      });
      if (put.ok) {
        const out = await put.json();
        // `parent` is what /source/revert restores to after a failed build (§12).
        return json({ ok: true, file: v.file, commit: { sha: out.commit?.sha, parent: out.commit?.parents?.[0]?.sha || null }, applied, skipped: allSkipped });
      }
      const err = await put.json().catch(() => ({}));
      const conflict = put.status === 409 || (put.status === 422 && /sha/i.test(err.message || ''));
      if (!conflict) return json({ error: 'commit failed', detail: err.message || String(put.status) }, 502);
    }
    return json({ error: 'conflict: the file changed while saving — try again' }, 409);
  } catch {
    return json({ error: 'could not apply edits safely' }, 502);
  }
}

/**
 * POST /source/read { repo, branch?, adapter, file, pointer } → { value, sha }:
 * what one field of a content file holds now, as the file has it (an entry's
 * Markdown body, a Markdown field of its front matter). The editor reads a
 * formatted text before it is edited, to match the page to the file and to
 * write back only what changed; YAML stays here, out of the editor. Same
 * door as /source/commit: the actor, the path rules, the adapter.
 */
async function sourceReadField(request, env) {
  const { repo, branch = 'main', adapter, file, pointer } = await request.json().catch(() => ({}));
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) return json({ error: 'bad repo' }, 400);
  if (!/^[\w./-]{1,100}$/.test(branch)) return json({ error: 'bad ref' }, 400);
  const actor = await authActor(request, env, repo);
  const v = validateSourceRequest({ file, edits: [{ pointer, value: '' }], adapter, actor }, { isSensitivePath, pathInScope });
  if (v.error) return json({ error: v.error, ...(v.detail !== undefined && { detail: v.detail }) }, v.status);
  const itok = await installationToken(env, repo);
  if (!itok) return json({ error: 'app not installed on repo', repo }, 503);
  const h = { Authorization: `Bearer ${itok}`, Accept: 'application/vnd.github+json', 'User-Agent': UA };
  try {
    const cur = await sourceRead(h, repo, v.file, branch);
    if (!cur) return json({ error: SOURCE_FILE_GONE }, 404);
    const parsed = v.adapter.parse(utf8FromB64(cur.content), v.file);
    const value = v.adapter.read(parsed, pointer);
    if (value === undefined) return json({ error: 'pointer not found in source' }, 404);
    if (value !== null && typeof value === 'object') return json({ error: 'type mismatch' }, 422);
    return json({ value: value ?? '', sha: cur.sha });
  } catch {
    return json({ error: 'could not read the file' }, 502);
  }
}

async function sourceRevert(request, env) {
  const { repo, branch = 'main', file, toSha } = await request.json().catch(() => ({}));
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) return json({ error: 'bad repo' }, 400);
  if (!/^[\w./-]{1,100}$/.test(branch)) return json({ error: 'bad ref' }, 400);
  if (!/^[a-f0-9]{40}$/.test(String(toSha || ''))) return json({ error: 'bad toSha' }, 400);
  const actor = await authActor(request, env, repo);
  const refuse = sourceModeRefusal(actor);
  if (refuse) return json({ error: refuse.error }, refuse.status);
  // A revert restores whatever the failed commit touched — any adapter's
  // editable file or an HTML page, same denylists as /source/commit.
  const p = refuseSourcePath(file, actor, { isSensitivePath, pathInScope }, { anyEditable: true });
  if (p.error) return json({ error: p.error }, p.status);

  const itok = await installationToken(env, repo);
  if (!itok) return json({ error: 'app not installed on repo', repo }, 503);
  const h = { Authorization: `Bearer ${itok}`, Accept: 'application/vnd.github+json', 'User-Agent': UA, 'Content-Type': 'application/json' };
  try {
    const old = await sourceRead(h, repo, p.file, toSha);
    if (!old) return json({ error: 'that file does not exist at that commit — nothing to revert to' }, 404);
    // Base64 passed through untouched (whitespace stripped) — exact bytes back.
    const restore = old.content.replace(/\s/g, '');
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await sourceRead(h, repo, p.file, branch);
      // Deleted at head → the PUT (no sha) recreates it; that IS the revert.
      if (cur && cur.content.replace(/\s/g, '') === restore) {
        return json({ ok: true, file: p.file, unchanged: true });
      }
      // `toSha` is whatever the caller names — any commit GitHub can resolve,
      // not necessarily one this site ever published. So an editor's revert
      // gets the same content guard as every other editor write: the restored
      // file may carry no executable markup the current one does not already
      // have. Undoing a text edit passes untouched. Fails CLOSED.
      if (!actor.admin) {
        const bad = checkDocumentWrite(cur ? utf8FromB64(cur.content) : null, utf8FromB64(old.content));
        if (bad) return json({ error: 'That version would add scripts to the page, so only the site owner can restore it.', detail: bad }, 403);
      }
      const put = await fetch(`${GH}/repos/${repo}/contents/${encodeURIComponent(p.file)}`, {
        method: 'PUT', headers: h,
        body: JSON.stringify({
          message: `Kiln: revert ${p.file} to ${toSha.slice(0, 7)}`,
          content: restore, branch, ...(cur && { sha: cur.sha }),
          author: { name: `${actor.name} (via Kiln)`, email: 'kiln-editor@users.noreply.github.com' },
        }),
      });
      if (put.ok) {
        const out = await put.json();
        return json({ ok: true, file: p.file, commit: { sha: out.commit?.sha, parent: out.commit?.parents?.[0]?.sha || null } });
      }
      const err = await put.json().catch(() => ({}));
      const conflict = put.status === 409 || (put.status === 422 && /sha/i.test(err.message || ''));
      if (!conflict) return json({ error: 'commit failed', detail: err.message || String(put.status) }, 502);
    }
    return json({ error: 'conflict: the file changed while reverting — try again' }, 409);
  } catch {
    return json({ error: 'could not revert safely' }, 502);
  }
}

async function sourceDuplicate(request, env) {
  const { repo, branch = 'main', file } = await request.json().catch(() => ({}));
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) return json({ error: 'bad repo' }, 400);
  if (!/^[\w./-]{1,100}$/.test(branch)) return json({ error: 'bad ref' }, 400);
  const actor = await authActor(request, env, repo);
  const refuse = sourceModeRefusal(actor);
  if (refuse) return json({ error: refuse.error }, refuse.status);
  const p = refuseSourcePath(file, actor, { isSensitivePath, pathInScope }, { anyEditable: true });
  if (p.error) return json({ error: p.error }, p.status);

  const itok = await installationToken(env, repo);
  if (!itok) return json({ error: 'app not installed on repo', repo }, 503);
  const h = { Authorization: `Bearer ${itok}`, Accept: 'application/vnd.github+json', 'User-Agent': UA, 'Content-Type': 'application/json' };
  try {
    const src = await sourceRead(h, repo, p.file, branch);
    if (!src) return json({ error: SOURCE_FILE_GONE }, 404);
    // Exact byte copy: the base64 goes back out untouched (whitespace stripped).
    const bytes = src.content.replace(/\s/g, '');
    let target = null;
    for (const candidate of duplicateCandidates(p.file)) {
      // Same dir + extension as a file that just passed, so this re-check can
      // only trip on something genuinely odd — refuse loudly, never write it.
      const cp = refuseSourcePath(candidate, actor, { isSensitivePath, pathInScope }, { anyEditable: true });
      if (cp.error) return json({ error: cp.error }, cp.status);
      const probe = await fetch(`${GH}/repos/${repo}/contents/${encodeURIComponent(candidate)}?ref=${branch}`, { headers: h });
      if (probe.status === 404) { target = candidate; break; }
      if (!probe.ok) return json({ error: 'could not find a free name for the copy' }, 502);
    }
    if (!target) return json({ error: 'too many copies of this file — rename or delete one first' }, 409);
    const put = await fetch(`${GH}/repos/${repo}/contents/${encodeURIComponent(target)}`, {
      method: 'PUT', headers: h,
      body: JSON.stringify({
        message: `Kiln: duplicate ${p.file}`,
        content: bytes, branch,
        author: { name: `${actor.name} (via Kiln)`, email: 'kiln-editor@users.noreply.github.com' },
      }),
    });
    if (put.ok) {
      const out = await put.json();
      return json({ ok: true, path: target, commit: { sha: out.commit?.sha, parent: out.commit?.parents?.[0]?.sha || null } });
    }
    const err = await put.json().catch(() => ({}));
    // Raced: someone claimed the probed-free name first.
    const conflict = put.status === 409 || (put.status === 422 && /sha/i.test(err.message || ''));
    if (conflict) return json({ error: 'conflict: that name was just taken — try again' }, 409);
    return json({ error: 'commit failed', detail: err.message || String(put.status) }, 502);
  } catch {
    return json({ error: 'could not duplicate safely' }, 502);
  }
}

// ─── People (Google sign-in allowlist) ───────────────────────────────────────
// people:{repo} → [{ email, name, role: 'editor'|'member', days, paths? }]
// `paths` (editors only) limits which file prefixes they may write; [''] = whole site.

async function getPeople(env, repo) {
  const list = await env.KILN.get(`people:${repo}`, 'json');
  if (list) return list;
  // Nothing under this name. The same repository may have people on record
  // under the name it had before a rename or a transfer (KLR-08).
  // followRepo answers with the names the list may be filed under now:
  // another name the repository still has data under, or this one after a
  // move (and the one it is moving from, should the move have been cut short).
  const rec = await followRepo(env, repo);
  for (const name of rec ? [rec.name, ...movingFrom(rec)] : []) {
    const there = await env.KILN.get(`people:${name}`, 'json');
    if (there) return there;
  }
  return [];
}

/** The name a repository's people are filed under: `repo` itself, unless the
 *  same repository already has a list under another of its names. Writes go
 *  there too, so one repository never ends up with two lists. */
async function peopleHome(env, repo) {
  if (await env.KILN.get(`people:${repo}`)) return repo;
  const rec = await followRepo(env, repo);
  return rec ? rec.name : repo;
}

async function peopleList(request, env, url) {
  const repo = url.searchParams.get('repo') || '';
  if (!(await requirePush(request, repo, env))) return forbidden(request);
  return json({ people: await getPeople(env, repo), googleConfigured: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), aiConfigured: !!env.AI_API_KEY });
}

// Menu features an admin can grant an editor. People/settings stay owner-only.
const GRANTABLE_FEATURES = ['menu', 'findreplace', 'newpost', 'pagesettings', 'history', 'schedule', 'draft', 'makeeditable', 'comments', 'ai', 'blocks', 'theme'];
// What an editor has when the owner never chose: the same list the editor
// bundle falls back to (EDITOR_DEFAULT_FEATURES in src/editor/main.js).
const DEFAULT_FEATURES = ['pagesettings', 'history', 'draft'];
const GRANT_LABEL = { theme: 'the Theme tool', newpost: 'adding a new page', draft: 'saving drafts', schedule: 'scheduling', comments: 'comments' };

/** Does this editor session (or actor) hold a tool grant? The owner holds all. */
function hasGrant(who, feature) {
  if (who.admin) return true;
  return (Array.isArray(who.features) ? who.features : DEFAULT_FEATURES).includes(feature);
}
function grantRefusal(feature, path) {
  return json({ error: `your access does not include ${GRANT_LABEL[feature]}`, code: 'grant_required', grant: feature, ...(path ? { path } : {}) }, 403);
}
/**
 * The grant a file write needs, or null. Hiding a button in the editor is not
 * a permission, so the worker holds each write to the grant behind its tool:
 *   a stylesheet            → Theme
 *   a page that is new      → New post / page (on a branch that is published;
 *                             kiln scratch branches hold drafts and previews)
 *   anything on kiln-drafts → Drafts
 * Menu, Find & replace, Page settings, History, Blocks and Make editable end
 * in an ordinary edit of a page the editor may already change, so there is no
 * separate write to hold back for them. `branch` undefined = not known yet.
 */
function writeGrantNeeded(who, path, { adds = false, branch } = {}) {
  if (branch === 'kiln-drafts' && !hasGrant(who, 'draft')) return 'draft';
  if (editorFileKind(path) === 'css' && !hasGrant(who, 'theme')) return 'theme';
  const scratch = typeof branch === 'string' && KILN_BRANCH_RE.test(branch);
  if (adds && branch !== undefined && !scratch && isHtmlPath(path) && !hasGrant(who, 'newpost')) return 'newpost';
  return null;
}

async function peopleUpsert(request, env) {
  const { repo, email, name, role, days, paths, keys, features, mode } = await request.json().catch(() => ({}));
  if (!(await requirePush(request, repo, env))) return forbidden(request);
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
  const home = await peopleHome(env, repo);
  const people = (await getPeople(env, home)).filter(p => p.email !== addr);
  people.push(person);
  await env.KILN.put(`people:${home}`, JSON.stringify(people));
  // Purge this person's live editor sessions so a scope/role/feature change
  // takes effect immediately — the frozen `paths` in an old esess would
  // otherwise keep their previous access until it expired (up to 360 days).
  // (Under each name the repository has sessions for.)
  for (const r of new Set([repo, home, ...(await shelf(env, home)).names])) {
    await purgeEditorSessions(env, r, addr);
    await purgeMemberSessions(env, r, addr);
  }
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
  if (!(await requirePush(request, repo, env))) return forbidden(request);
  const addr = String(email || '').trim().toLowerCase();
  const home = await peopleHome(env, repo);
  const people = (await getPeople(env, home)).filter(p => p.email !== addr);
  await env.KILN.put(`people:${home}`, JSON.stringify(people));
  // Under each name the repository has sessions for (the one asked with, the
  // one its list is filed under when that differs, and any a move after a
  // rename has not finished with).
  const names = new Set([repo, home, ...(await shelf(env, home)).names]);
  // Revoke any active editor sessions for this person immediately (not just future sign-ins).
  for (const r of names) await purgeEditorSessions(env, r, addr);
  // A member's sign-in lives in a cookie their site signed; ending its record
  // here is what makes the site's gate turn them away at its next check.
  for (const r of names) await purgeMemberSessions(env, r, addr);
  // Also drop any pending scheduled posts this person created.
  let scur;
  do {
    const page = await env.KILN.list({ prefix: 'sched:', cursor: scur });
    for (const k of page.keys) {
      const v = await env.KILN.get(k.name, 'json');
      if (v && names.has(v.repo) && v.byEmail === addr) await env.KILN.delete(k.name);
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

  // The list the person is on is one repository's: the one the name it is
  // filed under is on record as. If that name now answers as another
  // repository, nobody is signed in. A session made now would be refused at
  // its first use, and the person is better told why here.
  const { home } = await shelf(env, state.repo);
  const rid = await idOnRecord(env, home);
  if (rid !== null && await answersAsAnother(env, home, rid)) {
    return html(`<h1>Nobody can be signed in to this site right now</h1>
      <p>You signed in as <strong>${esc(email)}</strong>, and that address is on the list.
      But this site is set up for a repository that is no longer the one its name
      points to: the name now belongs to a different repository. Until the site's
      owner corrects that, nobody is signed in here, so that nothing is saved to the
      wrong place.</p>
      <p>Ask the owner to run <code>kiln doctor</code>. It says what to change.</p>
      <p><a class="btn" href="${esc(state.origin + state.returnTo)}">Back to the site</a></p>`, 403);
  }

  const displayName = person.name || info.name || email.split('@')[0];
  if (person.role === 'editor') {
    const session = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    const exp = person.days ? Date.now() + person.days * 24 * 3600 * 1000 : null;  // days:0 = never
    // The session is filed under the name the repository's things are under
    // (`home`), so there is never one that only an old name knows about, and
    // it carries that repository's id: each use checks that the name still
    // answers as it. The site is told the name it asked with (below): that
    // is what its editor compares.
    await env.KILN.put(`esess:${session}`,
      JSON.stringify({ repo: home, name: displayName, role: 'editor', email, paths: person.paths || [''], keys: person.keys || [], features: person.features || null, mode: person.mode === 'suggest' || person.mode === 'review' ? person.mode : null, created: Date.now(), exp, ...(rid !== null && { rid }) }),
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
    JSON.stringify({ name: displayName, days: person.days, repo: state.repo, origin: state.origin, email }),
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
      const row = await cloudSiteForOrigin(env, origin);
      if (row) return row.repo;
    } catch { /* D1 unreachable — fall through */ }
  }
  const STATIC = { 'https://npu-i-site.pages.dev': 'NPU-I/npu-i' };
  return STATIC[origin] || null;
}

async function googleClaim(request, env) {
  const { code, origin, session } = await request.json().catch(() => ({}));
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
    // "The same repo" is the same repository, not the same spelling: a site
    // whose config still has the name from before a rename or a transfer is
    // the repository the origin belongs to, by its id (KLR-08).
    const authRepo = await repoForOrigin(env, data.origin);
    if (authRepo && authRepo !== data.repo && !(await sameRepository(env, authRepo, data.repo))) {
      return json({ error: 'sign-in not valid for this site' }, 403);
    }
  }
  // A site whose gate re-checks the list asks for a session id to put in its
  // cookie. The cookie itself is signed by the site and cannot be taken back;
  // this record can, and the gate asks about it (memberCheck).
  let sid;
  if (session && data.repo && data.email) {
    sid = crypto.randomUUID().replaceAll('-', '');
    const days = Number(data.days) === 0 ? 0 : Math.min(Math.max(Number(data.days) || 30, 1), 360);
    // Filed under the name the repository's things are under, with the id of
    // that repository: each check asks whether the name still answers as it.
    const { home } = await shelf(env, data.repo);
    const rid = await idOnRecord(env, home);
    await env.KILN.put(`msess:${sid}`, JSON.stringify({ repo: home, email: data.email, origin: data.origin, ...(rid !== null && { rid }) }),
      days ? { expirationTtl: days * 24 * 3600 } : undefined);
  }
  return json({ ok: true, name: data.name, days: data.days, ...(sid ? { sid } : {}) });
}

/**
 * POST /members/check {sid, origin} → { ok }. Asked by a site's members gate
 * (templates/functions/members/_middleware.js) every few minutes for each
 * signed-in member: is this sign-in still good? It is while its record exists,
 * belongs to the asking site, and the person is still a member on the list.
 * The id is 128 random bits and says nothing by itself, so there is no other
 * credential. Called server to server, hence no CORS and no per-IP limit (every
 * site's gate would share one address).
 */
async function memberCheck(request, env) {
  const { sid, origin } = await request.json().catch(() => ({}));
  if (!/^[a-f0-9]{32}$/.test(sid || '')) return json({ error: 'bad session' }, 400);
  const sess = await env.KILN.get(`msess:${sid}`, 'json');
  if (!sess || !origin || sess.origin !== origin) return json({ ok: false });
  // The list that is about to be read is found by the sign-in's name. If that
  // name now answers as another repository than the one the sign-in was made
  // for, it is not read: the sign-in is no longer good.
  if (!(await stillItsRepo(env, `msess:${sid}`, sess))) return json({ ok: false });
  const listed = (await getPeople(env, sess.repo)).some(p => p.email === sess.email && p.role === 'member');
  return json({ ok: listed });
}

/** End every member sign-in one person holds on one repo's site. */
async function purgeMemberSessions(env, repo, addr) {
  let cursor;
  do {
    const page = await env.KILN.list({ prefix: 'msess:', cursor });
    for (const k of page.keys) {
      const v = await env.KILN.get(k.name, 'json');
      if (v && v.repo === repo && v.email === addr) await env.KILN.delete(k.name);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
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
  if (!(await requirePush(request, repo, env))) return forbidden(request);
  const label = String(name || '').trim().slice(0, 60);
  if (!label) return json({ error: 'missing name' }, 400);
  const d = Math.min(Math.max(Number(days) || 0, 0), 3650);   // 0 / absent = never expires
  const secret = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const record = {
    id: crypto.randomUUID().replaceAll('-', '').slice(0, 8),
    // The name the repository's things are filed under: not always the one
    // this site's config has (a renamed repository).
    repo: (await shelf(env, repo)).home,
    name: label,
    paths: normalizePaths(paths),
    keys: normalizePaths(keys).filter(k => k !== '').slice(0, 50),
    readonly: !!readonly,
    created: Date.now(),
    exp: d ? Date.now() + d * 24 * 3600 * 1000 : null,
  };
  // And the id of the repository that name's things belong to: every use
  // checks that the name still answers as that repository.
  const rid = await idOnRecord(env, record.repo);
  if (rid !== null) record.rid = rid;
  await env.KILN.put(`atok:${await sha256Hex(secret)}`, JSON.stringify(record),
    d ? { expirationTtl: d * 24 * 3600 } : undefined);
  // The secret appears in this response ONCE and is never recoverable again.
  return json({ ok: true, token: secret, record });
}

async function apiTokenList(request, env, url) {
  const repo = url.searchParams.get('repo') || '';
  if (!(await requirePush(request, repo, env))) return forbidden(request);
  const mine = new Set([repo, ...(await shelf(env, repo)).names]);
  const tokens = [];
  let cursor;
  do {
    const page = await env.KILN.list({ prefix: 'atok:', cursor });
    for (const k of page.keys) {
      const v = await env.KILN.get(k.name, 'json');
      if (v && mine.has(v.repo)) tokens.push(v);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return json({ tokens: tokens.sort((a, b) => (b.created || 0) - (a.created || 0)) });
}

async function apiTokenRevoke(request, env) {
  const { repo, id } = await request.json().catch(() => ({}));
  if (!(await requirePush(request, repo, env))) return forbidden(request);
  if (!/^[a-f0-9]{8}$/.test(id || '')) return json({ error: 'bad id' }, 400);
  const mine = new Set([repo, ...(await shelf(env, repo)).names]);
  let cursor;
  do {
    const page = await env.KILN.list({ prefix: 'atok:', cursor });
    for (const k of page.keys) {
      const v = await env.KILN.get(k.name, 'json');
      if (v && mine.has(v.repo) && v.id === id) {
        await env.KILN.delete(k.name);
        return json({ ok: true });
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return json({ error: 'not found' }, 404);
}

/**
 * Resolve the API bearer secret to its stored token record, or null. null
 * also for a good token whose repository's name now answers as another
 * repository: everything a token does goes to GitHub by that name, so
 * nothing is done with it (tokenRefused says why).
 */
async function apiTokenAuth(request, env) {
  const secret = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!/^[a-f0-9]{64}$/.test(secret)) return null;
  const key = `atok:${await sha256Hex(secret)}`;
  const tok = await env.KILN.get(key, 'json');
  // Trust the stored expiry, not only KV's TTL.
  if (!tok || (tok.exp && tok.exp < Date.now())) return null;
  if (!(await stillItsRepo(env, key, tok))) { tokenRefusal.set(request, TOKEN_REPO_CHANGED); return null; }
  return tok;
}

// Why apiTokenAuth said no, when the token itself is good.
const tokenRefusal = new WeakMap();
const TOKEN_REPO_CHANGED = 'This token was made for a different repository than the one that now answers to its name, so nothing was read or changed: the site owner corrects repo in kiln-config.js if the repository was renamed or moved, or makes a new token if it was deleted and made again.';

/** The answer to an API request that apiTokenAuth turned down. */
function tokenRefused(request) {
  const why = tokenRefusal.get(request);
  return why ? json({ error: why, code: 'repo_changed' }, 403) : json({ error: 'unauthorized' }, 401);
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
  if (!tok) return tokenRefused(request);
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
  if (!tok) return tokenRefused(request);
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
  if (!tok) return tokenRefused(request);
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

// The largest body the proxy will read from an editor session: one file at the
// upload ceiling, base64-encoded, plus room for the JSON around it.
const PROXY_BODY_MAX = Math.ceil(UPLOAD_MAX_BYTES * 4 / 3) + 256 * 1024;
// Git modes for an ordinary file. Symlinks (120000) and submodules (160000)
// are never something an editor session commits.
const REGULAR_FILE_MODES = ['100644', '100755'];

/**
 * Read a request body as text, giving up once it passes `max` bytes, so an
 * oversized upload is turned away without being held in memory whole. Decoded
 * as it streams in — no second full-size copy. Returns { text } or
 * { tooLarge: true }.
 */
async function readBodyCapped(request, max) {
  if (Number(request.headers.get('Content-Length') || 0) > max) return { tooLarge: true };
  if (!request.body) return { text: '' };
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch { /* already closed */ }
      return { tooLarge: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode() };
}

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
  // Everything below reaches GitHub by the session's name. If that name now
  // answers as another repository than the one the session was made for,
  // nothing is asked of it: the session is refused as an ended one is.
  if (await answersAsAnother(env, sess.repo, sess.rid)) return sessionRepoChanged();

  // A site whose config still has the name from before a rename or a transfer
  // asks for /repos/<that name>/…. When the worker's records say it is the
  // repository this session is on, the request is carried out under the
  // session's own name. Any other name falls through to the allowlist below
  // and is refused there, as it always was.
  {
    const asked = /^\/repos\/([\w.-]+\/[\w.-]+)(?=[/?]|$)/.exec(ghPath);
    if (asked && asked[1] !== sess.repo && await sameOnRecord(env, asked[1], sess.repo)) {
      ghPath = `/repos/${sess.repo}${ghPath.slice(asked[0].length)}`;
    }
  }

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
  const isWrite = !['GET', 'HEAD'].includes(request.method);

  // Review-mode sessions are comment-only: the proxy is read-only for them.
  if (sess.mode === 'review' && isWrite) {
    return json({ error: 'review-mode: comment-only access' }, 403);
  }

  // ONE capped read of the body, shared by every check below and by the
  // forward to GitHub. The cap is the size ceiling on what an editor session
  // can send at all: an oversized upload is refused before it is buffered
  // whole, let alone parsed. `parsedBody` stays null for an absent or non-JSON
  // body, which every guard below treats as "nothing to vouch for".
  let rawBody = '';
  let parsedBody = null;
  if (isWrite) {
    const read = await readBodyCapped(request, PROXY_BODY_MAX);
    if (read.tooLarge) return json({ error: FILE_MESSAGES.size, code: 'file_size' }, 413);
    rawBody = read.text;
    try { parsedBody = JSON.parse(rawBody); } catch { /* non-JSON */ }
  }

  // Suggest-mode sessions: direct writes may only touch kiln scratch branches —
  // publishing to the live branch goes through the suggestions queue. Checked
  // FIRST so a misdirected publish gets the intentional 403 before we spend
  // GitHub calls on content verification. A non-JSON body is branch-less.
  if (sess.mode === 'suggest' && isWrite) {
    const deny = suggestWriteViolation(request.method, ghPath, parsedBody);
    if (deny) return json({ error: deny }, 403);
  }

  if (request.method === 'PUT' && cleanPath.includes('/contents/')) {
    const filePath = decodeURIComponent(cleanPath.split('/contents/')[1] || '');
    if (isSensitivePath(filePath)) return json({ error: 'forbidden path for editor' }, 403);
    if (!pathInScope(filePath, sess.paths)) return json({ error: 'outside your editing scope', path: filePath }, 403);
    // File-type gate: an editor writes pages, stylesheets and a short list of
    // inert uploads — never SVG/XML/XSL or anything else a browser or a build
    // would run. The type is judged from the path alone, so it is refused
    // before the body is even looked at; then size, then (for uploads) whether
    // the leading bytes are what the name claims.
    const refuseFile = (p) => json({ error: p.error, code: p.code, path: filePath }, p.status);
    const wrongType = uploadProblem(filePath);
    if (wrongType) return refuseFile(wrongType);
    if (!parsedBody || typeof parsedBody !== 'object') return json({ error: 'unreadable write body' }, 400);
    if (typeof parsedBody.content !== 'string') return json({ error: 'write needs content' }, 400);
    // Tool grants: a write no button offers this editor is refused here too.
    const needs = writeGrantNeeded(sess, filePath, { adds: !parsedBody.sha, branch: typeof parsedBody.branch === 'string' ? parsedBody.branch : '' });
    if (needs) return grantRefusal(needs, filePath);
    const unfit = uploadProblem(filePath, { size: base64Bytes(parsedBody.content), head: base64Head(parsedBody.content) });
    if (unfit) return refuseFile(unfit);
    // Content guard (C2): an editor session bypasses the browser's DOMPurify by
    // PUTting raw markup here. For HTML pages, refuse any write that INTRODUCES
    // executable markup (script/handlers/dangerous URLs/framing) not already in
    // the committed version. Fails CLOSED — a guard error blocks the write.
    if (isHtmlPath(filePath)) {
      let newHtml;
      const curSha = parsedBody.sha;
      try { newHtml = utf8FromB64(parsedBody.content); }
      catch { return json({ error: 'unreadable write body' }, 400); }
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
  // A blob is created before anything says where it will live, so the only
  // thing to hold it to here is the size ceiling. Its type is judged when a
  // commit gives it a path (commitDiffInScope).
  if (request.method === 'POST' && /\/git\/blobs$/.test(cleanPath) && parsedBody && typeof parsedBody.content === 'string') {
    const size = parsedBody.encoding === 'base64' ? base64Bytes(parsedBody.content) : new TextEncoder().encode(parsedBody.content).length;
    if (size > UPLOAD_MAX_BYTES) return json({ error: FILE_MESSAGES.size, code: 'file_size' }, 413);
  }
  // Non-JSON body — the allowlist already gated the route.
  if (request.method === 'POST' && /\/git\/trees$/.test(cleanPath) && parsedBody && Array.isArray(parsedBody.tree)) {
    const tree = parsedBody.tree;
    // A subtree entry (type:"tree") pulls in a whole subtree we can't see —
    // editors must submit blob-level entries only, each individually scoped.
    if (tree.some(e => e && e.type === 'tree')) {
      return json({ error: 'editors may not submit subtree entries' }, 403);
    }
    if (tree.some(e => e && isSensitivePath(e.path))) {
      return json({ error: 'forbidden path for editor' }, 403);
    }
    if (tree.some(e => e && (!e.path || !pathInScope(e.path, sess.paths)))) {
      return json({ error: 'outside your editing scope' }, 403);
    }
    // No deletes: a `sha: null` entry removes the file at that path.
    const gone = tree.find(e => e && e.sha === null);
    if (gone) return json({ error: NO_DELETE_MESSAGE, code: 'no_delete', path: gone.path }, 403);
    // Same file-type gate as a direct write, as early as the path is known.
    // Only regular files: a symlink would let an allowed name serve another
    // file's bytes.
    for (const e of tree) {
      if (!e) continue;
      const needs = writeGrantNeeded(sess, e.path);
      if (needs) return grantRefusal(needs, e.path);
      if (!REGULAR_FILE_MODES.includes(String(e.mode))) return json({ error: 'editors may only commit regular files', path: e.path }, 403);
      const unfit = uploadProblem(e.path, typeof e.content === 'string' ? { size: new TextEncoder().encode(e.content).length } : undefined);
      if (unfit) return json({ error: unfit.error, code: unfit.code, path: e.path }, unfit.status);
    }
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
  //   • ref writes also name the commit that goes live, so that commit is judged
  //     again there (refWriteCheck): a commit made somewhere else, or one that
  //     brings another branch's history with it, never passed the check above.
  if (!sess.admin && (request.method === 'POST' || request.method === 'PATCH')
      && /\/git\/refs(\/|$)/.test(cleanPath)) {
    if (parsedBody?.force) return json({ error: 'editors may not force-update refs' }, 403);
    const checked = await refWriteCheck(env, itok, sess, request.method, cleanPath, parsedBody);
    if (checked.refuse) return checked.refuse;
    // Forward only the fields that were judged.
    rawBody = JSON.stringify(checked.body);
    parsedBody = checked.body;
  }
  if (!sess.admin && request.method === 'POST' && /\/git\/commits$/.test(cleanPath)) {
    const scopeErr = await commitDiffInScope(env, itok, sess, rawBody);
    if (scopeErr) return scopeErr;
  }

  const headers = {
    Authorization: `Bearer ${itok}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': UA,
  };
  let body;
  if (isWrite) {
    headers['Content-Type'] = 'application/json';
    body = rawBody;
    // Attribute the change to the human editor (committer stays the Kiln bot).
    // Anything that is not a JSON object passes through untouched.
    if (parsedBody && typeof parsedBody === 'object' && (ghPath.includes('/contents/') || ghPath.includes('/git/commits'))) {
      parsedBody.author = editorStamp(sess);
      body = JSON.stringify(parsedBody);
    }
  }
  const res = await fetch(`${GH}${ghPath}`, { method: request.method, headers, body });
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' } });
}

// An editor session changes and adds files; it never removes one. Removing a
// page or a picture is the owner's call, made in the repository.
const NO_DELETE_MESSAGE = 'editors cannot delete files';

// The author every commit made through an editor session carries. The
// committer stays the Kiln bot.
const EDITOR_COMMIT_EMAIL = 'kiln-editor@users.noreply.github.com';
function editorStamp(sess) {
  return { name: `${sess.name} (via Kiln)`, email: EDITOR_COMMIT_EMAIL };
}
// Names are compared by their letters and digits only: git trims punctuation
// from the ends of a name, and that must not turn a real publish away.
const nameLetters = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Judge a ref write from an editor session. A ref decides what is live, so
 * this is where "the worker checked that commit" has to be true.
 *
 *   PATCH …/git/refs/heads/<branch>   the new commit must sit directly on the
 *     branch's current head (one parent, no other history riding along), carry
 *     the author this worker stamps on the session's commits, and pass the same
 *     check as a commit created through the proxy: scope, file types, content.
 *   POST …/git/refs   a new branch or tag may only point at a commit the
 *     default branch already contains, or at the head of an existing branch.
 *
 * Returns { body } (the fields to forward) or { refuse: Response }.
 * Fails CLOSED: if GitHub cannot be asked, the write does not happen.
 */
async function refWriteCheck(env, itok, sess, method, cleanPath, body) {
  const refuse = (error, status = 403, extra = {}) => ({ refuse: json({ error, ...extra }, status) });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('unreadable ref body', 400);
  const sha = String(body.sha || '').toLowerCase();
  if (!COMMIT_SHA_RE.test(sha)) return refuse('a ref needs a full commit sha', 400);
  let decoded = cleanPath;
  try { decoded = decodeURIComponent(cleanPath); } catch { /* judge raw */ }
  const repoPath = `/repos/${sess.repo}`;
  const gh = async (p) => {
    const r = await fetch(`${GH}${p}`, { headers: { Authorization: `Bearer ${itok}`, Accept: 'application/vnd.github+json', 'User-Agent': UA } });
    return { ok: r.ok, status: r.status, data: r.ok ? await r.json() : null };
  };
  const encRef = (name) => name.split('/').map(encodeURIComponent).join('/');
  try {
    if (method === 'PATCH') {
      const m = /\/git\/refs\/heads\/(.+)$/.exec(decoded);
      if (!m) return refuse('editors may only move branches');
      const branch = m[1];
      const cur = await gh(`${repoPath}/git/ref/heads/${encRef(branch)}`);
      if (!cur.ok) return cur.status === 404 ? refuse('no such branch', 404) : refuse('could not verify the branch', 502);
      const head = String(cur.data?.object?.sha || '');
      if (!COMMIT_SHA_RE.test(head)) return refuse('could not verify the branch', 502);
      if (sha === head) return { body: { sha } };   // already there: nothing moves
      const c = await gh(`${repoPath}/git/commits/${sha}`);
      if (!c.ok) return c.status === 404 ? refuse('no such commit in this repository') : refuse('could not verify the commit', 502);
      const parents = Array.isArray(c.data.parents) ? c.data.parents : [];
      if (parents.length !== 1 || parents[0].sha !== head) {
        return refuse('a branch can only move to a commit made directly on top of its current head', 403, { code: 'ref_not_direct' });
      }
      const stamp = editorStamp(sess);
      if (c.data.author?.email !== stamp.email || nameLetters(c.data.author?.name) !== nameLetters(stamp.name)) {
        return refuse('that commit was not made through this editing session', 403, { code: 'ref_foreign_commit' });
      }
      const bad = await commitDiffInScope(env, itok, sess, JSON.stringify({ tree: c.data.tree?.sha, parents: [head] }), { branch });
      if (bad) return { refuse: bad };
      return { body: { sha } };
    }
    // POST: create a ref.
    const ref = typeof body.ref === 'string' ? body.ref : '';
    if (!/^refs\/(heads|tags)\/[^\s~^:?*\[\\]+$/.test(ref)) return refuse('editors may only create branches and tags', 403);
    if (ref === 'refs/heads/kiln-drafts' && !hasGrant(sess, 'draft')) return { refuse: grantRefusal('draft') };
    const repo = await gh(repoPath);
    const base = repo.ok && typeof repo.data.default_branch === 'string' ? repo.data.default_branch : '';
    if (!base) return refuse('could not verify the repository', 502);
    const cmp = await gh(`${repoPath}/compare/${sha}...${encRef(base)}`);
    if (cmp.ok && (cmp.data.status === 'identical' || cmp.data.status === 'ahead') && cmp.data.behind_by === 0) return { body: { ref, sha } };
    if (!cmp.ok && cmp.status !== 404) return refuse('could not verify the commit', 502);
    // A site published from a branch other than the default one starts its
    // drafts from that branch's head.
    const branches = await gh(`${repoPath}/branches?per_page=100`);
    if (!branches.ok) return refuse('could not verify the commit', 502);
    if ((branches.data || []).some(b => b?.commit?.sha === sha)) return { body: { ref, sha } };
    return refuse('a new branch or version must start from a commit the site already has', 403, { code: 'ref_not_ancestor' });
  } catch (err) {
    return refuse('could not verify the ref', 502, { detail: String(err.message || err) });
  }
}

/**
 * Reject a proposed commit whose diff (vs its first parent) touches any path
 * outside the editor's scope or any sensitive path. Returns a 403 Response to
 * short-circuit, or null when the commit is in-scope. Fails CLOSED on any error.
 */
async function commitDiffInScope(env, itok, sess, bodyText, { branch } = {}) {
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
    const entry = new Map();   // path → the new tree's entry (mode + size) for the file-type gate
    for (const e of newTree.tree || []) if (e.type === 'blob') { after.set(e.path, e.sha); entry.set(e.path, e); }
    // Every path whose blob changed, was added, or was removed must be in scope.
    const changed = new Set();
    for (const [p, sha] of after) if (before.get(p) !== sha) changed.add(p);
    for (const p of before.keys()) if (!after.has(p)) changed.add(p);
    for (const p of changed) {
      if (isSensitivePath(p)) return json({ error: 'commit touches a forbidden path', path: p }, 403);
      if (!pathInScope(p, sess.paths)) return json({ error: 'commit touches a path outside your scope', path: p }, 403);
    }
    // No deletes, however the tree was built: a `sha: null` entry, or a tree
    // sent without its base so that every file it leaves out is gone.
    for (const p of before.keys()) {
      if (!after.has(p)) return json({ error: NO_DELETE_MESSAGE, code: 'no_delete', path: p }, 403);
    }
    // File-type gate on the git-data path (staged uploads, new posts, any
    // multi-file commit): every file this commit adds or changes must be a
    // regular file of a type editors may write, under the size ceiling, and an
    // upload's leading bytes must be what its name says. Read from the tree
    // GitHub built, so it holds however the blobs were made. Fails CLOSED.
    const blobHead = async (sha) => {
      const r = await fetch(`${GH}/repos/${sess.repo}/git/blobs/${sha}`, { headers: { Authorization: `Bearer ${itok}`, Accept: 'application/vnd.github.raw+json', 'User-Agent': UA } });
      if (!r.ok) throw new Error(`blob ${sha} ${r.status}`);
      // Raw media type: the body IS the file, so take the first bytes and hang
      // up. (If GitHub answers with the JSON envelope instead, read that.)
      if (!/param=raw/.test(r.headers.get('X-GitHub-Media-Type') || '')) return base64Head((await r.json()).content);
      const reader = r.body.getReader();
      let head = new Uint8Array(0);
      while (head.length < 48) {
        const { done, value } = await reader.read();
        if (done) break;
        head = concatBytes(head, value);
      }
      try { await reader.cancel(); } catch { /* already closed */ }
      return head;
    };
    for (const p of changed) {
      if (!after.has(p)) continue; // a removal carries nothing to judge
      const e = entry.get(p);
      if (!REGULAR_FILE_MODES.includes(String(e.mode))) return json({ error: 'editors may only commit regular files', path: p }, 403);
      const refuseFile = (problem) => json({ error: problem.error, code: problem.code, path: p }, problem.status);
      const wrongType = uploadProblem(p);
      if (wrongType) return refuseFile(wrongType);
      if (typeof e.size !== 'number') throw new Error(`no size for ${p}`);
      // Only an upload's bytes are sniffed, and only once it is known to fit.
      const sniff = isUploadKind(editorFileKind(p)) && e.size <= UPLOAD_MAX_BYTES;
      const unfit = uploadProblem(p, { size: e.size, head: sniff ? await blobHead(e.sha) : undefined });
      if (unfit) return refuseFile(unfit);
    }
    // Tool grants. The branch is only known once a ref is moved to the commit
    // (refWriteCheck); until then a commit is held to what its paths alone say.
    for (const p of changed) {
      const needs = writeGrantNeeded(sess, p, { adds: !before.has(p), branch });
      if (needs) return grantRefusal(needs, p);
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
  // Once per fresh token (every 50 minutes for a site in use): put this
  // repository's id on record, so a later rename can be followed. Never in the
  // way of the token.
  try { await lookUpRepo(env, repo, tok.token); } catch { /* best effort */ }
  return tok.token;
}

// ─── Repository identity (KLR-08) ────────────────────────────────────────────
// Everything a site stores here is filed under the `owner/name` its
// kiln-config.js gives. A name is not an identity: a repository can be renamed
// or moved to another account, and GitHub then answers to the old name only
// until someone else takes it. A repository's numeric id never changes, so the
// worker keeps, for every repository it meets:
//
//   rid:<id>            → { id, name, was?, at, from?, moved? }
//                           name   the name its things are filed under
//                           from   names a move is still bringing things from
//   rname:<owner/name>  → { id, at }         which repository a name is (lowercased)
//   rsee:<owner/name>   → { id, name }       GitHub's last answer for a name, 10 minutes
//   rmove:<id>          → { id, to, at, done, cursor? }   how far an unfinished move has got
//
// With that it can follow a rename. When a site starts using the new name,
// what it stores moves there: the people list and the Kiln Cloud registration
// at once, then comment threads, suggestions, API tokens, member sign-ins and
// scheduled publishes in bounded steps (see "Moving what a repository
// stores" below). While a site still uses the old name, everything is read
// from wherever it is filed. And it can tell a rename from a takeover: an old
// name that now answers as a different repository gets nothing that is stored
// for the one that had it before.

/** GitHub's answer for a name, read with the App's token: { id, name } or null. Cached for ten minutes. */
async function repoIdentity(env, repo) {
  const cached = await env.KILN.get(`rsee:${repo.toLowerCase()}`, 'json');
  if (cached && Number.isInteger(cached.id)) return cached;
  const tok = await installationToken(env, repo);   // a fresh token looks the repository up itself
  if (!tok) return null;
  return (await env.KILN.get(`rsee:${repo.toLowerCase()}`, 'json')) || lookUpRepo(env, repo, tok);
}

/** Ask GitHub what `repo` is now (a renamed repository answers to its old name with its current one), and put it on record. */
async function lookUpRepo(env, repo, token) {
  const res = await fetch(`${GH}/repos/${repo}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': UA },
  });
  if (!res.ok) return null;
  const info = await res.json();
  if (!Number.isInteger(info.id) || typeof info.full_name !== 'string') return null;
  const seen = { id: info.id, name: info.full_name };
  await admitRepo(env, repo, seen);
  await env.KILN.put(`rsee:${repo.toLowerCase()}`, JSON.stringify(seen), { expirationTtl: 600 });
  return seen;
}

/**
 * Put a repository's id on record for the name a site uses, and say whether
 * the name may be used for it. False only when the name is on record as one
 * repository, with that repository's things still stored under it, while
 * GitHub now answers to it as another. That is a takeover of an old name, or
 * a repository deleted and made again: either way what is stored belongs to
 * the repository that had the name before, and the record is left as it is.
 * A name with nothing stored under it is free and becomes the new
 * repository's. Writes only what is new; never throws.
 */
async function admitRepo(env, repo, seen) {
  try {
    const nameKey = `rname:${repo.toLowerCase()}`;
    const had = await env.KILN.get(nameKey, 'json');
    const other = !!had && Number.isInteger(had.id) && had.id !== seen.id;
    if (other && await stillFiledUnder(env, repo, had.id)) return false;
    if (!had || other) {
      await env.KILN.put(nameKey, JSON.stringify({ id: seen.id, at: Date.now() }));
      // What was last heard about this name may be about the repository that
      // had it before: forget it, so nothing is followed on stale word.
      await env.KILN.delete(`rsee:${repo.toLowerCase()}`);
    }
    if (!(await env.KILN.get(`rid:${seen.id}`))) await env.KILN.put(`rid:${seen.id}`, JSON.stringify({ id: seen.id, name: repo, at: Date.now() }));
  } catch { /* storage trouble must not lock an owner out; the record is written next time */ }
  return true;
}

/** Read only: is `repo` on record as another repository than `seen`, with that repository's things still stored under it? */
async function nameTakenOver(env, repo, seen) {
  try {
    const had = await env.KILN.get(`rname:${repo.toLowerCase()}`, 'json');
    if (!had || !Number.isInteger(had.id) || had.id === seen.id) return false;
    return await stillFiledUnder(env, repo, had.id);
  } catch { return false; }
}

/**
 * Does the repository `id` still have things filed under `name`? This is what
 * holds a name against whoever GitHub says has it now: the people list, as
 * before, and equally comment threads, suggestions, scheduled publishes and
 * API tokens. Sign-ins need no look of their own: they are filed where the
 * people list is, and a move ends or moves them before it lets go of a name.
 *
 * Schedules and tokens are found by reading every one of them, so that is
 * done last and only when the repository's things are filed under this very
 * name; after a finished move nothing of it names the old one any more.
 * Read only. If storage cannot be asked the answer is yes: what cannot be
 * shown to be nobody's is not handed over.
 */
async function stillFiledUnder(env, name, id) {
  try {
    if (await env.KILN.get(`people:${name}`)) return true;
    const rec = await env.KILN.get(`rid:${id}`, 'json');
    const same = (n) => typeof n === 'string' && n.toLowerCase() === name.toLowerCase();
    if (movingFrom(rec).some(same)) return true;                 // a move away from this name is not finished
    // Followed by the release before this one: only its people moved, and
    // what else it left under this name has yet to be brought along.
    if (rec && same(rec.was) && !same(rec.name) && !rec.moved && !Array.isArray(rec.from)) return true;
    const home = !rec || same(rec.name);
    const spellings = [...new Set([name, ...(rec && same(rec.name) ? [rec.name] : [])])];
    for (const n of spellings) {
      if (n !== name && await env.KILN.get(`people:${n}`)) return true;
      if (await anyKey(env.KILN, `cmt:${n}:`) || await anyKey(env.KILN, `sug:${n}:`)) return true;
    }
    if (!home) return false;
    return (await anyNaming(env, 'sched:', spellings)) || (await anyNaming(env, 'atok:', spellings));
  } catch { return true; }
}

/** Is there any key at all under a prefix? */
async function anyKey(kv, prefix) {
  return (await kv.list({ prefix, limit: 1 })).keys.length > 0;
}

/** Is there a record under `prefix` whose `repo` is one of `names`? Reads them all: for the rare ask only. */
async function anyNaming(env, prefix, names) {
  let cursor;
  do {
    const page = await env.KILN.list({ prefix, cursor });
    for (const k of page.keys) {
      const v = await env.KILN.get(k.name, 'json');
      if (v && names.includes(v.repo)) return true;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return false;
}

/** The names a move is still bringing a repository's things from. Empty when nothing is moving. */
function movingFrom(rec) {
  return rec && Array.isArray(rec.from) ? rec.from.filter(n => typeof n === 'string' && n && n !== rec.name) : [];
}

/**
 * `repo` is not the name its repository's things are filed under, or nothing
 * says so yet. Ask GitHub which repository it is and answer with that
 * repository's record: `name` is where its things are filed, and `from` (see
 * movingFrom) the names a move is still bringing them from. When `repo` is
 * the name GitHub has for the repository now and its things are under
 * another, the move to `repo` begins here. null when there is nothing to
 * follow.
 */
async function followRepo(env, repo) {
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || ''))) return null;
    const seen = await repoIdentity(env, repo);
    if (!seen) return null;
    const rec = await env.KILN.get(`rid:${seen.id}`, 'json');
    if (!rec || typeof rec.name !== 'string') return null;
    if (rec.name === repo) return movingFrom(rec).length ? rec : null;
    // A name that is on record as another repository, with that repository's
    // things still under it, is not followed: nothing is read from it for
    // this one and nothing of this one is moved into it.
    if (await nameTakenOver(env, repo, seen)) return null;
    // Asked by a name GitHub only redirects, or by another spelling of the
    // name the things are under: they stay where they are filed.
    if (repo.toLowerCase() !== seen.name.toLowerCase() || rec.name.toLowerCase() === repo.toLowerCase()) return rec;
    // Asked by the repository's current name: bring what is stored along.
    // Not on remembered word, though: what was heard up to ten minutes ago
    // (or is still read from KV somewhere a minute after it was dropped) may
    // say "current" of a name the repository has just left. GitHub is asked
    // again, and unless it says the same the things stay where they are.
    const token = await installationToken(env, repo);
    const fresh = token ? await lookUpRepo(env, repo, token) : null;
    if (!fresh || fresh.id !== seen.id || fresh.name.toLowerCase() !== repo.toLowerCase()) return rec;
    return await beginMove(env, seen.id, rec, repo);
  } catch (err) {
    console.error('repo follow failed', String(err && err.message || err));
    return null;
  }
}

/**
 * Turn a repository over to the name it has now. One write says both things
 * at once: its things are filed under `to` from here on, and what is under
 * its earlier names is still to come. Nothing is copied before that is on
 * record, so wherever this stops, every reader knows to look in both places
 * and the move is picked up again (moveStep). The people list is one key and
 * comes along here; the rest follows in bounded steps.
 */
async function beginMove(env, id, rec, to) {
  const from = [...new Set([...movingFrom(rec), rec.name])].filter(n => n !== to);
  const next = { id, name: to, was: rec.name, at: Date.now(), from };
  await env.KILN.put(`rid:${id}`, JSON.stringify(next));
  await env.KILN.put(`rmove:${id}`, JSON.stringify({ id, to, at: next.at, done: {} }));
  await env.KILN.put(`rname:${to.toLowerCase()}`, JSON.stringify({ id, at: next.at }));
  for (const name of from) {
    // The old name stays on record as this repository: that is what answers a
    // site still using it, and what keeps the name from anyone else until
    // everything under it has left.
    const key = `rname:${name.toLowerCase()}`;
    if (!(await env.KILN.get(key))) await env.KILN.put(key, JSON.stringify({ id, at: next.at }));
    // What was last heard about it may say it is the current name: forget
    // that, so nothing is moved back on stale word.
    if (name.toLowerCase() !== to.toLowerCase()) await env.KILN.delete(`rsee:${name.toLowerCase()}`);
  }
  await movePeople(env.KILN, from, to);
  if (env.kiln_cloud) {
    for (const name of from) {
      try { await env.kiln_cloud.prepare('UPDATE sites SET repo = ? WHERE lower(repo) = lower(?)').bind(to, name).run(); } catch { /* the registration is corrected by hand */ }
    }
  }
  console.log(`repo followed: ${rec.name} is now ${to} (id ${id}); what is stored under ${from.join(', ')} follows`);
  return next;
}

/**
 * A repository followed by the release before this one has only its people
 * under its new name. What it left under the name before (`was`) follows
 * now, unless that name has since become another repository's: then what is
 * under it is not this repository's to take. Decided once, and written down.
 */
async function adoptLeftBehind(env, rec) {
  if (typeof rec.was !== 'string' || rec.was === rec.name || Array.isArray(rec.from) || rec.moved || !Number.isInteger(rec.id)) return rec;
  try {
    const key = `rname:${rec.was.toLowerCase()}`;
    const named = await env.KILN.get(key, 'json');
    const ours = !named || named.id === rec.id;
    const next = ours ? { ...rec, from: [rec.was] } : { ...rec, moved: Date.now() };
    await env.KILN.put(`rid:${rec.id}`, JSON.stringify(next));
    if (ours) {
      if (!named) await env.KILN.put(key, JSON.stringify({ id: rec.id, at: Date.now() }));
      await env.KILN.put(`rmove:${rec.id}`, JSON.stringify({ id: rec.id, to: rec.name, at: Date.now(), done: {} }));
    }
    return next;
  } catch { return rec; }
}

/**
 * Where a repository's stored things are, for a request made under `repo`:
 *   home    the name they are filed under; whatever is written goes there
 *   names   every name to read from, home first. More than one only while a
 *           move after a rename or a transfer is unfinished.
 * Answered from the worker's own records: two KV reads for a repository that
 * never changed its name, and GitHub is asked (followRepo) only when the
 * records say this name's repository files its things under another one.
 * While a move is unfinished, a request also does one bounded step of it
 * (moveStep) unless `step` is false. Never throws: with no record, or with
 * trouble, a name is simply its own shelf, as it always was.
 */
async function shelf(env, repo, { step = true } = {}) {
  const plain = { home: repo, names: [repo] };
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || ''))) return plain;
    const named = await env.KILN.get(`rname:${repo.toLowerCase()}`, 'json');
    if (!named || !Number.isInteger(named.id)) return plain;
    let rec = await env.KILN.get(`rid:${named.id}`, 'json');
    if (!rec || typeof rec.name !== 'string') return plain;
    if (rec.name !== repo) {
      rec = await followRepo(env, repo);
      if (!rec) return plain;
    }
    rec = await adoptLeftBehind(env, rec);
    const from = movingFrom(rec);
    if (from.length && step) await moveStep(env, Number.isInteger(rec.id) ? rec.id : named.id, MOVE_OPS_PER_REQUEST);
    return { home: rec.name, names: [rec.name, ...from] };
  } catch { return plain; }
}

/** By the worker's own records, are two names the same repository? KV only: GitHub is not asked. */
async function sameOnRecord(env, a, b) {
  if (a === b) return true;
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  try {
    const [x, y] = await Promise.all([a, b].map(n => env.KILN.get(`rname:${n.toLowerCase()}`, 'json')));
    return !!x && !!y && Number.isInteger(x.id) && x.id === y.id;
  } catch { return false; }
}

/**
 * The one rule about a name that may have changed hands, for whatever
 * reaches a repository by a stored name: whoever answers to the name now
 * must be the repository the thing was made for.
 *
 *   id     the repository it was made for: the id it carries (`madeFor`),
 *          or, when it carries none, the id on record for the name
 *   seen   GitHub's answer for the name, remembered for ten minutes
 *   other  true only when both are known and they are different repositories
 *
 * A name with no id on record is used as it always was, and GitHub is not
 * asked about it. A name GitHub cannot be asked about is not `other` either.
 * Throws when storage or GitHub does: the caller decides what that means.
 */
async function whoAnswers(env, name, madeFor) {
  let id = Number.isInteger(madeFor) ? madeFor : null;
  if (id === null) {
    const named = await env.KILN.get(`rname:${String(name).toLowerCase()}`, 'json');
    if (named && Number.isInteger(named.id)) id = named.id;
  }
  if (id === null) return { id, seen: null, other: false };
  const seen = await repoIdentity(env, name);
  return { id, seen, other: !!seen && seen.id !== id };
}

// ─── A session or a token is for one repository ──────────────────────────────
// An editor session and an API token reach their repository by a name, and a
// name can change hands: a site that never corrected its config after a
// rename, whose old name another repository then takes, would send its
// editors' and its scripts' commits there. So an editor session, a member's
// sign-in and an API token carry the id of the repository they were made for
// (`rid`), and each use asks the question the cron asks before a scheduled
// publish (whoAnswers): is whoever answers to this name now that repository?
//
//   · On the usual path that is one more KV read, of the ten-minute `rsee:`
//     answer. GitHub is asked once when that has run out, not per request.
//   · An editor session made before ids were carried is held to the id on
//     record for its name, which is the cron's rule exactly, and costs one
//     read more. It is never rewritten to add the id: a rewrite could bring
//     back a session that taking someone off the list is ending at that
//     moment. It carries one from the person's next sign-in.
//   · A member's sign-in or a token from before takes that id the first time
//     it is used (stillItsRepo), rewritten in place as a move rewrites them.
//     For a sign-in that is harmless: the people list is asked again at every
//     check. A token cannot be ended instead: only its holder has it.
//   · One whose name answers as another repository is refused, not removed:
//     it is good again once the site says where the repository went.

/**
 * The id of the repository whose things are filed under `name`, by the
 * worker's own record of the name: what a new session, sign-in or token is
 * made for. Not whatever GitHub says the name is today: a name can be held
 * for the repository that had it before (admitRepo), and someone on that
 * repository's list is signed in to that repository. A name the worker has
 * never met is looked up once, which puts it on record. null when there is
 * nothing to go by; never throws.
 */
async function idOnRecord(env, name) {
  try {
    const key = `rname:${String(name).toLowerCase()}`;
    let named = await env.KILN.get(key, 'json');
    if (!named) {
      await repoIdentity(env, name);
      named = await env.KILN.get(key, 'json');
    }
    return named && Number.isInteger(named.id) ? named.id : null;
  } catch { return null; }
}

/**
 * whoAnswers, for a request about to use a session under `name`: true when
 * the name is known to answer as another repository than the one the session
 * was made for. Not being able to read the records, or to ask GitHub, is not
 * knowing: the request then goes on as it did before ids were carried, so a
 * storage hiccup signs nobody out and stops no token.
 */
async function answersAsAnother(env, name, madeFor) {
  try { return (await whoAnswersSoon(env, name, madeFor)).other; }
  catch { return false; }
}

// How long a request waits to learn who a name is before it goes on without
// knowing. Comments, presence and a members gate's check ask GitHub for
// nothing else, and must not hang on the day it does not answer (a members
// gate gives the worker five seconds).
const ASK_WAIT_MS = 2500;

/** whoAnswers, given up on after ASK_WAIT_MS: it then throws, as for any other trouble. */
async function whoAnswersSoon(env, name, madeFor) {
  let timer;
  try {
    return await Promise.race([
      whoAnswers(env, name, madeFor),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('no answer in time about who a name is')), ASK_WAIT_MS); }),
    ]);
  } finally { clearTimeout(timer); }
}

/**
 * The same question for a record that may take its id here: `record`, stored
 * under `key`, names its repository in `repo`. False only when that name is
 * known to answer as another repository. A record from before ids were
 * carried takes the id on record for its name the first time it is used,
 * whatever the answer, and carries it from then on.
 */
async function stillItsRepo(env, key, record) {
  let who;
  try { who = await whoAnswersSoon(env, record.repo, record.rid); } catch { return true; }
  if (!Number.isInteger(record.rid) && who.id !== null) await takeId(env, key, record.repo, who.id);
  return !who.other;
}

/**
 * Write a repository's id into a stored record that has none, in place and
 * with the expiry it had (as a move rewrites it). It looks again first: only
 * a record that is still there, still without an id and still under the same
 * name is written, so one that was removed or moved a moment ago is left
 * alone. Never throws: what is not written now is written at the next use.
 */
async function takeId(env, key, repo, id) {
  try {
    const [listed] = (await env.KILN.list({ prefix: key, limit: 1 })).keys;
    if (!listed || listed.name !== key) return;
    const keep = keepExpiry(listed);
    if (keep === null) return;
    const now = await env.KILN.get(key, 'json');
    if (!now || Number.isInteger(now.rid) || now.repo !== repo) return;
    await env.KILN.put(key, JSON.stringify({ ...now, rid: id }), keep);
  } catch { /* storage trouble: next time */ }
}

// What a refused session is told. The status and `error` are those of a
// session that has ended, which every editor already knows; the rest is for
// whoever reads the answer.
const SESSION_REPO_CHANGED = 'This sign-in was made for a different repository than the one that now answers to the name this site uses, so nothing was read or changed. The site owner can run kiln doctor: it says what to correct.';
function sessionRepoChanged() {
  return json({ error: 'session expired', code: 'repo_changed', message: SESSION_REPO_CHANGED }, 401);
}

/**
 * The entries of one kind (comment threads, suggestions) a repository has,
 * over every name they may be filed under. Old names are listed first and
 * the home name last, so an entry that moves while this runs is still met;
 * one that is under both for a moment (copied, not yet removed) counts once,
 * as its copy under the home name. At most `max` entries.
 */
async function shelfEntries(env, names, prefixOf, max) {
  const home = prefixOf(names[0]);
  const at = new Map();   // the part of a key after its prefix → the key to read
  let truncated = false;
  for (const name of [...names.slice(1), names[0]]) {
    const prefix = prefixOf(name);
    let cursor;
    do {
      const batch = await env.KILN.list({ prefix, cursor });
      for (const k of batch.keys) {
        const rest = k.name.slice(prefix.length);
        if (!at.has(rest) && at.size >= max) { truncated = true; break; }
        at.set(rest, k.name);
      }
      cursor = truncated || batch.list_complete ? null : batch.cursor;
    } while (cursor);
    if (truncated) break;
  }
  return { entries: [...at].map(([rest, key]) => ({ key, home: home + rest })), truncated };
}

/** Read one such entry. If it moved between the listing and now, it is under the home name. */
async function shelfRead(env, entry) {
  const v = await env.KILN.get(entry.key, 'json');
  return v || entry.key === entry.home ? v : env.KILN.get(entry.home, 'json');
}

/**
 * Find one entry that is about to be changed, under whichever name it is
 * filed. Returns { value, save } or null. save() writes it under the home
 * name and only then removes a copy an unfinished move had not got to, so
 * the change is never under the old name alone.
 */
async function shelfFind(env, names, keyOf) {
  const home = keyOf(names[0]);
  let value = null, old = null;
  for (const name of names.slice(1)) {
    const key = keyOf(name);
    const v = await env.KILN.get(key, 'json');
    if (v) { value = v; old = key; break; }
  }
  // Looked at last, so an entry moved a moment ago is not missed; and when
  // it is under both names, the copy under the home name is the newer one.
  const current = await env.KILN.get(home, 'json');
  if (current) value = current;
  if (!value) return null;
  return {
    value,
    save: async (next) => {
      await env.KILN.put(home, JSON.stringify(next));
      if (old) await env.KILN.delete(old);
    },
  };
}

// ─── Moving what a repository stores to its new name ─────────────────────────
// A site can hold hundreds of comment threads, and a request may only make so
// many KV operations, so a move is done in steps. Each step is bounded:
//
//   MOVE_OPS_PER_REQUEST   KV operations a request spends on an unfinished
//                          move (about a dozen comment threads)
//   MOVE_OPS_PER_CRON      the same for one cron run, which is what finishes
//                          a move nobody is making requests for
//
// What makes it safe to stop anywhere:
//   · `rid:<id>.from` names the old names until the move is done, and every
//     reader looks under them as well as under the new one (shelf);
//   · a thread or a suggestion is copied to its new key BEFORE its old key
//     is removed, and never over a copy that is already there (that copy has
//     been written to since);
//   · tokens and member sign-ins are rewritten in place, one write each;
//   · editor sign-ins under the old name are ended: an editor signs in again
//     and gets a session filed under the new one;
//   · scheduled publishes are rewritten by the cron pass that publishes them
//     (runDueSchedules), not here, so one cannot be moved by a request while
//     the cron is publishing it. Only where no cron has done it within the
//     hour (a worker set up without the cron trigger) does a step do it;
//   · the move is done only when every old name is seen empty, and then
//     `from` and `rmove:<id>` go.

const MOVE_OPS_PER_REQUEST = 60;
const MOVE_OPS_PER_CRON = 400;
// How long a move waits for the cron to file its scheduled publishes (the
// cron runs every five minutes) before a step does it instead.
const MOVE_SCHED_WAIT_MS = 60 * 60 * 1000;
// What a step may spend outside its copying: reading the two records, the
// people list, and writing down where it got to.
const MOVE_OVERHEAD = 12;

/** The two bounds, for the tests. */
function moveBounds() {
  return { request: MOVE_OPS_PER_REQUEST, cron: MOVE_OPS_PER_CRON };
}

/** KV with a count of the operations made through it. */
function metered(kv) {
  const m = { ops: 0 };
  for (const op of ['get', 'put', 'delete', 'list']) m[op] = (...args) => { m.ops++; return kv[op](...args); };
  return m;
}

/** KV options that keep a rewritten key's expiry as it was. null: it is about to expire, so it is left to (KV refuses so short a life). */
function keepExpiry(key) {
  if (!key.expiration) return undefined;
  return key.expiration - Math.floor(Date.now() / 1000) < 90 ? null : { expiration: key.expiration };
}

/** The people list: one key. Copied first, removed after; a list already under the new name is the one that counts. */
async function movePeople(kv, from, to) {
  for (const name of from) {
    const list = await kv.get(`people:${name}`);
    if (list === null) continue;
    if ((await kv.get(`people:${to}`)) === null) await kv.put(`people:${to}`, list);
    await kv.delete(`people:${name}`);
  }
}

/** Move the keys under one prefix to another, as many as `cap` allows. True once the old prefix is seen empty. */
async function movePrefix(kv, fromPrefix, toPrefix, cap) {
  for (;;) {
    const room = Math.floor((cap - kv.ops - 1) / 4);
    if (room < 1) return false;
    const page = await kv.list({ prefix: fromPrefix, limit: Math.min(room, 250) });
    if (!page.keys.length) return true;
    for (const k of page.keys) {
      const dst = toPrefix + k.name.slice(fromPrefix.length);
      const value = await kv.get(k.name);
      const keep = keepExpiry(k);
      if (value !== null && keep !== null && (await kv.get(dst)) === null) await kv.put(dst, value, keep);
      await kv.delete(k.name);
    }
  }
}

/**
 * One pass over every record of a kind that names its repository in its
 * value (`atok`, `msess`, `esess`, `sched`), as far as `cap` allows: those naming an
 * old name are rewritten to the new one, or, for editor sign-ins, ended.
 * Returns { done } or { done: false, cursor } to carry on from.
 */
async function moveNamed(kv, kind, old, to, cursor, cap) {
  for (;;) {
    const room = Math.floor((cap - kv.ops - 1) / 2);
    if (room < 1) return { done: false, cursor };
    let page;
    try { page = await kv.list({ prefix: `${kind}:`, limit: Math.min(room, 1000), ...(cursor ? { cursor } : {}) }); }
    catch (err) {
      if (!cursor) throw err;
      cursor = undefined;   // a place that is no longer good: the pass starts over, and what it already did stays done
      continue;
    }
    for (const k of page.keys) {
      const v = await kv.get(k.name, 'json');
      if (!v || !old.has(v.repo)) continue;
      if (kind === 'esess') { await kv.delete(k.name); continue; }
      const keep = keepExpiry(k);
      if (keep !== null) await kv.put(k.name, JSON.stringify({ ...v, repo: to }), keep);
    }
    if (page.list_complete || !page.cursor) return { done: true };
    cursor = page.cursor;
  }
}

/**
 * One bounded step of a repository's move to its new name. Spends at most
 * `budget` KV operations and returns how many it spent. Never throws: a step
 * that fails part way has lost nothing (see the notes above) and the next
 * one starts from what is actually there.
 */
async function moveStep(env, id, budget) {
  const kv = metered(env.KILN);
  try {
    const rec = await kv.get(`rid:${id}`, 'json');
    const from = movingFrom(rec);
    if (!from.length) { await kv.delete(`rmove:${id}`); return kv.ops; }
    const to = rec.name;
    const kept = await kv.get(`rmove:${id}`, 'json');
    const mv = kept && kept.to === to && kept.done && typeof kept.done === 'object' ? kept : { id, to, at: Date.now(), done: {} };
    const before = JSON.stringify(kept);
    const cap = budget - MOVE_OVERHEAD;

    await movePeople(kv, from, to);
    let empty = true;
    for (const name of from) {
      for (const kind of ['cmt', 'sug']) {
        if (!(await movePrefix(kv, `${kind}:${name}:`, `${kind}:${to}:`, cap))) empty = false;
      }
    }
    const old = new Set(from);
    // Scheduled publishes are filed under the new name by the cron pass that
    // publishes them. With none stored there is nothing for it to do; and if
    // an hour has gone by without it, no cron is running and a step does it.
    if (!mv.done.sched && !(await anyKey(kv, 'sched:'))) mv.done.sched = true;
    const overdue = Date.now() - (Number(mv.at) || 0) > MOVE_SCHED_WAIT_MS;
    for (const kind of ['atok', 'msess', 'esess', ...(overdue ? ['sched'] : [])]) {
      if (mv.done[kind]) continue;
      const pass = await moveNamed(kv, kind, old, to, mv.cursor && mv.cursor[kind], cap);
      const cursor = { ...(mv.cursor || {}) };
      delete cursor[kind];
      if (pass.done) mv.done[kind] = true;
      else if (pass.cursor) cursor[kind] = pass.cursor;
      if (Object.keys(cursor).length) mv.cursor = cursor; else delete mv.cursor;
    }

    if (empty && ['atok', 'msess', 'esess', 'sched'].every(kind => mv.done[kind])) {
      // Unless the repository was turned over to yet another name meanwhile.
      const now = await kv.get(`rid:${id}`, 'json');
      if (now && now.name === to && now.at === rec.at) {
        const { from: _brought, ...settled } = now;
        await kv.put(`rid:${id}`, JSON.stringify({ ...settled, moved: Date.now() }));
        await kv.delete(`rmove:${id}`);
        console.log(`repo move finished: everything stored for ${from.join(', ')} is under ${to} (id ${id})`);
      }
    } else if (JSON.stringify(mv) !== before) {
      await kv.put(`rmove:${id}`, JSON.stringify(mv));
    }
  } catch (err) {
    console.error('repo move step failed', String(err && err.message || err));
  }
  return kv.ops;
}

/** The cron's share: carry every unfinished move one step further, within one run's budget. */
async function continueMoves(env) {
  let left = MOVE_OPS_PER_CRON;
  const page = await env.KILN.list({ prefix: 'rmove:', limit: 25 });
  for (const k of page.keys) {
    if (left <= MOVE_OVERHEAD) break;
    const id = Number(k.name.slice('rmove:'.length));
    if (!Number.isInteger(id)) { await env.KILN.delete(k.name); continue; }
    left -= await moveStep(env, id, left);
  }
}

/** Old name → { id, to } for every repository whose things are on the move. */
async function movesUnderWay(env) {
  const moving = new Map();
  const page = await env.KILN.list({ prefix: 'rmove:', limit: 25 });
  for (const k of page.keys) {
    const id = Number(k.name.slice('rmove:'.length));
    const rec = Number.isInteger(id) ? await env.KILN.get(`rid:${id}`, 'json') : null;
    for (const name of movingFrom(rec)) moving.set(name, { id, to: rec.name });
  }
  return moving;
}

/** Are two names the same repository? Same spelling, or the same id by the worker's records or GitHub's answer. */
async function sameRepository(env, a, b) {
  if (a === b) return true;
  try {
    const [x, y] = [await repoIdentity(env, a), await repoIdentity(env, b)];
    return !!x && !!y && x.id === y.id;
  } catch { return false; }
}

/** What `kiln doctor` is told about a name: { renamed, reused }, or {} when GitHub cannot be asked. */
async function repoStanding(env, repo) {
  try {
    const seen = await repoIdentity(env, repo);
    if (!seen) return {};
    return { renamed: seen.name.toLowerCase() !== repo.toLowerCase(), reused: await nameTakenOver(env, repo, seen) };
  } catch { return {}; }
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
