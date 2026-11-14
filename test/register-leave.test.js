/**
 * A new domain through Kiln: renewal, ending and leaving (worker/register.js
 * `setRenewal`, `sweepRenewals`, `leaveName`, `freeRow`, `markRegistered`,
 * `handedOver`, and their routes in worker/cloud.js).
 *
 * The stand-in for Cloudflare's registrar below counts every call it
 * receives. `posts()` is the calls that register a name: in this whole file
 * there must never be one. `patches()` is the one change this chunk can
 * send, whether a name renews by itself, and `reads()` the looks at a
 * registration.
 *
 * Neither the change of renewal nor the reading of a registration has ever
 * been seen for real: their shapes here are guesses from Cloudflare's guide.
 * The real handlers run over the SQLite-backed D1 stand-in. Nothing touches
 * the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import worker from '../worker/index.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip, schemaFiles } from './d1-fake.js';
import { fakeGitHub } from './github-fake.js';
import { fakeCloudflare } from './cloudflare-fake.js';
import { sweepRenewals } from '../worker/cloud.js';
import { setRenewal, registeredFor } from '../worker/register.js';
import { hostingEndingMail, editingStoppedMail } from '../worker/mail.js';

const N = 'juniperhollowpottery.com';
const MIN = 60e3, DAY = 86400e3;
const NOW = Date.now();
const REG = 'https://api.cloudflare.com/client/v4/accounts/acct-hosting/registrar';
const WORKER = 'club-site1';
const OPS = 'ops@example.com';
const AT = '2026-11-13T10:00:00Z', UNTIL = '2027-11-13T10:00:00Z';
const words = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const iso = (ms) => new Date(ms).toISOString();

const SAYS = {
  stuck: (n) => `Registering ${n} stopped part way and a person at Kiln has been told. You do not need to do anything. We will email you within one working day.`,
  failed: (n) => `${n} could not be registered. Nothing was charged and your plan still includes a domain. Choose a name and try again.`,
  early: (day) => `A new name cannot be moved in its first 60 days. That is a rule for all domain names. We have noted your request and will email you on ${day} with what to do next. Your site stays on the name until then.`,
  now: (n) => `We have your request. A person at Kiln will email you within three working days with a code to move ${n}. Kiln charges nothing. The company you move it to charges its own price, which usually adds a year to the name.`,
  runsOut: (n, day) => `${n} runs out on ${day} and will not renew. To keep it, pay for a yearly plan again or ask us to hand it over. After that day the name can be lost for good.`,
  stays: (n, day) => `${n} stays registered until ${day}. Reply to this email and we hand it over to you at no charge.`,
  removed: (n, day) => `This site's domain, ${n}, was registered through Kiln. Removing the site does not hand the name over. Ask us for it before ${day}.`,
};

const envelope = (result, errors = []) => ({ success: errors.length === 0, errors, messages: [], result });

/**
 * Cloudflare's registrar, counting every call. `names[name]` is a
 * registration it holds ({ auto_renew, expires_at }). `refuse` makes it turn
 * the change of renewal down, and `ignore` makes it say yes and change nothing.
 */
function fakeRegistrar() {
  const seen = [];
  const reg = {
    seen, names: {}, refuse: false, ignore: false,
    posts: () => seen.filter(c => c.method === 'POST' && c.path === '/registrations'),
    patches: () => seen.filter(c => c.method === 'PATCH'),
    reads: () => seen.filter(c => c.method === 'GET' && /^\/registrations\/[^/]+$/.test(c.path)),
    changes: () => seen.filter(c => c.method !== 'GET'),
  };
  reg.handler = async (url, init = {}) => {
    if (!url.startsWith(REG)) return undefined;
    const method = (init.method || 'GET').toUpperCase(), path = url.slice(REG.length);
    const body = init.body ? JSON.parse(init.body) : null;
    seen.push({ method, path, body });
    if (method === 'POST' && path === '/registrations') return jsonRes(envelope({ domain_name: body.domain_name, state: 'in_progress' }), 202);
    const m = /^\/registrations\/([^/]+)$/.exec(path);
    const held = m ? reg.names[decodeURIComponent(m[1])] : null;
    if (m && !held) return jsonRes(envelope(null, [{ code: 10000, message: 'Registration not found' }]), 404);
    if (m && method === 'GET') return jsonRes(envelope({ domain_name: decodeURIComponent(m[1]), status: 'active', created_at: AT, expires_at: held.expires_at, auto_renew: held.auto_renew, privacy_mode: 'redaction', locked: true }));
    if (m && method === 'PATCH') {
      if (reg.refuse) return jsonRes(envelope(null, [{ code: 10000, message: 'This change is not allowed' }]), 403);
      if (!reg.ignore) held.auto_renew = body.auto_renew;
      return jsonRes(envelope({ domain_name: decodeURIComponent(m[1]), auto_renew: held.auto_renew }));
    }
    return jsonRes(envelope(null, [{ code: 10000, message: 'No route for that URI' }]), 404);
  };
  return reg;
}

/** One account (login "ada") with one site on the hosting plan: paid for a year, active, up on Kiln's hosting. `admin` is the operator's login. */
function world({ on = true, admin = 'ada', env: extra = {} } = {}) {
  const gh = fakeGitHub({ repo: 'ada/club', files: { 'index.html': '<!doctype html><h1>Home</h1>' } });
  const cf = fakeCloudflare();
  const reg = fakeRegistrar();
  const sent = [];
  const env = cloudEnv(fakeKV({ 'itok:ada/club': 'inst-token' }), {
    HOSTING_ACCOUNT_ID: cf.account, HOSTING_API_TOKEN: cf.token, HOSTING_SUBDOMAIN: 'kiln-sites', CLOUD_DASHBOARD: 'https://app.example',
    LS_VARIANT_MANAGED: '22', LS_VARIANT_MANAGED_YEARLY: '33', CLOUD_ADMIN: admin,
    NOTIFY: { send: async (m) => { sent.push(m); return { messageId: '<1@kilncms.com>' }; } }, NOTIFY_TO: OPS, CUSTOMER_MAIL_FROM: 'hello@kilncms.com',
    ...(on ? { REGISTER_DOMAINS: 'on' } : {}),
    ...extra,
  });
  addSite(env, { id: 'site1', plan: 'managed', status: 'active', ls_subscription_id: 'sub-1' });
  try { env.kiln_cloud.exec('UPDATE sites SET billing_period = ?, paid_until = ? WHERE id = ?', 'year', NOW + 300 * DAY, 'site1'); } catch { /* a database without migration 0016 */ }
  cf.addScript(WORKER);
  env.kiln_cloud.exec('INSERT INTO hosting (site_id, name, url, state, deployed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', 'site1', WORKER, `https://${WORKER}.kiln-sites.workers.dev`, 'live', 1, 1, 1);
  const handler = async (url, init) => (await reg.handler(url, init)) || (await cf.handler(url, init)) || gh.handler(url, init);
  const subject = (m) => String(m.subject || (/^Subject: (.*)$/m.exec(String(m.raw || '')) || [])[1] || '').trim();
  return {
    env, handler, reg, cf, sent,
    notes: (about = '') => sent.filter(m => m.raw && subject(m).includes(about)).map(subject),   // to the operator
    mails: (about = '') => sent.filter(m => !m.raw && subject(m).includes(about)),               // to the customer
    subject,
  };
}
/** A registration row, as the earlier chunks leave one. A registered one is also held by the stand-in for Cloudflare. */
function hold(w, over = {}) {
  const r = { id: 'reg-1', site_id: 'site1', account_id: 'acct-1', subscription_id: 'sub-1', name: N, state: 'registered', reason: null,
    asked_at: NOW - 10 * DAY, registered_at: NOW - 10 * DAY, expires_at: NOW + 355 * DAY, renews: 1, checked_at: NOW, created_at: NOW - 10 * DAY, updated_at: NOW, ...over };
  w.env.kiln_cloud.exec('INSERT INTO registrations (id, site_id, account_id, subscription_id, name, state, reason, asked_at, registered_at, expires_at, renews, checked_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    r.id, r.site_id, r.account_id, r.subscription_id, r.name, r.state, r.reason, r.asked_at, r.registered_at, r.expires_at, r.renews, r.checked_at, r.created_at, r.updated_at);
  if (r.state === 'registered') w.reg.names[r.name] = { auto_renew: !!r.renews, expires_at: iso(r.expires_at) };
  return r;
}
const waiting = { registered_at: null, expires_at: null };   // a row that is not registered yet has no dates
const ask = (env, pathname, method = 'GET', body) => worker.fetch(new Request(`https://worker.example${pathname}`, {
  method, headers: { Authorization: 'Bearer tok', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}), env);
const answer = async (r) => { const text = await r.text(); try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, json: { text } }; } };
const call = (w, pathname, method, body) => withFetch(w.handler, async () => answer(await ask(w.env, pathname, method, body)));
const leave = (w, body = {}) => call(w, '/cloud/sites/newdomain', 'POST', { action: 'leave', ...body });
const admin = (w, what, body) => call(w, `/admin/cloud/${what}`, body ? 'POST' : 'GET', body);
const timer = (w, now) => withFetch(w.handler, () => sweepRenewals(w.env, now ? { now } : {}));
const regs = (env) => env.kiln_cloud.prepare('SELECT * FROM registrations ORDER BY created_at, id').all().then(r => r.results || []);
const one = async (env, id = 'reg-1') => (await regs(env)).find(r => r.id === id);
const canceled = (w) => w.env.kiln_cloud.exec("UPDATE sites SET status = 'canceled' WHERE id = 'site1'");
const domainOn = (w, state = 'live') => w.env.kiln_cloud.exec('INSERT INTO domains (site_id, name, zone_id, state, registered, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', 'site1', N, 'zone-1', state, 1, 1, 1);
const domains = (env) => env.kiln_cloud.prepare('SELECT * FROM domains').all().then(r => r.results || []);
/** The billing company's webhook, signed as the earlier chunks' tests sign it. */
async function hook(env, attributes) {
  const body = JSON.stringify({
    meta: { event_name: 'subscription_updated', custom_data: { site_id: 'site1' } },
    data: { type: 'subscriptions', id: 'sub-1', attributes: { ends_at: null, variant_id: 33, renews_at: '2027-11-13T15:00:00.000000Z', ...attributes } },
  });
  const sig = createHmac('sha256', 'whsec').update(body).digest('hex');
  return (await worker.fetch(new Request('https://worker.example/cloud/webhook/ls', { method: 'POST', headers: { 'X-Signature': sig }, body }), env)).status;
}
/** Every line the service logs while `fn` runs. */
async function logged(fn) {
  const lines = [], log = console.log, warn = console.warn;
  console.log = (...a) => lines.push(a.join(' ')); console.warn = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.log = log; console.warn = warn; }
  return lines;
}

// ─── Renewal follows the plan ─────────────────────────────────────────────────

test('a cancel webhook leads to one change of renewal, written down only after Cloudflare reads back off, and resuming switches it on again', { skip: d1Skip }, async () => {
  const w = world();
  hold(w);
  await timer(w);
  assert.equal(w.reg.seen.length, 0, 'a paid plan, read today: nothing is asked of Cloudflare');
  assert.equal(await withFetch(w.handler, () => hook(w.env, { status: 'cancelled', ends_at: '2027-11-13T15:00:00.000000Z', updated_at: iso(NOW + 1000) })), 200);
  const lines = await logged(() => timer(w));
  assert.deepEqual(w.reg.patches().map(c => [c.path, c.body]), [[`/registrations/${N}`, { auto_renew: false }]]);
  assert.equal(w.reg.reads().length, 1);
  assert.equal((await one(w.env)).renews, 0);
  assert.ok(lines.some(l => l.includes('"renewal_off"')));
  assert.equal(lines.some(l => l.includes('ada@example.com')), false, 'no address in a log line');
  await timer(w);
  await timer(w, Date.now() + 10 * MIN);
  assert.equal(w.reg.patches().length, 1, 'one change, not one every five minutes');
  assert.equal(w.notes('Switch renewal').length, 0);

  // The plan is taken up again before the name runs out.
  assert.equal(await withFetch(w.handler, () => hook(w.env, { status: 'active', updated_at: iso(NOW + 2000) })), 200);
  const again = await logged(() => timer(w));
  assert.deepEqual(w.reg.patches().map(c => c.body), [{ auto_renew: false }, { auto_renew: true }]);
  assert.equal((await one(w.env)).renews, 1);
  assert.ok(again.some(l => l.includes('"renewal_on"')));
  assert.equal(w.reg.posts().length, 0);
});

test('a refused change tells the operator once that day and again the next, and the name is never marked as not renewing until Cloudflare shows it', { skip: d1Skip }, async () => {
  const w = world();
  hold(w);
  canceled(w);
  w.reg.refuse = true;
  await timer(w, NOW);
  await timer(w, NOW + 5 * MIN);
  await timer(w, NOW + 12 * 60 * MIN);
  assert.equal(w.reg.patches().length, 1);
  assert.deepEqual(w.notes('Switch renewal off by hand'), [`Switch renewal off by hand for ${N}`]);
  assert.equal((await one(w.env)).renews, 1);
  await timer(w, NOW + DAY + MIN);
  await timer(w, NOW + DAY + 6 * MIN);
  assert.equal(w.reg.patches().length, 2);
  assert.equal(w.notes('Switch renewal off by hand').length, 2);
  assert.equal((await one(w.env)).renews, 1);
  // Cloudflare says yes and changes nothing: its yes is not believed.
  w.reg.refuse = false; w.reg.ignore = true;
  await timer(w, NOW + 2 * DAY + 2 * MIN);
  assert.equal(w.notes('Switch renewal off by hand').length, 3);
  assert.equal((await one(w.env)).renews, 1);
  // The operator switches it off by hand. The next day it reads off, and nobody is written to again.
  w.reg.names[N].auto_renew = false;
  await timer(w, NOW + 3 * DAY + 3 * MIN);
  const row = await one(w.env);
  assert.equal(row.renews, 0);
  assert.equal(row.reason, null);
  assert.equal(w.notes('Switch renewal off by hand').length, 3);
  assert.equal(w.reg.posts().length, 0);
});

test('once a day the registration is read back, and the day it runs out is stored', { skip: d1Skip }, async () => {
  const w = world();
  hold(w, { checked_at: NOW - 2 * DAY });
  w.reg.names[N].expires_at = '2028-11-13T10:00:00Z';
  await timer(w);
  await timer(w);
  assert.equal(w.reg.reads().length, 1);
  assert.equal(w.reg.changes().length, 0);
  assert.equal((await one(w.env)).expires_at, Date.parse('2028-11-13T10:00:00Z'));
});

// ─── Running out ──────────────────────────────────────────────────────────────

test('the reminders at 30 and 7 days go once each, and only for a name that will not renew', { skip: d1Skip }, async () => {
  const until = NOW + 40 * DAY;
  const w = world();
  hold(w, { renews: 0, expires_at: until });
  canceled(w);
  await timer(w, NOW);
  assert.equal(w.mails().length, 0, 'forty days before: not yet');
  await timer(w, until - 29 * DAY);
  await timer(w, until - 28 * DAY);
  assert.equal(w.mails('runs out').length, 1);
  await timer(w, until - 6 * DAY);
  await timer(w, until - 5 * DAY);
  const mails = w.mails('runs out');
  assert.equal(mails.length, 2);
  for (const m of mails) {
    assert.equal(w.subject(m), `${N} runs out on ${words(until)}`);
    assert.ok(JSON.stringify(m).includes(SAYS.runsOut(N, words(until))));
  }
  assert.equal(w.reg.changes().length, 0);

  const v = world();
  hold(v, { expires_at: until });   // it renews: its plan is paid
  await timer(v, until - 29 * DAY);
  await timer(v, until - 6 * DAY);
  assert.equal(v.mails().length, 0);
});

test('past its day a name that did not renew has run out: the domain row is put away and the operator is told, once', { skip: d1Skip }, async () => {
  const until = NOW + 20 * DAY;
  const w = world();
  hold(w, { renews: 0, expires_at: until });
  canceled(w);
  domainOn(w);
  const lines = await logged(() => timer(w, until + MIN));
  await timer(w, until + 10 * MIN);
  assert.equal((await one(w.env)).state, 'ran_out');
  const [d] = await domains(w.env);
  assert.deepEqual([d.state, d.reason], ['put_away', 'ran_out']);
  assert.deepEqual(w.notes('ran out'), [`${N} ran out`]);
  assert.ok(lines.some(l => l.includes('"name_ran_out"')));
  assert.equal(w.reg.changes().length, 0);

  // A name somebody renewed by hand has a later day at Cloudflare, and stays.
  const v = world();
  hold(v, { renews: 0, expires_at: until });
  canceled(v);
  v.reg.names[N].expires_at = iso(until + 365 * DAY);
  await timer(v, until + MIN);
  assert.equal((await one(v.env)).state, 'registered');
  assert.equal((await one(v.env)).expires_at, until + 365 * DAY);
});

// ─── Taking the name away ─────────────────────────────────────────────────────

test('leave before day 60: the request is noted, the operator is told at once and again on the first day the name may leave', { skip: d1Skip }, async () => {
  const w = world();
  const r = hold(w);
  const from = r.registered_at + 60 * DAY;
  const a = await leave(w, { id: 'site1' });
  assert.equal(a.status, 200);
  assert.deepEqual([a.json.ok, a.json.when, a.json.sentence], [true, 'later', SAYS.early(words(from))]);
  assert.deepEqual([a.json.registration.name, a.json.registration.leave_asked, a.json.registration.leave_from], [N, true, from]);
  const b = await leave(w, { id: 'site1' });
  assert.equal(b.json.sentence, SAYS.early(words(from)));
  assert.deepEqual(w.notes('wants to take it away'), [`The owner of ${N} wants to take it away`], 'a second press tells nobody again');
  await timer(w, NOW + DAY);
  assert.equal(w.notes('may leave').length, 0);
  await timer(w, from + MIN);
  await timer(w, from + 6 * MIN);
  assert.deepEqual(w.notes('may leave'), [`${N} may leave from today`]);
  assert.equal(w.reg.changes().length, 0);
});

test('leave after day 60: a person will write with a code, and there is no second note', { skip: d1Skip }, async () => {
  const w = world();
  hold(w, { registered_at: NOW - 70 * DAY, asked_at: NOW - 70 * DAY, created_at: NOW - 70 * DAY });
  const a = await leave(w, { name: N });
  assert.deepEqual([a.status, a.json.when, a.json.sentence], [200, 'now', SAYS.now(N)]);
  assert.equal(w.notes('wants to take it away').length, 1);
  await timer(w, NOW + DAY + MIN);
  assert.equal(w.notes('may leave').length, 0);
});

test('a registration whose site was removed is listed for its account and can still be asked for, and nobody else\'s can', { skip: d1Skip }, async () => {
  const w = world();
  const r = hold(w);
  hold(w, { id: 'reg-2', account_id: 'acct-2', site_id: 'site9', subscription_id: 'sub-9', name: 'oakbakery.com' });
  hold(w, { id: 'reg-3', state: 'failed', subscription_id: 'sub-0', name: 'elmbakery.com', ...waiting });
  w.env.kiln_cloud.exec("DELETE FROM sites WHERE id = 'site1'");
  assert.equal((await leave(w, {})).json.when, 'later', 'the account\'s one registered name, with no site to name');
  assert.equal((await leave(w, { name: N })).status, 200);
  const other = await leave(w, { name: 'oakbakery.com' });
  assert.deepEqual([other.status, other.json.code], [404, 'no_name']);
  assert.equal(w.notes('wants to take it away').length, 1);
  const list = await call(w, '/cloud/sites/newdomain');
  assert.deepEqual(list.json, { ok: true, holder: 'kiln', registrations: [
    { name: N, state: 'registered', site: null, runs_until: r.expires_at, renews: true, leave_from: r.registered_at + 60 * DAY, leave_asked: true },
  ] });
});

// ─── The operator's three actions ─────────────────────────────────────────────

test('the three admin actions and the list are refused for anyone but the operator', { skip: d1Skip }, async () => {
  const w = world({ admin: 'erikkwilder' });
  hold(w, { state: 'stuck', ...waiting });
  for (const what of ['registration/free', 'registration/registered', 'registration/handed']) {
    assert.equal((await admin(w, what, { id: 'reg-1', name: N })).status, 403, what);
  }
  assert.equal((await admin(w, 'registrations')).status, 403);
  assert.equal((await one(w.env)).state, 'stuck');
  assert.equal(w.reg.seen.length, 0);
});

test('"free this row" needs the name typed out, frees a stuck row so the customer may choose again, and is refused for a registered row', { skip: d1Skip }, async () => {
  const w = world();
  hold(w, { state: 'stuck', reason: 'Cloudflare says "action_required"', ...waiting });
  assert.deepEqual([(await admin(w, 'registration/free', { id: 'reg-1' })).status, (await admin(w, 'registration/free', { id: 'reg-1' })).json.code], [400, 'type_name']);
  assert.equal((await admin(w, 'registration/free', { id: 'reg-1', name: 'juniperhollow.com' })).json.code, 'type_name');
  assert.equal((await one(w.env)).state, 'stuck');
  const freed = await admin(w, 'registration/free', { id: 'reg-1', name: N });
  assert.deepEqual([freed.status, freed.json.registration.state, freed.json.customer_told], [200, 'failed', true]);
  assert.equal((await one(w.env)).state, 'failed');
  await timer(w);
  const mails = w.mails('could not be registered');
  assert.equal(mails.length, 1, 'the customer hears once');
  assert.ok(JSON.stringify(mails[0]).includes(SAYS.failed(N)));
  assert.equal((await call(w, '/cloud/sites/newdomain?site=site1')).json.offered, true, 'the right is free again');
  assert.equal((await admin(w, 'registrations')).json.registrations[0].state, 'failed');
  assert.equal(w.reg.seen.length, 0, 'freeing a row asks nothing of Cloudflare');

  const v = world();
  hold(v);
  const no = await admin(v, 'registration/free', { id: 'reg-1', name: N });
  assert.deepEqual([no.status, no.json.code], [409, 'not_free']);
  assert.equal((await one(v.env)).state, 'registered');

  const x = world();
  hold(x, { state: 'asking', asked_at: NOW - 5 * MIN, ...waiting });
  assert.equal((await admin(x, 'registration/free', { id: 'reg-1', name: N })).json.code, 'too_soon');
  x.env.kiln_cloud.exec('UPDATE registrations SET asked_at = ?', NOW - 20 * MIN);
  assert.equal((await admin(x, 'registration/free', { id: 'reg-1', name: N })).status, 200);
  assert.equal(v.reg.seen.length + x.reg.seen.length, 0);
});

test('"mark registered" takes a stuck row to registered and on to its site, and asks Cloudflare for nothing but looks', { skip: d1Skip }, async () => {
  const w = world();
  hold(w, { state: 'stuck', ...waiting });
  w.reg.names[N] = { auto_renew: true, expires_at: UNTIL };
  const done = await admin(w, 'registration/registered', { id: 'reg-1' });
  assert.deepEqual([done.status, done.json.registration.state, done.json.cloudflare, done.json.on_site], [200, 'registered', 'shown', true]);
  const row = await one(w.env);
  assert.deepEqual([row.state, row.expires_at, row.renews], ['registered', Date.parse(UNTIL), 1]);
  const [d] = await domains(w.env);
  assert.deepEqual([d.name, d.state, d.registered], [N, 'waiting', 1]);
  assert.equal(w.mails(`${N} is yours`).length, 1);
  assert.equal(w.reg.changes().length, 0);
  assert.ok(w.reg.reads().length >= 1);
  const again = await admin(w, 'registration/registered', { id: 'reg-1' });
  assert.deepEqual([again.status, again.json.code], [409, 'not_stuck']);
});

test('"handed over" takes a registered row to handed_over and forgets the domain row, and asks Cloudflare for nothing', { skip: d1Skip }, async () => {
  const w = world();
  hold(w);
  domainOn(w);
  const done = await admin(w, 'registration/handed', { id: 'reg-1' });
  assert.deepEqual([done.status, done.json.registration.state, done.json.domain_forgotten], [200, 'handed_over', true]);
  assert.ok((await one(w.env)).handed_at > 0);
  assert.equal((await domains(w.env)).length, 0);
  const again = await admin(w, 'registration/handed', { id: 'reg-1' });
  assert.deepEqual([again.status, again.json.code], [409, 'not_registered']);
  await timer(w, NOW + 400 * DAY);
  assert.equal(w.reg.seen.length, 0, 'a name that has left is never asked about again');
});

test('money: nothing this chunk added can reach the call that registers a name, and one line sends the change of renewal', () => {
  const dir = new URL('../worker/', import.meta.url);
  const source = readFileSync(new URL('register.js', dir), 'utf8');
  const body = (name) => {
    const from = source.indexOf(`function ${name}(`);
    assert.ok(from > 0, name);
    return source.slice(from, source.indexOf('\n}\n', from));
  };
  // Everything after the heading of this chunk's part, and each function by itself.
  const part = source.slice(source.indexOf('// ─── Renewal, ending and leaving'));
  assert.ok(part.length > 1000);
  for (const text of [part, ...['freeRow', 'markRegistered', 'handedOver', 'leaveName', 'sweepRenewals', 'renewalTo', 'readBack', 'setRenewal', 'through'].map(body)]) {
    assert.equal(/registerOnce\(|registerName\(|respond-async|method: 'POST'/.test(text), false);
  }
  // The operator's actions and the leave action send no change of any kind: they have no way to the one sender of a change.
  for (const name of ['freeRow', 'markRegistered', 'handedOver', 'leaveName']) assert.equal(/setRenewal\(|fetch\(/.test(body(name)), false, name);
  // One line in the service sends a change to a registration, it carries one field, and one line asks for it.
  assert.equal(source.split("method: 'PATCH'").length - 1, 1);
  assert.ok(body('setRenewal').includes("{ method: 'PATCH', path, json: { auto_renew: on } }"));
  const callers = source.split('\n').filter(l => /\bsetRenewal\(/.test(l) && !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.startsWith('export async function setRenewal('));
  assert.equal(callers.length, 1, callers.join('\n'));
  assert.ok(body('renewalTo').includes(callers[0].trim()));
  for (const f of ['cloud.js', 'index.js', 'mail.js', 'domain.js']) assert.equal(/setRenewal\(|registrar\/registrations/.test(readFileSync(new URL(f, dir), 'utf8')), false, f);
});

// ─── What the customer is written ─────────────────────────────────────────────

test('a customer hears by email, once each, that a registration failed and that one stopped part way', { skip: d1Skip }, async () => {
  const w = world();
  hold(w, { id: 'reg-f', state: 'failed', subscription_id: 'sub-0', name: 'oakbakery.com', ...waiting });
  hold(w, { id: 'reg-old', state: 'failed', subscription_id: 'sub-00', name: 'elmbakery.com', updated_at: NOW - 8 * DAY, ...waiting });
  hold(w, { id: 'reg-s', state: 'stuck', ...waiting });
  await timer(w);
  await timer(w);
  assert.deepEqual(w.mails().map(w.subject).sort(), ['oakbakery.com could not be registered', `Registering ${N} stopped part way`].sort());
  assert.ok(JSON.stringify(w.mails('could not')[0]).includes(SAYS.failed('oakbakery.com')));
  assert.ok(JSON.stringify(w.mails('stopped part way')[0]).includes(SAYS.stuck(N)));
  assert.ok(JSON.stringify(w.mails('stopped part way')[0]).includes('https://app.example'));
  assert.equal(w.reg.seen.length, 0);
});

test('the emails about a site that comes down, and the answer to Remove, say that the name stays registered only for a site with a registered name', { skip: d1Skip }, async () => {
  const until = Date.parse(UNTIL);
  const about = { origin: 'https://club.example', plan: 'managed', repo: 'ada/club', endsAt: NOW + 7 * DAY, dashboard: 'https://app.example', domain: N };
  for (const mail of [hostingEndingMail, editingStoppedMail]) {
    assert.ok(mail({ ...about, registered: { name: N, until } }).text.includes(SAYS.stays(N, words(until))));
    assert.equal(mail(about).text.includes('stays registered'), false);
  }
  const w = world();
  assert.equal(await registeredFor(w.env, 'site1'), null);
  const r = hold(w);
  assert.deepEqual(await registeredFor(w.env, 'site1'), { name: N, until: r.expires_at });
  const gone = await admin(w, 'remove', { site_id: 'site1', force: true });
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.json.registration, { name: N, runs_until: r.expires_at, note: SAYS.removed(N, words(r.expires_at)) });
  assert.equal((await one(w.env)).state, 'registered', 'the registration outlives its site');

  const v = world();
  const plain = await admin(v, 'remove', { site_id: 'site1', force: true });
  assert.deepEqual([plain.status, 'registration' in plain.json], [200, false]);
});

// ─── The switch, an older database, the stand-in ──────────────────────────────

test('with the switch off everything this chunk added answers as an unknown route does, and the timer does nothing', { skip: d1Skip }, async () => {
  const w = world({ on: false });
  hold(w);
  canceled(w);
  const unknown = await call(w, '/cloud/sites/nosuchthing', 'POST', { id: 'site1' });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await leave(w, { id: 'site1' }), unknown);
  assert.deepEqual(await call(w, '/cloud/sites/newdomain'), await call(w, '/cloud/sites/nosuchthing'));
  const noAdmin = await admin(w, 'nosuchthing', { id: 'reg-1' });
  assert.equal(noAdmin.status, 404);
  for (const what of ['registration/free', 'registration/registered', 'registration/handed']) assert.deepEqual(await admin(w, what, { id: 'reg-1', name: N }), noAdmin, what);
  assert.deepEqual(await admin(w, 'registrations'), await admin(w, 'nosuchthing'));
  assert.deepEqual(await timer(w), { told: 0, renewalOff: 0, renewalOn: 0, renewalFailed: 0, read: 0, reminded: 0, ranOut: 0, leaveNotes: 0 });
  await assert.rejects(setRenewal(w.env, N, false), { code: 'off' });
  assert.equal(await registeredFor(w.env, 'site1'), null);
  const gone = await admin(w, 'remove', { site_id: 'site1', force: true });
  assert.equal('registration' in gone.json, false);
  assert.deepEqual([(await one(w.env)).state, (await one(w.env)).renews, (await one(w.env)).leave_asked_at], ['registered', 1, null]);
  assert.equal(w.reg.seen.length, 0);
  assert.equal(w.sent.length, 0);
});

test('a database without migration 0016 does not break the five-minute job', { skip: d1Skip }, async () => {
  const before = schemaFiles().findIndex(f => f.endsWith('0016_registrations.sql'));
  assert.ok(before > 0);
  const w = world({ env: { d1: { upTo: before } } });
  assert.throws(() => w.env.kiln_cloud.row('SELECT id FROM registrations'));
  await withFetch(w.handler, async () => {
    assert.deepEqual(await sweepRenewals(w.env), { told: 0, renewalOff: 0, renewalOn: 0, renewalFailed: 0, read: 0, reminded: 0, ranOut: 0, leaveNotes: 0 });
    assert.equal((await ask(w.env, '/cloud/sites/newdomain', 'POST', { action: 'leave', id: 'site1' })).status, 404);
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, w.env, { waitUntil: () => {} });
  });
  assert.equal(w.reg.seen.length, 0);
});

test('with the stand-in on, a name beginning "norenew" refuses the change, any other takes it, and no call of any kind reaches Cloudflare', { skip: d1Skip }, async () => {
  const standIn = { REGISTER_STANDIN: 'on', HOSTING_PREFIX: 'stg-' };
  const w = world({ env: standIn });
  hold(w, { name: 'norenewbakery.com' });
  canceled(w);
  await timer(w);
  await timer(w);
  assert.deepEqual(w.notes('Switch renewal'), ['Switch renewal off by hand for norenewbakery.com']);
  assert.equal((await one(w.env)).renews, 1);

  const v = world({ env: standIn });
  hold(v, { name: 'oakbakery.com' });
  canceled(v);
  await timer(v);
  assert.equal((await one(v.env)).renews, 0);
  v.env.kiln_cloud.exec("UPDATE sites SET status = 'active' WHERE id = 'site1'");
  await timer(v);
  assert.equal((await one(v.env)).renews, 1);
  assert.equal(v.notes('Switch renewal').length, 0);
  assert.equal(w.reg.seen.length + v.reg.seen.length, 0);
});
