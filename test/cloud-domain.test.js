/**
 * A hosted site on its owner's own domain, as the dashboard asks for it: the
 * look that changes nothing, the set-up and its lock, "check now", stopping,
 * the records to download, the email with the two name servers, and what
 * /cloud/me says (the routes in worker/cloud.js over worker/domain.js, and
 * the mail in worker/mail.js). The real handlers run over the SQLite-backed
 * D1 stand-in, an in-memory Cloudflare, and a stand-in for the registry and
 * the public DNS. The domains are made up (the ".test" ending is kept for
 * this). Nothing here touches the network.
 *
 * The step that makes a domain live is not built yet (cloud.js
 * domainTookHold): where a test says so, it is to change with that step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fakeKV, withFetch, call } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';
import { fakeGitHub } from './github-fake.js';
import { fakeCloudflare, fakeLookups } from './cloudflare-fake.js';
import { domainSentence, domainRow, saveDomain, removeWaitingDomain, domainsReady, LIMITS } from '../worker/domain.js';
import { domainTookHold, sweepDomains, siteHasAccess, cloudSiteForOrigin, hostingEndedNote, liveDomainLeftNote } from '../worker/cloud.js';
import { sweepHosting } from '../worker/hosted.js';
import { publicDomain } from '../worker/domain.js';
import { domainNameServersMail, domainLiveMail, domainReminderMail, domainPutAwayMail, domainMovedMail, dayWords } from '../worker/mail.js';

const N = 'oakbakery.test';
const WORKER = 'club-site1';
const GODADDY = 'https://www.godaddy.com/help/change-my-domain-nameservers-664';
const GENERAL = 'https://developers.cloudflare.com/dns/nameservers/update-nameservers/';

// What Cloudflare's copy finds: the website, the email, and a shop at another company.
const scanned = [
  { type: 'A', name: N, content: '203.0.113.10' },
  { type: 'CNAME', name: `www.${N}`, content: N },
  { type: 'MX', name: N, content: 'aspmx.l.google.com', priority: 1 },
  { type: 'TXT', name: N, content: '"v=spf1 include:_spf.google.com ~all"' },
  { type: 'CNAME', name: `shop.${N}`, content: 'shops.myshopify.com' },
];
// What the world knows of the domain. The copy above misses the last one.
const known = (over = {}) => ({ [N]: {
  seller: { name: 'GoDaddy.com, LLC', id: 146 }, nameServers: ['ns51.domaincontrol.com', 'ns52.domaincontrol.com'], dnssec: false,
  dns: [
    { name: N, type: 'MX', data: '1 aspmx.l.google.com.' },
    { name: N, type: 'TXT', data: '"v=spf1 include:_spf.google.com ~all"' },
    { name: `_dmarc.${N}`, type: 'TXT', data: '"v=DMARC1; p=none"' },
  ],
  ...over,
} });

/** One account with one site on the hosting plan, up on Kiln's hosting unless `hosted` is false. */
function world({ domains = known(), down = {}, env: extra = {}, hosted = true } = {}) {
  const gh = fakeGitHub({ repo: 'ada/club', files: { 'index.html': '<!doctype html><h1>Home</h1>' } });
  const cf = fakeCloudflare();
  const dns = fakeLookups(domains, down);
  cf.scanFinds(N, scanned);
  const sent = [];
  const env = cloudEnv(fakeKV({ 'itok:ada/club': 'inst-token' }), {
    HOSTING_ACCOUNT_ID: cf.account, HOSTING_API_TOKEN: cf.token, HOSTING_SUBDOMAIN: 'kiln-sites',
    NOTIFY: { send: async (m) => { sent.push(m); return { messageId: '<1@kilncms.com>' }; } }, CUSTOMER_MAIL_FROM: 'hello@kilncms.com', CLOUD_DASHBOARD: 'https://app.example',
    ...extra,
  });
  addSite(env, { id: 'site1', plan: 'managed', status: 'trialing' });
  if (hosted) {
    cf.addScript(WORKER);
    env.kiln_cloud.exec('INSERT INTO hosting (site_id, name, url, state, deployed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', 'site1', WORKER, `https://${WORKER}.kiln-sites.workers.dev`, 'live', 1, 1, 1);
  }
  const up = new Set();   // the names the site answers at: `answers(...names)` says which, and nothing else answers
  const handler = async (url, init) => (up.has(new URL(url).host) ? new Response('<!doctype html><h1>Home</h1>', { status: 200 })
    : (await cf.handler(url, init)) || (await dns.handler(url, init)) || gh.handler(url, init));
  return { cf, dns, env, handler, sent, answers: (...names) => { up.clear(); for (const n of names) up.add(n); }, mails: () => sent.filter(m => m.subject), notes: () => sent.filter(m => m.raw) };
}
const ask = (env, method, pathname, body, token = 'tok') => worker.fetch(new Request(`https://worker.example${pathname}`, {
  method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}), env);
const standing = (env) => ask(env, 'GET', '/cloud/sites/domain?site=site1');
const lookAt = (env, name = N) => ask(env, 'GET', `/cloud/sites/domain?site=site1&name=${encodeURIComponent(name)}`);
const setup = (env, name = N) => ask(env, 'POST', '/cloud/sites/domain', { id: 'site1', action: 'setup', name });
const check = (env) => ask(env, 'POST', '/cloud/sites/domain', { id: 'site1', action: 'check' });
const stop = (env) => ask(env, 'POST', '/cloud/sites/domain', { id: 'site1', action: 'stop' });
const records = (env) => ask(env, 'GET', '/cloud/sites/domain/records?site=site1');
const editingOff = (env) => env.kiln_cloud.exec("UPDATE sites SET status = 'expired' WHERE id = 'site1'");
const aMinuteAgo = (env) => env.kiln_cloud.exec("UPDATE domains SET checked_at = ? WHERE site_id = 'site1'", Date.now() - 61 * 1000);
const toCloudflare = (calls) => calls.filter(c => c.url.startsWith('https://api.cloudflare.com/'));
const quiet = async (fn) => { const real = console.warn; const lines = []; console.warn = (l) => lines.push(String(l)); try { await fn(); } finally { console.warn = real; } return lines; };
const hush = async (fn) => { const log = console.log, warn = console.warn; const lines = []; console.log = console.warn = (l) => lines.push(String(l)); try { await fn(); } finally { console.log = log; console.warn = warn; } return lines; };
const plain = (s) => { assert.doesNotMatch(s, /[—–]/); assert.doesNotMatch(s, /undefined|null|\[object/); assert.match(s, /^[A-Z].*\.$/); };

// ─── Looking, and changing nothing ────────────────────────────────────────────

test('own domain: a look says who sold the domain, whether it has email and what Kiln can see, and changes nothing', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async (calls) => {
    assert.deepEqual(await (await standing(w.env)).json(), { ok: true, domain: null }, 'a site with no domain says so');
    const res = await lookAt(w.env, 'https://www.OakBakery.test/about');
    assert.equal(res.status, 200);
    const { ok, look } = await res.json();
    assert.equal(ok, true);
    assert.deepEqual({ ...look, found: null }, {
      name: N, seller: { name: 'GoDaddy', help_url: GODADDY }, name_servers: ['ns51.domaincontrol.com', 'ns52.domaincontrol.com'], mail: true, found: null, stop: null,
    });
    assert.deepEqual(look.found, [
      { type: 'TXT', name: `_dmarc.${N}`, content: 'v=DMARC1; p=none', kind: 'mail' },
      { type: 'MX', name: N, content: '1 aspmx.l.google.com', kind: 'mail' },
      { type: 'TXT', name: N, content: 'v=spf1 include:_spf.google.com ~all', kind: 'mail' },
    ]);
    assert.equal(toCloudflare(calls).length, 0, 'Cloudflare is not asked for anything');
    assert.ok(calls.length > 0 && calls.every(c => c.method === 'GET'), 'the registry and the public DNS are only read');
  });
  assert.equal(w.cf.zones.size, 0);
  assert.equal(await domainRow(w.env, 'site1'), null);
  assert.equal(w.sent.length, 0);
});

test('own domain: a look says in a sentence what stands in the way, and asks nobody about a domain that cannot be set up anyway', { skip: d1Skip }, async () => {
  const stopOf = async (w, typed = N) => { const res = await lookAt(w.env, typed); assert.equal(res.status, 200, typed); return (await res.json()).look; };

  // Not a domain at all.
  let w = world();
  await withFetch(w.handler, async (calls) => {
    for (const typed of ['bakery', 'ada@oakbakery.test', 'https://club.kilncms.com', '203.0.113.9', 'oakbakery.test:8080', '']) {
      const look = await stopOf(w, typed);
      assert.deepEqual(look, { name: typed, seller: null, name_servers: [], mail: false, found: [], stop: { code: 'not_a_domain', sentence: domainSentence('not_a_domain') } }, typed);
    }
    assert.equal(calls.length, 0);
  });

  // The site is not up on Kiln's hosting: never was, or came down.
  w = world({ hosted: false });
  await withFetch(w.handler, async (calls) => {
    assert.deepEqual((await stopOf(w)).stop, { code: 'not_hosted', sentence: domainSentence('not_hosted') });
    assert.equal(calls.length, 0);
  });
  w = world();
  w.env.kiln_cloud.exec("UPDATE hosting SET state = 'ended' WHERE site_id = 'site1'");
  await withFetch(w.handler, async () => { assert.equal((await stopOf(w)).stop.code, 'not_hosted'); });

  // Another site of Kiln's has the domain, and this site has a domain already.
  w = world();
  await saveDomain(w.env, 'site-other', { name: N, zone_id: 'z9' });
  await withFetch(w.handler, async (calls) => {
    assert.deepEqual((await stopOf(w)).stop, { code: 'taken', sentence: domainSentence('taken', { name: N }) });
    assert.equal(calls.length, 0);
  });
  w = world();
  await saveDomain(w.env, 'site1', { name: 'elmcafe.test', zone_id: 'z9' });
  await withFetch(w.handler, async (calls) => {
    assert.deepEqual((await stopOf(w)).stop, { code: 'has_one', sentence: domainSentence('has_one') });
    assert.equal(calls.length, 0);
  });

  // What only the registry and the public DNS can say.
  w = world({ domains: known({ dnssec: true }) });
  await withFetch(w.handler, async () => {
    const look = await stopOf(w);
    assert.deepEqual(look.stop, { code: 'dnssec_on', sentence: domainSentence('dnssec_on', { name: N, seller: 'GoDaddy' }) });
    assert.match(look.stop.sentence, /Switch DNSSEC off at GoDaddy/);
    assert.equal(look.mail, true, 'the rest of what was seen is still told');
  });
  w = world({ domains: known({ seller: { name: 'Cloudflare, Inc.', id: 1910 } }) });
  await withFetch(w.handler, async () => {
    const { stop: s } = await stopOf(w);
    assert.equal(s.code, 'at_cloudflare');
    assert.match(s.sentence, /info@kilncms\.com/);
  });
  w = world({ domains: {} });
  await withFetch(w.handler, async () => { assert.deepEqual((await stopOf(w)).stop, { code: 'not_registered', sentence: domainSentence('not_registered', { name: N }) }); });

  // Nothing could be looked up: every part is empty, and that alone stops nothing.
  w = world({ down: { rdap: true, dns: true } });
  await withFetch(w.handler, async () => {
    assert.deepEqual(await stopOf(w), { name: N, seller: null, name_servers: [], mail: false, found: [], stop: null });
  });

  // A service that hosts no sites, and a database the migration has not reached.
  for (const extra of [{ HOSTING_API_TOKEN: '' }, { d1: { upTo: 5 } }]) {
    w = world({ env: extra });
    await withFetch(w.handler, async (calls) => {
      assert.deepEqual((await stopOf(w)).stop, { code: 'not_set_up', sentence: domainSentence('not_set_up') });
      assert.equal(calls.length, 0);
    });
  }
  for (const c of ['not_a_domain', 'not_hosted', 'taken', 'has_one', 'dnssec_on', 'at_cloudflare', 'not_registered', 'not_set_up']) plain(domainSentence(c, { name: N, seller: 'GoDaddy' }));
});

test('own domain: only the site\'s owner may ask, and a site whose editing is switched off cannot look or set up', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async (calls) => {
    for (const [method, pathname, body] of [
      ['GET', '/cloud/sites/domain?site=site1'], ['GET', `/cloud/sites/domain?site=site1&name=${N}`], ['GET', '/cloud/sites/domain/records?site=site1'],
      ['POST', '/cloud/sites/domain', { id: 'site1', action: 'setup', name: N }], ['POST', '/cloud/sites/domain', { id: 'site1', action: 'stop' }],
    ]) {
      assert.equal((await ask(w.env, method, pathname, body, 'nobody')).status, 401, `${method} ${pathname}`);
      const other = await ask(w.env, method, pathname.replace('site1', 'nope'), body && { ...body, id: 'nope' });
      assert.equal(other.status, 404, `${method} ${pathname}`);
      assert.equal((await other.json()).code, 'no_such_site');
    }
    assert.equal(siteHasAccess({ status: 'expired' }), false);
    editingOff(w.env);
    for (const res of [await lookAt(w.env), await setup(w.env)]) {
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: domainSentence('plan_ended'), code: 'plan_ended' });
    }
    assert.deepEqual(await (await standing(w.env)).json(), { ok: true, domain: null }, 'where the domain stands can still be read');
    const odd = await ask(w.env, 'POST', '/cloud/sites/domain', { id: 'site1', action: 'explode' });
    assert.deepEqual([odd.status, await odd.json()], [400, { error: domainSentence('bad_action'), code: 'bad_action' }]);
    assert.equal(calls.length, 0, 'nobody outside was asked for anything');
  });
  plain(domainSentence('plan_ended'));
  plain(domainSentence('bad_action'));
});

// ─── Setting it up ────────────────────────────────────────────────────────────

test('own domain: the set-up makes everything ready, remembers it as waiting, and writes to the owner with the two name servers', { skip: d1Skip }, async () => {
  const w = world({ env: { NOTIFY_TO: 'ops@example.com' } });
  let domain, zone;
  await withFetch(w.handler, async () => {
    const res = await setup(w.env, 'https://www.OakBakery.test/');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ['ok', 'domain']);
    domain = body.domain;
    zone = w.cf.zoneOf(N);
    assert.equal(zone.status, 'pending', 'the zone waits for the name servers');
    assert.deepEqual(Object.keys(domain), ['name', 'state', 'name_servers', 'old_name_servers', 'seller', 'records', 'since', 'checked_at', 'live_at', 'gives_up_at']);
    assert.deepEqual({ ...domain, records: null, since: null, gives_up_at: null }, {
      name: N, state: 'waiting', name_servers: zone.name_servers, old_name_servers: ['ns1.old-host.example', 'ns2.old-host.example'],
      seller: { name: 'GoDaddy', help_url: GODADDY }, records: null, since: null, checked_at: null, live_at: null, gives_up_at: null,
    });
    assert.ok(Math.abs(Date.now() - domain.since) < 5000);
    assert.equal(domain.gives_up_at, domain.since + LIMITS.waitDays * 24 * 60 * 60 * 1000);
    assert.deepEqual(domain.records.map(r => `${r.kind} ${r.type} ${r.name} ${r.content}`), [
      `mail TXT _dmarc.${N} v=DMARC1; p=none`, `mail MX ${N} 1 aspmx.l.google.com`, `mail TXT ${N} v=spf1 include:_spf.google.com ~all`, `other CNAME shop.${N} shops.myshopify.com`,
    ], 'the record the copy missed is among them');
    assert.doesNotMatch(JSON.stringify(body), new RegExp(zone.id), 'the zone\'s id is never told');

    // At Cloudflare: both names are on the site's own Worker, and nothing that was copied goes through Cloudflare.
    assert.deepEqual([...w.cf.workerDomains.values()].map(d => [d.hostname, d.service]), [[N, WORKER], [`www.${N}`, WORKER]]);
    assert.deepEqual(w.cf.recordsOf(N).filter(r => !r.meta && r.proxied), []);

    // What the service remembers, and what it says when asked again.
    const row = await domainRow(w.env, 'site1');
    assert.deepEqual({ name: row.name, zone_id: row.zone_id, state: row.state, ns1: row.ns1, ns2: row.ns2, seller: row.seller, seller_id: row.seller_id },
      { name: N, zone_id: zone.id, state: 'waiting', ns1: zone.name_servers[0], ns2: zone.name_servers[1], seller: 'GoDaddy.com, LLC', seller_id: 146 });
    assert.deepEqual(await (await standing(w.env)).json(), { ok: true, domain });
    assert.equal(await w.env.KILN.get('domainlock:site1'), null, 'the lock is let go');

    // The list of sites carries it without the records.
    const me = await (await ask(w.env, 'GET', '/cloud/me')).json();
    assert.equal(me.domains, true);
    const { records: _left, ...small } = domain;
    assert.deepEqual(me.sites[0].domain, small);

    // Pressed again: the site has a domain, and nothing more is made.
    const again = await setup(w.env);
    assert.deepEqual([again.status, await again.json()], [409, { error: domainSentence('has_one'), code: 'has_one' }]);
    assert.equal(w.cf.zones.size, 1);
  });

  // The owner is written to once, and so is whoever runs the service.
  assert.equal(w.mails().length, 1);
  const mail = w.mails()[0];
  assert.equal(mail.to, 'ada@example.com');
  assert.equal(mail.subject, `Two name servers to enter for ${N}`);
  assert.equal(mail.text, domainNameServersMail({
    origin: 'https://club.example', name: N, nameServers: zone.name_servers, seller: { name: 'GoDaddy' }, helpUrl: GODADDY, records: domain.records, givesUpAt: domain.gives_up_at, dashboard: 'https://app.example',
  }).text);
  for (const ns of zone.name_servers) assert.ok(mail.text.includes(`\n\n${ns}\n\n`), ns);
  assert.match(mail.text, /Kiln copied 3 email records and 1 other record of oakbakery\.test/);
  assert.equal(w.notes().length, 1);
  assert.match(w.notes()[0].raw, /Subject: Kiln is setting up oakbakery\.test for ada\/club/);
  assert.doesNotMatch(w.notes()[0].raw, /[—–]/);
});

test('own domain: a site named the way the design names it is found, and an account with no address is not written to', { skip: d1Skip }, async () => {
  const w = world();
  w.env.kiln_cloud.exec("UPDATE accounts SET email = NULL WHERE id = 'acct-1'");
  await withFetch(w.handler, async () => {
    const res = await ask(w.env, 'POST', '/cloud/sites/domain', { site: 'site1', action: 'setup', name: N });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).domain.state, 'waiting');
  });
  assert.equal(w.sent.length, 0);
  // A service that does not write to customers stays silent too.
  const silent = world({ env: { CUSTOMER_MAIL_FROM: '' } });
  await withFetch(silent.handler, async () => { assert.equal((await setup(silent.env)).status, 200); });
  assert.equal(silent.sent.length, 0);
});

test('own domain: the set-up looks again for itself and refuses with the look\'s sentences, and a set-up that fails leaves nothing behind', { skip: d1Skip }, async () => {
  const nothingMade = async (w) => {
    assert.equal(w.cf.zones.size, 0);
    assert.equal(w.cf.workerDomains.size, 0);
    assert.equal(await domainRow(w.env, 'site1'), null);
    assert.equal(w.sent.length, 0);
    assert.equal(await w.env.KILN.get('domainlock:site1'), null);
  };
  // The dashboard is never trusted: what the look would have stopped, the set-up stops.
  const cases = [
    [world({ domains: known({ dnssec: true }) }), N, 409, 'dnssec_on', { name: N, seller: 'GoDaddy' }],
    [world({ domains: known({ seller: { name: 'Cloudflare, Inc.', id: 1910 } }) }), N, 409, 'at_cloudflare', { name: N }],
    [world({ domains: {} }), N, 409, 'not_registered', { name: N }],
    [world({ hosted: false }), N, 409, 'not_hosted', {}],
    [world(), 'bakery', 400, 'not_a_domain', {}],
    [world(), null, 400, 'not_a_domain', {}],   // no name at all
    [world({ env: { d1: { upTo: 5 } } }), N, 503, 'not_set_up', {}],
  ];
  for (const [w, typed, status, code, about] of cases) {
    await withFetch(w.handler, async (calls) => {
      const res = await setup(w.env, typed);
      assert.deepEqual([res.status, await res.json()], [status, { error: domainSentence(code, about), code }], code);
      assert.equal(toCloudflare(calls).length, 0, `${code}: Cloudflare was not asked for anything`);
    });
    await nothingMade(w);
  }

  // Cloudflare will not take the domain.
  let w = world();
  w.cf.refuseZone(N, 1097, 'This zone is banned and cannot be added to Cloudflare at this time, please contact Cloudflare Support.');
  let lines = await quiet(() => withFetch(w.handler, async () => {
    const res = await setup(w.env);
    assert.deepEqual([res.status, await res.json()], [409, { error: domainSentence('refused', { name: N, seller: 'GoDaddy' }), code: 'refused' }]);
  }));
  await nothingMade(w);
  assert.deepEqual((({ evt, repo, name, stage, reason }) => ({ evt, repo, name, stage, reason }))(JSON.parse(lines[0])), { evt: 'domain_setup_failed', repo: 'ada/club', name: N, stage: 'prepare', reason: 'refused' });

  // A step fails after the zone was made (the second name cannot be attached): the zone is taken away again.
  w = world();
  let puts = 0;
  w.cf.failOn((method, path) => method === 'PUT' && path === '/workers/domains' && ++puts === 2);
  await quiet(() => withFetch(w.handler, async () => {
    const res = await setup(w.env);
    assert.deepEqual([res.status, await res.json()], [502, { error: domainSentence('cloudflare', { name: N }), code: 'cloudflare' }]);
  }));
  await nothingMade(w);
  // And the owner can simply press again.
  w.cf.failOn(null);
  await withFetch(w.handler, async () => { assert.equal((await setup(w.env)).status, 200); });
  assert.equal(w.cf.zones.size, 1);

  // Another site takes the name between the look and the moment it is written down: the zone that was just made goes again.
  w = world();
  let taken = false;
  w.cf.failOn((method, path) => {
    if (method === 'PUT' && path === '/workers/domains' && !taken) {
      taken = true;
      w.env.kiln_cloud.exec("INSERT INTO domains (site_id, name, zone_id, state, created_at, updated_at) VALUES ('site-other', ?, 'z-other', 'waiting', 1, 1)", N);
    }
    return false;
  });
  lines = await quiet(() => withFetch(w.handler, async () => {
    const res = await setup(w.env);
    assert.deepEqual([res.status, await res.json()], [409, { error: domainSentence('taken', { name: N, seller: 'GoDaddy' }), code: 'taken' }]);
  }));
  await nothingMade(w);
  assert.equal(JSON.parse(lines[0]).stage, 'record');
});

test('own domain: two presses at once make one zone', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async (calls) => {
    // While one set-up runs, another is told to wait, and nobody is asked for anything.
    await w.env.KILN.put('domainlock:site1', '1');
    const busy = await setup(w.env);
    assert.deepEqual([busy.status, await busy.json()], [409, { error: domainSentence('busy'), code: 'busy' }]);
    assert.equal(calls.length, 0);
    assert.equal(await w.env.KILN.get('domainlock:site1'), '1', 'the lock of the set-up that runs is left alone');
    await w.env.KILN.delete('domainlock:site1');

    // Two at the very same moment: one goes through, and the other is refused without making or removing anything.
    const both = await quiet(async () => {
      const answers = await Promise.all([setup(w.env), setup(w.env)]);
      assert.deepEqual(answers.map(r => r.status).sort(), [200, 409]);
    });
    assert.ok(both.length <= 1);
    assert.equal(w.cf.zones.size, 1);
    assert.equal(w.cf.workerDomains.size, 2);
    assert.equal((await domainRow(w.env, 'site1')).zone_id, w.cf.zoneOf(N).id);
    assert.equal(w.mails().length, 1, 'and the owner is written to once');
    assert.equal(await w.env.KILN.get('domainlock:site1'), null);
  });
  // The lock runs out by itself, in case a set-up never came back.
  const held = world();
  await withFetch(held.handler, async () => {
    let ttl = null;
    const put = held.env.KILN.put.bind(held.env.KILN);
    held.env.KILN.put = async (key, value, opts) => { if (key === 'domainlock:site1') ttl = opts?.expirationTtl; return put(key, value, opts); };
    assert.equal((await setup(held.env)).status, 200);
    assert.equal(ttl, 120);
  });
  plain(domainSentence('busy'));
});

// ─── Check now ────────────────────────────────────────────────────────────────

test('own domain: "check now" asks Cloudflare to look again, once a minute at most, and says when the name servers have changed', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    const none = await check(w.env);
    assert.deepEqual([none.status, await none.json()], [404, { error: domainSentence('no_domain'), code: 'no_domain' }]);

    await setup(w.env);
    const zone = w.cf.zoneOf(N);
    let res = await check(w.env);
    const first = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(first), ['ok', 'domain']);
    assert.equal(first.domain.state, 'waiting');
    assert.ok(first.domain.checked_at > 0);
    assert.equal(zone.checks, 1, 'Cloudflare was asked to look at the name servers again');

    // Pressed again within the minute: what is known is the answer, and Cloudflare is left alone.
    w.cf.calls.length = 0;
    res = await check(w.env);
    assert.deepEqual(await res.json(), first);
    assert.equal(w.cf.calls.length, 0);

    // A minute later, and the owner has changed the name servers.
    aMinuteAgo(w.env);
    w.cf.setStatus(N, 'active');
    res = await check(w.env);
    const after = await res.json();
    assert.equal(zone.checks, 2);
    assert.equal(after.changed, true, 'Cloudflare has seen the new name servers');
    // The site does not answer at the domain yet (its certificate takes a few minutes), so the domain still waits.
    assert.equal(after.domain.state, 'waiting');
    // A minute later it answers there, and the answer says `live`.
    aMinuteAgo(w.env);
    w.answers(N);
    let live;
    await hush(async () => { live = await (await check(w.env)).json(); });
    assert.deepEqual({ state: live.domain.state, changed: live.changed, at: live.domain.live_at > 0 }, { state: 'live', changed: undefined, at: true });
    // What follows is about a domain that waits.
    w.answers();
    await saveDomain(w.env, 'site1', { state: 'waiting' });

    // Cloudflare cannot be asked: nothing changes, and the answer says to try again.
    aMinuteAgo(w.env);
    const before = (await domainRow(w.env, 'site1')).checked_at;
    w.cf.failOn((method, path) => method === 'GET' && /^\/zones\/[^/]+$/.test(path));
    await quiet(async () => {
      res = await check(w.env);
      const body = await res.json();
      assert.equal(res.status, 502);
      assert.deepEqual({ error: body.error, code: body.code, state: body.domain.state }, { error: domainSentence('not_asked', { name: N }), code: 'not_asked', state: 'waiting' });
    });
    assert.equal((await domainRow(w.env, 'site1')).checked_at, before);
    w.cf.failOn(null);

    // A domain that does not wait has nothing to ask about.
    await saveDomain(w.env, 'site1', { state: 'put_away', reason: 'not_changed' });
    w.cf.calls.length = 0;
    res = await check(w.env);
    const away = await res.json();
    assert.deepEqual({ state: away.domain.state, error: away.domain.error }, { state: 'put_away', error: domainSentence('not_changed', { name: N }) });
    assert.equal(w.cf.calls.length, 0);
  });
  for (const c of ['no_domain', 'not_asked']) plain(domainSentence(c, { name: N }));
});

// ─── Stopping, and taking the records away ────────────────────────────────────

test('own domain: a set-up that is not live can be stopped, and one that is live says how to move away instead', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    assert.deepEqual(await (await stop(w.env)).json(), { ok: true, domain: null }, 'with nothing set up there is nothing to stop');
    await setup(w.env);
    let res = await stop(w.env);
    assert.deepEqual([res.status, await res.json()], [200, { ok: true, domain: null }]);
    assert.equal(w.cf.zones.size, 0, 'the waiting zone is removed');
    assert.equal(w.cf.workerDomains.size, 0, 'with the two names that were on the site\'s Worker');
    assert.equal(await domainRow(w.env, 'site1'), null);
    assert.deepEqual(await (await standing(w.env)).json(), { ok: true, domain: null });

    // They can start again at once.
    assert.equal((await setup(w.env)).status, 200);
    // The name servers were changed while it waited: the zone answers for the domain now, and stays.
    w.cf.setStatus(N, 'active');
    res = await stop(w.env);
    let body = await res.json();
    assert.equal(res.status, 409);
    assert.deepEqual({ error: body.error, code: body.code, state: body.domain.state }, { error: domainSentence('changed', { name: N, seller: 'GoDaddy' }), code: 'changed', state: 'waiting' });
    assert.equal(w.cf.zones.size, 1);
    assert.equal(w.cf.workerDomains.size, 2);

    // Live: refused, with how to move away (the records first, then the name servers at the seller).
    await saveDomain(w.env, 'site1', { state: 'live', live_at: Date.now() });
    w.cf.calls.length = 0;
    res = await stop(w.env);
    body = await res.json();
    assert.equal(res.status, 409);
    assert.deepEqual({ error: body.error, code: body.code, state: body.domain.state }, { error: domainSentence('is_live', { name: N, seller: 'GoDaddy' }), code: 'is_live', state: 'live' });
    assert.match(body.error, /download its records from this page first, and then change its name servers at GoDaddy/);
    assert.equal(w.cf.calls.length, 0, 'nothing of a live domain is touched');
    assert.equal((await domainRow(w.env, 'site1')).state, 'live');

    // Put away while its zone still answers for the domain's email: the set-up is forgotten, and the zone stays.
    await saveDomain(w.env, 'site1', { state: 'put_away', reason: 'moved' });
    res = await stop(w.env);
    assert.deepEqual([res.status, await res.json()], [200, { ok: true, domain: null }]);
    assert.equal(await domainRow(w.env, 'site1'), null);
    assert.equal(w.cf.zones.size, 1, 'a zone that took hold is never removed by Kiln');
    assert.equal(w.cf.recordsOf(N).filter(r => r.type === 'MX').length, 1);
  });

  // Cloudflare cannot be asked: the set-up stays as it is, so nothing is left there that nobody knows of.
  const d = world();
  await withFetch(d.handler, async () => {
    await setup(d.env);
    d.cf.failOn((method, path) => method === 'GET' && /^\/zones\/[^/]+$/.test(path));
    await quiet(async () => {
      const res = await stop(d.env);
      assert.equal(res.status, 502);
      assert.equal((await res.json()).code, 'not_asked');
    });
    assert.equal((await domainRow(d.env, 'site1')).state, 'waiting');
    assert.equal(d.cf.zones.size, 1);
  });
  for (const c of ['is_live', 'changed']) plain(domainSentence(c, { name: N, seller: 'GoDaddy' }));
});

test('own domain: the records are a file to download, and with editing switched off the owner can still check, download and stop', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    const none = await records(w.env);
    assert.deepEqual([none.status, await none.json()], [404, { error: domainSentence('no_domain'), code: 'no_domain' }]);
    await setup(w.env);
    editingOff(w.env);

    const res = await records(w.env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Disposition'), `attachment; filename="${N}-records.txt"`);
    assert.match(res.headers.get('Content-Type'), /^text\/plain/);
    assert.equal(res.headers.get('Access-Control-Expose-Headers'), 'Content-Disposition', 'the dashboard, at another address, may read the file\'s name');
    const text = await res.text();
    assert.match(text, new RegExp(`${N.replace('.', '\\.')}\\.\\t1\\tIN\\tMX\\t1 aspmx\\.l\\.google\\.com`));
    assert.match(text, /_dmarc\.oakbakery\.test\./);

    assert.equal((await check(w.env)).status, 200);
    assert.equal((await standing(w.env)).status, 200);
    assert.deepEqual(await (await stop(w.env)).json(), { ok: true, domain: null });
    assert.equal(w.cf.zones.size, 0);
  });

  // A set-up whose zone Cloudflare no longer has: there is nothing to hand over, and the answer says where the records are.
  const g = world();
  await withFetch(g.handler, async () => {
    await setup(g.env);
    g.cf.zones.clear();
    const res = await records(g.env);
    assert.deepEqual([res.status, await res.json()], [404, { error: domainSentence('no_records', { name: N }), code: 'no_records' }]);
    // Cloudflare cannot be asked at all.
    await saveDomain(g.env, 'site1', { zone_id: 'zone-x' });
    g.cf.failOn(() => true);
    await quiet(async () => {
      const down = await records(g.env);
      assert.deepEqual([down.status, await down.json()], [502, { error: domainSentence('not_asked', { name: N }), code: 'not_asked' }]);
    });
  });
  plain(domainSentence('no_records', { name: N }));
});

// ─── What the dashboard is told ───────────────────────────────────────────────

test('own domain: the list of sites says whether this service can do it at all, and where each site\'s domain stands', { skip: d1Skip }, async () => {
  const me = async (w) => (await (await ask(w.env, 'GET', '/cloud/me')).json());
  let w = world();
  await withFetch(w.handler, async () => {
    let out = await me(w);
    assert.equal(out.domains, true);
    assert.equal(out.sites[0].domain, null);
    await saveDomain(w.env, 'site1', { name: N, zone_id: 'zone-secret', state: 'put_away', reason: 'not_changed', ns1: 'ada.ns.cloudflare.com', ns2: 'bob.ns.cloudflare.com', records: [{ type: 'MX', name: N, content: '1 mx.example', kind: 'mail' }] });
    out = await me(w);
    assert.deepEqual({ ...out.sites[0].domain, since: null }, {
      name: N, state: 'put_away', name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], old_name_servers: [], seller: null,
      since: null, checked_at: null, live_at: null, gives_up_at: null, error: domainSentence('not_changed', { name: N }),
    });
    assert.doesNotMatch(JSON.stringify(out), /zone-secret/);
  });
  // A service that hosts no sites, and a database the migration has not reached.
  for (const extra of [{ HOSTING_API_TOKEN: '' }, { d1: { upTo: 5 } }]) {
    w = world({ env: extra });
    await withFetch(w.handler, async () => {
      const out = await me(w);
      assert.equal(out.domains, false);
      assert.equal(out.sites[0].domain, null);
    });
  }
});

// ─── The email ────────────────────────────────────────────────────────────────

test('own domain: the email says which two name servers to enter and where, what keeps working, what Kiln kept, and the day the set-up is put away', () => {
  const givesUpAt = Date.UTC(2026, 11, 7, 15);
  const about = {
    origin: 'https://club.example', name: N, nameServers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], seller: { name: 'GoDaddy', help_url: GODADDY }, helpUrl: GODADDY,
    records: [{ kind: 'mail' }, { kind: 'mail' }, { kind: 'mail' }, { kind: 'proof' }, { kind: 'other' }], givesUpAt, dashboard: 'https://app.example',
  };
  const mail = domainNameServersMail(about);
  assert.equal(dayWords(givesUpAt), 'Monday, December 7');
  assert.equal(mail.subject, 'Two name servers to enter for oakbakery.test');
  assert.equal(mail.text, [
    'Hello,',
    'Kiln has made everything ready for your site to answer at oakbakery.test. One step is left, and only you can take it: sign in at GoDaddy, and replace the name servers of oakbakery.test with these two.',
    'ada.ns.cloudflare.com',
    'bob.ns.cloudflare.com',
    'The domain was bought at GoDaddy. This page explains how to change its name servers:',
    GODADDY,
    'Until that change takes hold, your site and your email keep working exactly where they are now. It takes from a few minutes to a day. Kiln notices by itself, puts your site at oakbakery.test, and writes to you again when it is live.',
    'Kiln copied 3 email records and 2 other records of oakbakery.test, so that email and everything else on the domain keep working after the change. Kiln cannot always see every record, so before you change the name servers, compare the list on the site\'s row in your dashboard with the list at GoDaddy.',
    'https://app.example',
    'If the name servers are not changed by Monday, December 7, Kiln puts this set-up away. Nothing of yours is changed by that, and you can start again any time.',
    'Kiln\nYou are getting this because club.example was added to Kiln Cloud with this email address. Reply to this email to reach a person.\n',
  ].join('\n\n'));
  assert.ok(mail.html.includes(`<a href="${GODADDY}"`), 'the seller\'s page is a link');
  assert.ok(mail.html.includes('<a href="https://app.example"'));
  assert.ok(mail.html.includes('>ada.ns.cloudflare.com</p>'));

  // One record of each sort, and a seller nobody could name.
  const one = domainNameServersMail({ ...about, seller: null, helpUrl: GENERAL, records: [{ kind: 'mail' }, { kind: 'other' }] }).text;
  assert.match(one, /Kiln copied 1 email record and 1 other record of oakbakery\.test/);
  assert.match(one, /sign in at the company you bought the domain from, and replace/);
  assert.match(one, /compare the list on the site's row in your dashboard with the list at the company you bought the domain from\./);
  assert.ok(one.includes(`This page explains how to change a domain's name servers:\n\n${GENERAL}\n\n`));
  // No email records among those Kiln kept, and no records at all: the owner is told not to go on if the domain has email.
  const noMail = domainNameServersMail({ ...about, records: [{ kind: 'other' }] }).text;
  assert.ok(noMail.includes('Kiln copied 1 record of oakbakery.test and saw none for email. If the domain has email, do not change the name servers yet: reply to this email, and we will add the records with you first. The list is on the site\'s row in your dashboard.'));
  const empty = domainNameServersMail({ ...about, records: [] }).text;
  assert.ok(empty.includes('Kiln found no records to copy for oakbakery.test. If the domain has email, do not change the name servers yet: reply to this email, and we will add the records with you first.'));
  for (const text of [mail.text, mail.html, mail.subject, one, noMail, empty]) {
    assert.doesNotMatch(text, /[—–]/);
    assert.doesNotMatch(text, /undefined|null|\[object/);
  }
});

// ─── The four emails that follow a set-up ─────────────────────────────────────

const TEMP = `https://${WORKER}.kiln-sites.workers.dev`;
const letter = (paragraphs, host) => `${paragraphs.join('\n\n')}\n\nKiln\nYou are getting this because ${host} was added to Kiln Cloud with this email address. Reply to this email to reach a person.\n`;
const clean = (...mails) => { for (const m of mails) for (const text of [m.subject, m.text, m.html]) { assert.doesNotMatch(text, /[—–]/); assert.doesNotMatch(text, /undefined|null|\[object/); } };

test('own domain: the "live" email gives the address, says the temporary one keeps working and email is untouched, and how to open the editor', () => {
  const about = { name: N, address: `https://${N}`, tempUrl: TEMP, oneAddress: true, dashboard: 'https://app.example' };
  const mail = domainLiveMail(about);
  assert.equal(mail.subject, 'Your site is live at oakbakery.test');
  assert.equal(mail.text, letter([
    'Hello,',
    'The name servers of oakbakery.test now point at Kiln, and your site is live at its new address.',
    'https://oakbakery.test',
    'A visitor who types www.oakbakery.test is sent on to that address, and everyone gets the secure https version of it.',
    'The temporary address keeps working, so a link you have already shared still opens the site.',
    TEMP,
    'Your email and the other records of oakbakery.test are untouched. They answer the way they did before the change.',
    'To edit the site, open https://oakbakery.test/kiln and sign in the way you did before. Click any outlined words or picture, change them, and press Publish.',
    'The site\'s row in your dashboard shows the domain and the records Kiln keeps for it.',
    'https://app.example',
  ], N));
  assert.ok(mail.html.includes('<a href="https://oakbakery.test"'));
  // A site whose address is the www one is told that one, and that the bare name is sent on to it.
  const www = domainLiveMail({ ...about, address: `https://www.${N}/` });
  assert.ok(www.text.includes('\n\nhttps://www.oakbakery.test\n\nA visitor who types oakbakery.test is sent on to that address'));
  assert.ok(www.text.includes('open https://www.oakbakery.test/kiln and sign in'));
  // When the other name could not be sent on, the email does not say that it is. With no temporary address it names none.
  const plainer = domainLiveMail({ ...about, oneAddress: false, tempUrl: null });
  assert.doesNotMatch(plainer.text, /is sent on|temporary address/);
  clean(mail, www, plainer);
});

test('own domain: the reminder gives the two name servers again, the seller\'s page, and the day the set-up is put away', () => {
  const givesUpAt = Date.UTC(2026, 11, 7);
  const about = { origin: TEMP, name: N, nameServers: ['ada1.ns.cloudflare.com', 'bob1.ns.cloudflare.com'], seller: { name: 'GoDaddy' }, helpUrl: GODADDY, givesUpAt, dashboard: 'https://app.example' };
  const mail = domainReminderMail(about);
  assert.equal(mail.subject, 'oakbakery.test is still waiting for its two name servers');
  assert.equal(mail.text, letter([
    'Hello,',
    'Kiln has everything ready for your site to answer at oakbakery.test, and the name servers of oakbakery.test have not been changed yet. That one step is left, and only you can take it: sign in at GoDaddy, and replace the name servers of oakbakery.test with these two.',
    'ada1.ns.cloudflare.com',
    'bob1.ns.cloudflare.com',
    'The domain was bought at GoDaddy. This page explains how to change its name servers:',
    GODADDY,
    'Until that change takes hold, your site and your email keep working exactly where they are now. Kiln notices the change by itself and writes to you when your site is live at oakbakery.test.',
    `If the name servers are not changed by ${dayWords(givesUpAt)}, Kiln puts this set-up away. Nothing of yours is changed by that, and you can start again any time.`,
    'If you no longer want to use oakbakery.test, you can stop the set-up on the site\'s row in your dashboard.',
    'https://app.example',
  ], `${WORKER}.kiln-sites.workers.dev`));
  assert.equal(dayWords(givesUpAt), 'Monday, December 7');
  // Nobody could say who sold the domain: the general page, and no seller is named.
  const unknown = domainReminderMail({ ...about, seller: null, helpUrl: GENERAL });
  assert.ok(unknown.text.includes('sign in at the company you bought the domain from, and replace'));
  assert.ok(unknown.text.includes(`This page explains how to change a domain's name servers:\n\n${GENERAL}\n\n`));
  clean(mail, unknown);
});

test('own domain: the "put away" email says why, that nothing of theirs was changed, and how to start again', () => {
  const about = { origin: TEMP, name: N, reason: 'not_changed', waitDays: LIMITS.waitDays, dashboard: 'https://app.example' };
  const mail = domainPutAwayMail(about);
  assert.equal(mail.subject, 'The set-up for oakbakery.test was put away');
  assert.equal(mail.text, letter([
    'Hello,',
    'Kiln put the set-up for oakbakery.test away, because the name servers of oakbakery.test were not changed within 25 days.',
    'Kiln changed nothing of yours. oakbakery.test, its email and its other records are where you keep them, and your site is still up at the address it had.',
    TEMP,
    'To start again, open your dashboard and set up oakbakery.test on the site\'s row. It takes a minute, and Kiln writes to you again with the two name servers to enter.',
    'https://app.example',
  ], `${WORKER}.kiln-sites.workers.dev`));
  const moved = domainPutAwayMail({ ...about, reason: 'moved' });
  assert.ok(moved.text.includes('Kiln put the set-up for oakbakery.test away, because the name servers of oakbakery.test were pointed at Kiln and then pointed somewhere else before your site was live there.'));
  const gone = domainPutAwayMail({ ...about, reason: 'gone' });
  assert.ok(gone.text.includes('Kiln put the set-up for oakbakery.test away, because Cloudflare, which runs Kiln\'s hosting, no longer holds it.'));
  clean(mail, moved, gone);
  plain(domainSentence('gone', { name: N }));
});

test('own domain: the "moved away" email says the site is back at its temporary address, that nothing was deleted, and how to bring the domain back', () => {
  const mail = domainMovedMail({ name: N, tempUrl: `${TEMP}/`, dashboard: 'https://app.example' });
  assert.equal(mail.subject, 'oakbakery.test was moved away from Kiln');
  assert.equal(mail.text, letter([
    'Hello,',
    'The name servers of oakbakery.test no longer point at Kiln, so your site does not answer at oakbakery.test any more.',
    'Your site is back at its temporary address, and it is still up there.',
    TEMP,
    `Nothing was deleted. Your pages and your repository are as they were. To edit the site, open ${TEMP}/kiln and sign in the way you did before.`,
    'If email at oakbakery.test has stopped arriving, the company whose name servers the domain uses now needs its email records. Reply to this email and we will help you with that.',
    'To bring oakbakery.test back, open your dashboard and set it up again on the site\'s row. Kiln writes to you again with the two name servers to enter.',
    'https://app.example',
  ], N));
  const nowhere = domainMovedMail({ name: N, tempUrl: null, dashboard: 'https://app.example' });
  assert.doesNotMatch(nowhere.text, /temporary address|\/kiln/);
  clean(mail, nowhere);
});

// ─── The step that makes a domain live ────────────────────────────────────────

const originOf = async (env) => (await env.kiln_cloud.prepare("SELECT origin FROM sites WHERE id = 'site1'").first()).origin;
/** The domain is set up and its name servers have been changed: the row that waits. Call it inside withFetch. */
async function changed(w) { await setup(w.env); w.cf.setStatus(N, 'active'); return domainRow(w.env, 'site1'); }
const took = (env, row, now) => domainTookHold(env, { site: { id: 'site1' }, row, ...(now ? { now } : {}) });

test('own domain: once the name servers have changed and the site answers there, the domain is live, the site has that address, www is sent on, HTTPS is always on, and the owner is written to once', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    const row = await changed(w);
    const before = await originOf(w.env);
    // The certificate is not ready: nothing changes, and a line says so.
    const lines = await hush(async () => assert.deepEqual(await took(w.env, row, 5000), { live: false }));
    assert.match(lines.join('\n'), /domain_not_answering_yet/);
    assert.equal((await domainRow(w.env, 'site1')).state, 'waiting');
    assert.equal(await originOf(w.env), before);
    assert.equal(w.mails().length, 1, 'only the email with the two name servers has gone');
    assert.equal((w.cf.zoneOf(N).redirects || []).length, 0);

    // It answers this service, but its certificate is still being issued: a
    // browser would get a failed secure connection, so it is not live yet.
    w.answers(N);
    w.cf.zoneOf(N).certificate = 'pending_validation';
    const waiting = await hush(async () => assert.deepEqual(await took(w.env, row, 5000), { live: false }));
    assert.match(waiting.join('\n'), /domain_certificate_not_ready/);
    assert.equal((await domainRow(w.env, 'site1')).state, 'waiting');
    assert.equal(await originOf(w.env), before);
    assert.equal(w.mails().length, 1, 'nobody is told it is live');
    assert.equal(w.cf.zoneOf(N).settings.always_use_https, undefined, 'and nobody is sent to https before it works');

    // The certificate is issued: the domain is live.
    w.cf.zoneOf(N).certificate = 'active';
    await hush(async () => assert.deepEqual(await took(w.env, row, 5000), { live: true }));
    const live = await domainRow(w.env, 'site1');
    assert.deepEqual({ state: live.state, live_at: live.live_at, checked_at: live.checked_at }, { state: 'live', live_at: 5000, checked_at: 5000 });
    assert.equal(await originOf(w.env), `https://${N}`);
    const zone = w.cf.zoneOf(N);
    assert.equal(zone.redirects[0].expression, `(http.host eq "www.${N}")`);
    assert.equal(zone.settings.always_use_https, 'on');
    assert.equal(w.mails().length, 2);
    const mail = w.mails().at(-1);
    assert.equal(mail.subject, `Your site is live at ${N}`);
    assert.equal(mail.text, domainLiveMail({ name: N, address: `https://${N}`, tempUrl: TEMP, oneAddress: true, dashboard: 'https://app.example' }).text);

    // The button and the five-minute job can both see it: it is live, nothing is done twice, and nobody is written to twice.
    await hush(async () => {
      assert.deepEqual(await took(w.env, live), { live: true });
      assert.deepEqual(await took(w.env, row), { live: true });
    });
    assert.equal((await domainRow(w.env, 'site1')).live_at, 5000);
    assert.equal(w.mails().length, 2);
    assert.equal(await originOf(w.env), `https://${N}`);
  });
});

test('own domain: a site whose address on record was the www one keeps it, and a redirect or an HTTPS switch that fails does not stop the domain going live', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    const row = await changed(w);
    w.env.kiln_cloud.exec("UPDATE sites SET origin = ? WHERE id = 'site1'", `https://www.${N}`);
    w.answers(N, `www.${N}`);
    await hush(async () => assert.deepEqual(await took(w.env, row), { live: true }));
    assert.equal(await originOf(w.env), `https://www.${N}`);
    assert.equal(w.cf.zoneOf(N).redirects[0].expression, `(http.host eq "${N}")`);
    assert.ok(w.mails().at(-1).text.includes(`\n\nhttps://www.${N}\n\nA visitor who types ${N} is sent on to that address`));
  });
  // Cloudflare refuses the rule and the switch: live all the same, each failure leaves a line, and the email does not say what was not done.
  const v = world();
  await withFetch(v.handler, async () => {
    const row = await changed(v);
    v.answers(N);
    v.cf.failOn((method, path) => /rulesets|always_use_https/.test(path));
    const lines = await hush(async () => assert.deepEqual(await took(v.env, row), { live: true }));
    assert.equal(lines.filter(l => /domain_one_address_failed/.test(l)).length, 2);
    assert.equal((await domainRow(v.env, 'site1')).state, 'live');
    assert.equal(await originOf(v.env), `https://${N}`);
    const mail = v.mails().at(-1);
    assert.equal(mail.subject, `Your site is live at ${N}`);
    assert.doesNotMatch(mail.text, /is sent on/);
  });
});

test('own domain: going live writes to nobody where the service sends no customer mail, and a row it cannot use changes nothing and throws nothing', { skip: d1Skip }, async () => {
  const w = world({ env: { CUSTOMER_MAIL_FROM: '' } });
  await withFetch(w.handler, async () => {
    const row = await changed(w);
    assert.deepEqual(await domainTookHold(w.env), { live: false });
    assert.deepEqual(await took(w.env, { ...row, state: 'put_away' }), { live: false });
    assert.deepEqual(await took(w.env, { ...row, zone_id: null }), { live: false });
    assert.deepEqual(await domainTookHold(w.env, { site: { id: 'nobody' }, row }), { live: false });
    const lines = await hush(async () => assert.deepEqual(await took({}, row), { live: false }));
    assert.match(lines.join('\n'), /domain_took_hold_failed/);
    assert.equal((await domainRow(w.env, 'site1')).state, 'waiting');
    w.answers(N);
    await hush(async () => assert.deepEqual(await took(w.env, row), { live: true }));
    assert.equal(w.mails().length, 0);
  });
});

// ─── The five-minute job ──────────────────────────────────────────────────────

const DAY = 86400 * 1000;
const tally = (over = {}) => ({ looked: 0, live: 0, reminded: 0, putAway: 0, moved: 0, failed: 0, ...over });
const sweep = async (env, now) => { let out; const lines = await hush(async () => { out = await sweepDomains(env, now ? { now } : {}); }); return { out, lines: lines.join('\n') }; };
const where = async (env, id = 'site1') => { const r = await domainRow(env, id); return { state: r.state, reason: r.reason, checked_at: r.checked_at }; };

test('own domain: the five-minute job makes a domain live once its name servers have changed and the site answers there, and looks at a live domain once an hour at most', { skip: d1Skip }, async () => {
  const w = world();
  assert.deepEqual(await sweepDomains({}), tally(), 'a service with no database has nothing to look at');
  await withFetch(w.handler, async () => {
    assert.deepEqual((await sweep(w.env)).out, tally(), 'no site has a domain');
    await setup(w.env);
    const t = Date.now() + 1000;
    // The name servers have not changed: the domain is looked at and left as it is, and Cloudflare is not pressed to look again.
    assert.deepEqual((await sweep(w.env, t)).out, tally({ looked: 1 }));
    assert.deepEqual(await where(w.env), { state: 'waiting', reason: null, checked_at: t });
    assert.equal(w.cf.zoneOf(N).checks, 0);
    assert.equal(w.mails().length, 1);

    // They have changed, and the certificate is not ready: it still waits, and a line says so.
    w.cf.setStatus(N, 'active');
    let run = await sweep(w.env, t + 5 * 60000);
    assert.deepEqual(run.out, tally({ looked: 1 }));
    assert.match(run.lines, /domain_not_answering_yet/);
    assert.deepEqual(await where(w.env), { state: 'waiting', reason: null, checked_at: t + 5 * 60000 });

    // The site answers at the domain: live, at that address, and the owner is written to.
    w.answers(N);
    run = await sweep(w.env, t + 10 * 60000);
    assert.deepEqual(run.out, tally({ looked: 1, live: 1 }));
    assert.deepEqual(await where(w.env), { state: 'live', reason: null, checked_at: t + 10 * 60000 });
    assert.equal((await domainRow(w.env, 'site1')).live_at, t + 10 * 60000);
    assert.equal(await originOf(w.env), `https://${N}`);
    assert.deepEqual([w.mails().length, w.mails().at(-1).subject, w.mails().at(-1).to], [2, `Your site is live at ${N}`, 'ada@example.com']);

    // Within the hour a live domain is left alone. After it, it is looked at, and one that still points at Kiln stays as it is.
    w.cf.calls.length = 0;
    assert.deepEqual((await sweep(w.env, t + 60 * 60000)).out, tally());
    assert.equal(w.cf.calls.length, 0);
    assert.deepEqual((await sweep(w.env, t + 71 * 60000)).out, tally({ looked: 1 }));
    assert.deepEqual(await where(w.env), { state: 'live', reason: null, checked_at: t + 71 * 60000 });
    assert.equal(w.mails().length, 2);
  });
});

test('own domain: when the owner points a live domain\'s name servers elsewhere, the site goes back to its temporary address, the owner is written to once, and nothing is deleted', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await setup(w.env);
    w.cf.setStatus(N, 'active');
    w.answers(N);
    const t = Date.now() + 1000;
    assert.equal((await sweep(w.env, t)).out.live, 1);
    w.cf.setStatus(N, 'moved');
    w.answers();
    w.cf.calls.length = 0;
    const run = await sweep(w.env, t + 61 * 60000);
    assert.deepEqual(run.out, tally({ looked: 1, moved: 1 }));
    assert.match(run.lines, /domain_moved_away/);
    assert.deepEqual(await where(w.env), { state: 'put_away', reason: 'moved', checked_at: t + 61 * 60000 });
    assert.equal(await originOf(w.env), TEMP);
    const mail = w.mails().at(-1);
    assert.deepEqual([w.mails().length, mail.subject, mail.to], [3, `${N} was moved away from Kiln`, 'ada@example.com']);
    assert.equal(mail.text, domainMovedMail({ name: N, tempUrl: TEMP, dashboard: 'https://app.example' }).text);
    assert.ok(w.cf.zoneOf(N), 'the zone is left where it is: it may still answer for email');
    assert.deepEqual(w.cf.calls.map(c => c.method), ['GET'], 'Cloudflare was only asked where the zone stands');
    // The dashboard says it in the sentence it was built with, and the job never comes back to it.
    assert.match((await (await standing(w.env)).json()).domain.error, /no longer point at Kiln/);
    for (const later of [2, 3, 30]) assert.deepEqual((await sweep(w.env, t + later * DAY)).out, tally());
    assert.equal(w.mails().length, 3);
  });
});

test('own domain: a set-up that waits gets one reminder after 14 days, and after 25 its waiting zone is removed, it is put away, and the owner is told', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await setup(w.env);
    const row = await domainRow(w.env, 'site1');
    const made = row.created_at;
    assert.deepEqual((await sweep(w.env, made + 14 * DAY - 1)).out, tally({ looked: 1 }));
    assert.equal(w.mails().length, 1);
    assert.deepEqual((await sweep(w.env, made + 14 * DAY)).out, tally({ looked: 1, reminded: 1 }));
    assert.equal((await domainRow(w.env, 'site1')).reminded_at, made + 14 * DAY);
    const mail = w.mails().at(-1);
    assert.deepEqual([w.mails().length, mail.subject, mail.to], [2, `${N} is still waiting for its two name servers`, 'ada@example.com']);
    assert.ok(mail.text.includes(`\n\n${row.ns1}\n\n${row.ns2}\n\n`));
    assert.ok(mail.text.includes(`\n\n${GODADDY}\n\n`));
    assert.ok(mail.text.includes(`If the name servers are not changed by ${dayWords(made + LIMITS.waitDays * DAY)}, Kiln puts this set-up away.`));
    // Reminded once, however long it goes on waiting.
    for (const d of [15, 20, 24]) assert.deepEqual((await sweep(w.env, made + d * DAY)).out, tally({ looked: 1 }));
    assert.equal(w.mails().length, 2);

    const run = await sweep(w.env, made + 25 * DAY);
    assert.deepEqual(run.out, tally({ looked: 1, putAway: 1 }));
    assert.match(run.lines, /domain_put_away/);
    assert.equal(w.cf.zoneOf(N), null, 'the zone that never took hold is removed');
    assert.deepEqual(await where(w.env), { state: 'put_away', reason: 'not_changed', checked_at: made + 25 * DAY });
    assert.equal(w.mails().length, 3);
    assert.equal(w.mails().at(-1).text, domainPutAwayMail({ origin: await originOf(w.env), name: N, reason: 'not_changed', waitDays: LIMITS.waitDays, dashboard: 'https://app.example' }).text);
    assert.deepEqual((await sweep(w.env, made + 26 * DAY)).out, tally());
    assert.equal(w.mails().length, 3);
  });
  // Where the owner cannot be written to, nobody is marked as reminded, and the set-up is put away all the same.
  const v = world({ env: { CUSTOMER_MAIL_FROM: '' } });
  await withFetch(v.handler, async () => {
    await setup(v.env);
    const made = (await domainRow(v.env, 'site1')).created_at;
    assert.deepEqual((await sweep(v.env, made + 14 * DAY)).out, tally({ looked: 1 }));
    assert.equal((await domainRow(v.env, 'site1')).reminded_at, null);
    assert.deepEqual((await sweep(v.env, made + 25 * DAY)).out, tally({ looked: 1, putAway: 1 }));
    assert.equal(v.mails().length, 0);
  });
});

test('own domain: a set-up whose zone is gone, or whose name servers were changed and changed away again, is put away with one email', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await setup(w.env);
    await removeWaitingDomain(w.env, { zoneId: w.cf.zoneOf(N).id });
    assert.deepEqual((await sweep(w.env)).out, tally({ looked: 1, putAway: 1 }));
    assert.deepEqual({ ...(await where(w.env)), checked_at: 0 }, { state: 'put_away', reason: 'gone', checked_at: 0 });
    assert.deepEqual([w.mails().length, w.mails().at(-1).subject], [2, `The set-up for ${N} was put away`]);
    assert.ok(w.mails().at(-1).text.includes('because Cloudflare, which runs Kiln\'s hosting, no longer holds it.'));
    for (let i = 0; i < 3; i++) assert.deepEqual((await sweep(w.env)).out, tally());
    assert.equal(w.mails().length, 2, 'one email, however often the job runs');
    assert.match((await (await standing(w.env)).json()).domain.error, /no longer holds oakbakery\.test/);
  });
  const v = world();
  await withFetch(v.handler, async () => {
    await setup(v.env);
    v.cf.setStatus(N, 'moved');
    assert.deepEqual((await sweep(v.env)).out, tally({ looked: 1, putAway: 1 }));
    assert.deepEqual({ ...(await where(v.env)), checked_at: 0 }, { state: 'put_away', reason: 'moved', checked_at: 0 });
    assert.ok(v.mails().at(-1).text.includes('were pointed at Kiln and then pointed somewhere else before your site was live there.'));
    assert.ok(v.cf.zoneOf(N), 'a zone that is not waiting is not removed');
    assert.equal(v.mails().length, 2);
  });
});

test('own domain: the five-minute job looks at ten domains a run, the one looked at longest ago first, and one that fails is logged and does not stop the rest', { skip: d1Skip }, async () => {
  const w = world();
  // Twelve sites with a set-up each, at zones Cloudflare no longer has. The third cannot be asked about at all.
  for (let i = 1; i <= 12; i++) {
    addSite(w.env, { id: `s${i}`, repo: `ada/r${i}`, origin: `https://r${i}.example`, plan: 'managed' });
    await saveDomain(w.env, `s${i}`, { name: `r${i}.test`, zone_id: `zone-${i}`, state: 'waiting', ns1: 'ada.ns.cloudflare.com', ns2: 'bob.ns.cloudflare.com', checked_at: i });
  }
  w.cf.failOn((method, path) => path === '/zones/zone-3');
  await withFetch(w.handler, async () => {
    const t = Date.now();
    let run = await sweep(w.env, t);
    assert.deepEqual(run.out, tally({ looked: 10, putAway: 9, failed: 1 }));
    assert.equal(run.lines.split('\n').filter(l => /domain_sweep_one_failed/.test(l) && /r3\.test/.test(l)).length, 1);
    assert.deepEqual(await where(w.env, 's3'), { state: 'waiting', reason: null, checked_at: t }, 'the one that failed goes to the back of the line');
    assert.deepEqual([(await where(w.env, 's10')).state, (await where(w.env, 's11')).state, (await where(w.env, 's12')).state], ['put_away', 'waiting', 'waiting']);
    assert.equal(w.mails().length, 9);
    // The next run takes the two that waited their turn, and then the one that failed.
    run = await sweep(w.env, t + 5 * 60000);
    assert.deepEqual(run.out, tally({ looked: 3, putAway: 2, failed: 1 }));
    assert.equal(w.mails().length, 11);
  });
});

// ─── A site answers at two addresses ──────────────────────────────────────────

const OWNER = 'c'.repeat(64), EDITOR = 'e'.repeat(64);
const AT_DOMAIN = `https://${N}`, AT_WWW = `https://www.${N}`;
/** The owner, signed in at `address`, asks who they are there: 200 where the address is the site's own, 403 where it is not. */
async function ownerAt(w, address) {
  await w.env.KILN.put(`osess:${OWNER}`, JSON.stringify({ v: 1, token: 'ghu_live', token_exp: Date.now() + 8 * 3600000, refresh_token: 'ghr_live', login: 'ada', uid: 7, repo: 'ada/club', origin: address, created: Date.now() }));
  const r = await call(w.env, 'GET', '/auth/session', { session: OWNER, headers: { Origin: address } });
  return { status: r.status, code: r.json?.code, role: r.json?.role, allowed: r.res.headers.get('Access-Control-Allow-Origin') };
}
/** An invited editor reads a page of the site from `address`: the browser hands the answer to the page only when `allowed` is that address. */
async function editorAt(w, address) {
  await w.env.KILN.put(`esess:${EDITOR}`, JSON.stringify({ repo: 'ada/club', name: 'Sam', role: 'editor', email: 'sam@example.com', paths: [''], keys: [], features: null, mode: null }));
  const r = await call(w.env, 'GET', '/gh/repos/ada/club/contents/index.html', { session: EDITOR, headers: { Origin: address } });
  return { status: r.status, allowed: r.res.headers.get('Access-Control-Allow-Origin') };
}
/** Both sessions work at the address, and the service's answers are let through to it. */
async function works(w, address, why) {
  assert.deepEqual(await ownerAt(w, address), { status: 200, code: undefined, role: 'owner', allowed: address }, `owner at ${address}: ${why}`);
  assert.deepEqual(await editorAt(w, address), { status: 200, allowed: address }, `editor at ${address}: ${why}`);
}
/** Neither works: the owner's session is refused, and no answer is let through to a page at the address. */
async function refused(w, address, why) {
  assert.deepEqual(await ownerAt(w, address), { status: 403, code: 'origin_refused', role: undefined, allowed: null }, `owner at ${address}: ${why}`);
  assert.equal((await editorAt(w, address)).allowed, null, `editor at ${address}: ${why}`);
}

test('two addresses: while a domain waits for its name servers, the owner and an editor work at the temporary address and not at the domain', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await works(w, TEMP, 'before any domain');
    await refused(w, AT_DOMAIN, 'before any domain');

    await setup(w.env);
    assert.equal((await domainRow(w.env, 'site1')).state, 'waiting');
    await works(w, TEMP, 'while the domain waits');
    await refused(w, AT_DOMAIN, 'while the domain waits');
    await refused(w, AT_WWW, 'while the domain waits');

    // The owner had given the domain as the site's address before it pointed at Kiln: it still does not count while it waits.
    for (const address of [AT_DOMAIN, AT_WWW]) {
      w.env.kiln_cloud.exec("UPDATE sites SET origin = ? WHERE id = 'site1'", address);
      await refused(w, address, 'on record, and still waiting');
      await works(w, TEMP, 'while the domain waits');
    }
  });
});

test('two addresses: once the domain is live, the owner and an editor work at the domain and still at the temporary address', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    const row = await changed(w);
    w.answers(N);
    await hush(async () => assert.deepEqual(await took(w.env, row), { live: true }));
    assert.equal(await originOf(w.env), AT_DOMAIN);
    await works(w, AT_DOMAIN, 'the domain is live');
    await works(w, TEMP, 'the domain is live');
    await refused(w, AT_WWW, 'www is sent on to the one address');
    await refused(w, 'https://club.example', 'the address it had before');
    await refused(w, 'https://club-other.kiln-sites.workers.dev', 'another site');

    // A session is for the address it was made at: the owner's session from one address is not taken at the other.
    await ownerAt(w, TEMP);
    const crossed = await call(w.env, 'GET', '/auth/session', { session: OWNER, headers: { Origin: AT_DOMAIN } });
    assert.deepEqual([crossed.status, crossed.json.code], [403, 'owner_origin']);

    // Editing switched off: neither address.
    editingOff(w.env);
    await refused(w, AT_DOMAIN, 'editing is switched off');
    await refused(w, TEMP, 'editing is switched off');
  });
});

test('two addresses: a site keeps the address it has on record while somebody else\'s set-up for that name waits, and a database without domains works as before', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => { await setup(w.env); });
  addSite(w.env, { id: 'site2', repo: 'bo/shop', origin: AT_DOMAIN, status: 'active' });
  assert.equal((await cloudSiteForOrigin(w.env, AT_DOMAIN))?.repo, 'bo/shop');
  assert.equal((await cloudSiteForOrigin(w.env, TEMP))?.repo, 'ada/club');

  const old = world({ env: { d1: { upTo: 5 } } });
  assert.equal(await domainsReady(old.env), false);
  assert.equal((await cloudSiteForOrigin(old.env, 'https://club.example'))?.repo, 'ada/club');
  assert.equal((await cloudSiteForOrigin(old.env, TEMP))?.repo, 'ada/club');
});

// ─── When hosting ends, or the site is removed ────────────────────────────────

/** The site's time on Kiln's hosting is over: the sweep takes it down, and the operator's note goes out as it does for real. */
const takeDown = (w) => hush(() => sweepHosting(w.env, {
  installationToken: async () => 'inst-token', hasAccess: () => false, endsAt: () => 1, endReason: () => 'trial_ended',
  ended: (site, reason, domain) => hostingEndedNote(w.env, site, reason, domain),
}));
const hostingOf = (env) => env.kiln_cloud.prepare("SELECT * FROM hosting WHERE site_id = 'site1'").first();
const remove = (env) => ask(env, 'POST', '/cloud/sites/remove', { id: 'site1' });
const downNote = (w) => w.notes().filter(m => /took ada\/club down/.test(m.raw));
const hasMail = (w) => w.cf.recordsOf(N).some(r => r.type === 'MX');
async function goLive(w) { const row = await changed(w); w.answers(N); await hush(async () => assert.deepEqual(await took(w.env, row), { live: true })); }

test('hosting ends: a domain that still waits is removed with the site, and the note says nothing of a domain', { skip: d1Skip }, async () => {
  const w = world({ env: { NOTIFY_TO: 'ops@example.com' } });
  await withFetch(w.handler, async () => {
    await setup(w.env);
    await takeDown(w);
    assert.equal((await hostingOf(w.env)).state, 'ended');
    assert.equal(w.cf.scripts.size, 0);
    assert.equal(w.cf.zoneOf(N), null, 'the zone that never took hold is gone');
    assert.equal(w.cf.workerDomains.size, 0);
    assert.equal(await domainRow(w.env, 'site1'), null);
    assert.equal(downNote(w).length, 1);
    assert.doesNotMatch(downNote(w)[0].raw, /oakbakery/);
  });
});

test('hosting ends: a live domain is detached and put away, its zone and its email records stay, the site has its temporary address again, and the note says how to move the domain away', { skip: d1Skip }, async () => {
  const w = world({ env: { NOTIFY_TO: 'ops@example.com' } });
  await withFetch(w.handler, async () => {
    await goLive(w);
    assert.equal(w.cf.workerDomains.size, 2);
    await takeDown(w);
    assert.equal((await hostingOf(w.env)).state, 'ended');
    assert.equal(w.cf.scripts.size, 0);
    assert.equal(w.cf.workerDomains.size, 0, 'the two site names are off the Worker');
    assert.ok(w.cf.zoneOf(N), 'the zone stays');
    assert.equal(hasMail(w), true, 'and so does the email record');
    const row = await domainRow(w.env, 'site1');
    assert.deepEqual([row.state, row.reason, !!row.zone_id], ['put_away', 'hosting_ended', true]);
    assert.equal(await originOf(w.env), TEMP);
    const shown = publicDomain(row);
    assert.equal(shown.error, domainSentence('hosting_ended', { name: N, seller: shown.seller.name }));
    for (const sentence of shown.error.match(/[^.]+(?:\.[a-z][^.]*)*\./g)) plain(sentence.trim());
    assert.match(shown.error, /keep working\. To move the domain away, download its records from this page first, and then change its name servers at /);
    assert.equal(downNote(w).length, 1);
    assert.ok(downNote(w)[0].raw.includes(liveDomainLeftNote(N)));
    plain(liveDomainLeftNote(N));
  });
});

test('hosting ends: when Cloudflare refuses, the site still comes down on a later run, the domain is put away all the same, and the note still has its sentence', { skip: d1Skip }, async () => {
  const w = world({ env: { NOTIFY_TO: 'ops@example.com' } });
  await withFetch(w.handler, async () => {
    await goLive(w);
    w.cf.failOn((method) => method === 'DELETE');
    const lines = (await takeDown(w)).join('\n');
    assert.match(lines, /domain_detach_failed/);
    assert.match(lines, /hosting_end_failed/);
    assert.equal((await domainRow(w.env, 'site1')).state, 'put_away');
    assert.equal(downNote(w).length, 0);
    w.cf.failOn(null);
    await takeDown(w);
    assert.equal((await hostingOf(w.env)).state, 'ended');
    assert.equal(w.cf.scripts.size, 0);
    assert.ok(w.cf.zoneOf(N));
    assert.ok(downNote(w)[0].raw.includes(liveDomainLeftNote(N)));
  });
});

test('removing a site: a domain that still waits goes with it, and a live domain is detached and put away while its zone and email records stay, and the answer says how to move it away', { skip: d1Skip }, async () => {
  let w = world();
  await withFetch(w.handler, async () => {
    await setup(w.env);
    const res = await remove(w.env);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).domain, undefined);
    assert.equal(w.cf.zoneOf(N), null);
    assert.equal(w.cf.workerDomains.size, 0);
    assert.equal(await domainRow(w.env, 'site1'), null);
    assert.equal(w.cf.scripts.size, 0);
  });

  w = world();
  await withFetch(w.handler, async () => {
    await goLive(w);
    const seller = publicDomain(await domainRow(w.env, 'site1')).seller.name;
    const res = await remove(w.env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.domain, { name: N, note: domainSentence('site_removed', { name: N, seller }) });
    assert.equal(body.domain.note, `Your site no longer answers at ${N}. The other records of ${N}, such as its email, keep working. To move the domain away, change its name servers at ${seller}. For a file of the domain's records, write to info@kilncms.com.`);
    assert.doesNotMatch(body.domain.note, /[—–]|undefined|null/);
    assert.equal(w.cf.scripts.size, 0);
    assert.equal(w.cf.workerDomains.size, 0);
    assert.ok(w.cf.zoneOf(N), 'the zone stays');
    assert.equal(hasMail(w), true);
    const row = await domainRow(w.env, 'site1');
    assert.deepEqual([row.state, row.reason], ['put_away', 'site_removed']);
    assert.equal(await w.env.kiln_cloud.prepare("SELECT id FROM sites WHERE id = 'site1'").first(), null);
  });
});

test('removing a site: what Cloudflare refuses is logged, and the site is removed all the same', { skip: d1Skip }, async () => {
  for (const state of ['waiting', 'live']) {
    const w = world();
    await withFetch(w.handler, async () => {
      if (state === 'live') await goLive(w); else await setup(w.env);
      w.cf.failOn((method) => method !== 'POST');
      let res;
      const lines = (await hush(async () => { res = await remove(w.env); })).join('\n');
      assert.equal(res.status, 200, state);
      assert.match(lines, /domain_detach_failed/, state);
      if (state === 'waiting') assert.match(lines, /domain_remove_failed/);
      assert.equal(await w.env.kiln_cloud.prepare("SELECT id FROM sites WHERE id = 'site1'").first(), null, state);
      assert.equal((await domainRow(w.env, 'site1'))?.state, state === 'live' ? 'put_away' : undefined, state);
      assert.equal((await hostingOf(w.env)).state, 'removing', state);
    });
  }
});
