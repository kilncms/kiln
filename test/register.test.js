/**
 * A new domain through Kiln, included with the yearly form of the hosting
 * plan: the paid year, the switch, and the search with its price check
 * (worker/register.js and its routes in worker/cloud.js). Nothing here, and
 * nothing in the service, registers a name.
 *
 *   · With the switch off nothing shows and the routes are no routes.
 *   · With it on, a site is offered a name only when every condition holds.
 *   · Cloudflare's own saved answers (test/fixtures/registrar, asked on
 *     2026-11-13 and kept as they came) give exactly the lines a customer reads.
 *   · Typing is refused before any call, searches are counted, no price is sent.
 *   · The billing company's webhook writes whether a subscription is monthly
 *     or yearly and up to when it is paid; the checkout offers the yearly form
 *     only where the service sells one.
 *
 * The real handlers run over the SQLite-backed D1 stand-in. Cloudflare's
 * registrar and Lemon Squeezy are fetch stand-ins. Nothing touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip, schemaFiles } from './d1-fake.js';
import { fakeGitHub } from './github-fake.js';
import { fakeCloudflare } from './cloudflare-fake.js';
import { planForVariant, periodForVariant } from '../worker/cloud.js';
import { registerOn, registrar, mayHave, mayAsk, whyNot, registerSentence, readTyped, holderOf, clockWords, ENDINGS, LIMITS } from '../worker/register.js';

const saved = (name) => JSON.parse(readFileSync(new URL(`./fixtures/registrar/${name}.json`, import.meta.url), 'utf8'));
const SEARCH = saved('search');
// Every line Cloudflare gave, by name, as it came.
const LINES = Object.fromEntries(['check-1', 'check-odd', 'check-premium'].flatMap(f => saved(f).result.domains).map(d => [d.name, d]));
const J = 'juniperhollowpottery';
const DAY = 86400e3;
const REG = 'https://api.cloudflare.com/client/v4/accounts/acct-hosting/registrar';
const LS = 'https://api.lemonsqueezy.com/v1';
const WORKER = 'club-site1';
const SENTENCES = {
  can: 'Included with your yearly plan',
  taken: 'Taken. Someone else already has this name.',
  costs_more: 'Costs more than your plan covers.',
  premium: 'Sold at a special higher price, so your plan does not cover it.',
  ending: 'Kiln cannot get names with this ending.',
};

/** Cloudflare's registrar, answering from the saved answers. A name it was not asked about on that day is left out, as it leaves names out. */
function fakeRegistrar({ down = false } = {}) {
  const seen = [];
  const handler = async (url, init) => {
    if (!url.startsWith(REG)) return undefined;
    seen.push({ method: init.method, path: url.slice(REG.length), body: init.body ? JSON.parse(init.body) : null });
    if (down) return jsonRes({ success: false, errors: [{ code: 10000, message: 'Internal error' }], messages: [], result: null }, 500);
    if (init.method === 'GET' && url.startsWith(`${REG}/domain-search?q=`)) return jsonRes(url.includes('juniper') ? SEARCH : { result: { domains: [] }, success: true, errors: [], messages: [] });
    if (init.method === 'POST' && url === `${REG}/domain-check`) {
      return jsonRes({ result: { domains: JSON.parse(init.body).domains.map(n => LINES[n]).filter(Boolean) }, success: true, errors: [], messages: [] });
    }
    return jsonRes({ success: false, errors: [{ code: 10000, message: 'No route for that URI' }], messages: [], result: null }, 404);
  };
  return { handler, seen };
}

/**
 * One account with one site on the hosting plan: paid for a year, active, up
 * on Kiln's hosting, with no domain. `site` and `env` change that; `on: false`
 * leaves the switch off.
 */
function world({ on = true, site = {}, hosted = true, env: extra = {}, registrarDown = false } = {}) {
  const gh = fakeGitHub({ repo: 'ada/club', files: { 'index.html': '<!doctype html><h1>Home</h1>' } });
  const cf = fakeCloudflare();
  const reg = fakeRegistrar({ down: registrarDown });
  const env = cloudEnv(fakeKV({ 'itok:ada/club': 'inst-token' }), {
    HOSTING_ACCOUNT_ID: cf.account, HOSTING_API_TOKEN: cf.token, HOSTING_SUBDOMAIN: 'kiln-sites', CLOUD_DASHBOARD: 'https://app.example',
    LS_VARIANT_MANAGED: '22', LS_VARIANT_MANAGED_YEARLY: '33',
    ...(on ? { REGISTER_DOMAINS: 'on' } : {}),
    ...extra,
  });
  const s = { billing_period: 'year', paid_until: Date.now() + 300 * DAY, status: 'active', ls_subscription_id: 'sub-1', plan: 'managed', ...site };
  addSite(env, { id: 'site1', plan: s.plan, status: s.status, ls_subscription_id: s.ls_subscription_id });
  try { env.kiln_cloud.exec('UPDATE sites SET billing_period = ?, paid_until = ? WHERE id = ?', s.billing_period, s.paid_until, 'site1'); } catch { /* a database without migration 0016 */ }
  if (hosted) env.kiln_cloud.exec('INSERT INTO hosting (site_id, name, url, state, deployed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', 'site1', WORKER, `https://${WORKER}.kiln-sites.workers.dev`, 'live', 1, 1, 1);
  const handler = async (url, init) => (await reg.handler(url, init)) || (await cf.handler(url, init)) || gh.handler(url, init);
  return { env, handler, reg };
}
const ask = (env, pathname, method = 'GET', body) => worker.fetch(new Request(`https://worker.example${pathname}`, {
  method, headers: { Authorization: 'Bearer tok', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}), env);
const me = async (w) => withFetch(w.handler, async () => (await ask(w.env, '/cloud/me')).json());
const search = (w, q) => withFetch(w.handler, async () => { const r = await ask(w.env, `/cloud/sites/newdomain?site=site1&q=${encodeURIComponent(q)}`); return { status: r.status, text: await r.clone().text(), json: await r.json() }; });
const had = (env, over = {}) => {
  const r = { id: 'reg-1', site_id: 'site1', account_id: 'acct-1', subscription_id: 'sub-1', name: 'oakbakery.com', state: 'registered', registered_at: Date.now() - 10 * DAY, created_at: Date.now() - 10 * DAY, ...over };
  env.kiln_cloud.exec('INSERT INTO registrations (id, site_id, account_id, subscription_id, name, state, registered_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    r.id, r.site_id, r.account_id, r.subscription_id, r.name, r.state, r.registered_at, r.created_at, r.created_at);
};

// ─── The switch ───────────────────────────────────────────────────────────────

test('the switch is on only when it is exactly "on", and only on a service that hosts sites and sets up domains', () => {
  const base = { HOSTING_ACCOUNT_ID: 'a', HOSTING_API_TOKEN: 't', HOSTING_SUBDOMAIN: 'kiln-sites' };
  assert.equal(registerOn({ ...base, REGISTER_DOMAINS: 'on' }), true);
  for (const v of [undefined, '', 'off', 'ON', 'true', '1', ' on']) assert.equal(registerOn({ ...base, REGISTER_DOMAINS: v }), false, String(v));
  assert.equal(registerOn({ REGISTER_DOMAINS: 'on' }), false);
  assert.equal(registerOn({ ...base, HOSTING_API_TOKEN: '', REGISTER_DOMAINS: 'on' }), false);
  // The holder is one setting. Only "Kiln holds it" is built, so any other holder keeps the piece off.
  assert.equal(holderOf(base), 'kiln');
  assert.equal(holderOf({ REGISTER_HOLDER: 'customer' }), 'customer');
  assert.equal(registerOn({ ...base, REGISTER_DOMAINS: 'on', REGISTER_HOLDER: 'customer' }), false);
});

test('with the switch off the dashboard is told nothing new and the search is no route, also for a paid yearly site', { skip: d1Skip }, async () => {
  const w = world({ on: false });
  const seen = await me(w);
  assert.equal(seen.registers, false);
  assert.equal('new_domain' in seen.sites[0], false);
  assert.equal(JSON.stringify(seen).includes('billing_period'), false);
  await withFetch(w.handler, async () => {
    const unknown = await ask(w.env, '/cloud/sites/nosuchthing?site=site1');
    for (const path of ['/cloud/sites/newdomain?site=site1', `/cloud/sites/newdomain?site=site1&q=${J}`]) {
      const r = await ask(w.env, path);
      assert.equal(r.status, 404, path);
      assert.equal(await r.text(), await unknown.clone().text(), path);
    }
    const post = await ask(w.env, '/cloud/sites/newdomain', 'POST', { id: 'site1', action: 'register', name: `${J}.com`, checked: true });
    assert.equal(post.status, 404);
  });
  assert.equal(w.reg.seen.length, 0);
});

test('nothing in the service can register a name yet: the one door knows only how to look', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async (calls) => {
    for (const call of ['register', 'registrations', 'renew', 'update', '__proto__']) await assert.rejects(registrar(w.env, call, { name: `${J}.com` }), { code: 'not_a_call' });
    // With the switch on, the press that would register is still no route.
    const post = await ask(w.env, '/cloud/sites/newdomain', 'POST', { id: 'site1', action: 'register', name: `${J}.com`, checked: true });
    assert.equal(post.status, 404);
    assert.equal(calls.filter(c => c.url.includes('/registrar/')).length, 0);
  });
  const source = readFileSync(new URL('../worker/register.js', import.meta.url), 'utf8');
  assert.equal(/method: '(POST|PUT|PATCH|DELETE)', path: [`'"]\/registrations/.test(source), false);
});

// ─── Who is offered a name ────────────────────────────────────────────────────

test('with the switch on, the owner of a paid yearly site that is up and has no domain is offered a name', { skip: d1Skip }, async () => {
  const w = world();
  const seen = await me(w);
  assert.equal(seen.registers, true);
  assert.deepEqual(seen.sites[0].new_domain, { offered: true });
  await withFetch(w.handler, async () => {
    const r = await ask(w.env, '/cloud/sites/newdomain?site=site1');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, offered: true, holder: 'kiln', registration: null });
  });
});

const offered = async (w) => (await me(w)).sites[0].new_domain;
const NOT_PAID = 'A domain is included once a year of Kiln Cloud + hosting is paid. Pay for the year from this site\'s row, then choose your name.';

test('a site paid by the month is not offered a name', { skip: d1Skip }, async () => {
  const w = world({ site: { billing_period: 'month' } });
  assert.equal(await offered(w), null);
  const r = await search(w, J);
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { error: NOT_PAID, code: 'not_paid' });
  assert.equal(w.reg.seen.length, 0);
});

test('a yearly site that is not paid is not offered a name', { skip: d1Skip }, async () => {
  assert.equal(await offered(world({ site: { paid_until: Date.now() - DAY } })), null);
  assert.equal(await offered(world({ site: { paid_until: null } })), null);
  assert.equal(await offered(world({ site: { status: 'past_due' } })), null);
  assert.equal(await offered(world({ site: { status: 'canceled' } })), null);
  assert.equal(await offered(world({ site: { plan: 'cloud' } })), null);
  assert.equal((await search(world({ site: { status: 'past_due' } }), J)).json.code, 'not_paid');
});

test('a site that is not up on Kiln\'s hosting is not offered a name', { skip: d1Skip }, async () => {
  const w = world({ hosted: false });
  assert.equal(await offered(w), null);
  const r = await search(w, J);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'not_hosted');
});

test('a site with a domain of its own, waiting or live, is not offered a name', { skip: d1Skip }, async () => {
  for (const state of ['waiting', 'live']) {
    const w = world();
    w.env.kiln_cloud.exec('INSERT INTO domains (site_id, name, state, created_at, updated_at) VALUES (?,?,?,?,?)', 'site1', 'oakbakery.test', state, 1, 1);
    assert.equal(await offered(w), null, state);
    const r = await search(w, J);
    assert.equal(r.json.code, 'has_own');
    assert.match(r.json.error, /oakbakery\.test/);
  }
  // A domain that was put away is no domain.
  const w = world();
  w.env.kiln_cloud.exec('INSERT INTO domains (site_id, name, state, created_at, updated_at) VALUES (?,?,?,?,?)', 'site1', 'oakbakery.test', 'put_away', 1, 1);
  assert.deepEqual(await offered(w), { offered: true });
});

test('a subscription that already had its name is not offered another', { skip: d1Skip }, async () => {
  for (const state of ['asking', 'stuck', 'registered', 'handed_over', 'ran_out']) {
    const w = world();
    had(w.env, { state, registered_at: Date.now() - 500 * DAY, created_at: Date.now() - 500 * DAY });
    assert.equal(await offered(w), null, state);
    const r = await search(w, J);
    assert.deepEqual(r.json, { error: 'Your plan already has its domain, oakbakery.com. A yearly plan includes one.', code: 'has_name' });
  }
  // A registration that failed took nothing.
  const w = world();
  had(w.env, { state: 'failed' });
  assert.deepEqual(await offered(w), { offered: true });
});

test('an account that got a name in the last 12 months is not offered another', { skip: d1Skip }, async () => {
  const w = world();
  had(w.env, { site_id: 'gone', subscription_id: 'sub-0', state: 'handed_over', registered_at: Date.now() - 100 * DAY });
  assert.equal(await offered(w), null);
  const r = await search(w, J);
  assert.deepEqual(r.json, { error: 'Your account already got a domain through Kiln in the last 12 months. Email info@kilncms.com if you need another.', code: 'account_had' });
  const later = world();
  had(later.env, { site_id: 'gone', subscription_id: 'sub-0', state: 'handed_over', registered_at: Date.now() - 400 * DAY, created_at: Date.now() - 400 * DAY });
  assert.deepEqual(await offered(later), { offered: true });
});

// ─── Which names may be had ───────────────────────────────────────────────────

test('Cloudflare\'s saved answers give exactly the lines a customer reads', () => {
  const env = {};
  const line = (name) => { const why = whyNot(LINES[name], env); return why ? registerSentence(why) : registerSentence('can'); };
  // Included: both yearly prices at most $15 and the ending on Kiln's list.
  for (const e of ENDINGS) { assert.equal(line(`${J}.${e}`), SENTENCES.can, e); assert.equal(mayHave(LINES[`${J}.${e}`], env), true, e); }
  // Taken.
  assert.equal(line('google.com'), SENTENCES.taken);
  assert.equal(line('pizza.agency'), SENTENCES.taken);
  // Costs more: the first year is over the limit.
  for (const e of ['me', 'co', 'io', 'info', 'biz', 'shop', 'ai', 'blog', 'studio']) assert.equal(line(`${J}.${e}`), SENTENCES.costs_more, e);
  // Costs more because of the renewal only: cheap the first year, dear after.
  for (const e of ['store', 'online', 'site']) {
    assert.ok(Number(LINES[`${J}.${e}`].pricing.registration_cost) < 15 && Number(LINES[`${J}.${e}`].pricing.renewal_cost) > 15, e);
    assert.equal(line(`${J}.${e}`), SENTENCES.costs_more, e);
  }
  // Premium, also with an ending on Kiln's list. Cloudflare gives no price for these.
  for (const n of ['best.app', 'shop.dev', 'car.xyz', 'law.academy']) assert.equal(line(n), SENTENCES.premium, n);
  // An ending outside the list, cheap as it may be, and one Cloudflare cannot register.
  for (const e of ['us', 'uk', 'ca', 'co.uk', 'de', 'eu']) assert.equal(line(`${J}.${e}`), SENTENCES.ending, e);
  // A name Cloudflare left out of its answer cannot be had.
  assert.equal(mayHave(undefined, env), false);
  assert.equal(whyNot(LINES['xn--caf-dma.com'], env), 'not_checked');
});

test('both prices count, the limit is REGISTER_MAX_USD, and only a standard name in US dollars may be had', () => {
  const com = LINES[`${J}.com`];
  const priced = (first, renew, more = {}) => ({ ...com, ...more, pricing: { currency: 'USD', registration_cost: first, renewal_cost: renew, ...(more.pricing || {}) } });
  assert.equal(whyNot(priced('15.00', '15.00'), {}), null);
  assert.equal(whyNot(priced('15.01', '11.17'), {}), 'costs_more');   // the first year only
  assert.equal(whyNot(priced('11.17', '15.01'), {}), 'costs_more');   // the renewal only
  assert.equal(whyNot(com, { REGISTER_MAX_USD: '11' }), 'costs_more');
  assert.equal(whyNot(priced('15.01', '15.01'), { REGISTER_MAX_USD: '20' }), null);
  assert.equal(whyNot(com, { REGISTER_MAX_USD: 'plenty' }), null);     // a setting that is no number is the default, 15
  assert.equal(mayHave(priced('11.17', '11.17', { pricing: { currency: 'EUR' } }), {}), false);
  assert.equal(mayHave({ ...com, pricing: undefined }), false);
  assert.equal(mayHave({ ...com, tier: 'premium' }, {}), false);
  assert.equal(mayHave({ ...com, registrable: 'true' }, {}), false);
  assert.equal(mayHave({ ...com, name: 'xn--caf-dma.com' }, {}), false);
  assert.equal(mayAsk(`${J}.com`), true);
  for (const n of [`${J}.io`, 'xn--caf-dma.com', 'café.com', '-oak.com', 'oak-.com', 'oak', 'a.b.com', 'Oak.com']) assert.equal(mayAsk(n), false, n);
});

// ─── The search ───────────────────────────────────────────────────────────────

test('a search answers with the names and their lines, and no price', { skip: d1Skip }, async () => {
  const w = world();
  const r = await search(w, 'juniper hollow pottery');
  assert.equal(r.status, 200);
  const line = (why) => ({ can: false, why, sentence: SENTENCES[why] });
  assert.deepEqual(r.json, { ok: true, asked: 'juniper hollow pottery', searches_left: 19, names: [
    { name: `${J}.com`, can: true }, { name: `${J}.org`, can: true }, { name: `${J}.net`, can: true },
    { name: `${J}.dev`, can: true }, { name: `${J}.app`, can: true }, { name: `${J}.xyz`, can: true },
    { name: `${J}.uk`, ...line('ending') }, { name: `${J}.info`, ...line('costs_more') }, { name: `${J}.us`, ...line('ending') },
    { name: `${J}.ca`, ...line('ending') }, { name: `${J}.site`, ...line('costs_more') },
  ] });
  // One search and one price check, and nothing else, went to Cloudflare.
  assert.deepEqual(w.reg.seen.map(c => `${c.method} ${c.path}`), ['GET /domain-search?q=juniper%20hollow%20pottery', 'POST /domain-check']);
  assert.equal(w.reg.seen[1].body.domains.length, 11);
  // No price is in the answer.
  assert.equal(/pricing|_cost|USD|\d+\.\d\d/.test(r.text), false);
  for (const n of r.json.names) assert.deepEqual(Object.keys(n).filter(k => !['name', 'can', 'why', 'sentence'].includes(k)), []);
});

test('a full name typed with its ending is checked first and shown first; a name Cloudflare leaves out cannot be had', { skip: d1Skip }, async () => {
  const w = world();
  const r = await search(w, 'Best.app');
  assert.equal(r.json.asked, 'Best.app');
  assert.deepEqual(r.json.names[0], { name: 'best.app', can: false, why: 'premium', sentence: SENTENCES.premium });
  assert.deepEqual(r.json.names.slice(1).map(n => n.name), ['best.com', 'best.org', 'best.net', 'best.dev', 'best.xyz']);
  for (const n of r.json.names.slice(1)) assert.deepEqual(n, { name: n.name, can: false, why: 'not_checked', sentence: 'Kiln could not check this name. Try another one.' });
  const taken = await search(w, 'google.com');
  assert.deepEqual(taken.json.names[0], { name: 'google.com', can: false, why: 'taken', sentence: SENTENCES.taken });
});

test('typing with accents or in another script is refused before any call', { skip: d1Skip }, async () => {
  const w = world();
  const sentence = 'Kiln can only get names written with the letters a to z, numbers and hyphens. Type the name without accents or other characters.';
  for (const q of ['café du coin', 'жук', '東京', 'xn--caf-dma.com', 'oak & ash', 'oak_bakery', '   ', '---']) {
    const r = await search(w, q);
    assert.equal(r.status, 400, q);
    assert.deepEqual(r.json, { error: sentence, code: 'letters_only' }, q);
  }
  assert.equal(w.reg.seen.length, 0);
  // A refused typing is not counted as a search.
  assert.equal((await search(w, J)).json.searches_left, 19);
  assert.deepEqual(readTyped('Juniper  Hollow-Pottery '), { asked: 'Juniper Hollow-Pottery', label: 'juniperhollow-pottery', full: null });
  assert.deepEqual(readTyped('juniperhollow.com'), { asked: 'juniperhollow.com', label: 'juniperhollow', full: 'juniperhollow.com' });
  assert.deepEqual(readTyped('a'.repeat(64)), { stop: 'too_long' });
});

test('the twenty-first search in an hour is refused with its sentence and the time', { skip: d1Skip }, async () => {
  const w = world();
  const before = Date.now();
  for (let i = 1; i <= 20; i++) assert.equal((await search(w, J)).json.searches_left, 20 - i, `search ${i}`);
  const asked = w.reg.seen.length;
  const r = await search(w, J);
  assert.equal(r.status, 429);
  assert.equal(r.json.code, 'too_many_searches');
  assert.ok(r.json.retry_at >= before + 3600e3 && r.json.retry_at <= Date.now() + 3600e3);
  assert.equal(r.json.error, `You have searched 20 times in the last hour. Wait until ${clockWords(r.json.retry_at, 'America/New_York')}, then search again.`);
  assert.match(r.json.error, /Wait until \d{1,2}:\d\d (AM|PM), then search again\.$/);
  assert.equal(w.reg.seen.length, asked);   // the refused search asked Cloudflare nothing
  assert.equal(clockWords(Date.UTC(2026, 10, 13, 20, 40), 'America/New_York'), '3:40 PM');
  // Sixty in a day, and three hundred in an hour for everybody together.
  const day = world();
  day.env.KILN.map.set('regsearch:d:acct-1', JSON.stringify({ n: LIMITS.searchesADay, since: Date.now() - 5 * 3600e3 }));
  const d = await search(day, J);
  assert.equal(d.status, 429);
  assert.equal(d.json.error, 'You have searched 60 times in the last day. Wait until tomorrow, then search again.');
  const all = world();
  all.env.KILN.map.set('regsearch:all', JSON.stringify({ n: LIMITS.searchesAnHourAll, since: Date.now() - 60e3 }));
  const a = await search(all, J);
  assert.equal(a.status, 503);
  assert.equal(a.json.code, 'search_busy');
  assert.equal(day.reg.seen.length + all.reg.seen.length, 0);
  // A count whose hour is over starts again.
  const again = world();
  again.env.KILN.map.set('regsearch:h:acct-1', JSON.stringify({ n: 20, since: Date.now() - 3601e3 }));
  assert.equal((await search(again, J)).json.searches_left, 19);
});

test('a search that fails says so and offers no name', { skip: d1Skip }, async () => {
  const w = world({ registrarDown: true });
  const r = await search(w, J);
  assert.equal(r.status, 502);
  assert.deepEqual(r.json, { error: 'Kiln could not search just now. Nothing was changed. Try again in a minute.', code: 'search_failed', searches_left: 19 });
});

test('a site of another account is refused before anything is searched', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    assert.equal((await ask(w.env, `/cloud/sites/newdomain?site=not-mine&q=${J}`)).status, 404);
    const anon = await worker.fetch(new Request(`https://worker.example/cloud/sites/newdomain?site=site1&q=${J}`), w.env);
    assert.equal(anon.status, 401);
  });
  assert.equal(w.reg.seen.length, 0);
});

// ─── The stand-in ─────────────────────────────────────────────────────────────

test('the stand-in for Cloudflare is refused on a service whose prefix is not "stg-", and such a service offers nothing', { skip: d1Skip }, async () => {
  for (const prefix of [undefined, '', 'prod-', 'stg']) {
    const w = world({ env: { REGISTER_STANDIN: 'on', ...(prefix === undefined ? {} : { HOSTING_PREFIX: prefix }) } });
    assert.equal(registerOn(w.env), false, String(prefix));
    await withFetch(w.handler, async (calls) => {
      for (const call of ['search', 'check', 'status']) await assert.rejects(registrar(w.env, call, { q: J, names: [`${J}.com`], name: `${J}.com` }), { code: 'standin_refused' });
      assert.equal((await ask(w.env, `/cloud/sites/newdomain?site=site1&q=${J}`)).status, 404);
      assert.equal(calls.filter(c => c.url.includes('/registrar')).length, 0);
    });
    assert.equal((await me(w)).registers, false);
  }
});

test('on the test service the stand-in answers and nothing is asked of Cloudflare', { skip: d1Skip }, async () => {
  const w = world({ env: { REGISTER_STANDIN: 'on', HOSTING_PREFIX: 'stg-' } });
  const r = await search(w, 'oak bakery');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.names.filter(n => n.can).map(n => n.name), ENDINGS.map(e => `oakbakery.${e}`));
  assert.equal((await search(w, 'taken bakery')).json.names.every(n => n.why === 'taken'), true);
  assert.equal((await search(w, 'pricey bakery')).json.names.every(n => n.why === 'costs_more'), true);
  assert.equal((await search(w, 'premium bakery')).json.names.every(n => n.why === 'premium'), true);
  assert.equal(w.reg.seen.length, 0);
  // A name nobody asked to register: the stand-in says what Cloudflare says.
  assert.deepEqual(await registrar(w.env, 'status', { name: 'oakbakery.com' }), { http: 404, ok: false, result: null, errors: [{ code: 10000, message: 'No workflow found for oakbakery.com' }] });
});

// ─── The paid year ────────────────────────────────────────────────────────────

async function hook(env, attributes, { event = 'subscription_updated', site = 'site1', sub = 'sub-1' } = {}) {
  const body = JSON.stringify({
    meta: { event_name: event, ...(site ? { custom_data: { site_id: site } } : {}) },
    data: { type: 'subscriptions', id: sub, attributes: { updated_at: new Date().toISOString(), ends_at: null, ...attributes } },
  });
  const sig = createHmac('sha256', 'whsec').update(body).digest('hex');
  const res = await worker.fetch(new Request('https://worker.example/cloud/webhook/ls', { method: 'POST', headers: { 'X-Signature': sig }, body }), env);
  return res.status;
}
const row = (env) => env.kiln_cloud.row('SELECT * FROM sites WHERE id = ?', 'site1');
const unpaid = { site: { billing_period: null, paid_until: null, status: 'trialing', ls_subscription_id: null } };
const RENEWS = '2027-11-13T15:00:00.000000Z', ENDS = '2027-03-01T00:00:00.000000Z';

test('a yearly subscription marks the site yearly and paid up to the day it renews; a monthly one says month', { skip: d1Skip }, async () => {
  const w = world({ on: false, ...unpaid });
  assert.equal(await hook(w.env, { status: 'active', variant_id: 33, renews_at: RENEWS }, { event: 'subscription_created' }), 200);
  assert.deepEqual((({ plan, status, billing_period, paid_until }) => ({ plan, status, billing_period, paid_until }))(row(w.env)),
    { plan: 'managed', status: 'active', billing_period: 'year', paid_until: Date.parse(RENEWS) });
  // Cancelled: paid up to the day it ends, and still yearly.
  assert.equal(await hook(w.env, { status: 'cancelled', variant_id: 33, renews_at: RENEWS, ends_at: ENDS, updated_at: '2026-12-01T00:00:00Z' }), 200);
  assert.equal(row(w.env).paid_until, Date.parse(ENDS));
  assert.equal(row(w.env).billing_period, 'year');

  const m = world({ on: false, ...unpaid });
  assert.equal(await hook(m.env, { status: 'active', variant_id: 22, renews_at: '2026-12-13T15:00:00.000000Z' }), 200);
  assert.equal(row(m.env).billing_period, 'month');
  assert.equal(row(m.env).paid_until, Date.parse('2026-12-13T15:00:00.000000Z'));
  // A payment that failed: the day already paid for stays as it was, whatever day the next try is set for.
  assert.equal(await hook(m.env, { status: 'past_due', variant_id: 22, renews_at: '2026-12-17T15:00:00.000000Z', updated_at: '2026-12-13T15:01:00Z' }), 200);
  assert.equal(row(m.env).status, 'past_due');
  assert.equal(row(m.env).paid_until, Date.parse('2026-12-13T15:00:00.000000Z'));
  // Moved to the yearly form later (in the billing portal): the row follows.
  assert.equal(await hook(m.env, { status: 'active', variant_id: 33, renews_at: RENEWS, updated_at: '2026-12-14T00:00:00Z' }), 200);
  assert.equal(row(m.env).billing_period, 'year');
  assert.equal(row(m.env).paid_until, Date.parse(RENEWS));
});

test('where no yearly variant is set, a webhook that names an unknown variant is treated exactly as today', { skip: d1Skip }, async () => {
  const w = world({ on: false, ...unpaid, env: { LS_VARIANT_MANAGED_YEARLY: undefined } });
  assert.equal(planForVariant(w.env, 33), null);
  assert.equal(periodForVariant(w.env, 33), null);
  assert.equal(periodForVariant(w.env, 22), 'month');
  assert.equal(await hook(w.env, { status: 'active', variant_id: 33, renews_at: RENEWS }), 200);
  const r = row(w.env);
  assert.deepEqual([r.status, r.plan, r.ls_subscription_id, r.billing_period, r.paid_until], ['active', 'managed', 'sub-1', null, null]);
  assert.equal('yearly' in (await me(w)), false);
});

test('the checkout offers the yearly form only where the service sells one, and only for the hosting plan', { skip: d1Skip }, async () => {
  const lemon = async (url, init) => (url === `${LS}/checkouts` && init.method === 'POST' ? jsonRes({ data: { attributes: { url: 'https://kiln.lemonsqueezy.com/checkout/custom/abc' } } }, 201) : undefined);
  const variantOf = async (w, query) => withFetch(lemon, async (calls) => {
    const r = await ask(w.env, `/cloud/checkout?site=site1${query}`);
    assert.equal(r.status, 200);
    const sent = calls.find(c => c.url === `${LS}/checkouts`).body.data;
    return [sent.relationships.variant.data.id, sent.attributes.product_options.enabled_variants];
  });
  const w = world({ on: false, ...unpaid });
  assert.deepEqual(await variantOf(w, '&period=year'), ['33', [33]]);
  assert.deepEqual(await variantOf(w, ''), ['22', [22]]);
  assert.deepEqual(await variantOf(w, '&period=forever'), ['22', [22]]);
  assert.equal((await me(w)).yearly, true);
  // No yearly variant: asking for a year changes nothing.
  const none = world({ on: false, ...unpaid, env: { LS_VARIANT_MANAGED_YEARLY: undefined } });
  assert.deepEqual(await variantOf(none, '&period=year'), ['22', [22]]);
  // The plan without hosting has no yearly form.
  const cloud = world({ on: false, site: { ...unpaid.site, plan: 'cloud' } });
  assert.deepEqual(await variantOf(cloud, '&period=year'), ['11', [11]]);
});

// ─── A database the migration has not reached ─────────────────────────────────

test('a database without migration 0016 still answers the dashboard and the webhook', { skip: d1Skip }, async () => {
  const before = schemaFiles().findIndex(f => f.endsWith('0016_registrations.sql'));
  assert.ok(before > 0);
  const w = world({ ...unpaid, env: { d1: { upTo: before } } });
  assert.throws(() => w.env.kiln_cloud.row('SELECT billing_period FROM sites'));
  const seen = await me(w);
  assert.equal(seen.registers, false);   // the switch is on, and the table is not there
  assert.equal(seen.sites.length, 1);
  assert.equal('new_domain' in seen.sites[0], false);
  await withFetch(w.handler, async () => assert.equal((await ask(w.env, `/cloud/sites/newdomain?site=site1&q=${J}`)).status, 404));
  assert.equal(await hook(w.env, { status: 'active', variant_id: 33, renews_at: RENEWS }), 200);
  assert.deepEqual([row(w.env).status, row(w.env).plan, row(w.env).ls_subscription_id], ['active', 'managed', 'sub-1']);
});

test('the table keeps its own three rules', { skip: d1Skip }, () => {
  const { env } = world();
  had(env);
  // One name for a subscription, for good; one at a time for a site; one holder for a name.
  assert.throws(() => had(env, { id: 'reg-2', site_id: 'site2', name: 'other.com' }), /UNIQUE/);
  assert.throws(() => had(env, { id: 'reg-3', subscription_id: 'sub-2', name: 'other.com' }), /UNIQUE/);
  assert.throws(() => had(env, { id: 'reg-4', site_id: 'site2', subscription_id: 'sub-2' }), /UNIQUE/);
  // A registration that failed holds nothing.
  had(env, { id: 'reg-5', site_id: 'site9', subscription_id: 'sub-9', name: 'pine.com', state: 'failed' });
  had(env, { id: 'reg-6', site_id: 'site9', subscription_id: 'sub-9', name: 'pine.com', state: 'failed' });
  had(env, { id: 'reg-7', site_id: 'site9', subscription_id: 'sub-9', name: 'pine.com', state: 'asking' });
  // A name that was handed over leaves its site free, and keeps its subscription's one name used.
  env.kiln_cloud.exec("UPDATE registrations SET state = 'handed_over' WHERE id = 'reg-1'");
  had(env, { id: 'reg-8', subscription_id: 'sub-3', name: 'elm.com' });
  assert.throws(() => had(env, { id: 'reg-9', site_id: 'site3', subscription_id: 'sub-1', name: 'ash.com' }), /UNIQUE/);
});
