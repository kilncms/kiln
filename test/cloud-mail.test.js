/**
 * The emails Kiln Cloud writes to a customer (worker/mail.js): one when a site
 * is added, one two days before its free trial runs out, one when it has. A
 * trial needs no card, so nobody else can remind the owner, and it used to end
 * in silence. And two for a site Kiln hosts whose paid plan has ended: one
 * when editing stops, with the day the site comes down, and one seven days
 * before that day. Each goes once, to the account's own address, through the
 * send_email binding, and only on a worker that is set up to write to
 * customers. The real handlers run over a SQLite-backed D1 stand-in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../worker/index.js';
import { expireStaleTrials, remindEndingTrials, noticeEndingHosting } from '../worker/cloud.js';
import { mailAddress, dayWords, siteAddedMail, trialEndingMail, trialEndedMail, editingStoppedMail, hostingEndingMail, sendMail, customerMailOn } from '../worker/mail.js';
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

test('customer mail: on the hosting plan, the two trial notices say what happens to the hosted site, and the Kiln Cloud ones do not', async () => {
  const { trialEndingMail, trialEndedMail } = await import('../worker/mail.js');
  const base = { origin: 'https://club.example', endsAt: Date.UTC(2026, 10, 19), dashboard: 'https://app.kilncms.com' };
  for (const mail of [trialEndingMail({ ...base, plan: 'managed' }), trialEndedMail({ ...base, plan: 'managed' })]) {
    assert.match(mail.text, /If Kiln hosts the site, it stays up at its temporary address for three more days and then comes down\./);
    assert.match(mail.text, /subscribing puts the site back up/);
    assert.match(mail.html, /three more days/);
  }
  for (const mail of [trialEndingMail({ ...base, plan: 'cloud' }), trialEndedMail({ ...base, plan: 'cloud' })]) assert.doesNotMatch(mail.text, /hosts the site/);
});


// ── A site Kiln hosts, that was paid for, when its plan has ended ──

const HOSTS = { HOSTING_ACCOUNT_ID: 'acc', HOSTING_API_TOKEN: 'cf-token', HOSTING_SUBDOMAIN: 'kiln-sites' };
/** A hosted site that was paid for: its row, and its record on Kiln's hosting. */
function hosted(env, id, { status = 'canceled', until = null, sub = `sub-${id}`, state = 'live', deployed_at = 5, ...site } = {}) {
  addSite(env, { id, origin: `https://${id}.example`, repo: `ada/${id}`, plan: 'managed', status, ls_subscription_id: sub, created_at: Date.now() - 300 * DAY, ...site });
  env.kiln_cloud.exec('UPDATE sites SET access_until = ? WHERE id = ?', until, id);
  env.kiln_cloud.exec('INSERT INTO hosting (site_id, name, url, state, deployed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    id, `${id}-x`, `https://${id}-x.kiln-sites.workers.dev`, state, deployed_at, 1, 1);
}
const subjects = (mail) => mail.out.filter(m => m && m.subject).map(m => m.subject);

test('the words: a paid site whose plan ended is told the day it comes down, what keeps it up, and that its files are its own', () => {
  const ends = Date.UTC(2027, 0, 15, 9, 0, 0);
  const about = { origin: 'https://rosasbakery.example', plan: 'managed', repo: 'rosa/bakery', endsAt: ends, dashboard: DASH };
  const stopped = editingStoppedMail(about);
  assert.equal(stopped.subject, 'Editing is off for rosasbakery.example, and the site stays online until Friday, January 15');
  assert.match(stopped.text, /The Kiln plan for rosasbakery\.example has ended, so editing through Kiln is switched off for now\./);
  assert.match(stopped.text, /Kiln still hosts the site\. It stays online at its address until Friday, January 15, and then it comes down\./);
  assert.match(stopped.text, /To turn editing back on and keep the site up, press Subscribe on the site's row in your dashboard\. Kiln Cloud \+ hosting is \$14\.99 a month for the site\./);
  assert.match(stopped.text, /Everything on the site is still in your own GitHub repository \(rosa\/bakery\)\. If you would rather move the site to another host, you can do that at any time\./);
  const soon = hostingEndingMail(about);
  assert.equal(soon.subject, 'rosasbakery.example comes down on Friday, January 15');
  assert.match(soon.text, /Kiln hosts rosasbakery\.example, and its plan has ended\. The site comes down on Friday, January 15\./);
  assert.match(soon.text, /To keep it up, press Subscribe on the site's row in your dashboard before then\. Kiln Cloud \+ hosting is \$14\.99 a month/);
  assert.match(soon.text, /Every file stays in your own GitHub repository \(rosa\/bakery\), so you can subscribe later and put the site back up, or move it to another host\./);
  // A payment that failed: the plan is still there, so the card is put right, and nobody is sent to pay twice.
  const failed = [editingStoppedMail({ ...about, pastDue: true }), hostingEndingMail({ ...about, pastDue: true })];
  assert.match(failed[0].text, /The last payment for rosasbakery\.example has not gone through, so editing through Kiln is switched off for now\./);
  assert.match(failed[0].text, /To turn editing back on and keep the site up, open Manage billing in your dashboard and update the card\./);
  assert.match(failed[1].text, /To keep it up, open Manage billing in your dashboard before then and update the card\./);
  for (const m of failed) assert.doesNotMatch(m.text, /Subscribe/);
  for (const m of [stopped, soon, ...failed]) {
    assert.match(m.text, new RegExp(`\\n${DASH}\\n`), 'the dashboard is a line of its own');
    assert.match(m.html, new RegExp(`<a href="${DASH}"`));
    assert.match(m.text, /\n\nKiln\nYou are getting this because rosasbakery\.example was added to Kiln Cloud with this email address\. Reply to this email to reach a person\.\n$/);
    assert.equal(/[—–]|!/.test(m.subject + m.text), false, m.subject);
  }
  assert.doesNotMatch(editingStoppedMail({ ...about, origin: 'https://x.example/"><script>alert(1)</script>', repo: '<b>r</b>' }).html, /<script>|<b>/);
});

test('a paid, hosted site whose plan ended: its owner is told once when editing stops, and once more seven days before it comes down', { skip: d1Skip }, async () => {
  const mail = box();
  const env = cloud(mail, HOSTS);
  const now = Date.now();
  const until = now - 60e3;   // editing stopped a minute ago
  hosted(env, 'club', { until });
  // Sites this is not about: still paid up, paying again, never up, already down, and a free trial that ran out.
  hosted(env, 'paidup', { until: now + 200 * DAY });
  hosted(env, 'back', { status: 'active', until: now - 3 * DAY });
  hosted(env, 'neverup', { until, state: 'waiting', deployed_at: null });
  hosted(env, 'down', { until: now - 40 * DAY, state: 'ended', deployed_at: null });
  hosted(env, 'trial', { sub: null, until: null, created_at: now - 8 * DAY });

  assert.deepEqual(await noticeEndingHosting(env, now), { sent: 1, undated: 0 });
  assert.equal(mail.out.length, 1);
  assert.equal(mail.out[0].to, 'ada@example.com');
  assert.equal(mail.out[0].subject, `Editing is off for club.example, and the site stays online until ${dayWords(until + 30 * DAY)}`);
  assert.match(mail.out[0].text, /still in your own GitHub repository \(ada\/club\)/);
  // five minutes later, the next day, and on day 22: nothing more
  for (const later of [5 * 60e3, DAY, 22.9 * DAY]) assert.equal((await noticeEndingHosting(env, now + later)).sent, 0);
  assert.equal(mail.out.length, 1);
  // seven days before it comes down (day 23): the second one, once
  const day23 = until + 23 * DAY;
  assert.equal((await noticeEndingHosting(env, day23 - 60e3)).sent, 0, 'not before day 23');
  assert.equal((await noticeEndingHosting(env, day23 + 60e3)).sent, 1);
  assert.equal(mail.out[1].subject, `club.example comes down on ${dayWords(until + 30 * DAY)}`);
  for (const later of [day23 + 5 * 60e3, day23 + 3 * DAY, until + 29.9 * DAY]) assert.equal((await noticeEndingHosting(env, later)).sent, 0);
  // on the day itself the sweep takes it down; nothing is written then, or after
  assert.equal((await noticeEndingHosting(env, until + 30 * DAY + 60e3)).sent, 0);
  assert.equal(mail.out.length, 2);

  // Subscribed again (the day is cleared), then stopped again later: that is a new ending, and both go again.
  env.kiln_cloud.exec("UPDATE sites SET status = 'active', access_until = NULL WHERE id = 'club'");
  assert.deepEqual(await noticeEndingHosting(env, until + 40 * DAY), { sent: 0, undated: 0 });
  const again = until + 100 * DAY;
  env.kiln_cloud.exec("UPDATE sites SET status = 'past_due', access_until = ? WHERE id = 'club'", again);
  assert.equal((await noticeEndingHosting(env, again - 60e3)).sent, 0, 'not while it may still be edited');
  assert.equal((await noticeEndingHosting(env, again + 60e3)).sent, 1);
  assert.equal((await noticeEndingHosting(env, again + 24 * DAY)).sent, 1);
  assert.equal((await noticeEndingHosting(env, again + 25 * DAY)).sent, 0);
  assert.deepEqual(subjects(mail).slice(2), [
    `Editing is off for club.example, and the site stays online until ${dayWords(again + 30 * DAY)}`,
    `club.example comes down on ${dayWords(again + 30 * DAY)}`,
  ]);
  assert.match(mail.out[2].text, /open Manage billing in your dashboard and update the card/);
  assert.equal(mail.out.every(m => /club\.example/.test(m.subject)), true, 'nobody else was written to');
});

test('a paid, hosted site first seen in its last week gets the second message alone', { skip: d1Skip }, async () => {
  const mail = box();
  const env = cloud(mail, HOSTS);
  const now = Date.now();
  hosted(env, 'late', { until: now - 25 * DAY });
  assert.equal((await noticeEndingHosting(env, now)).sent, 1);
  assert.equal((await noticeEndingHosting(env, now + 5 * 60e3)).sent, 0);
  assert.deepEqual(subjects(mail), [`late.example comes down on ${dayWords(now + 5 * DAY)}`]);
});

test('the two messages go only to an address, only from a service that writes to customers, and only where Kiln hosts', { skip: d1Skip }, async () => {
  const now = Date.now();
  // no address on the account: skipped, and sent once there is one
  const mail = box();
  const env = cloud(mail, HOSTS);
  env.kiln_cloud.exec('UPDATE accounts SET email = NULL');
  hosted(env, 'club', { until: now - DAY });
  assert.equal((await noticeEndingHosting(env, now)).sent, 0);
  env.kiln_cloud.exec("UPDATE accounts SET email = 'rosa@example.com'");
  assert.equal((await noticeEndingHosting(env, now)).sent, 1);
  assert.equal(mail.out[0].to, 'rosa@example.com');
  // customer mail off: nothing, and nothing fails
  const quiet = box();
  const off = cloud(quiet, { ...HOSTS, CUSTOMER_MAIL_FROM: '' });
  hosted(off, 'club', { until: now - DAY });
  assert.deepEqual(await noticeEndingHosting(off, now), { sent: 0, undated: 0 });
  assert.equal(quiet.out.length, 0);
  // a service that hosts nothing does not look at all
  const none = cloud(box());
  hosted(none, 'club', { until: now - DAY });
  assert.deepEqual(await noticeEndingHosting(none, now), { sent: 0, undated: 0 });
  // a send that fails is tried again at the next run, and never throws
  const flaky = box();
  let fail = true;
  const env2 = cloud({ out: flaky.out, binding: { send: async (m) => { if (fail) throw new Error('quota'); return flaky.binding.send(m); } } }, HOSTS);
  hosted(env2, 'club', { until: now - DAY });
  assert.equal((await noticeEndingHosting(env2, now)).sent, 0);
  fail = false;
  assert.equal((await noticeEndingHosting(env2, now + 5 * 60e3)).sent, 1);
  // a database that cannot be read is not an exception either
  assert.deepEqual(await noticeEndingHosting({ ...env2, kiln_cloud: { prepare: () => { throw new Error('down'); } } }, now), { sent: 0, undated: 0 });
});

test('a run writes to twenty-five people at most, and the rest hear five minutes later', { skip: d1Skip }, async () => {
  const mail = box();
  const env = cloud(mail, HOSTS);
  const now = Date.now();
  for (let i = 0; i < 27; i++) hosted(env, `s${i}`, { until: now - DAY - i });
  assert.equal((await noticeEndingHosting(env, now)).sent, 25);
  assert.equal((await noticeEndingHosting(env, now + 5 * 60e3)).sent, 2);
  assert.equal((await noticeEndingHosting(env, now + 10 * 60e3)).sent, 0);
  assert.equal(new Set(subjects(mail)).size, 27);
});

test('a paid, hosted site with no day on record: its owner is not written to, and the operator is told once', { skip: d1Skip }, async () => {
  const mail = box();
  const env = cloud(mail, { ...HOSTS, NOTIFY_TO: 'ops@example.com' });
  const now = Date.now();
  hosted(env, 'nodate', { until: null });
  hosted(env, 'failed', { status: 'past_due', until: null });
  hosted(env, 'fine', { status: 'active', until: null });
  assert.deepEqual(await noticeEndingHosting(env, now), { sent: 0, undated: 2 });
  assert.deepEqual(await noticeEndingHosting(env, now + 5 * 60e3), { sent: 0, undated: 2 });
  assert.equal(mail.out.length, 1, 'one note for both, and not again');
  assert.equal(mail.out[0].to, 'ops@example.com');
  assert.match(mail.out[0].raw, /Subject: Kiln: 2 hosted sites with a plan that ended and no end date/);
  assert.match(mail.out[0].raw, /ada\/nodate \(https:\/\/nodate\.example\), status canceled/);
  assert.match(mail.out[0].raw, /ada\/failed \(https:\/\/failed\.example\), status past_due/);
  assert.doesNotMatch(mail.out[0].raw, /ada\/fine/);
  // a marker that cannot be written means no note, not a note every five minutes
  const mail2 = box();
  const kv = fakeKV();
  kv.put = async () => { throw new Error('KV write limit'); };
  const env2 = { ...cloud(mail2, { ...HOSTS, NOTIFY_TO: 'ops@example.com' }), KILN: kv };
  hosted(env2, 'nodate', { until: null });
  assert.deepEqual(await noticeEndingHosting(env2, now), { sent: 0, undated: 1 });
  assert.equal(mail2.out.length, 0);
});
