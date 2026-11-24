/**
 * The operator's view of the customers: `GET /admin/cloud/overview` answers
 * who has an account, how far each one got, and the few things that need the
 * operator. Two moments feed it (migration 0020): when a person was last at
 * the dashboard, and when a change was last published to a site through Kiln.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { buildCustomers, noteSeen, notePublish, googleDashboardSignIn, emailDashboardSignIn } from '../worker/cloud.js';
import { REPO, editorEnv, fakeKV, withFetch, call, b64, jsonRes, SAMPLES } from './worker-harness.js';
import { fakeD1, cloudEnv, addSite, addAccount, schemaFiles, d1Skip } from './d1-fake.js';

const DAY = 86400 * 1000;
const NOW = Date.UTC(2026, 10, 24, 12);
const account = (over = {}) => ({ id: 'a1', github_login: null, name: null, google_sub: null, signin_email: null, linked_at: null, created_at: NOW - 10 * DAY, last_seen: null, email: null, ...over });
const site = (over = {}) => ({ id: 's1', account_id: 'a1', repo: 'ada/club', origin: 'https://club.example', plan: 'cloud', status: 'trialing', created_at: NOW - DAY, ...over });
const view = (accounts, sites, more = {}) => buildCustomers(accounts, sites, { now: NOW, ...more });
const kinds = (out) => out.needs_you.map(n => n.kind);

// ─── the list itself ─────────────────────────────────────────────────────────

test('a customer is answered whole: who they are, how they sign in, their address, how far they got, and each site', () => {
  const out = view(
    [account({ github_login: 'ada', google_sub: 'g-1', linked_at: NOW - DAY, email: 'ada@example.com', last_seen: NOW - 3600 })],
    [site({ name: 'Rowing Club', kept: 1, plan: 'managed', status: 'active', stripe_subscription_id: 'sub_secret', billing_period: 'year', paid_until: NOW + 300 * DAY, last_publish: NOW - 60, stripe_customer_id: 'cus_secret' })],
  );
  assert.deepEqual(out.customers, [{
    id: 'a1', who: '@ada', signs_in: ['github', 'google'], linked: true, address: 'ada@example.com',
    created_at: NOW - 10 * DAY, last_seen: NOW - 3600, stage: 'paying',
    sites: [{
      id: 's1', label: 'Rowing Club', origin: 'https://club.example', plan: 'managed', status: 'active', kept: true,
      trial_ends: null, paid_until: NOW + 300 * DAY, billing_period: 'year', access_until: null, set_up: 'ready to edit', last_publish: NOW - 60,
    }],
  }]);
  assert.deepEqual(out.needs_you, []);
  assert.deepEqual(out.funnel, { signed_up: 1, added_site: 1, set_up: 1, published: 1, paying: 1 });
  assert.equal(/sub_secret|cus_secret/.test(JSON.stringify(out)), false, 'no id at Stripe is answered');
});

test('who a person is called: the GitHub login, else the name, else the address, else "no name"', () => {
  const who = (over) => view([account(over)], []).customers[0];
  assert.equal(who({ github_login: 'ada', name: 'Ada L', email: 'a@example.com' }).who, '@ada');
  assert.equal(who({ name: 'Ada L', email: 'a@example.com', google_sub: 'g' }).who, 'Ada L');
  assert.equal(who({ email: 'a@example.com', signin_email: 'a@example.com' }).who, 'a@example.com');
  assert.equal(who({}).who, 'no name');
  assert.equal(who({}).address, null, 'an address is never made up');
  assert.deepEqual(who({ signin_email: 'a@example.com' }).signs_in, ['email']);
  assert.deepEqual(who({ github_login: 'ada', google_sub: 'g', signin_email: 'a@example.com' }).signs_in, ['github', 'google', 'email']);
  assert.equal(who({}).linked, false);
});

test('a site says how far its set-up got, when its free days end, and what to call it', () => {
  const one = (over) => view([account()], [site(over)]).customers[0].sites[0];
  assert.equal(one({}).set_up, 'not started');
  assert.equal(one({ prepared_at: 5 }).set_up, 'kiln added');
  assert.equal(one({ prepared_at: 5, firstpass_at: 6 }).set_up, 'ready to edit');
  assert.equal(one({ kept: 1 }).set_up, 'ready to edit', 'a site Kiln made is ready as it is');
  assert.equal(one({ prepared_at: 5, last_publish: 9 }).set_up, 'ready to edit', 'a published change shows it can be edited');
  assert.equal(one({ created_at: NOW - DAY }).trial_ends, NOW + 6 * DAY, 'seven free days from the day it was added');
  assert.equal(one({ stripe_subscription_id: 'sub_1' }).trial_ends, null, 'someone subscribed: nothing runs out');
  assert.equal(one({ status: 'active' }).trial_ends, null);
  assert.equal(one({}).label, 'ada/club');
  assert.equal(one({ name: 'Rowing Club' }).label, 'Rowing Club');
  assert.equal(one({ repo: null }).label, 'club.example');
  assert.equal(one({}).last_publish, null);
});

test('the stage is the furthest an account got, and the funnel counts everyone who reached at least each one', () => {
  const out = view(
    [
      account({ id: 'none' }),
      account({ id: 'added' }),
      account({ id: 'setup' }),
      account({ id: 'published' }),
      account({ id: 'paying' }),
      account({ id: 'granted' }),
      account({ id: 'failed' }),
    ],
    [
      site({ id: 's-added', account_id: 'added' }),
      site({ id: 's-setup', account_id: 'setup', prepared_at: 5 }),
      site({ id: 's-pub', account_id: 'published', prepared_at: 5, last_publish: 9 }),
      site({ id: 's-pay', account_id: 'paying', status: 'active', stripe_subscription_id: 'sub_1' }),
      site({ id: 's-granted', account_id: 'granted', status: 'active' }),
      site({ id: 's-failed', account_id: 'failed', status: 'past_due', stripe_subscription_id: 'sub_2' }),
    ],
  );
  const stage = Object.fromEntries(out.customers.map(c => [c.id, c.stage]));
  assert.deepEqual(stage, {
    none: 'signed up', added: 'added a site', setup: 'set up', published: 'published', paying: 'paying',
    granted: 'added a site',   // set to active by the operator, with no subscription: nobody is paying for it
    failed: 'paying',          // a subscription whose last charge failed is still a subscription
  });
  assert.deepEqual(out.funnel, { signed_up: 7, added_site: 6, set_up: 4, published: 3, paying: 2 });
});

test('customers come newest first, in the order the accounts were read', () => {
  const out = view([account({ id: 'new', created_at: NOW }), account({ id: 'old', created_at: 1 })], []);
  assert.deepEqual(out.customers.map(c => c.id), ['new', 'old']);
});

// ─── what needs the operator ─────────────────────────────────────────────────

test('needs you: a trial that ends within three days for an account Kiln cannot write to', () => {
  const ending = (createdAgo, acct = {}, s = {}) => kinds(view([account(acct)], [site({ created_at: NOW - createdAgo, kept: 1, ...s })]));
  assert.deepEqual(ending(4 * DAY), ['trial_no_address'], 'three days left, to the millisecond');
  assert.deepEqual(ending(4 * DAY - 1), [], 'a moment more than three days left');
  assert.deepEqual(ending(6 * DAY), ['trial_no_address']);
  assert.deepEqual(ending(7 * DAY), [], 'the free days are over: there is nothing left to warn of');
  assert.deepEqual(ending(5 * DAY, { email: 'a@example.com' }), [], 'Kiln\'s own reminder reaches them');
  assert.deepEqual(ending(5 * DAY, {}, { stripe_subscription_id: 'sub_1' }), [], 'someone subscribed');
  const [row] = view([account({ github_login: 'ada' })], [site({ id: 's9', created_at: NOW - 5 * DAY, kept: 1, name: 'Rowing Club' })]).needs_you;
  assert.deepEqual({ ...row, detail: '' }, { kind: 'trial_no_address', account_id: 'a1', site_id: 's9', who: '@ada', label: 'Trial ending, no address', detail: '' });
  assert.equal(row.detail, 'The free days of Rowing Club end on 26 November and Kiln\'s reminder cannot reach this person: Kiln has no address for them, so reach them on GitHub as @ada, or keep the site open yourself with its status control.');
});

test('needs you: a payment that failed', () => {
  const out = view([account({ email: 'a@example.com' })], [site({ status: 'past_due', kept: 1, stripe_subscription_id: 'sub_1', access_until: NOW + 2 * DAY })]);
  assert.deepEqual(kinds(out), ['payment_failed']);
  assert.equal(out.needs_you[0].detail, 'The last charge for ada/club did not go through and editing stops on 26 November unless a later one does: write to them at a@example.com, or look at the subscription in Stripe.');
  assert.equal(out.needs_you[0].label, 'Payment failed');
});

test('needs you: a site added more than two days ago that is not ready to edit', () => {
  const stuck = (s) => kinds(view([account({ email: 'a@example.com' })], [site(s)]));
  assert.deepEqual(stuck({ created_at: NOW - 2 * DAY }), [], 'two days to the millisecond is still its first two days');
  assert.deepEqual(stuck({ created_at: NOW - 2 * DAY - 1 }), ['stuck_setup']);
  assert.deepEqual(stuck({ created_at: NOW - 5 * DAY, prepared_at: 5 }), ['stuck_setup'], 'Kiln is added, nothing is marked');
  assert.deepEqual(stuck({ created_at: NOW - 5 * DAY, prepared_at: 5, firstpass_at: 6 }), []);
  assert.deepEqual(stuck({ created_at: NOW - 5 * DAY, kept: 1 }), []);
  assert.deepEqual(stuck({ created_at: NOW - 40 * DAY, status: 'canceled' }), [], 'a site that ended is not waiting for anything');
  const [row] = view([account({ email: 'a@example.com' })], [site({ created_at: NOW - 5 * DAY, prepared_at: 5 })]).needs_you;
  assert.equal(row.detail, 'ada/club was added 5 days ago and Kiln is in its repository, but nothing is marked for editing yet: write to them at a@example.com and offer to help.');
  assert.equal(row.site_id, 's1');
});

test('needs you: someone who signed up between two and thirty days ago and has no site', () => {
  const lone = (ago, over = {}, more = {}) => kinds(view([account({ created_at: NOW - ago, ...over })], [], more));
  assert.deepEqual(lone(2 * DAY), []);
  assert.deepEqual(lone(2 * DAY + 1), ['no_site']);
  assert.deepEqual(lone(30 * DAY - 1), ['no_site']);
  assert.deepEqual(lone(30 * DAY), [], 'after a month it is no longer news');
  assert.deepEqual(lone(5 * DAY, {}, { asking: 'a1' }), [], 'the operator is not told to write to themself');
  const [row] = view([account({ created_at: NOW - 4 * DAY, name: 'Eve Park' })], []).needs_you;
  assert.deepEqual(row, { kind: 'no_site', account_id: 'a1', site_id: null, who: 'Eve Park', label: 'No site yet', detail: 'Signed up 4 days ago and has not added a site: Kiln has no address for them and they have no GitHub login, so there is nobody to write to.' });
  const [written] = view([account({ created_at: NOW - 4 * DAY, email: 'eve@example.com' })], []).needs_you;
  assert.equal(written.detail, 'Signed up 4 days ago and has not added a site: write to them at eve@example.com and ask what stopped them.');
});

test('needs you is in order: the most urgent kind first, and the most pressing of each kind first', () => {
  const out = view(
    [account({ id: 'lone', created_at: NOW - 5 * DAY }), account({ id: 'lone2', created_at: NOW - 3 * DAY }), account({ id: 'a1' }), account({ id: 'a2', email: 'b@example.com' })],
    [
      site({ id: 'stuck', account_id: 'a2', created_at: NOW - 9 * DAY, status: 'active' }),
      site({ id: 'failed', account_id: 'a2', status: 'past_due', kept: 1 }),
      site({ id: 'late', account_id: 'a1', created_at: NOW - 5 * DAY, kept: 1 }),
      site({ id: 'soon', account_id: 'a1', created_at: NOW - 6 * DAY, kept: 1 }),
    ],
  );
  assert.deepEqual(out.needs_you.map(n => n.site_id || n.account_id), ['soon', 'late', 'failed', 'stuck', 'lone2', 'lone']);
  for (const n of out.needs_you) assert.equal(n.detail.includes('—'), false);
});

// ─── the service ─────────────────────────────────────────────────────────────

const ask = (env, path, token = 'tok') => worker.fetch(new Request(`https://worker.example${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }), env);
const quiet = (fn) => withFetch(async () => undefined, fn);   // nothing outside the worker answers

test('the overview answers customers, needs_you and funnel beside everything it answered before, to the operator only', { skip: d1Skip }, async () => {
  const kv = fakeKV();
  const env = cloudEnv(kv, { CLOUD_ADMIN: 'ada' });
  const now = Date.now();
  addSite(env, { id: 'site-1', status: 'active', stripe_subscription_id: 'sub_live_1', prepared_at: 5, firstpass_at: 6, last_publish: now - 1000 });
  addAccount(env, { id: 'acct-2', created_at: now - 5 * DAY, google_sub: 'g-2', google_email: 'eve@example.com', name: 'Eve Park', email: 'not-this@example.com' });
  addAccount(env, { id: 'acct-3', created_at: now - 5 * DAY, signin_email: 'kit@example.com', last_seen: now - 60 });
  addSite(env, { id: 'site-3', account_id: 'acct-3', repo: 'kiln-sites/kit', origin: 'https://kit.example', status: 'trialing', created_at: now - 5 * DAY, kept: 1, name: 'Kit Bakes' });
  kv.map.set('csess:other', JSON.stringify({ account_id: 'acct-2', login: null, google: { sub: 'g-2' } }));
  await quiet(async () => {
    const res = await ask(env, '/admin/cloud/overview');
    assert.equal(res.status, 200);
    const text = await res.text();
    const o = JSON.parse(text);
    // Everything from before is still there.
    assert.equal(o.accounts, 3);
    assert.equal(o.sites.length, 2);
    assert.equal(o.active, 1);
    assert.equal(typeof o.mrr, 'number');
    assert.ok(o.store && o.insights && o.insights.byStatus);
    // The new part.
    assert.deepEqual(o.customers.map(c => c.id).sort(), ['acct-1', 'acct-2', 'acct-3']);
    assert.equal(o.customers[o.customers.length - 1].id, 'acct-1', 'the oldest account comes last');
    const by = Object.fromEntries(o.customers.map(c => [c.id, c]));
    assert.equal(by['acct-2'].address, 'eve@example.com', 'a Google account is written to at the address Google confirmed, as mail.js decides');
    assert.equal(by['acct-2'].who, 'Eve Park');
    assert.deepEqual(by['acct-2'].signs_in, ['google']);
    assert.equal(by['acct-3'].address, 'kit@example.com');
    assert.equal(by['acct-3'].last_seen, now - 60);
    assert.equal(by['acct-3'].sites[0].label, 'Kit Bakes');
    assert.equal(by['acct-3'].sites[0].trial_ends, now + 2 * DAY);
    assert.equal(by['acct-1'].stage, 'paying');
    assert.equal(by['acct-1'].sites[0].last_publish, now - 1000);
    assert.deepEqual(o.funnel, { signed_up: 3, added_site: 2, set_up: 2, published: 1, paying: 1 });
    assert.deepEqual(o.needs_you.map(n => [n.kind, n.account_id]), [['no_site', 'acct-2']]);
    assert.equal(/gho_x|sub_live_1|csess|"gh"|stripe_customer_id":"cus/.test(JSON.stringify({ c: o.customers, n: o.needs_you, f: o.funnel })), false, 'no token and no id at Stripe in the new part');
    // Anyone else is refused, as before.
    assert.equal((await ask(env, '/admin/cloud/overview', 'other')).status, 403);
    assert.equal((await ask(env, '/admin/cloud/overview', 'nobody')).status, 403);
    assert.equal((await ask(env, '/admin/cloud/overview', null)).status, 403);
  });
});

test('on a database migration 0020 has not reached, the overview still answers, with nothing seen and nothing published', { skip: d1Skip }, async () => {
  const kv = fakeKV();
  const before0020 = schemaFiles().findIndex(f => f.includes('0020_'));
  assert.ok(before0020 > 0);
  const env = cloudEnv(kv, { CLOUD_ADMIN: 'ada', d1: { upTo: before0020 } });
  addSite(env, { id: 'site-1', status: 'active', last_publish: 5 });
  assert.throws(() => env.kiln_cloud.row('SELECT last_seen FROM accounts'), 'this database has no such column');
  await quiet(async () => {
    assert.equal((await ask(env, '/cloud/me')).status, 200, 'the dashboard is not troubled by a moment it cannot record');
    const o = await (await ask(env, '/admin/cloud/overview')).json();
    assert.equal(o.accounts, 1);
    assert.equal(o.customers.length, 1);
    assert.equal(o.customers[0].last_seen, null);
    assert.equal(o.customers[0].sites[0].last_publish, null);
    assert.equal(o.customers[0].address, 'ada@example.com');
    assert.deepEqual(o.funnel, { signed_up: 1, added_site: 1, set_up: 0, published: 0, paying: 0 });
  });
  await noteSeen(env, 'acct-1');           // neither throws
  await notePublish(env, 'ada/club');
});

// ─── last seen ───────────────────────────────────────────────────────────────

test('a sign-in to the dashboard writes when the person was last seen: with GitHub, with Google and by email', { skip: d1Skip }, async () => {
  const kv = fakeKV({ 'app:creds': { client_id: 'cid', client_secret: 'cs' }, 'cstate:n1': '1' });
  const env = { ...cloudEnv(kv), CLOUD_DASHBOARD: 'https://app.example' };
  const seen = (where, ...a) => env.kiln_cloud.row(`SELECT last_seen FROM accounts WHERE ${where}`, ...a)?.last_seen ?? null;
  assert.equal(seen("id = 'acct-1'"), null);
  const started = Date.now();
  await withFetch(async (url) => {
    if (url.includes('/login/oauth/access_token')) return jsonRes({ access_token: 'gho_y' });
    if (url === 'https://api.github.com/user') return jsonRes({ login: 'ada', id: 11, email: 'ada@example.com' });
  }, async () => {
    const res = await worker.fetch(new Request('https://worker.example/cloud/callback?code=c&state=n1', { headers: { Cookie: '__Host-kiln_signin=n1' } }), env);
    assert.match(res.headers.get('Location') || '', /#kc_token=/);
  });
  assert.ok(seen("github_login = 'ada'") >= started, 'GitHub');
  const g = await googleDashboardSignIn(env, { for: 'dashboard', dash: 'https://app.example' }, { identity: async () => ({ info: { sub: 'g-7', email: 'eve@example.com', email_verified: 'true', name: 'Eve Park' } }) });
  assert.equal(g.status, 302);
  assert.ok(seen("google_sub = 'g-7'") >= started, 'Google');
  const e = await emailDashboardSignIn(env, { email: 'kit@example.com' });
  assert.equal(e.status, 302);
  assert.ok(seen("signin_email = 'kit@example.com'") >= started, 'email');
});

test('an open dashboard writes last seen at most once an hour for an account', { skip: d1Skip }, async () => {
  const kv = fakeKV();
  const env = cloudEnv(kv);
  const seen = () => env.kiln_cloud.row("SELECT last_seen FROM accounts WHERE id = 'acct-1'").last_seen;
  await quiet(async () => {
    const t0 = Date.now();
    assert.equal((await ask(env, '/cloud/me')).status, 200);
    const first = seen();
    assert.ok(first >= t0, 'the first request of the hour writes it');
    const recent = Date.now() - 59 * 60 * 1000;
    env.kiln_cloud.exec("UPDATE accounts SET last_seen = ? WHERE id = 'acct-1'", recent);
    await ask(env, '/cloud/me');
    assert.equal(seen(), recent, 'seen 59 minutes ago: left as it is');
    env.kiln_cloud.exec("UPDATE accounts SET last_seen = ? WHERE id = 'acct-1'", Date.now() - 61 * 60 * 1000);
    await ask(env, '/cloud/me');
    assert.ok(seen() >= t0, 'seen more than an hour ago: written again');
    assert.equal((await ask(env, '/cloud/me', 'nobody')).status, 401);
  });
  // A database that refuses the write does not fail the request.
  const broken = { ...env, kiln_cloud: { ...env.kiln_cloud, prepare: (sql) => { if (/last_seen = \?/.test(sql)) throw new Error('no'); return env.kiln_cloud.prepare(sql); } } };
  await quiet(async () => assert.equal((await ask(broken, '/cloud/me')).status, 200));
});

// ─── last publish ────────────────────────────────────────────────────────────

const githubTakesIt = async (url, init) => {
  if (init.method === 'PUT' || init.method === 'POST' || init.method === 'PATCH') return jsonRes({ content: {}, commit: { sha: 'c1' }, sha: 'new' }, 201);
};
const putPicture = (env, branch = 'main') => call(env, 'PUT', `/gh/repos/${REPO}/contents/images/boat.png`, { body: { message: 'x', content: b64(SAMPLES.png), branch } });

test('publishing in the editor writes when a change last went to each Cloud site of that repository, at most once a minute', { skip: d1Skip }, async () => {
  const d1 = fakeD1();
  d1.exec("INSERT INTO accounts (id, github_login, email, created_at) VALUES ('acct-1', 'acme', 'o@example.com', 1)");
  const env = { ...editorEnv(), kiln_cloud: d1 };
  addSite(env, { id: 'site-a', repo: 'Acme/Site' });                                   // the name is compared without its capitals
  addSite(env, { id: 'site-b', repo: REPO, origin: 'https://second.example' });        // a second site of the same repository
  addSite(env, { id: 'site-c', repo: 'acme/other', origin: 'https://other.example' });
  const at = (id) => d1.row('SELECT last_publish FROM sites WHERE id = ?', id).last_publish;
  await withFetch(githubTakesIt, async () => {
    // A draft kept on Kiln's own scratch branch is not a publish.
    assert.equal((await putPicture(env, 'kiln-drafts')).status, 201);
    assert.equal(at('site-a'), null);
    const t0 = Date.now();
    assert.equal((await putPicture(env)).status, 201);
    assert.ok(at('site-a') >= t0 && at('site-b') >= t0, 'every site of the repository');
    assert.equal(at('site-c'), null, 'and no other');
    const recent = Date.now() - 30 * 1000;
    d1.exec('UPDATE sites SET last_publish = ?', recent);
    await putPicture(env);
    assert.equal(at('site-a'), recent, 'published half a minute ago: left as it is');
    d1.exec('UPDATE sites SET last_publish = ?', Date.now() - 61 * 1000);
    await putPicture(env);
    assert.ok(at('site-a') >= t0, 'published more than a minute ago: written again');
    assert.equal(at('site-c') < t0, true);
  });
  // GitHub turning the write away records nothing.
  d1.exec('UPDATE sites SET last_publish = NULL');
  await withFetch(async () => jsonRes({ message: 'no' }, 409), async () => { await putPicture(env); });
  assert.equal(at('site-a'), null);
  // A database that refuses the write does not fail the save.
  const broken = { ...env, kiln_cloud: { ...d1, prepare: (sql) => { if (/last_publish = \?/.test(sql)) throw new Error('no'); return d1.prepare(sql); } } };
  await withFetch(githubTakesIt, async () => assert.equal((await putPicture(broken)).status, 201));
});

test('notePublish by itself: one write a minute for a repository, and nothing for a repository that is no Cloud site', { skip: d1Skip }, async () => {
  const env = cloudEnv(fakeKV());
  addSite(env, { id: 'site-1', repo: 'ada/club' });
  const at = () => env.kiln_cloud.row("SELECT last_publish FROM sites WHERE id = 'site-1'").last_publish;
  await notePublish(env, 'ada/club', { now: 1_000_000 });
  assert.equal(at(), 1_000_000);
  await notePublish(env, 'ada/club', { now: 1_059_999 });
  assert.equal(at(), 1_000_000);
  await notePublish(env, 'ada/club', { now: 1_060_000 });
  assert.equal(at(), 1_060_000);
  await notePublish(env, 'someone/else', { now: 2_000_000 });
  assert.equal(at(), 1_060_000);
  await notePublish({}, 'ada/club');
  await notePublish(env, null);
});
