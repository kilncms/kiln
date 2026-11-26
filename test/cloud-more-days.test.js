/**
 * Seven more free days for a site, at the operator's word: POST
 * /admin/cloud/grant with `more_days: true`, or with the status set to
 * `trialing` on a site whose days are over. A site's free days are counted
 * from the moment it was added (`created_at`), and the five-minute job closes
 * a site nobody pays for once seven days have passed since then
 * (expireStaleTrials). So what the operator gives has to move that moment, or
 * the job takes it back within five minutes. These check that it holds, that
 * only a site with no subscription is touched, and that only the operator can.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { moreFreeDays, expireStaleTrials, domainFreeDays } from '../worker/cloud.js';
import { fakeKV, withFetch } from './worker-harness.js';
import { cloudEnv, addSite, addAccount, d1Skip } from './d1-fake.js';

const DAY = 86400 * 1000;
const quiet = (fn) => withFetch(async () => undefined, fn);   // nothing outside the worker answers
const post = (env, path, body, token = 'tok') => worker.fetch(new Request(`https://worker.example${path}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), env);
const overview = async (env) => (await worker.fetch(new Request('https://worker.example/admin/cloud/overview', { headers: { Authorization: 'Bearer tok' } }), env)).json();
const row = (env, id = 'site-1') => ({ ...env.kiln_cloud.row('SELECT status, created_at, access_until, stripe_subscription_id FROM sites WHERE id = ?', id) });
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 5000;

function world() {
  const kv = fakeKV();
  const env = cloudEnv(kv, { CLOUD_ADMIN: 'ada' });
  // A customer Kiln has no address for: its own reminders cannot reach them.
  addAccount(env, { id: 'acct-uma', github_login: 'uma', created_at: Date.now() - 9 * DAY });
  kv.map.set('csess:tok-uma', JSON.stringify({ account_id: 'acct-uma', login: 'uma', uid: 202, gh: 'gho_u' }));
  return { env, kv };
}

test('a site whose free days are over gets seven full days from this moment, and the five-minute job leaves it open', { skip: d1Skip }, async () => {
  const { env, kv } = world();
  const added = Date.now() - 9 * DAY;
  addSite(env, { account_id: 'acct-uma', repo: 'uma/shop', origin: 'https://shop.example', status: 'canceled', created_at: added, prepared_at: 5, firstpass_at: 6 });
  kv.map.set('mail:trial-soon:site-1', '1'); kv.map.set('mail:trial-ended:site-1', '1'); kv.map.set('mail:trial-soon:other', '1');
  await quiet(async () => {
    const before = await overview(env);
    assert.deepEqual(before.needs_you.map(n => [n.kind, n.site_id, n.more_days]), [['trial_ended', 'site-1', true]]);
    const r = await post(env, '/admin/cloud/grant', { site_id: 'site-1', more_days: true });
    assert.equal(r.status, 200);
    const said = await r.json();
    assert.deepEqual({ ...said, trial_ends: 0 }, { ok: true, status: 'trialing', trial_ends: 0, days: 7 });
    assert.ok(near(said.trial_ends, Date.now() + 7 * DAY), 'seven days from now');
    const now = row(env);
    assert.equal(now.status, 'trialing');
    assert.ok(near(now.created_at, Date.now()), 'the days are counted from this moment');
    assert.equal(now.created_at + 7 * DAY, said.trial_ends);
    // What closed it before does not close it again.
    await expireStaleTrials(env);
    assert.equal(row(env).status, 'trialing');
    // Kiln's notes about the end of the days can go once more for the new end; another site's are left alone.
    assert.equal(kv.map.has('mail:trial-soon:site-1'), false);
    assert.equal(kv.map.has('mail:trial-ended:site-1'), false);
    assert.equal(kv.map.has('mail:trial-soon:other'), true);
    // The operator's page: the line is gone, and the site says when its days end.
    const after = await overview(env);
    assert.deepEqual(after.needs_you, []);
    const site = after.customers.find(c => c.id === 'acct-uma').sites[0];
    assert.equal(site.status, 'trialing');
    assert.equal(site.trial_ends, said.trial_ends);
    assert.equal(site.trial_ended, null);
  });
});

test('a site whose free days are still running has seven days added to their end, each time it is asked', { skip: d1Skip }, async () => {
  const { env } = world();
  const added = Date.now() - 5 * DAY;
  addSite(env, { account_id: 'acct-uma', status: 'trialing', created_at: added });
  await quiet(async () => {
    const one = await (await post(env, '/admin/cloud/grant', { site_id: 'site-1', more_days: true })).json();
    assert.equal(one.trial_ends, added + 14 * DAY, 'two days were left: now nine');
    assert.equal(row(env).created_at, added + 7 * DAY);
    const two = await (await post(env, '/admin/cloud/grant', { site_id: 'site-1', more_days: true })).json();
    assert.equal(two.trial_ends, added + 21 * DAY);
    assert.equal(row(env).status, 'trialing');
  });
});

test('only a site with no subscription has free days to add to, and a site that is not there is said to be so', { skip: d1Skip }, async () => {
  const { env } = world();
  const added = Date.now() - 20 * DAY;
  addSite(env, { account_id: 'acct-uma', status: 'past_due', stripe_subscription_id: 'sub_1', created_at: added, access_until: Date.now() + DAY });
  await quiet(async () => {
    const r = await post(env, '/admin/cloud/grant', { site_id: 'site-1', more_days: true });
    assert.equal(r.status, 409);
    const said = await r.json();
    assert.equal(said.code, 'subscribed');
    assert.match(said.error, /has a subscription, so it has no free days to add to/);
    assert.deepEqual(row(env), { status: 'past_due', created_at: added, access_until: row(env).access_until, stripe_subscription_id: 'sub_1' });
    assert.equal(row(env).created_at, added, 'nothing moved');
    const none = await post(env, '/admin/cloud/grant', { site_id: 'no-such-site', more_days: true });
    assert.equal(none.status, 404);
    assert.equal((await none.json()).code, 'no_such_site');
  });
});

test('setting a site to Trial holds: on a site whose days are over it starts seven days, on any other it sets the status alone', { skip: d1Skip }, async () => {
  const { env } = world();
  const over = Date.now() - 12 * DAY, running = Date.now() - 2 * DAY;
  addSite(env, { id: 'over', account_id: 'acct-uma', repo: 'uma/a', origin: 'https://a.example', status: 'canceled', created_at: over });
  addSite(env, { id: 'shut', account_id: 'acct-uma', repo: 'uma/b', origin: 'https://b.example', status: 'canceled', created_at: running });
  addSite(env, { id: 'paid', account_id: 'acct-uma', repo: 'uma/c', origin: 'https://c.example', status: 'canceled', created_at: over, stripe_subscription_id: 'sub_1' });
  await quiet(async () => {
    // Days over: without new days the job would close it again at its next run.
    assert.deepEqual({ ...(await (await post(env, '/admin/cloud/grant', { site_id: 'over', status: 'trialing' })).json()), trial_ends: 0 }, { ok: true, status: 'trialing', trial_ends: 0, days: 7 });
    assert.ok(near(row(env, 'over').created_at, Date.now()));
    // Shut by hand with days still left: open again, and its days end when they did.
    assert.deepEqual(await (await post(env, '/admin/cloud/grant', { site_id: 'shut', status: 'trialing' })).json(), { ok: true });
    assert.deepEqual([row(env, 'shut').status, row(env, 'shut').created_at], ['trialing', running]);
    // A site with a subscription: the status as the operator set it, and no date of its own moved.
    assert.deepEqual(await (await post(env, '/admin/cloud/grant', { site_id: 'paid', status: 'trialing' })).json(), { ok: true });
    assert.deepEqual([row(env, 'paid').status, row(env, 'paid').created_at], ['trialing', over]);
    await expireStaleTrials(env);
    assert.equal(row(env, 'over').status, 'trialing', 'the operator\'s word held');
    assert.equal(row(env, 'shut').status, 'trialing');
    // The other statuses are set as they always were, and a word that is no status is refused.
    assert.deepEqual(await (await post(env, '/admin/cloud/grant', { site_id: 'over', status: 'active' })).json(), { ok: true });
    assert.equal(row(env, 'over').status, 'active');
    assert.equal((await post(env, '/admin/cloud/grant', { site_id: 'over', status: 'free' })).status, 400);
    assert.equal((await post(env, '/admin/cloud/grant', { site_id: 'over' })).status, 400);
  });
});

test('nobody but the operator gives free days, to their own site or anyone\'s', { skip: d1Skip }, async () => {
  const { env } = world();
  const added = Date.now() - 9 * DAY;
  addSite(env, { account_id: 'acct-uma', status: 'canceled', created_at: added });
  await quiet(async () => {
    for (const token of ['tok-uma', 'nobody']) {
      for (const body of [{ site_id: 'site-1', more_days: true }, { site_id: 'site-1', status: 'trialing' }]) {
        const r = await post(env, '/admin/cloud/grant', body, token);
        assert.ok(r.status === 403 || r.status === 404, `${token} ${JSON.stringify(body)} answered ${r.status}`);
      }
    }
  });
  assert.deepEqual([row(env).status, row(env).created_at], ['canceled', added]);
});

test('by itself: null for a plain status change that needs no new days, and the marks that stop free days starting again are left alone', { skip: d1Skip }, async () => {
  const { env, kv } = world();
  const running = Date.now() - DAY;
  addSite(env, { account_id: 'acct-uma', status: 'trialing', created_at: running });
  kv.map.set('firstseen:https://club.example', String(running));
  assert.equal(await moreFreeDays(env, 'site-1'), null);
  assert.equal(await moreFreeDays(env, 'no-such-site'), null);
  assert.equal(row(env).created_at, running);
  const given = await moreFreeDays(env, 'site-1', { always: true, now: running + 2 * DAY });
  assert.equal(given.status, 200);
  assert.equal(given.body.trial_ends, running + 14 * DAY);
  assert.equal(kv.map.get('firstseen:https://club.example'), String(running));
});

test('the operator can hide a line that carries its day, and it is that day\'s line alone that stays hidden', { skip: d1Skip }, async () => {
  const { env } = world();
  addSite(env, { account_id: 'acct-uma', status: 'canceled', created_at: Date.now() - 9 * DAY, prepared_at: 5, firstpass_at: 6 });
  await quiet(async () => {
    const [line] = (await overview(env)).needs_you;
    assert.match(line.key, /^trial_ended:acct-uma:site-1:\d{13}$/);
    assert.equal((await post(env, '/admin/cloud/needs/hide', { key: line.key })).status, 200);
    assert.deepEqual((await overview(env)).needs_you, []);
    // Days are given and run out again: that is another day, and a new line.
    await post(env, '/admin/cloud/grant', { site_id: 'site-1', more_days: true });
    env.kiln_cloud.exec("UPDATE sites SET status = 'canceled', created_at = ? WHERE id = 'site-1'", Date.now() - 8 * DAY);
    const again = (await overview(env)).needs_you;
    assert.deepEqual(again.map(n => n.kind), ['trial_ended']);
    assert.notEqual(again[0].key, line.key);
    // A key that is not a line's is refused as before.
    assert.equal((await post(env, '/admin/cloud/needs/hide', { key: 'trial_ended:acct-uma:site-1:not-a-day' })).status, 400);
    assert.equal((await post(env, '/admin/cloud/needs/hide', { key: 'trial_ended:acct-uma:site-1:1:2' })).status, 400);
  });
});

test('a site on a domain of its own keeps the days it was given: the domain\'s own mark moves with them', { skip: d1Skip }, async () => {
  const { env, kv } = world();
  const added = Date.now() - 9 * DAY;
  addSite(env, { account_id: 'acct-uma', repo: 'uma/shop', origin: 'https://www.oakbakery.test', plan: 'managed', status: 'canceled', created_at: added });
  env.kiln_cloud.exec("INSERT INTO domains (site_id, name, zone_id, state, created_at, updated_at) VALUES ('site-1', 'oakbakery.test', 'z1', 'live', 1, 1)");
  kv.map.set('firstseen:domain:oakbakery.test', String(added));   // written when the site went live there, in its first days
  kv.map.set('firstseen:domain:other.test', String(added));
  const given = await moreFreeDays(env, 'site-1', { always: true });
  assert.equal(given.status, 200);
  const from = row(env).created_at;
  assert.equal(kv.map.get('firstseen:domain:oakbakery.test'), String(from), 'the domain is counted from the same moment as the site');
  assert.equal(kv.map.get('firstseen:domain:other.test'), String(added), 'another domain is not touched');
  // Setting the domain up again, or going live on it, no longer takes the days back.
  assert.equal(await domainFreeDays(env, 'site-1', 'oakbakery.test'), null);
  assert.equal(await domainFreeDays(env, 'site-1', 'oakbakery.test', { goesLive: true }), null);
  assert.deepEqual([row(env).status, row(env).created_at], ['trialing', from]);
  // A mark is never moved back: days given while a later mark stands leave it.
  kv.map.set('firstseen:domain:oakbakery.test', String(from + 30 * DAY));
  await moreFreeDays(env, 'site-1', { always: true });
  assert.equal(kv.map.get('firstseen:domain:oakbakery.test'), String(from + 30 * DAY));
});
