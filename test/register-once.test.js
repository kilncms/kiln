/**
 * A new domain through Kiln: the press that registers a name, once, and
 * what follows it (worker/register.js `registerOnce`, `registerName`,
 * `settle`, `ontoSite`, `sweepRegistrations`, and their routes and the
 * domain sweep's branches in worker/cloud.js).
 *
 * THE MONEY RULES, one test each. The stand-in for Cloudflare's registrar
 * below counts every call it receives, and `posts()` is the calls that
 * register a name:
 *   · two presses at once make one call
 *   · a press after a timeout makes none
 *   · the timer makes none
 *   · a second tab makes none
 *   · a row that is asking, stuck or registered can never lead to a call
 *   · in the whole service one line sends that call, and one line asks for it
 *
 * The answers to the registering call and to the reading of its state have
 * never been seen for real (no name has been registered): their shapes are
 * the ones in Cloudflare's guide. The real handlers run over the
 * SQLite-backed D1 stand-in. Nothing touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../worker/index.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip, schemaFiles } from './d1-fake.js';
import { fakeGitHub } from './github-fake.js';
import { fakeCloudflare } from './cloudflare-fake.js';
import { sweepDomains, sweepRegistrations } from '../worker/cloud.js';
import { registerOnce, settle, ontoSite, publicRegistration } from '../worker/register.js';

const N = 'juniperhollowpottery.com';
const MIN = 60e3, DAY = 86400e3;
const REG = 'https://api.cloudflare.com/client/v4/accounts/acct-hosting/registrar';
const WORKER = 'club-site1';
const OPS = 'ops@example.com';
const AT = '2026-11-13T10:00:00Z', UNTIL = '2027-11-13T10:00:00Z';

const SAYS = {
  being: (n) => `${n} is being registered for this site right now. Wait for it to finish.`,
  stuck: (n) => `Registering ${n} stopped part way and a person at Kiln has been told. You do not need to do anything. We will email you within one working day.`,
  failed: (n) => `${n} could not be registered. Nothing was charged and your plan still includes a domain. Choose a name and try again.`,
  taken: (n) => `Someone registered ${n} a moment ago. Nothing was registered for you. Choose another name.`,
  price: 'The price of this name just went up and your plan no longer covers it. Nothing was registered for you. Choose another name.',
  notPaid: 'A domain is included once a year of Kiln Cloud + hosting is paid. Pay for the year from this site\'s row, then choose your name.',
  daily: 'Kiln has registered as many names as it can today. Nothing was registered for you. Come back tomorrow and choose the name again.',
  account: 'Your account already got a domain through Kiln in the last 12 months. Email info@kilncms.com if you need another.',
  has: (n) => `Your plan already has its domain, ${n}. A yearly plan includes one.`,
};

const envelope = (result, errors = []) => ({ success: errors.length === 0, errors, messages: [], result });
const free = (name, cost = '11.17') => ({ name, registrable: true, tier: 'standard', pricing: { currency: 'USD', registration_cost: cost, renewal_cost: cost } });
const accepted = (b) => jsonRes(envelope({ domain_name: b.domain_name, state: 'in_progress', completed: false, created_at: AT, updated_at: AT }), 202);

/**
 * Cloudflare's registrar, counting every call. `lines[name]` is what the price
 * check says of a name (free at $11.17 when nothing is set), `post` answers
 * the registering call (202 "in_progress" when nothing is set), and
 * `status[name]` is how the registration stands: a state of the guide's, or
 * "down" for a 500. A name with no state gets Cloudflare's 404 "No workflow found".
 */
function fakeRegistrar() {
  const seen = [];
  const reg = {
    seen, lines: {}, status: {}, post: accepted,
    posts: () => seen.filter(c => c.method === 'POST' && c.path === '/registrations'),
    looks: () => seen.filter(c => c.path.endsWith('/registration-status')),
  };
  reg.handler = async (url, init = {}) => {
    if (!url.startsWith(REG)) return undefined;
    const method = (init.method || 'GET').toUpperCase(), path = url.slice(REG.length);
    const body = init.body ? JSON.parse(init.body) : null;
    seen.push({ method, path, body, prefer: (init.headers && init.headers.Prefer) || null });
    if (method === 'POST' && path === '/domain-check') return jsonRes(envelope({ domains: body.domains.map(n => (reg.lines[n] === undefined ? free(n) : reg.lines[n])).filter(Boolean) }));
    if (method === 'POST' && path === '/registrations') return reg.post(body);
    const m = /^\/registrations\/([^/]+)\/registration-status$/.exec(path);
    if (method === 'GET' && m) {
      const name = decodeURIComponent(m[1]), state = reg.status[name];
      if (!state) return jsonRes(envelope(null, [{ code: 10000, message: `No workflow found for ${name}` }]), 404);
      if (state === 'down') return jsonRes(envelope(null, [{ code: 10000, message: 'Internal error' }]), 500);
      return jsonRes(envelope({
        domain_name: name, state, completed: state === 'succeeded' || state === 'failed', created_at: AT, updated_at: AT,
        ...(state === 'succeeded' ? { context: { registration: { domain_name: name, status: 'active', created_at: AT, expires_at: UNTIL, auto_renew: true, privacy_mode: 'redaction', locked: true } } } : {}),
        ...(state === 'failed' ? { error: { code: 'registry_rejected', message: 'The registry turned the name down.' } } : {}),
      }));
    }
    return jsonRes(envelope(null, [{ code: 10000, message: 'No route for that URI' }]), 404);
  };
  return reg;
}

/** One account with one site on the hosting plan: paid for a year, active, up on Kiln's hosting, with no domain. */
function world({ on = true, site = {}, env: extra = {} } = {}) {
  const gh = fakeGitHub({ repo: 'ada/club', files: { 'index.html': '<!doctype html><h1>Home</h1>' } });
  const cf = fakeCloudflare();
  const reg = fakeRegistrar();
  const sent = [];
  const env = cloudEnv(fakeKV({ 'itok:ada/club': 'inst-token' }), {
    HOSTING_ACCOUNT_ID: cf.account, HOSTING_API_TOKEN: cf.token, HOSTING_SUBDOMAIN: 'kiln-sites', CLOUD_DASHBOARD: 'https://app.example',
    LS_VARIANT_MANAGED: '22', LS_VARIANT_MANAGED_YEARLY: '33',
    NOTIFY: { send: async (m) => { sent.push(m); return { messageId: '<1@kilncms.com>' }; } }, NOTIFY_TO: OPS, CUSTOMER_MAIL_FROM: 'hello@kilncms.com',
    ...(on ? { REGISTER_DOMAINS: 'on' } : {}),
    ...extra,
  });
  const s = { billing_period: 'year', paid_until: Date.now() + 300 * DAY, status: 'active', ls_subscription_id: 'sub-1', plan: 'managed', ...site };
  addSite(env, { id: 'site1', plan: s.plan, status: s.status, ls_subscription_id: s.ls_subscription_id });
  try { env.kiln_cloud.exec('UPDATE sites SET billing_period = ?, paid_until = ? WHERE id = ?', s.billing_period, s.paid_until, 'site1'); } catch { /* a database without migration 0016 */ }
  cf.addScript(WORKER);
  env.kiln_cloud.exec('INSERT INTO hosting (site_id, name, url, state, deployed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', 'site1', WORKER, `https://${WORKER}.kiln-sites.workers.dev`, 'live', 1, 1, 1);
  const handler = async (url, init) => (await reg.handler(url, init)) || (await cf.handler(url, init)) || gh.handler(url, init);
  const subject = (m) => String(m.subject || (/^Subject: (.*)$/m.exec(String(m.raw || '')) || [])[1] || '').trim();
  return {
    env, handler, reg, cf, sent,
    notes: (about = '') => sent.filter(m => m.raw && subject(m).includes(about)).map(subject),   // to the operator
    mails: () => sent.filter(m => !m.raw),                                                       // to the customer
  };
}
const ask = (env, pathname, method = 'GET', body) => worker.fetch(new Request(`https://worker.example${pathname}`, {
  method, headers: { Authorization: 'Bearer tok', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}), env);
const post = async (env, name, more = {}) => {
  const r = await ask(env, '/cloud/sites/newdomain', 'POST', { id: 'site1', action: 'register', name, checked: true, ...more });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, json: { text } }; }   // an unknown route answers in plain words
};
const press = (w, name, more) => withFetch(w.handler, () => post(w.env, name, more));
const state = (w) => withFetch(w.handler, async () => (await ask(w.env, '/cloud/sites/newdomain?site=site1')).json());
const timer = (w, now) => withFetch(w.handler, () => sweepRegistrations(w.env, now ? { now } : {}));
const all = async (env, sql, ...args) => (await env.kiln_cloud.prepare(sql).bind(...args).all()).results || [];
const regs = (env) => all(env, 'SELECT * FROM registrations ORDER BY created_at, id');
// The ten seconds between two looks from the state route, passed.
const later = (env) => env.kiln_cloud.exec('UPDATE registrations SET checked_at = checked_at - 11000');
const had = (env, over = {}) => {
  const r = { id: 'reg-1', site_id: 'site1', account_id: 'acct-1', subscription_id: 'sub-1', name: 'oakbakery.com', state: 'registered', registered_at: Date.now() - 10 * DAY, created_at: Date.now() - 10 * DAY, ...over };
  env.kiln_cloud.exec('INSERT INTO registrations (id, site_id, account_id, subscription_id, name, state, registered_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    r.id, r.site_id, r.account_id, r.subscription_id, r.name, r.state, r.registered_at, r.created_at, r.created_at);
};
const fresh = (over = {}) => ({ id: `try-${Math.random().toString(36).slice(2)}`, site_id: 'site1', account_id: 'acct-1', subscription_id: 'sub-1', name: N, price_first: 1117, price_renew: 1117, ...over });
/** Every line the service logs while `fn` runs. */
async function logged(fn) {
  const lines = [], log = console.log, warn = console.warn;
  console.log = (...a) => lines.push(a.join(' ')); console.warn = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.log = log; console.warn = warn; }
  return lines;
}

// ─── The money rules ──────────────────────────────────────────────────────────

test('money: two presses at once make one registration call', { skip: d1Skip }, async () => {
  const w = world();
  const both = await withFetch(w.handler, () => Promise.all([post(w.env, N), post(w.env, N)]));
  assert.equal(w.reg.posts().length, 1);
  assert.deepEqual(both.map(b => b.status).sort(), [200, 409]);
  assert.ok(['busy', 'being_registered'].includes(both.find(b => b.status === 409).json.code));
  assert.equal((await regs(w.env)).length, 1);
  // The call itself: one year, renewing, private, answered at once, and no contact (Kiln's company holds the name).
  assert.deepEqual(w.reg.posts()[0].body, { domain_name: N, years: 1, auto_renew: true, privacy_mode: 'redaction' });
  assert.equal(w.reg.posts()[0].prefer, 'respond-async');

  // Without the courtesy lock in front: the insert alone decides, for one site and for two customers after one name.
  const v = world();
  const tries = await withFetch(v.handler, () => Promise.all([registerOnce(v.env, fresh()), registerOnce(v.env, fresh()), registerOnce(v.env, fresh({ name: 'othername.com' })),
    registerOnce(v.env, fresh({ site_id: 'site9', account_id: 'acct-9', subscription_id: 'sub-9' }))]));
  assert.equal(tries.filter(t => t.won).length, 1);
  assert.equal(v.reg.posts().length, 1);
  assert.equal((await regs(v.env)).length, 1);
});

test('money: a press after a timeout or an error makes no second call, and neither does the look', { skip: d1Skip }, async () => {
  for (const silent of [() => { throw new Error('The operation was aborted due to timeout'); }, () => jsonRes(envelope(null, [{ code: 10000, message: 'Internal error' }]), 500), () => new Response('<html>bad gateway</html>', { status: 502 })]) {
    const w = world();
    w.reg.post = silent;
    const first = await press(w, N);
    // Kiln does not know whether Cloudflare began. The customer waits, and the row stays as it is.
    assert.equal(first.status, 200);
    assert.equal(first.json.registration.state, 'asking');
    assert.equal(w.reg.posts().length, 1);
    for (const name of [N, 'othername.com']) {
      const again = await press(w, name);
      assert.deepEqual([again.status, again.json.code, again.json.error], [409, 'being_registered', SAYS.being(N)]);
    }
    assert.equal((await state(w)).registration.state, 'asking');
    await timer(w);
    const [row] = await regs(w.env);
    assert.equal(row.state, 'asking');
    assert.equal(w.reg.posts().length, 1, 'nothing is sent again, ever');
    assert.equal(w.reg.looks().length >= 1, true);
  }
});

test('money: the timer makes no registration call, whatever rows it finds', { skip: d1Skip }, async () => {
  const w = world();
  had(w.env, { id: 'a', state: 'asking', name: 'asking-one.com' });
  had(w.env, { id: 'b', state: 'stuck', name: 'stuck-one.com', site_id: 'site2', subscription_id: 'sub-2' });
  had(w.env, { id: 'c', state: 'registered', name: 'registered-one.com', site_id: 'site3', subscription_id: 'sub-3' });
  had(w.env, { id: 'd', state: 'failed', name: 'failed-one.com', site_id: 'site4', subscription_id: 'sub-4' });
  for (const now of [undefined, Date.now() + 20 * MIN, Date.now() + 2 * DAY]) await timer(w, now);
  assert.equal(w.reg.posts().length, 0);
  assert.equal(w.reg.seen.every(c => c.method === 'GET' && c.path.endsWith('/registration-status')), true, 'the timer only reads');
});

test('money: a second tab makes no call and is answered with the row that stands', { skip: d1Skip }, async () => {
  const w = world();
  assert.equal((await press(w, N)).status, 200);
  for (const name of [N, 'othername.com', 'third.org']) {
    const tab = await press(w, name);
    assert.deepEqual([tab.status, tab.json.code, tab.json.error], [409, 'being_registered', SAYS.being(N)]);
    assert.deepEqual([tab.json.registration.name, tab.json.registration.state], [N, 'asking']);
  }
  assert.equal(w.reg.posts().length, 1);
  assert.equal((await regs(w.env)).length, 1);
});

test('money: a row that is asking, stuck or registered can never lead to a call', { skip: d1Skip }, async () => {
  for (const st of ['asking', 'stuck', 'registered']) {
    const w = world();
    had(w.env, { state: st });
    const want = { asking: ['being_registered', SAYS.being('oakbakery.com')], stuck: ['stuck', SAYS.stuck('oakbakery.com')], registered: ['has_name', SAYS.has('oakbakery.com')] }[st];
    for (const name of ['oakbakery.com', N]) {
      const r = await press(w, name);
      assert.deepEqual([r.status, r.json.code, r.json.error], [409, ...want], st);
    }
    await withFetch(w.handler, async () => {
      // The sending function by itself, handed the same name and another one: its insert changes nothing, so it sends nothing.
      for (const row of [fresh({ name: 'oakbakery.com' }), fresh(), fresh({ site_id: 'site9', account_id: 'acct-9', subscription_id: 'sub-9', name: 'oakbakery.com' })]) {
        assert.deepEqual(await registerOnce(w.env, row), { won: false }, st);
      }
      const [row] = await regs(w.env);
      await settle(w.env, row, { now: Date.now() + DAY, every: 0 });
      await ontoSite(w.env, row, { up: () => true });
    });
    await state(w);
    await timer(w, Date.now() + DAY);
    assert.equal(w.reg.posts().length, 0, st);
    assert.equal((await regs(w.env)).length, 1, st);
  }
});

test('money: in the whole service one line sends the registering call and one line asks for it', () => {
  const dir = new URL('../worker/', import.meta.url);
  let sends = 0, asyncs = 0;
  const callers = [];
  for (const f of readdirSync(dir).filter(n => n.endsWith('.js'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    sends += src.split('/registrar/registrations`').length - 1;
    asyncs += src.split('respond-async').length - 1;
    src.split('\n').forEach((line, i) => {
      const t = line.trim();
      if (/\bregisterOnce\(/.test(t) && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('export async function registerOnce(')) callers.push(`${f}:${i + 1}`);
    });
  }
  assert.equal(sends, 1);
  assert.equal(asyncs, 1);
  assert.equal(callers.length, 1, callers.join(', '));
  assert.match(callers[0], /^register\.js:\d+$/);
  // The door for looking has no call that changes anything about a registration.
  const source = readFileSync(new URL('register.js', dir), 'utf8');
  assert.equal(/method: '(POST|PUT|PATCH|DELETE)', path: [`'"]\/registrations/.test(source), false);
});

// ─── The switch ───────────────────────────────────────────────────────────────

test('with the switch off the press answers as an unknown route does, and the sending function refuses by itself', { skip: d1Skip }, async () => {
  const w = world({ on: false });
  await withFetch(w.handler, async () => {
    const unknown = await ask(w.env, '/cloud/sites/nosuchthing', 'POST', { id: 'site1' });
    const r = await ask(w.env, '/cloud/sites/newdomain', 'POST', { id: 'site1', action: 'register', name: N, checked: true });
    assert.equal(r.status, 404);
    assert.equal(await r.text(), await unknown.text());
    await assert.rejects(registerOnce(w.env, fresh()), { code: 'off' });
    // A wrong holder, and a stand-in asked for where it is refused, keep it off as well.
    await assert.rejects(registerOnce({ ...w.env, REGISTER_DOMAINS: 'on', REGISTER_HOLDER: 'customer' }, fresh()), { code: 'off' });
    await assert.rejects(registerOnce({ ...w.env, REGISTER_DOMAINS: 'on', REGISTER_STANDIN: 'on' }, fresh()), { code: 'off' });
    had(w.env, { state: 'asking' });
    const [row] = await regs(w.env);
    assert.equal((await settle(w.env, row, { every: 0 })).state, 'asking');
    assert.deepEqual(await sweepRegistrations(w.env), { looked: 0, registered: 0, failed: 0, stuck: 0, onSite: 0, late: 0 });
  });
  assert.equal(w.reg.seen.length, 0);
  assert.equal((await regs(w.env)).length, 1);
});

test('a name that cannot be asked for and a box that is not ticked are refused before any call', { skip: d1Skip }, async () => {
  const w = world();
  assert.deepEqual(await press(w, N, { checked: false }), { status: 400, json: { error: 'Tick the box to say you checked the spelling, then press Register again.', code: 'tick_first' } });
  assert.deepEqual((await press(w, N, { checked: 'yes' })).json.code, 'tick_first');
  assert.deepEqual(await press(w, 'juniperhollowpottery.info'), { status: 400, json: { error: 'Kiln cannot get names with this ending.', code: 'ending' } });
  for (const bad of ['', 'juniper hollow.com', 'jüniper.com', 'xn--jniper-3ya.com', 'www.juniper.com.']) assert.equal((await press(w, bad)).json.code, 'letters_only', bad);
  await assert.rejects(registerOnce(w.env, fresh({ name: 'juniper.info' })), { code: 'not_a_name' });
  assert.equal(w.reg.seen.length, 0);
  assert.equal((await regs(w.env)).length, 0);
});

// ─── What follows the press ───────────────────────────────────────────────────

test('202 and then "succeeded": the name is on the site as a waiting domain marked registered, with one email', { skip: d1Skip }, async () => {
  const w = world();
  let seen;
  const lines = await logged(async () => {
    const p = await press(w, N);
    assert.equal(p.status, 200);
    assert.deepEqual(Object.keys(p.json.registration), ['name', 'state', 'since']);
    assert.deepEqual([p.json.ok, p.json.registration.name, p.json.registration.state], [true, N, 'asking']);
    w.reg.status[N] = 'in_progress';
    assert.deepEqual((await state(w)).registration.state, 'asking');
    // The state route looks at most every ten seconds, however often it is asked.
    await state(w); await state(w);
    assert.equal(w.reg.looks().length, 1);
    w.reg.status[N] = 'succeeded';
    later(w.env);
    seen = await state(w);
  });
  const at = Date.parse(AT);
  assert.deepEqual(seen, {
    ok: true, offered: false, holder: 'kiln',
    registration: { name: N, state: 'registered', registered_at: at, runs_until: Date.parse(UNTIL), renews: true, leave_from: at + 60 * DAY, leave_asked: false },
    domain: { name: N, state: 'waiting', registered: true },
  });
  const [d] = await all(w.env, 'SELECT * FROM domains');
  assert.deepEqual([d.site_id, d.name, d.state, d.registered, d.zone_id], ['site1', N, 'waiting', 1, w.cf.zoneOf(N).id]);
  assert.equal(w.cf.zones.size, 1);
  assert.equal((await regs(w.env))[0].zone_id, d.zone_id);
  // One email to the customer, in the design's words, and one note to the operator with both prices.
  assert.equal(w.mails().length, 1);
  const mail = w.mails()[0];
  assert.equal(mail.subject, `${N} is yours`);
  assert.equal(mail.to, 'ada@example.com');
  for (const said of [`${N} is yours. Kiln is putting your site on it now. That usually takes a few minutes and sometimes up to an hour. You will get an email when it is live.`,
    'Registered through Kiln until November 13, 2027. It renews by itself while your yearly plan is paid.',
    'The name is registered to Wilder Idea LLC, the company behind Kiln, for you to use.']) assert.ok(mail.text.includes(said), said);
  assert.deepEqual(w.notes('Kiln registered'), [`Kiln registered ${N}`]);
  const note = w.sent.find(m => m.raw && m.raw.includes('Kiln registered')).raw;
  for (const said of ['First year: $11.17. Each year after that: $11.17.', 'Runs until: November 13, 2027', 'Site: ada/club (site1)', 'Registrations written in the last 24 hours: 1. The limit (REGISTER_DAILY_MAX) is 3.']) assert.ok(note.includes(said), said);

  // Asked again, looked at again, swept again: nothing is sent twice and nothing is registered twice.
  await state(w); await timer(w); await timer(w, Date.now() + 10 * MIN);
  assert.equal(w.mails().length, 1);
  assert.equal(w.notes('Kiln registered').length, 1);
  assert.equal(w.reg.posts().length, 1);
  assert.equal(w.cf.zones.size, 1);

  // The dashboard is told the domain is a registered one (no name servers to enter, never put away for waiting), and the site's row says so.
  await withFetch(w.handler, async () => {
    const dom = (await (await ask(w.env, '/cloud/sites/domain?site=site1')).json()).domain;
    assert.deepEqual([dom.name, dom.state, dom.registered, dom.gives_up_at], [N, 'waiting', true, null]);
    const me = await (await ask(w.env, '/cloud/me')).json();
    assert.deepEqual([me.sites[0].new_domain.offered, me.sites[0].new_domain.registration.state, me.sites[0].domain.registered], [false, 'registered', true]);
  });

  // The log: asked before answered, then registered, then on the site. Never an address and never a token.
  const evts = lines.map(l => { try { return JSON.parse(l).evt; } catch { return null; } }).filter(Boolean);
  const order = ['register_asked', 'register_answered', 'registered', 'register_on_site'].map(e => evts.indexOf(e));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(order.includes(-1), false, evts.join(' '));
  const asked = JSON.parse(lines.find(l => l.includes('"register_asked"')));
  assert.deepEqual(asked, { evt: 'register_asked', site: 'site1', name: N, subscription: 'sub-1', first: 1117, renew: 1117, holder: 'kiln' });
  assert.equal(/ada@example\.com|cf-token|inst-token|Bearer/.test(lines.join('\n')), false);
});

test('a zone Cloudflare made by itself for the registered name is taken up, and no second one is made', { skip: d1Skip }, async () => {
  const w = world();
  await press(w, N);
  await w.cf.handler('https://api.cloudflare.com/client/v4/zones', { method: 'POST', headers: { Authorization: `Bearer ${w.cf.token}` }, body: JSON.stringify({ name: N, account: { id: w.cf.account }, type: 'full' }) });
  const zone = w.cf.zoneOf(N).id;
  w.reg.status[N] = 'succeeded';
  assert.equal((await state(w)).domain.state, 'waiting');
  assert.equal(w.cf.zones.size, 1);
  assert.equal((await all(w.env, 'SELECT zone_id FROM domains'))[0].zone_id, zone);
});

test('a site that cannot take the name yet keeps it registered, and the timer puts it on the site later', { skip: d1Skip }, async () => {
  const w = world();
  await press(w, N);
  w.env.kiln_cloud.exec("UPDATE hosting SET state = 'ended' WHERE site_id = 'site1'");
  w.reg.status[N] = 'succeeded';
  assert.equal((await state(w)).registration.state, 'registered');
  assert.equal((await all(w.env, 'SELECT * FROM domains')).length, 0);
  assert.equal(w.mails().length, 1);
  // An hour on, still not there: the operator is told, once.
  await timer(w, Date.parse(AT) + 30 * MIN);
  const hourOn = Math.max(Date.now(), Date.parse(AT)) + 2 * 3600e3;
  await timer(w, hourOn); await timer(w, hourOn + 5 * MIN);
  assert.deepEqual(w.notes('still not on its site'), [`${N} is registered and still not on its site after an hour`]);
  w.env.kiln_cloud.exec("UPDATE hosting SET state = 'live' WHERE site_id = 'site1'");
  assert.equal((await timer(w, hourOn + 10 * MIN)).onSite, 1);
  const [d] = await all(w.env, 'SELECT * FROM domains');
  assert.deepEqual([d.name, d.state, d.registered], [N, 'waiting', 1]);
  assert.equal(w.reg.posts().length, 1);
});

test('"failed" frees the right, and a second name can then be registered with exactly one more call', { skip: d1Skip }, async () => {
  const w = world();
  await press(w, N);
  w.reg.status[N] = 'failed';
  const seen = await state(w);
  assert.deepEqual(seen, { ok: true, offered: true, holder: 'kiln', registration: { name: N, state: 'failed', sentence: SAYS.failed(N) } });
  const [row] = await regs(w.env);
  assert.deepEqual([row.state, row.reason], ['failed', 'registry_rejected The registry turned the name down.']);
  assert.deepEqual(w.notes('could not register'), [`Kiln could not register ${N}`]);
  assert.ok(w.sent.find(m => m.raw && m.raw.includes('could not register')).raw.includes('Cloudflare\'s reason: registry_rejected The registry turned the name down.'));
  assert.equal(w.mails().length, 0);
  assert.equal(w.reg.posts().length, 1);

  const second = await press(w, 'secondchoice.org');
  assert.deepEqual([second.status, second.json.registration.name, second.json.registration.state], [200, 'secondchoice.org', 'asking']);
  assert.equal(w.reg.posts().length, 2);
  assert.deepEqual((await regs(w.env)).map(r => r.state).sort(), ['asking', 'failed']);
  assert.equal((await press(w, 'thirdchoice.org')).status, 409);
  assert.equal(w.reg.posts().length, 2);
});

test('a refusal from Cloudflare itself frees the right only when it says nothing was started', { skip: d1Skip }, async () => {
  const refusal = () => jsonRes(envelope(null, [{ code: 10000, message: 'domain_name is not available for registration' }]), 400);
  const w = world();
  w.reg.post = refusal;
  const r = await press(w, N);
  assert.deepEqual(r, { status: 502, json: { error: SAYS.failed(N), code: 'failed' } });
  assert.equal(w.reg.looks().length, 1);
  assert.deepEqual((await regs(w.env)).map(x => [x.state, x.reason]), [['failed', '400 10000 domain_name is not available for registration']]);
  assert.equal(w.notes('could not register').length, 1);
  w.reg.post = accepted;
  assert.equal((await press(w, N)).status, 200);
  assert.equal(w.reg.posts().length, 2);

  // Refused, and yet Cloudflare knows of a registration under way, or cannot say: the row stands and nothing is freed.
  for (const stands of ['in_progress', 'down']) {
    const v = world();
    v.reg.post = refusal;
    v.reg.status[N] = stands;
    const kept = await press(v, N);
    assert.deepEqual([kept.status, kept.json.registration.state], [200, 'asking'], stands);
    assert.equal((await press(v, 'othername.com')).json.code, 'being_registered');
    assert.equal(v.reg.posts().length, 1);
  }
});

test('fifteen minutes without a word from Cloudflare ends "stuck", with one note to the operator and no call', { skip: d1Skip }, async () => {
  for (const silence of [undefined, 'down']) {
    const w = world();
    w.reg.post = () => { throw new Error('The operation was aborted due to timeout'); };
    if (silence) w.reg.status[N] = silence;
    await press(w, N);
    const t0 = Date.now();
    assert.deepEqual([(await timer(w, t0 + 5 * MIN)).stuck, (await timer(w, t0 + 14 * MIN)).stuck], [0, 0]);
    assert.equal((await regs(w.env))[0].state, 'asking');
    assert.equal(w.notes().length, 0);
    assert.equal((await timer(w, t0 + 16 * MIN)).stuck, 1);
    await timer(w, t0 + 21 * MIN); await timer(w, t0 + DAY);
    assert.equal((await regs(w.env))[0].state, 'stuck');
    assert.deepEqual(w.notes(), [`A person must look: registering ${N} stopped part way`]);
    assert.deepEqual((await state(w)).registration.sentence, SAYS.stuck(N));
    const again = await press(w, 'othername.com');
    assert.deepEqual([again.status, again.json.code, again.json.error], [409, 'stuck', SAYS.stuck(N)]);
    assert.equal(w.reg.posts().length, 1);
    assert.equal(w.mails().length, 0);
  }
  // Cloudflare's own "action_required" and "blocked" need a person at once.
  for (const word of ['action_required', 'blocked']) {
    const w = world();
    await press(w, N);
    w.reg.status[N] = word;
    assert.equal((await state(w)).registration.state, 'stuck');
    assert.equal(w.notes('A person must look').length, 1);
    assert.equal(w.reg.posts().length, 1);
  }
});

// ─── Refusals ─────────────────────────────────────────────────────────────────

test('a name taken between the search and the press is refused, and nothing is written or sent', { skip: d1Skip }, async () => {
  const w = world();
  w.reg.lines[N] = { name: N, registrable: false, tier: 'standard', reason: 'domain_unavailable' };
  assert.deepEqual(await press(w, N), { status: 409, json: { error: SAYS.taken(N), code: 'taken' } });
  assert.equal(w.reg.posts().length, 0);
  assert.equal((await regs(w.env)).length, 0);
  // Another customer's row for the name does the same, whatever the price check says.
  const v = world();
  had(v.env, { id: 'theirs', site_id: 'site9', account_id: 'acct-9', subscription_id: 'sub-9', name: N, state: 'asking' });
  assert.deepEqual(await press(v, N), { status: 409, json: { error: SAYS.taken(N), code: 'taken' } });
  assert.equal(v.reg.posts().length, 0);
});

test('a price that moved over the limit between the search and the press is refused', { skip: d1Skip }, async () => {
  for (const line of [free(N, '15.01'), { ...free(N), pricing: { currency: 'USD', registration_cost: '9.00', renewal_cost: '27.70' } }, { name: N, registrable: false, tier: 'premium', reason: 'domain_premium' }]) {
    const w = world();
    w.reg.lines[N] = line;
    assert.deepEqual(await press(w, N), { status: 409, json: { error: SAYS.price, code: 'price_moved' } });
    assert.equal(w.reg.posts().length, 0);
    assert.equal((await regs(w.env)).length, 0);
  }
  // A check that cannot be read registers nothing either.
  const w = world();
  w.reg.lines[N] = null;
  assert.equal((await press(w, N)).json.code, 'not_checked');
  assert.equal(w.reg.posts().length, 0);
});

test('a year that is not paid is refused before anything is asked of Cloudflare', { skip: d1Skip }, async () => {
  for (const site of [{ paid_until: Date.now() - DAY }, { billing_period: 'month' }, { status: 'cancelled' }, { status: 'past_due' }, { plan: 'cloud' }, { paid_until: null }]) {
    const w = world({ site });
    assert.deepEqual(await press(w, N), { status: 403, json: { error: SAYS.notPaid, code: 'not_paid' } }, JSON.stringify(site));
    assert.equal(w.reg.seen.length, 0);
    assert.equal((await regs(w.env)).length, 0);
  }
});

test('the daily limit refuses the press and tells the operator once', { skip: d1Skip }, async () => {
  const w = world({ env: { REGISTER_DAILY_MAX: '1' } });
  // One row today, of another customer, and it failed: failed ones are counted too.
  had(w.env, { id: 'today', site_id: 'site9', account_id: 'acct-9', subscription_id: 'sub-9', name: 'elsewhere.com', state: 'failed', created_at: Date.now() - 3600e3 });
  for (let i = 0; i < 3; i++) assert.deepEqual(await press(w, N), { status: 429, json: { error: SAYS.daily, code: 'daily_limit' } });
  assert.deepEqual(w.notes('limit'), ['Kiln has reached its limit of new domains for today']);
  // The sending function keeps the limit by itself, in the statement that writes the row.
  await withFetch(w.handler, async () => assert.deepEqual(await registerOnce(w.env, fresh()), { won: false }));
  assert.equal(w.reg.seen.length, 0);
  assert.equal((await regs(w.env)).length, 1);
  // A day later the count is over.
  w.env.kiln_cloud.exec('UPDATE registrations SET created_at = created_at - ?', 2 * DAY);
  assert.equal((await press(w, N)).status, 200);
  assert.equal(w.reg.posts().length, 1);
});

test('an account gets one name in 12 months', { skip: d1Skip }, async () => {
  const w = world();
  had(w.env, { site_id: 'gone', subscription_id: 'sub-0', state: 'handed_over', registered_at: Date.now() - 100 * DAY });
  assert.deepEqual(await press(w, N), { status: 409, json: { error: SAYS.account, code: 'account_had' } });
  assert.equal(w.reg.seen.length, 0);
  const v = world();
  had(v.env, { site_id: 'gone', subscription_id: 'sub-0', state: 'handed_over', registered_at: Date.now() - 400 * DAY, created_at: Date.now() - 400 * DAY });
  assert.equal((await press(v, N)).status, 200);
});

// ─── The domain sweep, and an older database ──────────────────────────────────

test('a registered name that waits is not reminded and not put away by the domain sweep: the operator is told after an hour, once', { skip: d1Skip }, async () => {
  const w = world();
  await press(w, N);
  w.reg.status[N] = 'succeeded';
  await state(w);
  const began = (await all(w.env, 'SELECT created_at FROM domains'))[0].created_at;
  const sweep = (after) => withFetch(w.handler, () => sweepDomains(w.env, { now: began + after }));
  await sweep(30 * MIN);
  assert.equal(w.notes('still not live').length, 0);
  let tally = { reminded: 0, putAway: 0 };
  for (const after of [2 * 3600e3, 3 * 3600e3, 4 * DAY, 8 * DAY, 26 * DAY, 60 * DAY]) { const out = await sweep(after); tally = { reminded: tally.reminded + out.reminded, putAway: tally.putAway + out.putAway }; }
  assert.deepEqual(tally, { reminded: 0, putAway: 0 });
  assert.deepEqual(w.notes('still not live'), [`${N} is registered and still not live after an hour`]);
  const [d] = await all(w.env, 'SELECT * FROM domains');
  assert.deepEqual([d.state, d.registered, d.reason], ['waiting', 1, null]);
  assert.equal(w.cf.zones.size, 1, 'the zone is not removed');
  assert.deepEqual(w.mails().map(m => m.subject), [`${N} is yours`]);
});

test('a database without migration 0016 does not break the five-minute job', { skip: d1Skip }, async () => {
  const before = schemaFiles().findIndex(f => f.endsWith('0016_registrations.sql'));
  assert.ok(before > 0);
  const w = world({ env: { d1: { upTo: before } } });
  assert.throws(() => w.env.kiln_cloud.row('SELECT id FROM registrations'));
  await withFetch(w.handler, async () => {
    assert.deepEqual(await sweepRegistrations(w.env), { looked: 0, registered: 0, failed: 0, stuck: 0, onSite: 0, late: 0 });
    assert.equal((await sweepDomains(w.env)).failed, 0);
    assert.equal((await post(w.env, N)).status, 404);
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, w.env, { waitUntil: () => {} });
  });
  assert.equal(w.reg.seen.length, 0);
});

// ─── The stand-in for the test service ────────────────────────────────────────

test('with the stand-in on no call of any kind reaches Cloudflare\'s registrar, names behave as their first letters say, and it stops at registered', { skip: d1Skip }, async () => {
  const standin = () => world({ env: { REGISTER_STANDIN: 'on', HOSTING_PREFIX: 'stg-' } });
  const run = async (name) => { const w = standin(name); const p = await press(w, name); const s = p.status === 200 ? await state(w) : null; return { w, p, s }; };

  const fine = await run('finename.com');
  assert.equal(fine.p.status, 200);
  assert.equal(fine.s.registration.state, 'registered');
  assert.equal('domain' in fine.s, false);
  await timer(fine.w, Date.now() + 3 * 3600e3);
  assert.equal((await all(fine.w.env, 'SELECT * FROM domains')).length, 0, 'the stand-in stops at registered');
  assert.equal(fine.w.cf.zones.size, 0);
  assert.equal(fine.w.mails().length, 1);
  assert.ok(fine.w.sent.find(m => m.raw && m.raw.includes('Kiln registered')).raw.includes('This was the stand-in on the test service: no name was registered and nothing was charged.'));

  const slow = await run('slowname.com');
  assert.equal(slow.s.registration.state, 'asking');
  slow.w.env.kiln_cloud.exec('UPDATE registrations SET asked_at = asked_at - ?, checked_at = 0', 4 * MIN);
  assert.equal((await state(slow.w)).registration.state, 'registered');

  const fail = await run('failname.com');
  assert.deepEqual([fail.s.registration.state, fail.s.offered], ['failed', true]);
  const stuck = await run('stuckname.com');
  assert.equal(stuck.s.registration.state, 'stuck');
  const taken = await run('takenname.com');
  assert.deepEqual([taken.p.status, taken.p.json.code], [409, 'taken']);
  const pricey = await run('priceyname.com');
  assert.deepEqual([pricey.p.status, pricey.p.json.code], [409, 'price_moved']);

  for (const r of [fine, slow, fail, stuck, taken, pricey]) assert.equal(r.w.reg.seen.length, 0);

  // Anywhere but the test service the stand-in is refused, and with it the whole piece.
  const prod = world({ env: { REGISTER_STANDIN: 'on' } });
  assert.equal((await press(prod, N)).status, 404);
  assert.equal(prod.reg.seen.length, 0);
});

test('what the dashboard is told about a registration never holds a price', () => {
  const row = { name: N, state: 'registered', registered_at: 1794500000000, expires_at: 1826036000000, renews: 1, price_first: 1117, price_renew: 1117, leave_asked_at: null };
  assert.deepEqual(publicRegistration(row), { name: N, state: 'registered', registered_at: 1794500000000, runs_until: 1826036000000, renews: true, leave_from: 1799684000000, leave_asked: false });
  assert.deepEqual(publicRegistration({ name: N, state: 'asking', asked_at: 5 }), { name: N, state: 'asking', since: 5 });
  assert.equal(publicRegistration(null), null);
});
