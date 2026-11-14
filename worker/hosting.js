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
 *   HOSTING_MEMBER_KEY   switches the members area on for hosted sites (a
 *                        secret): each site's own secret is made from it
 *   HOSTING_SERVICE_URL  this service's own address, which a hosted site's
 *                        members gate asks about its members
 *
 * A site with files under members/ is uploaded with one small program beside
 * its files, the members gate (members-gate-entry.js), and Cloudflare runs it
 * only for the addresses in GATE_PATHS. Every other site, and every other
 * page, is plain files as before. See "The members area" below.
 */

import { gh, inTurn, refPath, base64, prepareSentence, readAstroSettings } from './prepare.js';
import { detectGenerators } from '../src/adapters/detect.js';
import { dayWords } from './mail.js';
import { MEMBERS_GATE_MODULE } from './members-gate.js';

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
 * digits and dashes, 63 at most, as a web address allows. It never begins
 * with "pv-", which is how every preview's name begins (previewName below):
 * a repository named that way gets "s-" in front, so no site can be given the
 * name of another site's preview.
 */
const idStart = (id) => String(id || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || '0';

// What stands before every name this service gives a Worker (staging: "stg-"), so the test service's sites and previews can be told from the live ones in the one hosting account.
const namePrefix = (env) => String((env && env.HOSTING_PREFIX) || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 8);

export function siteName(env, { repo, id }) {
  const said = String(repo || '').split('/').pop().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'site';
  const words = /^pv(-|$)/.test(said) ? `s-${said}` : said;
  const tail = idStart(id);
  const prefix = namePrefix(env);
  // A site whose files Kiln keeps already carries those eight characters at the end of its repository's name
  // (keeps.js), so they are not said twice in its address.
  return `${prefix}${words.endsWith(`-${tail}`) ? words : `${words}-${tail}`}`.replace(/^-+/, '').slice(0, 63);
}

export const siteAddress = (env, name) => `https://${name}.${env.HOSTING_SUBDOMAIN}.workers.dev`;

// ── Previews ───────────────────────────────────────────────────────────────
//
// A suggestion is written to a branch named kiln/suggest-<name>, and a shared
// draft to the branch kiln-drafts. Each such branch of a hosted site is put up
// as a second Worker of its own, so the link the editor shows leads somewhere.
// A preview never carries the pages under members/, tells search engines to
// leave it out, and is never attached to the site's own domain.

/** True for a branch the editor writes a suggestion or a shared draft to. */
export const isPreviewBranch = (branch) => typeof branch === 'string' && (branch === 'kiln-drafts' || branch.startsWith('kiln/suggest-'));

/**
 * The part of a preview's address that stands for its branch. The same rule,
 * step for step, as `previewUrl` in src/editor/suggest.js, which makes the link
 * the editor shows: the two must agree or the link leads nowhere.
 */
export function previewAlias(branch) {
  return String(branch).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
    .replace(/-+$/, '');
}

/** The name of the Worker a branch's preview is served from, or null for a branch with no usable name. */
export function previewName(env, site, branch) {
  const alias = previewAlias(branch);
  return alias ? `${namePrefix(env)}pv-${idStart(site?.id)}-${alias}` : null;
}

/**
 * The pattern a hosted site's settings file needs for its preview links
 * (`preview:` in the site's settings), with `{branch}` where the editor puts
 * the branch. Null when this service hosts nothing.
 */
export function previewPattern(env, site) {
  return hostingOn(env) && site?.id ? siteAddress(env, `${namePrefix(env)}pv-${idStart(site.id)}-{branch}`) : null;
}

/** What every preview's `_headers` ends with: no search engine lists any of its pages. */
export const PREVIEW_HEADERS = '/*\n  X-Robots-Tag: noindex\n';

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

/**
 * A repository's files at the head of `branch`, or of its default branch when none is named: { state, branch, head, entries }.
 * When `commit` is given, the files are that commit's, and where the branch points now is not asked.
 */
export async function readTree({ token, repo, branch: named = null, commit = null }) {
  const meta = await gh(token, 'GET', `/repos/${repo}`);
  if ([401, 403, 404].includes(meta.status)) return { state: 'no_access' };
  if (!meta.ok) return { state: 'github' };
  const branch = named || (await meta.json()).default_branch || 'main';
  let head = commit;
  if (!head) {
    const ref = await gh(token, 'GET', `/repos/${repo}/git/ref/heads/${refPath(branch)}`);
    if (ref.status === 404 || ref.status === 409) return { state: 'empty', branch };
    if (!ref.ok) return { state: 'github' };
    head = (await ref.json())?.object?.sha;
  }
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
 *
 * A site with files under members/ also gets the members gate, and the answer
 * then carries `members: 'on'`. Where this service cannot switch the gate on
 * (membersGateOn), the files under members/ are LEFT OUT of what is published and
 * the answer carries `members: 'left_out'`, so the caller can tell the owner
 * that those pages are not on the site yet. They are never served open. `siteId` is what the site's member secret is made
 * from; without one the Worker's name stands in.
 *
 * `branch` names another branch than the default one to copy, and `preview`
 * says the Worker is a preview of it: the files under members/ are then left
 * out always and the gate is never uploaded (a preview's address is not a
 * place members can sign in), and its `_headers` ends with PREVIEW_HEADERS
 * after whatever the site's own file says. `commit` names the one commit to
 * copy: a preview is a copy of the commit that was looked at, even when its
 * branch has moved since.
 *
 * A site Astro builds ("A site that Astro builds" below) is copied from the branch its build pushes
 * the finished pages to, never from its default branch, which holds source.
 * Every answer about such a site carries `built`: { tool, source, head, from }
 * (the installer, the head of the default branch, the head of the built branch
 * and the source commit that one says it was built from). Its answers also
 * include: a refusal ('build_server', 'build_tool', 'astro_unusual'),
 * 'needs_build_file' (no build file in the repository), 'building' (the build
 * file is there and the built branch is not yet), and 'same' when `have` names
 * the commit of the built branch that is up already, so nothing is sent. What
 * is published is the built branch as it is: its files under members/ are
 * guarded or left out exactly as a plain site's are, and its `_headers` and
 * `_redirects` are the ones in the built branch.
 */
export async function deploySite(env, { token, repo, name, first = false, siteId = null, branch = null, commit = null, preview = false, have = null }) {
  if (!hostingOn(env)) throw new HostingError('not_set_up');
  let tree = await readTree({ token, repo, branch, commit });
  if (tree.state !== 'ok') return tree;
  let built = null;
  if (!branch && !commit && !preview) {
    const kind = await builtKind({ token, repo, entries: tree.entries });
    if (kind) {
      const source = { branch: tree.branch, head: tree.head };
      if (kind.refuse) return { state: kind.refuse, ...source };
      built = { tool: kind.tool, source: tree.head, head: null, from: null };
      if (!kind.hasFile) return { state: 'needs_build_file', ...source, built };
      const pages = await readTree({ token, repo, branch: BUILT_BRANCH });
      if (pages.state === 'empty') return { state: 'building', ...source, built };
      if (pages.state !== 'ok') return { ...pages, ...source, built };
      built.head = pages.head;
      if (have && have === pages.head) return { state: 'same', ...source, built };
      built.from = await builtFrom({ token, repo, head: pages.head });
      tree = { ...pages, branch: source.branch };
    }
  }
  const say = (answer) => (built ? { ...answer, built } : answer);
  const all = publishedFiles(tree.entries);
  const { headers, redirects, skipped } = all;
  // Members-only pages are never put up without their gate. Where this service cannot switch the gate on,
  // they are left out of what is published, so nobody without the right can open them (tried for real on
  // the test service: a page under members/ that is uploaded as a plain file is served to everybody).
  const gate = !preview && membersGateOn(env), hadMembers = hasMembersArea(all.files);
  const files = hadMembers && !gate ? all.files.filter(f => !String(f.path).startsWith('/members/')) : all.files;
  if (!files.some(f => f.path === '/index.html')) return say({ state: 'no_home', branch: tree.branch, head: tree.head });
  if (files.length > LIMITS.files) return say({ state: 'too_big', branch: tree.branch, head: tree.head, fileCount: files.length });

  const { manifest, byHash } = await buildManifest(files);
  const script = `/workers/scripts/${encodeURIComponent(name)}`;
  const session = (await cloudflare(env, 'POST', `${script}/assets-upload-session`, { json: { manifest } })).result || {};
  const buckets = session.buckets || [];
  const wanted = buckets.reduce((n, b) => n + b.length, 0);
  if (wanted > LIMITS.newFiles) return say({ state: 'too_big', branch: tree.branch, head: tree.head, fileCount: files.length, newFiles: wanted });

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
  const ownHeaders = await settingsText(token, repo, headers);
  const headersText = preview ? `${ownHeaders ? `${ownHeaders.replace(/\s+$/, '')}\n\n` : ''}${PREVIEW_HEADERS}` : ownHeaders;
  const redirectsText = await settingsText(token, repo, redirects);
  if (headersText) config._headers = headersText;
  if (redirectsText) config._redirects = redirectsText;
  const members = hadMembers ? (gate ? 'on' : 'left_out') : null;
  const meta = {
    compatibility_date: COMPATIBILITY_DATE,
    assets: { jwt: done, config },
    annotations: { 'workers/message': `${repo} at ${String(tree.head).slice(0, 7)}`.slice(0, 100) },
  };
  if (members === 'on') {
    config.run_worker_first = GATE_PATHS;
    meta.main_module = GATE_FILE;
    meta.bindings = [
      { type: 'assets', name: 'ASSETS' },
      { type: 'plain_text', name: 'KILN_WORKER', text: serviceAddress(env) },
      { type: 'secret_text', name: 'KILN_MEMBER_SECRET', text: await memberSecret(env, siteId ?? name) },
    ];
  }
  const metadata = new FormData();
  metadata.append('metadata', JSON.stringify(meta));
  if (members === 'on') metadata.append(GATE_FILE, new File([MEMBERS_GATE_MODULE], GATE_FILE, { type: 'application/javascript+module' }), GATE_FILE);
  await cloudflare(env, 'PUT', script, { form: metadata });
  // A new Worker has no address until it is switched on. Asked once; asking
  // again later would only repeat it.
  if (first) await cloudflare(env, 'POST', `${script}/subdomain`, { json: { enabled: true, previews_enabled: false } });

  // A built site's commit is the source commit its pages were built from: that is the one its owner knows.
  return say({ state: 'live', url: siteAddress(env, name), commit: built ? built.from || built.source : tree.head, branch: tree.branch, files: files.length, sent: wanted, skipped, ...(members ? { members } : {}) });
}

// ── The members area ───────────────────────────────────────────────────────
//
// Pages under members/ are for the people on the site's list of members. On
// Cloudflare Pages the site's own functions/ folder guards them. A hosted site
// runs no program of its own, so Kiln uploads the same gate with the files
// (Cloudflare's "run_worker_first": the program runs before the file is
// served, and only for the addresses listed). The gate signs a member's
// cookie with a secret that belongs to that one site. The secret is kept
// nowhere: it is worked out again at every upload from the site's id and
// HOSTING_MEMBER_KEY, so it is the same every time and no two sites share one.

/** The file name the gate is uploaded under. */
export const GATE_FILE = 'members-gate.js';

/**
 * The addresses of a hosted site where the gate runs before a file is served:
 * everything under members/, the address the sign-in page posts to, and every
 * address written with a %-code (so /%6Dembers/ cannot slip past as a file).
 * The same three as templates/_routes.json names for Cloudflare Pages.
 */
export const GATE_PATHS = ['/members/*', '/api/member-redeem-google', '/*%*'];

/** True when these published files include a members area. */
export const hasMembersArea = (files) => (files || []).some(f => String(f.path).startsWith('/members/'));

/** This service's own address as a hosted site's gate should call it, or '' when it is not set. */
export function serviceAddress(env) {
  const url = String((env && env.HOSTING_SERVICE_URL) || '').trim().replace(/\/+$/, '');
  return /^https:\/\/[^\s/]+$/.test(url) ? url : '';
}

/** True when this service can switch a hosted site's members area on. */
export function membersGateOn(env) {
  return !!(env && env.HOSTING_MEMBER_KEY && serviceAddress(env));
}

/** One site's member secret: HMAC-SHA256 of the site's id with HOSTING_MEMBER_KEY, in hex. */
export async function memberSecret(env, siteId) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(String(env.HOSTING_MEMBER_KEY)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(String(siteId))));
  return [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** What a person reads when a hosted site has members pages and the gate cannot be switched on. */
export const MEMBERS_OFF_SENTENCE = 'This site has pages under members/, but the members area is not switched on for Kiln\'s hosting yet, so Kiln left those pages out of the site rather than show them to everybody. Write to info@kilncms.com and we will switch it on.';

/** Take a site's Worker away. True when it is gone (or was never there). */
export async function removeSite(env, name) {
  if (!hostingOn(env)) throw new HostingError('not_set_up');
  try { await cloudflare(env, 'DELETE', `/workers/scripts/${encodeURIComponent(name)}?force=true`); return true; }
  catch (e) { if (e instanceof HostingError && e.code === 'cloudflare_missing') return true; throw e; }
}

/**
 * The sentence a person reads for each way hosting can stop without the site
 * going up. `kept`: Kiln keeps the site's files (keeps.js), and its owner has
 * never seen a repository, so a site that was taken down is told where its
 * files are in those words.
 */
export function hostingSentence(code, { repo = 'the repository', planEnded = null, kept = false } = {}) {
  switch (code) {
    case 'no_home': return `Kiln found no home page (a file named index.html) at the top of ${repo}, so there is nothing to show at the site's address yet. Add one, and Kiln puts the site up by itself.`;
    case 'empty': return `${repo} has no files yet. Put the site's pages in it, and Kiln puts the site up by itself.`;
    case 'too_big': return `This site has more files than Kiln's hosting takes on by itself. Write to info@kilncms.com and we will look at it with you.`;
    case 'no_access': return 'The Kiln app is not installed on that repository yet, or it was removed, so Kiln cannot read the site\'s files.';
    case 'not_set_up': return 'Hosting is not switched on for this service yet.';
    case 'trial_ended': return `Kiln took this site down from its hosting because the free days ran out. ${kept ? "Kiln keeps your site's files." : 'Your repository is untouched.'} Now that the site is subscribed, put it up again.`;
    case 'plan_ended': return `Kiln took this site down from its hosting because its plan ended${Number(planEnded) ? ` on ${dayWords(Number(planEnded))}` : ''}. ${kept ? "Kiln keeps your site's files." : 'Your repository still has everything.'} To put the site back, subscribe again and then press the button to put it up.`;
    case 'needs_build_file': return BUILD_SENTENCES.needs_file;
    case 'building': return BUILD_SENTENCES.building;
    case 'build_server': return BUILD_REFUSALS.build_server;
    case 'build_tool': return BUILD_REFUSALS.build_tool;
    case 'astro_unusual': return prepareSentence('astro_unusual');
    case 'github': return 'GitHub did not answer just now. The site is as it was. Kiln tries again by itself in a few minutes.';
    default: return 'Kiln could not put the new files up just now. The site is as it was. Kiln tries again by itself in a few minutes.';
  }
}

// ── A site that Astro builds ───────────────────────────────────────────────
//
// Such a repository holds source: the pages exist only after a build. Kiln
// builds nothing. A GitHub Actions workflow in the customer's own repository
// (BUILD_FILE, the text below) builds the site on every push to the default
// branch and pushes the finished pages to the branch BUILT_BRANCH as one fresh
// commit whose message is "Built from <the source commit>". deploySite copies
// that branch where it copies the default branch of a plain site, so no secret
// is involved and Kiln takes no files from outside: it reads a branch with the
// access its GitHub App already has.
//
// Kiln's App may not write workflow files, so the customer adds the file by
// one press: the dashboard opens GitHub's own "new file" page with the name
// and the text filled in (addUrl), and the customer presses Commit changes.
//
// What follows says which repositories are built sites and which of those
// Kiln's hosting takes (builtKind), holds the build file, and words where a
// build stands for the dashboard (buildShown). hosted.js keeps the record
// (migration 0014) and decides when to look.

export const BUILT_BRANCH = 'kiln-built';
export const BUILD_FILE = '.github/workflows/kiln-build.yml';
/** The name of the mark the build puts on the commit it builds (a commit status). */
export const BUILD_CONTEXT = 'kiln-build';
/** A build that has shown no result for this long is called late. */
export const BUILD_LATE_MS = 15 * 60 * 1000;

/** What the owner reads for each place a build can stand. A site whose build is up has no sentence. */
export const BUILD_SENTENCES = {
  needs_file: 'Astro has to build this site before Kiln can show it. Press Add the build file. GitHub opens with the file filled in. Press Commit changes there, then come back to this page.',
  building: 'GitHub is building your site. This usually takes one to three minutes. This page updates by itself.',
  failed: 'The last build did not finish, so your site still shows the version from before. Open the build on GitHub to see what went wrong, or undo the last change in the editor.',
  late: 'The build has not finished yet. Open the Actions tab of your repository on GitHub to see where it stands. If Actions is switched off there, switch it on, then press Build again.',
};

/** What the owner reads when Kiln's hosting cannot take a site Astro builds. */
export const BUILD_REFUSALS = {
  build_server: 'This site runs a program for each visit. Kiln\'s hosting serves ready-made pages only, so it cannot host this site. You can still use Kiln with the host you have now.',
  build_tool: 'This site installs its parts with a tool Kiln\'s build file does not know yet. Write to info@kilncms.com and we will add it.',
};

// The build file for a site that installs with npm and whose default branch
// is main. It is the text of templates/kiln-build.yml, line for line: a test
// holds the two together (test/cloud-built.test.js).
export const BUILD_FILE_TEXT = [
  '# Kiln\'s build file. Each time this site changes, GitHub runs the steps below:',
  '# it builds the site with Astro and puts the finished pages on a branch named',
  '# kiln-built, and Kiln\'s hosting shows those pages at your site\'s address.',
  '# It uses no password or key of yours, only the pass GitHub gives each run,',
  '# which works for this repository alone and ends when the run ends.',
  'name: Kiln build',
  'on:',
  '  push:',
  '    branches: [main]',
  '  workflow_dispatch:',
  'permissions:',
  '  contents: write    # to put the finished pages on the kiln-built branch',
  '  statuses: write    # to mark each change as building, built or failed',
  'concurrency:         # one build at a time, and a newer change stops an older build',
  '  group: kiln-build',
  '  cancel-in-progress: true',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    env:',
  '      GH_TOKEN: ${{ github.token }}',
  '      MARK: gh api --silent repos/${{ github.repository }}/statuses/${{ github.sha }} -f context=kiln-build -f target_url=${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - uses: actions/setup-node@v4',
  '        with:',
  '          node-version: 22',
  '      # Mark this change as building. Kiln and its editor read that mark.',
  '      - run: $MARK -f state=pending',
  '      - run: npm ci',
  '      - run: npm run build',
  '      # The finished pages are in the folder dist. They go to the kiln-built',
  '      # branch as one fresh commit, so that branch holds only the newest pages.',
  '      - name: Hand the pages to Kiln',
  '        working-directory: dist',
  '        run: |',
  '          git init -q -b kiln-built',
  '          git add -A',
  '          git -c user.name="Kiln build" -c user.email="build@kilncms.com" commit -q -m "Built from $GITHUB_SHA"',
  '          git push -q -f "https://x-access-token:$GH_TOKEN@github.com/$GITHUB_REPOSITORY.git" kiln-built',
  '      - if: success()',
  '        run: $MARK -f state=success',
  '      - if: failure()',
  '        run: $MARK -f state=failure',
  '',
].join('\n');

/**
 * The build file for one site: the template, with the site's own default
 * branch where the template says main, and for a site that installs with pnpm
 * the two lines that install and build changed to pnpm's.
 */
export function buildFile({ tool = 'npm', branch = 'main' } = {}) {
  let text = BUILD_FILE_TEXT;
  if (branch && branch !== 'main') text = text.replace('    branches: [main]', `    branches: [${JSON.stringify(String(branch))}]`);
  if (tool === 'pnpm') {
    text = text.replace('      - run: npm ci', '      - run: corepack enable && pnpm install --frozen-lockfile')
      .replace('      - run: npm run build', '      - run: pnpm build');
  }
  return text;
}

/** GitHub's own "new file" page for a repository, with the build file's name and text filled in. */
export function addUrl({ repo, branch = 'main', tool = 'npm' }) {
  return `https://github.com/${repo}/new/${refPath(branch)}?filename=${BUILD_FILE}&value=${encodeURIComponent(buildFile({ tool, branch }))}`;
}

/** True when an Astro settings file (its text without comments) says the site runs on a server. */
export const runsOnServer = (src) => /\boutput\s*:\s*['"`]server['"`]/.test(src) || /\badapter\s*:/.test(src);

/**
 * Whether a repository is a site Astro builds, from the listing of its default
 * branch (`entries`). Null for every other repository: a plain site, and a
 * site another generator builds, are hosted as they always were. For an Astro
 * site: { refuse } with why Kiln's hosting does not take it ('build_server',
 * 'astro_unusual', 'build_tool', or 'github' when GitHub would not hand over
 * the settings file), or { tool, hasFile }: which of npm and pnpm installs its
 * parts, and whether the build file is in the repository.
 */
export async function builtKind({ token, repo, entries }) {
  const files = (entries || []).filter(e => e.type === 'blob');
  const paths = files.map(e => e.path);
  const generator = detectGenerators(paths).find(g => g.confidence >= 0.5);
  if (!generator || generator.id !== 'astro') return null;
  const settings = await readAstroSettings({ token, repo, entries: files });
  if (settings.state === 'github') return { refuse: 'github' };
  if (settings.src && runsOnServer(settings.src)) return { refuse: 'build_server' };
  if (settings.state !== 'ok') return { refuse: settings.state };
  const tool = paths.includes('pnpm-lock.yaml') ? 'pnpm' : paths.includes('package-lock.json') ? 'npm' : null;
  if (!tool) return { refuse: 'build_tool' };
  return { tool, hasFile: paths.includes(BUILD_FILE) };
}

/** The source commit a commit of the built branch says it was built from, or null when its message does not say. */
export async function builtFrom({ token, repo, head }) {
  try {
    const res = await gh(token, 'GET', `/repos/${repo}/git/commits/${head}`);
    if (!res.ok) return null;
    return /^Built from ([0-9a-f]{40})\b/.exec(String((await res.json())?.message || ''))?.[1] || null;
  } catch { return null; }
}

/**
 * True when the build marked a commit as failed. Only the build's own mark
 * counts (BUILD_CONTEXT), the newest one: another tool's mark on the same
 * commit says nothing about the pages. False when GitHub does not answer.
 */
export async function buildFailed({ token, repo, sha }) {
  try {
    const res = await gh(token, 'GET', `/repos/${repo}/commits/${sha}/statuses?per_page=100`);
    if (!res.ok) return false;
    const marks = await res.json();
    const mine = (Array.isArray(marks) ? marks : []).find(s => s?.context === BUILD_CONTEXT);
    return !!mine && (mine.state === 'failure' || mine.state === 'error');
  } catch { return false; }
}

/**
 * What the dashboard is told of a built site's build, from its row of the
 * hosting table: { state, sentence, add_url | runs_url }. `state` is
 * 'needs_file', 'building', 'failed', 'late' or 'built' (no sentence).
 */
export function buildShown(row, { repo, now = Date.now() } = {}) {
  let state = 'built';
  if (row.build_state === 'needs_file') state = 'needs_file';
  else if (row.build_wanted_sha) state = row.build_state === 'failed' ? 'failed' : now - Number(row.build_wanted_at || 0) > BUILD_LATE_MS ? 'late' : 'building';
  const out = { state };
  if (BUILD_SENTENCES[state]) out.sentence = BUILD_SENTENCES[state];
  if (state === 'needs_file') out.add_url = addUrl({ repo, branch: row.branch || 'main', tool: row.build_tool || 'npm' });
  else out.runs_url = `https://github.com/${repo}/actions`;
  return out;
}
