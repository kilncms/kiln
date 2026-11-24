/**
 * An in-memory stand-in for the worker's D1 binding (`env.kiln_cloud`), backed
 * by Node's own SQLite so the worker's real SQL runs. Built from the same
 * migration files production gets, in order; `upTo` stops early, to stand for
 * a database a migration has not reached yet.
 *
 * node:sqlite ships with Node 22. On Node 20 `d1Available` is false and the
 * tests that need a database are skipped with that reason. Not a test file.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const WORKER = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'worker');
let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { /* Node 20 */ }
export const d1Available = !!sqlite;
export const d1Skip = d1Available ? false : 'needs node:sqlite (Node 22)';

export function schemaFiles() {
  const dir = path.join(WORKER, 'migrations');
  return readdirSync(dir).filter(f => f.endsWith('.sql')).sort().map(f => path.join(dir, f));
}

export function fakeD1({ upTo = Infinity } = {}) {
  const db = new sqlite.DatabaseSync(':memory:');
  schemaFiles().slice(0, upTo).forEach(f => db.exec(readFileSync(f, 'utf8')));
  const statement = (sql, args = []) => ({
    sql, args,
    bind: (...a) => statement(sql, a),
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
  });
  return {
    db,
    prepare: (sql) => statement(sql),
    /** As D1 does it: every statement is carried out, or none is. */
    async batch(list) {
      db.exec('BEGIN');
      try { const out = list.map(s => ({ success: true, meta: { changes: Number(db.prepare(s.sql).run(...s.args).changes) } })); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    /** Test conveniences, not part of D1. */
    row: (sql, ...a) => db.prepare(sql).get(...a) ?? null,
    exec: (sql, ...a) => db.prepare(sql).run(...a),
  };
}

/** A Cloud worker env: one account ('acct-1', login 'ada') signed in to the dashboard with token 'tok'. Billing is on: Stripe's key, the price of the plan without hosting and the webhook's secret are set. */
export function cloudEnv(kv, extra = {}) {
  const d1 = fakeD1(extra.d1 || {});
  d1.exec("INSERT INTO accounts (id, github_login, email, created_at) VALUES ('acct-1', 'ada', 'ada@example.com', 1)");
  kv.map.set('csess:tok', JSON.stringify({ account_id: 'acct-1', login: 'ada', gh: 'gho_x' }));
  const { d1: _opts, ...rest } = extra;
  return { KILN: kv, kiln_cloud: d1, ALLOWED_ORIGINS: 'https://app.example', STRIPE_SECRET_KEY: 'sk_test_key', STRIPE_PRICE_CLOUD: 'price_cloud', STRIPE_WEBHOOK_SECRET: 'whsec', ...rest };
}

/**
 * One site. `stripe_subscription_id` says it is paid for. A database that
 * migration 0017 has not reached has no column for it, and there the site is
 * added without one: on such a database no site has a subscription.
 */
export function addSite(env, over = {}) {
  const s = { id: 'site-1', account_id: 'acct-1', repo: 'ada/club', origin: 'https://club.example', plan: 'cloud', status: 'active', stripe_subscription_id: null, created_at: Date.now(), ...over };
  env.kiln_cloud.exec('INSERT INTO sites (id, account_id, repo, origin, plan, status, created_at) VALUES (?,?,?,?,?,?,?)',
    s.id, s.account_id, s.repo, s.origin, s.plan, s.status, s.created_at);
  if (s.stripe_subscription_id !== null && s.stripe_subscription_id !== undefined) {
    try { env.kiln_cloud.exec('UPDATE sites SET stripe_subscription_id = ? WHERE id = ?', s.stripe_subscription_id, s.id); } catch { /* a database without migration 0017 */ }
  }
  // What a later migration added, when a test gives it: how far set-up got, whether Kiln keeps the files,
  // what was paid for, and when a change was last published through Kiln (0020). A database the column
  // has not reached is left without it.
  for (const column of ['prepared_at', 'firstpass_at', 'kept', 'name', 'access_until', 'billing_period', 'paid_until', 'last_publish']) {
    if (s[column] === undefined) continue;
    try { env.kiln_cloud.exec(`UPDATE sites SET ${column} = ? WHERE id = ?`, s[column], s.id); } catch { /* not on this database yet */ }
  }
  return s;
}

/**
 * One more account. `google_sub` with `google_email`, `signin_email`, `name`,
 * `linked_at` and `last_seen` (0020) are written when given, each where the
 * database has the column.
 */
export function addAccount(env, over = {}) {
  const a = { id: 'acct-2', github_login: null, email: null, created_at: Date.now(), ...over };
  env.kiln_cloud.exec('INSERT INTO accounts (id, github_login, email, created_at) VALUES (?,?,?,?)', a.id, a.github_login, a.email, a.created_at);
  for (const column of ['github_id', 'name', 'google_sub', 'google_email', 'signin_email', 'linked_at', 'last_seen']) {
    if (a[column] === undefined) continue;
    try { env.kiln_cloud.exec(`UPDATE accounts SET ${column} = ? WHERE id = ?`, a[column], a.id); } catch { /* not on this database yet */ }
  }
  return a;
}
