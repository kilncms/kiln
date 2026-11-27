/**
 * The problem tally: the problems the service meets, counted by the day
 * (migration 0026), so that the operator can notice a fault early, fix it,
 * and tell an owner when one affected their site (GET /admin/cloud/problems
 * in cloud.js).
 *
 * It is switched off until the privacy page says so. Nothing here reads or
 * writes anything unless the service's PROBLEM_TALLY setting is exactly "on".
 * Nothing here ever throws: a count that cannot be kept is said in one log
 * line and dropped, and the request or the job goes on as before.
 *
 * A row is one day (in Eastern time), one kind, one site (none when the
 * problem named none on Kiln) and one detail word, with how many times and
 * when first and last. Each problem adds one to its row, and problems that
 * arrive while their row's write waits are added to it and written once, so
 * a burst cannot flood the database (as the security log does). Never what
 * was being changed, a network address, a token or an email address: the
 * writers pass none, and nothing but these fields is kept.
 *
 *   noteProblem        one problem
 *   notePublishFailed  one change GitHub did not take, by the door it came through
 *   forgetProblems     a site's rows, when the site is removed
 *   pruneProblems      rows older than PROBLEM_KEEP_DAYS, and those of sites no longer on Kiln (the five-minute schedule)
 *   problemsPage       the last 14 days by kind and site, each kind marked new, ongoing or rising, for the operator
 *
 * The kinds, where they are noted, and the words `detail` holds:
 *   publish_failed       a change GitHub did not take (index.js). editor, owner: at the two doors, GitHub
 *                        refused the save with 403, 404 or 5xx (a conflict, which the editor tries again
 *                        itself, is not counted there); source, several, revert, suggestion, api: after the
 *                        service's own tries, a conflict or GitHub not answering (409, 5xx); scheduled: a
 *                        scheduled change given up without being published
 *   signin_not_finished  a sign-in that did not finish. github_<why>, google_<why> (a site's sign-in,
 *                        index.js); dash_github_<stage>, dash_google_<why>, dash_email_<why>, dash_cookie
 *                        (the dashboard, cloud.js); link_<stage>, link_cookie, link_write (a way of
 *                        signing in added to an account, cloud.js)
 *   email_not_sent       customer (mail.js sendMail), operator (cloud.js notifyOwner)
 *   copy_failed          a site being brought in that stopped (bring.js): the reason it stopped; not_started
 *   setup_failed         add_kiln, first_pass, editor_update (cloud.js); hosting_editor (lookafter.js);
 *                        keep_start (keeps.js)
 *   domain_failed        a site's own domain that could not be set up (cloud.js): the step it stopped at
 *   hosting_failed       a site that could not be put up, or its preview (hosted.js): the reason; preview
 */

export const PROBLEM_KINDS = Object.freeze(['publish_failed', 'signin_not_finished', 'email_not_sent', 'copy_failed', 'setup_failed', 'domain_failed', 'hosting_failed']);
export const PROBLEM_KEEP_DAYS = 400;
export const PROBLEM_PAGE_DAYS = 14;
export const PROBLEM_ROWS_MAX = 500;
/** Rising: the last 7 days at least three times the usual, a day. */
export const RISING_TIMES = 3;
const DAY = 24 * 3600 * 1000;
/** A detail is one lower-case word: never a sentence, an address or a token. */
const WORD = /^[a-z0-9_]{1,32}$/;
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

export const problemsOn = (env) => String(env?.PROBLEM_TALLY || '').trim() === 'on' && !!env?.kiln_cloud;

/** GitHub refused a save after the service's own tries: a conflict, or GitHub not answering. */
export const refusedAfterRetries = (status) => status === 409 || Number(status) >= 500;
/** GitHub refused a save at the editor's or the owner's door. A conflict is left out: the editor tries again itself. */
export const refusedAtDoor = (status) => status === 403 || status === 404 || Number(status) >= 500;

const EASTERN = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The date in Eastern time, YYYY-MM-DD. */
export function easternDay(ms) {
  const p = Object.fromEntries(EASTERN.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
/** The date `n` days after a YYYY-MM-DD date (before it when n is below 0). */
export function dayPlus(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** The Monday that starts the week of `ms`, in Eastern time, YYYY-MM-DD. */
export function easternMonday(ms) {
  const day = easternDay(ms);
  return dayPlus(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
}

const waiting = new WeakMap();   // the database → Map(row key → the write of that row that has not started)

/**
 * Adds a row's count with `write`, one write at a time for each row in this
 * isolate: counts for a row that arrive while its write waits are added to it
 * and written with it. Answers true when the row was written (with others, or
 * alone). Feature use (feature-use.js) counts the same way.
 */
export async function addUp(db, key, row, write, notKept) {
  let rows = waiting.get(db);
  if (!rows) { rows = new Map(); waiting.set(db, rows); }
  const queued = rows.get(key);
  if (queued && !queued.started) {   // this row's write waits already: the count is added to it
    queued.row.count += row.count;
    if (row.first !== undefined) { queued.row.first = Math.min(queued.row.first, row.first); queued.row.last = Math.max(queued.row.last, row.last); }
    return await queued.done;
  }
  const entry = { row, started: false };
  entry.done = (queued ? queued.done : Promise.resolve()).then(async () => {
    entry.started = true;
    try { await write(entry.row); return true; }
    catch (e) { notKept(e); return false; }
    finally { if (rows.get(key) === entry) rows.delete(key); }
  });
  rows.set(key, entry);
  return await entry.done;
}

function notKept(evt, kind, e) {
  try { console.warn(JSON.stringify({ evt, kind: String(kind || '').slice(0, 40), detail: String(e?.message || e).slice(0, 160) })); } catch { /* never */ }
}
const idOr = (v) => (v === null || v === undefined || v === '' ? '' : String(v).slice(0, 120));

// A site named by its repository is the site on record for it; the repository itself is not kept.
const UPSERT = `INSERT INTO problem_tally (day, kind, site_id, detail, count, first_at, last_at)
  VALUES (?, ?, COALESCE(NULLIF(?, ''), (SELECT id FROM sites WHERE ? != '' AND lower(repo) = lower(?) ORDER BY created_at LIMIT 1), ''), ?, ?, ?, ?)
  ON CONFLICT (day, kind, site_id, detail) DO UPDATE SET count = count + excluded.count,
    first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at)`;

/**
 * One problem. `site_id`, or `repo` for a site named by its repository;
 * `detail` one word. Answers true when its row was written.
 */
export async function noteProblem(env, { kind, site_id = null, repo = null, detail = null, at = Date.now() } = {}) {
  if (!problemsOn(env)) return false;
  try {
    if (!PROBLEM_KINDS.includes(kind)) throw new Error('not a kind of problem');
    const t = Number(at) || Date.now();
    const row = {
      day: easternDay(t), kind, site: idOr(site_id),
      repo: typeof repo === 'string' && REPO.test(repo) ? repo : '',
      detail: typeof detail === 'string' && WORD.test(detail) ? detail : '', count: 1, first: t, last: t,
    };
    const db = env.kiln_cloud;
    const key = ['problem', row.day, kind, row.site, row.repo.toLowerCase(), row.detail].join('\n');
    return await addUp(db, key, row,
      (r) => db.prepare(UPSERT).bind(r.day, r.kind, r.site, r.repo, r.repo, r.detail, r.count, r.first, r.last).run(),
      (e) => notKept('problem_not_written', kind, e));
  } catch (e) { notKept('problem_not_written', kind, e); return false; }
}

/** A change GitHub did not take, for the site of `repo`; `via` is the door (see the kinds above). */
export function notePublishFailed(env, repo, via, { at = Date.now() } = {}) {
  return noteProblem(env, { kind: 'publish_failed', repo, detail: via, at });
}

/** A site's rows go when the site does. It never throws: a removal goes on whatever happens here. */
export async function forgetProblems(env, siteId) {
  if (!problemsOn(env) || !siteId) return false;
  try { await env.kiln_cloud.prepare('DELETE FROM problem_tally WHERE site_id = ?').bind(String(siteId)).run(); return true; }
  catch (e) { notKept('problems_not_removed', 'site', e); return false; }
}

/**
 * Rows older than PROBLEM_KEEP_DAYS go, and so do the rows of a site no longer
 * on Kiln however it went. It throws when the database cannot be asked; the
 * schedule's cronJob says so.
 */
export async function pruneProblems(env, { now = Date.now() } = {}) {
  if (!problemsOn(env)) return { ran: false };
  await env.kiln_cloud.prepare("DELETE FROM problem_tally WHERE day < ? OR (site_id != '' AND site_id NOT IN (SELECT id FROM sites))")
    .bind(easternDay(now - PROBLEM_KEEP_DAYS * DAY)).run();
  return { ran: true };
}

/**
 * The last 14 days (today among them). Each kind: its count, its count in the
 * last 7 days and today, its count in the 14 days before (`before`; `usual` is
 * that a day), and its mark: new when it was not seen in the 14 days before,
 * rising when its last 7 days come to at least three times its usual a day,
 * otherwise ongoing; null when it was not seen. Then each kind's count by site
 * and by detail word, the newest PROBLEM_ROWS_MAX. It throws when the table
 * cannot be read (cloud.js says so).
 */
export async function problemsPage(env, { now = Date.now() } = {}) {
  const today = easternDay(now);
  const since = dayPlus(today, -(PROBLEM_PAGE_DAYS - 1)), from = dayPlus(since, -PROBLEM_PAGE_DAYS), week = dayPlus(today, -6);
  const db = env.kiln_cloud;
  const all = async (sql, ...args) => (await db.prepare(sql).bind(...args).all())?.results || [];
  const totals = await all(`SELECT kind, SUM(CASE WHEN day >= ? THEN count ELSE 0 END) AS recent, SUM(CASE WHEN day >= ? THEN count ELSE 0 END) AS week,
    SUM(CASE WHEN day = ? THEN count ELSE 0 END) AS today, SUM(CASE WHEN day < ? THEN count ELSE 0 END) AS before
    FROM problem_tally WHERE day >= ? GROUP BY kind`, since, week, today, since, from);
  const by = Object.fromEntries(totals.map(r => [r.kind, r]));
  const kinds = [...new Set([...PROBLEM_KINDS, ...totals.map(r => r.kind)])].map((kind) => {
    const r = by[kind] || {};
    const count = Number(r.recent) || 0, last7 = Number(r.week) || 0, before = Number(r.before) || 0;
    const usual = before / PROBLEM_PAGE_DAYS;
    const mark = !count ? null : !before ? 'new' : last7 / 7 >= RISING_TIMES * usual ? 'rising' : 'ongoing';
    return { kind, count, week: last7, today: Number(r.today) || 0, before, usual: Math.round(usual * 100) / 100, mark };
  });
  const sites = (await all(`SELECT p.kind, p.site_id, s.repo, SUM(p.count) AS count, COUNT(DISTINCT p.day) AS days, MIN(p.first_at) AS first_at, MAX(p.last_at) AS last_at
    FROM problem_tally p LEFT JOIN sites s ON s.id = p.site_id WHERE p.day >= ? GROUP BY p.kind, p.site_id ORDER BY last_at DESC LIMIT ?`, since, PROBLEM_ROWS_MAX))
    .map(r => ({ kind: r.kind, site_id: r.site_id || null, repo: r.repo || null, count: Number(r.count) || 0, days: Number(r.days) || 0, first_at: r.first_at, last_at: r.last_at }));
  const details = (await all('SELECT kind, detail, SUM(count) AS count FROM problem_tally WHERE day >= ? GROUP BY kind, detail ORDER BY count DESC, kind, detail LIMIT ?', since, PROBLEM_ROWS_MAX))
    .map(r => ({ kind: r.kind, detail: r.detail || null, count: Number(r.count) || 0 }));
  return { days: PROBLEM_PAGE_DAYS, since, today, kinds, sites, details };
}
