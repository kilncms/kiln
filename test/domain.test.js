/**
 * A hosted site on its owner's own domain (worker/domain.js). The real code
 * runs over an in-memory Cloudflare that holds zones, records and the names
 * attached to Workers, and over a stand-in for the registry and the public
 * DNS, so each test can look at what the domain's DNS would hold afterwards.
 * The domains are made up (the ".test" ending is kept for this). Nothing here
 * touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFetch } from './worker-harness.js';
import { fakeCloudflare, fakeLookups } from './cloudflare-fake.js';
import { fakeD1, d1Skip } from './d1-fake.js';
import {
  cleanDomain, lookUp, whatStops, sellerHelp, prepareDomain, domainStatus, siteAnswers, detachDomain, removeWaitingDomain, exportRecords,
  domainSentence, publicDomain, domainRow, domainForName, saveDomain, recordKind, kindWords, txtWords, domainsOn, DomainError, LIMITS,
  redirectToOne, alwaysHttps, publicLook, forgetDomain, domainsForAccount, domainsReady,
} from '../worker/domain.js';

const N = 'oakbakery.test';
const WORKER = 'oakbakery-12345678';
const DKIM = `v=DKIM1; k=rsa; p=${'A'.repeat(300)}`;   // longer than one piece of a TXT record holds
const MS_KEY = 'selector1-oakbakery-test._domainkey.oakbakery.onmicrosoft.com';

// What Cloudflare's copy finds: the website, the seller's note, and some of the email.
const scanned = [
  { type: 'A', name: N, content: '203.0.113.10' },
  { type: 'A', name: N, content: '203.0.113.11' },
  { type: 'CNAME', name: `www.${N}`, content: N },
  { type: 'CNAME', name: `_domainconnect.${N}`, content: '_domainconnect.gd.domaincontrol.com' },
  { type: 'MX', name: N, content: 'aspmx.l.google.com', priority: 1 },
  { type: 'TXT', name: N, content: '"v=spf1 include:_spf.google.com ~all"' },
  { type: 'TXT', name: N, content: '"google-site-verification=abc123"' },
  { type: 'A', name: `mail.${N}`, content: '203.0.113.25' },
  { type: 'CNAME', name: `shop.${N}`, content: 'shops.myshopify.com' },
];
// What the world knows of the domain. The copy above misses the last three.
const known = (over = {}) => ({ [N]: {
  seller: { name: 'GoDaddy.com, LLC', id: 146 }, nameServers: ['NS51.DOMAINCONTROL.COM', 'ns52.domaincontrol.com'], dnssec: false,
  dns: [
    { name: N, type: 'NS', data: 'ns51.domaincontrol.com.' },
    { name: N, type: 'MX', data: '1 aspmx.l.google.com.' },
    { name: N, type: 'TXT', data: '"v=spf1 include:_spf.google.com ~all"' },
    { name: N, type: 'TXT', data: '"google-site-verification=abc123"' },
    { name: `_dmarc.${N}`, type: 'TXT', data: `"v=DMARC1; p=none; rua=mailto:postmaster@${N}"` },
    { name: `google._domainkey.${N}`, type: 'TXT', data: `"${DKIM.slice(0, 255)}" "${DKIM.slice(255)}"` },
    { name: `selector1._domainkey.${N}`, type: 'CNAME', data: `${MS_KEY}.`, then: [{ name: MS_KEY, type: 'TXT', data: '"v=DKIM1; k=rsa; p=BBBB"' }] },
  ],
  ...over,
} });

function world({ scan = scanned } = {}) {
  const cf = fakeCloudflare();
  cf.addScript(WORKER);
  cf.scanFinds(N, scan);
  return { cf, env: { HOSTING_ACCOUNT_ID: cf.account, HOSTING_API_TOKEN: cf.token } };
}
const look = (domains = known(), down = {}) => lookUp(N, { fetchImpl: fakeLookups(domains, down).fetchImpl });
const code = (c) => (e) => e instanceof DomainError && e.code === c;
const own = (cf, name = N) => cf.recordsOf(name).filter(r => !r.meta);   // without the records a Worker's name brings with it
const quiet = async (fn) => { const real = console.warn; const lines = []; console.warn = (l) => lines.push(String(l)); try { await fn(); } finally { console.warn = real; } return lines; };

// ─── What a person types ──────────────────────────────────────────────────────

test('domain: what a person types becomes the bare name they bought', () => {
  const good = {
    'example.com': 'example.com',
    '  https://www.Example.com/about  ': 'example.com',
    'WWW.EXAMPLE.COM.': 'example.com',
    'http://blog.example.com?x=1#top': 'example.com',
    'example.co.uk': 'example.co.uk',
    'https://www.shop.example.co.uk/': 'example.co.uk',
    'my-club.org': 'my-club.org',
    'münchen.de': 'xn--mnchen-3ya.de',
  };
  for (const [typed, name] of Object.entries(good)) assert.equal(cleanDomain(typed), name, typed);
});

test('domain: an address with a port, an IP address, a single word, an ending by itself and Kiln\'s own names are refused', () => {
  const bad = ['', null, undefined, 'localhost', 'example', 'com', 'co.uk', 'example.com:8080', 'http://example.com:8080/', '192.168.1.1', 'http://203.0.113.9/', '[::1]',
    'ada@example.com', 'kilncms.com', 'app.kilncms.com', 'https://demo.kilncms.com/x', 'workers.dev', 'club-12345678.kiln-sites.workers.dev', 'mysite.pages.dev',
    'exa mple.com', 'exam_ple.com', '-bad.com', 'a..com', '.com', 'example.c'];
  for (const typed of bad) assert.throws(() => cleanDomain(typed), code('not_a_domain'), String(typed));
});

// ─── Looking ──────────────────────────────────────────────────────────────────

test('domain: a look says who sold the domain, that it takes email, and what the public DNS shows for email', async () => {
  const dns = fakeLookups(known());
  const out = await lookUp(N, { fetchImpl: dns.fetchImpl });
  assert.deepEqual({ name: out.name, seller: out.seller, nameServers: out.nameServers, dnssec: out.dnssec, atCloudflare: out.atCloudflare, mail: out.mail },
    { name: N, seller: { name: 'GoDaddy.com, LLC', id: 146 }, nameServers: ['ns51.domaincontrol.com', 'ns52.domaincontrol.com'], dnssec: false, atCloudflare: false, mail: true });
  assert.deepEqual(out.found, [
    { type: 'MX', name: N, content: 'aspmx.l.google.com', priority: 1 },
    { type: 'TXT', name: N, content: 'v=spf1 include:_spf.google.com ~all' },
    { type: 'TXT', name: N, content: 'google-site-verification=abc123' },
    { type: 'TXT', name: `_dmarc.${N}`, content: `v=DMARC1; p=none; rua=mailto:postmaster@${N}` },
    { type: 'CNAME', name: `selector1._domainkey.${N}`, content: MS_KEY },
    { type: 'TXT', name: `google._domainkey.${N}`, content: DKIM },
  ], 'a long record is one piece again, and a name that points on is not given the other name\'s record');
  assert.equal(whatStops(out), null);
  const asked = dns.calls.filter(c => c.url.startsWith('https://cloudflare-dns.com/'));
  assert.equal(dns.calls.length - asked.length, 1, 'the registry is asked once');
  assert.equal(dns.calls.find(c => c.url.startsWith('https://rdap.org/')).redirect, 'follow');
  assert.ok(asked.every(c => c.accept === 'application/dns-json'));
  for (const sel of ['selector1', 'selector2', 'google', 'default', 'k1', 's1', 's2']) for (const type of ['CNAME', 'TXT']) {
    assert.ok(asked.some(c => c.url.includes(`name=${sel}._domainkey.${N}&type=${type}`)), `${sel} ${type}`);
  }
});

test('domain: a look never fails, and says what it could not read', async () => {
  // Nothing answers at all.
  assert.deepEqual(await look(known(), { rdap: true, dns: true }), { name: N, registered: null, seller: null, nameServers: [], dnssec: null, atCloudflare: false, mail: false, found: [] });
  assert.deepEqual(await lookUp(N, { fetchImpl: () => { throw new Error('no network'); } }), { name: N, registered: null, seller: null, nameServers: [], dnssec: null, atCloudflare: false, mail: false, found: [] });
  // The registry is silent: the public DNS still says where the domain is and that it takes email.
  const half = await look(known({ rdap: false }));
  assert.equal(half.seller, null);
  assert.deepEqual(half.nameServers, ['ns51.domaincontrol.com']);
  assert.equal(half.dnssec, false, 'the public DNS shows no DS record');
  assert.equal(half.mail, true);
  // The public DNS is silent: the registry still says who sold it.
  const other = await look(known(), { dns: true });
  assert.equal(other.seller.id, 146);
  assert.equal(other.mail, false);
  assert.deepEqual(other.found, []);
});

test('domain: DNSSEC is seen from the registry or from the public DNS, a domain that takes no email is told apart, and one bought at Cloudflare is named', async () => {
  assert.equal((await look(known({ dnssec: true }))).dnssec, true);
  const ds = { name: N, type: 'DS', data: '2371 13 2 0F0F0F0F' };
  assert.equal((await look(known({ rdap: false, dns: [ds] }))).dnssec, true, 'the registry is silent and a DS record is there');
  assert.equal((await look(known({ dnssec: false, dns: [ds] }))).dnssec, true, 'either one is enough to stop');
  assert.equal(whatStops(await look(known({ dnssec: true }))), 'dnssec_on');
  const none = await look(known({ dns: [{ name: N, type: 'MX', data: '0 .' }] }));
  assert.equal(none.mail, false, '"0 ." says the domain takes no email');
  assert.deepEqual(none.found, [{ type: 'MX', name: N, content: '.', priority: 0 }]);
  const atCf = await look(known({ seller: { name: 'Cloudflare, Inc.', id: 1910 } }));
  assert.equal(atCf.atCloudflare, true);
  assert.equal(whatStops(atCf), 'at_cloudflare');
  assert.equal(whatStops(null), null);
});

test('domain: each common seller gets its own page on changing name servers, and any other gets Cloudflare\'s', () => {
  const general = 'https://developers.cloudflare.com/dns/nameservers/update-nameservers/';
  const byId = { 146: 'GoDaddy', 1068: 'Namecheap', 895: 'Squarespace', 69: 'Hover (Tucows)', 2: 'Network Solutions', 625: 'Name.com', 1861: 'Porkbun', 83: 'IONOS', 1154: 'Bluehost', 81: 'Gandi', 472: 'Dynadot', 3817: 'Wix' };
  for (const [id, name] of Object.entries(byId)) {
    const help = sellerHelp({ name: 'whatever the registry calls it', id: Number(id) });
    assert.equal(help.name, name);
    assert.equal(help.known, true);
    assert.match(help.url, /^https:\/\/[a-z0-9.-]+\/\S*$/, name);
  }
  assert.match(sellerHelp({ id: 146 }).url, /godaddy\.com/);
  assert.match(sellerHelp({ id: 1068 }).url, /namecheap\.com/);
  // With no number, the name is enough. Google's domains are Squarespace's now.
  assert.equal(sellerHelp({ name: 'GoDaddy.com, LLC', id: null }).name, 'GoDaddy');
  assert.equal(sellerHelp({ name: 'Google LLC', id: null }).name, 'Squarespace');
  assert.equal(sellerHelp({ name: 'FastDomain Inc.', id: null }).name, 'Bluehost');
  assert.equal(sellerHelp({ name: 'Tucows Domains Inc.', id: null }).name, 'Hover (Tucows)');
  assert.deepEqual(sellerHelp({ name: 'Some Small Registrar Ltd', id: 99999 }), { name: 'Some Small Registrar Ltd', url: general, known: false });
  assert.deepEqual(sellerHelp(null), { name: null, url: general, known: false });
  assert.equal(sellerHelp({ id: 2 }).url, general, 'a seller whose page could not be confirmed gets the general one');
});

// ─── Making everything ready ──────────────────────────────────────────────────

test('domain: everything is made ready before the owner changes anything, and email is left working', async () => {
  const w = world();
  const seen = await look();
  let out;
  await withFetch(w.cf.handler, async () => { out = await prepareDomain(w.env, { name: N, worker: WORKER, look: seen }); });
  const zone = w.cf.zoneOf(N);
  assert.equal(zone.status, 'pending', 'the zone waits for the name servers');
  assert.equal(out.zoneId, zone.id);
  assert.deepEqual(out.nameServers, zone.name_servers);
  assert.equal(out.nameServers.length, 2);

  const recs = own(w.cf);
  // Kiln replaces the website records only.
  assert.deepEqual(recs.filter(r => ['A', 'AAAA', 'CNAME'].includes(r.type) && [N, `www.${N}`].includes(r.name)), [], 'the old host\'s records at the bare name and www are gone');
  assert.deepEqual(recs.filter(r => r.name.startsWith('_domainconnect.')), [], 'the seller\'s note is gone');
  // Never break email: nothing that was copied goes through Cloudflare.
  assert.deepEqual(recs.filter(r => r.proxied), [], 'every kept record is DNS only');
  assert.equal(recs.find(r => r.name === `mail.${N}`).proxied, false, 'the mail server\'s address arrived proxied and is DNS only now');
  assert.equal(recs.find(r => r.name === `shop.${N}`).content, 'shops.myshopify.com', 'another service\'s name is kept as it was');
  assert.equal(recs.filter(r => r.type === 'MX').length, 1, 'a record the copy already had is not added twice');
  assert.equal(recs.filter(r => r.type === 'TXT' && r.name === N).length, 2);
  // What the public DNS showed and the copy missed is added.
  assert.equal(recs.find(r => r.name === `_dmarc.${N}`).content, `"v=DMARC1; p=none; rua=mailto:postmaster@${N}"`);
  assert.equal(recs.find(r => r.name === `google._domainkey.${N}`).content, `"${DKIM}"`);
  assert.deepEqual((({ type, content, proxied }) => ({ type, content, proxied }))(recs.find(r => r.name === `selector1._domainkey.${N}`)), { type: 'CNAME', content: MS_KEY, proxied: false });
  assert.equal(recs.length, 8);

  // Only the site's own two names go through Kiln.
  assert.deepEqual([...w.cf.workerDomains.values()].map(d => [d.hostname, d.service, d.zone_id, d.environment]), [[N, WORKER, zone.id, 'production'], [`www.${N}`, WORKER, zone.id, 'production']]);
  assert.deepEqual(out.attached, [...w.cf.workerDomains.values()].map(d => ({ hostname: d.hostname, id: d.id })));
  assert.deepEqual(w.cf.recordsOf(N).filter(r => r.meta).map(r => `${r.type} ${r.name} ${r.content}`), [`AAAA ${N} 100::`, `AAAA www.${N} 100::`]);

  // Say what Kiln could see: every kept record, email first.
  assert.deepEqual(out.records.map(r => `${r.kind} ${r.type} ${r.name}`), [
    `mail TXT _dmarc.${N}`, `mail TXT google._domainkey.${N}`, `mail A mail.${N}`, `mail MX ${N}`, `mail TXT ${N}`, `mail CNAME selector1._domainkey.${N}`,
    `proof TXT ${N}`, `other CNAME shop.${N}`,
  ]);
  assert.deepEqual(out.records.find(r => r.type === 'MX'), { type: 'MX', name: N, content: '1 aspmx.l.google.com', kind: 'mail' }, 'a mail server is shown with its number in front');
  assert.deepEqual(out.oldNameServers, ['ns1.old-host.example', 'ns2.old-host.example'], 'the name servers that are being replaced are handed back');
  assert.equal(out.records.find(r => r.kind === 'proof').content, 'google-site-verification=abc123', 'a note is shown without its quotation marks');
  assert.equal(out.records.find(r => r.name === `google._domainkey.${N}`).content, DKIM);

  assert.ok(w.cf.calls.every(c => c.auth === w.cf.token), 'every call carries the hosting account\'s token');
  assert.ok(w.cf.calls.every(c => c.path.startsWith('/zones') || c.path === '/workers/domains'), 'nothing else in the account is touched');
  // The service may make only so many requests in one run.
  assert.equal(w.cf.calls.filter(c => c.path.endsWith('/dns_records/batch')).length, 1, 'every delete, change and add went in one call');
  assert.equal(w.cf.calls.filter(c => /\/dns_records\/rec-/.test(c.path)).length, 0, 'no record was changed by a call of its own');
  assert.equal(w.cf.calls.length, 6, 'six calls in all: the zone, the copy, the list, the changes, and the two names');
});

test('domain: the old DNS host\'s records about itself and the old host\'s catch-all go, and a real hand-over and another catch-all stay', async () => {
  // What the copy brought back for a parked domain whose old DNS answers for every name.
  const parked = [
    { type: 'A', name: N, content: '203.0.113.10' },
    { type: 'A', name: `www.${N}`, content: '203.0.113.10' },
    { type: 'A', name: `*.${N}`, content: '203.0.113.10' },
    { type: 'MX', name: N, content: '.', priority: 0 },
    { type: 'MX', name: `www.${N}`, content: '.', priority: 0 },
    { type: 'MX', name: `*.${N}`, content: '.', priority: 0 },
    { type: 'TXT', name: N, content: '"v=spf1 -all"' },
    ...['_dmarc', '_domainkey', 'aws', 'dev', 'email'].flatMap(sub => ['NS1.old-host.example.', 'ns2.old-host.example'].map(ns => ({ type: 'NS', name: `${sub}.${N}`, content: ns }))),
    { type: 'NS', name: `team.${N}`, content: 'ns-99.awsdns-12.com' },
  ];
  const w = world({ scan: parked });
  let out;
  await withFetch(w.cf.handler, async () => { out = await prepareDomain(w.env, { name: N, worker: WORKER }); });
  const recs = own(w.cf);
  assert.deepEqual(recs.filter(r => r.type === 'NS').map(r => `${r.name} ${r.content}`), [`team.${N} ns-99.awsdns-12.com`], 'only the hand-over of a part of the domain to another service is kept');
  assert.deepEqual(recs.filter(r => r.type === 'A'), [], 'the catch-all that pointed at the old host went with the website records');
  assert.deepEqual(recs.filter(r => r.type === 'MX').map(r => r.name).sort(), [`*.${N}`, N, `www.${N}`].sort(), 'records that only repeat the bare name\'s are harmless and kept');
  assert.equal(recs.length, 5);
  assert.equal(out.records.length, 5);
  assert.equal(w.cf.zoneOf(N).batches, 1, 'in one call');

  // A catch-all that points somewhere else is the owner's own, and stays.
  const other = world({ scan: [{ type: 'A', name: N, content: '203.0.113.10' }, { type: 'CNAME', name: `*.${N}`, content: 'apps.elsewhere.example' }] });
  await withFetch(other.cf.handler, async () => { await prepareDomain(other.env, { name: N, worker: WORKER }); });
  assert.deepEqual(own(other.cf).map(r => `${r.type} ${r.name} ${r.content} ${r.proxied}`), [`CNAME *.${N} apps.elsewhere.example false`]);

  // With no word from Cloudflare about the old name servers, the look's are used.
  const quietZone = world({ scan: [{ type: 'NS', name: `dev.${N}`, content: 'ns51.domaincontrol.com' }, { type: 'NS', name: `team.${N}`, content: 'ns-99.awsdns-12.com' }] });
  await withFetch(async (url, init) => {
    const res = await quietZone.cf.handler(url, init);
    if (init.method !== 'POST' || !url.endsWith('/zones')) return res;
    const body = await res.json();
    return new Response(JSON.stringify({ ...body, result: { ...body.result, original_name_servers: null } }), { status: 200 });
  }, async () => {
    const made = await prepareDomain(quietZone.env, { name: N, worker: WORKER, look: { nameServers: ['ns51.domaincontrol.com', 'ns52.domaincontrol.com'], found: [] } });
    assert.deepEqual(made.oldNameServers, ['ns51.domaincontrol.com', 'ns52.domaincontrol.com']);
  });
  assert.deepEqual(own(quietZone.cf).map(r => r.name), [`team.${N}`]);
});

test('domain: the changes to a domain\'s records are all or nothing', async () => {
  // A record Cloudflare will not take fails the whole set-up, and the zone is taken away again.
  const w = world();
  const seen = await look();
  w.cf.failOn((method, path) => path.endsWith('/dns_records/batch'));
  await withFetch(w.cf.handler, async () => { await assert.rejects(() => prepareDomain(w.env, { name: N, worker: WORKER, look: seen }), code('cloudflare')); });
  assert.equal(w.cf.zones.size, 0);
  // A domain with nothing to change makes no such call.
  const empty = world({ scan: [] });
  await withFetch(empty.cf.handler, async () => { await prepareDomain(empty.env, { name: N, worker: WORKER }); });
  assert.equal(empty.cf.calls.some(c => c.path.endsWith('/dns_records/batch')), false);
  // The stand-in keeps to all or nothing as the real service does: one record that is there already, and nothing in the call happens.
  const z = world();
  await withFetch(z.cf.handler, async () => {
    const { zoneId } = await prepareDomain(z.env, { name: N, worker: WORKER });
    const before = own(z.cf).map(r => r.id);
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/batch`, { method: 'POST', headers: { Authorization: `Bearer ${z.cf.token}` },
      body: JSON.stringify({ deletes: [{ id: own(z.cf).find(r => r.type === 'MX').id }], posts: [{ type: 'TXT', name: N, content: '"v=spf1 include:_spf.google.com ~all"' }] }) });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).errors[0].code, 81058);
    assert.deepEqual(own(z.cf).map(r => r.id), before, 'the delete in the same call did not happen either');
  });
});

test('domain: a name nobody has bought is told apart, and nothing is made for it', async () => {
  assert.equal((await look()).registered, true);
  // The registry knows no such name, and the public DNS shows no name servers for it.
  const free = await lookUp('nobody-owns-this.test', { fetchImpl: fakeLookups({}).fetchImpl });
  assert.equal(free.registered, false);
  assert.equal(whatStops(free), 'not_registered');
  // An ending with no registry to ask: its name servers show that somebody owns the domain.
  const noRegistry = await look(known({ registered: false }));
  assert.equal(noRegistry.registered, true);
  assert.equal(whatStops(noRegistry), null);
  // The registry cannot be reached, or says no while the public DNS cannot be asked: not known, and nothing is stopped.
  assert.equal((await look(known({ rdap: false }))).registered, null);
  assert.equal((await look(known({ registered: false }), { dns: true })).registered, null);
  assert.equal(whatStops({ registered: null }), null);
  const w = world();
  await withFetch(w.cf.handler, async () => { await assert.rejects(() => prepareDomain(w.env, { name: N, worker: WORKER, look: { registered: false, found: [] } }), code('not_registered')); });
  assert.equal(w.cf.calls.length, 0, 'Cloudflare, which would have taken the name, was not asked');
});

test('domain: with nothing known beforehand the copy alone is used, and a domain with no records at all is still made ready', async () => {
  const w = world();
  await withFetch(w.cf.handler, async () => {
    const out = await prepareDomain(w.env, { name: N, worker: WORKER });
    assert.equal(out.records.length, 5);
    assert.deepEqual(own(w.cf).filter(r => r.proxied), []);
  });
  const bare = world({ scan: [] });
  await withFetch(bare.cf.handler, async () => {
    const out = await prepareDomain(bare.env, { name: N, worker: WORKER, look: { found: [] } });
    assert.deepEqual(out.records, []);
    assert.equal(out.attached.length, 2);
  });
});

test('domain: where the copy and the public DNS disagree about a name that points on, the copy stays, and nothing outside the domain is added', async () => {
  const w = world({ scan: [...scanned, { type: 'TXT', name: `selector1._domainkey.${N}`, content: '"v=DKIM1; k=rsa; p=CCCC"' }] });
  const seen = await look();
  seen.found.push({ type: 'TXT', name: 'elsewhere.test', content: 'not ours' }, { type: 'A', name: N, content: '203.0.113.99' }, { type: 'CNAME', name: `_domainconnect.${N}`, content: 'x.example' });
  await withFetch(w.cf.handler, async () => {
    const out = await prepareDomain(w.env, { name: N, worker: WORKER, look: seen });
    assert.equal(out.records.find(r => r.name === `selector1._domainkey.${N}`).type, 'TXT');
    assert.equal(out.records.some(r => r.name === 'elsewhere.test' || r.name.startsWith('_domainconnect') || (r.type === 'A' && r.name === N)), false);
  });
  assert.equal(own(w.cf).filter(r => r.name === `selector1._domainkey.${N}`).length, 1);
});

test('domain: a failure after the zone was made deletes the zone again, so a failed try leaves nothing behind', async () => {
  // The second name cannot be attached: the first already is.
  const w = world();
  let puts = 0;
  w.cf.failOn((method, path) => method === 'PUT' && path === '/workers/domains' && ++puts === 2);
  await withFetch(w.cf.handler, async () => {
    await assert.rejects(() => prepareDomain(w.env, { name: N, worker: WORKER }), code('cloudflare'));
  });
  assert.equal(w.cf.zones.size, 0, 'the zone is gone');
  assert.equal(w.cf.workerDomains.size, 0, 'and so is the name that was attached');

  // The copy fails.
  const s = world();
  s.cf.failOn((method, path) => path.endsWith('/dns_records/scan'));
  await withFetch(s.cf.handler, async () => { await assert.rejects(() => prepareDomain(s.env, { name: N, worker: WORKER }), code('cloudflare')); });
  assert.equal(s.cf.zones.size, 0);

  // The site's Worker is not there.
  const m = world();
  await withFetch(m.cf.handler, async () => { await assert.rejects(() => prepareDomain(m.env, { name: N, worker: 'no-such-worker' }), code('cloudflare')); });
  assert.equal(m.cf.zones.size, 0);

  // Even the clearing up fails: the failure is still told, and the operator's log names the zone.
  const d = world();
  d.cf.failOn((method, path) => path.endsWith('/dns_records/scan') || (method === 'DELETE' && /^\/zones\/[^/]+$/.test(path)));
  const lines = await quiet(() => withFetch(d.cf.handler, async () => { await assert.rejects(() => prepareDomain(d.env, { name: N, worker: WORKER }), code('cloudflare')); }));
  assert.equal(lines.length, 1);
  assert.deepEqual((({ evt, name, zone }) => ({ evt, name, zone }))(JSON.parse(lines[0])), { evt: 'domain_cleanup_failed', name: N, zone: d.cf.zoneOf(N).id });
});

test('domain: DNSSEC on stops before anything is made, and so does a domain bought at Cloudflare', async () => {
  const w = world();
  await withFetch(w.cf.handler, async () => {
    await assert.rejects(() => prepareDomain(w.env, { name: N, worker: WORKER, look: { dnssec: true, found: [] } }), code('dnssec_on'));
    await assert.rejects(() => prepareDomain(w.env, { name: N, worker: WORKER, look: { atCloudflare: true, dnssec: false, found: [] } }), code('at_cloudflare'));
  });
  assert.equal(w.cf.calls.length, 0, 'Cloudflare was not asked for anything');
  assert.equal(w.cf.zones.size, 0);
});

test('domain: each way Cloudflare refuses a domain has its own code, and a zone that was already there is never deleted', async () => {
  const refusals = [
    [1049, `${N} is not a registered domain`, 'not_registered'],
    [1099, `We were unable to identify ${N} as a registered domain. Please ensure you are providing the root domain and not any subdomains.`, 'not_registered'],
    [1097, 'This zone is banned and cannot be added to Cloudflare at this time, please contact Cloudflare Support.', 'refused'],
    [9999, 'This zone is blocked from being added.', 'refused'],
    [1118, 'You have reached the limit of pending zones for this account.', 'too_many'],
    [1234, 'Something else entirely', 'cloudflare'],
  ];
  for (const [number, words, want] of refusals) {
    const w = world();
    w.cf.refuseZone(N, number, words);
    await withFetch(w.cf.handler, async () => { await assert.rejects(() => prepareDomain(w.env, { name: N, worker: WORKER }), code(want), words); });
    assert.equal(w.cf.zones.size, 0);
    assert.equal(w.cf.calls.length, 1, 'nothing is tried after the refusal');
  }
  // The domain is already on Kiln.
  const w = world();
  await withFetch(w.cf.handler, async () => {
    const first = await prepareDomain(w.env, { name: N, worker: WORKER });
    await assert.rejects(() => prepareDomain(w.env, { name: N, worker: WORKER }), code('already_here'));
    assert.equal(w.cf.zoneOf(N).id, first.zoneId, 'the zone that was there is still there');
    assert.equal(w.cf.workerDomains.size, 2, 'and still answers for the site');
    assert.equal(own(w.cf).length, 5);
  });
});

test('domain: nothing is tried when the service is not set up for domains', async () => {
  assert.equal(domainsOn({ HOSTING_ACCOUNT_ID: 'a', HOSTING_API_TOKEN: 't' }), true);
  assert.equal(domainsOn({ HOSTING_ACCOUNT_ID: 'a' }), false);
  await withFetch(() => { throw new Error('the network must not be touched'); }, async () => {
    for (const run of [
      () => prepareDomain({}, { name: N, worker: WORKER }), () => domainStatus({}, { zoneId: 'z' }), () => detachDomain({}, { zoneId: 'z', name: N }),
      () => removeWaitingDomain({}, { zoneId: 'z' }), () => exportRecords({}, { zoneId: 'z' }),
    ]) await assert.rejects(run, code('not_set_up'));
  });
});

// ─── Has the change taken hold ────────────────────────────────────────────────

test('domain: the status follows what Cloudflare has seen of the name servers, and a check can be asked for first', async () => {
  const w = world();
  await withFetch(w.cf.handler, async () => {
    const { zoneId, nameServers } = await prepareDomain(w.env, { name: N, worker: WORKER });
    assert.deepEqual(await domainStatus(w.env, { zoneId }), { status: 'waiting', nameServers });
    assert.equal(w.cf.zoneOf(N).checks, 0, 'no check is asked for unless it is wanted');

    w.cf.calls.length = 0;
    assert.equal((await domainStatus(w.env, { zoneId, recheck: true })).status, 'waiting');
    assert.equal(w.cf.zoneOf(N).checks, 1);
    assert.deepEqual(w.cf.calls.map(c => `${c.method} ${c.path}`), [`PUT /zones/${zoneId}/activation_check`, `GET /zones/${zoneId}`], 'the check comes first');

    w.cf.setStatus(N, 'active');
    assert.deepEqual(await domainStatus(w.env, { zoneId }), { status: 'active', nameServers });
    // Cloudflare takes a check only so often: its refusal is not a failure.
    w.cf.failOn((method, path) => path.endsWith('/activation_check'));
    assert.equal((await domainStatus(w.env, { zoneId, recheck: true })).status, 'active');
    w.cf.failOn(null);

    w.cf.setStatus(N, 'moved');
    assert.equal((await domainStatus(w.env, { zoneId })).status, 'moved');
    w.cf.setStatus(N, 'deleted');
    assert.equal((await domainStatus(w.env, { zoneId })).status, 'gone');
    w.cf.setStatus(N, 'deactivated');
    await assert.rejects(() => domainStatus(w.env, { zoneId }), code('cloudflare'), 'a status with no word here decides nothing');
    // A zone Cloudflare no longer has: it answers 400 with its error 1001, not a plain "not found".
    w.cf.zones.clear();
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}`, { headers: { Authorization: `Bearer ${w.cf.token}` } });
    assert.deepEqual([res.status, (await res.json()).errors[0].code], [400, 1001]);
    assert.deepEqual(await domainStatus(w.env, { zoneId }), { status: 'gone', nameServers: [] });
    assert.deepEqual(await removeWaitingDomain(w.env, { zoneId }), { removed: true, status: 'gone' });
    await assert.rejects(() => exportRecords(w.env, { zoneId }), code('no_records'), 'and there is nothing left to hand over');
  });
});

test('domain: the site gets one address, with www sent on to the bare name or the other way round, and HTTPS always', async () => {
  const w = world();
  await withFetch(w.cf.handler, async () => {
    const { zoneId } = await prepareDomain(w.env, { name: N, worker: WORKER });
    assert.deepEqual(await redirectToOne(w.env, { zoneId, name: N }), { from: `www.${N}`, to: N });
    let rules = w.cf.zoneOf(N).redirects;
    assert.equal(rules.length, 1);
    // The body that was tried against the real Cloudflare and taken, key for key and in its order.
    assert.equal(JSON.stringify({ rules }), JSON.stringify({ rules: [{
      action: 'redirect', description: 'www goes to the bare name', expression: `(http.host eq "www.${N}")`,
      action_parameters: { from_value: { status_code: 301, preserve_query_string: true, target_url: { expression: `concat("https://${N}", http.request.uri.path)` } } },
    }] }));
    // A site whose address on record is the www one keeps it.
    assert.deepEqual(await redirectToOne(w.env, { zoneId, name: N, www: true }), { from: N, to: `www.${N}` });
    rules = w.cf.zoneOf(N).redirects;
    assert.equal(rules.length, 1, 'written again, it replaces the rule');
    assert.equal(JSON.stringify({ rules }), JSON.stringify({ rules: [{
      action: 'redirect', description: 'the bare name goes to www', expression: `(http.host eq "${N}")`,
      action_parameters: { from_value: { status_code: 301, preserve_query_string: true, target_url: { expression: `concat("https://www.${N}", http.request.uri.path)` } } },
    }] }));
    assert.equal(w.cf.zoneOf(N).settings.always_use_https, undefined);
    assert.equal(await alwaysHttps(w.env, { zoneId }), true);
    assert.equal(w.cf.zoneOf(N).settings.always_use_https, 'on');
  });
  await assert.rejects(() => redirectToOne({}, { zoneId: 'z', name: N }), code('not_set_up'));
  await assert.rejects(() => alwaysHttps({}, { zoneId: 'z' }), code('not_set_up'));
});

test('domain: the site answers at its domain only with a 200, after three redirects at most that stay on the name or its www', async () => {
  const web = (pages) => {
    const asked = [];
    const fetchImpl = async (url, init = {}) => {
      asked.push(url);
      assert.equal(init.redirect, 'manual', 'a redirect is never followed unseen');
      const a = pages[url];
      if (a === undefined) throw new TypeError('fetch failed');
      return typeof a === 'number' ? new Response('', { status: a }) : new Response(null, { status: 301, headers: { location: a } });
    };
    return { asked, fetchImpl };
  };
  const yes = [
    { [`https://${N}/`]: 200 },
    { [`https://${N}/`]: `https://www.${N}/`, [`https://www.${N}/`]: 200 },
    { [`https://${N}/`]: '/home', [`https://${N}/home`]: 200 },
    { [`https://${N}/`]: '/a', [`https://${N}/a`]: '/b', [`https://${N}/b`]: '/c', [`https://${N}/c`]: 200 },
  ];
  for (const pages of yes) assert.equal(await siteAnswers(N, web(pages)), true, JSON.stringify(pages));
  const no = [
    { [`https://${N}/`]: 404 },
    { [`https://${N}/`]: 503 },
    {},                                                                                     // nothing answers
    { [`https://${N}/`]: 'https://elsewhere.test/', 'https://elsewhere.test/': 200 },         // off the name
    { [`https://${N}/`]: `https://shop.${N}/`, [`https://shop.${N}/`]: 200 },               // another name of the domain is not the site
    { [`https://${N}/`]: `http://${N}/`, [`http://${N}/`]: 200 },                           // not HTTPS
    { [`https://${N}/`]: '/a', [`https://${N}/a`]: '/b', [`https://${N}/b`]: '/c', [`https://${N}/c`]: '/d', [`https://${N}/d`]: 200 },   // a fourth redirect
  ];
  for (const pages of no) assert.equal(await siteAnswers(N, web(pages)), false, JSON.stringify(pages));
  const off = web({ [`https://${N}/`]: 'https://elsewhere.test/', 'https://elsewhere.test/': 200 });
  await siteAnswers(N, off);
  assert.deepEqual(off.asked, [`https://${N}/`], 'another site is never asked');
});

// ─── Putting it away ──────────────────────────────────────────────────────────

test('domain: detaching takes the two site names off their Worker and leaves the zone, the email records and every other site alone', async () => {
  const w = world();
  const OTHER = 'riverclub.test';
  w.cf.addScript('riverclub-87654321');
  await withFetch(w.cf.handler, async () => {
    const { zoneId } = await prepareDomain(w.env, { name: N, worker: WORKER });
    const other = await prepareDomain(w.env, { name: OTHER, worker: 'riverclub-87654321' });
    assert.deepEqual(await detachDomain(w.env, { zoneId, name: N }), { detached: [N, `www.${N}`] });
    assert.ok(w.cf.zoneOf(N), 'the zone stays: it may still answer for the owner\'s email');
    assert.equal(w.cf.recordsOf(N).length, 5, 'every other record is as it was');
    assert.ok(w.cf.recordsOf(N).some(r => r.type === 'MX'));
    assert.deepEqual([...w.cf.workerDomains.values()].map(d => d.hostname), [OTHER, `www.${OTHER}`]);
    assert.deepEqual(await detachDomain(w.env, { zoneId, name: N }), { detached: [] }, 'asking again changes nothing');
    assert.equal(w.cf.workerDomains.size, 2);
    assert.equal(other.attached.length, 2);
  });
  // Even if Cloudflare answered with every name in the account, only this zone's two are detached.
  const all = world();
  all.cf.addScript('riverclub-87654321');
  await withFetch((url, init) => all.cf.handler(url.replace(/\?zone_id=[^&]*$/, ''), init), async () => {
    const { zoneId } = await prepareDomain(all.env, { name: N, worker: WORKER });
    await prepareDomain(all.env, { name: OTHER, worker: 'riverclub-87654321' });
    await detachDomain(all.env, { zoneId, name: N });
    assert.deepEqual([...all.cf.workerDomains.values()].map(d => d.hostname), [OTHER, `www.${OTHER}`]);
  });
});

test('domain: a zone is deleted only while it is still waiting', async () => {
  const w = world();
  await withFetch(w.cf.handler, async () => {
    const { zoneId } = await prepareDomain(w.env, { name: N, worker: WORKER });
    for (const status of ['active', 'moved']) {
      w.cf.setStatus(N, status);
      assert.equal((await removeWaitingDomain(w.env, { zoneId })).removed, false, status);
      assert.ok(w.cf.zoneOf(N), `a zone that is ${status} is left alone`);
      assert.equal(w.cf.workerDomains.size, 2);
      assert.equal(own(w.cf).length, 5);
    }
    assert.equal(w.cf.calls.some(c => c.method === 'DELETE' && /^\/zones\/[^/]+$/.test(c.path)), false);

    w.cf.setStatus(N, 'pending');
    assert.deepEqual(await removeWaitingDomain(w.env, { zoneId }), { removed: true, status: 'waiting' });
    assert.equal(w.cf.zones.size, 0);
    assert.equal(w.cf.workerDomains.size, 0, 'its two names are detached with it');
    assert.deepEqual(await removeWaitingDomain(w.env, { zoneId }), { removed: true, status: 'gone' }, 'a zone that is already gone needs nothing');
  });
});

test('domain: the records can be handed over as one file for an owner who takes the DNS elsewhere', async () => {
  const w = world();
  await withFetch(w.cf.handler, async () => {
    const { zoneId } = await prepareDomain(w.env, { name: N, worker: WORKER });
    const text = await exportRecords(w.env, { zoneId });
    assert.match(text, new RegExp(`^;; Domain: +${N.replace('.', '\\.')}\\.$`, 'm'));
    assert.match(text, /\tIN\tMX\t1 aspmx\.l\.google\.com$/m);
    await assert.rejects(() => exportRecords(w.env, { zoneId: 'no-such-zone' }), (e) => e instanceof DomainError);
  });
});

// ─── What a person reads ──────────────────────────────────────────────────────

test('domain: every sentence is plain, has no em dash, names the domain and says what to do next', () => {
  const codes = ['not_a_domain', 'not_registered', 'already_here', 'taken', 'refused', 'too_many', 'dnssec_on', 'at_cloudflare', 'not_hosted', 'not_set_up', 'not_changed', 'moved',
    'has_one', 'no_domain', 'busy', 'plan_ended', 'is_live', 'changed', 'not_asked', 'no_records', 'bad_action', 'cloudflare'];
  const seenBefore = new Set();
  for (const c of codes) {
    for (const about of [{ name: N, seller: 'GoDaddy' }, { name: N, seller: { name: 'GoDaddy', url: 'https://x.example' } }, { name: N }, {}, undefined]) {
      const s = domainSentence(c, about);
      assert.equal(typeof s, 'string');
      assert.doesNotMatch(s, /[—–]/, `${c}: no dash`);
      assert.doesNotMatch(s, /undefined|null|\[object/, c);
      assert.match(s, /^[A-Z].*\.$/, `${c}: a whole sentence`);
    }
    const s = domainSentence(c, { name: N, seller: 'GoDaddy' });
    assert.ok(!seenBefore.has(s), `${c} has a sentence of its own`);
    seenBefore.add(s);
  }
  for (const c of ['not_registered', 'already_here', 'taken', 'refused', 'dnssec_on', 'at_cloudflare', 'not_changed', 'moved', 'is_live', 'changed', 'not_asked', 'no_records', 'cloudflare']) assert.ok(domainSentence(c, { name: N }).includes(N), c);
  // A domain that is live is not stopped: its owner is told how to move it away, records first.
  for (const c of ['is_live', 'changed']) assert.match(domainSentence(c, { name: N, seller: 'GoDaddy' }), /download its records from this page first, and then change its name servers at GoDaddy/, c);
  assert.match(domainSentence('dnssec_on', { name: N, seller: 'GoDaddy' }), /Switch DNSSEC off at GoDaddy/);
  assert.match(domainSentence('dnssec_on', { name: N }), /Switch DNSSEC off at the company you bought the domain from/);
  assert.match(domainSentence('at_cloudflare', { name: N }), /info@kilncms\.com/);
  assert.match(domainSentence('not_changed', { name: N }), new RegExp(`${LIMITS.waitDays} days`));
  assert.equal(domainSentence('something_new', { name: N }), domainSentence('cloudflare', { name: N }));
  for (const words of Object.values(kindWords)) assert.doesNotMatch(words, /[—–]/);
});

test('domain: a kept record is email, a proof-of-ownership note, or another name', () => {
  const kind = (type, name, content = 'x') => recordKind({ type, name: name ? `${name}.${N}` : N, content }, N);
  assert.equal(kind('MX', ''), 'mail');
  assert.equal(kind('TXT', '', '"v=spf1 -all"'), 'mail');
  assert.equal(kind('TXT', '_dmarc', 'v=DMARC1; p=reject'), 'mail');
  assert.equal(kind('CNAME', 'k1._domainkey', 'dkim.mcsv.net'), 'mail');
  assert.equal(kind('CNAME', 'autodiscover', 'autodiscover.outlook.com'), 'mail');
  assert.equal(kind('A', 'mail', '203.0.113.25'), 'mail');
  assert.equal(kind('SRV', '_autodiscover._tcp', '0 0 443 autodiscover.outlook.com'), 'mail');
  assert.equal(kind('TXT', '', 'MS=ms12345678'), 'proof');
  assert.equal(kind('TXT', '', 'facebook-domain-verification=abc'), 'proof');
  assert.equal(kind('TXT', '_acme-challenge', 'abc'), 'proof');
  assert.equal(kind('CNAME', '_a1b2c3', '_x.acm-validations.aws'), 'proof');
  assert.equal(kind('CNAME', 'shop', 'shops.myshopify.com'), 'other');
  assert.equal(kind('A', 'intranet', '203.0.113.7'), 'other');
  assert.equal(kind('TXT', '', 'just a note'), 'other');
  // A domain that is itself called "mail" is not all email.
  assert.equal(recordKind({ type: 'CNAME', name: 'shop.mail.test', content: 'x' }, 'mail.test'), 'other');
  assert.equal(txtWords('"one " "two"'), 'one two');
  assert.equal(txtWords('"say \\"hi\\""'), 'say "hi"');
  assert.equal(txtWords('plain'), 'plain');
});

test('domain: the dashboard is told of a domain in the names it was built to, with the seller\'s page and the kept records, and never the zone\'s id', () => {
  const kept = [{ type: 'MX', name: N, content: '1 aspmx.l.google.com', kind: 'mail' }];
  const row = { site_id: 'site-1', name: N, zone_id: 'zone-secret-0001', state: 'waiting', reason: null, ns1: 'ada.ns.cloudflare.com', ns2: 'bob.ns.cloudflare.com',
    old_name_servers: JSON.stringify(['ns51.domaincontrol.com', 'ns52.domaincontrol.com']), seller: 'GoDaddy.com, LLC', seller_id: 146,
    records: JSON.stringify(kept), checked_at: 5000, reminded_at: null, live_at: null, created_at: 1000, updated_at: 5000 };
  const out = publicDomain(row);
  assert.deepEqual(out, {
    name: N, state: 'waiting', name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], old_name_servers: ['ns51.domaincontrol.com', 'ns52.domaincontrol.com'],
    seller: { name: 'GoDaddy', help_url: 'https://www.godaddy.com/help/change-my-domain-nameservers-664' },
    records: kept, since: 1000, checked_at: 5000, live_at: null, gives_up_at: 1000 + 25 * 24 * 60 * 60 * 1000,
  });
  // The list of sites carries it without the records, to keep it small.
  const small = publicDomain(row, { records: false });
  assert.equal('records' in small, false);
  assert.deepEqual({ ...small, records: kept }, out);
  for (const state of ['waiting', 'live', 'put_away', 'failed']) assert.doesNotMatch(JSON.stringify(publicDomain({ ...row, state, reason: 'cloudflare' })), /zone/i, state);
  const live = publicDomain({ ...row, state: 'live', live_at: 9000, reason: null });
  assert.deepEqual({ live_at: live.live_at, gives_up_at: live.gives_up_at, error: live.error }, { live_at: 9000, gives_up_at: null, error: undefined });
  const away = publicDomain({ ...row, state: 'put_away', reason: 'not_changed' });
  assert.equal(away.error, domainSentence('not_changed', { name: N }));
  assert.equal(away.gives_up_at, null, 'only a set-up that waits has a day it is put away');
  assert.deepEqual(publicDomain({ ...row, records: 'not json' }).records, []);
  assert.deepEqual(publicDomain({ ...row, old_name_servers: null }).old_name_servers, []);
  assert.equal(publicDomain({ ...row, seller: null, seller_id: null }).seller, null, 'a seller nobody could name is not made up');
  assert.deepEqual(publicDomain({ ...row, seller: 'Some Small Registrar Ltd', seller_id: 99999 }).seller, { name: 'Some Small Registrar Ltd', help_url: 'https://developers.cloudflare.com/dns/nameservers/update-nameservers/' });
  assert.equal(publicDomain(null), null);
});

test('domain: the dashboard is told of a look in the names it was built to, with what stands in the way as a sentence', async () => {
  const out = publicLook(await look());
  assert.deepEqual(Object.keys(out), ['name', 'seller', 'name_servers', 'mail', 'found', 'stop']);
  assert.deepEqual({ ...out, found: null }, {
    name: N, seller: { name: 'GoDaddy', help_url: 'https://www.godaddy.com/help/change-my-domain-nameservers-664' },
    name_servers: ['ns51.domaincontrol.com', 'ns52.domaincontrol.com'], mail: true, found: null, stop: null,
  });
  assert.equal(out.found.length, 6);
  assert.ok(out.found.every(r => Object.keys(r).join() === 'type,name,content,kind'), 'each in the shape of a kept record');
  assert.deepEqual(out.found.find(r => r.type === 'MX'), { type: 'MX', name: N, content: '1 aspmx.l.google.com', kind: 'mail' });
  const stopped = publicLook(await look(known({ dnssec: true })), 'dnssec_on');
  assert.deepEqual(stopped.stop, { code: 'dnssec_on', sentence: domainSentence('dnssec_on', { name: N, seller: 'GoDaddy' }) });
  // Nothing could be read: every part is empty, and nothing is made up.
  assert.deepEqual(publicLook({ name: N }), { name: N, seller: null, name_servers: [], mail: false, found: [], stop: null });
  assert.deepEqual(publicLook({ name: 'not a domain' }, 'not_a_domain').stop, { code: 'not_a_domain', sentence: domainSentence('not_a_domain') });
});

// ─── What the service remembers ───────────────────────────────────────────────

test('domain: a site has one domain and a domain has one site, and a set-up that was put away holds nothing', { skip: d1Skip }, async () => {
  const env = { kiln_cloud: fakeD1() };
  assert.equal(await domainRow(env, 'site-1'), null);
  assert.equal(await domainForName(env, N), null);
  const kept = [{ type: 'MX', name: N, content: 'aspmx.l.google.com', kind: 'mail', priority: 1 }];
  assert.equal(await saveDomain(env, 'site-1', { name: 'OakBakery.test', zone_id: 'z1', ns1: 'ada.ns.cloudflare.com', ns2: 'bob.ns.cloudflare.com', seller: 'GoDaddy.com, LLC', seller_id: 146, records: kept }), true);
  let row = await domainRow(env, 'site-1');
  assert.deepEqual({ name: row.name, zone_id: row.zone_id, state: row.state, seller_id: row.seller_id, records: JSON.parse(row.records) }, { name: N, zone_id: 'z1', state: 'waiting', seller_id: 146, records: kept });
  assert.ok(row.created_at > 0 && row.updated_at >= row.created_at);
  assert.equal((await domainForName(env, 'OAKBAKERY.test')).site_id, 'site-1');
  assert.deepEqual(publicDomain(row).records, kept);

  await assert.rejects(() => saveDomain(env, 'site-2', { name: N, zone_id: 'z2' }), code('taken'), 'another site cannot take a domain that is waiting');
  assert.equal(await domainRow(env, 'site-2'), null);

  const made = row.created_at;
  assert.equal(await saveDomain(env, 'site-1', { state: 'live', live_at: 7000, checked_at: 7000 }), true);
  row = await domainRow(env, 'site-1');
  assert.deepEqual({ state: row.state, live_at: row.live_at, created_at: row.created_at, name: row.name }, { state: 'live', live_at: 7000, created_at: made, name: N });
  await assert.rejects(() => saveDomain(env, 'site-2', { name: N }), code('taken'), 'nor one that is live');

  await saveDomain(env, 'site-1', { state: 'put_away', reason: 'not_changed' });
  assert.equal(await domainForName(env, N), null, 'a set-up that was put away does not hold the name');
  assert.equal(await saveDomain(env, 'site-2', { name: N, zone_id: 'z2' }), true);
  assert.equal(await domainRow(env, 'site-1'), null, 'the old row is cleared out of the way');
  assert.equal((await domainForName(env, N)).site_id, 'site-2');
});

test('domain: a set-up that starts again starts its clock again', { skip: d1Skip }, async () => {
  const env = { kiln_cloud: fakeD1() };
  await saveDomain(env, 'site-3', { name: N, zone_id: 'z1', created_at: 1000, reminded_at: 2000, checked_at: 2500 });
  await saveDomain(env, 'site-3', { state: 'put_away', reason: 'not_changed' });
  let row = await domainRow(env, 'site-3');
  assert.deepEqual({ created_at: row.created_at, reminded_at: row.reminded_at, reason: row.reason }, { created_at: 1000, reminded_at: 2000, reason: 'not_changed' });
  await saveDomain(env, 'site-3', { state: 'waiting', zone_id: 'z9' });
  row = await domainRow(env, 'site-3');
  assert.ok(row.created_at > 1000, 'the 25 days count from the new start');
  assert.deepEqual({ zone_id: row.zone_id, state: row.state, reason: row.reason, reminded_at: row.reminded_at, checked_at: row.checked_at, live_at: row.live_at }, { zone_id: 'z9', state: 'waiting', reason: null, reminded_at: null, checked_at: null, live_at: null });
  // A note written while it waits does not start the clock again.
  const started = row.created_at;
  await saveDomain(env, 'site-3', { state: 'waiting', reminded_at: 4000 });
  row = await domainRow(env, 'site-3');
  assert.deepEqual({ created_at: row.created_at, reminded_at: row.reminded_at }, { created_at: started, reminded_at: 4000 });
});

test('domain: a database the migration has not reached fails no page', { skip: d1Skip }, async () => {
  const env = { kiln_cloud: fakeD1({ upTo: 5 }) };
  assert.equal(await domainsReady(env), false);
  assert.equal(await domainRow(env, 'site-1'), null);
  assert.equal(await domainForName(env, N), null);
  assert.equal(await saveDomain(env, 'site-1', { name: N, zone_id: 'z1' }), false);
  assert.deepEqual(await domainsForAccount(env, 'acct-1'), {});
  assert.equal(await forgetDomain(env, 'site-1'), false);
});

test('domain: the name servers that were replaced are remembered, and a site\'s domain can be forgotten', { skip: d1Skip }, async () => {
  const env = { kiln_cloud: fakeD1() };
  assert.equal(await domainsReady(env), true);
  await saveDomain(env, 'site-1', { name: N, zone_id: 'z1', old_name_servers: ['ns51.domaincontrol.com', 'ns52.domaincontrol.com'] });
  assert.deepEqual(publicDomain(await domainRow(env, 'site-1')).old_name_servers, ['ns51.domaincontrol.com', 'ns52.domaincontrol.com']);
  assert.equal(await forgetDomain(env, 'site-1'), true);
  assert.equal(await domainRow(env, 'site-1'), null);
  assert.equal(await domainForName(env, N), null, 'the name is free again');
});

test('domain: the registry and the public DNS are told who asks, because the registry answers 403 to a question that does not say', async () => {
  const dns = fakeLookups(known());
  const out = await lookUp(N, { fetchImpl: dns.fetchImpl });
  assert.match(JSON.stringify(out.seller), /GoDaddy/, 'the seller is found');
  assert.ok(dns.agents.length >= 2, 'the registry and the public DNS were both asked');
  assert.deepEqual([...new Set(dns.agents)], ['kiln-cms (+https://kilncms.com)']);
  // Asked the way a Worker asks by itself, naming no user agent, the registry refuses, and nobody can say who sold the domain.
  const refused = await dns.fetchImpl(`https://rdap.org/domain/${N}`, { headers: { accept: 'application/rdap+json' } });
  assert.equal(refused.status, 403);
  const unnamed = (url, init = {}) => { const headers = { ...(init.headers || {}) }; delete headers['user-agent']; return dns.fetchImpl(url, { ...init, headers }); };
  assert.equal((await lookUp(N, { fetchImpl: unnamed })).seller, null);
});
