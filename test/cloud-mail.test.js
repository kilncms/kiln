/**
 * The emails Kiln Cloud writes to a customer (worker/mail.js): one when a site
 * is added, one two days before its free trial runs out, one when it has. A
 * trial needs no card, so nobody else can remind the owner, and it used to end
 * in silence. Each goes once, to the account's own address, through the
 * send_email binding, and only on a worker that is set up to write to
 * customers. The real handlers run over a SQLite-backed D1 stand-in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../worker/index.js';
import { expireStaleTrials, remindEndingTrials } from '../worker/cloud.js';
import { mailAddress, dayWords, siteAddedMail, trialEndingMail, trialEndedMail, sendMail, customerMailOn } from '../worker/mail.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

const DAY = 86400e3;
const DASH = 'https://app.example';
const box = () => { const out = []; return { out, binding: { send: async (m) => { out.push(m); return { messageId: `<${out.length}@kilncms.com>` }; } } }; };
const cloud = (mail, extra = {}) => cloudEnv(fakeKV(), { CLOUD_DASHBOARD: DASH, NOTIFY: mail.binding, CUSTOMER_MAIL_FROM: 'hello@kilncms.com', CUSTOMER_MAIL_REPLY_TO: 'info@kilncms.com', LS_API_KEY: '', ...extra });
// A GitHub App key of this test's own, so the real "is the app installed?" check can sign its question.
const APP_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const post = (env, path, body) => worker.fetch(new Request(`https://worker.example${path}`, { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);

test('the words: each message names the site, the day and the way out, in plain sentences', () => {
  const ends = Date.UTC(2026, 10, 17, 15, 0, 0);
  assert.equal(dayWords(ends), 'Tuesday, November 17');
  const added = siteAddedMail({ origin: 'https://rosasbakery.example/', plan: 'cloud', endsAt: ends, dashboard: DASH });
  assert.equal(added.subject, 'rosasbakery.example is on Kiln: what to do next');
  assert.match(added.text, /free trial runs until Tuesday, November 17\. No card is needed/);
  assert.match(added.text, /open https:\/\/rosasbakery\.example\/kiln and sign in with GitHub/);
  assert.match(added.text, /Kiln Cloud is \$4\.99 a month/);
  const soon = trialEndingMail({ origin: 'https://rosasbakery.example', plan: 'managed', endsAt: ends, dashboard: DASH });
  assert.equal(soon.subject, 'The Kiln free trial for rosasbakery.example ends on Tuesday, November 17');
  assert.match(soon.text, /Kiln Cloud \+ hosting is \$14\.99 a month/);
  assert.match(soon.text, /stay exactly as they are/);
  const ended = trialEndedMail({ origin: 'https://rosasbakery.example', plan: 'cloud', dashboard: DASH });
  assert.equal(ended.subject, 'The Kiln free trial for rosasbakery.example has ended');
  assert.match(ended.text, /Nothing was charged, and nothing will be\./);
  for (const m of [added, soon, ended]) {
    assert.match(m.text, new RegExp(`\\n${DASH}\\n`), 'the dashboard is a line of its own');
    assert.match(m.html, new RegExp(`<a href="${DASH}"`));
    assert.match(m.text, /You are getting this because rosasbakery\.example was added to Kiln Cloud/);
    assert.equal(/[—–]|!/.test(m.text), false, m.subject);
  }
});

test('the words: what a site is called cannot carry markup into the HTML', () => {
  const m = trialEndedMail({ origin: 'https://x.example/"><script>alert(1)</script>', plan: 'cloud', dashboard: DASH });
  assert.doesNotMatch(m.html, /<script>/);
});

test('an address: one plain address, and nothing that could add a header or a second recipient', () => {
  for (const ok of ['rosa@example.com', 'a.b+c@sub.example.co']) assert.equal(mailAddress(ok), ok);
  for (const bad of ['', null, 'rosa', 'rosa@example', 'a@b.c\nBcc: x@y.z', 'a@b.c, d@e.f', '<a@b.c>', 'a b@c.d', 'x'.repeat(250) + '@e.fg']) assert.equal(mailAddress(bad), null, String(bad));
});

test('a worker that is not set up to write to customers sends nothing and fails nothing', async () => {
  const mail = box();
  assert.equal(customerMailOn({ NOTIFY: mail.binding }), false, 'no from address');
  assert.equal(customerMailOn({ CUSTOMER_MAIL_FROM: 'hello@kilncms.com' }), false, 'no binding');
  assert.deepEqual(await sendMail({ NOTIFY: mail.binding }, 'rosa@example.com', { subject: 's', text: 't', html: 'h' }), { ok: false, reason: 'mail is off' });
  assert.equal(mail.out.length, 0);
  // and a binding that throws is a line for the operator, never an exception
  const env = { NOTIFY: { send: async () => { throw new Error('quota'); } }, CUSTOMER_MAIL_FROM: 'hello@kilncms.com' };
  assert.deepEqual(await sendMail(env, 'rosa@example.com', { subject: 's', text: 't', html: 'h' }), { ok: false, reason: 'send failed' });
});

test('adding a site writes to the owner once, from the Kiln address, with replies going to a person', { skip: d1Skip }, async () => {
  const mail = box();
  const env = cloud(mail);
  env.KILN.map.set('app:creds', JSON.stringify({ app_id: 1, slug: 'kiln-cms', client_id: 'cid', client_secret: 'sec', pk8: APP_KEY }));
  await withFetch(async (url) => {
    if (url === 'https://api.github.com/repos/ada/club/installation') return jsonRes({ id: 1 });
  }, async () => {
    const res = await post(env, '/cloud/sites', { repo: 'ada/club', origin: 'https://club.example', plan: 'cloud', email: 'ada.new@example.com' });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    // the address given with the form is the one written to, and it is kept on the account
    assert.equal(env.kiln_cloud.row('SELECT email FROM accounts').email, 'ada.new@example.com');
    const toOwner = mail.out.filter(m => m && m.to === 'ada.new@example.com');
    assert.equal(toOwner.length, 1);
    assert.deepEqual(toOwner[0].from, { email: 'hello@kilncms.com', name: 'Kiln' });
    assert.equal(toOwner[0].replyTo, 'info@kilncms.com');
    assert.match(toOwner[0].subject, /^club\.example is on Kiln/);
    assert.match(toOwner[0].text, /free trial runs until /);
  });
  // an address that is no address stops the form before anything is added
  const env2 = cloud(box());
  const bad = await post(env2, '/cloud/sites', { repo: 'ada/club', origin: 'https://club.example', plan: 'cloud', email: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal(env2.kiln_cloud.row('SELECT COUNT(*) n FROM sites').n, 0);
});

test('two days before a trial ends its owner is told, once, and only for a trial nobody has subscribed for', { skip: d1Skip }, async () => {
  const mail = box();
  const env = cloud(mail);
  const now = Date.now();
  addSite(env, { id: 'fresh', origin: 'https://fresh.example', status: 'trialing', created_at: now - 1 * DAY });
  addSite(env, { id: 'soon', origin: 'https://soon.example', status: 'trialing', created_at: now - 5.2 * DAY });
  addSite(env, { id: 'paid', origin: 'https://paid.example', status: 'trialing', ls_subscription_id: '77', created_at: now - 5.5 * DAY });
  addSite(env, { id: 'live', origin: 'https://live.example', status: 'active', ls_subscription_id: '78', created_at: now - 5.5 * DAY });
  assert.equal(await remindEndingTrials(env, now), 1);
  assert.equal(mail.out.length, 1);
  assert.equal(mail.out[0].to, 'ada@example.com');
  assert.match(mail.out[0].subject, /^The Kiln free trial for soon\.example ends on /);
  // five minutes later, and the next day: not again
  assert.equal(await remindEndingTrials(env, now + 5 * 60e3), 0);
  assert.equal(await remindEndingTrials(env, now + DAY), 0);
  assert.equal(mail.out.length, 1);
});

test('an account with no address is skipped, and gets the reminder once it has given one', { skip: d1Skip }, async () => {
  const mail = box();
  const env = cloud(mail);
  const now = Date.now();
  env.kiln_cloud.exec('UPDATE accounts SET email = NULL');
  addSite(env, { id: 'soon', origin: 'https://soon.example', status: 'trialing', created_at: now - 5.2 * DAY });
  assert.equal(await remindEndingTrials(env, now), 0);
  const bad = await post(env, '/cloud/account', { email: 'not an address' });
  assert.equal(bad.status, 400);
  const res = await post(env, '/cloud/account', { email: 'rosa@example.com' });
  assert.deepEqual(await res.json(), { ok: true, email: 'rosa@example.com' });
  assert.equal(await remindEndingTrials(env, now), 1);
  assert.equal(mail.out[0].to, 'rosa@example.com');
  // an address can be taken away again
  assert.deepEqual(await (await post(env, '/cloud/account', { email: '' })).json(), { ok: true, email: null });
});

test('when a trial runs out its owner is told once, as well as the operator', { skip: d1Skip }, async () => {
  const mail = box();
  const env = cloud(mail);
  addSite(env, { id: 'over', origin: 'https://over.example', status: 'trialing', created_at: Date.now() - 8 * DAY });
  await expireStaleTrials(env);
  assert.equal(env.kiln_cloud.row('SELECT status FROM sites WHERE id = ?', 'over').status, 'canceled');
  const toOwner = mail.out.filter(m => m && m.to === 'ada@example.com');
  assert.equal(toOwner.length, 1);
  assert.equal(toOwner[0].subject, 'The Kiln free trial for over.example has ended');
  await expireStaleTrials(env);
  assert.equal(mail.out.filter(m => m && m.to === 'ada@example.com').length, 1, 'not again on the next run');
});

test('the dashboard is told whether this service writes to customers', { skip: d1Skip }, async () => {
  const mail = box();
  const on = await worker.fetch(new Request('https://worker.example/cloud/me', { headers: { Authorization: 'Bearer tok' } }), cloud(mail));
  assert.equal((await on.json()).mail, true);
  const off = await worker.fetch(new Request('https://worker.example/cloud/me', { headers: { Authorization: 'Bearer tok' } }), cloudEnv(fakeKV()));
  assert.equal((await off.json()).mail, false);
});
