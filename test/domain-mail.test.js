/**
 * One forwarded email address on a hosted site's own domain
 * (worker/domain-mail.js). The real code runs over an in-memory Cloudflare
 * that holds a zone's records, its forwarding switch and rules, and the
 * account's list of inboxes, so each test can look at what the domain's DNS
 * and its rules would hold afterwards. The domains and inboxes are made up.
 * Nothing here touches the network, and no email is sent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFetch } from './worker-harness.js';
import { fakeCloudflare } from './cloudflare-fake.js';
import { fakeD1, d1Skip, addSite } from './d1-fake.js';
import { txtWords } from '../worker/domain.js';
import {
  mailState, switchMailOn, hasOwnMail, sendsOwnMail, saysNoMail, mailStop, inboxState, addInbox, askAgain, canAskAgain,
  forward, stopForwarding, cleanLocal, cleanInbox, mailSentence, forwardRow, forwardsForAccount, forwardsConfirming,
  forwardsReady, saveForward, forgetForward, publicForward, MailError, MAIL_LIMITS,
} from '../worker/domain-mail.js';

const N = 'oakbakery.test';
const HELLO = `hello@${N}`;
const INBOX = 'ada@example.com';
const ROOT = 'https://api.cloudflare.com/client/v4';

const ROUTING = [
  `MX ${N} 15 route1.mx.cloudflare.net`,
  `MX ${N} 21 route2.mx.cloudflare.net`,
  `MX ${N} 38 route3.mx.cloudflare.net`,
  `TXT ${N} v=spf1 include:_spf.mx.cloudflare.net ~all`,
  `TXT cf2024-1._domainkey.${N} v=DKIM1`,
];
const NO_MAIL = [{ type: 'MX', name: N, content: '.', priority: 0 }, { type: 'TXT', name: N, content: '"v=spf1 -all"' }];

// A zone for the domain in the hosting account, holding these records and nothing else.
async function world(records = []) {
  const cf = fakeCloudflare();
  const ask = (method, path, body) => cf.handler(`${ROOT}${path}`, { method, headers: { Authorization: `Bearer ${cf.token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  await ask('POST', '/zones', { name: N, account: { id: cf.account }, type: 'full' });
  const zoneId = cf.zoneOf(N).id;
  for (const r of records) await ask('POST', `/zones/${zoneId}/dns_records`, r);
  cf.calls.length = 0;
  return { cf, zoneId, ask, env: { HOSTING_ACCOUNT_ID: cf.account, HOSTING_API_TOKEN: cf.token } };
}
const code = (c) => (e) => e instanceof MailError && e.code === c;
const did = (cf, method, end) => cf.calls.filter(c => c.method === method && c.path.endsWith(end)).length;
// A zone's records, one line each, a long key cut to its first word.
const view = (cf) => cf.recordsOf(N).map(r => `${r.type} ${r.name} ${r.priority !== undefined ? `${r.priority} ` : ''}${r.type === 'TXT' ? txtWords(r.content).split(';')[0] : r.content}`).sort();
const rules = (cf) => cf.rulesOf(N).map(r => ({ name: r.name, enabled: r.enabled, matchers: r.matchers, actions: r.actions }));
const quiet = async (fn) => { const real = console.warn; const lines = []; console.warn = (l) => lines.push(String(l)); try { await fn(); } finally { console.warn = real; } return lines; };

// ─── Does the domain have email of its own? ───────────────────────────────────

test('mail: a domain with a mail server of its own is told from one with none, and from one that says "no mail here"', () => {
  const google = [{ type: 'MX', name: N, content: '1 aspmx.l.google.com', kind: 'mail' }, { type: 'TXT', name: N, content: 'v=spf1 include:_spf.google.com ~all', kind: 'mail' }];
  const parked = [{ type: 'MX', name: N, content: '0 .', kind: 'mail' }, { type: 'TXT', name: N, content: 'v=spf1 -all', kind: 'mail' }];
  const plain = [{ type: 'TXT', name: N, content: 'google-site-verification=abc123', kind: 'proof' }, { type: 'CNAME', name: `shop.${N}`, content: 'shops.myshopify.com', kind: 'other' }];
  assert.deepEqual([hasOwnMail(google, N), saysNoMail(google, N)], [true, false]);
  assert.deepEqual([hasOwnMail(parked, N), saysNoMail(parked, N)], [false, true]);
  assert.deepEqual([hasOwnMail(plain, N), saysNoMail(plain, N)], [false, false]);
  assert.deepEqual([hasOwnMail([], N), saysNoMail([], N), hasOwnMail(null, N)], [false, false, false]);
  // Either half of "no mail here" is enough, and capitals and spacing do not matter.
  assert.equal(saysNoMail([parked[0]], N), true);
  assert.equal(saysNoMail([{ type: 'txt', name: `${N}.`, content: '"V=SPF1   -ALL"' }], N), true);
  // A mail server beside the "no mail here" one is email of its own.
  assert.equal(hasOwnMail([...parked, { type: 'MX', name: N, content: '10 mail.example.com' }], N), true);
  // Only the bare name counts when the domain is named; with no name, any mail server does.
  const under = [{ type: 'MX', name: `mg.${N}`, content: '10 mxa.mailgun.org', kind: 'mail' }];
  assert.deepEqual([hasOwnMail(under, N), hasOwnMail(under)], [false, true]);
  // The records as Cloudflare lists them read the same way.
  assert.equal(hasOwnMail([{ type: 'MX', name: N, content: 'aspmx.l.google.com', priority: 1 }], N), true);
  assert.equal(saysNoMail([{ type: 'MX', name: N, content: '.', priority: 0 }], N), true);
});

test('mail: a domain that sends email with no mail server of its own is left alone as well', () => {
  const sends = [{ type: 'TXT', name: N, content: 'v=spf1 include:servers.mcsv.net ~all', kind: 'mail' }];
  assert.deepEqual([hasOwnMail(sends, N), sendsOwnMail(sends, N), saysNoMail(sends, N)], [false, true, false]);
  assert.equal(sendsOwnMail([{ type: 'TXT', name: N, content: 'v=spf1 -all' }], N), false);
  assert.equal(sendsOwnMail([{ type: 'TXT', name: N, content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' }], N), false);   // Cloudflare's own, for forwarding
  assert.equal(sendsOwnMail([{ type: 'TXT', name: N, content: 'google-site-verification=abc123' }], N), false);
  assert.equal(saysNoMail([{ type: 'MX', name: N, content: '0 .' }, ...sends], N), false);
});

test('mail: forwarding is offered only for a domain that is live and has no email of its own', () => {
  const kept = (records) => JSON.stringify(records);
  assert.equal(mailStop(null), 'not_live');
  assert.equal(mailStop({ name: N, state: 'waiting', records: '[]' }), 'not_live');
  assert.equal(mailStop({ name: N, state: 'put_away', records: '[]' }), 'not_live');
  assert.equal(mailStop({ name: N, state: 'live', records: '[]' }), null);
  assert.equal(mailStop({ name: N, state: 'live', records: kept([{ type: 'MX', name: N, content: '0 .' }, { type: 'TXT', name: N, content: 'v=spf1 -all' }]) }), null);
  assert.equal(mailStop({ name: N, state: 'live', records: kept([{ type: 'MX', name: N, content: '1 aspmx.l.google.com' }]) }), 'has_own_mail');
  assert.equal(mailStop({ name: N, state: 'live', records: kept([{ type: 'TXT', name: N, content: 'v=spf1 include:servers.mcsv.net ~all' }]) }), 'has_own_mail');
  // What publicDomain hands a page: the records as a list.
  assert.equal(mailStop({ name: N, state: 'live', records: [{ type: 'MX', name: N, content: '1 aspmx.l.google.com', kind: 'mail' }] }), 'has_own_mail');
  assert.equal(mailStop({ name: N, state: 'live', records: 'not a list' }), null);   // switchMailOn looks at the zone itself before it changes anything
});

// ─── Forwarding for the whole domain ──────────────────────────────────────────

test('mail: forwarding is switched on once, and Cloudflare writes the mail records itself', async () => {
  const w = await world([{ type: 'TXT', name: N, content: '"google-site-verification=abc123"' }]);
  await withFetch(w.cf.handler, async () => {
    assert.deepEqual(await mailState(w.env, { zoneId: w.zoneId }), { on: false, status: 'unconfigured' });
    assert.deepEqual(await switchMailOn(w.env, { zoneId: w.zoneId, name: N }), { on: true });
    assert.deepEqual(await mailState(w.env, { zoneId: w.zoneId }), { on: true, status: 'ready' });
    assert.deepEqual(await switchMailOn(w.env, { zoneId: w.zoneId, name: N }), { on: true });
  });
  assert.deepEqual(view(w.cf), [...ROUTING, `TXT ${N} google-site-verification=abc123`].sort());
  assert.equal(did(w.cf, 'POST', '/email/routing/dns'), 1);   // the second time it was on already: nothing was asked for twice
  assert.equal(w.cf.calls.filter(c => c.method === 'DELETE').length, 0);
  assert.ok(w.cf.calls.every(c => c.auth === w.cf.token));
});

test('mail: a domain that said "no mail here" has those two records replaced, and nothing else', async () => {
  const w = await world([...NO_MAIL,
    { type: 'TXT', name: `_dmarc.${N}`, content: '"v=DMARC1; p=reject"' },
    { type: 'MX', name: `shop.${N}`, content: '.', priority: 0 },
    { type: 'A', name: `mail.${N}`, content: '203.0.113.25' },
  ]);
  await withFetch(w.cf.handler, async () => {
    assert.deepEqual(await switchMailOn(w.env, { zoneId: w.zoneId }), { on: true });   // with no name given, the zone's own is asked for
  });
  assert.deepEqual(view(w.cf), [...ROUTING, `A mail.${N} 203.0.113.25`, `MX shop.${N} 0 .`, `TXT _dmarc.${N} v=DMARC1`].sort());
  // They were deleted before the switch, since they say the opposite of what it writes.
  const order = w.cf.calls.map(c => `${c.method} ${c.path.replace(/^\/zones\/[^/]+/, '').replace(/rec-\d+/, ':id')}`).filter(l => !l.startsWith('GET'));
  assert.deepEqual(order, ['DELETE /dns_records/:id', 'DELETE /dns_records/:id', 'POST /email/routing/dns']);
});

test('mail: a domain with email of its own is never touched', async () => {
  const google = [{ type: 'MX', name: N, content: 'aspmx.l.google.com', priority: 1 }, { type: 'TXT', name: N, content: '"v=spf1 include:_spf.google.com ~all"' }];
  const sendsOnly = [...NO_MAIL.slice(0, 1), { type: 'TXT', name: N, content: '"v=spf1 include:servers.mcsv.net ~all"' }];
  const both = [...NO_MAIL, { type: 'MX', name: N, content: 'mail.example.com', priority: 10 }];
  for (const records of [google, sendsOnly, both]) {
    const w = await world(records);
    const before = view(w.cf);
    await withFetch(w.cf.handler, async () => {
      await assert.rejects(switchMailOn(w.env, { zoneId: w.zoneId, name: N }), code('has_own_mail'));
      assert.deepEqual(await mailState(w.env, { zoneId: w.zoneId }), { on: false, status: 'unconfigured' });
    });
    assert.deepEqual(view(w.cf), before);
    assert.ok(w.cf.calls.every(c => c.method === 'GET'), 'nothing was changed, only looked at');
  }
});

test('mail: a switch that fails leaves the domain saying "no mail here", as it did', async () => {
  const w = await world(NO_MAIL);
  const before = view(w.cf);
  w.cf.failOn((method, path) => method === 'POST' && path.endsWith('/email/routing/dns'));
  await withFetch(w.cf.handler, async () => {
    await assert.rejects(switchMailOn(w.env, { zoneId: w.zoneId, name: N }), code('cloudflare'));
    w.cf.failOn(null);
    assert.deepEqual(await mailState(w.env, { zoneId: w.zoneId }), { on: false, status: 'unconfigured' });
  });
  assert.deepEqual(view(w.cf), before);
});

test('mail: forwarding that is on but not ready is switched on again, so its records are written', async () => {
  const w = await world();
  await withFetch(w.cf.handler, async () => {
    await mailState(w.env, { zoneId: w.zoneId });
    Object.assign(w.cf.zoneOf(N).mail, { enabled: true, status: 'misconfigured' });
    assert.deepEqual(await mailState(w.env, { zoneId: w.zoneId }), { on: true, status: 'misconfigured' });
    assert.deepEqual(await switchMailOn(w.env, { zoneId: w.zoneId, name: N }), { on: true });
    assert.deepEqual(await mailState(w.env, { zoneId: w.zoneId }), { on: true, status: 'ready' });
  });
  assert.deepEqual(view(w.cf), [...ROUTING].sort());
});

// ─── The inbox ────────────────────────────────────────────────────────────────

test('mail: an inbox is added once, and Cloudflare sends its email once', async () => {
  const w = await world();
  await withFetch(w.cf.handler, async () => {
    assert.equal(await inboxState(w.env, { email: INBOX }), null);
    const first = await addInbox(w.env, { email: '  Ada@Example.com ' });
    assert.deepEqual(first, { id: first.id, verified: false, sent: true });
    assert.ok(first.id);
    assert.deepEqual(await addInbox(w.env, { email: INBOX }), { id: first.id, verified: false, sent: false });
    assert.deepEqual(await inboxState(w.env, { email: INBOX }), { id: first.id, verified: false });
    w.cf.confirm(INBOX);   // its owner pressed the button in the email
    assert.deepEqual(await inboxState(w.env, { email: 'ADA@example.com' }), { id: first.id, verified: true });
    assert.deepEqual(await addInbox(w.env, { email: INBOX }), { id: first.id, verified: true, sent: false });
    await assert.rejects(addInbox(w.env, { email: 'not an address' }), code('not_an_address'));
  });
  assert.deepEqual(w.cf.confirmations, [INBOX]);
  assert.equal(did(w.cf, 'POST', '/email/routing/addresses'), 1);
});

test('mail: an inbox is found however long the account\'s list is, and with one question when its id is known', async () => {
  const w = await world();
  for (let i = 0; i < 120; i++) w.cf.addresses.set(`p${i}@example.com`, { id: `old-${i}`, tag: `old-${i}`, email: `p${i}@example.com`, verified: null });
  await withFetch(w.cf.handler, async () => {
    const added = await addInbox(w.env, { email: INBOX });
    w.cf.calls.length = 0;
    assert.deepEqual(await inboxState(w.env, { email: INBOX }), { id: added.id, verified: false });
    assert.equal(w.cf.calls.length, 3);   // 121 inboxes, 50 to a page
    w.cf.calls.length = 0;
    assert.deepEqual(await inboxState(w.env, { email: INBOX, id: added.id }), { id: added.id, verified: false });
    assert.deepEqual(w.cf.calls.map(c => c.path), [`/email/routing/addresses/${added.id}`]);
    // An id that is gone, or that is another inbox's, is not believed: the list is read.
    assert.deepEqual(await inboxState(w.env, { email: INBOX, id: 'addr-gone' }), { id: added.id, verified: false });
    assert.deepEqual(await inboxState(w.env, { email: INBOX, id: 'old-7' }), { id: added.id, verified: false });
    assert.equal(await inboxState(w.env, { email: 'nobody@example.com', id: 'addr-gone' }), null);
  });
});

test('mail: two people adding one inbox at the same moment get the same inbox, and one email', async () => {
  const w = await world();
  await withFetch(w.cf.handler, async () => { await addInbox(w.env, { email: INBOX }); });
  let lists = 0;
  const late = async (url, init) => {   // the first look at the list was a moment too early to see it
    if (init.method === 'GET' && url.includes('/email/routing/addresses?') && ++lists === 1) return new Response(JSON.stringify({ success: true, errors: [], result: [] }), { status: 200 });
    return w.cf.handler(url, init);
  };
  await withFetch(late, async () => {
    assert.deepEqual(await addInbox(w.env, { email: INBOX }), { id: w.cf.addresses.get(INBOX).id, verified: false, sent: false });
  });
  assert.deepEqual(w.cf.confirmations, [INBOX]);
});

test('mail: "Send it again" has Cloudflare send its email again, and never for an inbox that has confirmed', async () => {
  const w = await world();
  await withFetch(w.cf.handler, async () => {
    const first = await addInbox(w.env, { email: INBOX });
    const again = await askAgain(w.env, { email: INBOX });
    assert.deepEqual(again, { id: again.id, verified: false, sent: true });
    assert.notEqual(again.id, first.id);
    assert.deepEqual(w.cf.confirmations, [INBOX, INBOX]);
    assert.equal(w.cf.addresses.size, 1);
    w.cf.confirm(INBOX);
    w.cf.calls.length = 0;
    assert.deepEqual(await askAgain(w.env, { email: INBOX }), { id: again.id, verified: true, sent: false });
    assert.ok(w.cf.calls.every(c => c.method === 'GET'), 'a confirmed inbox is left exactly as it is');
    // An inbox that is not on the list at all is simply added.
    assert.equal((await askAgain(w.env, { email: 'bob@example.net' })).sent, true);
  });
  assert.deepEqual(w.cf.confirmations, [INBOX, INBOX, 'bob@example.net']);
});

test('mail: the email is sent again at most once every ten minutes', () => {
  assert.equal(MAIL_LIMITS.againMs, 10 * 60 * 1000);
  assert.equal(canAskAgain({ asked_at: 1000 }, 1000 + MAIL_LIMITS.againMs - 1), false);
  assert.equal(canAskAgain({ asked_at: 1000 }, 1000 + MAIL_LIMITS.againMs), true);
  assert.equal(canAskAgain({ asked_at: null }, 5), true);
  assert.equal(canAskAgain({ asked_at: Date.now() }), false);
});

// ─── The one rule ─────────────────────────────────────────────────────────────

test('mail: no rule is made, and nothing is claimed, before the inbox has confirmed', async () => {
  const w = await world();
  await withFetch(w.cf.handler, async () => {
    await switchMailOn(w.env, { zoneId: w.zoneId, name: N });
    await assert.rejects(forward(w.env, { zoneId: w.zoneId, address: HELLO, inbox: INBOX }), code('not_confirmed'));   // not even on the list
    await addInbox(w.env, { email: INBOX });
    await assert.rejects(forward(w.env, { zoneId: w.zoneId, address: HELLO, inbox: INBOX }), (e) => code('not_confirmed')(e) && e.codes.includes(2054));
  });
  assert.deepEqual(rules(w.cf), []);
});

test('mail: once the inbox has confirmed, one rule forwards the address to it', async () => {
  const w = await world();
  let made;
  await withFetch(w.cf.handler, async () => {
    await switchMailOn(w.env, { zoneId: w.zoneId, name: N });
    await addInbox(w.env, { email: INBOX });
    w.cf.confirm(INBOX);
    made = await forward(w.env, { zoneId: w.zoneId, address: ' Hello@OakBakery.test ', inbox: 'Ada@Example.com' });
  });
  assert.deepEqual(Object.keys(made), ['ruleId']);
  assert.equal(w.cf.rulesOf(N)[0].id, made.ruleId);
  assert.deepEqual(rules(w.cf), [{ name: `Kiln forwards ${HELLO}`, enabled: true, matchers: [{ type: 'literal', field: 'to', value: HELLO }], actions: [{ type: 'forward', value: [INBOX] }] }]);
  // The zone's built-in catch-all rule is as it was: off, dropping mail.
  const all = [...w.cf.zoneOf(N).mail.rules.values()];
  assert.equal(all.length, 2);
  assert.deepEqual(all.filter(r => r.matchers[0].type === 'all').map(r => [r.enabled, r.actions[0].type]), [[false, 'drop']]);
});

test('mail: a site has one address: changing it replaces the rule, and the old address stops at once', async () => {
  const w = await world();
  await withFetch(w.cf.handler, async () => {
    await addInbox(w.env, { email: INBOX });
    w.cf.confirm(INBOX);
    const first = await forward(w.env, { zoneId: w.zoneId, address: HELLO, inbox: INBOX });
    const second = await forward(w.env, { zoneId: w.zoneId, address: `hi@${N}`, inbox: INBOX, ruleId: first.ruleId });
    assert.equal(second.ruleId, first.ruleId);
    assert.deepEqual(rules(w.cf).map(r => r.matchers[0].value), [`hi@${N}`]);
    // A new inbox that has not confirmed changes nothing: the rule goes on reaching the old one.
    await addInbox(w.env, { email: 'bob@example.net' });
    await assert.rejects(forward(w.env, { zoneId: w.zoneId, address: `hi@${N}`, inbox: 'bob@example.net', ruleId: first.ruleId }), code('not_confirmed'));
    assert.deepEqual(rules(w.cf).map(r => [r.matchers[0].value, r.actions[0].value]), [[`hi@${N}`, [INBOX]]]);
    // A row that lost its rule's id still ends with one rule: the one Kiln made is found and replaced.
    const third = await forward(w.env, { zoneId: w.zoneId, address: `shop@${N}`, inbox: INBOX });
    assert.equal(third.ruleId, first.ruleId);
    assert.deepEqual(rules(w.cf).map(r => r.matchers[0].value), [`shop@${N}`]);
    // A rule somebody removed by hand is made again.
    w.cf.zoneOf(N).mail.rules.delete(first.ruleId);
    const fourth = await forward(w.env, { zoneId: w.zoneId, address: HELLO, inbox: INBOX, ruleId: first.ruleId });
    assert.notEqual(fourth.ruleId, first.ruleId);
    assert.deepEqual(rules(w.cf).map(r => r.matchers[0].value), [HELLO]);
  });
});

test('mail: a rule made by hand is left alone', async () => {
  const w = await world();
  await withFetch(w.cf.handler, async () => {
    await addInbox(w.env, { email: INBOX });
    w.cf.confirm(INBOX);
    const byHand = { name: 'made by hand', enabled: true, matchers: [{ type: 'literal', field: 'to', value: `orders@${N}` }], actions: [{ type: 'forward', value: [INBOX] }] };
    await w.ask('POST', `/zones/${w.zoneId}/email/routing/rules`, byHand);
    const made = await forward(w.env, { zoneId: w.zoneId, address: HELLO, inbox: INBOX });
    assert.deepEqual(rules(w.cf).map(r => r.matchers[0].value), [`orders@${N}`, HELLO]);
    assert.deepEqual(await stopForwarding(w.env, { zoneId: w.zoneId }), { stopped: true });   // no id given: the one Kiln made is found
    assert.deepEqual(rules(w.cf), [byHand]);
    assert.deepEqual(await stopForwarding(w.env, { zoneId: w.zoneId }), { stopped: true });
    assert.deepEqual(rules(w.cf), [byHand]);
    assert.ok(made.ruleId);
  });
});

test('mail: an address is never forwarded to an inbox at its own domain, and what is not an address is refused before Cloudflare is asked', async () => {
  const w = await world();
  await withFetch(w.cf.handler, async () => {
    await assert.rejects(forward(w.env, { zoneId: w.zoneId, address: HELLO, inbox: `me@${N}` }), code('same_domain'));
    await assert.rejects(forward(w.env, { zoneId: w.zoneId, address: 'hello', inbox: INBOX }), code('not_an_address'));
    await assert.rejects(forward(w.env, { zoneId: w.zoneId, address: HELLO, inbox: 'ada' }), code('not_an_address'));
  });
  assert.equal(w.cf.calls.length, 0);
});

test('mail: switching forwarding off removes the rule and leaves the mail records', async () => {
  const w = await world();
  await withFetch(w.cf.handler, async () => {
    await switchMailOn(w.env, { zoneId: w.zoneId, name: N });
    await addInbox(w.env, { email: INBOX });
    w.cf.confirm(INBOX);
    const { ruleId } = await forward(w.env, { zoneId: w.zoneId, address: HELLO, inbox: INBOX });
    assert.deepEqual(await stopForwarding(w.env, { zoneId: w.zoneId, ruleId }), { stopped: true });
    assert.deepEqual(rules(w.cf), []);
    assert.deepEqual(await mailState(w.env, { zoneId: w.zoneId }), { on: true, status: 'ready' });
    assert.deepEqual(await stopForwarding(w.env, { zoneId: w.zoneId, ruleId }), { stopped: true });   // gone already: fine
    assert.deepEqual(await inboxState(w.env, { email: INBOX }), { id: w.cf.addresses.get(INBOX).id, verified: true });   // the inbox stays confirmed, for whoever else forwards to it
  });
  assert.deepEqual(view(w.cf), [...ROUTING].sort());
  assert.equal([...w.cf.zoneOf(N).mail.rules.values()].length, 1);   // the catch-all, untouched
});

test('mail: a service that is not set up for domains asks Cloudflare nothing, and a Cloudflare that does not answer is a failure that says so', async () => {
  const w = await world();
  await withFetch(w.cf.handler, async () => {
    for (const env of [{}, { HOSTING_ACCOUNT_ID: w.cf.account }]) {
      await assert.rejects(mailState(env, { zoneId: w.zoneId }), code('not_set_up'));
      await assert.rejects(switchMailOn(env, { zoneId: w.zoneId, name: N }), code('not_set_up'));
      await assert.rejects(inboxState(env, { email: INBOX }), code('not_set_up'));
      await assert.rejects(addInbox(env, { email: INBOX }), code('not_set_up'));
      await assert.rejects(askAgain(env, { email: INBOX }), code('not_set_up'));
      await assert.rejects(forward(env, { zoneId: w.zoneId, address: HELLO, inbox: INBOX }), code('not_set_up'));
      await assert.rejects(stopForwarding(env, { zoneId: w.zoneId, ruleId: 'rule-1' }), code('not_set_up'));
    }
  });
  assert.equal(w.cf.calls.length, 0);
  await withFetch(async () => { throw new Error('connection reset'); }, async () => {
    await assert.rejects(mailState(w.env, { zoneId: w.zoneId }), (e) => code('cloudflare')(e) && /connection reset/.test(e.detail));
    await assert.rejects(addInbox(w.env, { email: INBOX }), code('cloudflare'));
  });
  w.cf.failOn(() => true);
  await withFetch(w.cf.handler, async () => {
    await assert.rejects(switchMailOn(w.env, { zoneId: w.zoneId, name: N }), code('cloudflare'));
    await assert.rejects(forward(w.env, { zoneId: w.zoneId, address: HELLO, inbox: INBOX }), code('cloudflare'));
    await assert.rejects(stopForwarding(w.env, { zoneId: w.zoneId, ruleId: 'rule-1' }), code('cloudflare'));
  });
  // A zone Cloudflare no longer has: nothing is forwarded there, so stopping is done, and making a rule is a failure.
  w.cf.failOn(null);
  await withFetch(w.cf.handler, async () => {
    assert.deepEqual(await stopForwarding(w.env, { zoneId: 'zone-gone', ruleId: 'rule-1' }), { stopped: true });
    await assert.rejects(forward(w.env, { zoneId: 'zone-gone', address: HELLO, inbox: INBOX, ruleId: 'rule-1' }), code('cloudflare'));
  });
});

// ─── What a person types ──────────────────────────────────────────────────────

test('mail: the part before the @ is what a person may choose, and a whole address at their domain is cut down to it', () => {
  const good = { hello: 'hello', '  Hello ': 'hello', 'first.last': 'first.last', 'a_b-c.9': 'a_b-c.9', [`hello@${N}`]: 'hello', [`Info@OakBakery.TEST.`]: 'info', ['a'.repeat(64)]: 'a'.repeat(64) };
  for (const [typed, want] of Object.entries(good)) assert.equal(cleanLocal(typed, N), want, typed);
  const bad = ['', '   ', '.hello', 'hello.', 'he..llo', 'he llo', 'héllo', 'hello+shop', 'hello@', '@', 'hello@example.com', `a@b@${N}`, 'a'.repeat(65), '"hello"', 'hello,info', null, undefined];
  for (const typed of bad) assert.throws(() => cleanLocal(typed, N), code('not_an_address'), String(typed));
  assert.throws(() => cleanLocal(`hello@${N}`), code('not_an_address'));   // a whole address, and no domain to hold it against
});

test('mail: the inbox is a plain email address somewhere else', () => {
  const good = { 'ada@example.com': 'ada@example.com', '  Ada.Lovelace+shop@Mail.Example.CO.UK ': 'ada.lovelace+shop@mail.example.co.uk', [`ada@mail.${N}`]: `ada@mail.${N}` };
  for (const [typed, want] of Object.entries(good)) assert.equal(cleanInbox(typed, N), want, typed);
  const bad = ['', 'ada', 'ada@', '@example.com', 'ada@example', 'ada@@example.com', 'ada lovelace@example.com', 'Ada <ada@example.com>', 'ada@example.com, bob@example.com', '.ada@example.com', 'ada.@example.com', 'a..da@example.com', 'ada@-example.com', 'ada@exa_mple.com', `${'a'.repeat(65)}@example.com`, `ada@${'a'.repeat(250)}.com`, 'mailto:ada@example.com', null, undefined];
  for (const typed of bad) assert.throws(() => cleanInbox(typed, N), code('not_an_address'), String(typed));
  assert.throws(() => cleanInbox(`me@${N}`, N), code('same_domain'));
  assert.throws(() => cleanInbox(`Me@OakBakery.Test`, `${N}.`), code('same_domain'));
  assert.equal(cleanInbox(`me@${N}`), `me@${N}`);   // with no domain to hold it against, it is only an address
});

// ─── What a person reads ──────────────────────────────────────────────────────

test('mail: every code has a plain sentence that says what to do next', () => {
  const codes = ['not_confirmed', 'too_soon', 'not_an_address', 'same_domain', 'has_own_mail', 'not_live', 'not_set_up', 'cloudflare'];
  for (const names of [{ address: HELLO, inbox: INBOX, name: N }, {}]) {   // with the names, and with none to hand
    const seen = new Set();
    for (const c of codes) {
      const s = mailSentence(c, names);
      assert.ok(s.length > 40 && /[.]$|"\.$/.test(s), `${c}: ${s}`);
      assert.doesNotMatch(s, /[—–]|null|undefined|  /, c);
      assert.match(s, /^[A-Z]|^oakbakery\.test/, c);
      assert.ok(!seen.has(s), `${c} has a sentence of its own`);
      seen.add(s);
    }
  }
  const told = (c) => mailSentence(c, { address: HELLO, inbox: INBOX, name: N });
  assert.match(told('not_confirmed'), /ada@example\.com has not confirmed yet.*press the button.*hello@oakbakery\.test.*Send it again/);
  assert.match(told('has_own_mail'), /^oakbakery\.test has email of its own, which keeps working as it is\./);
  assert.match(told('same_domain'), /inbox at oakbakery\.test.*somewhere else/);
  assert.match(told('not_live'), /oakbakery\.test is not live.*Finish setting up the domain first/);
  assert.match(told('not_an_address'), /such as hello.*such as you@example\.com/);
  assert.match(told('too_soon'), /to ada@example\.com a few minutes ago.*ten minutes/);
  assert.match(told('cloudflare'), /Try again in a few minutes\.$/);
  assert.equal(mailSentence('something_new', { name: N }), mailSentence('cloudflare', { name: N }));
  assert.match(mailSentence('has_own_mail', { address: HELLO }), /^oakbakery\.test has email/);   // the domain is read from the address
});

// ─── What the service remembers ───────────────────────────────────────────────

test('mail: a site has one forwarded address, and its row follows it from confirming to on', { skip: d1Skip }, async () => {
  const env = { kiln_cloud: fakeD1() };
  assert.equal(await forwardsReady(env), true);
  assert.equal(await forwardRow(env, 'site-1'), null);
  assert.equal(publicForward(null), null);
  await assert.rejects(saveForward(env, 'site-1', { address: HELLO }), code('not_an_address'));   // a new row needs both
  assert.equal(await saveForward(env, 'site-1', { address: ' Hello@OakBakery.test', inbox: 'Ada@Example.com ', inbox_id: 'addr-1', asked_at: 5 }), true);
  let row = await forwardRow(env, 'site-1');
  assert.deepEqual({ address: row.address, inbox: row.inbox, inbox_id: row.inbox_id, rule_id: row.rule_id, state: row.state, asked_at: row.asked_at, on_at: row.on_at },
    { address: HELLO, inbox: INBOX, inbox_id: 'addr-1', rule_id: null, state: 'confirming', asked_at: 5, on_at: null });
  assert.deepEqual(publicForward(row), { address: HELLO, inbox: INBOX, state: 'confirming', since: row.created_at, on_at: null, gives_up_at: row.created_at + 30 * 86400000 });

  await saveForward(env, 'site-1', { state: 'failed', reason: 'cloudflare' });
  assert.equal(publicForward(await forwardRow(env, 'site-1')).error, mailSentence('cloudflare', { address: HELLO, inbox: INBOX }));

  await saveForward(env, 'site-1', { state: 'on', rule_id: 'rule-9' });
  row = await forwardRow(env, 'site-1');
  assert.ok(row.on_at >= row.created_at && row.reason === null);
  const told = publicForward(row);
  assert.deepEqual(told, { address: HELLO, inbox: INBOX, state: 'on', since: row.created_at, on_at: row.on_at });
  assert.doesNotMatch(JSON.stringify(told), /addr-1|rule-9/);   // never an id

  // A new inbox waits to be confirmed again; the site still has one row.
  await saveForward(env, 'site-1', { inbox: 'bob@example.net', inbox_id: 'addr-2', state: 'confirming', reason: 'not_confirmed' });
  row = await forwardRow(env, 'site-1');
  assert.deepEqual({ inbox: row.inbox, state: row.state, on_at: row.on_at, rule_id: row.rule_id, reason: row.reason }, { inbox: 'bob@example.net', state: 'confirming', on_at: null, rule_id: 'rule-9', reason: 'not_confirmed' });
  assert.equal(publicForward(row).error, mailSentence('not_confirmed', { address: HELLO, inbox: 'bob@example.net' }));
  assert.equal(env.kiln_cloud.row('SELECT COUNT(*) AS n FROM forwards').n, 1);

  await saveForward(env, 'site-1', { state: 'off', rule_id: null });
  // Switched off by its owner: nothing is wrong, so nothing is said to be.
  assert.deepEqual(publicForward(await forwardRow(env, 'site-1')), { address: HELLO, inbox: 'bob@example.net', state: 'off', since: row.created_at, on_at: null });
  assert.equal((await forwardRow(env, 'site-1')).rule_id, null);
  assert.equal(await forgetForward(env, 'site-1'), true);
  assert.equal(await forwardRow(env, 'site-1'), null);
});

test('mail: an account\'s forwarded addresses are read by site, and the rows that wait are read in turn', { skip: d1Skip }, async () => {
  const env = { kiln_cloud: fakeD1() };
  env.kiln_cloud.exec("INSERT INTO accounts (id, github_login, email, created_at) VALUES ('acct-1', 'ada', 'ada@example.com', 1)");
  env.kiln_cloud.exec("INSERT INTO accounts (id, github_login, email, created_at) VALUES ('acct-2', 'bob', 'bob@example.net', 1)");
  addSite(env, { id: 'site-1' });
  addSite(env, { id: 'site-2', repo: 'ada/two', origin: 'https://two.example' });
  addSite(env, { id: 'site-3', account_id: 'acct-2', repo: 'bob/three', origin: 'https://three.example' });
  await saveForward(env, 'site-1', { address: HELLO, inbox: INBOX });
  await saveForward(env, 'site-2', { address: 'hello@two.test', inbox: INBOX, state: 'on' });
  await saveForward(env, 'site-3', { address: 'hello@three.test', inbox: 'bob@example.net' });
  const mine = await forwardsForAccount(env, 'acct-1');
  assert.deepEqual(Object.keys(mine).sort(), ['site-1', 'site-2']);
  assert.equal(mine['site-2'].state, 'on');
  assert.ok(mine['site-2'].on_at);
  assert.deepEqual(await forwardsForAccount(env, 'acct-none'), {});

  env.kiln_cloud.exec('UPDATE forwards SET updated_at = ? WHERE site_id = ?', 100, 'site-3');
  env.kiln_cloud.exec('UPDATE forwards SET updated_at = ? WHERE site_id = ?', 200, 'site-1');
  assert.deepEqual((await forwardsConfirming(env)).map(r => r.site_id), ['site-3', 'site-1']);   // never the one that is on
  assert.deepEqual((await forwardsConfirming(env, 1)).map(r => r.site_id), ['site-3']);
  await saveForward(env, 'site-3', {});   // looked at, nothing to change: it goes to the back
  assert.deepEqual((await forwardsConfirming(env, 1)).map(r => r.site_id), ['site-1']);
});

test('mail: a database the migration has not reached fails no page', { skip: d1Skip }, async () => {
  const env = { kiln_cloud: fakeD1({ upTo: 6 }) };
  assert.equal(await forwardsReady(env), false);
  assert.equal(await forwardRow(env, 'site-1'), null);
  assert.equal(await saveForward(env, 'site-1', { address: HELLO, inbox: INBOX }), false);
  assert.deepEqual(await forwardsForAccount(env, 'acct-1'), {});
  assert.deepEqual(await forwardsConfirming(env), []);
  assert.equal(await forgetForward(env, 'site-1'), false);
});

test('mail: a switch that cannot put a record back says so in the log and still fails', async () => {
  const w = await world(NO_MAIL);
  w.cf.failOn((method, path) => method === 'POST');
  let lines;
  await withFetch(w.cf.handler, async () => {
    lines = await quiet(async () => { await assert.rejects(switchMailOn(w.env, { zoneId: w.zoneId, name: N }), code('cloudflare')); });
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[domain-mail\] a "no mail here" record of oakbakery\.test could not be put back/);
});
