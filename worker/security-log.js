/**
 * The security log: the requests the service refuses, counted by the hour
 * (migration 0025), so that the operator can notice an attack or a fault
 * early (GET /admin/cloud/security in cloud.js).
 *
 * It is switched off until the privacy page says so. Nothing here reads or
 * writes anything unless the service's SECURITY_LOG setting is exactly "on".
 * Nothing here ever throws: a count that cannot be kept is said in one log
 * line and dropped, and the refusal is answered as before.
 *
 * A row is one hour, one kind, one account (none when the request was not
 * signed in to the dashboard), one site (none when it named none on Kiln) and
 * one detail word, with how many times and when first and last. A burst makes
 * one row with a large count: each refusal adds one to its row, and refusals
 * that arrive while their row's write waits are added to it and written once.
 * Never a network address, a token, a code, an email address or what was
 * being edited: the writers pass none, and nothing but these fields is kept.
 *
 *   noteSecurity      one refusal
 *   pruneSecurityLog  rows older than SECURITY_KEEP_DAYS go (the five-minute schedule)
 *   securityPage      the last days, totals by kind and by hour, and the rows, for the operator
 *
 * The kinds, and the words `detail` holds for each:
 *   rate_limited     asked too often. address, standing, session (index.js rateLimited, standingLimited,
 *                    workLimited); signin_email, signin_network (emailLoginSend); code_tries (emailCodeFinish)
 *   wrong_code       a sign-in code typed wrong (emailCodeFinish)
 *   cross_account    refused because the site or account is not the asker's. other_site, origin_repo, no_push
 *                    (index.js, the editor door); site, repo (cloud.js ownedSite); admin (the admin routes)
 *   bad_signature    a message claiming to be from Stripe or GitHub whose signature failed. stripe, github
 *   operator_signin  the operator signed in to the dashboard, about the operator only. github
 */

export const SECURITY_KINDS = Object.freeze(['rate_limited', 'wrong_code', 'cross_account', 'bad_signature', 'operator_signin']);
export const SECURITY_KEEP_DAYS = 90;
export const SECURITY_DAYS_DEFAULT = 7;
export const SECURITY_ROWS_MAX = 500;
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
/** A detail is one lower-case word: never a sentence, an address or a token. */
const WORD = /^[a-z0-9_]{1,32}$/;
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

export const securityOn = (env) => String(env?.SECURITY_LOG || '').trim() === 'on' && !!env?.kiln_cloud;

function notKept(kind, e) {
  try { console.warn(JSON.stringify({ evt: 'security_not_written', kind: String(kind || '').slice(0, 40), detail: String(e?.message || e).slice(0, 160) })); } catch { /* never */ }
}
const idOr = (v) => (v === null || v === undefined || v === '' ? '' : String(v).slice(0, 120));

// A site named by its repository is the site on record for it; the repository itself is not kept.
const UPSERT = `INSERT INTO security_log (hour, kind, account_id, site_id, detail, count, first_at, last_at)
  VALUES (?, ?, ?, COALESCE(NULLIF(?, ''), (SELECT id FROM sites WHERE ? != '' AND lower(repo) = lower(?) ORDER BY created_at LIMIT 1), ''), ?, ?, ?, ?)
  ON CONFLICT (hour, kind, account_id, site_id, detail) DO UPDATE SET count = count + excluded.count,
    first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at)`;

const waiting = new WeakMap();   // the database → Map(row key → the write of that row that has not started)

/**
 * One refusal. `site_id`, or `repo` for a site named by its repository; `detail`
 * one word. Answers true when its row was written (with others, or alone).
 */
export async function noteSecurity(env, { kind, account_id = null, site_id = null, repo = null, detail = null, at = Date.now() } = {}) {
  if (!securityOn(env)) return false;
  try {
    if (!SECURITY_KINDS.includes(kind)) throw new Error('not a kind of refusal');
    const t = Number(at) || Date.now();
    const row = {
      hour: t - (t % HOUR), kind, account: idOr(account_id), site: idOr(site_id),
      repo: typeof repo === 'string' && REPO.test(repo) ? repo : '',
      detail: typeof detail === 'string' && WORD.test(detail) ? detail : '', count: 1, first: t, last: t,
    };
    const db = env.kiln_cloud;
    let rows = waiting.get(db);
    if (!rows) { rows = new Map(); waiting.set(db, rows); }
    const key = [row.hour, kind, row.account, row.site, row.repo.toLowerCase(), row.detail].join('\n');
    const queued = rows.get(key);
    if (queued && !queued.started) {   // this row's write waits already: the refusal is added to it
      queued.row.count += 1;
      queued.row.first = Math.min(queued.row.first, t);
      queued.row.last = Math.max(queued.row.last, t);
      return await queued.done;
    }
    const entry = { row, started: false };
    entry.done = (queued ? queued.done : Promise.resolve()).then(async () => {
      entry.started = true;
      const r = entry.row;
      try {
        await db.prepare(UPSERT).bind(r.hour, r.kind, r.account, r.site, r.repo, r.repo, r.detail, r.count, r.first, r.last).run();
        return true;
      } catch (e) { notKept(kind, e); return false; }
      finally { if (rows.get(key) === entry) rows.delete(key); }
    });
    rows.set(key, entry);
    return await entry.done;
  } catch (e) { notKept(kind, e); return false; }
}

/** Rows older than SECURITY_KEEP_DAYS go. It throws when the database cannot be asked; the schedule's cronJob says so. */
export async function pruneSecurityLog(env, { now = Date.now() } = {}) {
  if (!securityOn(env)) return { ran: false };
  await env.kiln_cloud.prepare('DELETE FROM security_log WHERE hour < ?').bind(now - SECURITY_KEEP_DAYS * DAY).run();
  return { ran: true };
}

/**
 * The last `days` (SECURITY_DAYS_DEFAULT, at most SECURITY_KEEP_DAYS): the
 * total of each kind, the total of each kind in each hour (newest first), and
 * the newest SECURITY_ROWS_MAX rows behind them. It throws when the table
 * cannot be read (cloud.js says so).
 */
export async function securityPage(env, { days = SECURITY_DAYS_DEFAULT, now = Date.now() } = {}) {
  const n = Math.min(Math.max(parseInt(days, 10) || SECURITY_DAYS_DEFAULT, 1), SECURITY_KEEP_DAYS);
  const from = now - n * DAY, since = from - (from % HOUR);
  const db = env.kiln_cloud;
  const all = async (sql, ...args) => (await db.prepare(sql).bind(...args).all())?.results || [];
  const kinds = Object.fromEntries(SECURITY_KINDS.map(k => [k, 0]));
  for (const r of await all('SELECT kind, SUM(count) AS n FROM security_log WHERE hour >= ? GROUP BY kind', since)) kinds[r.kind] = Number(r.n) || 0;
  const hours = (await all('SELECT hour, kind, SUM(count) AS count FROM security_log WHERE hour >= ? GROUP BY hour, kind ORDER BY hour DESC, kind', since))
    .map(r => ({ hour: r.hour, kind: r.kind, count: Number(r.count) || 0 }));
  const rows = (await all('SELECT hour, kind, account_id, site_id, detail, count, first_at, last_at FROM security_log WHERE hour >= ? ORDER BY last_at DESC, hour DESC LIMIT ?', since, SECURITY_ROWS_MAX))
    .map(r => ({ hour: r.hour, kind: r.kind, account_id: r.account_id || null, site_id: r.site_id || null, detail: r.detail || null, count: Number(r.count) || 0, first_at: r.first_at, last_at: r.last_at }));
  return { days: n, since, kinds, hours, rows };
}
