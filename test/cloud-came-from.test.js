/**
 * Where a person came from: the campaign tags of the link they followed to
 * Kiln (utm_source, utm_medium, utm_campaign), kept on their account once, in
 * its first hour, and only while the service's CAMPAIGN_TAGS setting is "on".
 * The operator's overview answers them per customer as `came_from`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { campaignTags } from '../worker/cloud.js';
import { fakeKV, withFetch } from './worker-harness.js';
import { cloudEnv, addAccount, schemaFiles, d1Skip } from './d1-fake.js';

const TAGS = { utm_source: 'reddit', utm_medium: 'paid', utm_campaign: 'ai-sites-1' };
const post = (env, body, token = 'tok-new') => worker.fetch(new Request('https://worker.example/cloud/account/came-from', {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), env);
const tagsOf = (env, id) => ({ ...env.kiln_cloud.row('SELECT utm_source, utm_medium, utm_campaign FROM accounts WHERE id = ?', id) });
const quiet = (fn) => withFetch(async () => undefined, fn);

function world(extra = {}, d1 = undefined) {
  const kv = fakeKV();
  const env = cloudEnv(kv, { CLOUD_ADMIN: 'ada', ...(d1 ? { d1 } : {}), ...extra });
  addAccount(env, { id: 'acct-new', email: 'new@example.com', created_at: Date.now() - 60 * 1000 });
  kv.map.set('csess:tok-new', JSON.stringify({ account_id: 'acct-new', login: 'newbie', uid: 9, gh: 'gho_n' }));
  addAccount(env, { id: 'acct-old', email: 'old@example.com', created_at: Date.now() - 2 * 3600 * 1000 });
  kv.map.set('csess:tok-old', JSON.stringify({ account_id: 'acct-old', login: 'oldie', uid: 8, gh: 'gho_o' }));
  return { env, kv };
}

test('tags are trimmed, kept only when they are plain words, and anything else is left out', () => {
  assert.deepEqual(campaignTags(TAGS), { source: 'reddit', medium: 'paid', campaign: 'ai-sites-1' });
  assert.deepEqual(campaignTags({ source: ' google ', campaign: 'leave wp 1' }), { source: 'google', medium: null, campaign: 'leave wp 1' });
  assert.equal(campaignTags({ utm_source: '<script>' }), null);
  assert.equal(campaignTags({ utm_source: 'x'.repeat(81) }), null);
  assert.deepEqual(campaignTags({ utm_source: 'ok', utm_medium: 'a"b' }), { source: 'ok', medium: null, campaign: null });
  assert.equal(campaignTags({}), null);
  assert.equal(campaignTags(null), null);
  assert.equal(campaignTags({ utm_source: 42 }), null);
});

test('with the setting off, nothing is kept, whatever is sent', { skip: d1Skip }, async () => {
  const { env } = world();
  await quiet(async () => {
    const r = await post(env, TAGS);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, recorded: false, reason: 'off' });
  });
  assert.deepEqual(tagsOf(env, 'acct-new'), { utm_source: null, utm_medium: null, utm_campaign: null });
});

test('with the setting on: kept once on a new account, never on an old one, never over what is there', { skip: d1Skip }, async () => {
  const { env } = world({ CAMPAIGN_TAGS: 'on' });
  await quiet(async () => {
    assert.deepEqual(await (await post(env, TAGS)).json(), { ok: true, recorded: true });
    assert.deepEqual(tagsOf(env, 'acct-new'), { utm_source: 'reddit', utm_medium: 'paid', utm_campaign: 'ai-sites-1' });
    assert.deepEqual(await (await post(env, { utm_source: 'google', utm_campaign: 'other' })).json(), { ok: true, recorded: false }, 'the first tags stay');
    assert.equal(tagsOf(env, 'acct-new').utm_source, 'reddit');
    assert.deepEqual(await (await post(env, TAGS, 'tok-old')).json(), { ok: true, recorded: false }, 'an account more than an hour old is not described by today\'s link');
    assert.deepEqual(tagsOf(env, 'acct-old'), { utm_source: null, utm_medium: null, utm_campaign: null });
    assert.deepEqual(await (await post(env, { utm_source: '<b>' }, 'tok-old')).json(), { ok: true, recorded: false, reason: 'none' });
    assert.equal((await post(env, TAGS, null)).status, 401);
    assert.equal((await post(env, TAGS, 'nobody')).status, 401);
  });
  // Nobody else's account was written.
  assert.deepEqual(tagsOf(env, 'acct-1'), { utm_source: null, utm_medium: null, utm_campaign: null });
});

test('the overview answers where each customer came from', { skip: d1Skip }, async () => {
  const { env } = world({ CAMPAIGN_TAGS: 'on' });
  await quiet(async () => {
    await post(env, TAGS);
    const o = await (await worker.fetch(new Request('https://worker.example/admin/cloud/overview', { headers: { Authorization: 'Bearer tok' } }), env)).json();
    const by = Object.fromEntries(o.customers.map(c => [c.id, c]));
    assert.deepEqual(by['acct-new'].came_from, { source: 'reddit', medium: 'paid', campaign: 'ai-sites-1' });
    assert.equal(by['acct-old'].came_from, null);
  });
});

test('on a database migration 0021 has not reached, nothing is kept and the overview still answers', { skip: d1Skip }, async () => {
  const before0021 = schemaFiles().findIndex(f => f.includes('0021_'));
  assert.ok(before0021 > 0);
  const { env } = world({ CAMPAIGN_TAGS: 'on' }, { upTo: before0021 });
  await quiet(async () => {
    assert.deepEqual(await (await post(env, TAGS)).json(), { ok: true, recorded: false, reason: 'not_ready' });
    const o = await (await worker.fetch(new Request('https://worker.example/admin/cloud/overview', { headers: { Authorization: 'Bearer tok' } }), env)).json();
    assert.equal(o.customers.length, 3);
    assert.ok(o.customers.every(c => c.came_from === null));
  });
});

test('when the database cannot write just now the answer is not a yes, so the dashboard keeps the tags for its next load', { skip: d1Skip }, async () => {
  const { env } = world({ CAMPAIGN_TAGS: 'on' });
  const real = env.kiln_cloud;
  let fail = 'D1_ERROR: the storage operation timed out';
  env.kiln_cloud = new Proxy(real, { get: (d, k) => (k === 'prepare' ? (sql) => { if (/SET utm_source/.test(sql)) throw new Error(fail); return d.prepare(sql); } : d[k]) });
  await quiet(async () => {
    const r = await post(env, TAGS);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, 'try_again');
    // A database the columns have not reached is another matter: asking again would not help, and the answer says so.
    fail = 'D1_ERROR: no such column: utm_source';
    assert.deepEqual(await (await post(env, TAGS)).json(), { ok: true, recorded: false, reason: 'not_ready' });
  });
  env.kiln_cloud = real;
  assert.deepEqual(tagsOf(env, 'acct-new'), { utm_source: null, utm_medium: null, utm_campaign: null });
});
