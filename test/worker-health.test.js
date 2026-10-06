/**
 * KLR-09, KLR-10 — seeing when it breaks, and not breaking it by watching.
 *
 *   /healthz?deep=1   asks KV, D1 and GitHub, and answers 503 naming the part
 *                     that failed; a plain GET stays a constant 200
 *   cron              each job runs and logs on its own
 *   presence          a ping writes to KV only when something changed, or
 *                     every five minutes
 *   monitor.yml       asks the deep check and the demo sites every 30 minutes
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import worker from '../worker/index.js';
import { fakeKV, withFetch, jsonRes, editorEnv, call, REPO, SESSION } from './worker-harness.js';

const PK8 = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const CREDS = { app_id: 4242, slug: 'kiln-test', client_id: 'cid', client_secret: 'CLIENT-SECRET-VALUE', pk8: PK8 };
const d1 = (ok = true) => ({ prepare: () => ({ first: async () => { if (!ok) throw new Error('D1_ERROR: database is locked: SECRET-INTERNAL-DETAIL'); return { up: 1 }; }, bind() { return this; }, run: async () => ({}), all: async () => ({ results: [] }) }) });
const github = (status = 200) => async (url) => (url === 'https://api.github.com/app' ? jsonRes({ id: 4242, slug: 'kiln-test' }, status) : undefined);
const get = async (env, path = '/healthz?deep=1') => { const res = await worker.fetch(new Request(`https://worker.example${path}`), env); const text = await res.text(); return { status: res.status, json: JSON.parse(text), text }; };

test('KLR-09 a plain GET /healthz is still a constant 200 that touches nothing', async () => {
  const kv = fakeKV({ 'app:creds': CREDS });
  let touched = 0;
  const watched = { ...kv, get: async (...a) => { touched++; return kv.get(...a); } };
  await withFetch(async () => { touched++; }, async (calls) => {
    const env = { KILN: watched, kiln_cloud: { prepare: () => { touched++; throw new Error('not asked'); } } };
    for (const path of ['/healthz', '/healthz?deep=0', '/healthz?deep=true', '/healthz?x=1']) {
      const r = await get(env, path);
      assert.equal(r.status, 200, path);
      assert.equal(r.json.ok, true);
      assert.equal('checks' in r.json, false, path);
    }
    assert.equal(touched, 0, 'no KV read, no D1 query');
    assert.equal(calls.length, 0, 'no call to GitHub');
  });
});

test('KLR-09 /healthz?deep=1: everything publishing needs is asked, and 200 means all of it answered', async () => {
  await withFetch(github(200), async (calls) => {
    const r = await get({ KILN: fakeKV({ 'app:creds': CREDS }), kiln_cloud: d1() });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.checks, { kv: 'ok', d1: 'ok', app: 'ok' });
    assert.deepEqual(r.json.failed, []);
    assert.equal(typeof r.json.version, 'string', 'the usual fields are still there');
    // GitHub was asked with a token signed by the App's key (a JWT: three dot-separated parts).
    assert.equal(calls.length, 1);
    assert.match(calls[0].headers.Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });
});

test('KLR-09 /healthz?deep=1 answers 503 and names the part that failed', async () => {
  const brokenKv = { get: async () => { throw new Error('KV GET failed: 500 SECRET-INTERNAL-DETAIL'); }, put: async () => {}, list: async () => ({ keys: [] }) };
  const cases = [
    ['the database', { KILN: fakeKV({ 'app:creds': CREDS }), kiln_cloud: d1(false) }, github(200), { kv: 'ok', d1: 'failed', app: 'ok' }, ['d1']],
    ['KV', { KILN: brokenKv, kiln_cloud: d1() }, github(200), { kv: 'failed', d1: 'ok', app: 'failed' }, ['kv', 'app']],
    ['GitHub rejecting the App key', { KILN: fakeKV({ 'app:creds': CREDS }), kiln_cloud: d1() }, github(401), { kv: 'ok', d1: 'ok', app: 'failed' }, ['app']],
    ['GitHub not answering', { KILN: fakeKV({ 'app:creds': CREDS }), kiln_cloud: d1() }, async () => { throw new Error('connect failed'); }, { kv: 'ok', d1: 'ok', app: 'failed' }, ['app']],
    ['a key that cannot sign', { KILN: fakeKV({ 'app:creds': { ...CREDS, pk8: 'bm90IGEga2V5' } }), kiln_cloud: d1() }, github(200), { kv: 'ok', d1: 'ok', app: 'failed' }, ['app']],
    ['no App registered yet', { KILN: fakeKV(), kiln_cloud: d1() }, github(200), { kv: 'ok', d1: 'ok', app: 'not configured' }, ['app']],
  ];
  for (const [name, env, gh, checks, failed] of cases) {
    await withFetch(gh, async () => {
      const r = await get(env);
      assert.equal(r.status, 503, name);
      assert.equal(r.json.ok, false, name);
      assert.deepEqual(r.json.checks, checks, name);
      assert.deepEqual(r.json.failed.sort(), [...failed].sort(), name);
      // Words only: no error text, no credential, no id.
      for (const secret of ['SECRET-INTERNAL-DETAIL', 'CLIENT-SECRET-VALUE', PK8.slice(0, 40), 'D1_ERROR', 'connect failed']) assert.equal(r.text.includes(secret), false, `${name} leaked ${secret.slice(0, 20)}`);
    });
  }
});

test('KLR-09 /healthz?deep=1 on a self-hosted worker: no database is not a failure; and it is rate-limited where a limiter is bound', async () => {
  await withFetch(github(200), async () => {
    const r = await get({ KILN: fakeKV({ 'app:creds': CREDS }) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.checks, { kv: 'ok', d1: 'not configured', app: 'ok' });
    let asked = 0;
    const limited = await get({ KILN: fakeKV({ 'app:creds': CREDS }), RL: { limit: async () => { asked++; return { success: false }; } } });
    assert.equal(limited.status, 429);
    assert.equal(asked, 1);
    assert.equal((await get({ KILN: fakeKV(), RL: { limit: async () => ({ success: false }) } }, '/healthz')).status, 200, 'the plain check is never limited');
  });
});

test('KLR-09 cron: each job runs on its own and leaves one structured line; a failure in the first does not skip the second', async () => {
  const lines = [];
  const real = { log: console.log, error: console.error };
  console.log = (l) => lines.push(['log', l]); console.error = (l) => lines.push(['error', l]);
  try {
    // Schedules blow up (KV list fails); the trial job must still run.
    let trialsRan = 0;
    const env = {
      KILN: { list: async () => { throw new Error('KV list exploded'); }, get: async () => null, put: async () => {}, delete: async () => {} },
      kiln_cloud: { prepare: () => ({ bind: () => ({ run: async () => { trialsRan++; return {}; } }) }) },
    };
    await worker.scheduled({}, env);
    assert.equal(trialsRan, 1, 'the second job ran');
    const parsed = lines.map(([level, l]) => ({ level, ...JSON.parse(l) }));
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed.map(p => [p.level, p.evt, p.job, p.ok]), [['error', 'cron', 'schedules', false], ['log', 'cron', 'trials', true]]);
    assert.match(parsed[0].error, /KV list exploded/);
    assert.equal(typeof parsed[1].ms, 'number');
    // Both fail: still no throw (an unhandled error in a cron is invisible).
    lines.length = 0;
    await worker.scheduled({}, { KILN: env.KILN, kiln_cloud: { prepare: () => { throw new Error('D1 down'); } } });
    assert.deepEqual(lines.map(([level]) => level), ['error', 'error']);
  } finally { console.log = real.log; console.error = real.error; }
});

test('KLR-09 a rejected billing webhook leaves a line', async () => {
  const lines = [];
  const realWarn = console.warn;
  console.warn = (l) => lines.push(l);
  try {
    const res = await worker.fetch(new Request('https://worker.example/cloud/webhook/ls', { method: 'POST', headers: { 'X-Signature': 'bad' }, body: '{"meta":{}}' }), { KILN: fakeKV(), LS_WEBHOOK_SECRET: 'whsec' });
    assert.equal(res.status, 401);
    assert.deepEqual(JSON.parse(lines[0]), { evt: 'webhook_rejected', reason: 'bad signature', bytes: 11 });
  } finally { console.warn = realWarn; }
});

// ─── presence ────────────────────────────────────────────────────────────────

/** An editor's env whose KV counts writes, and a clock the test moves. */
function presenceWorld() {
  const env = editorEnv();
  const kv = env.KILN;
  let puts = 0;
  const realPut = kv.put.bind(kv);
  kv.put = async (k, v, o) => { if (k.startsWith('pres:')) puts++; return realPut(k, v, o); };
  let t = 1_800_000_000_000;
  const realNow = Date.now;
  const ping = async (path = '/about/', session = SESSION) => { Date.now = () => t; try { return await call(env, 'POST', '/presence', { body: { repo: REPO, path }, session }); } finally { Date.now = realNow; } };
  return { env, kv, ping, puts: () => puts, wait: (ms) => { t += ms; }, entry: () => JSON.parse(kv.map.get(`pres:${REPO}:Sam`)) };
}

test('KLR-10 presence: a working day of pings is about a hundred KV writes, not a thousand', async () => {
  const w = presenceWorld();
  for (let i = 0; i < 1000; i++) { assert.equal((await w.ping()).status, 200); w.wait(30_000); }   // 8 h 20 min, one page
  assert.equal(w.puts(), 100, 'one write every five minutes');
});

test('KLR-10 presence: written on arrival, on moving to another page, and after five minutes; skipped otherwise', async () => {
  const w = presenceWorld();
  await w.ping('/about/');
  assert.equal(w.puts(), 1, 'arrival');
  for (let i = 0; i < 9; i++) { w.wait(30_000); await w.ping('/about/'); }
  assert.equal(w.puts(), 1, 'four and a half minutes on the same page: nothing written');
  w.wait(30_000); await w.ping('/about/');
  assert.equal(w.puts(), 2, 'five minutes');
  w.wait(30_000); await w.ping('/pricing/');
  assert.equal(w.puts(), 3, 'a different page is written at once');
  assert.equal(w.entry().page, '/pricing/');
  w.wait(30_000); await w.ping('/pricing/');
  assert.equal(w.puts(), 3);
});

test('KLR-10 presence: others still see who is here, and stop seeing someone who left', async () => {
  const w = presenceWorld();
  const other = 'b'.repeat(64);
  w.kv.map.set(`esess:${other}`, JSON.stringify({ repo: REPO, name: 'Robin', role: 'editor', email: 'robin@example.com', paths: [''], keys: [], features: null, mode: null }));
  await w.ping('/about/', other);
  // Four minutes later Robin has pinged all along (no writes), and Sam arrives: Robin is listed.
  w.wait(4 * 60_000);
  const sam = await w.ping('/about/');
  assert.deepEqual(sam.json.others, [{ name: 'Robin', role: 'editor' }]);
  assert.deepEqual(sam.json.online.map(o => o.name), ['Robin']);
  assert.ok(sam.json.scope, 'the editor still gets its scope from the ping');
  // Robin closed the editor. Seven minutes after their last write they are gone, even if KV has not expired the key yet.
  w.wait(3 * 60_000);
  assert.deepEqual((await w.ping('/about/')).json.online, []);
});

// ─── the monitor ─────────────────────────────────────────────────────────────

test('KLR-09 monitor.yml: every 30 minutes, the deep check and both demo sites, loudly, with no secret', () => {
  const text = readFileSync(new URL('../.github/workflows/monitor.yml', import.meta.url), 'utf8');
  const wf = YAML.parse(text);
  assert.equal(wf.on.schedule[0].cron, '7,37 * * * *');
  assert.ok('workflow_dispatch' in wf.on);
  assert.deepEqual(wf.permissions, { contents: 'read' });
  assert.doesNotMatch(text, /secrets\.|TOKEN|API_KEY/);
  const runs = wf.jobs.production.steps.map(s => s.run).join('\n');
  assert.match(runs, /https:\/\/auth\.kilncms\.com\/healthz\?deep=1/);
  assert.match(runs, /https:\/\/demo\.kilncms\.com\/ https:\/\/kiln-demo\.pages\.dev\//);
  assert.match(runs, /exit 1/);
  assert.match(runs, /::error::/);
  assert.equal(wf.jobs.production.steps.some(s => s.uses), false, 'nothing but curl: no checkout, no action to pin');
  // It only reads: GET requests to public addresses.
  assert.doesNotMatch(runs, /-X (POST|PUT|PATCH|DELETE)|--data|wrangler/);
});
