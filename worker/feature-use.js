/**
 * Feature use: how many times each of Kiln's features was used, per site and
 * per week (migration 0027), so that the operator can see which parts of Kiln
 * help people and which need explaining better (GET /admin/cloud/features in
 * cloud.js). Counts only, never what was written.
 *
 * It is switched off until the privacy page says so. Nothing here reads or
 * writes anything unless the service's FEATURE_USE setting is exactly "on".
 * Nothing here ever throws: a count that cannot be kept is said in one log
 * line and dropped, and the request is answered as before.
 *
 * A row is one week (starting Monday, in Eastern time), one site on Kiln and
 * one feature, with a count. A use for a repository that is no site on Kiln
 * is not counted. Uses that arrive while their row's write waits are added to
 * it and written once (problems.js addUp), so a burst of calls to the API
 * cannot flood the database.
 *
 *   noteFeature       one use
 *   forgetFeatureUse  a site's rows, when the site is removed
 *   pruneFeatureUse   rows older than FEATURE_KEEP_DAYS, and those of sites no longer on Kiln (the five-minute schedule)
 *   featuresPage      per feature, the sites that used it in the last 4 and 12 weeks and how often, unused ones too
 *
 * The features, and where they are counted (index.js unless said). A request
 * is counted when the service answered it with success:
 *   publish         each publish: the editor's door, the owner's door, the source commit, a suggestion
 *                   accepted, a scheduled change (cloud.js notePublish)
 *   publish_many    several pages published together (POST /source/commit with more than one file)
 *   schedule        a change scheduled (POST /schedule)
 *   invite_editor   an editor added to a site, or their access changed (POST /admin/people, role editor)
 *   invite_member   a member added to a site, or their access changed (POST /admin/people, role member)
 *   comment         a comment written (POST /comments)
 *   suggestion      a suggestion made (POST /suggestions)
 *   writing_helper  the writing helper asked (POST /ai/assist)
 *   api             a call to the API with a token (/api/v1/pages, /api/v1/fields, /api/v1/edits), once the token is good
 *   api_token       an API token made (POST /admin/api-tokens)
 *   revert          a page or the site put back to an earlier version (POST /source/revert)
 *   page_added      a page added or copied (POST /source/create, /source/duplicate)
 *   page_removed    a page removed (POST /source/remove)
 *   history         a page's history looked at (POST /source/history)
 */

import { addUp, easternMonday, dayPlus } from './problems.js';

export const FEATURES = Object.freeze(['publish', 'publish_many', 'schedule', 'invite_editor', 'invite_member', 'comment', 'suggestion',
  'writing_helper', 'api', 'api_token', 'revert', 'page_added', 'page_removed', 'history']);
export const FEATURE_KEEP_DAYS = 400;
const DAY = 24 * 3600 * 1000;
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

export const featuresOn = (env) => String(env?.FEATURE_USE || '').trim() === 'on' && !!env?.kiln_cloud;

function notKept(evt, feature, e) {
  try { console.warn(JSON.stringify({ evt, feature: String(feature || '').slice(0, 40), detail: String(e?.message || e).slice(0, 160) })); } catch { /* never */ }
}
const idOr = (v) => (v === null || v === undefined || v === '' ? '' : String(v).slice(0, 120));

// The site is the one on record, by its id or else by its repository; with none, nothing is written.
const UPSERT = `INSERT INTO feature_use (week, site_id, feature, count)
  SELECT ?, id, ?, ? FROM sites WHERE id = COALESCE(
    (SELECT id FROM sites WHERE ? != '' AND id = ?),
    (SELECT id FROM sites WHERE ? != '' AND lower(repo) = lower(?) ORDER BY created_at LIMIT 1))
  ON CONFLICT (week, site_id, feature) DO UPDATE SET count = count + excluded.count`;

/** One use of `feature` on the site `site_id`, or the site of `repo`. Answers true when its row was written. */
export async function noteFeature(env, { feature, site_id = null, repo = null, at = Date.now() } = {}) {
  if (!featuresOn(env)) return false;
  try {
    if (!FEATURES.includes(feature)) throw new Error('not a feature');
    const site = idOr(site_id), name = typeof repo === 'string' && REPO.test(repo) ? repo : '';
    if (!site && !name) return false;
    const row = { week: easternMonday(Number(at) || Date.now()), feature, site, repo: name, count: 1 };
    const db = env.kiln_cloud;
    return await addUp(db, ['feature', row.week, feature, site, name.toLowerCase()].join('\n'), row,
      (r) => db.prepare(UPSERT).bind(r.week, r.feature, r.count, r.site, r.site, r.repo, r.repo).run(),
      (e) => notKept('feature_not_written', feature, e));
  } catch (e) { notKept('feature_not_written', feature, e); return false; }
}

/** A site's rows go when the site does. It never throws: a removal goes on whatever happens here. */
export async function forgetFeatureUse(env, siteId) {
  if (!featuresOn(env) || !siteId) return false;
  try { await env.kiln_cloud.prepare('DELETE FROM feature_use WHERE site_id = ?').bind(String(siteId)).run(); return true; }
  catch (e) { notKept('features_not_removed', 'site', e); return false; }
}

/** Weeks that started more than FEATURE_KEEP_DAYS ago go, and so do the rows of a site no longer on Kiln. It throws when the database cannot be asked; cronJob says so. */
export async function pruneFeatureUse(env, { now = Date.now() } = {}) {
  if (!featuresOn(env)) return { ran: false };
  await env.kiln_cloud.prepare('DELETE FROM feature_use WHERE week < ? OR site_id NOT IN (SELECT id FROM sites)').bind(easternMonday(now - FEATURE_KEEP_DAYS * DAY)).run();
  return { ran: true };
}

/**
 * Each feature, those nobody used included: how many sites used it and how
 * many times, in the last 4 weeks and the last 12 (this week among them), and
 * how many sites there are. It throws when the table cannot be read (cloud.js says so).
 */
export async function featuresPage(env, { now = Date.now() } = {}) {
  const week = easternMonday(now), since4 = dayPlus(week, -21), since12 = dayPlus(week, -77);
  const db = env.kiln_cloud;
  const rows = (await db.prepare(`SELECT feature, COUNT(DISTINCT CASE WHEN week >= ? THEN site_id END) AS sites_4, SUM(CASE WHEN week >= ? THEN count ELSE 0 END) AS count_4,
      COUNT(DISTINCT site_id) AS sites_12, SUM(count) AS count_12 FROM feature_use WHERE week >= ? GROUP BY feature`).bind(since4, since4, since12).all())?.results || [];
  const by = Object.fromEntries(rows.map(r => [r.feature, r]));
  const n = (v) => Number(v) || 0;
  const features = [...new Set([...FEATURES, ...rows.map(r => r.feature)])]
    .map(feature => ({ feature, sites_4: n(by[feature]?.sites_4), count_4: n(by[feature]?.count_4), sites_12: n(by[feature]?.sites_12), count_12: n(by[feature]?.count_12) }));
  const sites = n((await db.prepare('SELECT COUNT(*) AS n FROM sites').first())?.n);
  return { week, since_4: since4, since_12: since12, sites, features };
}
