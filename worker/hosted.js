/**
 * The sites Kiln hosts: what the service remembers about each, and the three
 * ways one is published.
 *
 *   publishSite     the owner switches hosting on, or presses Publish again
 *   pushNotice      GitHub says the repository changed (the App's push webhook)
 *   sweepHosting    every five minutes: finish what could not be done at once,
 *                   and look whether a repository moved without a notice
 *
 * hosting.js does the copying; this file keeps the record (the `hosting` table,
 * migration 0005) and makes sure one site is copied by one thing at a time.
 * cloud.js decides who may ask, and passes in `hasAccess` (may this site be
 * edited right now) and the App's token.
 *
 * KV:
 *   hostlock:<site id>   '1'   one copy at a time for a site (TTL 5 min)
 */

import { hostingOn, siteName, siteAddress, deploySite, removeSite, hostingSentence, HostingError } from './hosting.js';
import { gh, refPath } from './prepare.js';

const LOCK_S = 300;
const RETRY_AFTER_MS = 2 * 60 * 1000;        // a failed copy is tried again this long after it failed
const SWEEP_PUBLISH = 5;                     // copies one sweep makes at most
const SWEEP_LOOK = 20;                       // repositories one sweep looks at for a change nobody announced
const lockKey = (id) => `hostlock:${id}`;

const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export async function hostingRow(env, siteId) {
  try { return await env.kiln_cloud.prepare('SELECT * FROM hosting WHERE site_id = ?').bind(siteId).first(); }
  catch { return null; }   // a database migration 0005 has not reached: nothing is hosted
}

/** Every hosted site of one account, by site id. Never fails the page that asks. */
export async function hostingForAccount(env, accountId) {
  try {
    const rows = await env.kiln_cloud.prepare('SELECT h.* FROM hosting h JOIN sites s ON s.id = h.site_id WHERE s.account_id = ?').bind(accountId).all();
    return Object.fromEntries((rows?.results || []).map(r => [r.site_id, r]));
  } catch { return {}; }
}

/** What the dashboard is shown of a hosted site. */
export function publicHosting(row, { repo } = {}) {
  if (!row || row.state === 'removing') return null;
  const out = { state: row.state, url: row.url, commit: row.commit_sha || null, files: row.files ?? null, deployed_at: row.deployed_at || null };
  if (row.state !== 'live' && row.reason) { out.reason = row.reason; out.error = hostingSentence(row.reason, { repo }); }
  // A site that was live and whose last copy failed still serves what it served.
  if (row.state !== 'live' && row.deployed_at) out.serving = true;
  return out;
}

async function save(env, siteId, fields) {
  const cols = Object.keys(fields);
  await env.kiln_cloud.prepare(`UPDATE hosting SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE site_id = ?`)
    .bind(...cols.map(c => fields[c]), Date.now(), siteId).run();
}

/**
 * Copy a site's repository to its Worker now, and record how it went. One at
 * a time for a site: while another copy runs, the answer is { state: 'busy' }
 * (and a commit that was asked for is remembered, so it is not lost). Never
 * throws. `wanted` is the commit a push notice named, when there was one.
 */
export async function publishSite(env, { site, token, wanted = null }) {
  if (!hostingOn(env)) return { state: 'failed', reason: 'not_set_up', error: hostingSentence('not_set_up') };
  let row = await hostingRow(env, site.id);
  if (await env.KILN.get(lockKey(site.id))) {
    if (row && wanted && wanted !== row.commit_sha) await save(env, site.id, { wanted_sha: wanted });
    return { state: 'busy' };
  }
  await env.KILN.put(lockKey(site.id), '1', { expirationTtl: LOCK_S });
  try {
    if (!row) {
      const name = siteName(env, { repo: site.repo, id: site.id });
      const now = Date.now();
      await env.kiln_cloud.prepare('INSERT INTO hosting (site_id, name, url, state, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .bind(site.id, name, siteAddress(env, name), 'starting', now, now).run();
      row = await hostingRow(env, site.id);
    }
    // Twice at most: a change that arrived while the first copy ran is
    // published at once, not five minutes later.
    for (let round = 0; round < 2; round++) {
      let out;
      try {
        out = await deploySite(env, { token, repo: site.repo, name: row.name, first: !row.deployed_at });
      } catch (e) {
        const reason = e instanceof HostingError ? e.code : 'cloudflare';
        console.warn(JSON.stringify({ evt: 'hosting_failed', repo: site.repo, name: row.name, reason, detail: e instanceof HostingError ? e.detail : String(e?.message || e).slice(0, 300) }));
        await save(env, site.id, { state: 'failed', reason, ...(wanted ? { wanted_sha: wanted } : {}) });
        break;
      }
      if (out.state !== 'live') {
        await save(env, site.id, { state: 'waiting', reason: out.state, branch: out.branch || row.branch || null, wanted_sha: null, checked_at: Date.now() });
        break;
      }
      await save(env, site.id, { state: 'live', reason: null, branch: out.branch, commit_sha: out.commit, files: out.files, deployed_at: Date.now(), checked_at: Date.now() });
      row = await hostingRow(env, site.id);
      // Did something newer get asked for meanwhile?
      if (!row.wanted_sha || row.wanted_sha === row.commit_sha) { if (row.wanted_sha) await save(env, site.id, { wanted_sha: null }); break; }
      if (round === 0) await save(env, site.id, { wanted_sha: null });
    }
    return publicHosting(await hostingRow(env, site.id), { repo: site.repo });
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'hosting_failed', repo: site.repo, reason: 'record', detail: String(e?.message || e).slice(0, 300) }));
    return { state: 'failed', reason: 'cloudflare', error: hostingSentence('cloudflare') };
  } finally {
    try { await env.KILN.delete(lockKey(site.id)); } catch { /* it runs out by itself */ }
  }
}

/** The hosted sites of a repository that may be edited now (so: that are paid for or on trial). */
async function hostedSitesOf(env, repo, hasAccess) {
  const rows = await env.kiln_cloud.prepare(
    `SELECT s.id, s.repo, s.status, s.access_until, s.plan, h.commit_sha, h.state FROM sites s JOIN hosting h ON h.site_id = s.id
     WHERE lower(s.repo) = lower(?) AND h.state != 'removing'`).bind(String(repo)).all();
  return (rows?.results || []).filter(s => hasAccess(s));
}

/**
 * GitHub says a repository's branch moved to `sha`. Publishes every hosted
 * site of that repository that does not serve that commit yet. Returns how
 * many it published. Never throws.
 */
export async function pushNotice(env, { repo, sha }, { installationToken, hasAccess }) {
  let published = 0;
  try {
    const sites = await hostedSitesOf(env, repo, hasAccess);
    for (const site of sites) {
      if (sha && site.commit_sha === sha) continue;
      const token = await installationToken(env, site.repo);
      if (!token) { await save(env, site.id, { wanted_sha: sha || null }); continue; }   // the sweep tries again once the App can read it
      const out = await publishSite(env, { site, token, wanted: sha || null });
      if (out.state === 'live') published++;
    }
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'push_notice_failed', repo, detail: String(e?.message || e).slice(0, 300) }));
  }
  return published;
}

/**
 * The App's webhook. Only a delivery signed with the webhook secret is acted
 * on, and only a push to a repository's default branch. The answer goes back
 * at once (GitHub waits ten seconds at most); the copying carries on after it.
 */
export async function handleGithubWebhook(request, env, ctx, tools) {
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  // With no secret set, nothing can be verified: the route does not exist.
  if (!env.GH_WEBHOOK_SECRET) return json({ error: 'not found' }, 404);
  const body = await request.text();
  const given = String(request.headers.get('X-Hub-Signature-256') || '');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.GH_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = `sha256=${hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))}`;
  let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (given.charCodeAt(i) || 0);
  if (diff !== 0) {
    console.warn(JSON.stringify({ evt: 'github_webhook_rejected', bytes: body.length }));
    return json({ error: 'bad signature' }, 401);
  }
  const event = request.headers.get('X-GitHub-Event') || '';
  if (event !== 'push') return json({ ok: true, ignored: event || 'no event' });
  let p = null;
  try { p = JSON.parse(body); } catch { return json({ error: 'not json' }, 400); }
  const repo = p?.repository?.full_name;
  const branch = p?.repository?.default_branch;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ ok: true, ignored: 'no repository' });
  if (p.deleted || !branch || p.ref !== `refs/heads/${branch}`) return json({ ok: true, ignored: 'not the default branch' });
  if (!hostingOn(env) || !env.kiln_cloud) return json({ ok: true, ignored: 'hosting is off' });
  const work = pushNotice(env, { repo, sha: typeof p.after === 'string' ? p.after : null }, tools);
  if (ctx && typeof ctx.waitUntil === 'function') { ctx.waitUntil(work); return json({ ok: true, accepted: true }, 202); }
  return json({ ok: true, published: await work });
}

/**
 * Every five minutes. First what is owed: a copy that failed, a first copy
 * that never finished, a commit a notice named that is not up, a Worker of a
 * removed site that is still there. Then a look at the repositories checked
 * longest ago, in case one moved and no notice came. Sites that may not be
 * edited any more are left as they are (ending hosting is its own step).
 */
export async function sweepHosting(env, { installationToken, hasAccess }) {
  if (!hostingOn(env) || !env.kiln_cloud) return { published: 0, looked: 0 };
  const now = Date.now();
  let published = 0, looked = 0;
  let rows = [];
  try {
    rows = (await env.kiln_cloud.prepare(
      `SELECT s.id, s.repo, s.status, s.access_until, s.plan, h.name, h.state, h.branch, h.commit_sha, h.wanted_sha, h.checked_at, h.updated_at
       FROM hosting h LEFT JOIN sites s ON s.id = h.site_id ORDER BY COALESCE(h.checked_at, 0)`).all())?.results || [];
  } catch { return { published, looked }; }   // migration 0005 has not reached this database

  for (const r of rows) {
    if (r.state !== 'removing') continue;
    try { await removeSite(env, r.name); await env.kiln_cloud.prepare('DELETE FROM hosting WHERE name = ?').bind(r.name).run(); }
    catch (e) { console.warn(JSON.stringify({ evt: 'hosting_remove_failed', name: r.name, detail: String(e?.detail || e?.message || e).slice(0, 200) })); }
  }
  const live = rows.filter(r => r.state !== 'removing' && r.id && hasAccess(r));
  const owed = live.filter(r => (r.wanted_sha && r.wanted_sha !== r.commit_sha) || ((r.state === 'failed' || r.state === 'starting') && now - Number(r.updated_at) > RETRY_AFTER_MS));
  const done = new Set();
  for (const r of owed.slice(0, SWEEP_PUBLISH)) {
    const token = await installationToken(env, r.repo);
    if (!token) continue;
    const out = await publishSite(env, { site: r, token });
    done.add(r.id);
    if (out.state === 'live') published++;
  }
  for (const r of live.filter(x => !done.has(x.id) && (x.state === 'live' || x.state === 'waiting')).slice(0, SWEEP_LOOK)) {
    if (published >= SWEEP_PUBLISH) break;
    const token = await installationToken(env, r.repo);
    if (!token) continue;
    looked++;
    let head = null;
    try {
      let branch = r.branch;
      if (!branch) { const meta = await gh(token, 'GET', `/repos/${r.repo}`); branch = meta.ok ? (await meta.json()).default_branch : null; }
      const ref = branch ? await gh(token, 'GET', `/repos/${r.repo}/git/ref/heads/${refPath(branch)}`) : null;
      head = ref && ref.ok ? (await ref.json())?.object?.sha : null;
    } catch { head = null; }
    if (head && head !== r.commit_sha) { if ((await publishSite(env, { site: r, token })).state === 'live') published++; }
    else await save(env, r.id, { checked_at: Date.now() });
  }
  return { published, looked };
}

/**
 * A site is removed from Kiln: its Worker is taken down. If Cloudflare does
 * not answer, the record stays, marked, and the sweep takes it down later.
 */
export async function forgetHosting(env, siteId) {
  const row = await hostingRow(env, siteId);
  if (!row) return;
  try { await removeSite(env, row.name); await env.kiln_cloud.prepare('DELETE FROM hosting WHERE site_id = ?').bind(siteId).run(); }
  catch (e) {
    console.warn(JSON.stringify({ evt: 'hosting_remove_failed', name: row.name, detail: String(e?.detail || e?.message || e).slice(0, 200) }));
    try { await save(env, siteId, { state: 'removing' }); } catch { /* the sweep has nothing to go on; the operator's log line above does */ }
  }
}

/** The site whose temporary address this is, when it may be edited now. */
export async function siteForHostingAddress(env, origin, hasAccess) {
  try {
    const row = await env.kiln_cloud.prepare(
      `SELECT s.repo, s.status, s.access_until FROM hosting h JOIN sites s ON s.id = h.site_id WHERE h.url = ? AND h.state != 'removing' LIMIT 1`).bind(origin).first();
    return row && hasAccess(row) ? row : null;
  } catch { return null; }
}
