/**
 * A new domain through Kiln, included with the yearly form of the hosting plan.
 *
 * A customer whose site is on Kiln Cloud + hosting, paid by the year, and who
 * has no domain, chooses a free name. Kiln registers it in its own Cloudflare
 * account (Cloudflare's Registrar API, the hosting account) and puts the site
 * on it. This file holds the switch, who is offered a name, which names may
 * be had, the search with its limits, and the one function every call to
 * Cloudflare's registrar goes through.
 *
 * WHAT IS HERE SO FAR: looking only. The search, the price check and the
 * reading of a registration's state. Nothing in this file, and nothing in the
 * service, can register a name yet: `registrar` below knows no call that does.
 *
 * Settings (all read here and nowhere else):
 *   REGISTER_DOMAINS   the switch. On only when it is exactly "on". Absent on
 *                      the test service and on production until matters
 *                      outside the code are settled. Off: nothing is offered
 *                      and the routes answer as an unknown route does.
 *   REGISTER_HOLDER    who a name is registered to: "kiln" (the default) has
 *                      Kiln's company hold it for the customer to use. Only
 *                      that way is built; with any other value the piece
 *                      stays off, so nobody is told of a holder Kiln cannot
 *                      deliver.
 *   REGISTER_MAX_USD   the most a name may cost in a year, first year and
 *                      renewal alike (15).
 *   REGISTER_DAILY_MAX how many names the whole service registers in a day (3).
 *   REGISTER_STANDIN   "on": a stand-in answers in Cloudflare's place and no
 *                      call leaves the service. For the test service only: it
 *                      is refused unless HOSTING_PREFIX is "stg-", and a
 *                      service where it is refused offers nothing.
 * It also needs what hosting and own domains need (HOSTING_ACCOUNT_ID,
 * HOSTING_API_TOKEN, HOSTING_SUBDOMAIN) and migration 0016.
 */
import { hostingOn } from './hosting.js';
import { domainsOn } from './domain.js';

const CF = 'https://api.cloudflare.com/client/v4';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** The endings Kiln registers. Each needs only the name, allows privacy, and costs at most $15 in both prices (2026-11). */
export const ENDINGS = ['com', 'org', 'net', 'dev', 'app', 'xyz'];

export const LIMITS = {
  namesChecked: 20,        // one price check carries at most this many names
  searchesAnHour: 20,      // for one account
  searchesADay: 60,        // for one account
  searchesAnHourAll: 300,  // for the whole service
  accountEveryMs: 365 * DAY,   // one name for an account in this long
};

export class RegisterError extends Error {
  constructor(code, detail = '') { super(code); this.code = code; this.detail = String(detail).slice(0, 300); }
}

// ─── The switch and the settings ──────────────────────────────────────────────

/** Who a name is registered to. The only place REGISTER_HOLDER is read. */
export function holderOf(env) {
  const v = String((env && env.REGISTER_HOLDER) || '').trim().toLowerCase();
  return v === '' || v === 'kiln' ? 'kiln' : v === 'customer' ? 'customer' : 'unknown';
}

/** The most a name may cost in a year, in US cents. */
export function maxCents(env) {
  const n = Number(env && env.REGISTER_MAX_USD);
  return Math.round((Number.isFinite(n) && n > 0 ? n : 15) * 100);
}

/** How many names the whole service registers in 24 hours. */
export function dailyMax(env) {
  const n = Number(env && env.REGISTER_DAILY_MAX);
  return Number.isInteger(n) && n >= 0 ? n : 3;
}

// The prefix as worker/hosting.js reads it (its own reader is not exported).
const hostingPrefix = (env) => String((env && env.HOSTING_PREFIX) || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 8);
/** True when a stand-in is asked for in Cloudflare's place. */
export const standInAsked = (env) => !!(env && env.REGISTER_STANDIN && String(env.REGISTER_STANDIN).toLowerCase() !== 'off');
/** The stand-in is for the test service, whose sites carry "stg-". Anywhere else it is refused. */
export const standInAllowed = (env) => hostingPrefix(env) === 'stg-';

/**
 * True when this service is told to offer new domains, as far as its settings
 * say. Off when the switch is anything but "on", when the service hosts no
 * sites or sets up no domains, when a stand-in is asked for where it is
 * refused, and when the holder is one this service cannot register for.
 */
export function registerOn(env) {
  if (!env || env.REGISTER_DOMAINS !== 'on') return false;
  if (!hostingOn(env) || !domainsOn(env)) return false;
  if (standInAsked(env) && !standInAllowed(env)) return false;
  return holderOf(env) === 'kiln';
}

/** `registerOn`, and the database has the table (migration 0016 has reached it). */
export async function registerReady(env) {
  if (!registerOn(env)) return false;
  try { await env.kiln_cloud.prepare('SELECT id FROM registrations LIMIT 1').first(); return true; }
  catch { return false; }
}

// ─── Sentences ────────────────────────────────────────────────────────────────

/** What a person reads. `name` is a domain, `time` a time of day. */
export function registerSentence(code, { name = 'this name', time = '' } = {}) {
  switch (code) {
    // A result line.
    case 'can': return 'Included with your yearly plan';
    case 'taken': return 'Taken. Someone else already has this name.';
    case 'costs_more': return 'Costs more than your plan covers.';
    case 'premium': return 'Sold at a special higher price, so your plan does not cover it.';
    case 'ending': return 'Kiln cannot get names with this ending.';
    case 'not_checked': return 'Kiln could not check this name. Try another one.';
    // Typing that is refused before any search.
    case 'letters_only': return 'Kiln can only get names written with the letters a to z, numbers and hyphens. Type the name without accents or other characters.';
    case 'too_long': return 'That name is too long for a domain. Type a shorter one.';
    case 'too_many_searches': return `You have searched ${LIMITS.searchesAnHour} times in the last hour. Wait until ${time}, then search again.`;
    case 'too_many_today': return `You have searched ${LIMITS.searchesADay} times in the last day. Wait until tomorrow, then search again.`;
    case 'search_busy': return 'Kiln is handling a lot of searches right now. Nothing was changed. Try again in an hour.';
    case 'search_failed': return 'Kiln could not search just now. Nothing was changed. Try again in a minute.';
    // Why a site is not offered a name.
    case 'has_name': return `Your plan already has its domain, ${name}. A yearly plan includes one.`;
    case 'account_had': return 'Your account already got a domain through Kiln in the last 12 months. Email info@kilncms.com if you need another.';
    case 'not_paid': return 'A domain is included once a year of Kiln Cloud + hosting is paid. Pay for the year from this site\'s row, then choose your name.';
    case 'not_hosted': return 'A new domain can be put only on a site that is up on Kiln\'s hosting. Put the site up first, and then come back here.';
    case 'has_own': return `This site already has its own domain, ${name}. The domain your plan includes is for a site without one. Email info@kilncms.com if you want to change it.`;
    default: return 'Kiln could not search just now. Nothing was changed. Try again in a minute.';
  }
}

// ─── Which names may be had ───────────────────────────────────────────────────

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ENDING = /^[a-z]{2,24}(?:\.[a-z]{2,24})?$/;

/** A domain as { label, ending }, or null for anything but one plain label and an ending. */
export function nameParts(name) {
  const s = String(name ?? '');
  const dot = s.indexOf('.');
  if (dot < 1) return null;
  const label = s.slice(0, dot), ending = s.slice(dot + 1);
  if (!LABEL.test(label) || !ENDING.test(ending) || s.includes('xn--')) return null;
  return { label, ending };
}

/** The half of `mayHave` that needs no call: a to z, 0 to 9 and hyphens, no "xn--", and an ending on Kiln's list. */
export function mayAsk(name) {
  const parts = nameParts(name);
  return !!parts && ENDINGS.includes(parts.ending);
}

// Cloudflare sends a price as text ("11.17"). Anything else is no price.
const cents = (v) => (typeof v === 'string' && /^\d{1,6}(\.\d{1,2})?$/.test(v.trim()) ? Math.round(Number(v) * 100) : null);

/** The two prices in one line of Cloudflare's price check, in US cents, or null where it gave none in US dollars. */
export function pricesOf(answer) {
  const p = answer && answer.pricing;
  if (!p || p.currency !== 'USD') return null;
  const first = cents(p.registration_cost), renew = cents(p.renewal_cost);
  return first === null || renew === null ? null : { first, renew };
}

/**
 * Why a name cannot be had, from one line of Cloudflare's price check
 * (`answer`, or nothing when Cloudflare left the name out): 'taken',
 * 'premium', 'costs_more', 'ending' or 'not_checked'. Null: it may be had.
 * The price is judged before the ending, so a dear name with an ending
 * outside the list says that it costs more.
 */
export function whyNot(answer, env) {
  if (!answer || typeof answer !== 'object') return 'not_checked';
  if (answer.tier === 'premium' || answer.reason === 'domain_premium') return 'premium';
  if (answer.registrable !== true) {
    if (answer.reason === 'domain_unavailable') return 'taken';
    if (answer.reason === 'extension_not_supported') return 'ending';
    return 'not_checked';
  }
  if (answer.tier !== 'standard') return 'premium';
  const prices = pricesOf(answer);
  if (!prices) return 'not_checked';
  if (Math.max(prices.first, prices.renew) > maxCents(env)) return 'costs_more';
  if (!mayAsk(answer.name)) return 'ending';
  return null;
}

/**
 * The one rule for which names may be had: the ending is on Kiln's list, the
 * name is a to z, 0 to 9 and hyphens with no "xn--", and Cloudflare's check
 * says it can be registered, at the standard tier, in US dollars, with the
 * larger of its two yearly prices at most the limit.
 */
export function mayHave(answer, env) {
  return whyNot(answer, env) === null;
}

// ─── What was typed ───────────────────────────────────────────────────────────

/**
 * What a person typed into the search, made ready: { asked, label, full }.
 * `label` is the words run together ("juniper hollow pottery" becomes
 * "juniperhollowpottery"), and `full` is the whole name when one was typed
 * with its ending. Refused with { stop } before anything is asked of anybody:
 * 'letters_only' for accents, other scripts and other characters, 'too_long'.
 */
export function readTyped(typed) {
  const asked = String(typed ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!asked || !/^[A-Za-z0-9 .-]+$/.test(asked) || /xn--/i.test(asked)) return { stop: 'letters_only' };
  const run = asked.toLowerCase().replace(/ /g, '').replace(/^\.+|\.+$/g, '');
  const dot = run.indexOf('.');
  const label = (dot < 0 ? run : run.slice(0, dot)).replace(/^-+|-+$/g, '');
  const ending = dot < 0 ? '' : run.slice(dot + 1);
  if (!label) return { stop: 'letters_only' };
  if (label.length > 63) return { stop: 'too_long' };
  if (!LABEL.test(label)) return { stop: 'letters_only' };
  const full = ending && ENDING.test(ending) ? `${label}.${ending}` : null;
  return { asked, label, full };
}

// ─── Cloudflare's registrar: the one door ─────────────────────────────────────

// Every call this service makes to Cloudflare's registrar, by name. Looking
// only: there is no call here that registers, changes or renews a name.
const CALLS = {
  /** Names like the words typed. */
  search: ({ q }) => ({ method: 'GET', path: `/domain-search?q=${encodeURIComponent(String(q ?? ''))}` }),
  /** Whether each name can be registered, and both of its yearly prices. */
  check: ({ names }) => ({ method: 'POST', path: '/domain-check', json: { domains: (names || []).slice(0, LIMITS.namesChecked) } }),
  /** How far a registration that was asked for has got. HTTP 404 for a name never asked for. */
  status: ({ name }) => ({ method: 'GET', path: `/registrations/${encodeURIComponent(String(name ?? ''))}/registration-status` }),
};

/**
 * The one function every call to Cloudflare's registrar goes through.
 * `ask` is one of the names in CALLS. Answers { http, ok, result, errors }
 * also when Cloudflare refuses (the caller reads `http` and `errors`), and
 * throws a RegisterError only when no answer could be read at all, when the
 * call is not one this door knows, or when a stand-in is asked for where it
 * is refused. With the stand-in, nothing leaves the service.
 */
export async function registrar(env, ask, args = {}) {
  if (!Object.prototype.hasOwnProperty.call(CALLS, ask)) throw new RegisterError('not_a_call', ask);
  if (standInAsked(env)) {
    if (!standInAllowed(env)) throw new RegisterError('standin_refused', 'REGISTER_STANDIN is for a service whose HOSTING_PREFIX is "stg-"');
    return standIn(ask, args);
  }
  if (!domainsOn(env)) throw new RegisterError('not_set_up');
  const { method, path, json } = CALLS[ask](args);
  const headers = { Authorization: `Bearer ${env.HOSTING_API_TOKEN}` };
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  let res;
  // Cloudflare is given fifteen seconds. No answer in that time is no answer.
  try { res = await fetch(`${CF}/accounts/${env.HOSTING_ACCOUNT_ID}/registrar${path}`, { method, headers, body, signal: AbortSignal.timeout(15000) }); }
  catch (e) { throw new RegisterError('cloudflare', `${ask}: ${e?.message || e}`); }
  let data = null;
  try { data = await res.json(); } catch { /* an answer that is not JSON is read as a refusal below */ }
  const errors = Array.isArray(data?.errors) ? data.errors.map(e => ({ code: Number(e?.code) || 0, message: String(e?.message || '').slice(0, 200) })) : [];
  return { http: res.status, ok: res.ok && !!data && data.success !== false, result: data?.result ?? null, errors };
}

// The stand-in for the test service. A name's first letters say how it
// behaves: "taken…" is taken, "pricey…" costs more than any plan covers,
// "premium…" is sold at a special price. Every other name is free at the
// prices Cloudflare gave on 2026-11-13.
const STANDIN_PRICES = { com: ['11.17', '11.17'], org: ['8.50', '11.20'], net: ['11.86', '11.86'], dev: ['8.20', '12.20'], app: ['8.20', '14.20'], xyz: ['13.50', '13.50'], us: ['6.50', '6.50'], info: ['21.20', '21.20'], site: ['4.99', '27.70'] };
function standInLine(name) {
  const parts = nameParts(name);
  if (!parts) return null;   // as Cloudflare does: a name it cannot read is left out without a word
  if (parts.label.startsWith('taken')) return { name, registrable: false, tier: 'standard', reason: 'domain_unavailable' };
  if (parts.label.startsWith('premium')) return { name, registrable: false, tier: 'premium', reason: 'domain_premium' };
  if (parts.ending === 'de' || parts.ending === 'eu') return { name, registrable: false, tier: 'standard', reason: 'extension_not_supported' };
  const [first, renew] = parts.label.startsWith('pricey') ? ['30.00', '30.00'] : STANDIN_PRICES[parts.ending] || ['30.00', '30.00'];
  return { name, registrable: true, tier: 'standard', pricing: { currency: 'USD', registration_cost: first, renewal_cost: renew } };
}
function standIn(ask, args) {
  const answer = (domains) => ({ http: 200, ok: true, result: { domains: domains.filter(Boolean) }, errors: [] });
  if (ask === 'search') {
    const label = String(args.q ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 63);
    return answer(['com', 'net', 'org', 'us', 'info', 'site'].map(e => standInLine(`${label}.${e}`)));
  }
  if (ask === 'check') return answer((args.names || []).slice(0, LIMITS.namesChecked).map(standInLine));
  // No name has been asked for yet, and Cloudflare says so in these words.
  return { http: 404, ok: false, result: null, errors: [{ code: 10000, message: `No workflow found for ${String(args.name ?? '')}` }] };
}

// ─── Who is offered a name ────────────────────────────────────────────────────

/**
 * Why a site is not offered a new domain, or null when every condition
 * holds: the site is on Kiln Cloud + hosting and up on Kiln's hosting, its
 * subscription is yearly, active and paid, it has no domain waiting or live,
 * no name was already had on this subscription, and the account had none in
 * the last 12 months. Answers { why, name } (`name` where a sentence names a
 * domain). `had` is the account's registrations that did not fail.
 */
export function offerStop({ site, up, domain, had = [], now = Date.now() }) {
  if (!site || site.plan !== 'managed' || !site.ls_subscription_id) return { why: 'not_paid' };
  if (site.billing_period !== 'year' || site.status !== 'active' || !(Number(site.paid_until) > now)) return { why: 'not_paid' };
  if (!up) return { why: 'not_hosted' };
  if (domain && (domain.state === 'waiting' || domain.state === 'live')) return { why: 'has_own', name: domain.name };
  const standing = ['asking', 'stuck', 'registered'];
  const mine = had.find(r => r.subscription_id === String(site.ls_subscription_id)) || had.find(r => r.site_id === site.id && standing.includes(r.state));
  if (mine) return { why: 'has_name', name: mine.name };
  if (had.some(r => Number(r.registered_at || r.asked_at || r.created_at) > now - LIMITS.accountEveryMs)) return { why: 'account_had' };
  return null;
}

/**
 * For each of an account's sites, whether it is offered a new domain:
 * { [siteId]: { offered, why, name } }. `up(siteId)` says whether the site is
 * up on Kiln's hosting and `domains` holds each site's own domain row; both
 * come from the caller, which has read them already. Never fails the page
 * that asks: where the database cannot answer, nothing is offered.
 */
export async function offersForAccount(env, accountId, { up = () => false, domains = {}, now = Date.now() } = {}) {
  try {
    const sites = await env.kiln_cloud.prepare('SELECT id, plan, status, ls_subscription_id, billing_period, paid_until FROM sites WHERE account_id = ?').bind(accountId).all();
    const had = await env.kiln_cloud.prepare("SELECT site_id, subscription_id, name, state, asked_at, registered_at, created_at FROM registrations WHERE account_id = ? AND state != 'failed'").bind(accountId).all();
    const out = {};
    for (const site of sites.results || []) {
      const stop = offerStop({ site, up: !!up(site.id), domain: domains[site.id] || null, had: had.results || [], now });
      out[site.id] = stop ? { offered: false, why: stop.why, name: stop.name || null } : { offered: true, why: null, name: null };
    }
    return out;
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'register_offer_unread', err: String(e?.message || e).slice(0, 200) }));
    return {};
  }
}

// ─── The search and its limits ────────────────────────────────────────────────

// A count that starts with its first search and is forgotten when its time
// is over. KV's own lifetime clears the key; `since` is what decides.
async function counted(env, key, windowMs, now) {
  let c = null;
  try { c = await env.KILN.get(key, 'json'); } catch { c = null; }
  return c && Number(c.since) > now - windowMs ? { n: Number(c.n) || 0, since: Number(c.since) } : { n: 0, since: now };
}
const count = (env, key, c, windowMs, now) => env.KILN.put(key, JSON.stringify({ n: c.n + 1, since: c.since }),
  { expirationTtl: Math.max(60, Math.ceil((c.since + windowMs - now) / 1000)) });

/** A time of day as a person says it ("3:40 PM"), in the zone the request came from. */
export function clockWords(ms, timeZone) {
  const say = (tz) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).replace(/[  ]/g, ' ');
  try { return say(timeZone || 'America/New_York'); } catch { return say('America/New_York'); }
}

/**
 * Search and price for one account: what was typed becomes names, Cloudflare
 * is asked once for names like it and once what each can be had for, and only
 * that second answer decides. Answers the route's own answer, or
 * { stop, status, more } for a refusal. No price leaves this function.
 */
export async function searchNames(env, accountId, typed, { now = Date.now(), timeZone = null } = {}) {
  const read = readTyped(typed);
  if (read.stop) return { stop: read.stop, status: 400 };
  const keys = { hour: `regsearch:h:${accountId}`, day: `regsearch:d:${accountId}`, all: 'regsearch:all' };
  const hour = await counted(env, keys.hour, HOUR, now), day = await counted(env, keys.day, DAY, now), all = await counted(env, keys.all, HOUR, now);
  if (hour.n >= LIMITS.searchesAnHour) {
    const at = hour.since + HOUR;
    return { stop: 'too_many_searches', status: 429, time: clockWords(at, timeZone), more: { retry_at: at, searches_left: 0 } };
  }
  if (day.n >= LIMITS.searchesADay) return { stop: 'too_many_today', status: 429, more: { retry_at: day.since + DAY, searches_left: 0 } };
  if (all.n >= LIMITS.searchesAnHourAll) return { stop: 'search_busy', status: 503, more: { retry_at: all.since + HOUR } };
  await Promise.all([count(env, keys.hour, hour, HOUR, now), count(env, keys.day, day, DAY, now), count(env, keys.all, all, HOUR, now)]);
  const left = Math.max(0, Math.min(LIMITS.searchesAnHour - hour.n - 1, LIMITS.searchesADay - day.n - 1));

  // The names to ask about: the full name that was typed first, then the words with each of Kiln's endings, then Cloudflare's own ideas.
  const names = [];
  const add = (n) => { const name = String(n ?? '').toLowerCase(); if (nameParts(name) && !names.includes(name) && names.length < LIMITS.namesChecked) names.push(name); };
  if (read.full) add(read.full);
  for (const e of ENDINGS) add(`${read.label}.${e}`);
  const failed = (why) => {
    console.warn(JSON.stringify({ evt: 'register_search_failed', account: accountId, why: String(why).slice(0, 200) }));
    return { stop: 'search_failed', status: 502, more: { searches_left: left } };
  };
  let lines;
  try {
    // Ideas that cannot be read are no reason to fail: the names above are still checked.
    const ideas = await registrar(env, 'search', { q: read.asked.toLowerCase() }).catch((e) => { if (e?.code === 'standin_refused') throw e; return null; });
    if (ideas?.ok) for (const d of ideas.result?.domains || []) add(d?.name);
    const checked = await registrar(env, 'check', { names });
    if (!checked.ok || !Array.isArray(checked.result?.domains)) return failed(`check answered ${checked.http} ${checked.errors.map(e => `${e.code} ${e.message}`).join('; ')}`);
    lines = Object.fromEntries(checked.result.domains.filter(d => d && typeof d.name === 'string').map(d => [d.name.toLowerCase(), d]));
  } catch (e) { return failed(e instanceof RegisterError ? `${e.code} ${e.detail}` : e?.message || e); }

  const out = names.map((name) => {
    const why = whyNot(lines[name], env);   // a name Cloudflare left out of its answer cannot be had
    return why ? { name, can: false, why, sentence: registerSentence(why) } : { name, can: true };
  });
  console.log(JSON.stringify({ evt: 'register_search', account: accountId, names: out.length, can: out.filter(n => n.can).length }));
  return { ok: true, asked: read.asked, searches_left: left, names: out };
}
