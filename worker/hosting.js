/**
 * Hosting a site's files on Kiln's Cloudflare (the Kiln Cloud + hosting plan).
 *
 * A hosted site is one Cloudflare Worker that holds nothing but the site's
 * files ("static assets"), in a Cloudflare account that holds only customers'
 * sites. This module copies a repository's files there:
 *
 *   1. list the repository's files at the head of its default branch;
 *   2. hand Cloudflare the list (path, fingerprint, size). It answers with the
 *      fingerprints it does not have yet;
 *   3. fetch only those files from GitHub and send them on;
 *   4. deploy: the Worker now serves exactly that list.
 *
 * So the first copy sends everything, and a later one sends only what an edit
 * changed, which is why a published change is live in seconds.
 *
 * A file's fingerprint is made from the id git already has for its bytes (and
 * its extension, because Cloudflare keeps the content type with the bytes), so
 * nothing has to be downloaded to know whether Cloudflare has it. The site's
 * own `_headers` and `_redirects` files are not served as files: their text is
 * handed over as settings, which is how Cloudflare applies them. All of this
 * was tried against the real service before it was written (2026-11-12).
 *
 * Nothing here knows about accounts, plans or the dashboard: cloud.js decides
 * who may host what. The names it reads from the environment:
 *
 *   HOSTING_ACCOUNT_ID   the Cloudflare account that holds customers' sites
 *   HOSTING_API_TOKEN    a token for that account alone (a secret)
 *   HOSTING_SUBDOMAIN    that account's workers.dev name ("kiln-sites")
 *   HOSTING_PREFIX       put before every site's name (staging: "stg-")
 */

import { gh, inTurn, refPath, base64 } from './prepare.js';

const CF = 'https://api.cloudflare.com/client/v4';
const COMPATIBILITY_DATE = '2026-06-01';

export const LIMITS = {
  files: 20000,                    // files in one site
  fileBytes: 25 * 1024 * 1024,     // Cloudflare refuses a larger file
  newFiles: 5000,                  // files sent in one copy; more than this is not a small business site
  settingsBytes: 100 * 1024,       // a _headers or _redirects file larger than this is not read
};

export class HostingError extends Error {
  constructor(code, detail = '') { super(code); this.code = code; this.detail = String(detail).slice(0, 300); }
}

/** True when this service is set up to host sites at all. */
export function hostingOn(env) {
  return !!(env && env.HOSTING_ACCOUNT_ID && env.HOSTING_API_TOKEN && env.HOSTING_SUBDOMAIN);
}

/**
 * The name of a site's Worker, which is also the first part of its temporary
 * address: the repository's name made safe, and the start of the site's id so
 * that two repositories of the same name never share one. Lowercase letters,
 * digits and dashes, 63 at most, as a web address allows.
 */
export function siteName(env, { repo, id }) {
  const words = String(repo || '').split('/').pop().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'site';
  const tail = String(id || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || '0';
  const prefix = String(env?.HOSTING_PREFIX || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 8);
  return `${prefix}${words}-${tail}`.replace(/^-+/, '').slice(0, 63);
}

export const siteAddress = (env, name) => `https://${name}.${env.HOSTING_SUBDOMAIN}.workers.dev`;

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json', map: 'application/json', webmanifest: 'application/manifest+json', xml: 'application/xml', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  pdf: 'application/pdf', zip: 'application/zip', wasm: 'application/wasm',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
};
const extensionOf = (path) => { const name = String(path).split('/').pop(); const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''; };
export const contentType = (path) => TYPES[extensionOf(path)] || 'application/octet-stream';

// Not part of the website: anything hidden, packages, and the folder Cloudflare
// Pages reads its functions from (they are programs, not pages, and a hosted
// site runs none).
const SKIP_TOP = new Set(['node_modules', 'functions']);
const SETTINGS = new Set(['_headers', '_redirects', '_routes.json']);

/**
 * Which of a repository's files are the website, from GitHub's own listing
 * (`entries`: { path, type, sha, size, mode }). The whole repository is the
 * site, as it is on a host that publishes a repository as it stands. Left out:
 * hidden files and folders, node_modules, functions/, and the three settings
 * files. A file Cloudflare would refuse for its size is left out and named.
 */
export function publishedFiles(entries) {
  const files = [], skipped = [];
  let headers = null, redirects = null;
  for (const e of entries || []) {
    if (e.type !== 'blob') continue;
    const parts = String(e.path).split('/');
    if (parts.some(p => p.startsWith('.')) || parts.includes('node_modules')) continue;
    if (SKIP_TOP.has(parts[0])) continue;
    if (parts.length === 1 && SETTINGS.has(parts[0])) {
      if (parts[0] === '_headers') headers = e;
      if (parts[0] === '_redirects') redirects = e;
      continue;
    }
    if (Number(e.size) > LIMITS.fileBytes) { skipped.push({ path: e.path, why: 'large' }); continue; }
    files.push({ path: `/${e.path}`, sha: e.sha, size: Number(e.size) || 0 });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, headers, redirects, skipped };
}

const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

/** A file's fingerprint: 32 hex characters from git's id for its bytes, and its extension. */
export async function fingerprint(sha, path) {
  const data = new TextEncoder().encode(`git:${sha}.${extensionOf(path)}`);
  return hex(await crypto.subtle.digest('SHA-256', data)).slice(0, 32);
}

/** The list Cloudflare is handed ({ '/path': { hash, size } }), and which file each fingerprint is. */
export async function buildManifest(files) {
  const manifest = {}, byHash = new Map();
  for (const f of files) {
    const hash = await fingerprint(f.sha, f.path);
    manifest[f.path] = { hash, size: f.size };
    if (!byHash.has(hash)) byHash.set(hash, f);
  }
  return { manifest, byHash };
}

// ─── Cloudflare, with the token for the hosting account ───────────────────────

async function cloudflare(env, method, path, { json, form, bearer } = {}) {
  const headers = { Authorization: `Bearer ${bearer || env.HOSTING_API_TOKEN}` };
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  let res;
  try { res = await fetch(`${CF}/accounts/${env.HOSTING_ACCOUNT_ID}${path}`, { method, headers, body }); }
  catch (e) { throw new HostingError('cloudflare', `${method} ${path}: ${e?.message || e}`); }
  let data = null;
  try { data = await res.json(); } catch { /* an answer that is not JSON is a failure below */ }
  if (!res.ok || !data || data.success === false) {
    const why = (data?.errors || []).map(e => `${e.code || ''} ${e.message || ''}`.trim()).join('; ') || `status ${res.status}`;
    throw new HostingError(res.status === 404 ? 'cloudflare_missing' : 'cloudflare', `${method} ${path}: ${why}`);
  }
  return { status: res.status, result: data.result };
}

/** A repository's files at the head of its default branch: { state, branch, head, entries }. */
export async function readTree({ token, repo }) {
  const meta = await gh(token, 'GET', `/repos/${repo}`);
  if ([401, 403, 404].includes(meta.status)) return { state: 'no_access' };
  if (!meta.ok) return { state: 'github' };
  const branch = (await meta.json()).default_branch || 'main';
  const ref = await gh(token, 'GET', `/repos/${repo}/git/ref/heads/${refPath(branch)}`);
  if (ref.status === 404 || ref.status === 409) return { state: 'empty', branch };
  if (!ref.ok) return { state: 'github' };
  const head = (await ref.json())?.object?.sha;
  const listing = await gh(token, 'GET', `/repos/${repo}/git/trees/${head}?recursive=1`);
  if (!listing.ok) return { state: 'github' };
  const tree = await listing.json();
  if (tree.truncated) return { state: 'too_big', branch, head };
  return { state: 'ok', branch, head, entries: tree.tree || [] };
}

async function fileBytes(token, repo, sha) {
  const r = await gh(token, 'GET', `/repos/${repo}/git/blobs/${sha}`, null, 'application/vnd.github.raw');
  if (!r.ok) throw new HostingError('github', `blob ${sha}: ${r.status}`);
  return r.arrayBuffer();
}

async function settingsText(token, repo, entry) {
  if (!entry || Number(entry.size) > LIMITS.settingsBytes) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(await fileBytes(token, repo, entry.sha)); }
  catch (e) { if (e instanceof HostingError) throw e; return null; }   // not text: left out, the site still goes up
}

/**
 * Copy a repository's files to its Worker and deploy it. Returns
 * { state: 'live', url, commit, branch, files, sent, skipped } or, when the
 * repository cannot be hosted as it is, { state } with one of: 'no_access',
 * 'github', 'empty', 'too_big', 'no_home' (no index.html at the top). A
 * failure part-way is a HostingError, and the site keeps serving what it
 * served before: Cloudflare switches to the new files only at the last step.
 */
export async function deploySite(env, { token, repo, name, first = false }) {
  if (!hostingOn(env)) throw new HostingError('not_set_up');
  const tree = await readTree({ token, repo });
  if (tree.state !== 'ok') return tree;
  const { files, headers, redirects, skipped } = publishedFiles(tree.entries);
  if (!files.some(f => f.path === '/index.html')) return { state: 'no_home', branch: tree.branch, head: tree.head };
  if (files.length > LIMITS.files) return { state: 'too_big', branch: tree.branch, head: tree.head, fileCount: files.length };

  const { manifest, byHash } = await buildManifest(files);
  const script = `/workers/scripts/${encodeURIComponent(name)}`;
  const session = (await cloudflare(env, 'POST', `${script}/assets-upload-session`, { json: { manifest } })).result || {};
  const buckets = session.buckets || [];
  const wanted = buckets.reduce((n, b) => n + b.length, 0);
  if (wanted > LIMITS.newFiles) return { state: 'too_big', branch: tree.branch, head: tree.head, fileCount: files.length, newFiles: wanted };

  // With nothing to send, the first answer already carries the token that
  // says "every file is here". Otherwise it comes with the last upload.
  let done = buckets.length ? null : session.jwt;
  for (const bucket of buckets) {
    const parts = await inTurn(bucket, async (hash) => {
      const f = byHash.get(hash);
      if (!f) throw new HostingError('cloudflare', `asked for a file that is not in the list: ${hash}`);
      return { hash, path: f.path, bytes: await fileBytes(token, repo, f.sha) };
    });
    const form = new FormData();
    for (const p of parts) form.append(p.hash, new File([base64(p.bytes)], p.hash, { type: contentType(p.path) }), p.hash);
    const sent = await cloudflare(env, 'POST', '/workers/assets/upload?base64=true', { form, bearer: session.jwt });
    if (sent.result?.jwt) done = sent.result.jwt;
  }
  if (!done) throw new HostingError('cloudflare', 'every file was sent but Cloudflare did not say the set is complete');

  const config = { html_handling: 'auto-trailing-slash', not_found_handling: manifest['/404.html'] ? '404-page' : 'none' };
  const headersText = await settingsText(token, repo, headers);
  const redirectsText = await settingsText(token, repo, redirects);
  if (headersText) config._headers = headersText;
  if (redirectsText) config._redirects = redirectsText;
  const metadata = new FormData();
  metadata.append('metadata', JSON.stringify({
    compatibility_date: COMPATIBILITY_DATE,
    assets: { jwt: done, config },
    annotations: { 'workers/message': `${repo} at ${String(tree.head).slice(0, 7)}`.slice(0, 100) },
  }));
  await cloudflare(env, 'PUT', script, { form: metadata });
  // A new Worker has no address until it is switched on. Asked once; asking
  // again later would only repeat it.
  if (first) await cloudflare(env, 'POST', `${script}/subdomain`, { json: { enabled: true, previews_enabled: false } });

  return { state: 'live', url: siteAddress(env, name), commit: tree.head, branch: tree.branch, files: files.length, sent: wanted, skipped };
}

/** Take a site's Worker away. True when it is gone (or was never there). */
export async function removeSite(env, name) {
  if (!hostingOn(env)) throw new HostingError('not_set_up');
  try { await cloudflare(env, 'DELETE', `/workers/scripts/${encodeURIComponent(name)}?force=true`); return true; }
  catch (e) { if (e instanceof HostingError && e.code === 'cloudflare_missing') return true; throw e; }
}

/** The sentence a person reads for each way hosting can stop without the site going up. */
export function hostingSentence(code, { repo = 'the repository' } = {}) {
  switch (code) {
    case 'no_home': return `Kiln found no home page (a file named index.html) at the top of ${repo}, so there is nothing to show at the site's address yet. Add one, and Kiln puts the site up by itself.`;
    case 'empty': return `${repo} has no files yet. Put the site's pages in it, and Kiln puts the site up by itself.`;
    case 'too_big': return `This site has more files than Kiln's hosting takes on by itself. Write to info@kilncms.com and we will look at it with you.`;
    case 'no_access': return 'The Kiln app is not installed on that repository yet, or it was removed, so Kiln cannot read the site\'s files.';
    case 'not_set_up': return 'Hosting is not switched on for this service yet.';
    case 'github': return 'GitHub did not answer just now. The site is as it was. Kiln tries again by itself in a few minutes.';
    default: return 'Kiln could not put the new files up just now. The site is as it was. Kiln tries again by itself in a few minutes.';
  }
}
