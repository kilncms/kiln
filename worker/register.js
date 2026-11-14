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
 * WHAT IS HERE: looking (the search, the price check, the reading of a
 * registration's state), and ONE function that registers a name:
 * `registerOnce`, in the last part of this file. It is the only place in the
 * whole service that can spend money, and `registerName` is the only place
 * that calls it. `registrar`, the door for looking, knows no call that
 * registers, changes or renews a name, and must never learn one.
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
import { domainsOn, prepareDomain, saveDomain, domainRow } from './domain.js';
import { hostingRow } from './hosted.js';
import { customerMailOn, mailAddress, addressSql, sendOnce, nameYoursMail, dateWords } from './mail.js';

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
    // The press that registers a name, and how a registration stands.
    case 'tick_first': return 'Tick the box to say you checked the spelling, then press Register again.';
    case 'taken_since': return `Someone registered ${name} a moment ago. Nothing was registered for you. Choose another name.`;
    case 'price_moved': return 'The price of this name just went up and your plan no longer covers it. Nothing was registered for you. Choose another name.';
    case 'failed': return `${name} could not be registered. Nothing was charged and your plan still includes a domain. Choose a name and try again.`;
    case 'stuck': return `Registering ${name} stopped part way and a person at Kiln has been told. You do not need to do anything. We will email you within one working day.`;
    case 'being_registered': return `${name} is being registered for this site right now. Wait for it to finish.`;
    case 'daily_limit': return 'Kiln has registered as many names as it can today. Nothing was registered for you. Come back tomorrow and choose the name again.';
    case 'off': return 'Kiln is not registering new domains right now. Nothing was changed. Try again later, or email info@kilncms.com.';
    case 'busy': return 'Kiln is already working on this site. Wait a moment and look again.';
    case 'check_failed': return 'Kiln could not check this name just now. Nothing was registered for you. Try again in a minute.';
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
    return standIn(env, ask, args);
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
// prices Cloudflare gave on 2026-11-13. Once a name has been asked for
// (`registerOnce` wrote its row; with the stand-in it sends nothing), the
// reading of its state goes by the first letters too: "fail…" failed,
// "stuck…" needs a person, "slow…" is in progress for three minutes, and
// every other name succeeded.
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
function standIn(env, ask, args) {
  const answer = (domains) => ({ http: 200, ok: true, result: { domains: domains.filter(Boolean) }, errors: [] });
  if (ask === 'search') {
    const label = String(args.q ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 63);
    return answer(['com', 'net', 'org', 'us', 'info', 'site'].map(e => standInLine(`${label}.${e}`)));
  }
  if (ask === 'check') return answer((args.names || []).slice(0, LIMITS.namesChecked).map(standInLine));
  return standInStatus(env, String(args.name ?? '').toLowerCase());
}
const STANDIN_SLOW_MS = 3 * 60 * 1000;
async function standInStatus(env, name) {
  let row = null;
  try { row = await env.kiln_cloud.prepare("SELECT asked_at, created_at FROM registrations WHERE name = ? AND state != 'failed' ORDER BY created_at DESC LIMIT 1").bind(name).first(); } catch { row = null; }
  const parts = nameParts(name);
  // A name nobody asked for: Cloudflare says so in these words.
  if (!row || !parts) return { http: 404, ok: false, result: null, errors: [{ code: 10000, message: `No workflow found for ${name}` }] };
  const began = Number(row.asked_at || row.created_at) || Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const say = (state, more = {}) => ({ http: 200, ok: true, errors: [], result: { domain_name: name, state, completed: state === 'succeeded' || state === 'failed', created_at: iso(began), updated_at: iso(Date.now()), ...more } });
  if (parts.label.startsWith('fail')) return say('failed', { error: { code: 'registration_failed', message: 'The stand-in fails every name that begins with "fail".' } });
  if (parts.label.startsWith('stuck')) return say('action_required');
  if (parts.label.startsWith('slow') && Date.now() - began < STANDIN_SLOW_MS) return say('in_progress');
  return say('succeeded', { context: { registration: { domain_name: name, status: 'active', created_at: iso(began), expires_at: iso(began + 365 * DAY), auto_renew: true, privacy_mode: 'redaction', locked: true } } });
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

// ─── Registering a name: once ─────────────────────────────────────────────────
//
// THE MONEY RULE. One function below, `registerOnce`, sends the call that
// registers a name, and one place calls it: `registerName`, for the request
// whose insert of the row changed a row. Nothing else may ever send it: not a
// retry, not a second call after a timeout, not the timer, not an admin
// route. A press, a tab or a retry that finds a row standing is answered
// with that row. A row is freed only by Cloudflare's own word "failed" (or by
// its "No workflow found" right after it refused the call), never by silence:
// after fifteen minutes of not knowing, the row is `stuck` and a person looks.

const MIN = 60 * 1000;
export const TIMES = {
  lockS: 60,                // one press at a time for a site (a courtesy: the table's unique rules are the guard)
  lookEveryMs: 10 * 1000,   // the state route asks Cloudflare how a registration stands at most this often
  stuckAfterMs: 15 * MIN,   // this long without Cloudflare's word, and a person must look
  leaveAfterMs: 60 * DAY,   // the rules for domain names let a name move from this long after it is registered
  lateAfterMs: HOUR,        // a registered name that is still not on its site after this long: the operator is told
  failedShownMs: HOUR,      // a try that failed is shown on the site's row for this long
  yearMs: 365 * DAY,
};
const PER_RUN = 20;         // the five-minute job looks at this many registrations at most
const STANDING = ['asking', 'stuck', 'registered'];
const changed = (r) => Number(r && r.meta && r.meta.changes) > 0;
const usd = (c) => (c === null || c === undefined || !Number.isFinite(Number(c)) ? 'not known' : `$${(Number(c) / 100).toFixed(2)}`);
const short = (v, n = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const teller = (env, notify) => async (subject, lines) => {
  try { if (typeof notify === 'function') await notify(env, subject, lines); } catch { /* a note that could not go never stops the work */ }
};
const rowById = (env, id) => env.kiln_cloud.prepare('SELECT * FROM registrations WHERE id = ?').bind(id).first();
const writtenToday = async (env, now) => Number((await env.kiln_cloud.prepare('SELECT COUNT(*) AS n FROM registrations WHERE created_at > ?').bind(now - DAY).first())?.n) || 0;
// The site a registration is for, with its owner's address for the one email. The address never goes into a log line.
async function siteOf(env, siteId) {
  try {
    return (await env.kiln_cloud.prepare(`SELECT s.id, s.repo, s.origin, ${await addressSql(env)} FROM sites s LEFT JOIN accounts a ON a.id = s.account_id WHERE s.id = ?`).bind(siteId).first()) || { id: siteId };
  } catch { return { id: siteId }; }
}

/** What the dashboard is told about a registration. No price: the customer pays none. */
export function publicRegistration(row) {
  if (!row) return null;
  const name = row.name, since = Number(row.asked_at || row.created_at) || null;
  if (row.state === 'asking') return { name, state: 'asking', since };
  if (row.state === 'stuck') return { name, state: 'stuck', since, sentence: registerSentence('stuck', { name }) };
  if (row.state === 'failed') return { name, state: 'failed', sentence: registerSentence('failed', { name }) };
  const at = Number(row.registered_at) || null;
  return {
    name, state: row.state, registered_at: at,
    runs_until: Number(row.expires_at) || (at ? at + TIMES.yearMs : null),
    renews: !!row.renews,
    leave_from: at ? at + TIMES.leaveAfterMs : null,
    leave_asked: !!row.leave_asked_at,
  };
}

/**
 * THE ONE PLACE THAT CAN SPEND MONEY, with ONE caller (`registerName`).
 *
 * It writes the row and, only when its own insert changed a row, sends the
 * one call that registers a name. The two are kept in one function so that
 * the call cannot be reached by any other way than through a row that was
 * written this very moment:
 *   · The insert is INSERT … ON CONFLICT DO NOTHING against the table's three
 *     unique rules (one name for a subscription, one at a time for a site,
 *     one row for a name). A row that is `asking`, `stuck` or `registered`
 *     makes the insert change nothing, and then nothing is sent.
 *   · The same statement counts the rows written in the last 24 hours, so
 *     the day's limit cannot be passed by two presses at once either.
 *   · The switch is asked again here, so that a mistake anywhere else in the
 *     service cannot reach Cloudflare.
 *   · There is no retry and no second try in here, whatever comes back.
 * With the stand-in nothing leaves the service.
 *
 * Answers { won: false } when nothing was written, and otherwise
 * { won: true, answer, none, ms }. `answer` is { http, ok, refused, state,
 * errors }, or null when no answer could be read (`none` says why): then
 * nobody knows whether Cloudflare began, and nothing is sent again, ever.
 * Throws RegisterError('off') or ('not_a_name') before anything is written.
 */
export async function registerOnce(env, row, { now = Date.now() } = {}) {
  if (!registerOn(env)) throw new RegisterError('off');
  if (!row || !row.id || !row.site_id || !row.account_id || !row.subscription_id || !mayAsk(row.name)) throw new RegisterError('not_a_name');
  const holder = holderOf(env), first = row.price_first ?? null, renew = row.price_renew ?? null;
  const wrote = await env.kiln_cloud.prepare(
    `INSERT INTO registrations (id, site_id, account_id, subscription_id, name, state, holder, price_first, price_renew, asked_at, renews, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, 'asking', ?, ?, ?, ?, 1, ?, ?
      WHERE (SELECT COUNT(*) FROM registrations WHERE created_at > ?) < ?
     ON CONFLICT DO NOTHING`)
    .bind(row.id, row.site_id, row.account_id, String(row.subscription_id), row.name, holder, first, renew, now, now, now, now - DAY, dailyMax(env)).run();
  if (!changed(wrote)) return { won: false };
  console.log(JSON.stringify({ evt: 'register_asked', site: row.site_id, name: row.name, subscription: String(row.subscription_id), first, renew, holder }));

  const started = Date.now();
  let answer = null, none = '';
  try {
    if (standInAsked(env)) {
      // `registerOn` above has made sure the stand-in is allowed here. Nothing leaves the service.
      answer = { http: 202, ok: true, refused: false, state: 'in_progress', errors: [] };
    } else {
      const res = await fetch(`${CF}/accounts/${env.HOSTING_ACCOUNT_ID}/registrar/registrations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.HOSTING_API_TOKEN}`, 'Content-Type': 'application/json', Prefer: 'respond-async' },
        body: JSON.stringify({ domain_name: row.name, years: 1, auto_renew: true, privacy_mode: 'redaction' }),
        signal: AbortSignal.timeout(15000),
      });
      let data = null;
      try { data = await res.json(); } catch { /* an answer that cannot be read is no word either way */ }
      answer = {
        http: res.status, ok: res.ok && !!data && data.success !== false, refused: !!data && data.success === false,
        state: data && data.result && typeof data.result.state === 'string' ? data.result.state.slice(0, 40) : null,
        errors: Array.isArray(data?.errors) ? data.errors.map(e => ({ code: Number(e?.code) || 0, message: short(e?.message, 200) })) : [],
      };
    }
  } catch (e) { none = short(e?.message || e, 200); }
  return { won: true, answer, none, ms: Date.now() - started };
}

/**
 * The press that registers a name for a site: the design's steps 1 to 5.
 * `site` is the site its owner asked for (the route has made sure of that),
 * `name` what was chosen and `checked` the ticked box. `notify` writes to the
 * operator and `up(hostingRow)` says whether a site is up on Kiln's hosting;
 * both come from cloud.js. Answers { status, body } for the route to send.
 */
export async function registerName(env, { site, name: typed, checked }, { notify = null, up = () => false, now = Date.now() } = {}) {
  const name = String(typed ?? '').trim().toLowerCase();
  const refuse = (code, status, { sentence = code, about = name, ...more } = {}) => ({ status, body: { error: registerSentence(sentence, { name: about || undefined }), code, ...more } });
  const tell = teller(env, notify);

  // 1. No call yet.
  if (!registerOn(env)) return refuse('off', 503);
  if (!nameParts(name)) return refuse('letters_only', 400);
  if (!mayAsk(name)) return refuse('ending', 400);
  if (checked !== true) return refuse('tick_first', 400);
  const db = env.kiln_cloud;
  const full = await db.prepare('SELECT id, account_id, repo, plan, status, ls_subscription_id, billing_period, paid_until FROM sites WHERE id = ?').bind(site && site.id).first();
  if (!full) return refuse('not_paid', 403);
  const sub = full.ls_subscription_id ? String(full.ls_subscription_id) : null;
  // A row that stands for this site or this subscription answers every later press, tab and retry.
  const standing = async () => {
    const mine = (await db.prepare("SELECT * FROM registrations WHERE (site_id = ? OR subscription_id = ?) AND state != 'failed' ORDER BY created_at DESC").bind(full.id, sub).all()).results || [];
    return mine.find(r => r.site_id === full.id && STANDING.includes(r.state)) || mine.find(r => r.subscription_id === sub) || null;
  };
  const answerWith = (r) => refuse(r.state === 'asking' ? 'being_registered' : r.state === 'stuck' ? 'stuck' : 'has_name', 409, { about: r.name, registration: publicRegistration(r) });
  const overTheDay = async (n) => {
    // The operator is told once in a day, however many presses are refused.
    const marker = `regnote:daily:${new Date(now).toISOString().slice(0, 10)}`;
    try {
      if (!(await env.KILN.get(marker))) {
        await env.KILN.put(marker, String(now), { expirationTtl: 2 * 86400 });
        await tell('Kiln has reached its limit of new domains for today', [
          `Registrations written in the last 24 hours: ${n}. The limit (REGISTER_DAILY_MAX) is ${dailyMax(env)}.`,
          `The owner of ${full.repo || full.id} chose ${name} and was told to come back tomorrow. Nothing was registered for them.`,
          'Nobody else can register a name through Kiln until the oldest of these is a day old. Raise the limit only if these registrations are ones you expected.',
        ]);
      }
    } catch { /* the press is refused all the same */ }
    return refuse('daily_limit', 429);
  };

  const there = await standing();
  if (there) return answerWith(there);
  const had = (await db.prepare("SELECT site_id, subscription_id, name, state, asked_at, registered_at, created_at FROM registrations WHERE account_id = ? AND state != 'failed'").bind(full.account_id).all()).results || [];
  const stop = offerStop({ site: full, up: !!up(await hostingRow(env, full.id)), domain: await domainRow(env, full.id), had, now });
  if (stop) return refuse(stop.why, stop.why === 'not_paid' ? 403 : 409, { about: stop.name || name });
  const today = await writtenToday(env, now);
  if (today >= dailyMax(env)) return overTheDay(today);

  const lock = `registerlock:${full.id}`;
  if (await env.KILN.get(lock)) return refuse('busy', 409);
  await env.KILN.put(lock, '1', { expirationTtl: TIMES.lockS });
  try {
    // 2. The name and its price, asked again now. Nothing is written when it may not be had.
    let line = null;
    try {
      const asked = await registrar(env, 'check', { names: [name] });
      if (!asked.ok || !Array.isArray(asked.result?.domains)) return refuse('check_failed', 502);
      line = asked.result.domains.find(d => d && String(d.name).toLowerCase() === name) || null;
    } catch { return refuse('check_failed', 502); }
    const why = whyNot(line, env);
    if (why === 'taken') return refuse('taken', 409, { sentence: 'taken_since' });
    if (why === 'costs_more' || why === 'premium') return refuse('price_moved', 409);
    if (why) return refuse(why, 409);
    const prices = pricesOf(line);

    // 3 and 4. The row, and for the one request whose insert wrote it, the one call.
    const row = { id: crypto.randomUUID(), site_id: full.id, account_id: full.account_id, subscription_id: sub, name, price_first: prices.first, price_renew: prices.renew };
    let sent;
    try { sent = await registerOnce(env, row, { now }); }
    catch (e) { if (e instanceof RegisterError) return refuse('off', 503); throw e; }
    if (!sent.won) {
      const other = await standing();
      if (other) return answerWith(other);
      if (await db.prepare("SELECT id FROM registrations WHERE name = ? AND state != 'failed'").bind(name).first()) return refuse('taken', 409, { sentence: 'taken_since' });
      const n = await writtenToday(env, now);
      return n >= dailyMax(env) ? overTheDay(n) : refuse('busy', 409);
    }

    // 5. What came back is written down. Whatever it was, nothing is sent again.
    const a = sent.answer;
    console.log(JSON.stringify({ evt: 'register_answered', site: full.id, name, http: a ? a.http : 0, state: a ? a.state : null, ms: sent.ms }));
    const said = a ? short(`${a.http} ${a.state || a.errors.map(e => `${e.code} ${e.message}`).join('; ')}`) : short(`no answer: ${sent.none}`);
    await db.prepare("UPDATE registrations SET answered_at = ?, reason = ?, updated_at = ? WHERE id = ? AND state = 'asking'").bind(a ? now : null, said, now, row.id).run();
    if (a && a.refused && a.http >= 400 && a.http < 500) {
      // Cloudflare itself refused. One look says whether anything was started: its "No workflow found" means nothing was.
      let st = null;
      try { st = await registrar(env, 'status', { name }); } catch { st = null; }
      if (st && st.http === 404 && st.errors.some(e => /no workflow found/i.test(e.message))) {
        const freed = await db.prepare("UPDATE registrations SET state = 'failed', reason = ?, updated_at = ? WHERE id = ? AND state = 'asking'").bind(said, now, row.id).run();
        if (changed(freed)) {
          console.log(JSON.stringify({ evt: 'register_failed', site: full.id, name, reason: said }));
          await tell(`Kiln could not register ${name}`, failedLines({ name, repo: full.repo, siteId: full.id, reason: said }));
        }
        return refuse('failed', 502);
      }
    }
    return { status: 200, body: { ok: true, registration: publicRegistration(await rowById(env, row.id)) } };
  } finally {
    try { await env.KILN.delete(lock); } catch { /* it runs out by itself */ }
  }
}

const failedLines = ({ name, repo, siteId, reason }) => [
  `Domain: ${name}`,
  `Site: ${repo || 'not known'} (${siteId})`,
  `Cloudflare's reason: ${reason || 'none given'}`,
  'Cloudflare says nothing was registered. The customer was told that nothing was charged and may choose a name again.',
];

/**
 * The look: how a registration that was asked for stands at Cloudflare. It
 * only ever reads (`registration-status`); it can never register anything.
 * `every` is how long ago the last look must be (the state route's ten
 * seconds; the timer passes 0), and of two looks at once only one goes on.
 *   succeeded                 → `registered`; the one update that changed the
 *                               row tells the operator, emails the customer
 *                               and puts the site on the name (step 7)
 *   pending, in_progress      → left as it is
 *   failed                    → `failed` with Cloudflare's reason: the right is free again
 *   action_required, blocked  → `stuck`, and the operator is told at once
 *   anything else (404, an error, no answer) → left until the row is fifteen
 *                               minutes old, then `stuck`. Never freed.
 * Answers the row as it now stands. Never throws.
 */
export async function settle(env, row, { notify = null, up = () => false, now = Date.now(), every = TIMES.lookEveryMs } = {}) {
  try {
    if (!row || row.state !== 'asking' || !registerOn(env)) return row;
    const db = env.kiln_cloud;
    const mine = await db.prepare("UPDATE registrations SET checked_at = ?, updated_at = ? WHERE id = ? AND state = 'asking' AND COALESCE(checked_at, 0) <= ?").bind(now, now, row.id, now - every).run();
    if (!changed(mine)) return (await rowById(env, row.id)) || row;
    const tell = teller(env, notify);
    let st = null, none = '';
    try { st = await registrar(env, 'status', { name: row.name }); } catch (e) { none = short(e instanceof RegisterError ? `${e.code} ${e.detail}` : e?.message || e, 200); }
    const state = st && st.ok && st.result ? String(st.result.state || '') : '';
    const stuck = async (reason) => {
      const set = await db.prepare("UPDATE registrations SET state = 'stuck', reason = ?, updated_at = ? WHERE id = ? AND state = 'asking'").bind(short(reason), now, row.id).run();
      if (!changed(set)) return;
      const s = await siteOf(env, row.site_id);
      console.warn(JSON.stringify({ evt: 'register_stuck', site: row.site_id, name: row.name, reason: short(reason) }));
      await tell(`A person must look: registering ${row.name} stopped part way`, [
        `Domain: ${row.name}`,
        `Site: ${s.repo || 'not known'} (${row.site_id})`,
        `What Kiln knows: ${short(reason)}`,
        `Asked of Cloudflare: ${row.asked_at ? new Date(Number(row.asked_at)).toISOString() : 'not known'}. Its first answer: ${row.reason || 'none'}.`,
        `Look for ${row.name} in Cloudflare's dashboard, under Domain Registration, in the hosting account. Kiln will not ask for this name again by itself, and this site cannot get another name until a person has decided.`,
        'The customer was told: a person at Kiln has been told, and we will email you within one working day.',
      ]);
    };

    if (state === 'succeeded') {
      const reg = (st.result.context && st.result.context.registration) || {};
      const at = Date.parse(reg.created_at) || now, until = Date.parse(reg.expires_at) || null;
      const won = await db.prepare("UPDATE registrations SET state = 'registered', reason = NULL, registered_at = ?, expires_at = ?, renews = ?, updated_at = ? WHERE id = ? AND state = 'asking'")
        .bind(at, until, reg.auto_renew === false ? 0 : 1, now, row.id).run();
      if (changed(won)) {
        const fresh = await rowById(env, row.id);
        const s = await siteOf(env, row.site_id);
        const runsUntil = Number(fresh.expires_at) || Number(fresh.registered_at) + TIMES.yearMs;
        console.log(JSON.stringify({ evt: 'registered', site: row.site_id, name: row.name, runs_until: runsUntil }));
        let n = 0;
        try { n = await writtenToday(env, now); } catch { n = 0; }
        await tell(`Kiln registered ${row.name}`, [
          `Domain: ${row.name}`,
          `Site: ${s.repo || 'not known'} (${row.site_id})`,
          `First year: ${usd(fresh.price_first)}. Each year after that: ${usd(fresh.price_renew)}.`,
          `Runs until: ${dateWords(runsUntil)}`,
          `Registrations written in the last 24 hours: ${n}. The limit (REGISTER_DAILY_MAX) is ${dailyMax(env)}.`,
          standInAsked(env) ? 'This was the stand-in on the test service: no name was registered and nothing was charged.' : 'Cloudflare charges the first year to the hosting account.',
        ]);
        try {
          if (customerMailOn(env) && mailAddress(s.email)) {
            await sendOnce(env, `name-yours:${row.id}`, s.email, nameYoursMail({ name: row.name, origin: s.origin, runsUntil, dashboard: env.CLOUD_DASHBOARD || 'https://app.kilncms.com' }));
          }
        } catch { /* the name is theirs all the same; the dashboard says so */ }
        await ontoSite(env, fresh, { up, now });
      }
    } else if (state === 'failed') {
      const err = (st.result && st.result.error) || {};
      const reason = short(`${err.code || ''} ${err.message || ''}`) || 'Cloudflare gave no reason';
      const set = await db.prepare("UPDATE registrations SET state = 'failed', reason = ?, updated_at = ? WHERE id = ? AND state = 'asking'").bind(reason, now, row.id).run();
      if (changed(set)) {
        const s = await siteOf(env, row.site_id);
        console.log(JSON.stringify({ evt: 'register_failed', site: row.site_id, name: row.name, reason }));
        await tell(`Kiln could not register ${row.name}`, failedLines({ name: row.name, repo: s.repo, siteId: row.site_id, reason }));
      }
    } else if (state === 'action_required' || state === 'blocked') {
      await stuck(`Cloudflare says "${state}"`);
    } else if (state !== 'pending' && state !== 'in_progress') {
      // Not knowing. The row waits, and after fifteen minutes a person looks. It is never freed from here.
      if (now - Number(row.asked_at || row.created_at || now) >= TIMES.stuckAfterMs) {
        await stuck(st ? `no word of it at Cloudflare for ${Math.round(TIMES.stuckAfterMs / MIN)} minutes (it answered ${st.http} ${st.errors.map(e => e.message).join('; ') || state})` : `Cloudflare did not answer for ${Math.round(TIMES.stuckAfterMs / MIN)} minutes (${none})`);
      }
    }
    return (await rowById(env, row.id)) || row;
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'register_look_failed', site: row && row.site_id, name: row && row.name, detail: short(e?.message || e) }));
    return row;
  }
}

// The zone Cloudflare holds for a name in the hosting account, or null. Whether registering a name makes its zone by itself is not known, so it is looked for.
async function zoneFor(env, name) {
  const res = await fetch(`${CF}/zones?name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(env.HOSTING_ACCOUNT_ID)}`, { headers: { Authorization: `Bearer ${env.HOSTING_API_TOKEN}` }, signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.success === false || !Array.isArray(data.result)) throw new Error(`zones answered ${res.status}`);
  const zone = data.result.find(z => z && String(z.name).toLowerCase() === name);
  return zone ? String(zone.id) : null;
}

/**
 * Onto the site (the design's step 7): the name Kiln registered becomes a
 * waiting row of the own-domain piece, marked `registered`, which the
 * five-minute job takes to live. The zone is taken up where Cloudflare made
 * one and made where it did not. A name registered at Cloudflare uses
 * Cloudflare's name servers, so nobody has anything to enter. The stand-in
 * stops before this: there is no name to put anything on. Answers
 * { done, why }. Never throws: what fails is tried again by the timer.
 */
export async function ontoSite(env, row, { up = () => false } = {}) {
  try {
    if (!row || row.state !== 'registered' || !registerOn(env) || standInAsked(env)) return { done: false, why: 'not_now' };
    const own = await domainRow(env, row.site_id);
    if (own && (own.state === 'waiting' || own.state === 'live')) return own.name === row.name ? { done: true } : { done: false, why: 'has_own' };
    const host = await hostingRow(env, row.site_id);
    if (!host || !up(host)) return { done: false, why: 'not_hosted' };
    const made = await prepareDomain(env, { name: row.name, worker: host.name, look: null, earlier: await zoneFor(env, row.name) });
    const saved = await saveDomain(env, row.site_id, {
      name: row.name, zone_id: made.zoneId, state: 'waiting', ns1: made.nameServers[0], ns2: made.nameServers[1],
      old_name_servers: [], seller: null, seller_id: null, records: made.records || [], registered: 1,
    });
    if (!saved) return { done: false, why: 'not_set_up' };
    await env.kiln_cloud.prepare('UPDATE registrations SET zone_id = ?, updated_at = ? WHERE id = ?').bind(made.zoneId, Date.now(), row.id).run();
    console.log(JSON.stringify({ evt: 'register_on_site', site: row.site_id, name: row.name, zone: made.zoneId }));
    return { done: true };
  } catch (e) {
    const why = short(e?.detail || e?.code || e?.message || e);
    console.warn(JSON.stringify({ evt: 'register_on_site_failed', site: row && row.site_id, name: row && row.name, detail: why }));
    return { done: false, why };
  }
}

/** The registration the state route shows for a site: the one that stands, or a try that failed within the last hour. Looks at Cloudflare for one that is still being asked for. */
export async function siteRegistration(env, siteId, tools = {}) {
  const now = tools.now || Date.now();
  try {
    const row = await env.kiln_cloud.prepare('SELECT * FROM registrations WHERE site_id = ? ORDER BY created_at DESC LIMIT 1').bind(siteId).first();
    if (!row) return null;
    const r = row.state === 'asking' ? await settle(env, row, tools) : row;
    return r.state === 'failed' && now - Number(r.updated_at || 0) > TIMES.failedShownMs ? null : r;
  } catch { return null; }
}

/** Each of an account's sites that has a registration standing: { [siteId]: its public form }. Never throws. */
export async function standingForAccount(env, accountId) {
  try {
    const rows = (await env.kiln_cloud.prepare("SELECT * FROM registrations WHERE account_id = ? AND state IN ('asking', 'stuck', 'registered')").bind(accountId).all()).results || [];
    return Object.fromEntries(rows.map(r => [r.site_id, publicRegistration(r)]));
  } catch { return {}; }
}

/**
 * The five-minute job, after the domains. (a) Every registration that is
 * still being asked for is looked at. (b) A registered name with no domain
 * row is put on its site, and the operator is told once when that has not
 * worked an hour after the name was registered. It sends nothing that
 * registers, changes or renews a name. Never throws; a database without the
 * table is left alone.
 */
export async function sweepRegistrations(env, { notify = null, up = () => false, now = Date.now() } = {}) {
  const out = { looked: 0, registered: 0, failed: 0, stuck: 0, onSite: 0, late: 0 };
  try {
    if (!env || !env.kiln_cloud || !(await registerReady(env))) return out;
    const db = env.kiln_cloud;
    const asking = (await db.prepare("SELECT * FROM registrations WHERE state = 'asking' ORDER BY COALESCE(checked_at, 0) ASC LIMIT ?").bind(PER_RUN).all()).results || [];
    for (const r of asking) {
      const after = await settle(env, r, { notify, up, now, every: 0 });
      out.looked++;
      if (after && after.state !== 'asking' && out[after.state] !== undefined) out[after.state]++;
    }
    if (standInAsked(env)) return out;   // the stand-in stops at `registered`
    const loose = (await db.prepare(
      `SELECT r.* FROM registrations r LEFT JOIN domains d ON d.site_id = r.site_id AND d.name = r.name
        WHERE r.state = 'registered' AND d.site_id IS NULL ORDER BY r.registered_at ASC LIMIT ?`).bind(PER_RUN).all()).results || [];
    const tell = teller(env, notify);
    for (const r of loose) {
      const went = await ontoSite(env, r, { up });
      if (went.done) { out.onSite++; continue; }
      if (now - Number(r.registered_at || now) < TIMES.lateAfterMs) continue;
      const marker = `regnote:late:${r.id}`;
      if (await env.KILN.get(marker)) continue;
      await env.KILN.put(marker, String(now));
      out.late++;
      const s = await siteOf(env, r.site_id);
      await tell(`${r.name} is registered and still not on its site after an hour`, [
        `Domain: ${r.name}`,
        `Site: ${s.repo || 'not known'} (${r.site_id})`,
        `What stood in the way on the last try: ${went.why || 'not known'}`,
        'The name is registered and safe. Kiln tries again every five minutes. This note is sent once.',
      ]);
    }
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'register_sweep_failed', detail: short(e?.message || e) }));
  }
  return out;
}
