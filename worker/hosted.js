/**
 * The sites Kiln hosts: what the service remembers about each, and the three
 * ways one is published.
 *
 *   publishSite     the owner switches hosting on, or presses Publish again
 *   pushNotice      GitHub says the repository changed (the App's push webhook)
 *   previewNotice   GitHub says a branch the editor writes suggestions or shared
 *                   drafts to changed, or was deleted: its preview goes up
 *                   as a Worker of its own, or comes down
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
 * A preview is on record in the `previews` table (migration 0010). A database
 * that migration has not reached has no previews, and nothing here fails.
 *
 * KV:
 *   hostlock:<site id>           '1'   one copy at a time for a site (TTL 5 min)
 *   pvlock:<site id>:<alias>     '1'   one copy at a time for a preview (TTL 5 min)
 *   pvwant:<site id>:<alias>     the commit a notice named while that copy ran (TTL 5 min)
 *   pvcount:<site id>:<hour>     how many copies of previews the site got in that hour (TTL 2 hours)
 */

import { hostingOn, siteName, siteAddress, deploySite, removeSite, hostingSentence, HostingError, isPreviewBranch, previewAlias, previewName } from './hosting.js';
import { gh, refPath } from './prepare.js';
import { keepEditorsCurrent, finishCare, setPreviews } from './lookafter.js';
import { domainRow, saveDomain, forgetDomain, detachDomain, removeWaitingDomain } from './domain.js';

const LOCK_S = 300;
const RETRY_AFTER_MS = 2 * 60 * 1000;        // a failed copy is tried again this long after it failed
const SWEEP_PUBLISH = 5;                     // copies one sweep makes at most
const SWEEP_LOOK = 20;                       // repositories one sweep looks at for a change nobody announced
const PREVIEWS_PER_SITE = 5;                  // previews one site has at most
const PREVIEW_KEPT_MS = 30 * 24 * 60 * 60 * 1000;   // a preview nobody changed for this long comes down
const SWEEP_PREVIEWS = 5;                    // previews one sweep takes down at most
const PREVIEW_COPIES_PER_HOUR = 60;          // copies of previews one site gets in one hour at most
const HOUR_MS = 60 * 60 * 1000;
const lockKey = (id) => `hostlock:${id}`;
const previewLock = (id, alias) => `pvlock:${id}:${alias}`;
const previewWant = (id, alias) => `pvwant:${id}:${alias}`;
const previewCount = (id, now = Date.now()) => `pvcount:${id}:${Math.floor(now / HOUR_MS)}`;

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
        out = await deploySite(env, { token, repo: site.repo, name: row.name, first: !row.deployed_at, siteId: site.id });
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
      // The site has pages under members/ and this service cannot guard them
      // (hosting.js: membersGateOn). The owner reads it in "Check this site".
      if (out.members === 'left_out') console.warn(JSON.stringify({ evt: 'hosting_members_left_out', repo: site.repo, name: row.name }));
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

// ── Previews ───────────────────────────────────────────────────────────────

/** Rows of the `previews` table, or none on a database migration 0010 has not reached. */
async function previewRows(env, sql, ...args) {
  try { return (await env.kiln_cloud.prepare(sql).bind(...args).all())?.results || []; }
  catch { return []; }
}

/** A site's previews, the one changed longest ago first. */
export const previewsOf = (env, siteId) => previewRows(env, 'SELECT * FROM previews WHERE site_id = ? ORDER BY updated_at, alias', siteId);

/**
 * Take one preview down: its Worker, then its row. When Cloudflare does not
 * answer, the row stays, with `updated_at` set to 0 so the next sweep tries
 * again (a push to its branch meanwhile makes it a preview like any other
 * again). Never throws.
 */
async function removePreview(env, row, why) {
  try {
    await removeSite(env, row.name);
    await env.kiln_cloud.prepare('DELETE FROM previews WHERE site_id = ? AND alias = ?').bind(row.site_id, row.alias).run();
    console.log(JSON.stringify({ evt: 'preview_removed', site: row.site_id, name: row.name, why }));
    return true;
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'preview_remove_failed', site: row.site_id, name: row.name, why, detail: String(e?.detail || e?.message || e).slice(0, 200) }));
    // Marked as the oldest there is, so the next sweep takes it down whatever the reason was.
    try { await env.kiln_cloud.prepare('UPDATE previews SET updated_at = 0 WHERE site_id = ? AND alias = ?').bind(row.site_id, row.alias).run(); } catch { /* the row is as it was */ }
    return false;
  }
}

/** Every preview of a site comes down. Returns how many did. Never throws. */
export async function forgetPreviews(env, siteId, why = 'site_removed') {
  let removed = 0;
  for (const row of await previewsOf(env, siteId)) if (await removePreview(env, row, why)) removed++;
  return removed;
}

/**
 * Put one branch of a hosted site up as its preview, and record it. One copy
 * at a time for a preview: a notice that arrives while a copy runs leaves the
 * commit it named, and the running copy goes round once more for it. The row
 * is written before the first copy, so no Worker is ever up without one. A
 * site that has five previews already loses the one changed longest ago
 * first, and the database itself refuses a sixth row, so branches pushed at
 * the same moment cannot each count "fewer than five" and all go up. Every
 * copy is a whole copy of the site, so one site gets sixty copies of previews
 * in one hour and no more. Never throws.
 */
async function putPreview(env, { site, token, branch, sha = null }) {
  const alias = previewAlias(branch), name = previewName(env, site, branch);
  const lock = previewLock(site.id, alias), want = previewWant(site.id, alias);
  try {
    if (await env.KILN.get(lock)) {
      if (sha) await env.KILN.put(want, sha, { expirationTtl: LOCK_S });
      return { state: 'busy' };
    }
  } catch { return { state: 'failed' }; }
  try {
    await env.KILN.put(lock, '1', { expirationTtl: LOCK_S });
    await env.KILN.delete(want);   // what was asked for until now is what the copy below reads
    const one = env.kiln_cloud.prepare('SELECT * FROM previews WHERE site_id = ? AND alias = ?').bind(site.id, alias);
    let row;
    try { row = await one.first(); } catch { return { state: 'off' }; }   // migration 0010 has not reached this database: no previews
    if (row && row.deployed_at && sha && row.commit_sha === sha && row.branch === branch) return { state: 'live', url: siteAddress(env, name), commit: sha };
    const countKey = previewCount(site.id);
    const copies = async () => Number(await env.KILN.get(countKey)) || 0;
    const tooMany = () => {
      console.log(JSON.stringify({ evt: 'preview_too_many', site: site.id, repo: site.repo, branch, most: PREVIEW_COPIES_PER_HOUR }));
      return { state: 'busy' };
    };
    // Asked before anything is taken down to make room, so a copy that will not be made costs nobody their preview.
    if (await copies() >= PREVIEW_COPIES_PER_HOUR) return tooMany();
    if (!row) {
      const others = await previewsOf(env, site.id);
      for (const old of others.slice(0, Math.max(0, others.length - (PREVIEWS_PER_SITE - 1)))) {
        // Five is the most a site has: when the oldest cannot be taken down just now, the new one waits for the next push.
        if (!(await removePreview(env, old, 'room_for_another'))) return { state: 'full' };
      }
      // The count is part of the write: of many notices that arrive together, the database lets five write a row.
      const put = await env.kiln_cloud.prepare('INSERT INTO previews (site_id, alias, branch, name, commit_sha, deployed_at, updated_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM previews WHERE site_id = ?) < ?')
        .bind(site.id, alias, branch, name, null, null, Date.now(), site.id, PREVIEWS_PER_SITE).run();
      if (!put?.meta?.changes) return { state: 'full' };
      row = await one.first();
      if (!row) return { state: 'full' };   // taken away again already, to make room for another
    }
    let out = null;
    for (let round = 0; round < 2; round++) {
      const made = await copies();
      if (made >= PREVIEW_COPIES_PER_HOUR) {
        if (round) break;   // the copy made a moment ago stays up; the commit that came meanwhile waits for the next hour's push
        if (!row.deployed_at) await env.kiln_cloud.prepare('DELETE FROM previews WHERE site_id = ? AND alias = ?').bind(site.id, alias).run();
        return tooMany();
      }
      await env.KILN.put(countKey, String(made + 1), { expirationTtl: 2 * 60 * 60 });
      out = await deploySite(env, { token, repo: site.repo, name, first: !row.deployed_at, siteId: site.id, branch, preview: true });
      if (out.state !== 'live') {
        // Nothing was put up (no home page on that branch, say). A preview that was up keeps what it served.
        if (!row.deployed_at) await env.kiln_cloud.prepare('DELETE FROM previews WHERE site_id = ? AND alias = ?').bind(site.id, alias).run();
        console.log(JSON.stringify({ evt: 'preview_not_up', repo: site.repo, branch, name, reason: out.state }));
        return { state: out.state };
      }
      const now = Date.now();
      const kept = await env.kiln_cloud.prepare('UPDATE previews SET branch = ?, name = ?, commit_sha = ?, deployed_at = ?, updated_at = ? WHERE site_id = ? AND alias = ?')
        .bind(branch, name, out.commit, now, now, site.id, alias).run();
      if (!kept?.meta?.changes) {
        // Its row was taken away while the copy ran (the branch was deleted, or the room went to a newer preview),
        // so what was just put up comes down again: no Worker stays up without a row.
        try { await removeSite(env, name); }
        catch (e) { console.warn(JSON.stringify({ evt: 'preview_remove_failed', site: site.id, name, why: 'row_gone', detail: String(e?.detail || e?.message || e).slice(0, 200) })); }
        console.log(JSON.stringify({ evt: 'preview_not_up', repo: site.repo, branch, name, reason: 'row_gone' }));
        return { state: 'full' };
      }
      row = { ...row, branch, name, commit_sha: out.commit, deployed_at: now };
      const wanted = await env.KILN.get(want);
      if (!wanted || wanted === out.commit) break;
      await env.KILN.delete(want);
    }
    return { state: 'live', url: out.url, commit: out.commit };
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'preview_failed', repo: site.repo, branch, name, reason: e instanceof HostingError ? e.code : 'record', detail: e instanceof HostingError ? e.detail : String(e?.message || e).slice(0, 300) }));
    return { state: 'failed' };
  } finally {
    try { await env.KILN.delete(lock); } catch { /* it runs out by itself */ }
  }
}

/**
 * A suggestion was approved or declined, so what its branch's preview showed
 * is settled: the preview comes down. The branch is left where it is (the
 * editor writes that person's next suggestion to it, and a preview goes up
 * again then). Whoever calls this has made sure that no other suggestion on
 * the same branch still waits. Answers how many previews came down. Never
 * throws.
 */
export async function previewDecided(env, { repo, branch }) {
  let gone = 0;
  try {
    if (!hostingOn(env) || !env.kiln_cloud || !isPreviewBranch(branch) || !previewAlias(branch)) return 0;
    const rows = await previewRows(env, 'SELECT p.* FROM previews p JOIN sites s ON s.id = p.site_id WHERE lower(s.repo) = lower(?) AND p.alias = ? AND p.branch = ?', String(repo), previewAlias(branch), branch);
    for (const row of rows) if (await removePreview(env, row, 'decided')) gone++;
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'preview_decided_failed', repo, branch, detail: String(e?.message || e).slice(0, 300) }));
  }
  return gone;
}

/**
 * GitHub says a branch the editor writes suggestions or shared drafts to moved
 * (to `sha`) or was deleted. A branch that moved goes up as the preview of
 * every hosted site of that repository whose hosting is up and that may be
 * edited now; a deleted branch's preview comes down, whoever may edit.
 * Returns how many previews went up or came down. Never throws.
 */
export async function previewNotice(env, { repo, branch, sha = null, deleted = false }, { installationToken, hasAccess }) {
  let changed = 0;
  try {
    if (!isPreviewBranch(branch) || !previewAlias(branch)) return 0;
    if (deleted) {
      const rows = await previewRows(env, 'SELECT p.* FROM previews p JOIN sites s ON s.id = p.site_id WHERE lower(s.repo) = lower(?) AND p.alias = ? AND p.branch = ?', String(repo), previewAlias(branch), branch);
      for (const row of rows) if (await removePreview(env, row, 'branch_deleted')) changed++;
      return changed;
    }
    const sites = (await hostedSitesOf(env, repo, hasAccess)).filter(s => s.state !== 'ended');   // a site that was taken down has no previews
    for (const site of sites) {
      const token = await installationToken(env, site.repo);
      if (!token) continue;   // the next push to the branch tries again
      if ((await putPreview(env, { site, token, branch, sha })).state === 'live') changed++;
    }
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'preview_notice_failed', repo, branch, detail: String(e?.message || e).slice(0, 300) }));
  }
  return changed;
}

/**
 * The sweep's part: previews that should be gone come down, five a run at
 * most. Those are the previews of a site that is no longer hosted (removed,
 * or taken down) which Cloudflare did not take away at the time, and the
 * previews nobody changed for thirty days. Never throws.
 */
async function sweepPreviews(env, now) {
  const rows = await previewRows(env,
    `SELECT p.site_id, p.alias, p.name, p.updated_at, h.site_id AS hosted, h.state FROM previews p LEFT JOIN hosting h ON h.site_id = p.site_id
     WHERE h.site_id IS NULL OR h.state IN ('removing', 'ended') OR p.updated_at < ? ORDER BY p.updated_at LIMIT ?`, now - PREVIEW_KEPT_MS, SWEEP_PREVIEWS);
  let removed = 0;
  const why = (row) => (!row.hosted || row.state === 'removing' ? 'site_removed' : row.state === 'ended' ? 'hosting_ended' : Number(row.updated_at) === 0 ? 'left_from_an_earlier_try' : 'not_changed_for_30_days');
  for (const row of rows) if (await removePreview(env, row, why(row))) removed++;
  return removed;
}

/**
 * The App's webhook. Only a delivery signed with the webhook secret is acted
 * on, and only a push to a repository's default branch (the site) or to a
 * branch the editor writes suggestions or shared drafts to (its preview; such
 * a branch being deleted takes the preview down). The answer goes back at
 * once (GitHub waits ten seconds at most); the copying carries on after it.
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
  const pushed = typeof p.ref === 'string' && p.ref.startsWith('refs/heads/') ? p.ref.slice('refs/heads/'.length) : null;
  if (pushed && pushed !== branch && isPreviewBranch(pushed)) {
    if (!hostingOn(env) || !env.kiln_cloud) return json({ ok: true, ignored: 'hosting is off' });
    const preview = previewNotice(env, { repo, branch: pushed, sha: typeof p.after === 'string' ? p.after : null, deleted: !!p.deleted }, tools);
    if (ctx && typeof ctx.waitUntil === 'function') { ctx.waitUntil(preview); return json({ ok: true, accepted: true }, 202); }
    return json({ ok: true, previews: await preview });
  }
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
      await forgetPreviews(env, r.id, 'hosting_ended');   // its previews come down with it
      console.log(JSON.stringify({ evt: 'hosting_ended', repo: r.repo, name: r.name, reason, ...(domain ? { domain: domain.name } : {}) }));
      if (typeof ended === 'function') { try { await ended(r, reason, domain); } catch { /* the operator's note is not what takes a site down */ } }
    } catch (e) { console.warn(JSON.stringify({ evt: 'hosting_end_failed', name: r.name, detail: String(e?.detail || e?.message || e).slice(0, 200) })); }
  }
  // Previews that should be gone: those Cloudflare did not take away when their site came down, and the old ones.
  await sweepPreviews(env, now);
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
  // A site that was hosted before Kiln wrote the preview line of the settings file is given it, once.
  await setPreviews(env, live.filter(x => x.state === 'live'), { installationToken, now });
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
 * A site is removed from Kiln: its Worker is taken down, and so is every
 * preview of it. If Cloudflare does not answer, the record stays, marked, and
 * the sweep takes it down later.
 */
export async function forgetHosting(env, siteId) {
  // Its own domain first, while the Worker the two names are attached to is still there.
  const domain = await domainComesDown(env, siteId, { reason: 'site_removed', removed: true });
  if (hostingOn(env)) await forgetPreviews(env, siteId, 'site_removed');
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
