/**
 * The sites Kiln hosts: what the service remembers about each, and the three
 * ways one is published.
 *
 *   publishSite     the owner switches hosting on, or presses Publish again
 *   pushNotice      GitHub says the repository changed (the App's push webhook)
 *   sweepHosting    every five minutes: finish what could not be done at once,
 *                   look whether a repository moved without a notice, take
 *                   down a site whose time on Kiln's hosting is over (a trial
 *                   nobody subscribed for, or a plan that ended), and
 *                   bring a hosted site's editor up to the released one
 *                   (lookafter.js)
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
import { keepEditorsCurrent, finishCare } from './lookafter.js';
import { domainRow, saveDomain, forgetDomain, detachDomain, removeWaitingDomain } from './domain.js';

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

/**
 * What the dashboard is shown of a hosted site. `endsAt` (ms) is the moment a
 * site that may not be edited any more comes down: it is passed on as
 * `ends_at` while the site is still there. `planEnded` (ms) is when its plan
 * ended, for the sentence that says why it was taken down.
 */
export function publicHosting(row, { repo, endsAt = null, planEnded = null } = {}) {
  if (!row || row.state === 'removing') return null;
  const out = { state: row.state, url: row.url, commit: row.commit_sha || null, files: row.files ?? null, deployed_at: row.deployed_at || null };
  if (row.state !== 'live' && row.reason) { out.reason = row.reason; out.error = hostingSentence(row.reason, { repo, planEnded }); }
  // A site that was live and whose last copy failed still serves what it served.
  if (row.state !== 'live' && row.deployed_at) out.serving = true;
  if (endsAt && row.state !== 'ended') out.ends_at = endsAt;
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
 * removed site that is still there. Then the editor of a site or two is
 * brought up to the released one (lookafter.js), and then a look at the
 * repositories checked longest ago, in case one moved and no notice came:
 * that look is also what publishes an editor that was just updated, when
 * GitHub's notice has not done so first. Sites that may not be edited any
 * more are not published again, and come down when `endsAt` says their time
 * is over; `endReason` names why, for the record the dashboard reads.
 */
export async function sweepHosting(env, { installationToken, hasAccess, endsAt = () => null, endReason = () => 'trial_ended', ended = null, care = {} }) {
  if (!hostingOn(env) || !env.kiln_cloud) return { published: 0, looked: 0, editors: 0, cared: 0 };
  const now = Date.now();
  let published = 0, looked = 0, editors = 0, cared = 0;
  let rows = [];
  try {
    rows = (await env.kiln_cloud.prepare(
      `SELECT s.id, s.repo, s.status, s.access_until, s.plan, s.created_at, s.ls_subscription_id, s.firstpass_at, h.name, h.state, h.branch, h.commit_sha, h.wanted_sha, h.checked_at, h.updated_at, h.deployed_at
       FROM hosting h LEFT JOIN sites s ON s.id = h.site_id ORDER BY COALESCE(h.checked_at, 0)`).all())?.results || [];
    // (`h.deployed_at` is read with the rest: a site that was never up needs no notice before it is cleared away.)
  } catch { return { published, looked, editors, cared }; }   // migration 0005 has not reached this database

  for (const r of rows) {
    if (r.state !== 'removing') continue;
    try { await removeSite(env, r.name); await env.kiln_cloud.prepare('DELETE FROM hosting WHERE name = ?').bind(r.name).run(); }
    catch (e) { console.warn(JSON.stringify({ evt: 'hosting_remove_failed', name: r.name, detail: String(e?.detail || e?.message || e).slice(0, 200) })); }
  }
  // A site whose time on Kiln's hosting is over comes down. `endsAt` says
  // when: a free trial nobody subscribed for, a few days after it ran out
  // (`trial_ended`), or a site that was paid for, thirty days after its plan
  // ended (`plan_ended`). Its record stays, so the dashboard can say why, and
  // subscribing puts it back: `deployed_at` is cleared so its address is
  // switched on again then.
  for (const r of rows) {
    if (r.state === 'removing' || r.state === 'ended' || !r.id || hasAccess(r)) continue;
    // `endsAt` answers with a time, or with { at, ready }: a site whose owner
    // has not yet had the last notice for a week is not ready to come down.
    const end = await endsAt(r);
    const at = end && typeof end === 'object' ? end.at : end;
    if (!at || now < at || (typeof end === 'object' && end.ready === false)) continue;
    try {
      // Its own domain first, while the Worker the two names are attached to is still there.
      const domain = await domainComesDown(env, r.id, { reason: 'hosting_ended' });
      await removeSite(env, r.name);
      const reason = endReason(r) || 'trial_ended';
      await save(env, r.id, { state: 'ended', reason, deployed_at: null, wanted_sha: null });
      console.log(JSON.stringify({ evt: 'hosting_ended', repo: r.repo, name: r.name, reason, ...(domain ? { domain: domain.name } : {}) }));
      if (typeof ended === 'function') { try { await ended(r, reason, domain); } catch { /* the operator's note is not what takes a site down */ } }
    } catch (e) { console.warn(JSON.stringify({ evt: 'hosting_end_failed', name: r.name, detail: String(e?.detail || e?.message || e).slice(0, 200) })); }
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
  // A step that could not be done when a site was put up (GitHub did not
  // answer, say) is tried again for one site. Like the editor below, this only
  // moves the repository's branch; the look below, or GitHub's notice, publishes it.
  cared = (await finishCare(env, live.filter(x => x.state !== 'ended'), { installationToken, record: care, now })).finished;
  // A hosted site's editor is kept current for its owner.
  editors = (await keepEditorsCurrent(env, live.filter(x => x.state === 'live'), { installationToken, now })).updated;
  for (const r of live.filter(x => !done.has(x.id) && (x.state === 'live' || x.state === 'waiting')).slice(0, SWEEP_LOOK)) {   // not 'ended': its owner puts it back
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
  return { published, looked, editors, cared };
}

/**
 * A site is removed from Kiln: its Worker is taken down. If Cloudflare does
 * not answer, the record stays, marked, and the sweep takes it down later.
 */
export async function forgetHosting(env, siteId) {
  // Its own domain first, while the Worker the two names are attached to is still there.
  const domain = await domainComesDown(env, siteId, { reason: 'site_removed', removed: true });
  const row = await hostingRow(env, siteId);
  if (!row) return { domain };
  try { await removeSite(env, row.name); await env.kiln_cloud.prepare('DELETE FROM hosting WHERE site_id = ?').bind(siteId).run(); }
  catch (e) {
    console.warn(JSON.stringify({ evt: 'hosting_remove_failed', name: row.name, detail: String(e?.detail || e?.message || e).slice(0, 200) }));
    try { await save(env, siteId, { state: 'removing' }); } catch { /* the sweep has nothing to go on; the operator's log line above does */ }
  }
  return { domain };
}

/**
 * What becomes of a site's own domain when the site comes down from Kiln's
 * hosting (`reason` 'hosting_ended') or is removed from Kiln ('site_removed',
 * with `removed`):
 *   waiting  nothing of the owner's depends on the zone yet, so it is removed
 *            (domain.js removeWaitingDomain) and the row is forgotten. A zone
 *            that turns out to be active by now is treated as a live one;
 *   live     the bare name and `www` are detached from the site's Worker and
 *            the row is put away with `reason`. The zone and every other
 *            record STAY: the owner's email may be answered from them;
 *   put away or failed: left as it is.
 * A forwarded email address at the domain (domain-mail.js) is left as it is
 * in every case, its row and its rule: the rule lives in the zone, and mail
 * for the address keeps arriving for as long as the zone answers for the
 * domain. Its owner can still stop it from the dashboard.
 * A site that stays on Kiln gets its temporary address back as the address on
 * record, as when a domain is moved away. Never throws: what Cloudflare or
 * the database refuses is logged, and the take-down or the removal goes on.
 * Returns null for a site with no domain, or { name, row, live }: `live`
 * is true when the domain was live, now or when an earlier try at the same
 * take-down put it away.
 */
export async function domainComesDown(env, siteId, { reason = 'hosting_ended', removed = false } = {}) {
  const warn = (evt, row, e) => console.warn(JSON.stringify({ evt, site: siteId, name: row?.name, zone: row?.zone_id, detail: String(e?.detail || e?.message || e).slice(0, 200) }));
  let row = null;
  try { row = await domainRow(env, siteId); } catch { row = null; }
  if (!row) return null;
  const out = { name: row.name, row, live: row.state === 'live' || (row.state === 'put_away' && row.reason === reason) };
  if (row.state !== 'waiting' && row.state !== 'live') return out;
  // The two names come off the site's Worker first, whatever becomes of the zone.
  try { if (row.zone_id) await detachDomain(env, { zoneId: row.zone_id, name: row.name }); }
  catch (e) { warn('domain_detach_failed', row, e); }
  if (row.state === 'waiting') {
    let gone = true;
    try { if (row.zone_id) gone = (await removeWaitingDomain(env, { zoneId: row.zone_id })).removed; }
    catch (e) { warn('domain_remove_failed', row, e); }
    if (gone) { await forgetDomain(env, siteId); return out; }
    out.live = true;   // the name servers have changed since the last look: the zone may answer for email, so it stays
  }
  try { await saveDomain(env, siteId, { state: 'put_away', reason }); }
  catch (e) { warn('domain_not_put_away', row, e); }
  if (!removed) {
    try {
      const h = await hostingRow(env, siteId);
      if (h?.url) await env.kiln_cloud.prepare('UPDATE sites SET origin = ? WHERE id = ? AND origin IN (?, ?)').bind(h.url, siteId, `https://${row.name}`, `https://www.${row.name}`).run();
    } catch (e) { warn('domain_address_not_set', row, e); }
  }
  return out;
}

/** The site whose temporary address this is, when it may be edited now. */
export async function siteForHostingAddress(env, origin, hasAccess) {
  try {
    const row = await env.kiln_cloud.prepare(
      `SELECT s.repo, s.status, s.access_until FROM hosting h JOIN sites s ON s.id = h.site_id WHERE h.url = ? AND h.state != 'removing' LIMIT 1`).bind(origin).first();
    return row && hasAccess(row) ? row : null;
  } catch { return null; }
}
