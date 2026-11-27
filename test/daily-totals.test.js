/**
 * Daily totals (worker/daily-totals.js, migration 0024). Switched off, the
 * five-minute run reads and writes nothing and the read route reads nothing.
 * Switched on, the first run of a day in Eastern time writes one line for the
 * whole of Kiln and every later run that day writes none; no person is in it;
 * a line that cannot be written leaves the run going on; only the operator
 * reads the lines, newest first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { runDailyTotals, easternDay, TOTALS_PAGE_MAX } from '../worker/daily-totals.js';
import { fakeKV, withFetch } from './worker-harness.js';
import { cloudEnv, addSite, addAccount, d1Skip } from './d1-fake.js';

const DAY = 86400e3;
const NIGHT = Date.UTC(2026, 10, 26, 5, 2);   // 00:02 Eastern on 26 November 2026
const call = async (env, path, token = 'tok') => {
  const res = await worker.fetch(new Request(`https://worker.example${path}`, { headers: { Authorization: `Bearer ${token}` } }), env);
  return { status: res.status, json: await res.json().catch(() => null) };
};
const quietly = async (fn) => {
  const was = [console.log, console.warn, console.error];
  const said = [];
  console.log = console.warn = console.error = (s) => said.push(String(s));
  try { await fn(); } finally { [console.log, console.warn, console.error] = was; }
  return said;
};
const nobodyAnswers = (fn) => withFetch(async () => undefined, fn);   // Stripe included: the fixed prices count
const rows = (env) => env.kiln_cloud.db.prepare('SELECT * FROM daily_totals ORDER BY day').all().map(r => ({ ...r }));
const run = (env) => worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env);

/** The operator 'ada' (acct-1) and a customer 'uma': two sites paying (one on each plan), one on free days, one ended. */
function world({ on = true } = {}) {
  const kv = fakeKV();
  const env = cloudEnv(kv, { CLOUD_ADMIN: 'ada', ...(on ? { DAILY_TOTALS: 'on' } : {}) });
  kv.map.set('csess:tok-uma', JSON.stringify({ account_id: 'acct-uma', login: 'uma', uid: 202, gh: 'gho_u' }));
  addAccount(env, { id: 'acct-uma', github_login: 'uma', email: 'uma@example.com' });
  addSite(env);
  addSite(env, { id: 'site-2', account_id: 'acct-uma', repo: 'uma/shop', origin: 'https://shop.example', plan: 'managed', status: 'active' });
  addSite(env, { id: 'site-3', account_id: 'acct-uma', repo: 'uma/blog', origin: 'https://blog.example', status: 'trialing' });
  addSite(env, { id: 'site-4', account_id: 'acct-uma', repo: 'uma/old', origin: 'https://old.example', status: 'canceled' });
  return { env, kv };
}

test('switched off, the totals ask the database nothing, whatever else the setting says', async () => {
  const asked = [];
  const db = { prepare: (sql) => { asked.push(sql); throw new Error('asked'); } };
  for (const DAILY_TOTALS of [undefined, 'off', 'ON', '', 'yes']) {
    assert.deepEqual(await runDailyTotals({ kiln_cloud: db, ...(DAILY_TOTALS === undefined ? {} : { DAILY_TOTALS }) }), { ran: false });
  }
  assert.deepEqual(asked, []);
  assert.equal(TOTALS_PAGE_MAX, 400);
});

test('the day is the date in Eastern time, in winter and in summer', () => {
  assert.equal(easternDay(Date.UTC(2026, 10, 26, 4, 59)), '2026-11-25');
  assert.equal(easternDay(Date.UTC(2026, 10, 26, 5, 1)), '2026-11-26');
  assert.equal(easternDay(Date.UTC(2026, 6, 4, 3, 59)), '2026-07-03');
  assert.equal(easternDay(Date.UTC(2026, 6, 4, 4, 1)), '2026-07-04');
});

test('switched off, the five-minute run keeps no line and the read route reads nothing', { skip: d1Skip }, async () => {
  const { env } = world({ on: false });
  await nobodyAnswers(() => quietly(() => run(env)));
  assert.equal(rows(env).length, 0);
  assert.deepEqual((await call(env, '/admin/cloud/totals')).json, { ok: true, recording: false, totals: [] });
});

test('switched on, the first run of a day writes one line for all of Kiln, naming no one, and every later run that day writes none', { skip: d1Skip }, async () => {
  const { env } = world();
  await nobodyAnswers(async () => {
    assert.deepEqual(await runDailyTotals(env, { now: NIGHT }), { ran: true, day: '2026-11-26', written: true });
    for (let i = 1; i <= 20; i++) assert.deepEqual(await runDailyTotals(env, { now: NIGHT + i * 300e3 }), { ran: true, day: '2026-11-26', written: false });
    assert.deepEqual(await runDailyTotals(env, { now: NIGHT + DAY }), { ran: true, day: '2026-11-27', written: true });
  });
  assert.deepEqual(rows(env), [
    { day: '2026-11-26', at: NIGHT, accounts: 2, sites: 4, paying: 2, mrr_cents: 499 + 1499, trialing: 1 },
    { day: '2026-11-27', at: NIGHT + DAY, accounts: 2, sites: 4, paying: 2, mrr_cents: 1998, trialing: 1 },
  ]);
  const text = JSON.stringify(rows(env));
  for (const never of ['acct', 'site-', 'uma', 'ada', '@', 'https://']) assert.ok(!text.includes(never), never);
  // The schedule itself, run many times today: one line for today.
  await nobodyAnswers(() => quietly(async () => { for (let i = 0; i < 4; i++) await run(env); }));
  assert.equal(rows(env).filter(r => r.day === easternDay(Date.now())).length, 1);
  // Prices Stripe holds, where they were read: a yearly price counts as a twelfth of it each month.
  env.kiln_cloud.exec("UPDATE sites SET billing_period = 'year' WHERE id = 'site-1'");
  const store = { prices: [{ plan: 'cloud', period: 'year', interval: 'year', amount: 48 }] };
  await runDailyTotals(env, { now: NIGHT + 2 * DAY, store });
  assert.equal(rows(env).find(r => r.day === '2026-11-28').mrr_cents, 400 + 1499);
});

test('a line that cannot be written is said in the run\'s log line, and the run goes on to its heartbeat', { skip: d1Skip }, async () => {
  const { env, kv } = world();
  env.kiln_cloud.db.exec('DROP TABLE daily_totals');
  const said = await nobodyAnswers(() => quietly(() => run(env)));
  const line = said.map(s => { try { return JSON.parse(s); } catch { return {}; } }).find(l => l.evt === 'cron' && l.job === 'totals');
  assert.equal(line.ok, false);
  assert.ok(Number(kv.map.get('hb:cron')) > 0);
});

test('only the operator reads the totals: newest first, up to 400 days', { skip: d1Skip }, async () => {
  const { env } = world();
  await nobodyAnswers(async () => { for (let d = 0; d < 3; d++) await runDailyTotals(env, { now: NIGHT + d * DAY }); });
  for (const token of ['tok-uma', 'nobody']) assert.equal((await call(env, '/admin/cloud/totals', token)).status, 403);
  const read = await call(env, '/admin/cloud/totals');
  assert.equal(read.status, 200);
  assert.equal(read.json.recording, true);
  assert.deepEqual(read.json.totals.map(t => t.day), ['2026-11-28', '2026-11-27', '2026-11-26']);
  assert.deepEqual((await call(env, '/admin/cloud/totals?limit=2')).json.totals.map(t => t.day), ['2026-11-28', '2026-11-27']);
  assert.equal((await call(env, '/admin/cloud/totals?limit=9000')).json.totals.length, 3);
});
