/**
 * The daily site check: once a day for each site, the service asks the site's
 * public address and its Kiln page whether they answer, and keeps the result
 * and the editor version (migration 0023), so that the operator and the owner
 * can see when a site is down or its editor is out of date.
 *
 * It is switched off until the privacy page says so: nothing here runs, and
 * the five-minute schedule does not call it, unless the service's
 * SITE_CHECK_DAILY setting is exactly "on".
 *
 * It runs from the five-minute schedule (index.js), a few sites a run
 * (DAILY_CHECK_SLICE), each one whose last check is more than a day old, the
 * longest-waiting first. A site costs three outside requests, more only where
 * its address redirects (at most four for each): the home page, the editor's
 * file the page loads, and the sign-in page at /kiln. These are the address,
 * live and signin lines of "Check this site" (sitecheck.js checkPublic). The
 * repository is not read and no one's token is used, so the lines about the
 * repository, Kiln's files in it and its settings are left out of this check.
 * Sites whose free days ended unpaid (status canceled) are not asked.
 *
 * A row holds when, whether all three answered, and a summary: each check's
 * outcome in a word or two and the editor version the site's editors last
 * reported (KV `ebuild:<repo>`, the one the admin overview shows). Rows older
 * than DAILY_CHECK_KEEP_DAYS, and those of sites no longer on Kiln, are
 * deleted in the same run.
 */

import { checkPublic } from './sitecheck.js';

export const DAILY_CHECK_SLICE = 4;
export const DAILY_CHECK_EVERY_MS = 24 * 3600 * 1000;
export const DAILY_CHECK_KEEP_DAYS = 30;
const DAY = 86400 * 1000;

export const dailyCheckOn = (env) => String(env?.SITE_CHECK_DAILY || '').trim() === 'on' && !!env?.kiln_cloud;

/** What one check found, a word or two for each line, and the editor version. */
export function checkSummary(found, editor = null) {
  const ok = Object.fromEntries((found?.lines || []).map(l => [l.id, l.ok]));
  const home = found?.home || {};
  const address = ok.address === true ? 'answers'
    : home.problem ? String(home.problem).replace(/_/g, ' ').slice(0, 20)
    : Number(home.status) ? `http ${Number(home.status)}` : 'not checked';
  return {
    address,
    live: ok.live === true ? 'loads kiln' : ok.live === false ? 'no kiln' : 'not checked',
    signin: ok.signin === true ? 'answers' : ok.signin === false ? 'no answer' : 'not checked',
    editor: typeof editor === 'string' && /^[\w.+-]{1,40}$/.test(editor) ? editor : null,
  };
}

const said = (evt, site, e) => console.warn(JSON.stringify({ evt, site: site || null, detail: String(e?.message || e).slice(0, 160) }));

/**
 * One run: old rows go, then at most `slice` sites that are due are checked,
 * one after another, and each gets one row. A site that does not answer gets
 * a row that says so, and the run goes on. Answers what it did.
 */
export async function runDailySiteChecks(env, { now = Date.now(), slice = DAILY_CHECK_SLICE, check = checkPublic } = {}) {
  if (!dailyCheckOn(env)) return { ran: false };
  const db = env.kiln_cloud;
  await db.prepare('DELETE FROM site_checks WHERE at < ? OR site_id NOT IN (SELECT id FROM sites)').bind(now - DAILY_CHECK_KEEP_DAYS * DAY).run();
  const due = (await db.prepare(
    `SELECT s.id, s.repo, s.origin FROM sites s
     LEFT JOIN (SELECT site_id, MAX(at) AS last FROM site_checks GROUP BY site_id) c ON c.site_id = s.id
     WHERE s.status != 'canceled' AND s.origin IS NOT NULL AND (c.last IS NULL OR c.last <= ?)
     ORDER BY c.last IS NOT NULL, c.last, s.created_at LIMIT ?`
  ).bind(now - DAILY_CHECK_EVERY_MS, Math.max(0, Math.floor(Number(slice) || 0))).all())?.results || [];
  let checked = 0;
  for (const s of due) {
    let found = null;
    try { found = await check({ origin: s.origin }); } catch (e) { said('site_check_daily_failed', s.id, e); }
    let editor = null;
    try { editor = s.repo ? (await env.KILN.get(`ebuild:${s.repo}`, 'json'))?.build || null : null; } catch { editor = null; }
    const ok = !!found && ['address', 'live', 'signin'].every(id => (found.lines || []).some(l => l.id === id && l.ok === true));
    try {
      await db.prepare('INSERT INTO site_checks (site_id, at, ok, summary) VALUES (?, ?, ?, ?)').bind(s.id, now, ok ? 1 : 0, JSON.stringify(checkSummary(found, editor))).run();
      checked++;
    } catch (e) { said('site_check_daily_not_kept', s.id, e); }
  }
  return { ran: true, due: due.length, checked };
}

/** The latest check of each site, for the operator (GET /admin/cloud/checks in cloud.js). */
export async function latestChecks(env) {
  const rows = (await env.kiln_cloud.prepare(
    `SELECT c.site_id, c.at, c.ok, c.summary FROM site_checks c
     JOIN (SELECT site_id, MAX(at) AS last FROM site_checks GROUP BY site_id) l ON l.site_id = c.site_id AND l.last = c.at
     ORDER BY c.at DESC, c.site_id`
  ).all())?.results || [];
  const read = (t) => { try { return JSON.parse(t); } catch { return null; } };
  return rows.map(r => ({ site_id: r.site_id, at: r.at, ok: Number(r.ok) === 1, summary: read(r.summary) }));
}
