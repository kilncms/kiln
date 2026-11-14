/**
 * KLR-08 / KLN-04 — the Kiln Cloud operator is identified by GitHub's numeric
 * user id, which survives a rename; the login is only a fallback for a worker
 * that has no id configured yet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { isCloudAdmin } from '../worker/cloud.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';

test('KLR-08 with CLOUD_ADMIN_ID set, the id decides: the right login with another id is not the operator', () => {
  const env = { CLOUD_ADMIN: 'erikkwilder', CLOUD_ADMIN_ID: '4242' };
  assert.equal(isCloudAdmin({ login: 'erikkwilder', uid: 4242 }, env), true);
  assert.equal(isCloudAdmin({ login: 'renamed-since', uid: 4242 }, env), true, 'a rename does not lock the operator out');
  assert.equal(isCloudAdmin({ login: 'erikkwilder', uid: 9999 }, env), false, 'someone who registered the freed username');
  assert.equal(isCloudAdmin({ login: 'erikkwilder' }, env), false, 'a session from before ids were recorded signs in again');
  assert.equal(isCloudAdmin({ login: 'erikkwilder', uid: null }, env), false);
  assert.equal(isCloudAdmin(null, env), false);
  assert.equal(isCloudAdmin({ login: 'erikkwilder', uid: 4242 }, { CLOUD_ADMIN: 'erikkwilder', CLOUD_ADMIN_ID: 'not-a-number' }), false, 'a malformed id admits nobody');
});

test('KLR-08 without an id configured, the login is compared as before; with neither, nobody is the operator', () => {
  assert.equal(isCloudAdmin({ login: 'erikkwilder', uid: 1 }, { CLOUD_ADMIN: 'erikkwilder' }), true);
  assert.equal(isCloudAdmin({ login: 'someone', uid: 1 }, { CLOUD_ADMIN: 'erikkwilder' }), false);
  assert.equal(isCloudAdmin({ login: '', uid: 1 }, {}), false);
  assert.equal(isCloudAdmin({ login: undefined }, { CLOUD_ADMIN: '' }), false);
});

test('KLR-08 end to end: sign-in records the numeric id, and /admin/cloud/* answers by it', async () => {
  const kv = fakeKV({ 'app:creds': { client_id: 'cid', client_secret: 'cs' }, 'cstate:n1': '1', 'cstate:n2': '1' });
  const d1 = { prepare: () => ({ bind: () => ({ first: async () => ({ id: 'acct', github_login: 'x' }), run: async () => ({}), all: async () => ({ results: [] }) }) }), batch: async () => [] };
  const env = { KILN: kv, kiln_cloud: d1, CLOUD_ADMIN: 'erikkwilder', CLOUD_ADMIN_ID: '4242', CLOUD_DASHBOARD: 'https://app.example' };
  const signIn = async (state, user) => withFetch(async (url) => {
    if (url.includes('/login/oauth/access_token')) return jsonRes({ access_token: 'gho_x' });
    if (url === 'https://api.github.com/user') return jsonRes(user);
  }, async () => {
    const res = await worker.fetch(new Request(`https://worker.example/cloud/callback?code=c&state=${state}`, { headers: { Cookie: `__Host-kiln_signin=${state}` } }), env);
    return new URL(res.headers.get('Location')).hash.replace('#kc_token=', '');
  });
  const runbook = (token) => worker.fetch(new Request('https://worker.example/admin/cloud/runbook', { headers: { Authorization: `Bearer ${token}` } }), env);
  const operator = await signIn('n1', { login: 'erikkwilder', id: 4242 });
  assert.equal(JSON.parse(kv.map.get(`csess:${operator}`)).uid, 4242);
  const page = await runbook(operator);
  assert.equal(page.status, 200);
  // The playbook speaks of every part of the service the operator now runs, in a few of each part's own words.
  const text = await page.text();
  for (const words of [
    'Kiln Hosting', 'kiln-sites', 'kiln-converter',                         // the map
    '--env production', 'wrangler secret list', 'HOSTING_MEMBER_KEY',       // the switches and the secrets
    'Every five minutes', 'Every minute',                                   // the timers
    'Kiln no longer uses REPOSITORY', 'never sooner',                       // the notes to the operator
    'Kiln cannot confirm that inbox by itself', 'Transfer ownership',       // when a customer writes
    'firstseen:repo:', 'copied:', "SET status = 'trialing'",                // free days
    'Handing a domain over to a customer who leaves', 'Free this row', 'Switching renewal off by hand', 'REGISTER_DOMAINS',   // a new domain through Kiln (switched off)
    'Publish again', 'three more days', 'hosting_members_left_out',         // hosting
    'at most <strong>five</strong> previews', 'One known limit',            // previews
    'put_away', 'not_changed', 'Activity log',                              // own domains and email forwarding
    'Moving away', 'Download the domain\'s records',                        // leaving
    "GitHub's permanent number", 'docs/deleting-data.md',                   // accounts
    'npm run deploy:prod', 'GitHub 500', 'Retry deployment',                // releasing
    'wrangler rollback VERSION_ID', 'does not roll back with the code',     // rolling back
    'wrangler tail --env production', 'Worker exceeded memory limit',       // looking at what happened
    'Lemon Squeezy', 'While billing is not set up',                         // billing
    'Every day, in five minutes', 'Every week',                             // the two looks
    'Known gaps',
  ]) assert.ok(text.includes(words), `the playbook says nothing of "${words}"`);
  assert.equal(text.includes('—'), false, 'the playbook has an em dash in it');
  // Nothing in it runs, and nothing is loaded from another address.
  assert.equal(/<script|<link|<img|<iframe|src=|@import|url\(/i.test(text), false);
  // Every wrangler command that reaches a store, the database or the service names its environment.
  for (const line of text.split('\n').filter(l => /npx wrangler (kv|d1|secret|rollback|deployments|tail)/.test(l))) {
    assert.match(line, /--env (production|staging)/, `a command without its environment: ${line.trim().slice(0, 80)}`);
  }
  // The old username, registered by someone else: same login, different id.
  const squatter = await signIn('n2', { login: 'erikkwilder', id: 777 });
  assert.equal((await runbook(squatter)).status, 403);
  assert.equal((await runbook('no-such-session')).status, 403);
});
