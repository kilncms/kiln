/**
 * One forwarded email address on a hosted site's own domain, as the dashboard
 * asks for it: what stands and whether it is offered, the set-up, "check
 * now", "Send it again", stopping, the lock, the five-minute look at the
 * inboxes that wait, the two emails, and what /cloud/me says (the routes and
 * the job in worker/cloud.js over worker/domain-mail.js, and the mails in
 * worker/mail.js). The real handlers run over the SQLite-backed D1 stand-in,
 * an in-memory Cloudflare that holds the zone's records, its rules and the
 * account's list of inboxes, and a stand-in for the registry and the public
 * DNS. The domains and inboxes are made up. Nothing here touches the network,
 * and no email is sent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { fakeKV, withFetch } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip, schemaFiles } from './d1-fake.js';
import { fakeGitHub } from './github-fake.js';
import { fakeCloudflare, fakeLookups } from './cloudflare-fake.js';
import { domainRow } from '../worker/domain.js';
import { addInbox, forwardRow, saveForward, ownsInbox, publicForward, mailSentence, MAIL_LIMITS } from '../worker/domain-mail.js';
import { domainTookHold, sweepForwards, hostingEndedNote } from '../worker/cloud.js';
import { sweepHosting } from '../worker/hosted.js';
import { forwardOnMail, forwardWaitingMail, dayWords } from '../worker/mail.js';

const N = 'oakbakery.test';
const HELLO = `hello@${N}`;
const N2 = 'oakcafe.test';                // the domain of a second site (secondSite)
const INBOX = 'ada@example.com';       // the account's own address, and the inbox the mail is to reach
const OTHER = 'bea@example.net';
const WORKER = 'club-site1';
const DAY = 86400 * 1000;
const OWN_MAIL = [{ type: 'MX', name: N, content: 'aspmx.l.google.com', priority: 1 }, { type: 'TXT', name: N, content: '"v=spf1 include:_spf.google.com ~all"' }];

const NO_MAIL = [{ type: 'MX', name: N, content: '.', priority: 0 }, { type: 'TXT', name: N, content: '"v=spf1 -all"' }];

/** One account with one hosted site. `mail: true` gives the domain email of its own, which Kiln keeps, and `mail: 'none'` a parked domain's "no mail here". */
function world({ mail = false, env: extra = {} } = {}) {
  const gh = fakeGitHub({ repo: 'ada/club', files: { 'index.html': '<!doctype html><h1>Home</h1>' } });
  const cf = fakeCloudflare();
  const dns = fakeLookups({ [N]: {
    seller: { name: 'GoDaddy.com, LLC', id: 146 }, nameServers: ['ns51.domaincontrol.com', 'ns52.domaincontrol.com'], dnssec: false,
    dns: mail === 'none' ? [{ name: N, type: 'MX', data: '0 .' }, { name: N, type: 'TXT', data: '"v=spf1 -all"' }] : mail ? [{ name: N, type: 'MX', data: '1 aspmx.l.google.com.' }, { name: N, type: 'TXT', data: '"v=spf1 include:_spf.google.com ~all"' }] : [],
  }, [N2]: { seller: { name: 'GoDaddy.com, LLC', id: 146 }, nameServers: ['ns51.domaincontrol.com', 'ns52.domaincontrol.com'], dnssec: false, dns: [] } }, {});
  cf.scanFinds(N, [{ type: 'A', name: N, content: '203.0.113.10' }, { type: 'CNAME', name: `www.${N}`, content: N }, ...(mail === 'none' ? NO_MAIL : mail ? OWN_MAIL : [])]);
  const sent = [];
  const env = cloudEnv(fakeKV({ 'itok:ada/club': 'inst-token' }), {
    HOSTING_ACCOUNT_ID: cf.account, HOSTING_API_TOKEN: cf.token, HOSTING_SUBDOMAIN: 'kiln-sites',
    NOTIFY: { send: async (m) => { sent.push(m); return { messageId: '<1@kilncms.com>' }; } }, CUSTOMER_MAIL_FROM: 'hello@kilncms.com', CLOUD_DASHBOARD: 'https://app.example',
    ...extra,
  });
  addSite(env, { id: 'site1', plan: 'managed', status: 'trialing' });
  cf.addScript(WORKER);
  env.kiln_cloud.exec('INSERT INTO hosting (site_id, name, url, state, deployed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', 'site1', WORKER, `https://${WORKER}.kiln-sites.workers.dev`, 'live', 1, 1, 1);
  const up = new Set();
  const handler = async (url, init) => (up.has(new URL(url).host) ? new Response('<!doctype html><h1>Home</h1>', { status: 200 })
    : (await cf.handler(url, init)) || (await dns.handler(url, init)) || gh.handler(url, init));
  // The mails about forwarding only: the domain's own set-up writes to the owner too.
  return { cf, env, handler, sent, answers: (...names) => { up.clear(); for (const n of names) up.add(n); }, mails: () => sent.filter(m => m.subject && /now reaches|is waiting for/.test(m.subject)), notes: () => sent.filter(m => m.raw) };
}
const ask = (env, method, pathname, body) => worker.fetch(new Request(`https://worker.example${pathname}`, {
  method, headers: { Authorization: 'Bearer tok', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}), env);
const hush = async (fn) => { const log = console.log, warn = console.warn; const lines = []; console.log = console.warn = (l) => lines.push(String(l)); try { await fn(); } finally { console.log = log; console.warn = warn; } return lines; };
const plain = (s) => { assert.doesNotMatch(s, /[—–]/); assert.doesNotMatch(s, /undefined|null|\[object/); assert.match(s, /^[A-Z].*\.$/); };
const sentences = (s) => s.match(/[^.]+(?:\.[a-z][^.]*)*\./g).map(x => x.trim());

const standing = async (env) => (await ask(env, 'GET', '/cloud/sites/mail?site=site1')).json();
const post = (env, action, more = {}) => ask(env, 'POST', '/cloud/sites/mail', { id: 'site1', action, ...more });
const setup = (env, local = 'hello', inbox = INBOX) => post(env, 'setup', { local, inbox });
const rowOf = (env) => forwardRow(env, 'site1');
const rules = (w) => w.cf.rulesOf(N).map(r => `${r.matchers[0].value} > ${r.actions[0].value.join(',')}`);
const routed = (w) => w.cf.recordsOf(N).filter(r => r.type === 'MX').map(r => r.content).sort();
const mailCalls = (calls) => calls.filter(c => /\/email\/routing/.test(c.url));
const editingOff = (env) => env.kiln_cloud.exec("UPDATE sites SET status = 'expired' WHERE id = 'site1'");
const longAgo = (env, days) => env.kiln_cloud.exec("UPDATE forwards SET created_at = ?, asked_at = ? WHERE site_id = 'site1'", Date.now() - days * DAY - 1000, Date.now() - days * DAY - 1000);

/** The site's domain: set up and waiting, or live when `live` is not false. */
async function withDomain(w, { live = true } = {}) {
  await hush(async () => {
    assert.equal((await ask(w.env, 'POST', '/cloud/sites/domain', { id: 'site1', action: 'setup', name: N })).status, 200);
    if (!live) return;
    w.cf.setStatus(N, 'active');
    w.answers(N);
    assert.deepEqual(await domainTookHold(w.env, { site: { id: 'site1' }, row: await domainRow(w.env, 'site1') }), { live: true });
  });
}
/** A live domain with hello@ asked for and its inbox still to confirm. */
async function waiting(w) { await withDomain(w); assert.equal((await setup(w.env)).status, 200); }
/** A site of another Kiln customer (or, with `account: 'acct-1'`, a second site of this one) that forwards to an inbox: confirmed and on, or still waiting. */
async function otherSite(w, { account = 'acct-2', inbox = OTHER, confirmed = true } = {}) {
  if (account !== 'acct-1') w.env.kiln_cloud.exec('INSERT INTO accounts (id, github_login, email, created_at) VALUES (?,?,?,?)', account, 'bea', inbox, 1);
  addSite(w.env, { id: 'site9', account_id: account, repo: 'bea/shop', origin: 'https://shop.example', plan: 'managed' });
  const box = await addInbox(w.env, { email: inbox });
  if (confirmed) w.cf.confirm(inbox);
  await saveForward(w.env, 'site9', { address: 'hi@beashop.test', inbox, inbox_id: box.id, state: confirmed ? 'on' : 'confirming', rule_id: confirmed ? 'rule-9' : null, asked_at: Date.now() });
}
const NONE = { looked: 0, on: 0, reminded: 0, gaveUp: 0, failed: 0 };
/** A live domain with hello@ reaching the inbox. */
async function forwarding(w) { await waiting(w); w.cf.confirm(INBOX); await hush(async () => assert.equal((await post(w.env, 'check')).status, 200)); assert.equal((await rowOf(w.env)).state, 'on'); }

// ─── What stands, and whether it is offered ───────────────────────────────────

test('forwarding: it is offered only at a live domain with no email of its own, and each other case says why in a sentence', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async (calls) => {
    assert.deepEqual(await standing(w.env), { ok: true, forward: null, offered: false, why: mailSentence('no_domain') });
    await withDomain(w, { live: false });
    assert.deepEqual(await standing(w.env), { ok: true, forward: null, offered: false, why: mailSentence('not_live', { name: N }) });
    assert.match(mailSentence('not_live', { name: N }), /^oakbakery\.test is not live on Kiln yet\. Finish setting up the domain first/);
    calls.length = 0;
    const res = await setup(w.env);
    assert.deepEqual([res.status, (await res.json()).code], [409, 'not_live']);
    assert.equal(mailCalls(calls).length, 0, 'Cloudflare is not asked about mail for a domain that is not live');
    assert.equal(await rowOf(w.env), null);
  });
  const live = world();
  await withFetch(live.handler, async () => {
    await withDomain(live);
    assert.deepEqual(await standing(live.env), { ok: true, forward: null, offered: true, why: null });
    editingOff(live.env);
    assert.deepEqual(await standing(live.env), { ok: true, forward: null, offered: false, why: mailSentence('plan_ended') });
  });
  for (const code of ['no_domain', 'plan_ended', 'busy', 'no_forward', 'bad_action']) for (const s of sentences(mailSentence(code))) plain(s);
  for (const s of sentences(mailSentence('never_confirmed', { address: HELLO, inbox: INBOX }))) plain(s);
});

test('forwarding: a domain with email of its own is never touched, and the row says that email keeps working', { skip: d1Skip }, async () => {
  const w = world({ mail: true });
  await withFetch(w.handler, async (calls) => {
    await withDomain(w);
    const before = routed(w);
    assert.deepEqual(before, ['aspmx.l.google.com']);
    const shown = await standing(w.env);
    assert.deepEqual([shown.offered, shown.why], [false, `${N} has email of its own, which keeps working as it is. Kiln changes nothing there. To forward an address, set that up with the company that runs that email.`]);
    calls.length = 0;
    const res = await setup(w.env);
    const body = await res.json();
    assert.deepEqual([res.status, body.code, body.error], [409, 'has_own_mail', shown.why]);
    assert.equal(mailCalls(calls).length, 0);
    // The account's own list says so on the site's domain, so the dashboard shows that sentence and no button.
    const me = await (await ask(w.env, 'GET', '/cloud/me')).json();
    assert.deepEqual([me.forwarding, me.sites[0].domain.own_mail, me.sites[0].forward], [true, true, null]);
    assert.deepEqual(routed(w), before);
    assert.equal(await rowOf(w.env), null);
  });
});

test('forwarding: a parked domain that says "no mail here" is offered forwarding, is told first that its two records are replaced, and has them replaced by the set-up', { skip: d1Skip }, async () => {
  const w = world({ mail: 'none' });
  await withFetch(w.handler, async () => {
    await withDomain(w);
    assert.deepEqual(routed(w), ['.']);
    const shown = await standing(w.env);
    assert.deepEqual([shown.offered, shown.why, shown.note], [true, null, `${N} says today that it takes no email. When you forward an address, Kiln replaces the two records that say so, and the domain takes email for that one address.`]);
    for (const s of sentences(mailSentence('says_no_mail'))) plain(s);
    assert.equal((await setup(w.env)).status, 200);
    assert.deepEqual(routed(w), ['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net', 'route3.mx.cloudflare.net']);
    assert.equal(w.cf.recordsOf(N).some(r => r.type === 'TXT' && /v=spf1 -all/.test(r.content)), false);
    assert.equal('note' in (await standing(w.env)), false, 'an address that is asked for needs no such word');
  });
});

test('forwarding: a service whose database has no table for it says so, offers nothing, and /cloud/me leaves it out', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await withDomain(w);
    w.env.kiln_cloud.exec('DROP TABLE forwards');
    assert.deepEqual(await standing(w.env), { ok: true, forward: null, offered: false, why: mailSentence('not_set_up') });
    const res = await setup(w.env);
    assert.deepEqual([res.status, (await res.json()).error], [503, mailSentence('not_set_up')]);
    const me = await (await ask(w.env, 'GET', '/cloud/me')).json();
    assert.deepEqual([me.domains, me.forwarding, me.sites[0].forward], [true, false, null]);
    assert.deepEqual(await sweepForwards(w.env), { looked: 0, on: 0, reminded: 0, gaveUp: 0, failed: 0 });
  });
});

// ─── The set-up ───────────────────────────────────────────────────────────────

test('forwarding: what was typed is cleaned and refused with a sentence before anything is asked of Cloudflare', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async (calls) => {
    await withDomain(w);
    calls.length = 0;
    for (const [local, inbox, code] of [['he llo', INBOX, 'not_an_address'], ['', INBOX, 'not_an_address'], ['hello', 'ada at example', 'not_an_address'], ['hello', `me@${N}`, 'same_domain'], ['hello@elsewhere.test', INBOX, 'not_an_address']]) {
      const res = await setup(w.env, local, inbox);
      const body = await res.json();
      assert.deepEqual([res.status, body.code, body.error], [400, code, mailSentence(code, { name: N })], `${local} > ${inbox}`);
      for (const s of sentences(body.error.replace(/you@example\.com/, 'an address'))) plain(s);
    }
    assert.equal(mailCalls(calls).length, 0);
    assert.equal(await rowOf(w.env), null);
    const bad = await post(w.env, 'paint');
    assert.deepEqual([bad.status, (await bad.json()).error], [400, mailSentence('bad_action')]);
  });
});

test('forwarding: a set-up switches mail on for the domain, has Cloudflare write to the inbox, and waits: no rule and no mail until the inbox confirms', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await withDomain(w);
    const res = await setup(w.env, ' Hello ', ' Ada@Example.com ');
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual({ ...body, forward: { ...body.forward, since: 0, gives_up_at: 0 } }, { ok: true, sent: true, forward: { address: HELLO, inbox: INBOX, state: 'confirming', since: 0, on_at: null, gives_up_at: 0 } });
    assert.deepEqual(routed(w), ['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net', 'route3.mx.cloudflare.net']);
    assert.deepEqual(w.cf.confirmations, [INBOX]);
    assert.deepEqual(rules(w), []);
    assert.equal(w.mails().length, 0);
    const row = await rowOf(w.env);
    assert.ok(row.inbox_id && row.asked_at && !row.rule_id);
    assert.deepEqual((await standing(w.env)).forward, publicForward(row));
    assert.equal(await w.env.KILN.get('forwardlock:site1'), null, 'the lock is given back');
    // "Check now" before the button was pressed: it still waits.
    const early = await (await post(w.env, 'check')).json();
    assert.deepEqual([early.ok, early.forward.state], [true, 'confirming']);
    assert.deepEqual(rules(w), []);
    const me = await (await ask(w.env, 'GET', '/cloud/me')).json();
    assert.equal(me.forwarding, true);
    assert.deepEqual(me.sites[0].forward, publicForward(row));
    // A waiting set-up says the day Kiln stops waiting, and a domain with no email of its own is not marked as having one.
    assert.deepEqual([me.sites[0].forward.gives_up_at, 'own_mail' in me.sites[0].domain], [row.created_at + 30 * 86400000, false]);
  });
});

test('forwarding: the address the account signs in with at Google, confirmed before, gets no second email, and the address is on at once', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await withDomain(w);
    // The address typed on the account proves nothing. The one Google confirmed for the account does.
    w.env.kiln_cloud.exec("UPDATE accounts SET google_sub = 'g-ada', google_email = ? WHERE id = 'acct-1'", INBOX);
    await addInbox(w.env, { email: INBOX });
    w.cf.confirm(INBOX);
    let body;
    await hush(async () => { body = await (await setup(w.env)).json(); });
    assert.deepEqual([body.ok, body.sent, body.forward.state, typeof body.forward.on_at], [true, false, 'on', 'number']);
    assert.deepEqual(w.cf.confirmations, [INBOX], 'only the first asking sent an email');
    assert.deepEqual(rules(w), [`${HELLO} > ${INBOX}`]);
    assert.deepEqual(w.mails().map(m => m.subject), [`${HELLO} now reaches ${INBOX}`]);
    // Asking for the same again changes nothing and asks nobody.
    const again = await (await setup(w.env)).json();
    assert.deepEqual([again.forward.state, again.sent], ['on', false]);
    assert.equal(w.mails().length, 1);
  });
});

test('forwarding: an inbox that confirmed for another customer is refused in one sentence that gives nothing away, and nothing is made at Cloudflare', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await withDomain(w);
    await otherSite(w);
    const before = { mx: routed(w), calls: w.cf.calls.length };
    const res = await setup(w.env, 'hello', OTHER);
    const body = await res.json();
    assert.deepEqual([res.status, body.code, body.forward], [409, 'inbox_elsewhere', null]);
    assert.equal(body.error, 'Kiln cannot confirm that inbox by itself. Write to info@kilncms.com and we will set it up with you.');
    assert.equal(body.error, mailSentence('inbox_elsewhere', { address: HELLO, inbox: OTHER, name: N }), 'the sentence names nobody and nothing');
    for (const s of sentences(body.error)) plain(s);
    assert.equal(await rowOf(w.env), null);
    assert.deepEqual([rules(w), routed(w), w.cf.confirmations], [[], before.mx, [OTHER]], 'no rule, no mail records, and no email to the inbox');
    assert.deepEqual(w.cf.calls.slice(before.calls).filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`), [], 'Cloudflare was only read');
    assert.equal(w.mails().length, 0);
  });
});

test('forwarding: an inbox that another site of the same account already forwards to is on at once, with no email to it', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await withDomain(w);
    await otherSite(w, { account: 'acct-1' });
    let body;
    await hush(async () => { body = await (await setup(w.env, 'hello', OTHER)).json(); });
    assert.deepEqual([body.ok, body.sent, body.forward.state, body.forward.inbox], [true, false, 'on', OTHER]);
    assert.deepEqual(w.cf.confirmations, [OTHER], 'the inbox was written to once, for the first site');
    assert.deepEqual(rules(w), [`${HELLO} > ${OTHER}`]);
    assert.deepEqual(w.mails().map(m => [m.to, m.subject]), [[INBOX, `${HELLO} now reaches ${OTHER}`]]);
  });
});

// ─── Whose a row is, after its site was removed ───────────────────────────────

const askAs = (env, token, pathname, body) => worker.fetch(new Request(`https://worker.example${pathname}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), env);
const rulesAt = (w, name) => w.cf.rulesOf(name).map(r => `${r.matchers[0].value} > ${r.actions[0].value.join(',')}`);
const owns = (env, accountId, inbox) => ownsInbox(env, { accountId, inbox });
/** A second hosted site ('site2') on a live domain of its own, with nothing forwarded: this account's, or another customer's who is signed in with `token`. */
async function secondSite(w, { account = 'acct-1', token = 'tok' } = {}) {
  if (account !== 'acct-1') {
    w.env.kiln_cloud.exec('INSERT INTO accounts (id, github_login, email, created_at) VALUES (?,?,?,?)', account, 'bea', OTHER, 1);
    w.env.KILN.map.set(`csess:${token}`, JSON.stringify({ account_id: account, login: 'bea', gh: 'gho_y' }));
  }
  // This account's second site is the repository it removed, added again: the one repository GitHub lets it reach here.
  addSite(w.env, { id: 'site2', account_id: account, repo: account === 'acct-1' ? 'ada/club' : 'bea/cafe', origin: 'https://cafe.example', plan: 'managed', status: 'active' });
  w.cf.addScript('cafe-site2');
  w.env.kiln_cloud.exec('INSERT INTO hosting (site_id, name, url, state, deployed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', 'site2', 'cafe-site2', 'https://cafe-site2.kiln-sites.workers.dev', 'live', 1, 1, 1);
  w.cf.scanFinds(N2, [{ type: 'A', name: N2, content: '203.0.113.10' }]);
  await hush(async () => {
    assert.equal((await askAs(w.env, token, '/cloud/sites/domain', { id: 'site2', action: 'setup', name: N2 })).status, 200);
    w.cf.setStatus(N2, 'active');
    w.answers(N2);
    assert.deepEqual(await domainTookHold(w.env, { site: { id: 'site2' }, row: await domainRow(w.env, 'site2') }), { live: true });
  });
}
/** hello@ reaches the inbox, and then its owner removes the site. The row and the rule stay, as they are meant to. */
async function removedWhileForwarding(w) {
  await forwarding(w);
  const row = await rowOf(w.env);
  assert.equal(row.account_id, 'acct-1', 'the row names the account it was set up for');
  await hush(async () => assert.equal((await ask(w.env, 'POST', '/cloud/sites/remove', { id: 'site1' })).status, 200));
  assert.equal(w.env.kiln_cloud.row("SELECT id FROM sites WHERE id = 'site1'"), null, 'the site is gone from the account');
  assert.deepEqual([await rowOf(w.env), rules(w)], [row, [`${HELLO} > ${INBOX}`]], 'and its address goes on forwarding');
  return row;
}

test('forwarding: after a site is removed, its owner asks for the same inbox on a new site and it is on at once, with no email to the inbox', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    const left = await removedWhileForwarding(w);
    await secondSite(w);
    const before = { confirmations: [...w.cf.confirmations], mails: w.mails().length };
    let res, body;
    await hush(async () => { res = await askAs(w.env, 'tok', '/cloud/sites/mail', { id: 'site2', action: 'setup', local: 'hello', inbox: INBOX }); body = await res.json(); });
    assert.deepEqual([res.status, body.ok, body.sent, body.forward.state, body.forward.address, body.forward.inbox], [200, true, false, 'on', `hello@${N2}`, INBOX]);
    assert.deepEqual(w.cf.confirmations, before.confirmations, 'Cloudflare wrote to the inbox once, for the first site, and not again');
    assert.deepEqual(rulesAt(w, N2), [`hello@${N2} > ${INBOX}`]);
    assert.deepEqual(w.mails().slice(before.mails).map(m => m.subject), [`hello@${N2} now reaches ${INBOX}`]);
    assert.equal((await forwardRow(w.env, 'site2')).account_id, 'acct-1');
    assert.deepEqual([await rowOf(w.env), rules(w)], [left, [`${HELLO} > ${INBOX}`]], 'the removed site\'s row and rule are untouched');
  });
});

test('forwarding: after a site is removed, another customer who asks for its inbox is still refused, and nothing is made at Cloudflare', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    const left = await removedWhileForwarding(w);
    await secondSite(w, { account: 'acct-2', token: 'tok2' });
    const before = { calls: w.cf.calls.length, confirmations: [...w.cf.confirmations], mails: w.mails().length };
    const res = await askAs(w.env, 'tok2', '/cloud/sites/mail', { id: 'site2', action: 'setup', local: 'hello', inbox: INBOX });
    const body = await res.json();
    assert.deepEqual([res.status, body.code, body.forward], [409, 'inbox_elsewhere', null]);
    assert.equal(body.error, 'Kiln cannot confirm that inbox by itself. Write to info@kilncms.com and we will set it up with you.');
    assert.deepEqual(w.cf.calls.slice(before.calls).filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`), [], 'Cloudflare was only read');
    assert.deepEqual([await forwardRow(w.env, 'site2'), rulesAt(w, N2), w.cf.confirmations, w.mails().length], [null, [], before.confirmations, before.mails], 'no row, no rule and no email');
    assert.deepEqual([await owns(w.env, 'acct-1', INBOX), await owns(w.env, 'acct-2', INBOX)], [true, false]);
    assert.deepEqual([await rowOf(w.env), rules(w)], [left, [`${HELLO} > ${INBOX}`]], 'the removed site\'s row is still its first owner\'s, and still forwards');
  });
});

test('forwarding: a row written before rows named their account counts for its site\'s account as before, and the migration gives it that account', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await otherSite(w, { account: 'acct-1' });   // saved with no account, as every row was
    assert.equal((await forwardRow(w.env, 'site9')).account_id, null);
    assert.deepEqual([await owns(w.env, 'acct-1', OTHER), await owns(w.env, 'acct-2', OTHER)], [true, false]);
    // What migration 0011 does to the rows it finds: each takes its site's account. A row whose site is gone already stays
    // without one and shows nothing for anybody, as before.
    await saveForward(w.env, 'gone', { address: 'hi@gone.test', inbox: 'cy@example.org', state: 'on', rule_id: 'rule-0' });
    const fill = readFileSync(schemaFiles().find(f => f.endsWith('0011_forward_account.sql')), 'utf8').match(/^UPDATE forwards[^;]+;/m)[0];
    w.env.kiln_cloud.db.exec(fill);
    assert.deepEqual([(await forwardRow(w.env, 'site9')).account_id, (await forwardRow(w.env, 'gone')).account_id], ['acct-1', null]);
    assert.deepEqual([await owns(w.env, 'acct-1', OTHER), await owns(w.env, 'acct-2', OTHER), await owns(w.env, 'acct-1', 'cy@example.org')], [true, false, false]);
  });
});

test('forwarding: the account a row names is written once, to a row that has none, and no later write replaces it', { skip: d1Skip }, async () => {
  const { env } = world();
  const named = async (id) => (await forwardRow(env, id)).account_id;
  await saveForward(env, 'site1', { address: HELLO, inbox: INBOX, account_id: 'acct-1' });
  assert.equal(await named('site1'), 'acct-1');
  await saveForward(env, 'site1', { state: 'on', rule_id: 'rule-1', account_id: 'acct-2' });
  await saveForward(env, 'site1', { account_id: null });
  await saveForward(env, 'site1', { account_id: '' });
  await saveForward(env, 'site1', {});
  assert.deepEqual([await named('site1'), (await rowOf(env)).state, (await rowOf(env)).rule_id], ['acct-1', 'on', 'rule-1']);
  // A row that has none takes the first account it is given, and keeps that one.
  await saveForward(env, 'site9', { address: 'hi@beashop.test', inbox: OTHER });
  assert.equal(await named('site9'), null);
  await saveForward(env, 'site9', { account_id: 'acct-2' });
  await saveForward(env, 'site9', { state: 'on', account_id: 'acct-1' });
  assert.deepEqual([await named('site9'), (await forwardRow(env, 'site9')).state], ['acct-2', 'on']);
});

test('forwarding: on a database where rows cannot name their account yet, an inbox is an account\'s own through its site as before, and nothing throws', { skip: d1Skip }, async () => {
  const w = world({ env: { d1: { upTo: schemaFiles().findIndex(f => f.endsWith('0011_forward_account.sql')) } } });
  await withFetch(w.handler, async () => {
    assert.throws(() => w.env.kiln_cloud.row('SELECT account_id FROM forwards LIMIT 1'), /no such column/, 'migration 0011 has not reached this database');
    await otherSite(w, { account: 'acct-1' });
    assert.deepEqual([await owns(w.env, 'acct-1', OTHER), await owns(w.env, 'acct-2', OTHER), await owns(w.env, 'acct-1', INBOX)], [true, false, false]);
    // A write that names the account is made without it there, for a new row and for one that stands.
    assert.equal(await saveForward(w.env, 'site8', { address: 'yo@elsewhere.test', inbox: 'cy@example.org', account_id: 'acct-1' }), true);
    assert.equal(await saveForward(w.env, 'site8', { state: 'on', rule_id: 'rule-8', account_id: 'acct-1' }), true);
    assert.deepEqual([(await forwardRow(w.env, 'site8')).state, (await forwardRow(w.env, 'site8')).rule_id], ['on', 'rule-8']);
    // The dashboard's set-up works there as it did: an inbox another site of the account forwards to is on at once.
    await withDomain(w);
    let body;
    await hush(async () => { body = await (await setup(w.env, 'hello', OTHER)).json(); });
    assert.deepEqual([body.ok, body.sent, body.forward.state, rules(w)], [true, false, 'on', [`${HELLO} > ${OTHER}`]]);
  });
});

test('forwarding: an inbox another customer still waits for is refused, and one that nobody waits for any more is written to afresh', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await withDomain(w);
    await otherSite(w, { confirmed: false });
    const res = await setup(w.env, 'hello', OTHER);
    assert.deepEqual([res.status, (await res.json()).code], [409, 'inbox_elsewhere']);
    assert.deepEqual([await rowOf(w.env), w.cf.confirmations], [null, [OTHER]]);
    // The other customer gave up on it: the inbox is still on Cloudflare's list, and nobody waits for it.
    w.env.kiln_cloud.exec("DELETE FROM forwards WHERE site_id = 'site9'");
    const body = await (await setup(w.env, 'hello', OTHER)).json();
    assert.deepEqual([body.sent, body.forward.state], [true, 'confirming']);
    assert.deepEqual(w.cf.confirmations, [OTHER, OTHER], 'Cloudflare writes to the inbox at this account\'s asking');
    w.cf.confirm(OTHER);
    await hush(async () => { await post(w.env, 'check'); });
    assert.deepEqual([(await rowOf(w.env)).state, rules(w)], ['on', [`${HELLO} > ${OTHER}`]]);
  });
});

test('forwarding: a confirmed inbox that was left on Cloudflare\'s list with no address forwarding to it is written to afresh, not refused', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await withDomain(w);
    // What a stop left behind before Kiln took inboxes off the list: confirmed at Cloudflare, and no row of anybody's names it.
    const old = await addInbox(w.env, { email: INBOX });
    w.cf.confirm(INBOX);
    const res = await setup(w.env);
    const body = await res.json();
    assert.deepEqual([res.status, body.ok, body.sent, body.forward.state], [200, true, true, 'confirming']);
    assert.deepEqual(w.cf.confirmations, [INBOX, INBOX], 'Cloudflare writes to the inbox at this asking');
    const now = w.cf.addresses.get(INBOX);
    assert.ok(now.id !== old.id && !now.verified, 'the inbox has to press the button again');
    const row = await rowOf(w.env);
    assert.ok(row.inbox_id === now.id && Date.now() - row.asked_at < 5000 && !row.rule_id);
    assert.deepEqual([rules(w), w.mails().length], [[], 0], 'no rule and no "now reaches" until it does');
    w.cf.confirm(INBOX);
    await hush(async () => { assert.equal((await post(w.env, 'check')).status, 200); });
    assert.deepEqual([(await rowOf(w.env)).state, rules(w)], ['on', [`${HELLO} > ${INBOX}`]]);
  });
});

test('forwarding: if Cloudflare took a left-behind inbox as confirmed the moment it was put back, no rule is made for it and the asker is refused', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await withDomain(w);
    await addInbox(w.env, { email: INBOX });
    w.cf.confirm(INBOX);
    w.cf.remembers = new Set([INBOX]);   // not how Cloudflare behaved when it was tried, and the service must not rest on that
    const res = await setup(w.env);
    const body = await res.json();
    assert.deepEqual([res.status, body.code, body.forward], [409, 'inbox_elsewhere', null]);
    assert.deepEqual([await rowOf(w.env), rules(w), w.mails().length], [null, [], 0], 'no row, no rule, no mail');
  });
});

test('forwarding: an address typed on the Kiln account is no proof of an inbox, and the address Google confirmed for the account is', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await withDomain(w);
    await otherSite(w);   // another customer's site forwards to the inbox, which has confirmed
    const refused = async (why) => {
      const before = w.cf.calls.length;
      const res = await setup(w.env, 'hello', OTHER);
      assert.deepEqual([res.status, (await res.json()).code], [409, 'inbox_elsewhere'], why);
      assert.deepEqual([await rowOf(w.env), rules(w), w.cf.confirmations], [null, [], [OTHER]], why);
      assert.deepEqual(w.cf.calls.slice(before).filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`), [], 'Cloudflare was only read');
    };
    // Anybody can type any address on their account in the dashboard, and nobody checks it.
    w.env.kiln_cloud.exec("UPDATE accounts SET email = ? WHERE id = 'acct-1'", OTHER);
    await refused('the typed address is no proof');
    // An address in the Google column proves nothing either while the account does not sign in with Google.
    w.env.kiln_cloud.exec("UPDATE accounts SET google_email = ? WHERE id = 'acct-1'", OTHER);
    await refused('no Google sign-in, no proof');
    // The account signs in with Google, and Google confirmed this address for it (however it is written).
    w.env.kiln_cloud.exec("UPDATE accounts SET google_sub = 'g-ada', google_email = ? WHERE id = 'acct-1'", ' Bea@Example.NET ');
    let body;
    await hush(async () => { body = await (await setup(w.env, 'hello', OTHER)).json(); });
    assert.deepEqual([body.ok, body.sent, body.forward.state, body.forward.inbox], [true, false, 'on', OTHER]);
    assert.deepEqual(w.cf.confirmations, [OTHER], 'no email to the inbox');
    assert.deepEqual(rules(w), [`${HELLO} > ${OTHER}`]);
  });
});

test('forwarding: the every-minute timer switches an address on about a minute after its inbox pressed the button, does nothing else, and stands back on the minutes the five-minute timer runs', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await withDomain(w);
    assert.equal((await setup(w.env)).status, 200);
    w.cf.confirm(INBOX);
    const at = (minute) => Date.UTC(2026, 10, 13, 16, minute, 0);
    // On a minute the five-minute timer runs, the every-minute one leaves it to that one.
    await hush(async () => { await worker.scheduled({ cron: '* * * * *', scheduledTime: at(35) }, w.env, { waitUntil() {} }); });
    assert.deepEqual([(await rowOf(w.env)).state, rules(w)], ['confirming', []]);
    // On any other minute it looks, and makes the rule.
    const calls = w.cf.calls.length;
    await hush(async () => { await worker.scheduled({ cron: '* * * * *', scheduledTime: at(33) }, w.env, { waitUntil() {} }); });
    assert.deepEqual([(await rowOf(w.env)).state, rules(w)], ['on', [`${HELLO} > ${INBOX}`]]);
    assert.ok(w.cf.calls.slice(calls).every(c => /email\/routing/.test(c.path)), 'it asks Cloudflare about mail only: no site is published or looked at by this timer');
    // The five-minute timer's name is no name of the every-minute one: it runs everything, as before.
    assert.match(readFileSync(new URL('../worker/wrangler.toml', import.meta.url), 'utf8'), /\[env\.production\.triggers\][^\[]*crons = \["\*\/5 \* \* \* \*", "\* \* \* \* \*"\]/, 'production has both timers');
  });
});

test('forwarding: a row left waiting for an inbox that confirmed for another customer gets no rule from "check now", "Send it again" or the five-minute job', { skip: d1Skip }, async () => {
  for (const how of ['check', 'again', 'job']) {
    const w = world();
    await withFetch(w.handler, async () => {
      await withDomain(w);
      await otherSite(w);
      const box = await addInbox(w.env, { email: OTHER });
      await saveForward(w.env, 'site1', { address: HELLO, inbox: OTHER, inbox_id: box.id, state: 'confirming' });   // as a set-up saved it before this was guarded
      let res;
      await hush(async () => { res = how === 'job' ? await sweepForwards(w.env) : await post(w.env, how); });
      if (how === 'job') assert.deepEqual(res, { ...NONE, looked: 1, gaveUp: 1 });
      else {
        const body = await res.json();
        assert.deepEqual([res.status, body.code, body.error, body.forward.state, body.forward.error], [409, 'inbox_elsewhere', mailSentence('inbox_elsewhere'), 'failed', mailSentence('inbox_elsewhere')], how);
      }
      const row = await rowOf(w.env);
      assert.deepEqual([row.state, row.reason, row.rule_id], ['failed', 'inbox_elsewhere', null], how);
      assert.deepEqual([rules(w), w.cf.confirmations, w.mails().length], [[], [OTHER], 0], how);
      assert.deepEqual(await sweepForwards(w.env), NONE, 'it is not asked about again');
    });
  }
});

// ─── Check now ────────────────────────────────────────────────────────────────

test('forwarding: "check now" after the inbox confirmed makes the one rule, marks the address on and writes to the owner once', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    const none = await post(w.env, 'check');
    assert.deepEqual([none.status, (await none.json()).error], [404, mailSentence('no_forward')]);
    await waiting(w);
    w.cf.confirm(INBOX);
    let body;
    const lines = await hush(async () => { body = await (await post(w.env, 'check')).json(); });
    assert.equal(body.forward.state, 'on');
    assert.ok(body.forward.on_at);
    assert.deepEqual(rules(w), [`${HELLO} > ${INBOX}`]);
    const row = await rowOf(w.env);
    assert.equal(row.rule_id, w.cf.rulesOf(N)[0].id);
    assert.ok(lines.some(l => /"evt":"forward_on"/.test(l)) && !lines.some(l => l.includes(INBOX)), 'the log names the address and never the inbox');
    assert.equal(w.mails().length, 1);
    assert.equal(w.mails()[0].text, forwardOnMail({ address: HELLO, inbox: INBOX, dashboard: 'https://app.example' }).text);
    await hush(async () => { await post(w.env, 'check'); await sweepForwards(w.env); });
    assert.equal(w.mails().length, 1);
    assert.equal(rules(w).length, 1);
  });
});

test('forwarding: a change to a new inbox waits beside the address that works, which stays on until the new inbox confirms, and then one rule reaches the new one', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await forwarding(w);
    await tick();
    const was = await rowOf(w.env);
    const body = await (await setup(w.env, 'post', OTHER)).json();
    assert.deepEqual([body.forward.address, body.forward.inbox, body.forward.state, body.forward.on_at, body.sent], [HELLO, INBOX, 'on', was.on_at, true], 'the address that works stays on');
    assert.deepEqual([body.forward.changing_to.address, body.forward.changing_to.inbox, Date.now() - body.forward.changing_to.since < 5000], [`post@${N}`, OTHER, true]);
    // The day Kiln stops waiting belongs to the change, 30 days after it was asked for. The address that works has no such day.
    assert.deepEqual([body.forward.changing_to.gives_up_at, 'gives_up_at' in body.forward], [body.forward.changing_to.since + 30 * 86400000, false]);
    const kept = await rowOf(w.env);
    assert.deepEqual([kept.address, kept.inbox, kept.state, kept.rule_id, kept.created_at, kept.on_at], [HELLO, INBOX, 'on', was.rule_id, was.created_at, was.on_at], 'the row that works is as it was');
    assert.ok(kept.want_inbox_id && kept.want_asked_at && kept.want_since);
    assert.deepEqual((await standing(w.env)).forward, body.forward, 'the look says the same');
    const me = await (await ask(w.env, 'GET', '/cloud/me')).json();
    assert.deepEqual(me.sites.find(s => s.id === 'site1').forward, body.forward, 'and so does the account page');
    assert.deepEqual((await (await post(w.env, 'check')).json()).forward, body.forward, 'a check before the new inbox confirmed changes nothing');
    assert.deepEqual(rules(w), [`${HELLO} > ${INBOX}`], 'the old address still reaches the old inbox');
    w.cf.confirm(OTHER);
    await hush(async () => { await post(w.env, 'check'); });
    assert.deepEqual(rules(w), [`post@${N} > ${OTHER}`], 'one address for a site: the old one stopped as the new one began');
    assert.deepEqual(w.mails().map(m => m.subject), [`${HELLO} now reaches ${INBOX}`, `post@${N} now reaches ${OTHER}`]);
    assert.equal(w.mails()[1].to, INBOX, 'the account is written to at its own address');
    const row = await rowOf(w.env);
    assert.deepEqual([row.address, row.inbox, row.state, row.want_address, row.want_inbox, row.want_inbox_id, row.want_asked_at, row.want_since], [POST, OTHER, 'on', null, null, null, null, null]);
    assert.deepEqual(Object.keys((await standing(w.env)).forward), ['address', 'inbox', 'state', 'since', 'on_at'], 'no change waits any more');
  });
});

const POST = `post@${N}`;
/** A change is asked for later than the address it changes. The mail about each is sent once for the millisecond it was asked for in, so a test lets one pass. */
const tick = () => new Promise(done => setTimeout(done, 3));
/** hello@ reaches the account's inbox, and a change to post@ and another inbox waits beside it. */
async function changing(w) {
  await forwarding(w);
  await tick();
  assert.equal((await setup(w.env, 'post', OTHER)).status, 200);
}

test('five-minute job: a change that waits is reminded about after 7 days and dropped after 30, and the address that works is never switched off', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await changing(w);
    const was = await rowOf(w.env);
    const wantSince = (days) => w.env.kiln_cloud.exec("UPDATE forwards SET want_since = ? WHERE site_id = 'site1'", Date.now() - days * DAY - 1000);
    assert.deepEqual(await sweepForwards(w.env), { ...NONE, looked: 1 });
    wantSince(7);
    const since = (await rowOf(w.env)).want_since;
    assert.deepEqual(await sweepForwards(w.env), { ...NONE, looked: 1, reminded: 1 });
    assert.deepEqual(await sweepForwards(w.env), { ...NONE, looked: 1 }, 'the reminder goes once');
    const remind = w.mails().at(-1);
    assert.deepEqual([remind.to, remind.subject], [INBOX, `${POST} is waiting for ${OTHER} to confirm`]);
    assert.equal(remind.text, forwardWaitingMail({ address: POST, inbox: OTHER, givesUpAt: since + 30 * DAY, dashboard: 'https://app.example', keeps: { address: HELLO, inbox: INBOX } }).text);
    const keeps = `Until it does, mail sent to ${HELLO} keeps arriving in the inbox ${INBOX}, as it does today.`;
    assert.ok(remind.text.includes(keeps));
    plain(keeps);
    wantSince(30);
    const lines = await hush(async () => assert.deepEqual(await sweepForwards(w.env), { ...NONE, looked: 1, gaveUp: 1 }));
    assert.ok(lines.some(l => /forward_change_dropped/.test(l)));
    const row = await rowOf(w.env);
    assert.deepEqual([row.address, row.inbox, row.state, row.reason, row.rule_id, row.on_at, row.created_at], [HELLO, INBOX, 'on', null, was.rule_id, was.on_at, was.created_at], 'the row that works is untouched');
    assert.deepEqual([row.want_address, row.want_inbox, row.want_inbox_id, row.want_asked_at, row.want_since], [null, null, null, null, null]);
    assert.deepEqual(rules(w), [`${HELLO} > ${INBOX}`], 'mail still reaches the inbox it reached');
    const f = (await standing(w.env)).forward;
    assert.deepEqual([f.state, f.address, f.inbox, 'changing_to' in f, 'error' in f], ['on', HELLO, INBOX, false, false]);
    assert.deepEqual(await sweepForwards(w.env), NONE, 'and nothing more is asked');
  });
});

test('five-minute job: a change whose new inbox has confirmed replaces the rule, and the row takes the new address and inbox', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await changing(w);
    const was = await rowOf(w.env);
    w.cf.confirm(OTHER);
    await hush(async () => assert.deepEqual(await sweepForwards(w.env), { ...NONE, looked: 1, on: 1 }));
    const row = await rowOf(w.env);
    assert.deepEqual([row.address, row.inbox, row.state, row.want_address, row.want_inbox, row.created_at], [POST, OTHER, 'on', null, null, was.want_since]);
    assert.ok(row.on_at >= was.on_at);
    assert.deepEqual(rules(w), [`${POST} > ${OTHER}`], 'one address for a site: the old one stopped as the new one began');
    assert.deepEqual(w.mails().map(m => m.subject), [`${HELLO} now reaches ${INBOX}`, `${POST} now reaches ${OTHER}`]);
    assert.deepEqual(await sweepForwards(w.env), NONE);
  });
});

test('forwarding: "Send it again" writes to the inbox of a change that waits, and a stop drops the change with the address', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await changing(w);
    const soon = await post(w.env, 'again');
    const told = await soon.json();
    assert.deepEqual([soon.status, told.code, told.error, told.forward.state, told.forward.changing_to.inbox], [429, 'too_soon', mailSentence('too_soon', { address: POST, inbox: OTHER }), 'on', OTHER]);
    w.env.kiln_cloud.exec("UPDATE forwards SET want_asked_at = ? WHERE site_id = 'site1'", Date.now() - MAIL_LIMITS.againMs - 1000);
    const before = await rowOf(w.env);
    const again = await (await post(w.env, 'again')).json();
    assert.deepEqual([again.sent, again.forward.state, again.forward.inbox, again.forward.changing_to.inbox], [true, 'on', INBOX, OTHER]);
    assert.deepEqual(w.cf.confirmations, [INBOX, OTHER, OTHER], 'the new inbox is written to again, and the one that works is not');
    const row = await rowOf(w.env);
    assert.ok(Date.now() - row.want_asked_at < 5000 && row.want_inbox_id);
    assert.deepEqual([row.inbox_id, row.asked_at, row.want_since], [before.inbox_id, before.asked_at, before.want_since], 'the address that works, and the day the change was asked for, are as they were');
    assert.deepEqual(rules(w), [`${HELLO} > ${INBOX}`]);
    let res;
    await hush(async () => { res = await post(w.env, 'stop'); });
    assert.deepEqual(await res.json(), { ok: true, forward: null });
    assert.deepEqual([await rowOf(w.env), rules(w)], [null, []]);
    assert.deepEqual([...w.cf.addresses.keys()], [], 'the inbox that worked and the one the change waited for are both off Cloudflare\'s list');
    assert.deepEqual(await sweepForwards(w.env), NONE, 'the change went with the address: nothing is switched on later');
  });
});

test('forwarding: a change of the address alone happens at once, and asking again for what works drops a change that waits', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await forwarding(w);
    await tick();
    let body;
    await hush(async () => { body = await (await setup(w.env, 'post', INBOX)).json(); });
    assert.deepEqual([body.forward.address, body.forward.inbox, body.forward.state, 'changing_to' in body.forward, body.sent], [POST, INBOX, 'on', false, false]);
    assert.deepEqual([rules(w), w.cf.confirmations], [[`${POST} > ${INBOX}`], [INBOX]], 'one rule, and no second email to the inbox');
    assert.deepEqual(w.mails().map(m => m.subject), [`${HELLO} now reaches ${INBOX}`, `${POST} now reaches ${INBOX}`]);
    // A change waits, a different one takes its place, and then the owner asks for what works.
    const first = await (await setup(w.env, 'hello', OTHER)).json();
    assert.deepEqual([first.forward.address, first.forward.changing_to.address, first.forward.changing_to.inbox, first.sent], [POST, HELLO, OTHER, true]);
    const second = await (await setup(w.env, 'mail', OTHER)).json();
    assert.deepEqual([second.forward.changing_to.address, second.sent, w.cf.confirmations.length], [`mail@${N}`, false, 2], 'the same inbox is not written to twice');
    assert.ok((await rowOf(w.env)).want_asked_at, 'and the row still knows that Cloudflare wrote to it');
    const back = await (await setup(w.env, 'post', INBOX)).json();
    assert.deepEqual([back.ok, back.sent, back.forward.address, back.forward.state, 'changing_to' in back.forward], [true, false, POST, 'on', false]);
    const row = await rowOf(w.env);
    assert.deepEqual([row.want_address, row.want_inbox, row.want_since], [null, null, null]);
    assert.deepEqual([rules(w), await sweepForwards(w.env)], [[`${POST} > ${INBOX}`], NONE]);
  });
});

test('forwarding: a change to an inbox that confirmed for another customer is refused or dropped, and the address that works is left as it is', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await forwarding(w);
    await otherSite(w);
    const res = await setup(w.env, 'post', OTHER);
    const body = await res.json();
    assert.deepEqual([res.status, body.code, body.error, body.forward.state, body.forward.address, 'changing_to' in body.forward], [409, 'inbox_elsewhere', mailSentence('inbox_elsewhere'), 'on', HELLO, false]);
    assert.deepEqual([rules(w), w.cf.confirmations, (await rowOf(w.env)).want_inbox], [[`${HELLO} > ${INBOX}`], [INBOX, OTHER], null]);
    // A change that was left waiting for such an inbox is dropped at the moment a rule would be made.
    for (const how of ['check', 'job']) {
      await saveForward(w.env, 'site1', { want_address: POST, want_inbox: OTHER, want_since: Date.now() });
      let out;
      await hush(async () => { out = how === 'job' ? await sweepForwards(w.env) : (await post(w.env, 'check')).status; });
      assert.deepEqual(out, how === 'job' ? { ...NONE, looked: 1, gaveUp: 1 } : 409, how);
      const row = await rowOf(w.env);
      assert.deepEqual([row.state, row.address, row.inbox, row.reason, row.want_inbox, rules(w)], ['on', HELLO, INBOX, null, null, [`${HELLO} > ${INBOX}`]], how);
    }
  });
});

// ─── Send it again ────────────────────────────────────────────────────────────

test('forwarding: "Send it again" has Cloudflare write once more, at most once every ten minutes', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    const none = await post(w.env, 'again');
    assert.deepEqual([none.status, (await none.json()).code], [404, 'no_forward']);
    await waiting(w);
    const first = await rowOf(w.env);
    const soon = await post(w.env, 'again');
    const told = await soon.json();
    assert.deepEqual([soon.status, told.code, told.error, told.forward.state], [429, 'too_soon', mailSentence('too_soon', { address: HELLO, inbox: INBOX }), 'confirming']);
    assert.deepEqual(w.cf.confirmations, [INBOX]);
    w.env.kiln_cloud.exec("UPDATE forwards SET asked_at = ? WHERE site_id = 'site1'", Date.now() - MAIL_LIMITS.againMs - 1000);
    const body = await (await post(w.env, 'again')).json();
    assert.deepEqual([body.ok, body.sent, body.forward.state], [true, true, 'confirming']);
    assert.deepEqual(w.cf.confirmations, [INBOX, INBOX]);
    const row = await rowOf(w.env);
    assert.ok(Date.now() - row.asked_at < 5000);
    assert.equal(row.inbox_id, w.cf.addresses.get(INBOX).id, 'the inbox has a new id at Cloudflare, and the row follows it');
    assert.equal(row.created_at, first.created_at, 'the waiting is still counted from the first asking');
    // Pressed after the inbox confirmed after all: no email goes, and the address is on.
    w.env.kiln_cloud.exec("UPDATE forwards SET asked_at = 1 WHERE site_id = 'site1'");
    w.cf.confirm(INBOX);
    let late;
    await hush(async () => { late = await (await post(w.env, 'again')).json(); });
    assert.deepEqual([late.sent, late.forward.state], [false, 'on']);
    assert.deepEqual(w.cf.confirmations, [INBOX, INBOX]);
    assert.deepEqual(rules(w), [`${HELLO} > ${INBOX}`]);
  });
});

// ─── Stopping, editing switched off, and the lock ─────────────────────────────

test('forwarding: stopping deletes the rule and forgets the address, and leaves the domain\'s mail records where they are', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    assert.deepEqual(await (await post(w.env, 'stop')).json(), { ok: true, forward: null });
    await forwarding(w);
    let res;
    await hush(async () => { res = await post(w.env, 'stop'); });
    assert.deepEqual(await res.json(), { ok: true, forward: null });
    assert.deepEqual(rules(w), []);
    assert.equal(await rowOf(w.env), null);
    assert.equal(routed(w).length, 3, 'the mail records stay, so nothing bounces differently by surprise');
    assert.deepEqual(await standing(w.env), { ok: true, forward: null, offered: true, why: null });
  });
});

test('forwarding: a stop that Cloudflare does not take keeps the address as it was and says to try again', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await forwarding(w);
    w.cf.failOn((method, path) => /\/email\/routing\/rules/.test(path));
    let res;
    await hush(async () => { res = await post(w.env, 'stop'); });
    const body = await res.json();
    assert.deepEqual([res.status, body.code, body.error, body.forward.state], [502, 'cloudflare', mailSentence('cloudflare'), 'on']);
    w.cf.failOn(null);
    assert.equal((await rowOf(w.env)).state, 'on');
    assert.equal(rules(w).length, 1);
    assert.equal(await w.env.KILN.get('forwardlock:site1'), null);
  });
});

test('forwarding: a stop takes the inbox off Cloudflare\'s list, and the same address set up again has Cloudflare write to the inbox afresh', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await forwarding(w);
    await hush(async () => { assert.deepEqual(await (await post(w.env, 'stop')).json(), { ok: true, forward: null }); });
    assert.deepEqual([...w.cf.addresses.keys()], [], 'nothing of the stopped address stays at Cloudflare');
    // "You can set it up again any time."
    const res = await setup(w.env);
    const body = await res.json();
    assert.deepEqual([res.status, body.ok, body.sent, body.forward.state, body.forward.inbox], [200, true, true, 'confirming', INBOX]);
    assert.deepEqual(w.cf.confirmations, [INBOX, INBOX], 'Cloudflare writes to the inbox a second time');
    const row = await rowOf(w.env);
    assert.ok(row.inbox_id === w.cf.addresses.get(INBOX).id && Date.now() - row.asked_at < 5000 && !row.rule_id);
    assert.deepEqual(rules(w), [], 'no rule until the inbox confirms again');
    w.cf.confirm(INBOX);
    await hush(async () => { assert.equal((await post(w.env, 'check')).status, 200); });
    assert.deepEqual([(await rowOf(w.env)).state, rules(w)], ['on', [`${HELLO} > ${INBOX}`]]);
  });
});

test('forwarding: a stop leaves the inbox on Cloudflare\'s list while another site forwards to it, and that site\'s address goes on working', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await withDomain(w);
    await otherSite(w, { account: 'acct-1' });   // a second site of this account forwards to the same inbox
    await hush(async () => { assert.equal((await setup(w.env, 'hello', OTHER)).status, 200); });
    assert.equal((await rowOf(w.env)).state, 'on');
    const was = { ...w.cf.addresses.get(OTHER) };
    const before = w.cf.calls.length;
    await hush(async () => { assert.deepEqual(await (await post(w.env, 'stop')).json(), { ok: true, forward: null }); });
    assert.deepEqual([await rowOf(w.env), rules(w)], [null, []]);
    assert.deepEqual(w.cf.addresses.get(OTHER), was, 'the inbox is on the list as it was, confirmed');
    assert.deepEqual(w.cf.calls.slice(before).filter(c => /\/email\/routing\/addresses/.test(c.path)), [], 'the list was not even asked about');
    const other = await forwardRow(w.env, 'site9');
    assert.deepEqual([other.state, other.inbox, other.inbox_id, other.rule_id], ['on', OTHER, was.id, 'rule-9']);
    assert.deepEqual(w.cf.confirmations, [OTHER]);
  });
});

test('forwarding: a stop stands when Cloudflare does not take the inbox off its list, and the set-up after it still asks the inbox afresh', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await forwarding(w);
    w.cf.failOn((method, path) => method === 'DELETE' && /\/email\/routing\/addresses\//.test(path));
    const log = console.log, warn = console.warn, lines = [];
    console.log = console.warn = (l) => lines.push(String(l));
    let res;
    try { res = await post(w.env, 'stop'); } finally { console.log = log; console.warn = warn; }
    assert.deepEqual([res.status, await res.json()], [200, { ok: true, forward: null }]);
    assert.deepEqual([await rowOf(w.env), rules(w)], [null, []], 'the rule and the row are gone all the same');
    assert.equal(await w.env.KILN.get('forwardlock:site1'), null);
    assert.ok(w.cf.addresses.get(INBOX)?.verified, 'the inbox is still on the list');
    const left = lines.map(l => JSON.parse(l)).filter(l => l.evt === 'forward_inbox_left');
    assert.deepEqual(left.map(l => [l.repo, l.address, l.which]), [['ada/club', HELLO, 'inbox']]);
    assert.ok(!JSON.stringify(left).includes(INBOX), 'the inbox itself is not written to the log');
    w.cf.failOn(null);
    const body = await (await setup(w.env)).json();
    assert.deepEqual([body.sent, body.forward.state], [true, 'confirming']);
    assert.deepEqual(w.cf.confirmations, [INBOX, INBOX]);
    assert.ok(!w.cf.addresses.get(INBOX).verified, 'the inbox has to press the button again');
  });
});

test('forwarding: with editing switched off nothing new is set up, and what was asked for can still be checked, sent again and stopped', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await waiting(w);
    editingOff(w.env);
    const res = await setup(w.env, 'post', OTHER);
    assert.deepEqual([res.status, (await res.json()).error], [403, mailSentence('plan_ended', { address: HELLO, inbox: INBOX })]);
    assert.equal((await rowOf(w.env)).address, HELLO);
    w.env.kiln_cloud.exec("UPDATE forwards SET asked_at = 1 WHERE site_id = 'site1'");
    assert.equal((await (await post(w.env, 'again')).json()).sent, true);
    w.cf.confirm(INBOX);
    let checked;
    await hush(async () => { checked = await (await post(w.env, 'check')).json(); });
    assert.equal(checked.forward.state, 'on');
    await hush(async () => assert.deepEqual(await (await post(w.env, 'stop')).json(), { ok: true, forward: null }));
    assert.deepEqual(rules(w), []);
  });
});

test('forwarding: while one press is at work a second one is told to wait, and the five-minute job leaves that address for its next run', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async (calls) => {
    await waiting(w);
    w.cf.confirm(INBOX);
    await w.env.KILN.put('forwardlock:site1', '1');
    calls.length = 0;
    for (const action of ['setup', 'check', 'again', 'stop']) {
      const res = await post(w.env, action, { local: 'hello', inbox: INBOX });
      const body = await res.json();
      assert.deepEqual([res.status, body.code, body.error, body.forward.state], [409, 'busy', mailSentence('busy'), 'confirming'], action);
    }
    assert.deepEqual(await sweepForwards(w.env), { looked: 1, on: 0, reminded: 0, gaveUp: 0, failed: 0 });
    assert.equal(mailCalls(calls).length, 0, 'nothing was asked of Cloudflare');
    assert.deepEqual(rules(w), []);
    assert.equal(await w.env.KILN.get('forwardlock:site1'), '1', 'a lock somebody else holds is not taken away');
    await w.env.KILN.delete('forwardlock:site1');
    await hush(async () => assert.equal((await sweepForwards(w.env)).on, 1));
    assert.equal(rules(w).length, 1);
  });
});

// ─── The five-minute job ──────────────────────────────────────────────────────

test('five-minute job: an inbox that has confirmed gets its rule, the address is on with its time, and the owner is written to', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await waiting(w);
    assert.deepEqual(await sweepForwards(w.env), { looked: 1, on: 0, reminded: 0, gaveUp: 0, failed: 0 });
    assert.deepEqual([rules(w).length, w.mails().length, (await rowOf(w.env)).state], [0, 0, 'confirming']);
    w.cf.confirm(INBOX);
    const now = Date.now() + 60000;
    await hush(async () => assert.deepEqual(await sweepForwards(w.env, { now }), { looked: 1, on: 1, reminded: 0, gaveUp: 0, failed: 0 }));
    const row = await rowOf(w.env);
    assert.deepEqual([row.state, row.on_at, row.rule_id], ['on', now, w.cf.rulesOf(N)[0].id]);
    assert.deepEqual(rules(w), [`${HELLO} > ${INBOX}`]);
    assert.deepEqual(w.mails().map(m => [m.to, m.subject]), [[INBOX, `${HELLO} now reaches ${INBOX}`]]);
    assert.deepEqual(await sweepForwards(w.env), { looked: 0, on: 0, reminded: 0, gaveUp: 0, failed: 0 }, 'an address that is on is not asked about again');
  });
});

test('five-minute job: after 7 days the owner is reminded once, and after 30 days the address is marked off with a sentence and nothing more is asked', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async (calls) => {
    await waiting(w);
    longAgo(w.env, 6);
    assert.equal((await sweepForwards(w.env)).reminded, 0);
    longAgo(w.env, 7);
    const row = await rowOf(w.env);
    assert.deepEqual(await sweepForwards(w.env), { looked: 1, on: 0, reminded: 1, gaveUp: 0, failed: 0 });
    assert.deepEqual(await sweepForwards(w.env), { looked: 1, on: 0, reminded: 0, gaveUp: 0, failed: 0 });
    assert.equal(w.mails().length, 1);
    assert.equal(w.mails()[0].to, INBOX);
    assert.equal(w.mails()[0].text, forwardWaitingMail({ address: HELLO, inbox: INBOX, givesUpAt: row.created_at + 30 * DAY, dashboard: 'https://app.example' }).text);
    longAgo(w.env, 30);
    await hush(async () => assert.deepEqual(await sweepForwards(w.env), { looked: 1, on: 0, reminded: 0, gaveUp: 1, failed: 0 }));
    const off = await rowOf(w.env);
    assert.deepEqual([off.state, off.reason], ['off', 'never_confirmed']);
    assert.equal((await standing(w.env)).forward.error, `The inbox ${INBOX} did not confirm within 30 days, so Kiln stopped waiting. Nothing of yours was changed. To try again, press "Forward an address" on the site's row.`);
    calls.length = 0;
    assert.deepEqual(await sweepForwards(w.env), { looked: 0, on: 0, reminded: 0, gaveUp: 0, failed: 0 });
    assert.equal(mailCalls(calls).length, 0);
    assert.equal(w.mails().length, 1);
    // Asking again starts a new wait, with a new clock.
    w.env.kiln_cloud.exec("UPDATE forwards SET asked_at = 1 WHERE site_id = 'site1'");
    const again = await (await setup(w.env)).json();
    assert.deepEqual([again.forward.state, again.forward.error], ['confirming', undefined]);
    assert.ok(Date.now() - (await rowOf(w.env)).created_at < 5000);
  });
});

test('five-minute job: an inbox that confirms on the last day is still switched on, and no reminder goes where the owner cannot be written to', { skip: d1Skip }, async () => {
  const w = world({ env: { CUSTOMER_MAIL_FROM: '' } });
  await withFetch(w.handler, async () => {
    await waiting(w);
    longAgo(w.env, 8);
    assert.deepEqual(await sweepForwards(w.env), { looked: 1, on: 0, reminded: 0, gaveUp: 0, failed: 0 });
    longAgo(w.env, 31);
    w.cf.confirm(INBOX);
    await hush(async () => assert.equal((await sweepForwards(w.env)).on, 1));
    assert.equal((await rowOf(w.env)).state, 'on');
    assert.equal(w.mails().length, 0);
  });
});

test('five-minute job: at most 10 addresses a run, the one looked at longest ago first, and an address whose site is gone is given up on', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    for (let i = 0; i < 12; i++) {
      await saveForward(w.env, `gone${i}`, { address: `hello@gone${i}.test`, inbox: INBOX });
      w.env.kiln_cloud.exec('UPDATE forwards SET updated_at = ? WHERE site_id = ?', 1000 + i, `gone${i}`);
    }
    let first;
    await hush(async () => { first = await sweepForwards(w.env); });
    assert.deepEqual(first, { looked: 10, on: 0, reminded: 0, gaveUp: 10, failed: 0 });
    assert.deepEqual([(await forwardRow(w.env, 'gone0')).state, (await forwardRow(w.env, 'gone9')).state, (await forwardRow(w.env, 'gone10')).state], ['off', 'off', 'confirming']);
    await hush(async () => assert.equal((await sweepForwards(w.env)).looked, 2));
  });
});

test('five-minute job: it never throws, a failure for one address is logged and tried again, and a domain that is no longer live is not asked about', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async (calls) => {
    await waiting(w);
    w.cf.confirm(INBOX);
    w.cf.failOn((method, path) => /\/email\/routing/.test(path));
    let out;
    const lines = await hush(async () => { out = await sweepForwards(w.env); });
    assert.deepEqual(out, { looked: 1, on: 0, reminded: 0, gaveUp: 0, failed: 1 });
    assert.ok(lines.some(l => /forward_sweep_one_failed/.test(l)));
    assert.equal((await rowOf(w.env)).state, 'confirming');
    w.cf.failOn(null);
    w.env.kiln_cloud.exec("UPDATE domains SET state = 'put_away', reason = 'moved' WHERE site_id = 'site1'");
    calls.length = 0;
    assert.deepEqual(await sweepForwards(w.env), { looked: 1, on: 0, reminded: 0, gaveUp: 0, failed: 0 });
    assert.equal(mailCalls(calls).length, 0);
    const checked = await (await post(w.env, 'check')).json();
    assert.equal(checked.forward.state, 'confirming', '"check now" makes no rule for it either');
    assert.deepEqual(await sweepForwards({}), { looked: 0, on: 0, reminded: 0, gaveUp: 0, failed: 0 });
    assert.deepEqual(await sweepForwards({ kiln_cloud: { prepare() { throw new Error('down'); } } }), { looked: 0, on: 0, reminded: 0, gaveUp: 0, failed: 0 });
  });
});

test('five-minute job: the service\'s own timer runs the look at forwarded addresses', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await waiting(w);
    w.cf.confirm(INBOX);
    await hush(async () => { await worker.scheduled({}, w.env, { waitUntil() {} }); });
    assert.equal((await rowOf(w.env)).state, 'on');
  });
});

// ─── When the domain goes away ────────────────────────────────────────────────

test('hosting ends: the forwarded address is left as it is, its row and its rule, so mail keeps arriving while the zone answers for the domain', { skip: d1Skip }, async () => {
  const w = world({ env: { NOTIFY_TO: 'ops@example.com' } });
  await withFetch(w.handler, async () => {
    await forwarding(w);
    const before = await rowOf(w.env);
    await hush(() => sweepHosting(w.env, {
      installationToken: async () => 'inst-token', hasAccess: () => false, endsAt: () => 1, endReason: () => 'trial_ended',
      ended: (site, reason, domain) => hostingEndedNote(w.env, site, reason, domain),
    }));
    const domain = await domainRow(w.env, 'site1');
    assert.deepEqual([domain.state, domain.reason], ['put_away', 'hosting_ended']);
    assert.equal(w.cf.workerDomains.size, 0, 'the site is off the domain');
    assert.deepEqual(await rowOf(w.env), before, 'the row is as it was');
    assert.deepEqual(rules(w), [`${HELLO} > ${INBOX}`], 'and the rule still forwards');
    assert.equal(routed(w).length, 3, 'with the mail records it needs');
    // Its owner can still stop it, though nothing new can be set up at a domain that is not live.
    const shown = await standing(w.env);
    assert.deepEqual([shown.forward.state, shown.offered], ['on', false]);
    await hush(async () => assert.deepEqual(await (await post(w.env, 'stop')).json(), { ok: true, forward: null }));
    assert.deepEqual(rules(w), []);
  });
});

// ─── The two emails ───────────────────────────────────────────────────────────

test('forwarding mails: "now reaches" says what it does, that it only receives, and how to change or stop it', () => {
  const mail = forwardOnMail({ address: HELLO, inbox: INBOX, dashboard: 'https://app.example' });
  assert.equal(mail.subject, `${HELLO} now reaches ${INBOX}`);
  assert.equal(mail.text, [
    'Hello,',
    `Mail sent to ${HELLO} now arrives in the inbox ${INBOX}. The inbox has confirmed, so there is nothing more for you to do.`,
    `The address only receives mail. To answer a message, reply from ${INBOX} as you always do. Your reply is sent from that inbox.`,
    'To send the mail to a different inbox, to change the address, or to stop the forwarding, open your dashboard and use the email line on the site\'s row.',
    'https://app.example',
    'Kiln\nYou are getting this because oakbakery.test was added to Kiln Cloud with this email address. Reply to this email to reach a person.\n',
  ].join('\n\n'));
  assert.doesNotMatch(mail.text + mail.html, /[—–]|undefined|null/);
  assert.ok(mail.html.includes('<a href="https://app.example"'));
});

test('forwarding mails: the reminder says whose inbox must press the button, where "Send it again" is, and the day Kiln stops waiting', () => {
  const givesUpAt = Date.UTC(2026, 11, 13, 12);
  const mail = forwardWaitingMail({ address: HELLO, inbox: OTHER, givesUpAt, dashboard: 'https://app.example' });
  assert.equal(mail.subject, `${HELLO} is waiting for ${OTHER} to confirm`);
  assert.equal(mail.text, [
    'Hello,',
    `You asked Kiln to forward ${HELLO} to the inbox ${OTHER}. That has not started yet, because the inbox has not confirmed.`,
    `Cloudflare, the company that carries the mail, sent an email to ${OTHER}. Whoever reads that inbox needs to open that email and press the button in it. That is the only step. Kiln then switches the forwarding on by itself and writes to you when it has.`,
    'If the email is not there, look in the spam folder. To have it sent again, open your dashboard and press "Send it again" on the site\'s row.',
    'https://app.example',
    `If the inbox has not confirmed by ${dayWords(givesUpAt)}, Kiln stops waiting. Nothing of yours is changed by that, and you can ask again from the dashboard any time.`,
    'Kiln\nYou are getting this because oakbakery.test was added to Kiln Cloud with this email address. Reply to this email to reach a person.\n',
  ].join('\n\n'));
  assert.doesNotMatch(mail.text + mail.html, /[—–]|undefined|null/);
  assert.doesNotMatch(forwardWaitingMail({ address: HELLO, inbox: OTHER, dashboard: 'https://app.example' }).text, /stops waiting/);
});
