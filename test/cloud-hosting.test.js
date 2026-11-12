/**
 * Kiln hosting a site (the Kiln Cloud + hosting plan): switching it on from
 * the dashboard, publishing again when GitHub says the repository changed, the
 * five-minute sweep that catches what was missed, editing at the temporary
 * address, and taking a site down (worker/hosted.js, worker/hosting.js, the
 * routes in worker/cloud.js and /gh/webhook in worker/index.js). The real
 * handlers run over the SQLite-backed D1 stand-in, an in-memory GitHub and an
 * in-memory Cloudflare. Nothing here touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../worker/index.js';
import { fakeKV, withFetch, githubWrites } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';
import { fakeGitHub } from './github-fake.js';
import { fakeCloudflare } from './cloudflare-fake.js';
import { cloudSiteForOrigin, hostingEndsAt, hostingEndReason } from '../worker/cloud.js';
import { dayWords } from '../worker/mail.js';

const SECRET = 'whsec-github';
const pages = { 'index.html': '<!doctype html><h1>Home</h1>', 'about.html': '<!doctype html><h1>About</h1>', 'assets/site.css': 'h1{}' };
const URL_1 = 'https://club-site1.kiln-sites.workers.dev';

function world(files = pages, { site = {}, env: extra = {}, kv: seed = {} } = {}) {
  const gh = fakeGitHub({ repo: 'ada/club', files });
  const cf = fakeCloudflare();
  const env = cloudEnv(fakeKV({ 'itok:ada/club': 'inst-token', ...seed }), {
    HOSTING_ACCOUNT_ID: cf.account, HOSTING_API_TOKEN: cf.token, HOSTING_SUBDOMAIN: 'kiln-sites', GH_WEBHOOK_SECRET: SECRET, ...extra,
  });
  addSite(env, { id: 'site1', plan: 'managed', status: 'trialing', ...site });
  // These tests are about the copying. What Kiln does to a repository before a
  // site's first copy is in cloud-lookafter.test.js; here the first pass is on
  // record and the release is out of reach, so the repository is only read.
  try { env.kiln_cloud.exec("UPDATE sites SET firstpass_at = 1 WHERE id = 'site1'"); } catch { /* a database before migration 0004 */ }
  const handler = async (url, init) => (await cf.handler(url, init)) || gh.handler(url, init);
  return { gh, cf, env, handler };
}
const ask = (env, method, pathname, body, token = 'tok') => worker.fetch(new Request(`https://worker.example${pathname}`, {
  method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}), env);
const switchOn = (env, id = 'site1') => ask(env, 'POST', '/cloud/sites/hosting', { id });
const standing = async (env, id = 'site1') => (await (await ask(env, 'GET', `/cloud/sites/hosting?site=${id}`)).json());
const row = (env, id = 'site1') => env.kiln_cloud.row('SELECT * FROM hosting WHERE site_id = ?', id);
const served = (w, path, name = 'club-site1') => w.cf.serve(name, path)?.bytes.toString() ?? null;
/** A push notice as GitHub sends it, signed with `secret`. */
function notice(w, { ref = 'refs/heads/main', repo = 'ada/club', secret = SECRET, event = 'push', after = w.gh.head(), deleted = false, ctx } = {}) {
  const body = JSON.stringify({ ref, after, deleted, repository: { full_name: repo, default_branch: 'main' } });
  const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return worker.fetch(new Request('https://worker.example/gh/webhook', { method: 'POST', headers: { 'X-GitHub-Event': event, 'X-Hub-Signature-256': sig, 'Content-Type': 'application/json' }, body }), w.env, ctx);
}
const sweep = (env) => worker.scheduled({}, env);

test('hosting: the owner switches it on, the site is up at a temporary address, and the dashboard knows', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async (calls) => {
    assert.deepEqual(await standing(w.env), { ok: true, available: true, on_plan: true, hosting: null });
    const res = await switchOn(w.env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual({ state: body.hosting.state, url: body.hosting.url, commit: body.hosting.commit, files: body.hosting.files }, { state: 'live', url: URL_1, commit: w.gh.head(), files: 3 });
    assert.ok(body.hosting.deployed_at > 0);
    assert.deepEqual(githubWrites(calls), [], 'the repository is only read');
    const me = await (await ask(w.env, 'GET', '/cloud/me')).json();
    assert.equal(me.hosting, true);
    assert.equal(me.sites[0].hosting.state, 'live');
    assert.equal(me.sites[0].hosting.url, URL_1);
    assert.equal((await standing(w.env)).hosting.state, 'live');
  });
  assert.equal(served(w, '/index.html'), pages['index.html']);
  assert.equal(w.cf.scripts.get('club-site1').address, true);
  assert.equal(row(w.env).name, 'club-site1');
  assert.equal(await w.env.KILN.get('hostlock:site1'), null);
});

test('hosting: it is part of the hosting plan, of a service that hosts, and of the first few sites until one is paid for', { skip: d1Skip }, async () => {
  let w = world(pages, { site: { plan: 'cloud' } });
  await withFetch(w.handler, async (calls) => {
    assert.equal((await standing(w.env)).on_plan, false);
    const res = await switchOn(w.env);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'not_on_plan');
    assert.match(body.error, /Kiln Cloud \+ hosting plan/);
    assert.deepEqual(calls, []);
  });
  // A service with no hosting account: the dashboard is told, and nothing is tried.
  w = world(pages, { env: { HOSTING_API_TOKEN: '' } });
  await withFetch(w.handler, async (calls) => {
    assert.deepEqual(await standing(w.env), { ok: true, available: false, on_plan: true, hosting: null });
    const res = await switchOn(w.env);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'not_set_up');
    assert.equal((await (await ask(w.env, 'GET', '/cloud/me')).json()).hosting, false);
    assert.equal(calls.filter(c => c.url.includes('cloudflare')).length, 0);
  });
  // Not signed in, and somebody else's site.
  w = world();
  await withFetch(w.handler, async () => {
    assert.equal((await ask(w.env, 'POST', '/cloud/sites/hosting', { id: 'site1' }, 'nobody')).status, 401);
    assert.equal((await switchOn(w.env, 'nope')).status, 404);
  });
  // Two hosted sites during the free days, a third only once something is paid for.
  w = world();
  for (const n of [2, 3]) { addSite(w.env, { id: `site${n}`, plan: 'managed', status: 'trialing', repo: 'ada/club', origin: `https://club${n}.example` }); }
  await withFetch(w.handler, async () => {
    assert.equal((await switchOn(w.env, 'site1')).status, 200);
    assert.equal((await switchOn(w.env, 'site2')).status, 200);
    const third = await switchOn(w.env, 'site3');
    assert.equal(third.status, 403);
    const body = await third.json();
    assert.equal(body.code, 'free_limit');
    assert.match(body.error, /During the free days Kiln hosts 2 sites/);
    assert.equal(w.cf.scripts.size, 2);
    assert.equal((await switchOn(w.env, 'site1')).status, 200, 'publishing a site that is already up again is not a new site');
    w.env.kiln_cloud.exec("UPDATE sites SET ls_subscription_id = '77', status = 'active' WHERE id = 'site1'");
    assert.equal((await switchOn(w.env, 'site3')).status, 200);
  });
});

test('hosting: a repository that cannot be a website yet is told why, and goes up by itself once it can', { skip: d1Skip }, async () => {
  const w = world({ 'README.md': '# soon' });
  await withFetch(w.handler, async () => {
    const res = await switchOn(w.env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'no_home');
    assert.match(body.error, /no home page \(a file named index\.html\)/);
    assert.equal(body.hosting.state, 'waiting');
    assert.equal(w.cf.scripts.size, 0);
    w.gh.commit({ 'index.html': '<h1>Now there is one</h1>' });
    await sweep(w.env);
  });
  assert.equal(row(w.env).state, 'live');
  assert.equal(served(w, '/index.html'), '<h1>Now there is one</h1>');
});

test('hosting: when GitHub says the repository changed, the site is published again', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async (calls) => {
    await switchOn(w.env);
    w.gh.commit({ 'about.html': '<!doctype html><h1>About us</h1>' });
    const n = calls.length;
    const res = await notice(w);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, published: 1 });
    assert.equal(calls.slice(n).filter(c => /assets\/upload/.test(c.url)).length, 1, 'only the changed page is sent');
  });
  assert.equal(served(w, '/about.html'), '<!doctype html><h1>About us</h1>');
  assert.equal(row(w.env).commit_sha, w.gh.head());

  // The same notice again (GitHub delivers twice at times) copies nothing.
  await withFetch(w.handler, async (calls) => {
    assert.deepEqual(await (await notice(w)).json(), { ok: true, published: 0 });
    assert.equal(calls.filter(c => c.url.includes('cloudflare')).length, 0);
  });
  // On the real service the answer goes back at once and the copying carries on after it.
  w.gh.commit({ 'index.html': '<!doctype html><h1>Home, again</h1>' });
  await withFetch(w.handler, async () => {
    const later = [];
    const res = await notice(w, { ctx: { waitUntil: (p) => later.push(p) } });
    assert.equal(res.status, 202);
    assert.equal(later.length, 1);
    assert.equal(await later[0], 1);
  });
  assert.equal(served(w, '/index.html'), '<!doctype html><h1>Home, again</h1>');
});

test('hosting: a notice is acted on only when GitHub signed it, and only for the branch the site is made from', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async (calls) => {
    await switchOn(w.env);
    w.gh.commit({ 'index.html': '<!doctype html><h1>Changed</h1>' });
    const n = calls.length;
    const forged = await notice(w, { secret: 'guess' });
    assert.equal(forged.status, 401);
    const unsigned = await worker.fetch(new Request('https://worker.example/gh/webhook', { method: 'POST', headers: { 'X-GitHub-Event': 'push' }, body: '{}' }), w.env);
    assert.equal(unsigned.status, 401);
    for (const [why, opts] of Object.entries({
      'another branch': { ref: 'refs/heads/draft' },
      'a tag': { ref: 'refs/tags/v1' },
      'a branch being deleted': { deleted: true },
      'another kind of event': { event: 'installation' },
      'a repository Kiln does not host': { repo: 'bob/elsewhere' },
      'a name that is not a repository': { repo: '../../etc' },
    })) {
      const res = await notice(w, opts);
      assert.equal(res.status, 200, why);
      const body = await res.json();
      assert.ok(body.ignored || body.published === 0, why);
    }
    assert.equal(calls.slice(n).filter(c => c.url.includes('cloudflare')).length, 0, 'none of these copied anything');
  });
  assert.equal(served(w, '/index.html'), pages['index.html']);
  // A service with no webhook secret has no such route at all.
  const off = world(pages, { env: { GH_WEBHOOK_SECRET: '' } });
  await withFetch(off.handler, async () => assert.equal((await notice(off)).status, 404));
});

test('hosting: the five-minute sweep publishes what a notice never announced, retries what failed, and leaves a site that may not be edited', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await switchOn(w.env);
    // A change with no notice.
    w.gh.commit({ 'index.html': '<!doctype html><h1>Quiet change</h1>' });
    await sweep(w.env);
    assert.equal(served(w, '/index.html'), '<!doctype html><h1>Quiet change</h1>');
    // A copy that fails is kept as it was, said so, and tried again later.
    w.gh.commit({ 'index.html': '<!doctype html><h1>Third</h1>' });
    w.cf.failOn((method) => method === 'PUT');
    const res = await notice(w);
    assert.deepEqual(await res.json(), { ok: true, published: 0 });
    assert.equal(row(w.env).state, 'failed');
    assert.equal(served(w, '/index.html'), '<!doctype html><h1>Quiet change</h1>', 'visitors still get the site as it was');
    const shown = (await standing(w.env)).hosting;
    assert.equal(shown.serving, true);
    assert.match(shown.error, /The site is as it was\. Kiln tries again by itself/);
    w.cf.failOn(null);
    await sweep(w.env);
    assert.equal(served(w, '/index.html'), '<!doctype html><h1>Third</h1>', 'the commit the notice named is published at the next sweep');
    assert.equal(row(w.env).state, 'live');
    assert.equal(row(w.env).wanted_sha, null);
    // A site whose free days ran out is not published any more.
    w.env.kiln_cloud.exec("UPDATE sites SET status = 'canceled' WHERE id = 'site1'");
    w.gh.commit({ 'index.html': '<!doctype html><h1>After the trial</h1>' });
    await sweep(w.env);
    assert.deepEqual(await (await notice(w)).json(), { ok: true, published: 0 });
    assert.equal(served(w, '/index.html'), '<!doctype html><h1>Third</h1>');
  });
});

test('hosting: a change that arrives while a copy is running is not lost', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await switchOn(w.env);
    w.gh.commit({ 'index.html': '<!doctype html><h1>While busy</h1>' });
    await w.env.KILN.put('hostlock:site1', '1');
    assert.deepEqual(await (await notice(w)).json(), { ok: true, published: 0 });
    assert.equal(row(w.env).wanted_sha, w.gh.head(), 'the commit is remembered');
    const busy = await switchOn(w.env);
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).code, 'busy');
    await w.env.KILN.delete('hostlock:site1');
    await sweep(w.env);
  });
  assert.equal(served(w, '/index.html'), '<!doctype html><h1>While busy</h1>');
  assert.equal(row(w.env).wanted_sha, null);
});

test('hosting: the site can be edited at its temporary address while it may be edited at all', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => { await switchOn(w.env); });
  assert.equal((await cloudSiteForOrigin(w.env, URL_1))?.repo, 'ada/club');
  assert.equal((await cloudSiteForOrigin(w.env, 'https://club.example'))?.repo, 'ada/club', 'its own address works as before');
  assert.equal(await cloudSiteForOrigin(w.env, 'https://club-other.kiln-sites.workers.dev'), null);
  w.env.kiln_cloud.exec("UPDATE sites SET status = 'canceled' WHERE id = 'site1'");
  assert.equal(await cloudSiteForOrigin(w.env, URL_1), null, 'not after the free days ran out');
});

test('hosting: removing a site takes it down, and a take-down Cloudflare did not answer is finished by the sweep', { skip: d1Skip }, async () => {
  let w = world();
  await withFetch(w.handler, async () => {
    await switchOn(w.env);
    const res = await ask(w.env, 'POST', '/cloud/sites/remove', { id: 'site1' });
    assert.equal(res.status, 200);
  });
  assert.equal(w.cf.scripts.size, 0);
  assert.equal(row(w.env), null);

  w = world();
  await withFetch(w.handler, async () => {
    await switchOn(w.env);
    w.cf.failOn((method) => method === 'DELETE');
    assert.equal((await ask(w.env, 'POST', '/cloud/sites/remove', { id: 'site1' })).status, 200, 'the site is removed from the account all the same');
    assert.equal(row(w.env).state, 'removing');
    assert.equal(w.cf.scripts.size, 1);
    assert.equal((await (await ask(w.env, 'GET', '/cloud/me')).json()).sites.length, 0);
    w.cf.failOn(null);
    await sweep(w.env);
  });
  assert.equal(w.cf.scripts.size, 0);
  assert.equal(row(w.env), null);
});

test('hosting: on a database the migration has not reached, the dashboard and sign-in work as before', { skip: d1Skip }, async () => {
  const w = world(pages, { env: { d1: { upTo: 4 } } });
  await withFetch(w.handler, async () => {
    const me = await ask(w.env, 'GET', '/cloud/me');
    assert.equal(me.status, 200);
    assert.equal((await me.json()).sites[0].hosting, null);
    assert.equal((await standing(w.env)).hosting, null);
    assert.equal((await cloudSiteForOrigin(w.env, 'https://club.example'))?.repo, 'ada/club');
    assert.equal(await cloudSiteForOrigin(w.env, URL_1), null);
    const res = await switchOn(w.env);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /could not put the new files up/);
    await sweep(w.env);
    assert.equal((await notice(w)).status, 200);
  });
});

test('hosting: a hosted site whose free days ran out unpaid comes down three days later, and subscribing puts it back', { skip: d1Skip }, async () => {
  const day = 86400 * 1000;
  const w = world();
  await withFetch(w.handler, async () => {
    await switchOn(w.env);
    // The trial ran out a day ago: the site is still up.
    w.env.kiln_cloud.exec("UPDATE sites SET status = 'canceled', created_at = ? WHERE id = 'site1'", Date.now() - 8 * day);
    await sweep(w.env);
    assert.equal(w.cf.scripts.size, 1, 'one day after the trial');
    assert.equal(row(w.env).state, 'live');
    // The dashboard is given the day it comes down: ten days after the site was added.
    const added = w.env.kiln_cloud.row('SELECT created_at FROM sites WHERE id = ?', 'site1').created_at;
    assert.equal((await standing(w.env)).hosting.ends_at, added + 10 * day);
    assert.equal((await (await ask(w.env, 'GET', '/cloud/me')).json()).sites[0].hosting.ends_at, added + 10 * day);
    // Four days ago: it comes down, and the record says why.
    w.env.kiln_cloud.exec("UPDATE sites SET created_at = ? WHERE id = 'site1'", Date.now() - 11 * day);
    await sweep(w.env);
    assert.equal(w.cf.scripts.size, 0, 'four days after the trial');
    assert.equal(row(w.env).state, 'ended');
    assert.equal(row(w.env).reason, 'trial_ended');
    await sweep(w.env);
    assert.equal(w.cf.scripts.size, 0, 'and it is not put back by the sweep');
    // Subscribed: the owner puts it up again, and its address is switched on again.
    w.env.kiln_cloud.exec("UPDATE sites SET status = 'active', ls_subscription_id = '77' WHERE id = 'site1'");
    const shown = (await standing(w.env)).hosting;
    assert.equal(shown.state, 'ended');
    assert.match(shown.error, /because the free days ran out\. Your repository is untouched\./);
    const res = await switchOn(w.env);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).hosting.state, 'live');
  });
  assert.equal(w.cf.scripts.get('club-site1').address, true);
  assert.equal(served(w, '/index.html'), pages['index.html']);

  // A site that was paid for and then cancelled is on another clock (the next
  // tests): twenty days after its paid time ran out it is still up.
  const p = world(pages, { site: { ls_subscription_id: '77', status: 'active' } });
  await withFetch(p.handler, async () => {
    await switchOn(p.env);
    p.env.kiln_cloud.exec("UPDATE sites SET status = 'canceled', access_until = ?, created_at = ? WHERE id = 'site1'", Date.now() - 20 * day, Date.now() - 60 * day);
    await sweep(p.env);
  });
  assert.equal(p.cf.scripts.size, 1);
});


test('hosting: a site that was paid for comes down thirty days after its plan ended, and subscribing again puts it back', { skip: d1Skip }, async () => {
  const day = 86400 * 1000;
  const w = world(pages, { site: { ls_subscription_id: '77', status: 'active', created_at: Date.now() - 200 * day } });
  const stopped = (status, until) => w.env.kiln_cloud.exec("UPDATE sites SET status = ?, access_until = ? WHERE id = 'site1'", status, until);
  const me = async () => (await (await ask(w.env, 'GET', '/cloud/me')).json()).sites[0];
  await withFetch(w.handler, async () => {
    await switchOn(w.env);
    // Cancelled and still paid up: nothing is on its way down, and nothing says so.
    stopped('canceled', Date.now() + 3 * day);
    await sweep(w.env);
    assert.equal(row(w.env).state, 'live');
    assert.equal('ends_at' in (await standing(w.env)).hosting, false);
    assert.equal('ends_at' in (await me()).hosting, false);
    // Its paid time ran out 29 days ago: still up, not published any more, and the dashboard is given the day.
    const until = Date.now() - 29 * day;
    stopped('canceled', until);
    w.gh.commit({ 'index.html': '<!doctype html><h1>After the plan</h1>' });
    await sweep(w.env);
    assert.equal(w.cf.scripts.size, 1, '29 days after the plan ended');
    assert.equal(row(w.env).state, 'live');
    assert.equal(served(w, '/index.html'), pages['index.html']);
    assert.equal((await standing(w.env)).hosting.ends_at, until + 30 * day);
    const mine = await me();
    assert.equal(mine.editable, false);
    assert.equal(mine.hosting.ends_at, until + 30 * day);
    assert.equal('ls_subscription_id' in mine, false, 'the subscription is still not handed to the browser');
    // Paid again in time: it is not on its way down any more.
    stopped('active', null);
    await sweep(w.env);
    assert.equal(w.cf.scripts.size, 1);
    assert.equal('ends_at' in (await standing(w.env)).hosting, false);
    // Active again with an old date still on its row: left alone all the same.
    stopped('active', Date.now() - 90 * day);
    await sweep(w.env);
    assert.equal(row(w.env).state, 'live');
    // 31 days ago: it comes down, and the record says why.
    const over = Date.now() - 31 * day;
    stopped('canceled', over);
    await sweep(w.env);
    assert.equal(w.cf.scripts.size, 0, '31 days after the plan ended');
    assert.deepEqual({ state: row(w.env).state, reason: row(w.env).reason, deployed_at: row(w.env).deployed_at }, { state: 'ended', reason: 'plan_ended', deployed_at: null });
    const down = (await standing(w.env)).hosting;
    assert.equal(down.state, 'ended');
    assert.equal(down.error, `Kiln took this site down from its hosting because its plan ended on ${dayWords(over)}. Your repository still has everything. To put the site back, subscribe again and then press the button to put it up.`);
    assert.equal('ends_at' in down, false, 'a site that is down has no day to come down on');
    assert.equal(/[—–]|!/.test(down.error), false);
    await sweep(w.env);
    assert.equal(w.cf.scripts.size, 0, 'and it is not put back by the sweep');
    // Subscribed again: the sweep still leaves it, and its owner puts it up with the button.
    stopped('active', null);
    await sweep(w.env);
    assert.equal(w.cf.scripts.size, 0);
    assert.match((await standing(w.env)).hosting.error, /because its plan ended\. Your repository still has everything\./);
    const res = await switchOn(w.env);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).hosting.state, 'live');
  });
  assert.equal(w.cf.scripts.get('club-site1').address, true);
  assert.equal(served(w, '/index.html'), '<!doctype html><h1>After the plan</h1>');

  // A payment that failed, and whose grace ran out 31 days ago, ends the same way.
  const f = world(pages, { site: { ls_subscription_id: '78', status: 'active' } });
  await withFetch(f.handler, async () => {
    await switchOn(f.env);
    f.env.kiln_cloud.exec("UPDATE sites SET status = 'past_due', access_until = ? WHERE id = 'site1'", Date.now() - 31 * day);
    await sweep(f.env);
  });
  assert.equal(f.cf.scripts.size, 0);
  assert.equal(row(f.env).reason, 'plan_ended');
});

test('hosting: a paid site with no day on record is left up, and the operator is told once', { skip: d1Skip }, async () => {
  const day = 86400 * 1000;
  const notes = [];
  const w = world(pages, {
    site: { ls_subscription_id: '77', status: 'active', created_at: Date.now() - 200 * day },
    env: { NOTIFY: { send: async (m) => { notes.push(m); } }, NOTIFY_TO: 'ops@example.com' },
  });
  const told = () => notes.filter(m => /no end date/.test(m.raw));
  await withFetch(w.handler, async () => {
    await switchOn(w.env);
    notes.length = 0;
    w.env.kiln_cloud.exec("UPDATE sites SET status = 'canceled', access_until = NULL WHERE id = 'site1'");
    await sweep(w.env);
    await sweep(w.env);
    assert.equal(w.cf.scripts.size, 1, 'not taken down by guesswork');
    assert.equal(row(w.env).state, 'live');
    assert.equal('ends_at' in (await standing(w.env)).hosting, false);
    assert.equal(told().length, 1, 'told once, not at every sweep');
    assert.match(told()[0].raw, /Subject: Kiln: 1 hosted site with a plan that ended and no end date/);
    assert.match(told()[0].raw, /ada\/club \(https:\/\/club\.example\), status canceled/);
    assert.equal(await w.env.KILN.get('hostnodate:site1:77') !== null, true);
    // Subscribed anew and ended again with no day: that is another ending, and it is said again.
    w.env.kiln_cloud.exec("UPDATE sites SET status = 'past_due', ls_subscription_id = '99' WHERE id = 'site1'");
    await sweep(w.env);
    await sweep(w.env);
    assert.equal(told().length, 2);
    assert.equal(w.cf.scripts.size, 1);
  });
});

test('hosting: when a hosted site comes down, in so many words', () => {
  const day = 86400 * 1000, now = Date.UTC(2026, 10, 12, 12);
  const paid = { ls_subscription_id: '77', created_at: now - 300 * day };
  // a trial nobody subscribed for: ten days after it was added, as before
  assert.equal(hostingEndsAt({ status: 'canceled', created_at: now - 8 * day }, now), now + 2 * day);
  assert.equal(hostingEndsAt({ status: 'trialing', created_at: now - 3 * day }, now), null);
  assert.equal(hostingEndReason({ status: 'canceled' }), 'trial_ended');
  // a site that was paid for: thirty days after the day it could last be edited
  for (const status of ['canceled', 'past_due']) {
    assert.equal(hostingEndsAt({ ...paid, status, access_until: now - day }, now), now + 29 * day, status);
    assert.equal(hostingEndsAt({ ...paid, status, access_until: now + day }, now), null, `${status}, and it may still be edited`);
    assert.equal(hostingEndsAt({ ...paid, status, access_until: null }, now), null, `${status}, with no day on record`);
  }
  assert.equal(hostingEndsAt({ ...paid, status: 'active', access_until: now - 40 * day }, now), null);
  assert.equal(hostingEndsAt({ ...paid, status: 'trialing', access_until: null }, now), null);
  assert.equal(hostingEndReason({ ...paid, status: 'canceled' }), 'plan_ended');
  assert.equal(hostingEndsAt(null, now), null);
});

test('hosting: a plan that is cancelled and then runs out leaves its day on record, so the site is on its way down and not left up for want of one', { skip: d1Skip }, async () => {
  const day = 86400 * 1000;
  const notes = [];
  const w = world(pages, {
    site: { ls_subscription_id: '77', status: 'active', created_at: Date.now() - 200 * day },
    env: { NOTIFY: { send: async (m) => { notes.push(m); } }, NOTIFY_TO: 'ops@example.com' },
  });
  /** A subscription notice as the payment company sends it, signed. */
  const billing = (status, { at, ends_at }) => {
    const body = JSON.stringify({ meta: { event_name: `subscription_${status}`, custom_data: { site_id: 'site1' } },
      data: { type: 'subscriptions', id: '77', attributes: { status, updated_at: new Date(at).toISOString(), ends_at: new Date(ends_at).toISOString() } } });
    return worker.fetch(new Request('https://worker.example/cloud/webhook/ls', { method: 'POST', headers: { 'X-Signature': createHmac('sha256', 'whsec').update(body).digest('hex') }, body }), w.env);
  };
  await withFetch(w.handler, async () => {
    await switchOn(w.env);
    const paidUntil = Date.now() - 2 * day;
    assert.equal((await billing('cancelled', { at: paidUntil - 10 * day, ends_at: paidUntil })).status, 200);
    assert.equal((await billing('expired', { at: paidUntil + 1000, ends_at: paidUntil })).status, 200);
    assert.equal(w.env.kiln_cloud.row('SELECT status, access_until FROM sites WHERE id = ?', 'site1').access_until, paidUntil);
    await sweep(w.env);
    assert.equal(row(w.env).state, 'live', 'two days after: still up');
    assert.equal((await standing(w.env)).hosting.ends_at, paidUntil + 30 * day);
    assert.equal(notes.filter(m => /no end date/.test(m.raw)).length, 0, 'the operator is not asked to look: there is a day');
  });
});
