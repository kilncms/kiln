/**
 * The security log (worker/security-log.js, migration 0025). Switched off, no
 * refusal is counted, nothing is read, and every refusal answers as before.
 * Switched on, each refusal adds one to its hour's row (a burst is one row
 * with a large count), naming the account and the site where there are and
 * never an address, a token, a code or an email address; a count that cannot
 * be kept is dropped and the refusal answers as before; the five-minute run
 * deletes rows older than 90 days; only the operator reads the log.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { noteSecurity, pruneSecurityLog, SECURITY_KINDS } from '../worker/security-log.js';
import { fakeKV, withFetch } from './worker-harness.js';
import { cloudEnv, addSite, addAccount, d1Skip } from './d1-fake.js';

const HOUR = 3600e3, DAY = 24 * HOUR;
const ADDRESS = '203.0.113.9';
const rows = (env) => env.kiln_cloud.db.prepare('SELECT kind, account_id, site_id, detail, count FROM security_log ORDER BY kind, detail, account_id, site_id').all().map(r => ({ ...r }));
const total = (env) => env.kiln_cloud.row('SELECT COUNT(*) n FROM security_log').n;
const call = async (env, path, { method = 'GET', token = 'tok', headers = {}, body } = {}) => {
  const res = await worker.fetch(new Request(`https://worker.example${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', Origin: 'https://app.example', 'CF-Connecting-IP': ADDRESS, ...headers },
    ...(body === undefined ? {} : { body }),
  }), env);
  return { status: res.status, json: await res.json().catch(() => null) };
};
const quiet = (fn) => withFetch(async () => undefined, fn);   // nothing outside the worker answers
const hushed = async (fn) => {
  const was = [console.log, console.warn, console.error];
  const said = [];
  console.log = console.warn = console.error = (s) => said.push(String(s));
  try { await fn(); } finally { [console.log, console.warn, console.error] = was; }
  return said;
};

/** The operator 'ada' (token 'tok', acct-1, site-1 ada/club) and a customer 'uma' (token 'tok-uma'). */
function world({ on = true } = {}) {
  const kv = fakeKV();
  const env = cloudEnv(kv, { CLOUD_ADMIN: 'ada', GH_WEBHOOK_SECRET: 'ghsec', ...(on ? { SECURITY_LOG: 'on' } : {}) });
  addAccount(env, { id: 'acct-uma', github_login: 'uma', email: 'uma@example.com' });
  kv.map.set('csess:tok-uma', JSON.stringify({ account_id: 'acct-uma', login: 'uma', uid: 202, gh: 'gho_u' }));
  addSite(env);
  return { env, kv };
}

/** Requests the service refuses, one of each kind it can be asked here; their answers are compared with the log off and on. */
async function refusals(env) {
  const out = [];
  await quiet(async () => {
    out.push(await call(env, '/cloud/sites/prepare?site=site-1', { token: 'tok-uma' }));   // another account's site
    out.push(await call(env, '/admin/cloud/overview', { token: 'tok-uma' }));               // not the operator
    out.push(await call(env, '/admin/cloud/overview', { token: 'nobody' }));                // not signed in
    out.push(await call(env, '/cloud/webhook/stripe', { method: 'POST', token: null, headers: { 'Stripe-Signature': 't=1,v1=00' }, body: '{"id":"evt_x"}' }));
    out.push(await call(env, '/gh/webhook', { method: 'POST', token: null, headers: { 'X-Hub-Signature-256': 'sha256=00', 'X-GitHub-Event': 'push' }, body: '{"zen":"x"}' }));
    env.RL = { limit: async () => ({ success: false }) };   // a limiter that refuses everything
    out.push(await call(env, '/cloud/sites/prepare?site=site-1', { token: 'tok-uma' }));
    delete env.RL;
  });
  return out;
}

test('switched off, nothing is asked of the database, whatever else the setting says', async () => {
  for (const SECURITY_LOG of [undefined, 'off', 'ON', '', 'yes']) {
    const asked = [];
    const env = { kiln_cloud: { prepare: (sql) => { asked.push(sql); throw new Error('asked'); } }, ...(SECURITY_LOG === undefined ? {} : { SECURITY_LOG }) };
    assert.equal(await noteSecurity(env, { kind: 'rate_limited', detail: 'address' }), false);
    assert.deepEqual(await pruneSecurityLog(env), { ran: false });
    assert.deepEqual(asked, [], `SECURITY_LOG=${SECURITY_LOG}`);
  }
  assert.deepEqual(SECURITY_KINDS, ['rate_limited', 'wrong_code', 'cross_account', 'bad_signature', 'operator_signin']);
  // A kind not on the list is refused, and nothing throws.
  const said = await hushed(async () => assert.equal(await noteSecurity({ kiln_cloud: { prepare: () => { throw new Error('asked'); } }, SECURITY_LOG: 'on' }, { kind: 'looked_around' }), false));
  assert.equal(JSON.parse(said[0]).evt, 'security_not_written');
});

test('switched off, no refusal is counted, the read route reads nothing, and every refusal answers as it does switched on', { skip: d1Skip }, async () => {
  const off = world({ on: false });
  const answeredOff = await refusals(off.env);
  assert.equal(total(off.env), 0);
  assert.deepEqual((await call(off.env, '/admin/cloud/security')).json, { ok: true, recording: false, kinds: {}, hours: [], rows: [] });
  const on = world();
  const answeredOn = await refusals(on.env);
  assert.deepEqual(answeredOff, answeredOn);
  assert.deepEqual(answeredOn.map(a => a.status), [404, 403, 403, 400, 401, 429]);
});

test('switched on, each refusal adds one to its row, with the account and the site where there are, and never an address, a token or an email', { skip: d1Skip }, async () => {
  const { env } = world();
  await refusals(env);
  assert.deepEqual(rows(env), [
    { kind: 'bad_signature', account_id: '', site_id: '', detail: 'github', count: 1 },
    { kind: 'bad_signature', account_id: '', site_id: '', detail: 'stripe', count: 1 },
    { kind: 'cross_account', account_id: '', site_id: '', detail: 'admin', count: 1 },
    { kind: 'cross_account', account_id: 'acct-uma', site_id: '', detail: 'admin', count: 1 },
    { kind: 'cross_account', account_id: 'acct-uma', site_id: 'site-1', detail: 'site', count: 1 },
    { kind: 'rate_limited', account_id: '', site_id: '', detail: 'address', count: 1 },
  ]);
  const text = JSON.stringify(env.kiln_cloud.db.prepare('SELECT * FROM security_log').all());
  for (const never of [ADDRESS, 'tok', 'gho_', '@', 'whsec', 'ghsec', 'evt_x', 'ada/club', 'zen']) assert.ok(!text.includes(never), never);
  // A detail is one word and a site is one on record: a sentence, an address or an unknown repository is not kept.
  await noteSecurity(env, { kind: 'rate_limited', detail: `limit for ${ADDRESS}`, repo: 'some/one-else' });
  assert.deepEqual(rows(env).find(r => r.kind === 'rate_limited' && !r.detail), { kind: 'rate_limited', account_id: '', site_id: '', detail: '', count: 1 });
});

test('a burst of 1,000 refusals in one hour is one row with a count of 1,000, one after another or all at once', { skip: d1Skip }, async () => {
  const { env } = world();
  const at = Date.UTC(2026, 10, 26, 14, 0, 1);
  for (let i = 0; i < 1000; i++) await noteSecurity(env, { kind: 'wrong_code', repo: 'ADA/Club', at: at + i });
  let writes = 0;
  const prepare = env.kiln_cloud.prepare.bind(env.kiln_cloud);
  env.kiln_cloud.prepare = (sql) => { if (sql.startsWith('INSERT INTO security_log')) writes++; return prepare(sql); };
  const all = await Promise.all(Array.from({ length: 1000 }, (_, i) => noteSecurity(env, { kind: 'rate_limited', detail: 'session', at: at + i })));
  assert.ok(all.every(Boolean));
  assert.ok(writes <= 2, `written ${writes} times`);
  assert.deepEqual(rows(env), [
    { kind: 'rate_limited', account_id: '', site_id: '', detail: 'session', count: 1000 },
    { kind: 'wrong_code', account_id: '', site_id: 'site-1', detail: '', count: 1000 },
  ]);
  const one = env.kiln_cloud.row("SELECT hour, first_at, last_at FROM security_log WHERE kind = 'wrong_code'");
  assert.deepEqual([one.hour, one.first_at, one.last_at], [Date.UTC(2026, 10, 26, 14), at, at + 999]);
  await noteSecurity(env, { kind: 'wrong_code', repo: 'ada/club', at: at + HOUR });   // the next hour: a row of its own
  assert.equal(total(env), 3);
});

test('a count that cannot be kept is said in the log and dropped, and the refusal answers as before', { skip: d1Skip }, async () => {
  const { env } = world();
  env.kiln_cloud.db.exec('DROP TABLE security_log');
  let answered;
  const said = await hushed(async () => { answered = await quiet(() => call(env, '/admin/cloud/overview', { token: 'tok-uma' })); });
  assert.equal(answered.status, 403);
  assert.deepEqual(said.map(s => { try { return JSON.parse(s); } catch { return {}; } }).filter(l => l.evt === 'security_not_written').map(l => l.kind), ['cross_account']);
});

test('the five-minute run deletes rows older than 90 days, and only the operator reads the log: by kind and by hour, the last 7 days unless asked', { skip: d1Skip }, async () => {
  const { env } = world();
  const now = Date.now();
  for (const [kind, ago, n, detail] of [['rate_limited', 2 * HOUR, 3, 'address'], ['rate_limited', 3 * DAY, 2, 'address'], ['wrong_code', 10 * DAY, 4, null], ['bad_signature', 91 * DAY, 1, 'stripe']]) {
    for (let i = 0; i < n; i++) await noteSecurity(env, { kind, detail, at: now - ago });
  }
  await quiet(() => hushed(() => worker.scheduled({ cron: '*/5 * * * *', scheduledTime: now }, env)));
  assert.deepEqual(rows(env).map(r => r.kind), ['rate_limited', 'rate_limited', 'wrong_code']);
  for (const token of ['tok-uma', 'nobody']) assert.equal((await call(env, '/admin/cloud/security', { token })).status, 403);
  const week = (await call(env, '/admin/cloud/security')).json;
  assert.equal(week.recording, true);
  assert.equal(week.days, 7);
  assert.deepEqual(week.kinds, { rate_limited: 5, wrong_code: 0, cross_account: 2, bad_signature: 0, operator_signin: 0 });
  assert.deepEqual(week.hours.filter(h => h.kind === 'rate_limited').map(h => h.count), [3, 2]);
  assert.ok(week.hours.every((h, i) => i === 0 || week.hours[i - 1].hour >= h.hour), 'newest hour first');
  assert.deepEqual(week.rows.filter(r => r.kind === 'cross_account').map(r => r.account_id).sort(), ['acct-uma', null].sort());
  assert.equal((await call(env, '/admin/cloud/security?days=30')).json.kinds.wrong_code, 4);
  assert.equal((await call(env, '/admin/cloud/security?days=900')).json.days, 90);
});
