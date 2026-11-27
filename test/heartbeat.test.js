/**
 * The five-minute schedule's heartbeat (index.js noteHeartbeat): each run ends
 * by writing the time to KV (`hb:cron`), and /healthz?deep=1 says how long ago
 * that was (`cron_age_s`), as information only: it is never one of the checks
 * that can fail, which the release script reads. It names no one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../worker/index.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';

const PK8 = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const CREDS = { app_id: 4242, slug: 'kiln-test', client_id: 'cid', client_secret: 'CLIENT-SECRET-VALUE', pk8: PK8 };
const d1 = () => ({ prepare: () => ({ first: async () => ({ up: 1 }), bind() { return this; }, run: async () => ({}), all: async () => ({ results: [] }) }) });
const github = async (url) => (url === 'https://api.github.com/app' ? jsonRes({ id: 4242, slug: 'kiln-test' }) : undefined);
const deep = async (env) => {
  const res = await worker.fetch(new Request('https://worker.example/healthz?deep=1'), env);
  return { status: res.status, json: await res.json() };
};
const quietly = async (fn) => {
  const was = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { [console.log, console.warn, console.error] = was; }
};

test('the five-minute run ends by writing its heartbeat, the every-minute one does not, and the deep check tells its age without counting it', async () => {
  const kv = fakeKV({ 'app:creds': CREDS });
  const env = { KILN: kv, kiln_cloud: d1() };
  await withFetch(github, async () => {
    const before = await deep(env);
    assert.equal(before.status, 200);
    assert.equal(before.json.cron_age_s, null, 'no run has written one yet');
    // The every-minute trigger, on a minute the five-minute one does not run: no heartbeat.
    await quietly(() => worker.scheduled({ cron: '* * * * *', scheduledTime: Date.UTC(2026, 10, 26, 12, 3) }, env));
    assert.equal(kv.map.get('hb:cron'), undefined);
    const t0 = Date.now();
    await quietly(() => worker.scheduled({ cron: '*/5 * * * *', scheduledTime: t0 }, env));
    const at = Number(kv.map.get('hb:cron'));
    assert.ok(at >= t0 && at <= Date.now(), 'the time the run ended');
    assert.ok((await deep(env)).json.cron_age_s <= 1);
    // Ten minutes silent: the age says so, and the answer is still 200 with the same checks.
    kv.map.set('hb:cron', String(Date.now() - 600e3));
    const late = await deep(env);
    assert.equal(late.status, 200);
    assert.ok(late.json.cron_age_s >= 600 && late.json.cron_age_s <= 601);
    assert.equal(late.json.ok, true);
    assert.deepEqual(late.json.checks, { kv: 'ok', d1: 'ok', app: 'ok' });
    assert.deepEqual(late.json.failed, []);
    // The plain handshake stays as it was: no age, and nothing asked.
    const plain = await (await worker.fetch(new Request('https://worker.example/healthz'), env)).json();
    assert.equal('cron_age_s' in plain, false);
  });
});

test('a heartbeat that cannot be written is said in a log line and the run ends as before; an age that cannot be read is null', async () => {
  const warned = [];
  const kv = { get: async () => { throw new Error('KV down'); }, put: async () => { throw new Error('KV down'); }, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) };
  const was = [console.log, console.warn, console.error];
  console.log = console.error = () => {};
  console.warn = (s) => warned.push(String(s));
  try {
    await withFetch(async () => undefined, () => worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, { KILN: kv, kiln_cloud: d1() }));
  } finally { [console.log, console.warn, console.error] = was; }
  assert.ok(warned.some(w => { try { return JSON.parse(w).evt === 'cron_heartbeat_not_written'; } catch { return false; } }));
  const res = await withFetch(github, () => deep({ KILN: kv, kiln_cloud: d1() }));
  assert.equal(res.json.cron_age_s, null);
});
