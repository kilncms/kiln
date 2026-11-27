/**
 * The activity record (worker/activity.js, migration 0022). Switched off, it
 * reads and writes nothing and every route answers as it did. Switched on,
 * each writer leaves one line of the right kind and the right "by", with
 * nothing anyone wrote and no token in it; a line that cannot be written is
 * dropped and the request answers as before; only the operator reads it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import worker from '../worker/index.js';
import { notePublish, markPrepared, markFirstPass, expireStaleTrials, emailDashboardSignIn } from '../worker/cloud.js';
import { sendOnce } from '../worker/mail.js';
import { noteActivity, notePublished, noteEmailSent, noteSiteRemoved, forgetActivity, smallDetail, DETAIL_FIELDS, ACTIVITY_KINDS } from '../worker/activity.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { cloudEnv, addSite, addAccount, d1Skip } from './d1-fake.js';

const DAY = 86400e3;
const APP_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
/** GitHub, as far as adding a site asks it: the repository (which the person can push to) and its installation. */
const github = async (url) => {
  const m = /^https:\/\/api\.github\.com\/repos\/([\w.-]+\/[\w.-]+?)(\/installation)?$/.exec(url);
  if (!m) return undefined;
  return m[2] ? jsonRes({ id: 1 }) : jsonRes({ id: 4343, full_name: m[1], permissions: { push: true } });
};
const sec = (ms) => Math.floor(ms / 1000);
const quiet = (fn) => withFetch(async () => undefined, fn);   // nothing outside the worker answers
const call = async (env, path, { method = 'GET', body, token = 'tok' } = {}) => {
  const res = await worker.fetch(new Request(`https://worker.example${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: 'https://app.example' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  return { status: res.status, json: await res.json().catch(() => null) };
};
const lines = (env, kind = null) => env.kiln_cloud.db.prepare('SELECT account_id, site_id, kind, "by", detail FROM activity ORDER BY id').all()
  .map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })).filter(r => !kind || r.kind === kind);
const count = (env) => env.kiln_cloud.row('SELECT COUNT(*) n FROM activity').n;

/** The operator 'ada' (token 'tok', account acct-1, site-1 ada/club) and a customer 'uma' (token 'tok-uma'). */
function world({ on = true } = {}) {
  const kv = fakeKV();
  const env = cloudEnv(kv, { CLOUD_ADMIN: 'ada', ...(on ? { ACTIVITY_RECORD: 'on' } : {}), CUSTOMER_MAIL_FROM: 'hello@kiln.example', NOTIFY: { send: async () => ({ messageId: 'm-1' }) } });
  addAccount(env, { id: 'acct-uma', github_login: 'uma', email: 'uma@example.com', created_at: Date.now() - 9 * DAY });
  kv.map.set('csess:tok-uma', JSON.stringify({ account_id: 'acct-uma', login: 'uma', uid: 202, gh: 'gho_u' }));
  addSite(env);   // site-1, acct-1, ada/club
  return { env, kv };
}

/** A database stand-in that keeps every statement it is asked and answers none. */
function askedDb() {
  const asked = [];
  return { asked, prepare: (sql) => { asked.push(sql); throw new Error('asked'); }, batch: async () => { asked.push('batch'); throw new Error('asked'); } };
}

let seq = 0;
async function stripe(env, type, object, at) {
  const body = JSON.stringify({ id: `evt_act_${++seq}`, object: 'event', type, created: sec(at), data: { object } });
  const t = sec(Date.now());
  const header = `t=${t},v1=${createHmac('sha256', 'whsec').update(`${t}.${body}`).digest('hex')}`;
  return (await worker.fetch(new Request('https://worker.example/cloud/webhook/stripe', { method: 'POST', headers: { 'Stripe-Signature': header }, body }), env)).status;
}
const sub = (status, periodFrom, more = {}) => ({
  id: 'sub_act', object: 'subscription', customer: 'cus_1', status, cancel_at_period_end: false, cancel_at: null, ended_at: null,
  metadata: { site_id: 'site-4' }, items: { data: [{ current_period_end: sec(periodFrom + 30 * DAY), price: { id: 'price_cloud' } }] }, ...more,
});

test('switched off, the record asks the database nothing, whatever else the setting says', async () => {
  for (const ACTIVITY_RECORD of [undefined, 'off', '', 'ON', 'yes', 'true']) {
    const db = askedDb();
    const env = { kiln_cloud: db, ...(ACTIVITY_RECORD === undefined ? {} : { ACTIVITY_RECORD }) };
    assert.equal(await noteActivity(env, { account_id: 'a', kind: 'signed_up', by: 'person' }), false);
    assert.equal(await notePublished(env, 'ada/club', { by: 'person' }), false);
    assert.equal(await noteEmailSent(env, 'trial-soon:site-1'), false);
    assert.equal(await noteSiteRemoved(env, { account_id: 'a', site_id: 's', by: 'person' }), false);
    assert.equal(await forgetActivity(env, { account_id: 'a' }), false);
    assert.deepEqual(db.asked, [], `ACTIVITY_RECORD=${ACTIVITY_RECORD}`);
    // A publish still makes the one write it always made, and nothing more.
    await notePublish(env, 'ada/club', { by: 'person' });
    assert.equal(db.asked.length, 1);
    assert.match(db.asked[0], /^UPDATE sites SET last_publish/);
  }
});

test('a line keeps a few named words and numbers, never sentences, tokens, markup or unnamed fields', async () => {
  assert.equal(smallDetail({ way: 'github', days: 7, scheduled: true }), '{"way":"github","days":7,"scheduled":true}');
  assert.equal(smallDetail({ way: 'Here is what I wrote on my page', mail: `ghp_${'a'.repeat(36)}`, step: '<p>hi</p>', html: 'x', token: 'y', plan: { nested: 1 } }), null);
  for (const no of [null, undefined, 'text', 5, [1, 2]]) assert.equal(smallDetail(no), null);
  const most = smallDetail(Object.fromEntries(DETAIL_FIELDS.map(k => [k, 'x'.repeat(32)])));
  assert.ok(!most || most.length <= 500);
  // A kind or a "by" that is not on the lists is refused, and nothing throws.
  const warned = [];
  const was = console.warn; console.warn = (s) => warned.push(String(s));
  try {
    const env = { kiln_cloud: askedDb(), ACTIVITY_RECORD: 'on' };
    assert.equal(await noteActivity(env, { account_id: 'a', kind: 'looked_at_page', by: 'person' }), false);
    assert.equal(await noteActivity(env, { account_id: 'a', kind: 'signed_up', by: 'visitor' }), false);
    assert.deepEqual(env.kiln_cloud.asked, []);
  } finally { console.warn = was; }
  assert.equal(warned.length, 2);
  assert.ok(warned.every(w => JSON.parse(w).evt === 'activity_not_written'));
  assert.equal(ACTIVITY_KINDS.length, 21);   // with subscription_ending, the sign that a customer is leaving, and refund, dispute_opened, dispute_closed
});

/** What the operator's and the customer's routes answer, in one world: compared below with the record off and on. */
async function routes(env) {
  addSite(env, { id: 'site-2', account_id: 'acct-uma', repo: 'uma/shop', origin: 'https://shop.example', status: 'canceled', created_at: Date.now() - 9 * DAY });
  addSite(env, { id: 'site-3', account_id: 'acct-uma', repo: 'uma/blog', origin: 'https://blog.example', status: 'trialing', created_at: Date.now() - 9 * DAY });
  const out = [];
  await quiet(async () => {
    out.push(await call(env, '/admin/cloud/grant', { method: 'POST', body: { site_id: 'site-2', more_days: true } }));
    out.push(await call(env, '/admin/cloud/grant', { method: 'POST', body: { site_id: 'site-2', status: 'active' } }));
    out.push(await call(env, '/admin/cloud/needs/hide', { method: 'POST', body: { key: 'trial_ended:acct-uma:site-3' } }));
    out.push(await call(env, '/admin/cloud/needs/hide', { method: 'POST', body: { key: 'trial_ended:acct-uma:site-3', undo: true } }));
    await expireStaleTrials(env);
    await notePublish(env, 'ada/club', { by: 'editor' });
    await markPrepared(env, 'site-1', 'abc123');
    out.push(await call(env, '/admin/cloud/remove', { method: 'POST', body: { site_id: 'site-2' } }));
    out.push(await call(env, '/cloud/sites/remove', { method: 'POST', body: { id: 'site-1' } }));
  });
  // `until` (when a hidden line shows again) and `trial_ends` are counted from the moment of asking.
  const timeless = (j) => (j && typeof j === 'object' ? { ...j, ...('until' in j ? { until: 0 } : {}), ...('trial_ends' in j ? { trial_ends: 0 } : {}) } : j);
  return out.map(r => ({ ...r, json: timeless(r.json) }));
}

test('switched off, no line is written, the read route reads nothing, and every route answers as it does switched on', { skip: d1Skip }, async () => {
  const off = world({ on: false });
  const answeredOff = await routes(off.env);
  assert.equal(count(off.env), 0);
  const read = await call(off.env, '/admin/cloud/activity');
  assert.equal(read.status, 200);
  assert.deepEqual(read.json, { ok: true, recording: false, activity: [], next: null });
  const on = world();
  const answeredOn = await routes(on.env);
  assert.deepEqual(answeredOff, answeredOn);
  assert.ok(count(on.env) > 0);
});

test('switched on, each writer leaves one line of its kind and "by", and a removed site keeps its lines with the account', { skip: d1Skip }, async () => {
  const { env } = world();
  await routes(env);
  const kinds = lines(env).map(r => [r.kind, r.by, r.account_id, r.site_id, r.detail]);
  // A removed site's earlier lines stay with the account (the privacy page: kept with your account and
  // removed with it); one more line says it was removed.
  assert.deepEqual(kinds.filter(k => k[1] !== 'person' || k[0] === 'site_removed').filter(k => ['operator_line_hidden', 'free_days_ended', 'email_sent', 'site_removed'].includes(k[0])), [
    ['operator_line_hidden', 'operator', 'acct-uma', 'site-3', { line: 'trial_ended' }],
    ['operator_line_hidden', 'operator', 'acct-uma', 'site-3', { line: 'trial_ended', undo: true }],
    ['free_days_ended', 'kiln', 'acct-uma', 'site-3', null],
    ['email_sent', 'kiln', 'acct-uma', 'site-3', { mail: 'trial-ended' }],
    ['site_removed', 'operator', 'acct-uma', 'site-2', null],
    ['site_removed', 'person', 'acct-1', 'site-1', null],
  ]);
  assert.ok(lines(env, 'free_days_given').length >= 1, 'site-2\'s free days given are still there after it was removed');
  assert.ok(lines(env, 'operator_status_set').length >= 1, 'and the status the operator set');
});

test('switched on: publishes, set-up steps, emails, sign-ups and a site added each leave exactly one line', { skip: d1Skip }, async () => {
  const { env, kv } = world();
  kv.map.set('app:creds', JSON.stringify({ app_id: 1, slug: 'kiln-cms', client_id: 'cid', client_secret: 'sec', pk8: APP_KEY }));
  env.STRIPE_SECRET_KEY = '';   // adding a site asks nothing of Stripe here
  await notePublish(env, 'ada/club', { by: 'person' });
  await notePublish(env, 'ADA/Club', { by: 'editor', scheduled: true });   // a repository's name is the same in any case
  await notePublish(env, 'nobody/else', { by: 'person' });                 // no site on record: no line
  await markPrepared(env, 'site-1', 'abc123');
  await markFirstPass(env, 'site-1', null, 'kiln');
  const mail = { subject: 'Your free days end soon', text: 'Words someone wrote on the page', html: '<p>Words</p>' };
  assert.equal((await sendOnce(env, 'trial-soon:site-1', 'ada@example.com', mail)).ok, true);
  await sendOnce(env, 'trial-soon:site-1', 'ada@example.com', mail);      // already sent: no second line
  await emailDashboardSignIn(env, { email: 'Nell@Example.com' });
  await emailDashboardSignIn(env, { email: 'nell@example.com' });         // the same person again: no second sign-up
  await withFetch(github, async () => {
    const added = await call(env, '/cloud/sites', { method: 'POST', body: { repo: 'ada/shop', origin: 'https://shop-ada.example' } });
    assert.ok(added.status < 300, JSON.stringify(added.json));
  });
  const all = lines(env);
  const nell = env.kiln_cloud.row("SELECT id FROM accounts WHERE signin_email = 'nell@example.com'");
  const shop = env.kiln_cloud.row("SELECT id FROM sites WHERE repo = 'ada/shop'");
  assert.deepEqual(all.filter(r => r.kind !== 'email_sent' || r.site_id === 'site-1').map(r => [r.kind, r.by, r.account_id, r.site_id, r.detail]), [
    ['published', 'person', 'acct-1', 'site-1', null],
    ['published', 'editor', 'acct-1', 'site-1', { scheduled: true }],
    ['setup_step', 'person', 'acct-1', 'site-1', { step: 'kiln_added' }],
    ['setup_step', 'kiln', 'acct-1', 'site-1', { step: 'marked_for_editing' }],
    ['email_sent', 'kiln', 'acct-1', 'site-1', { mail: 'trial-soon' }],
    ['signed_up', 'person', nell.id, null, { way: 'email' }],
    ['site_added', 'person', 'acct-1', shop.id, { way: 'github' }],
  ]);
  // The site added was told so by email, and that is a line of its own.
  assert.deepEqual(all.filter(r => r.kind === 'email_sent' && r.site_id === shop.id).map(r => r.detail), [{ mail: 'added' }]);
  const text = JSON.stringify(all);
  for (const never of ['Words', '<p>', 'gho_', '@', 'Your free days', 'https://']) assert.ok(!text.includes(never), never);
});

test('switched on: Stripe\'s notices leave started, renewed, failed and ended, and a notice that changes nothing leaves no line', { skip: d1Skip }, async () => {
  const { env } = world();
  addSite(env, { id: 'site-4', account_id: 'acct-uma', repo: 'uma/cafe', origin: 'https://cafe.example', status: 'trialing' });
  const T = sec(Date.now()) * 1000;
  await quiet(async () => {
    assert.equal(await stripe(env, 'customer.subscription.created', sub('active', T), T), 200);
    assert.equal(await stripe(env, 'customer.subscription.updated', sub('active', T + 1000), T + 1000), 200);   // paid to a later day
    assert.equal(await stripe(env, 'customer.subscription.updated', sub('active', T + 1000), T + 2000), 200);   // nothing paid: no line
    const invoice = { id: 'in_act', object: 'invoice', subscription: 'sub_act', parent: { subscription_details: { subscription: 'sub_act', metadata: { site_id: 'site-4' } } } };
    assert.equal(await stripe(env, 'invoice.payment_failed', invoice, T + 3000), 200);
    assert.equal(await stripe(env, 'customer.subscription.updated', sub('active', T + 1000), T + 4000), 200);   // the charge went through after all
    // Set to end with its period, then set back, then set to end again: the clearest sign of leaving, and its undo.
    assert.equal(await stripe(env, 'customer.subscription.updated', sub('active', T + 1000, { cancel_at_period_end: true }), T + 4100), 200);
    assert.equal(await stripe(env, 'customer.subscription.updated', sub('active', T + 1000), T + 4200), 200);
    assert.equal(await stripe(env, 'customer.subscription.updated', sub('active', T + 1000, { cancel_at_period_end: true }), T + 4300), 200);
    assert.equal(await stripe(env, 'customer.subscription.deleted', sub('canceled', T + 1000, { ended_at: sec(T + 5000) }), T + 5000), 200);
  });
  assert.deepEqual(lines(env).map(r => [r.kind, r.by, r.account_id, r.site_id, r.kind === 'subscription_ending' ? !!(r.detail && r.detail.undo) : null]), [
    ['subscription_started', 'stripe', 'acct-uma', 'site-4', null],
    ['subscription_renewed', 'stripe', 'acct-uma', 'site-4', null],
    ['payment_failed', 'stripe', 'acct-uma', 'site-4', null],
    ['subscription_renewed', 'stripe', 'acct-uma', 'site-4', null],
    ['subscription_ending', 'stripe', 'acct-uma', 'site-4', false],
    ['subscription_ending', 'stripe', 'acct-uma', 'site-4', true],
    ['subscription_ending', 'stripe', 'acct-uma', 'site-4', false],
    ['subscription_ended', 'stripe', 'acct-uma', 'site-4', null],
  ]);
  assert.ok(!JSON.stringify(lines(env)).includes('cus_1') && !JSON.stringify(lines(env)).includes('sub_act'));
});

test('a line that cannot be written is said once in the log and dropped, and the request answers as before', { skip: d1Skip }, async () => {
  const { env } = world();
  env.kiln_cloud.db.exec('DROP TABLE activity');
  const warned = [];
  const was = console.warn; console.warn = (s) => warned.push(String(s));
  let answered;
  try {
    await quiet(async () => {
      answered = await call(env, '/admin/cloud/grant', { method: 'POST', body: { site_id: 'site-1', status: 'past_due' } });
      await notePublish(env, 'ada/club', { by: 'person' });
    });
  } finally { console.warn = was; }
  assert.deepEqual(answered, { status: 200, json: { ok: true } });
  assert.equal(env.kiln_cloud.row('SELECT status FROM sites WHERE id = ?', 'site-1').status, 'past_due');
  const notWritten = warned.map(w => { try { return JSON.parse(w); } catch { return {}; } }).filter(w => w.evt === 'activity_not_written');
  assert.deepEqual(notWritten.map(w => w.kind), ['operator_status_set', 'published']);
});

test('only the operator reads the record: newest first, by account or by site, a page at a time', { skip: d1Skip }, async () => {
  const { env } = world();
  addSite(env, { id: 'site-5', account_id: 'acct-uma', repo: 'uma/zine', origin: 'https://zine.example' });
  for (let i = 0; i < 5; i++) await noteActivity(env, { site_id: 'site-5', kind: 'published', by: 'person', at: 1000 + i });
  await noteActivity(env, { account_id: 'acct-1', kind: 'signed_up', by: 'person', detail: { way: 'github' } });
  for (const token of ['tok-uma', 'nobody']) assert.equal((await call(env, '/admin/cloud/activity', { token })).status, 403);
  const everyone = await call(env, '/admin/cloud/activity');
  assert.equal(everyone.status, 200);
  assert.deepEqual(everyone.json.activity.map(r => r.kind), ['signed_up', 'published', 'published', 'published', 'published', 'published']);
  assert.deepEqual(everyone.json.activity[0].detail, { way: 'github' });
  const uma = await call(env, '/admin/cloud/activity?account=acct-uma&limit=2');
  assert.deepEqual(uma.json.activity.map(r => [r.account_id, r.site_id, r.at]), [['acct-uma', 'site-5', 1004], ['acct-uma', 'site-5', 1003]]);
  const more = await call(env, `/admin/cloud/activity?site=site-5&limit=2&before=${uma.json.next}`);
  assert.deepEqual(more.json.activity.map(r => r.at), [1002, 1001]);
  const last = await call(env, `/admin/cloud/activity?site=site-5&limit=500&before=${more.json.next}`);
  assert.deepEqual(last.json.activity.map(r => r.at), [1000]);
  assert.equal(last.json.next, null);
});

test('Stripe\'s refunds and disputes: one line each for the site the charge paid for, a dispute opened alerts the operator, and a charge that is no site\'s leaves nothing', { skip: d1Skip }, async () => {
  const T = sec(Date.now()) * 1000;
  const charges = { ch_1: { id: 'ch_1', object: 'charge', customer: 'cus_1', amount: 1499, currency: 'usd' }, ch_9: { id: 'ch_9', object: 'charge', customer: 'cus_nobody', amount: 1499, currency: 'usd' } };
  // Stripe, as far as a dispute's notice asks it: the charge disputed. Anything else is not found.
  const stripeApi = async (url) => { const m = /^https:\/\/api\.stripe\.com\/v1\/charges\/(\w+)$/.exec(url); return m && charges[m[1]] ? jsonRes(charges[m[1]]) : undefined; };
  const dispute = (id, charge, status) => ({ id, object: 'dispute', charge, amount: 1499, currency: 'usd', reason: 'fraudulent', status, evidence_details: { due_by: sec(T + 7 * DAY) } });
  const run = async ({ on }) => {
    const { env } = world({ on });
    const sent = [];
    Object.assign(env, { NOTIFY_TO: 'owner@kiln.example', NOTIFY: { send: async (m) => { sent.push(m); return { messageId: 'm' }; } } });
    addSite(env, { id: 'site-4', account_id: 'acct-uma', repo: 'uma/cafe', origin: 'https://cafe.example' });
    env.kiln_cloud.exec('UPDATE sites SET stripe_customer_id = ? WHERE id = ?', 'cus_1', 'site-4');
    await withFetch(stripeApi, async () => {
      assert.equal(await stripe(env, 'charge.refunded', { ...charges.ch_1, refunded: true, amount_refunded: 1499 }, T), 200);
      assert.equal(await stripe(env, 'charge.dispute.created', dispute('dp_1', 'ch_1', 'needs_response'), T + 1000), 200);
      assert.equal(await stripe(env, 'charge.dispute.closed', dispute('dp_1', 'ch_1', 'won'), T + 2000), 200);
      assert.equal(await stripe(env, 'charge.refunded', { ...charges.ch_9, refunded: true }, T + 3000), 200);                  // no site's: nothing
      assert.equal(await stripe(env, 'charge.dispute.created', dispute('dp_9', 'ch_9', 'needs_response'), T + 4000), 200);   // nor this, and no alert
      assert.equal(await stripe(env, 'charge.dispute.created', dispute('dp_8', 'ch_8', 'needs_response'), T + 5000), 200);   // a charge Stripe does not know
      assert.equal(await stripe(env, 'charge.succeeded', charges.ch_1, T + 6000), 200);                                       // not listened for: answered as before
    });
    return { env, sent };
  };
  const on = await run({ on: true });
  assert.deepEqual(lines(on.env).map(r => [r.kind, r.by, r.account_id, r.site_id, r.detail]), [
    ['refund', 'stripe', 'acct-uma', 'site-4', null],
    ['dispute_opened', 'stripe', 'acct-uma', 'site-4', null],
    ['dispute_closed', 'stripe', 'acct-uma', 'site-4', { outcome: 'won' }],
  ]);
  const text = JSON.stringify(lines(on.env));
  for (const never of ['1499', 'usd', 'fraudulent', 'cus_', 'ch_', 'dp_']) assert.ok(!text.includes(never), never);
  assert.equal(on.sent.length, 1, 'one alert, for the dispute on a site\'s charge');
  assert.match(on.sent[0].raw, /^Subject: Kiln alert: a payment was disputed \(uma\/cafe\)$/m);
  assert.match(on.sent[0].raw, /dp_1/);
  // Switched off, no line is written, and the dispute is still an alert.
  const off = await run({ on: false });
  assert.equal(count(off.env), 0);
  assert.equal(off.sent.length, 1);
});
