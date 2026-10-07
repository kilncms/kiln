/**
 * What the people list tells the owner's panel about the worker itself:
 * whether Google sign-in is set up, and whether an AI key is. The panel
 * offers only what can work, so "AI assist" is not a box to tick on a
 * worker with no key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fakeKV, withFetch, jsonRes, ORIGIN } from './worker-harness.js';

const GH = 'https://api.github.com';
const REPO = 'acme/site';
const OWNER = { Authorization: 'Bearer gho_owner' };

/** GitHub says the caller may push to REPO; nothing else answers. */
const github = async (url, init) => {
  if (url === `${GH}/repos/${REPO}` && (init.headers.Authorization || '').includes('gho_owner')) return jsonRes({ id: 7, full_name: REPO, permissions: { push: true } });
  throw new TypeError('fetch failed');
};

async function people(extra = {}) {
  const env = { ALLOWED_ORIGINS: ORIGIN, KILN: fakeKV(), ...extra };
  let out = null;
  await withFetch(github, async () => {
    const res = await worker.fetch(new Request(`https://worker.example/admin/people?repo=${REPO}`, { headers: { Origin: ORIGIN, ...OWNER } }), env);
    out = { status: res.status, json: await res.json() };
  });
  return out;
}

test('the people list says an AI key is set when it is', async () => {
  const r = await people({ AI_API_KEY: 'sk-test' });
  assert.equal(r.status, 200);
  assert.equal(r.json.aiConfigured, true);
});

test('the people list says no AI key is set when there is none, so the panel does not offer AI assist', async () => {
  const r = await people();
  assert.equal(r.status, 200);
  assert.equal(r.json.aiConfigured, false);
});

test('the people list still says whether Google sign-in is set up, and never the key itself', async () => {
  const r = await people({ AI_API_KEY: 'sk-test', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' });
  assert.equal(r.json.googleConfigured, true);
  assert.deepEqual(Object.keys(r.json).sort(), ['aiConfigured', 'googleConfigured', 'people']);
  assert.equal(JSON.stringify(r.json).includes('sk-test'), false);
});
