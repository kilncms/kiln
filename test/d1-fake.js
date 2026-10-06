/**
 * An in-memory stand-in for the worker's D1 binding (`env.kiln_cloud`), backed
 * by Node's own SQLite so the worker's real SQL runs. Built from the same
 * migration files production gets, in order; `upTo` stops early, to stand for
 * a database a migration has not reached yet.
 *
 * node:sqlite ships with Node 22. On Node 20 `d1Available` is false and the
 * tests that need a database are skipped with that reason. Not a test file.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const WORKER = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'worker');
let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { /* Node 20 */ }
export const d1Available = !!sqlite;
export const d1Skip = d1Available ? false : 'needs node:sqlite (Node 22)';

export function schemaFiles() {
  const dir = path.join(WORKER, 'migrations');
  if (existsSync(dir)) return readdirSync(dir).filter(f => f.endsWith('.sql')).sort().map(f => path.join(dir, f));
  return [path.join(WORKER, 'cloud-schema.sql')];
}

export function fakeD1({ upTo = Infinity } = {}) {
  const db = new sqlite.DatabaseSync(':memory:');
  schemaFiles().slice(0, upTo).forEach(f => db.exec(readFileSync(f, 'utf8')));
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
  });
  return {
    db,
    prepare: (sql) => statement(sql),
    /** Test conveniences, not part of D1. */
    row: (sql, ...a) => db.prepare(sql).get(...a) ?? null,
    exec: (sql, ...a) => db.prepare(sql).run(...a),
  };
}

/** A Cloud worker env: one account ('acct-1', login 'ada') signed in to the dashboard with token 'tok'. */
export function cloudEnv(kv, extra = {}) {
  const d1 = fakeD1(extra.d1 || {});
  d1.exec("INSERT INTO accounts (id, github_login, email, created_at) VALUES ('acct-1', 'ada', 'ada@example.com', 1)");
  kv.map.set('csess:tok', JSON.stringify({ account_id: 'acct-1', login: 'ada', gh: 'gho_x' }));
  const { d1: _opts, ...rest } = extra;
  return { KILN: kv, kiln_cloud: d1, ALLOWED_ORIGINS: 'https://app.example', LS_API_KEY: 'ls_test_key', LS_STORE_ID: '1', LS_VARIANT_CLOUD: '11', LS_WEBHOOK_SECRET: 'whsec', ...rest };
}

export function addSite(env, over = {}) {
  const s = { id: 'site-1', account_id: 'acct-1', repo: 'ada/club', origin: 'https://club.example', plan: 'cloud', status: 'active', ls_subscription_id: null, created_at: Date.now(), ...over };
  env.kiln_cloud.exec('INSERT INTO sites (id, account_id, repo, origin, plan, status, ls_subscription_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
    s.id, s.account_id, s.repo, s.origin, s.plan, s.status, s.ls_subscription_id, s.created_at);
  return s;
}
