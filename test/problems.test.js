/**
 * The problem tally (worker/problems.js, migration 0026). Switched off,
 * nothing is counted or read and every route answers as before. Switched on,
 * each problem adds one to its day's row for its kind, site and detail word,
 * never what was being changed, an address, a token or an email address; a
 * burst is one row; a count that cannot be kept is dropped and the request
 * answers as before; the five-minute run deletes rows older than 400 days and
 * those of sites no longer on Kiln; a site's rows go with the site; only the
 * operator reads the tally, each kind marked new, ongoing or rising.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { noteProblem, notePublishFailed, forgetProblems, pruneProblems, refusedAfterRetries, refusedAtDoor, PROBLEM_KINDS, easternDay, easternMonday, dayPlus } from '../worker/problems.js';
import { sendMail } from '../worker/mail.js';
import { notifyOwner } from '../worker/cloud.js';
import { fakeKV, withFetch } from './worker-harness.js';
import { cloudEnv, addSite, addAccount, d1Skip } from './d1-fake.js';

const ADDRESS = '203.0.113.9';
const rows = (env) => env.kiln_cloud.db.prepare('SELECT kind, site_id, detail, count FROM problem_tally ORDER BY kind, detail, site_id').all().map(r => ({ ...r }));
const total = (env) => env.kiln_cloud.row('SELECT COUNT(*) n FROM problem_tally').n;
const call = async (env, path, { method = 'GET', token = 'tok', headers = {}, body } = {}) => {
  const res = await worker.fetch(new Request(`https://worker.example${path}`, {
    method, redirect: 'manual', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', Origin: 'https://app.example', 'CF-Connecting-IP': ADDRESS, ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), env);
  return { status: res.status, json: await res.clone().json().catch(() => null) };
};
const quiet = (fn) => withFetch(async () => undefined, fn);   // nothing outside the worker answers
const hushed = async (fn) => {
  const was = [console.log, console.warn, console.error];
  const said = [];
  console.log = console.warn = console.error = (s) => said.push(String(s));
  try { await fn(); } finally { [console.log, console.warn, console.error] = was; }
  return said;
};
const lines = (said, evt) => said.map(s => { try { return JSON.parse(s); } catch { return {}; } }).filter(l => l.evt === evt);
const down = { send: async () => { throw new Error('mail is down for 203.0.113.9'); } };

/** The operator 'ada' (token 'tok', acct-1, site-1 ada/club) and a customer 'uma' (token 'tok-uma', site-2 uma/cafe). */
function world({ on = true } = {}) {
  const kv = fakeKV();
  const env = cloudEnv(kv, { CLOUD_ADMIN: 'ada', ...(on ? { PROBLEM_TALLY: 'on' } : {}) });
  addAccount(env, { id: 'acct-uma', github_login: 'uma', email: 'uma@example.com' });
  kv.map.set('csess:tok-uma', JSON.stringify({ account_id: 'acct-uma', login: 'uma', uid: 202, gh: 'gho_u' }));
  addSite(env);
  addSite(env, { id: 'site-2', account_id: 'acct-uma', repo: 'uma/cafe', origin: 'https://cafe.example' });
  return { env, kv };
}
/** A row written straight into the table, `ago` Eastern days before today. */
const put = (env, { kind, site = '', detail = '', ago = 0, count = 1 }) => {
  const at = Date.now() - ago * 864e5;
  env.kiln_cloud.exec('INSERT INTO problem_tally (day, kind, site_id, detail, count, first_at, last_at) VALUES (?,?,?,?,?,?,?)', dayPlus(easternDay(Date.now()), -ago), kind, site, detail, count, at, at);
};

test('switched off, nothing is asked of the database, whatever else the setting says', async () => {
  for (const PROBLEM_TALLY of [undefined, 'off', 'ON', '', 'yes']) {
    const asked = [];
    const env = { kiln_cloud: { prepare: (sql) => { asked.push(sql); throw new Error('asked'); } }, ...(PROBLEM_TALLY === undefined ? {} : { PROBLEM_TALLY }) };
    assert.equal(await noteProblem(env, { kind: 'email_not_sent', detail: 'customer' }), false);
    assert.equal(await notePublishFailed(env, 'ada/club', 'editor'), false);
    assert.equal(await forgetProblems(env, 'site-1'), false);
    assert.deepEqual(await pruneProblems(env), { ran: false });
    assert.deepEqual(asked, [], `PROBLEM_TALLY=${PROBLEM_TALLY}`);
  }
  assert.deepEqual(PROBLEM_KINDS, ['publish_failed', 'signin_not_finished', 'email_not_sent', 'copy_failed', 'setup_failed', 'domain_failed', 'hosting_failed']);
  // A kind not on the list is refused, and nothing throws.
  const said = await hushed(async () => assert.equal(await noteProblem({ kiln_cloud: { prepare: () => { throw new Error('asked'); } }, PROBLEM_TALLY: 'on' }, { kind: 'felt_odd' }), false));
  assert.equal(lines(said, 'problem_not_written').length, 1);
  // Which refusals count as a change GitHub did not take, after the service's tries and at the doors.
  assert.deepEqual([200, 403, 404, 409, 422, 500, 502].filter(refusedAfterRetries), [409, 500, 502]);
  assert.deepEqual([200, 401, 403, 404, 409, 422, 500, 503].filter(refusedAtDoor), [403, 404, 500, 503]);
  // Days are Eastern; a week starts on Monday.
  assert.equal(easternDay(Date.UTC(2026, 10, 27, 3, 0)), '2026-11-26');   // 10 at night in New York
  assert.equal(easternMonday(Date.UTC(2026, 10, 26, 17)), '2026-11-23');
  assert.equal(easternMonday(Date.UTC(2026, 10, 23, 17)), '2026-11-23');
  assert.equal(easternMonday(Date.UTC(2026, 10, 30, 3)), '2026-11-23');   // Sunday night in New York
});

test('switched off, no problem is counted, the read route reads nothing, and the routes answer as they do switched on', { skip: d1Skip }, async () => {
  const answers = async (env) => {
    const out = [];
    await quiet(() => hushed(async () => {
      out.push(await call(env, '/cloud/callback', { token: null }));   // a dashboard sign-in with no code: it did not finish
      Object.assign(env, { NOTIFY_TO: 'owner@kiln.example', NOTIFY: down, CUSTOMER_MAIL_FROM: 'hello@kiln.example' });
      out.push({ note: await notifyOwner(env, 'Kiln: a note', ['one line']) ?? null });
      out.push(await sendMail(env, 'uma@example.com', { subject: 'Hello', text: 'x' }, { repo: 'uma/cafe' }));
    }));
    return out;
  };
  const off = world({ on: false });
  const answeredOff = await answers(off.env);
  assert.equal(total(off.env), 0);
  assert.deepEqual((await call(off.env, '/admin/cloud/problems')).json, { ok: true, recording: false, kinds: [], sites: [], details: [] });
  const on = world();
  assert.deepEqual(answeredOff, await answers(on.env));
  assert.equal(answeredOff[0].status, 302);
  assert.ok(total(on.env) > 0);
});

test('switched on, each writer adds one to its row, with the site where there is one, and never an address, a token or an email', { skip: d1Skip }, async () => {
  const { env } = world();
  await quiet(() => hushed(async () => {
    await call(env, '/cloud/callback', { token: null });
    Object.assign(env, { NOTIFY_TO: 'owner@kiln.example', NOTIFY: down, CUSTOMER_MAIL_FROM: 'hello@kiln.example' });
    await notifyOwner(env, 'Kiln: a note about ada/club', ['uma@example.com']);
    await sendMail(env, 'uma@example.com', { subject: 'Your site', text: 'x' }, { repo: 'UMA/Cafe' });
    await notePublishFailed(env, 'ada/club', 'editor');
    await notePublishFailed(env, 'ada/club', 'editor');
    await notePublishFailed(env, 'uma/cafe', 'scheduled');
    await noteProblem(env, { kind: 'setup_failed', site_id: 'site-2', detail: 'add_kiln' });
  }));
  assert.deepEqual(rows(env), [
    { kind: 'email_not_sent', site_id: 'site-2', detail: 'customer', count: 1 },
    { kind: 'email_not_sent', site_id: '', detail: 'operator', count: 1 },
    { kind: 'publish_failed', site_id: 'site-1', detail: 'editor', count: 2 },
    { kind: 'publish_failed', site_id: 'site-2', detail: 'scheduled', count: 1 },
    { kind: 'setup_failed', site_id: 'site-2', detail: 'add_kiln', count: 1 },
    { kind: 'signin_not_finished', site_id: '', detail: 'dash_github_state', count: 1 },
  ]);
  // A detail is one word and a site is one on record: a sentence, an address or an unknown repository is not kept.
  await noteProblem(env, { kind: 'copy_failed', detail: `stopped at ${ADDRESS}`, repo: 'some/one-else' });
  assert.deepEqual(rows(env).find(r => r.kind === 'copy_failed'), { kind: 'copy_failed', site_id: '', detail: '', count: 1 });
  const text = JSON.stringify(env.kiln_cloud.db.prepare('SELECT * FROM problem_tally').all());
  for (const never of [ADDRESS, 'tok', 'gho_', '@', 'ada/club', 'uma/cafe', 'mail is down', 'Your site']) assert.ok(!text.includes(never), never);
  const one = env.kiln_cloud.row("SELECT day, first_at, last_at FROM problem_tally WHERE kind = 'publish_failed' AND detail = 'editor'");
  assert.equal(one.day, easternDay(Date.now()));
  assert.ok(one.first_at <= one.last_at);
});

test('a burst of 1,000 problems in one day is one row with a count of 1,000, one after another or all at once', { skip: d1Skip }, async () => {
  const { env } = world();
  const at = Date.UTC(2026, 10, 26, 17, 0, 1);
  for (let i = 0; i < 1000; i++) await notePublishFailed(env, 'ADA/Club', 'source', { at: at + i });
  let writes = 0;
  const prepare = env.kiln_cloud.prepare.bind(env.kiln_cloud);
  env.kiln_cloud.prepare = (sql) => { if (sql.startsWith('INSERT INTO problem_tally')) writes++; return prepare(sql); };
  const all = await Promise.all(Array.from({ length: 1000 }, (_, i) => noteProblem(env, { kind: 'signin_not_finished', detail: 'google_busy', at: at + i })));
  assert.ok(all.every(Boolean));
  assert.ok(writes <= 2, `written ${writes} times`);
  assert.deepEqual(rows(env), [
    { kind: 'publish_failed', site_id: 'site-1', detail: 'source', count: 1000 },
    { kind: 'signin_not_finished', site_id: '', detail: 'google_busy', count: 1000 },
  ]);
  const one = env.kiln_cloud.row("SELECT day, first_at, last_at FROM problem_tally WHERE kind = 'publish_failed'");
  assert.deepEqual([one.day, one.first_at, one.last_at], ['2026-11-26', at, at + 999]);
  await notePublishFailed(env, 'ada/club', 'source', { at: at + 86400e3 });   // the next day: a row of its own
  assert.equal(total(env), 3);
});

test('a count that cannot be kept is said in the log and dropped, and the request answers as before', { skip: d1Skip }, async () => {
  const { env } = world();
  env.kiln_cloud.db.exec('DROP TABLE problem_tally');
  let answered;
  const said = await hushed(async () => { answered = await quiet(() => call(env, '/cloud/callback', { token: null })); });
  assert.equal(answered.status, 302);
  assert.deepEqual(lines(said, 'problem_not_written').map(l => l.kind), ['signin_not_finished']);
  assert.equal(await hushed(() => forgetProblems(env, 'site-1')).then(s => lines(s, 'problems_not_removed').length), 1);
});

test('the five-minute run deletes rows older than 400 days and those of sites gone; a removed site takes its rows; only the operator reads the tally, each kind marked', { skip: d1Skip }, async () => {
  const { env } = world();
  // publish_failed: only today, so new. email_not_sent: 14 in the 14 days before (1 a day) and 21 in the last 7 days, so rising.
  // signin_not_finished: 14 before and 7 in the last 7 days, so ongoing. copy_failed: not seen.
  put(env, { kind: 'publish_failed', site: 'site-1', detail: 'editor', count: 3 });
  put(env, { kind: 'publish_failed', site: 'site-2', detail: 'owner', count: 1 });
  put(env, { kind: 'email_not_sent', detail: 'customer', ago: 20, count: 14 });
  put(env, { kind: 'email_not_sent', detail: 'customer', ago: 2, count: 21 });
  put(env, { kind: 'signin_not_finished', detail: 'google_busy', ago: 15, count: 14 });
  put(env, { kind: 'signin_not_finished', detail: 'google_busy', ago: 3, count: 7 });
  put(env, { kind: 'setup_failed', site: 'site-2', detail: 'first_pass', ago: 399 });
  put(env, { kind: 'setup_failed', site: 'site-2', detail: 'first_pass', ago: 401 });
  put(env, { kind: 'hosting_failed', site: 'site-gone', detail: 'record' });
  await quiet(() => hushed(() => worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env)));
  assert.equal(env.kiln_cloud.row("SELECT COUNT(*) n FROM problem_tally WHERE kind = 'setup_failed'").n, 1);
  assert.equal(env.kiln_cloud.row("SELECT COUNT(*) n FROM problem_tally WHERE site_id = 'site-gone'").n, 0);

  for (const token of ['tok-uma', 'nobody']) assert.equal((await call(env, '/admin/cloud/problems', { token })).status, 403);
  const page = (await call(env, '/admin/cloud/problems')).json;
  assert.equal(page.recording, true);
  assert.equal(page.days, 14);
  const mark = Object.fromEntries(page.kinds.map(k => [k.kind, k.mark]));
  assert.deepEqual(mark, { publish_failed: 'new', signin_not_finished: 'ongoing', email_not_sent: 'rising', copy_failed: null, setup_failed: null, domain_failed: null, hosting_failed: null });
  assert.deepEqual(page.kinds.find(k => k.kind === 'email_not_sent'), { kind: 'email_not_sent', count: 21, week: 21, today: 0, before: 14, usual: 1, mark: 'rising' });
  assert.deepEqual(page.sites.filter(s => s.kind === 'publish_failed').map(s => [s.site_id, s.repo, s.count]).sort(), [['site-1', 'ada/club', 3], ['site-2', 'uma/cafe', 1]]);
  assert.deepEqual(page.details.find(d => d.kind === 'signin_not_finished'), { kind: 'signin_not_finished', detail: 'google_busy', count: 7 });

  // The owner removes site-2: its rows go with it, and site-1's stay.
  await quiet(() => hushed(() => call(env, '/cloud/sites/remove', { method: 'POST', token: 'tok-uma', body: { id: 'site-2' } })));
  assert.equal(env.kiln_cloud.row("SELECT COUNT(*) n FROM sites WHERE id = 'site-2'").n, 0);
  assert.equal(env.kiln_cloud.row("SELECT COUNT(*) n FROM problem_tally WHERE site_id = 'site-2'").n, 0);
  assert.equal(env.kiln_cloud.row("SELECT COUNT(*) n FROM problem_tally WHERE site_id = 'site-1'").n, 1);
});
