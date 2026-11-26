/**
 * The activity record: one dated line for each thing that happens to an
 * account or a site, kept for the operator's pages (GET /admin/cloud/activity
 * in cloud.js) and removed with the account (migration 0022).
 *
 * It is switched off until the privacy page says so. Nothing here reads or
 * writes anything unless the service's ACTIVITY_RECORD setting is exactly
 * "on". Nothing here ever throws: a line that cannot be written is said in one
 * log line and dropped, and what the person was doing goes on as before.
 *
 * A line holds when it happened, the account and the site, which kind of thing
 * happened (ACTIVITY_KINDS), who did it (ACTIVITY_BY) and a few named fields of
 * one word or number each (DETAIL_FIELDS). Never what someone wrote or
 * published, a token, or an address.
 *
 *   noteActivity     one line; the account of a site named alone is read from the site's row
 *   notePublished    one line for a publish, found by the site's repository
 *   noteEmailSent    one line for an email Kiln sent about a site: the kind of email only
 *   noteSiteRemoved  one line says a site was removed; its earlier lines stay with the account
 *   forgetActivity   the lines of an account or a site go
 *   activityPage     newest first, for the operator
 */

export const ACTIVITY_KINDS = Object.freeze([
  'signed_up', 'site_added', 'setup_step', 'published',
  'subscription_started', 'subscription_renewed', 'payment_failed', 'subscription_ending', 'subscription_ended',
  'free_days_ended', 'free_days_given', 'email_sent', 'site_removed',
  'hosting_down', 'hosting_up', 'domain_live', 'operator_status_set', 'operator_line_hidden',
]);

/** person: the account holder. editor: an invited editor. kiln: the service on its own. */
export const ACTIVITY_BY = Object.freeze(['person', 'editor', 'operator', 'kiln', 'stripe']);

/** The only fields `detail` may hold, each a word, a number or a yes or no. */
export const DETAIL_FIELDS = Object.freeze(['way', 'step', 'mail', 'line', 'status', 'reason', 'plan', 'period', 'days', 'scheduled', 'undo']);

/** A word or a code: no spaces, so no sentence anyone wrote, and too short for a token. */
const WORD = /^[A-Za-z0-9_.:-]{1,32}$/;
export const DETAIL_MAX = 500;
export const ACTIVITY_PAGE_MAX = 200;
const PAGE_DEFAULT = 50;

export const activityOn = (env) => String(env?.ACTIVITY_RECORD || '').trim() === 'on' && !!env?.kiln_cloud;

/** `detail` as it is kept: the named fields that hold a word, a number or a yes or no, as JSON; else null. */
export function smallDetail(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const kept = {};
  for (const key of DETAIL_FIELDS) {
    const v = detail[key];
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) kept[key] = v;
    else if (typeof v === 'string' && WORD.test(v)) kept[key] = v;
  }
  const text = JSON.stringify(kept);
  return text === '{}' || text.length > DETAIL_MAX ? null : text;
}

function notWritten(kind, e) {
  try { console.warn(JSON.stringify({ evt: 'activity_not_written', kind: String(kind || '').slice(0, 40), detail: String(e?.message || e).slice(0, 160) })); } catch { /* never */ }
}

const known = (kind, by) => {
  if (!ACTIVITY_KINDS.includes(kind)) throw new Error('not a kind of activity');
  if (!ACTIVITY_BY.includes(by)) throw new Error('not one of those who act');
};
const idOrNull = (v) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, 120));

/** One line. Answers true when it was written. */
export async function noteActivity(env, { account_id = null, site_id = null, kind, by, detail = null, at = Date.now() } = {}) {
  if (!activityOn(env)) return false;
  try {
    known(kind, by);
    const account = idOrNull(account_id), site = idOrNull(site_id);
    if (!account && !site) throw new Error('neither an account nor a site');
    await env.kiln_cloud.prepare('INSERT INTO activity (at, account_id, site_id, kind, "by", detail) VALUES (?, COALESCE(?, (SELECT account_id FROM sites WHERE id = ?)), ?, ?, ?, ?)')
      .bind(Number(at) || Date.now(), account, site, site, kind, by, smallDetail(detail)).run();
    return true;
  } catch (e) { notWritten(kind, e); return false; }
}

/** A change published to a site, found by its repository. A repository that is no site on record gets no line. */
export async function notePublished(env, repo, { by, scheduled = false, at = Date.now() } = {}) {
  if (!activityOn(env)) return false;
  try {
    known('published', by);
    if (typeof repo !== 'string' || !repo) throw new Error('no repository');
    await env.kiln_cloud.prepare('INSERT INTO activity (at, account_id, site_id, kind, "by", detail) SELECT ?, account_id, id, \'published\', ?, ? FROM sites WHERE lower(repo) = lower(?) ORDER BY created_at LIMIT 1')
      .bind(Number(at) || Date.now(), by, smallDetail(scheduled ? { scheduled: true } : null), repo).run();
    return true;
  } catch (e) { notWritten('published', e); return false; }
}

/**
 * An email Kiln sent about a site (mail.js sendOnce). `key` is the one the
 * email is sent once by, "<kind>:<site id>[:...]"; the kind is kept and nothing
 * else about it. `site_id` is given where the key's second part is not the site.
 * Only a site on record gets a line.
 */
export async function noteEmailSent(env, key, { site_id = null } = {}) {
  if (!activityOn(env)) return false;
  try {
    const parts = String(key || '').split(':');
    if (!WORD.test(parts[0] || '')) throw new Error('an email with no kind');
    const site = idOrNull(site_id ?? parts[1]);
    if (!site) return false;
    await env.kiln_cloud.prepare('INSERT INTO activity (at, account_id, site_id, kind, "by", detail) SELECT ?, account_id, id, \'email_sent\', \'kiln\', ? FROM sites WHERE id = ?')
      .bind(Date.now(), smallDetail({ mail: parts[0] }), site).run();
    return true;
  } catch (e) { notWritten('email_sent', e); return false; }
}

/** The lines of an account or of a site go. Answers true when it was asked. */
export async function forgetActivity(env, { account_id = null, site_id = null } = {}) {
  if (!activityOn(env)) return false;
  try {
    const account = idOrNull(account_id), site = idOrNull(site_id);
    if (account) await env.kiln_cloud.prepare('DELETE FROM activity WHERE account_id = ?').bind(account).run();
    if (site) await env.kiln_cloud.prepare('DELETE FROM activity WHERE site_id = ?').bind(site).run();
    return !!(account || site);
  } catch (e) { notWritten('forget', e); return false; }
}

/**
 * A site was removed: one line says so. Its earlier lines stay, kept with the
 * account and removed with it, as the privacy page says: they are what tells
 * the operator how a site went before it was removed.
 */
export async function noteSiteRemoved(env, { account_id = null, site_id, by }) {
  if (!activityOn(env)) return false;
  return noteActivity(env, { account_id, site_id, kind: 'site_removed', by });
}

/**
 * The operator's read, newest first: one account's lines, one site's, or
 * everyone's. `limit` is at most ACTIVITY_PAGE_MAX; `before` is the `next` of
 * the page before. It throws when the table cannot be read (cloud.js says so).
 */
export async function activityPage(env, { account = null, site = null, limit = PAGE_DEFAULT, before = null } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || PAGE_DEFAULT, 1), ACTIVITY_PAGE_MAX);
  const where = [], args = [];
  if (idOrNull(account)) { where.push('account_id = ?'); args.push(idOrNull(account)); }
  if (idOrNull(site)) { where.push('site_id = ?'); args.push(idOrNull(site)); }
  const b = Number(before);
  if (Number.isSafeInteger(b) && b > 0) { where.push('id < ?'); args.push(b); }
  const sql = `SELECT id, at, account_id, site_id, kind, "by", detail FROM activity${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  const rows = (await env.kiln_cloud.prepare(sql).bind(...args, n).all())?.results || [];
  const read = (d) => { try { return d ? JSON.parse(d) : null; } catch { return null; } };
  return { activity: rows.map(r => ({ ...r, detail: read(r.detail) })), next: rows.length === n ? rows[rows.length - 1].id : null };
}
