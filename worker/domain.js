/**
 * A hosted site on its owner's own domain.
 *
 * The owner keeps the domain where they bought it and changes one thing there:
 * its two name servers, to the two Cloudflare gives for it. From then on the
 * domain's DNS is answered from Kiln's hosting account, and the site's Worker
 * answers at the bare name and at `www`. This module does Kiln's side of that:
 *
 *   1. look, and change nothing: who sold the domain, whether it takes email,
 *      what the public DNS shows (lookUp);
 *   2. make everything ready before the owner changes anything: a waiting zone,
 *      a copy of the records Cloudflare can find, the site's two names attached
 *      to its Worker (prepareDomain);
 *   3. see whether the change has taken hold (domainStatus, siteAnswers);
 *   4. put it away again (removeWaitingDomain, detachDomain, exportRecords).
 *
 * The rule above all the others is that email is never broken. A copied record
 * is always set to "DNS only", because Cloudflare copies records as "proxied"
 * and a proxied record that points at another company's service can stop
 * working. Only the website's own records are replaced. And a record the
 * public DNS shows but the copy missed is added, because the copy "is not
 * guaranteed to find all existing DNS records" (Cloudflare's own words).
 *
 * The calls were tried against the real service before this was written
 * (2026-11-12). What was not tried is marked where it is used: the codes
 * Cloudflare refuses a domain with, and what it answers for a zone that is
 * gone.
 *
 * Nothing here knows about accounts, plans or the dashboard: cloud.js decides
 * who may ask, and hosted.js runs the five-minute look. The names it reads
 * from the environment are hosting.js's own:
 *
 *   HOSTING_ACCOUNT_ID   the Cloudflare account that holds customers' sites
 *   HOSTING_API_TOKEN    a token for that account (a secret). For domains it
 *                        must reach zones and DNS as well as Workers.
 */

const CF = 'https://api.cloudflare.com/client/v4';
const RDAP = 'https://rdap.org/domain/';                   // finds the right registry for any ending and sends the question on
const DOH = 'https://cloudflare-dns.com/dns-query';        // the public DNS, asked over HTTPS
const GENERAL_HELP = 'https://developers.cloudflare.com/dns/nameservers/update-nameservers/';
const DAY_MS = 24 * 60 * 60 * 1000;
const CLOUDFLARE_SELLER = 1910;                              // the number Cloudflare sells domains under (its IANA id)

export const LIMITS = {
  waitDays: 25,        // a set-up nobody finished is put away after this (Cloudflare drops a waiting domain at 28)
  lookMs: 8000,        // one question to the registry or the public DNS
  answerMs: 10000,     // the whole check that the site answers at its domain
  redirects: 3,        // followed while checking that
  recordPages: 20,     // pages of 100 records read from a new zone; more than this is not a small business domain
};

export class DomainError extends Error {
  constructor(code, detail = '', codes = []) { super(code); this.code = code; this.detail = String(detail).slice(0, 300); this.codes = codes; }
}

/** True when this service is set up to put a site on its owner's domain at all. */
export function domainsOn(env) {
  return !!(env && env.HOSTING_ACCOUNT_ID && env.HOSTING_API_TOKEN);
}
const need = (env) => { if (!domainsOn(env)) throw new DomainError('not_set_up'); };
const account = (env) => `/accounts/${env.HOSTING_ACCOUNT_ID}`;

const bare = (host) => String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
const upper = (type) => String(type || '').toUpperCase();
// Stops a question that gets no answer. The signal is made per call: one that has run out cannot be used again.
const limit = (ms) => (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined);

// ─── What a person types ──────────────────────────────────────────────────────

// Names Kiln itself hands out. A site's own domain is never one of these.
const OURS = ['kilncms.com', 'workers.dev', 'pages.dev'];

// Endings that are two parts long, so the name a person bought is the three
// last parts ("example.co.uk"), not the two last. This is a short list of the
// common ones, not the whole public list: Cloudflare makes the final call when
// the zone is made, and refuses a name that is not one somebody can own.
const TWO_PART = new Set(('co.uk org.uk me.uk ltd.uk plc.uk net.uk ac.uk gov.uk sch.uk com.au net.au org.au edu.au gov.au id.au co.nz net.nz org.nz ac.nz govt.nz '
  + 'co.za org.za net.za com.br net.br org.br com.mx org.mx co.jp ne.jp or.jp ac.jp co.in net.in org.in firm.in gen.in ind.in co.kr or.kr com.cn net.cn org.cn '
  + 'com.hk com.tw com.sg com.my com.ph co.th co.id com.vn com.pk com.bd com.tr com.ua co.il org.il com.sa com.eg com.ng co.ke com.gh com.ar com.co com.pe '
  + 'com.ve com.ec com.uy com.do com.gt com.pl com.pt com.es com.gr co.at or.at').split(' '));

/**
 * The domain a person means, from what they typed: lowercase, without
 * "https://", "www." or anything after the name, and cut back to the name they
 * bought ("blog.example.com" is "example.com", because the whole domain's name
 * servers are what changes). Throws DomainError('not_a_domain') for anything
 * that is not a domain Kiln can use: an address with a port, an IP address, an
 * email address, a single word, an ending on its own, or one of Kiln's names.
 */
export function cleanDomain(input) {
  const no = () => new DomainError('not_a_domain');
  let host = String(input ?? '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\/\//, '').split(/[/?#]/)[0];
  if (!host || /[@:\s]/.test(host)) throw no();                              // an email address, a port, an IPv6 address
  try { host = new URL(`http://${host}`).hostname; } catch { throw no(); }   // letters outside a to z become their "xn--" spelling
  host = host.replace(/\.$/, '');
  const labels = host.split('.');
  const ending = labels[labels.length - 1];
  if (labels.length < 2 || host.length > 253) throw no();
  if (!labels.every(l => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) throw no();
  if (/^\d+$/.test(ending) || ending.length < 2) throw no();                 // an IP address
  if (OURS.some(o => host === o || host.endsWith(`.${o}`))) throw no();
  const parts = TWO_PART.has(labels.slice(-2).join('.')) ? 3 : 2;
  if (labels.length < parts) throw no();                                     // "co.uk" by itself
  return labels.slice(-parts).join('.');
}

// ─── Looking, and changing nothing ────────────────────────────────────────────

const TYPE_NUMBER = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, DS: 43 };
// Where the common email services keep the key that signs a domain's mail.
// There is no way to list these names, so the usual ones are asked for.
const DKIM_NAMES = ['selector1', 'selector2', 'google', 'default', 'k1', 's1', 's2'];

/**
 * The words of a TXT record as one piece. The public DNS (and Cloudflare)
 * hand them over inside quotation marks, in pieces of 255 letters at most.
 */
export function txtWords(data) {
  const s = String(data ?? '').trim();
  if (!s.startsWith('"')) return s;
  const pieces = [];
  const quoted = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = quoted.exec(s))) pieces.push(m[1].replace(/\\(.)/g, '$1'));
  return pieces.join('');
}

/** One question to the public DNS. The answers at that name of that type, or null when it could not be asked. */
async function ask(fetchImpl, name, type) {
  try {
    const res = await fetchImpl(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: limit(LIMITS.lookMs) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.Status !== 0 && data.Status !== 3) return null;   // 3 is "no such name", which is an answer
    // A name that points on to another (a CNAME) is answered with the other
    // name's records too. Only what is at the name itself is this name's.
    return (data.Answer || []).filter(a => a.type === TYPE_NUMBER[type] && bare(a.name) === name).map(a => String(a.data ?? ''));
  } catch { return null; }
}

/** What the registry says about a domain: who sold it, its name servers, whether DNSSEC is on. Null when it could not be read. */
async function readRegistry(fetchImpl, name) {
  try {
    const res = await fetchImpl(`${RDAP}${name}`, { headers: { accept: 'application/rdap+json' }, redirect: 'follow', signal: limit(LIMITS.lookMs) });
    if (!res.ok) return null;
    const d = await res.json();
    const registrar = (d.entities || []).find(e => (e.roles || []).includes('registrar'));
    let seller = null;
    if (registrar) {
      const id = Number((registrar.publicIds || []).find(p => /iana registrar id/i.test(p.type || ''))?.identifier) || null;
      const fn = ((registrar.vcardArray || [])[1] || []).find(v => v[0] === 'fn');
      const sellerName = (fn && String(fn[3] || '').trim()) || null;
      if (id || sellerName) seller = { name: sellerName, id };
    }
    return {
      seller,
      nameServers: (d.nameservers || []).map(n => bare(n.ldhName)).filter(Boolean),
      dnssec: typeof d.secureDNS?.delegationSigned === 'boolean' ? d.secureDNS.delegationSigned : null,
    };
  } catch { return null; }
}

/**
 * Look at a domain without changing anything: { name, seller: { name, id } or
 * null, nameServers, dnssec: true, false or null, atCloudflare, mail, found }.
 * `found` is what the public DNS shows at the names that matter for email
 * ({ type, name, content, priority? }), so that prepareDomain can add any of
 * them the copy misses. Never throws: a part that could not be read is null
 * (or empty), and the rest is still told.
 *
 * `fetchImpl` is always called as a plain function, never as a method: a
 * Worker's own fetch refuses to be called on another object.
 */
export async function lookUp(name, { fetchImpl = fetch } = {}) {
  const out = { name, seller: null, nameServers: [], dnssec: null, atCloudflare: false, mail: false, found: [] };
  try {
    const asks = [['MX', name], ['TXT', name], ['TXT', `_dmarc.${name}`],
      ...DKIM_NAMES.flatMap(s => [['CNAME', `${s}._domainkey.${name}`], ['TXT', `${s}._domainkey.${name}`]])];
    const [registry, ds, ns, ...answers] = await Promise.all([
      readRegistry(fetchImpl, name), ask(fetchImpl, name, 'DS'), ask(fetchImpl, name, 'NS'),
      ...asks.map(([type, at]) => ask(fetchImpl, at, type)),
    ]);
    out.seller = registry?.seller || null;
    out.atCloudflare = Number(out.seller?.id) === CLOUDFLARE_SELLER;
    out.nameServers = registry?.nameServers?.length ? registry.nameServers : (ns || []).map(bare).filter(Boolean);
    // DNSSEC is on when the registry says so, or when the public DNS shows the
    // record that switches it on (a DS record). Either one is enough to stop:
    // being wrong the other way takes the domain off the air.
    const signed = registry ? registry.dnssec : null;
    const shown = ds === null ? null : ds.length > 0;
    out.dnssec = (signed === true || shown === true) ? true : (signed === false || shown === false) ? false : null;

    const seen = new Set();
    asks.forEach(([type, at], i) => {
      for (const data of answers[i] || []) {
        let rec = null;
        if (type === 'MX') { const m = /^(\d+)\s+(\S+)$/.exec(data.trim()); if (m) rec = { type, name: at, content: bare(m[2]) || '.', priority: Number(m[1]) }; }
        else if (type === 'TXT') rec = { type, name: at, content: txtWords(data) };
        else rec = { type, name: at, content: bare(data) };
        if (!rec || !rec.content || seen.has(recordKey(rec))) continue;
        seen.add(recordKey(rec));
        out.found.push(rec);
      }
    });
    // "0 ." is how a domain says it takes no email at all.
    out.mail = out.found.some(r => r.type === 'MX' && r.name === name && r.content !== '.');
  } catch { /* what was read so far is the answer */ }
  return out;
}

/** What must be done before a domain can be set up, as a code for domainSentence, or null when nothing stands in the way. */
export function whatStops(look) {
  if (look && look.atCloudflare) return 'at_cloudflare';
  if (look && look.dnssec === true) return 'dnssec_on';
  return null;
}

// ─── The companies that sell domains ──────────────────────────────────────────

// Each seller's own page on changing name servers, by the number the seller is
// registered under (its IANA id), or by its name when the registry gave no
// number. A page is here only when it answered on 2026-11-12; a seller with no
// page of its own here gets Cloudflare's general one.
const SELLERS = [
  { ids: [146], match: /godaddy/i, name: 'GoDaddy', url: 'https://www.godaddy.com/help/change-my-domain-nameservers-664' },
  { ids: [1068], match: /namecheap/i, name: 'Namecheap', url: 'https://www.namecheap.com/support/knowledgebase/article.aspx/767/10/how-to-change-dns-for-a-domain/' },
  // Google's domains went to Squarespace, under Google's old number.
  { ids: [895], match: /squarespace|google/i, name: 'Squarespace', url: 'https://support.squarespace.com/hc/en-us/articles/4404183898125-Review-change-or-reset-your-domain-s-nameservers' },
  { ids: [69], match: /tucows|hover/i, name: 'Hover (Tucows)', url: 'https://support.hover.com/support/solutions/articles/201000064742' },
  { ids: [2], match: /network solutions/i, name: 'Network Solutions', url: null },
  { ids: [625], match: /name\.com/i, name: 'Name.com', url: 'https://www.name.com/support/articles/205934547-changing-nameservers-for-dns-management' },
  { ids: [1861], match: /porkbun/i, name: 'Porkbun', url: 'https://kb.porkbun.com/article/22-how-to-change-your-nameservers' },
  { ids: [83], match: /ionos|1\s*&\s*1/i, name: 'IONOS', url: 'https://www.ionos.com/help/domains/using-your-own-name-servers/using-your-own-name-servers-for-a-domain/' },
  { ids: [1154], match: /bluehost|fastdomain/i, name: 'Bluehost', url: null },
  { ids: [81], match: /gandi/i, name: 'Gandi', url: 'https://docs.gandi.net/en/domain_names/common_operations/changing_nameservers.html' },
  { ids: [472], match: /dynadot/i, name: 'Dynadot', url: 'https://www.dynadot.com/help/question/set-name-servers' },
  { ids: [3817], match: /\bwix\b/i, name: 'Wix', url: null },
  { ids: [CLOUDFLARE_SELLER], match: /cloudflare/i, name: 'Cloudflare', url: null },
];

/**
 * Where a seller explains how to change name servers: { name, url, known }.
 * `name` is the everyday name of a seller Kiln knows, else the name the
 * registry gave (or null); `url` is always a page that can be opened.
 */
export function sellerHelp(seller) {
  const id = Number(seller?.id) || null;
  const given = String(seller?.name || '').trim();
  const hit = SELLERS.find(s => id && s.ids.includes(id)) || (given ? SELLERS.find(s => s.match.test(given)) : null);
  if (hit) return { name: hit.name, url: hit.url || GENERAL_HELP, known: true };
  return { name: given || null, url: GENERAL_HELP, known: false };
}

// ─── Cloudflare, with the token for the hosting account ───────────────────────

async function cloudflare(env, method, path, { json, text = false } = {}) {
  const headers = { Authorization: `Bearer ${env.HOSTING_API_TOKEN}` };
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  let res;
  try { res = await fetch(`${CF}${path}`, { method, headers, body }); }
  catch (e) { throw new DomainError('cloudflare', `${method} ${path}: ${e?.message || e}`); }
  if (res.status === 204) return { status: 204, result: null, info: null };   // a detached name is answered with nothing at all
  if (text && res.ok) return { status: res.status, result: await res.text(), info: null };
  let data = null;
  try { data = await res.json(); } catch { /* an answer that is not JSON is a failure below */ }
  if (!res.ok || !data || data.success === false) {
    const errors = data?.errors || [];
    const why = errors.map(e => `${e.code || ''} ${e.message || ''}`.trim()).join('; ') || `status ${res.status}`;
    throw new DomainError(res.status === 404 ? 'cloudflare_missing' : 'cloudflare', `${method} ${path}: ${why}`, errors.map(e => Number(e.code)).filter(Boolean));
  }
  return { status: res.status, result: data.result, info: data.result_info || null };
}

/**
 * Why Cloudflare would not make a zone, as one of this module's codes. These
 * refusals were not tried against the real service: the numbers are the ones
 * Cloudflare publishes, and the words of the refusal are read as well, so a
 * number that turns out different still lands on the right sentence.
 */
function zoneRefusal(e) {
  const codes = e?.codes || [];
  const words = String(e?.detail || '');
  const has = (...list) => list.some(c => codes.includes(c));
  if (has(1061) || /already exists/i.test(words)) return 'already_here';
  if (has(1049, 1099) || /not a registered domain|as a registered domain/i.test(words)) return 'not_registered';
  if (has(1097, 1098) || /banned|blocked/i.test(words)) return 'refused';
  if (has(1117, 1118) || /pending zones|limit (of|for) [a-z ]*zones|too many zones/i.test(words)) return 'too_many';
  return 'cloudflare';
}

// ─── A zone's records ─────────────────────────────────────────────────────────

/** Two records are the same when they have the same type, name and content (a TXT record's capitals count, a name's do not). */
function recordKey(r) {
  const type = upper(r.type);
  return `${type} ${bare(r.name)} ${type === 'TXT' ? txtWords(r.content) : bare(r.content)}`;
}

// The records that say where the website is. They point at the old host, and
// a name cannot be given to a Worker while one of them is there.
const isSiteRecord = (r, zone) => ['A', 'AAAA', 'CNAME'].includes(upper(r.type)) && [zone, `www.${zone}`].includes(bare(r.name));
// A note some sellers leave so that other services can find the seller's DNS. It belongs to the DNS that is being left.
const isDomainConnect = (r) => bare(r.name).split('.')[0] === '_domainconnect';
const inZone = (name, zone) => bare(name) === zone || bare(name).endsWith(`.${zone}`);

const MAIL_LABELS = new Set(['mail', 'email', 'webmail', 'smtp', 'imap', 'pop', 'pop3', 'mx', 'autodiscover', 'autoconfig', 'mta-sts', '_mta-sts', '_dmarc']);

/**
 * What a kept record is for, in the three groups the owner is shown:
 * 'mail' (email would stop without it), 'proof' (a note that proves to some
 * service that the owner has the domain), 'other' (every other name).
 */
export function recordKind(r, zone) {
  const type = upper(r.type);
  const name = bare(r.name);
  const under = name === zone ? '' : name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : name;
  const first = under.split('.')[0];
  const words = type === 'TXT' ? txtWords(r.content) : String(r.content || '');
  if (type === 'MX' || MAIL_LABELS.has(first) || /(^|\.)_domainkey$/.test(under) || under.startsWith('_smtp._tls')) return 'mail';
  if (type === 'TXT' && /^v=(spf1|dkim1|dmarc1|stsv1|tlsrptv1)\b/i.test(words)) return 'mail';
  if (type === 'SRV' && /^_(autodiscover|imaps?|pop3s?|submissions?)\./.test(under)) return 'mail';
  if (type === 'TXT' && (/verif|challenge|^ms=/i.test(words) || /verif|challenge/.test(first))) return 'proof';
  if (type === 'CNAME' && first.startsWith('_')) return 'proof';   // how certificate and ownership checks are answered
  return 'other';
}

/** The words the three groups go by where a person reads them. */
export const kindWords = { mail: 'Email', proof: 'Proof-of-ownership notes', other: 'Other names' };

const KIND_ORDER = { mail: 0, proof: 1, other: 2 };

/** The kept records as the owner is shown them, email first: { type, name, content, kind } and an MX record's priority. */
function shown(records, zone) {
  return records.map(r => {
    const type = upper(r.type);
    const out = { type, name: bare(r.name), content: type === 'TXT' ? txtWords(r.content) : (bare(r.content) || '.'), kind: recordKind(r, zone) };
    if (type === 'MX' && r.priority !== undefined && r.priority !== null) out.priority = Number(r.priority);
    return out;
  }).sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}

/** A record the public DNS showed, as Cloudflare is handed it. Always DNS only. */
function toSend(r) {
  const type = upper(r.type);
  const out = { type, name: bare(r.name), ttl: 1 };   // 1 is Cloudflare's "automatic"
  if (type === 'TXT') out.content = `"${txtWords(r.content).replace(/(["\\])/g, '\\$1')}"`;
  else out.content = bare(r.content) || '.';
  if (type === 'MX') out.priority = Number(r.priority) || 0;
  if (['A', 'AAAA', 'CNAME'].includes(type)) out.proxied = false;
  return out;
}

async function allRecords(env, zoneId) {
  const all = [];
  for (let page = 1; ; page++) {
    // Stopping short would leave records proxied that nobody looked at, so too many is a failure, not a shorter list.
    if (page > LIMITS.recordPages) throw new DomainError('cloudflare', `more than ${LIMITS.recordPages * 100} records`);
    const got = await cloudflare(env, 'GET', `/zones/${zoneId}/dns_records?per_page=100&page=${page}`);
    all.push(...(got.result || []));
    if (page >= Number(got.info?.total_pages || 1)) return all;
  }
}

/** The names attached to Workers in one zone. The zone is checked here as well as asked for, so another site's name is never touched. */
async function workerNames(env, zoneId) {
  let list;
  try { list = (await cloudflare(env, 'GET', `${account(env)}/workers/domains?zone_id=${encodeURIComponent(zoneId)}`)).result || []; }
  catch (e) { if (e instanceof DomainError && e.code === 'cloudflare_missing') return []; throw e; }
  return list.filter(d => d && d.id && d.zone_id === zoneId);
}

async function detach(env, id) {
  try { await cloudflare(env, 'DELETE', `${account(env)}/workers/domains/${encodeURIComponent(id)}`); }
  catch (e) { if (!(e instanceof DomainError && e.code === 'cloudflare_missing')) throw e; }   // already detached
}

/** Take a zone away, with the names in it that are attached to a Worker. Only ever called for a zone that never took hold. */
async function dropZone(env, zoneId) {
  // Whether Cloudflare detaches a zone's names when the zone goes was not
  // tried, so they are detached first. If that fails the zone still goes.
  try { for (const d of await workerNames(env, zoneId)) await detach(env, d.id); } catch { /* the zone's removal is what counts */ }
  try { await cloudflare(env, 'DELETE', `/zones/${zoneId}`); }
  catch (e) { if (!(e instanceof DomainError && e.code === 'cloudflare_missing')) throw e; }
}

// ─── Making everything ready ──────────────────────────────────────────────────

/**
 * Make a domain ready for its site, before its owner changes anything:
 *
 *   1. make the zone (it waits until the name servers change);
 *   2. let Cloudflare copy the records it can find;
 *   3. delete the website's records (A, AAAA and CNAME at the bare name and at
 *      `www`) and the seller's `_domainconnect` note, and set every other
 *      record to DNS only;
 *   4. add what `look.found` shows that the copy missed;
 *   5. attach the bare name and `www` to the Worker named `worker`.
 *
 * Returns { zoneId, nameServers: [a, b], records: [{ type, name, content,
 * kind }], attached: [{ hostname, id }] }. `records` is every record kept, so
 * the owner can compare it with the seller's list.
 *
 * Throws a DomainError and makes nothing when `look` says DNSSEC is on or the
 * domain was bought at Cloudflare. When Cloudflare refuses the domain the code
 * is 'not_registered', 'already_here', 'refused' or 'too_many'. When a step
 * after the zone was made fails, the zone is deleted again first, so a failed
 * try leaves nothing behind. A zone that was already there is never deleted:
 * it may be a domain that is live.
 */
export async function prepareDomain(env, { name, worker, look = null }) {
  need(env);
  const stop = whatStops(look);
  if (stop) throw new DomainError(stop);

  let zone;
  try { zone = (await cloudflare(env, 'POST', '/zones', { json: { name, account: { id: env.HOSTING_ACCOUNT_ID }, type: 'full' } })).result || {}; }
  catch (e) { throw new DomainError(zoneRefusal(e), e?.detail || e?.message || '', e?.codes || []); }
  const zoneId = zone.id;

  try {
    const nameServers = (zone.name_servers || []).map(bare).filter(Boolean).slice(0, 2);
    if (!zoneId || nameServers.length < 2) throw new DomainError('cloudflare', 'the new zone came without an id or without two name servers');
    const records = `/zones/${zoneId}/dns_records`;
    await cloudflare(env, 'POST', `${records}/scan`);

    const kept = [];
    for (const r of await allRecords(env, zoneId)) {
      if (isSiteRecord(r, name) || isDomainConnect(r)) { await cloudflare(env, 'DELETE', `${records}/${r.id}`); continue; }
      if (r.proxied) await cloudflare(env, 'PATCH', `${records}/${r.id}`, { json: { proxied: false } });
      kept.push(r);
    }

    const have = new Set(kept.map(recordKey));
    for (const f of (look && look.found) || []) {
      if (!f || !inZone(f.name, name) || isSiteRecord(f, name) || isDomainConnect(f) || have.has(recordKey(f))) continue;
      // A name that points on to another (a CNAME) can hold nothing else, so
      // where the copy and the public DNS disagree about such a name, the copy stays.
      if (kept.some(k => bare(k.name) === bare(f.name) && (upper(k.type) === 'CNAME' || upper(f.type) === 'CNAME'))) continue;
      await cloudflare(env, 'POST', records, { json: toSend(f) });
      kept.push(f);
      have.add(recordKey(f));
    }

    const attached = [];
    for (const hostname of [name, `www.${name}`]) {
      const made = (await cloudflare(env, 'PUT', `${account(env)}/workers/domains`, { json: { hostname, service: worker, zone_id: zoneId, environment: 'production' } })).result || {};
      attached.push({ hostname, id: made.id || null });
    }
    return { zoneId, nameServers, records: shown(kept, name), attached };
  } catch (e) {
    const detail = e instanceof DomainError ? e.detail : String(e?.message || e);
    if (zoneId) {
      try { await dropZone(env, zoneId); }
      catch (gone) { console.warn(JSON.stringify({ evt: 'domain_cleanup_failed', name, zone: zoneId, detail: String(gone?.detail || gone?.message || gone).slice(0, 200) })); }
    }
    throw new DomainError('cloudflare', detail, e instanceof DomainError ? e.codes : []);
  }
}

// ─── Has the change taken hold ────────────────────────────────────────────────

const STATUS = { pending: 'waiting', initializing: 'waiting', active: 'active', moved: 'moved', deleted: 'gone' };

/**
 * Where a domain stands: { status, nameServers }. 'waiting' until its name
 * servers are changed, 'active' once they are, 'moved' when they were changed
 * away again, 'gone' when Cloudflare no longer has the zone. With `recheck`,
 * Cloudflare is first asked to look at the name servers again now.
 */
export async function domainStatus(env, { zoneId, recheck = false }) {
  need(env);
  if (recheck) {
    // Cloudflare takes this request only so often. When it will not, what it last saw is still the answer.
    try { await cloudflare(env, 'PUT', `/zones/${zoneId}/activation_check`); } catch { /* see above */ }
  }
  let zone;
  try { zone = (await cloudflare(env, 'GET', `/zones/${zoneId}`)).result || {}; }
  // What Cloudflare answers for a zone it has deleted was not tried: a plain "not found" is taken to mean gone.
  catch (e) { if (e instanceof DomainError && e.code === 'cloudflare_missing') return { status: 'gone', nameServers: [] }; throw e; }
  const status = STATUS[zone.status];
  // A status this module has no word for is a failure, so that nothing is decided on a guess.
  if (!status) throw new DomainError('cloudflare', `zone status ${zone.status}`);
  return { status, nameServers: (zone.name_servers || []).map(bare).filter(Boolean).slice(0, 2) };
}

/**
 * True when https://<name>/ answers 200. A redirect is followed three times at
 * most, and only while it stays on the name or its `www`. The whole check has
 * ten seconds. Never throws.
 */
export async function siteAnswers(name, { fetchImpl = fetch } = {}) {
  const ours = new Set([name, `www.${name}`]);
  const signal = limit(LIMITS.answerMs);
  let url = `https://${name}/`;
  try {
    for (let hop = 0; hop <= LIMITS.redirects; hop++) {
      const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal });
      if (res.status === 200) return true;
      if (![301, 302, 303, 307, 308].includes(res.status)) return false;
      const next = new URL(res.headers.get('location') || '', url);
      if (next.protocol !== 'https:' || !ours.has(next.hostname)) return false;
      url = next.href;
    }
  } catch { /* no answer is a no */ }
  return false;
}

// ─── Putting it away ──────────────────────────────────────────────────────────

/**
 * Detach a domain's bare name and `www` from their Worker, and leave the zone
 * and every other record as they are: the owner's email is still answered
 * from this zone for as long as the name servers point here. Returns
 * { detached: [hostnames] }.
 */
export async function detachDomain(env, { zoneId, name }) {
  need(env);
  const ours = new Set([name, `www.${name}`]);
  const detached = [];
  for (const d of await workerNames(env, zoneId)) {
    if (!ours.has(bare(d.hostname))) continue;
    await detach(env, d.id);
    detached.push(bare(d.hostname));
  }
  return { detached };
}

/**
 * Delete a zone that never took hold. A zone that is active or moved is left
 * alone, because it may still be answering for somebody's email: Cloudflare
 * removes it by itself a week after the name servers move away. Returns
 * { removed, status }: `removed` is true when no zone is left.
 */
export async function removeWaitingDomain(env, { zoneId }) {
  const { status } = await domainStatus(env, { zoneId });
  if (status === 'gone') return { removed: true, status };
  if (status !== 'waiting') return { removed: false, status };
  await dropZone(env, zoneId);
  return { removed: true, status };
}

/** Every record of a zone as one text file (the BIND format), for an owner who takes the domain's DNS elsewhere. */
export async function exportRecords(env, { zoneId }) {
  need(env);
  return String((await cloudflare(env, 'GET', `/zones/${zoneId}/dns_records/export`, { text: true })).result || '');
}

// ─── What a person reads ──────────────────────────────────────────────────────

/**
 * The sentence a person reads for each way a domain can stop short of being
 * live. `seller` is the seller's name, or what sellerHelp answered.
 */
export function domainSentence(code, { name = null, seller = null } = {}) {
  const domain = name || 'that domain';
  const who = (typeof seller === 'string' ? seller : seller?.name) || 'the company you bought the domain from';
  switch (code) {
    case 'not_a_domain': return 'That does not look like a domain Kiln can use. Type the name you bought, like yourname.com, with nothing before or after it.';
    case 'not_registered': return `As far as Cloudflare can tell, nobody owns ${domain} yet, so there is nothing to connect. Check the spelling, or buy the domain first and then try again.`;
    case 'already_here': return `Kiln's hosting already has ${domain} set up. If you did not set it up, write to info@kilncms.com and we will sort it out with you.`;
    case 'taken': return `Another site on Kiln already has ${domain} as its address. Stop using it on that site first, or write to info@kilncms.com if that site is not yours.`;
    case 'refused': return `Cloudflare, which runs Kiln's hosting, will not take ${domain}, and Kiln cannot change that. Nothing was changed. Write to info@kilncms.com and we will look at it with you.`;
    case 'too_many': return 'Kiln has too many domains waiting for their name servers to change just now, so it cannot start another one. Nothing was changed. Try again tomorrow, or write to info@kilncms.com.';
    case 'dnssec_on': return `DNSSEC is switched on for ${domain}, and a domain with DNSSEC on stops answering when its name servers change. Switch DNSSEC off at ${who}, wait a day, and then set the domain up here again. Nothing was changed.`;
    case 'at_cloudflare': return `Because ${domain} was bought at Cloudflare, its name servers cannot be changed, so Kiln cannot set it up by itself. Write to info@kilncms.com and we will connect it with you.`;
    case 'not_hosted': return 'Your own domain can be used only for a site that is up on Kiln\'s hosting. Put the site up first, and then come back here.';
    case 'not_set_up': return 'Using your own domain is not switched on for this service yet.';
    case 'not_changed': return `Kiln put this set-up away because the name servers of ${domain} were not changed within ${LIMITS.waitDays} days. Nothing of yours was changed. You can start again any time.`;
    case 'moved': return `The name servers of ${domain} no longer point at Kiln, so the site does not answer at ${domain} any more. It is still up at its Kiln address. To use the domain again, set it up here again.`;
    default: return `Kiln could not finish setting up ${domain} just now. Nothing was changed, and your site and your email are as they were. Try again in a few minutes.`;
  }
}

// ─── What the service remembers (the `domains` table, migration 0006) ─────────

/** The domain of a site, or null. Never fails the page that asks. */
export async function domainRow(env, siteId) {
  try { return await env.kiln_cloud.prepare('SELECT * FROM domains WHERE site_id = ?').bind(siteId).first(); }
  catch { return null; }   // a database migration 0006 has not reached: no site has a domain
}

/**
 * The row that holds a domain now, or null. Only a set-up that is waiting or
 * live holds its name: one that was put away or failed leaves the name free
 * for whoever tries next.
 */
export async function domainForName(env, name) {
  try { return await env.kiln_cloud.prepare("SELECT * FROM domains WHERE name = ? AND state IN ('waiting', 'live')").bind(bare(name)).first(); }
  catch { return null; }
}

const COLUMNS = ['name', 'zone_id', 'state', 'reason', 'ns1', 'ns2', 'seller', 'seller_id', 'records', 'checked_at', 'reminded_at', 'live_at', 'created_at'];

/**
 * Write a site's domain row: made when the site has none, changed otherwise.
 * `records` may be handed over as the list itself. A set-up that starts again
 * (the state becomes 'waiting' from anything else) starts its clock again and
 * forgets the last try's reminder and reason. Returns true when it was
 * written and false when the table is not there yet. Throws
 * DomainError('taken') when another site holds the name.
 */
export async function saveDomain(env, siteId, fields) {
  const now = Date.now();
  let f = {};
  for (const c of COLUMNS) {
    if (fields[c] === undefined) continue;
    f[c] = c === 'records' && fields[c] !== null && typeof fields[c] !== 'string' ? JSON.stringify(fields[c]) : fields[c];
  }
  if (f.name) f.name = bare(f.name);
  try {
    const db = env.kiln_cloud;
    const was = await db.prepare('SELECT state FROM domains WHERE site_id = ?').bind(siteId).first();
    // A row that was put away or failed holds nothing, so it must not keep the name from the site that asks now.
    if (f.name) await db.prepare("DELETE FROM domains WHERE name = ? AND site_id != ? AND state NOT IN ('waiting', 'live')").bind(f.name, siteId).run();
    if (!was) {
      f = { state: 'waiting', created_at: now, ...f, updated_at: now };
      const cols = Object.keys(f);
      await db.prepare(`INSERT INTO domains (site_id, ${cols.join(', ')}) VALUES (?${', ?'.repeat(cols.length)})`).bind(siteId, ...cols.map(c => f[c])).run();
    } else {
      if (f.state === 'waiting' && was.state !== 'waiting') f = { reason: null, checked_at: null, reminded_at: null, live_at: null, created_at: now, ...f };
      const cols = Object.keys(f);
      await db.prepare(`UPDATE domains SET ${cols.map(c => `${c} = ?`).join(', ')}${cols.length ? ', ' : ''}updated_at = ? WHERE site_id = ?`).bind(...cols.map(c => f[c]), now, siteId).run();
    }
    return true;
  } catch (e) {
    const why = String(e?.message || e);
    if (/unique/i.test(why)) throw new DomainError('taken');
    if (/no such table/i.test(why)) return false;
    throw e;
  }
}

/**
 * What the dashboard is told about a site's domain. Never the zone's id: it
 * is the handle the whole domain is moved by, and no page needs it.
 */
export function publicDomain(row) {
  if (!row) return null;
  let records = [];
  try { const parsed = JSON.parse(row.records || '[]'); if (Array.isArray(parsed)) records = parsed; } catch { /* a list that cannot be read is shown as empty */ }
  const help = sellerHelp(row.seller || row.seller_id ? { name: row.seller, id: row.seller_id } : null);
  const out = {
    name: row.name,
    state: row.state,
    name_servers: [row.ns1, row.ns2].filter(Boolean),
    seller: { name: help.name, url: help.url },
    records,
    created_at: row.created_at || null,
    checked_at: row.checked_at || null,
    live_at: row.live_at || null,
  };
  if (row.state === 'live') out.url = `https://${row.name}`;
  if (row.state === 'waiting' && row.created_at) out.waits_until = Number(row.created_at) + LIMITS.waitDays * DAY_MS;
  if (row.state !== 'live' && row.reason) { out.reason = row.reason; out.error = domainSentence(row.reason, { name: row.name, seller: help.name }); }
  return out;
}
