/**
 * The daily site check (worker/daily-check.js, migration 0023). Switched off,
 * the five-minute run asks no site anything and nothing is read or written.
 * Switched on, a run checks only sites not checked for a day, at most a few,
 * keeps one row for each, deletes rows older than 30 days and rows of sites no
 * longer on Kiln, and goes on past a site that does not answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { runDailySiteChecks, checkSummary, DAILY_CHECK_SLICE } from '../worker/daily-check.js';
import { withKilnTags } from '../worker/prepare.js';
import { fakeKV, withFetch } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

const HOUR = 3600e3, DAY = 24 * HOUR;
const KILN_PAGE = withKilnTags('<!doctype html><html><head><title>Club</title></head><body><p>Hello</p></body></html>').html;
const page = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
/** The sites on the web: one with Kiln on it, one without, one that does not answer. */
const web = async (url) => {
  const u = new URL(url);
  if (u.hostname.endsWith('down.example')) throw new TypeError('fetch failed');
  if (u.hostname.endsWith('plain.example')) return u.pathname === '/' ? page('<html><body>Hi</body></html>') : page('not here', 404);
  return page(u.pathname === '/' ? KILN_PAGE : 'ok');
};
const rows = (env) => env.kiln_cloud.db.prepare('SELECT site_id, at, ok, summary FROM site_checks ORDER BY site_id, at').all();
const call = async (env, path, token = 'tok') => {
  const res = await worker.fetch(new Request(`https://worker.example${path}`, { headers: { Authorization: `Bearer ${token}` } }), env);
  return { status: res.status, json: await res.json().catch(() => null) };
};

function world({ on = true } = {}) {
  const kv = fakeKV();
  const env = cloudEnv(kv, { CLOUD_ADMIN: 'ada', ...(on ? { SITE_CHECK_DAILY: 'on' } : {}) });
  kv.map.set('csess:tok-uma', JSON.stringify({ account_id: 'acct-1b', login: 'uma', uid: 202, gh: 'gho_u' }));
  const t0 = Date.now() - 50 * DAY;
  const site = (id, origin, over = {}) => addSite(env, { id, repo: `ada/${id}`, origin: origin.replace('https://', `https://${id}.`), created_at: t0 + Number(id.replace(/\D/g, '')) * 1000, ...over });
  site('s1', 'https://kiln.example');                         // checked two hours ago: not due
  site('s2', 'https://kiln.example');                         // checked 25 hours ago: due, after those never checked
  site('s3', 'https://kiln.example');                         // never checked, with Kiln on it
  site('s4', 'https://down.example');                         // never checked, does not answer
  site('s5', 'https://plain.example');                        // never checked, no Kiln on it
  site('s6', 'https://kiln.example');                         // never checked
  site('s7', 'https://kiln.example', { status: 'canceled' }); // its free days ended unpaid: never asked
  kv.map.set('ebuild:ada/s3', JSON.stringify({ build: '0.11.0', at: 1 }));
  return { env, kv };
}

test('switched off, a run reads and writes nothing', async () => {
  const asked = [];
  const db = { prepare: (sql) => { asked.push(sql); throw new Error('asked'); } };
  for (const SITE_CHECK_DAILY of [undefined, 'off', 'ON', '']) {
    assert.deepEqual(await runDailySiteChecks({ kiln_cloud: db, ...(SITE_CHECK_DAILY === undefined ? {} : { SITE_CHECK_DAILY }) }), { ran: false });
  }
  assert.deepEqual(asked, []);
  assert.equal(DAILY_CHECK_SLICE, 4);
});

test('a summary is a word or two for each check and the editor version, nothing else', () => {
  const found = { lines: [{ id: 'address', ok: true, detail: 'https://x.example answers.' }, { id: 'live', ok: false, detail: 'a sentence' }, { id: 'signin', ok: null, detail: 'another' }], home: { status: 200 } };
  assert.deepEqual(checkSummary(found, '0.11.0'), { address: 'answers', live: 'no kiln', signin: 'not checked', editor: '0.11.0' });
  assert.deepEqual(checkSummary({ lines: [{ id: 'address', ok: false }], home: { problem: 'no_answer' } }, 'not a version, a sentence'), { address: 'no answer', live: 'not checked', signin: 'not checked', editor: null });
  assert.deepEqual(checkSummary(null), { address: 'not checked', live: 'not checked', signin: 'not checked', editor: null });
});

test('switched off, the five-minute run asks no site anything and keeps no row', { skip: d1Skip }, async () => {
  const { env } = world({ on: false });
  await withFetch(web, async (calls) => {
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env);
    assert.deepEqual(calls.filter(c => /\.example\//.test(c.url)).map(c => c.url), []);
  });
  assert.equal(rows(env).length, 0);
  assert.deepEqual((await call(env, '/admin/cloud/checks')).json, { ok: true, checking: false, checks: [] });
});

test('a run checks only sites not checked for a day, at most the slice, one row each, deletes old rows, and goes on past a site that does not answer', { skip: d1Skip }, async () => {
  const { env } = world();
  const now = Date.now();
  const keep = (site, at) => env.kiln_cloud.exec("INSERT INTO site_checks (site_id, at, ok, summary) VALUES (?, ?, 1, '{}')", site, at);
  keep('s1', now - 2 * HOUR);
  keep('s1', now - 31 * DAY);     // older than 30 days: goes
  keep('s2', now - 25 * HOUR);
  keep('gone', now - HOUR);       // a site no longer on Kiln: goes
  await withFetch(web, async () => {
    const first = await runDailySiteChecks(env, { now });
    assert.deepEqual(first, { ran: true, due: 4, checked: 4 });
    const second = await runDailySiteChecks(env, { now });
    assert.deepEqual(second, { ran: true, due: 1, checked: 1 });
    assert.deepEqual(await runDailySiteChecks(env, { now }), { ran: true, due: 0, checked: 0 });
  });
  const kept = rows(env).map(r => [r.site_id, r.at === now ? 'now' : Math.round((now - r.at) / HOUR) + 'h', r.ok, JSON.parse(r.summary)]);
  assert.deepEqual(kept, [
    ['s1', '2h', 1, {}],
    ['s2', '25h', 1, {}],
    ['s2', 'now', 1, { address: 'answers', live: 'loads kiln', signin: 'answers', editor: null }],
    ['s3', 'now', 1, { address: 'answers', live: 'loads kiln', signin: 'answers', editor: '0.11.0' }],
    ['s4', 'now', 0, { address: 'no answer', live: 'not checked', signin: 'not checked', editor: null }],
    ['s5', 'now', 0, { address: 'answers', live: 'no kiln', signin: 'no answer', editor: null }],
    ['s6', 'now', 1, { address: 'answers', live: 'loads kiln', signin: 'answers', editor: null }],
  ]);
  // A day later every site is due again, and a run takes the slice.
  await withFetch(web, async () => assert.equal((await runDailySiteChecks(env, { now: now + DAY })).due, 4));
});

test('switched on, the five-minute run does one slice, and only the operator reads the latest check of each site', { skip: d1Skip }, async () => {
  const { env } = world();
  await withFetch(web, async () => { await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env); });
  assert.equal(rows(env).length, DAILY_CHECK_SLICE);
  assert.equal((await call(env, '/admin/cloud/checks', 'tok-uma')).status, 403);
  const read = await call(env, '/admin/cloud/checks');
  assert.equal(read.status, 200);
  assert.equal(read.json.checking, true);
  assert.deepEqual(read.json.checks.map(c => c.site_id).sort(), ['s1', 's2', 's3', 's4']);
  assert.deepEqual(read.json.checks.find(c => c.site_id === 's3'), { site_id: 's3', at: read.json.checks.find(c => c.site_id === 's3').at, ok: true, summary: { address: 'answers', live: 'loads kiln', signin: 'answers', editor: '0.11.0' } });
});
