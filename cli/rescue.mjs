/**
 * kiln rescue — escape hatch from walled-garden site builders.
 *
 * Crawls a live site you own (Squarespace, Wix, WordPress.com, Google Sites…),
 * writes a clean static-HTML copy with localized assets, strips the builder's
 * runtime scripts, and auto-tags it for Kiln editing. Output is a folder ready
 * to `git init` and push to any static host.
 *
 *   npx github:kilncms/kiln#release rescue <url> [--out=dir] [--max-pages=N]
 *        [--delay=ms] [--max-asset-mb=N] [--max-total-mb=N]
 *        [--keep-scripts] [--no-tag] [--dry]
 *        [--menu-shim] [--render [--browser=path]] [--try]
 *
 * --render is for sites drawn by JavaScript (Lovable, v0, Bolt and other React
 * apps): each page is opened in a browser already on this machine and saved as
 * it looks once finished. See render.mjs. --try also writes a try-out config,
 * so the copy can be served locally and edited at once.
 *
 * The pure helpers (pageIdentity, mapUrls, fileToHref, cleanPage,
 * rewriteCssUrls, extractRefs, sitemapPages, sitemapIndexChildren,
 * staticLostLines, lostLines, wireKiln, appScripts,
 * looksLikeErrorPage) are exported
 * for tests — no network there.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, serialize } from 'parse5';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// git checkout: assets live one level up; published create-kiln: vendored next to us
const PKG_ROOT = existsSync(path.join(HERE, 'dist', 'kiln.js')) ? HERE : path.resolve(HERE, '..');

const UA = 'kiln-rescue/0.1 (+https://kilncms.com)';
// A font service hands each browser the files that browser can read, and an
// unknown caller gets the oldest and biggest kind. Asked as a current desktop
// browser, it names woff2 files, which every browser of the last ten years reads.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// Font services: a style sheet on the service's host that names font files on
// the service's host. copy says whether the fonts may be kept with the site:
// the open ones may, the rented ones are tied to the account that pays for them.
const ICON_FONT_PATH_RE = /font-?awesome|fortawesome|bootstrap-icons|material-?(design-?)?icons|ionicons|dashicons|themify-icons|line-?awesome|boxicons|remixicon/i;
const FONT_SERVICES = [
  { name: 'Google Fonts', host: /^fonts\.(googleapis|gstatic)\.com$/, copy: true },
  { name: 'Bunny Fonts', host: /^fonts\.bunny\.net$/, copy: true },
  { name: 'Font Awesome', host: /^use\.fontawesome\.com$/, copy: true },
  { name: 'an icon font on a shared file host', host: /^(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|(maxcdn|stackpath|netdna)\.bootstrapcdn\.com)$/, path: ICON_FONT_PATH_RE, copy: true },
  { name: 'Adobe Fonts', host: /^(use|p)\.typekit\.(net|com)$/, copy: false },
  { name: 'Font Awesome Pro', host: /^pro\.fontawesome\.com$/, copy: false },
  { name: 'Monotype Fonts', host: /^fast\.fonts\.(net|com)$/, copy: false },
  { name: 'Hoefler&Co', host: /^cloud\.typography\.com$/, copy: false },
];

/** The font service an address belongs to: { name, copy }, or null for any other address. */
export function fontService(url) {
  let u; try { u = url instanceof URL ? url : new URL(String(url)); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const f = FONT_SERVICES.find(s => s.host.test(u.hostname.toLowerCase()) && (!s.path || s.path.test(u.pathname)));
  return f ? { name: f.name, copy: f.copy } : null;
}

/** The headers one file is asked for with: a font service is asked the way a current desktop browser asks. */
export function headersFor(url) {
  return { 'user-agent': fontService(url) ? BROWSER_UA : UA, accept: '*/*' };
}
const MAX_ASSET_BYTES = 20 * 1024 * 1024;    // per file; --max-asset-mb changes it
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;   // per run; --max-total-mb changes it
const PAGES_FILE_LIMIT_MB = 25;              // Cloudflare Pages refuses a bigger file
// off-origin hosts that are really "the builder's disk" — localize these too
const BUILDER_CDN_RE = /(^|\.)(squarespace-cdn\.com|squarespace\.com|wixstatic\.com|parastorage\.com|wp\.com|wordpress\.com|googleusercontent\.com|cloudfront\.net|fastly\.net|fastly\.com|lovable\.app|lovableproject\.com|lovable\.dev|vercel-storage\.com|supabase\.co)$/i;
const TRACKER_RE = /googletagmanager\.com|google-analytics\.com|doubleclick\.net|googleadservices\.com|connect\.facebook\.net|facebook\.com\/tr|hotjar\.com|clarity\.ms|mc\.yandex|matomo|plausible\.io|segment\.com/i;
// scripts that count visitors or watch what they do: the report names them when they are taken out
const VISITOR_RE = new RegExp(TRACKER_RE.source + '|cloudflareinsights\\.com|usefathom\\.com|goatcounter\\.com|simpleanalyticscdn\\.com|umami\\.is|posthog\\.com|mixpanel\\.com|statcounter\\.com|hs-analytics\\.net|analytics', 'i');
// links that are clearly files, not pages — don't spend crawl budget fetching them
const NON_PAGE_RE = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|json|xml|txt|zip|gz|mp3|mp4|webm|mov|woff2?|ttf|otf|eot)$/i;
const EXT_BY_CT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/avif': '.avif', 'image/svg+xml': '.svg', 'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico', 'text/css': '.css', 'font/woff2': '.woff2',
  'font/woff': '.woff', 'font/ttf': '.ttf', 'font/otf': '.otf',
};

const ok = (s) => console.log(`  ✅ ${s}`);
const info = (s) => console.log(`  ▸ ${s}`);
const warn = (s) => console.log(`  ⚠️  ${s}`);
const fail = (s) => console.log(`  ❌ ${s}`);
const hr = (s) => console.log(`\n━━ ${s} ${'━'.repeat(Math.max(2, 56 - s.length))}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mb = (n) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;

const getAttr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
const setAttr = (node, name, value) => { const a = node.attrs.find(x => x.name === name); if (a) a.value = value; };
const textOf = (node) => (node.childNodes || []).map(c => c.value || '').join('');
/** asset identity: URL minus fragment (a sprite's #icon is not a different file) */
const assetKey = (u) => u.origin + u.pathname + u.search;

/** One site, whatever the address says: http and https of the same host, with
 *  or without a leading "www.", are the same site (old sites mix all four). */
const hostKey = (u) => u.hostname.toLowerCase().replace(/^www\./, '') + (u.port ? ':' + u.port : '');
export function sameSite(a, b) {
  try { return hostKey(a instanceof URL ? a : new URL(a)) === hostKey(b instanceof URL ? b : new URL(b)); } catch { return false; }
}
/** asset identity, with a same-site address written the way `base` writes it,
 *  so http://site/x.jpg and https://www.site/x.jpg are one file */
const siteKey = (u, base) => sameSite(u, base) ? base.origin + u.pathname + u.search : assetKey(u);

function walkTree(node, fn) {
  fn(node);
  for (const c of [...(node.childNodes || [])]) walkTree(c, fn);
  if (node.content) walkTree(node.content, fn);   // <template>
}

// ─── pure: URL → file mapping ────────────────────────────────────────────────

/** Endings WordPress uses, when its addresses are left "plain", to name a
 *  page: ?p=14 is a post, ?page_id=2 a page, ?cat=5 a category, ?paged=2 the
 *  second page of a list. An address that carries one is a page of its own. */
const PAGE_PARAMS = ['p', 'page_id', 'cat', 'tag', 'author', 'm', 'paged'];
/** Endings that never make a page of their own, and that the report does not
 *  count as links it failed to follow: a cart action, a reply to a comment, a
 *  search, and the labels visitor counters hang on links. */
const NO_PAGE_PARAM_RE = /^(add-to-cart|remove_item|replytocom|s|utm_\w+|fbclid|gclid)$/i;
const SIGN_IN_RE = /\/(wp-login\.php|wp-signup\.php|wp-register\.php|wp-admin)(\/|$)/i;
const FEED_RE = /(^|\/)feed(\/(rss2?|atom|rdf))?\/?$/i;

/**
 * The part of an address after the question mark, split in two. `page` is
 * what names a WordPress page ("p=14", in a fixed order; '' when nothing
 * does). `rest` is everything else, question mark included ('' when nothing
 * is left). `other` is true when the rest holds something the old site would
 * have acted on, such as a sort order or a filter.
 */
export function splitSearch(u) {
  if (!u.search) return { page: '', rest: '', other: false };
  const page = [], rest = [];
  let other = false;
  for (const k of PAGE_PARAMS) { const v = u.searchParams.get(k); if (v) page.push(`${k}=${encodeURIComponent(v)}`); }
  for (const [k, v] of u.searchParams) {
    if (PAGE_PARAMS.includes(k) && v) continue;
    rest.push(encodeURIComponent(k) + (v === '' ? '' : '=' + encodeURIComponent(v)));
    if (!NO_PAGE_PARAM_RE.test(k)) other = true;
  }
  return { page: page.join('&'), rest: !page.length ? u.search : (rest.length ? '?' + rest.join('&') : ''), other };
}

/** An address the rescue never opens: 'signin' for the old site's sign-in and
 *  admin pages, 'feeds' for a feed, '' for everything else. */
export function leftOutKind(u) {
  if (SIGN_IN_RE.test(u.pathname)) return 'signin';
  if (FEED_RE.test(u.pathname) || u.searchParams.has('feed')) return 'feeds';
  return '';
}

/** True when a page identity (or a path) is inside `folder` ('/shop-demo').
 *  With no folder, everything is. */
export function inFolder(id, folder) {
  return !folder || id === folder || id.startsWith(folder + '/') || id.startsWith(folder + '?');
}
const stripFolder = (pathname, folder) => !folder ? pathname
  : pathname === folder ? '/'
  : pathname.startsWith(folder + '/') ? pathname.slice(folder.length) : pathname;

/**
 * The folder a site lives in when it is not at the top of its host:
 * '/shop-demo' for https://host/shop-demo/, '' for a site at the top.
 * firstUrl is the address the first page was read from, links the page
 * identities it links to. An address inside a folder is taken at its word,
 * unless most of what its page links to lies outside that folder: then it is
 * one page of a bigger site (https://host/about/), and that site is copied
 * whole, as before.
 */
export function siteFolder(firstUrl, links = []) {
  let u; try { u = new URL(firstUrl); } catch { return ''; }
  const folder = u.pathname.slice(0, u.pathname.lastIndexOf('/')).replace(/\/+$/, '');
  if (!folder) return '';
  const self = pageIdentity(u.href);
  let inside = 0, outside = 0;
  for (const id of links) { if (id === self) continue; if (inFolder(id, folder)) inside++; else outside++; }
  return inside >= outside ? folder : '';
}

/** Page identity: same-origin pathname, #fragment and ?query stripped (all but a
 *  WordPress page ending such as ?p=14, which stays: it names its own page), trailing
 *  slash and /index.html dropped (so /about, /about/ and /about/index.html are
 *  one page). null = not a page URL. */
export function pageIdentity(href, base) {
  let u; try { u = new URL(href, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (base && !sameSite(u, new URL(base))) return null;
  const p = u.pathname.replace(/\/index\.html?$/i, '/');
  const id = p.length > 1 ? (p.replace(/\/+$/, '') || '/') : p;
  const q = splitSearch(u).page;
  return q ? `${id}?${q}` : id;
}

const fileSeg = (s) => {
  let d; try { d = decodeURIComponent(s); } catch { d = s; }
  d = d.replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return (!d || d === '.' || d === '..') ? '_' : d;
};

/**
 * Map crawled page identities (in crawl order) to output files, directory-style
 * so pretty URLs survive on static hosts: / → index.html, /about → about/index.html,
 * /a.html keeps its name. Collisions (two paths sanitizing to the same file) are
 * resolved deterministically: the first claimant in crawl order keeps the clean
 * name, later ones get -2, -3… before /index.html (or the extension).
 * A WordPress page ending becomes a folder of its own: /?p=14 → p-14/index.html,
 * /blog?cat=5 → blog/cat-5/index.html. With `folder` (the folder the site
 * lived in on its host), that folder is the top of the copy:
 * /shop-demo → index.html, /shop-demo/about → about/index.html.
 */
export function mapUrls(identities, folder = '') {
  const map = new Map(), taken = new Set();
  for (const p of identities) {
    if (map.has(p)) continue;
    const at = p.indexOf('?');
    const where = stripFolder(at === -1 ? p : p.slice(0, at), folder);
    const q = at === -1 ? '' : fileSeg(p.slice(at + 1).replace(/[=&]+/g, '-'));
    const segs = where === '/' ? [] : where.replace(/^\/+|\/+$/g, '').split('/').map(fileSeg);
    const last = segs.length - 1;
    let file;
    if (last >= 0 && /\.html?$/i.test(segs[last])) {
      if (q) segs[last] = segs[last].replace(/(\.html?)$/i, `-${q}$1`);
      file = segs.join('/');
    } else {
      if (q) segs.push(q);
      file = segs.length ? segs.join('/') + '/index.html' : 'index.html';
    }
    const want = file;
    for (let i = 2; taken.has(file); i++) {
      file = want.endsWith('/index.html')
        ? want.replace(/\/index\.html$/, `-${i}/index.html`)
        : want.replace(/(\.html?)$/i, `-${i}$1`);
    }
    taken.add(file);
    map.set(p, file);
  }
  return map;
}

/** Output file → the pretty URL links should point at: about/index.html → /about/ */
export function fileToHref(file) {
  if (file === 'index.html') return '/';
  if (file.endsWith('/index.html')) return '/' + file.slice(0, -'index.html'.length);
  return '/' + file;
}

// ─── pure: reference extraction (crawler feed) ───────────────────────────────

const ICON_RELS = ['icon', 'shortcut', 'apple-touch-icon', 'mask-icon'];
// pictures a page names in its head: the ones link previews draw, and the tile Windows pins
const PREVIEW_METAS = ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'];
const TILE_RE = /^msapplication-(tileimage|square\d+x\d+logo|wide\d+x\d+logo)$/;
// not pages: files, and Cloudflare's own addresses under /cdn-cgi/ (its email-hiding links)
const isFileId = (id) => NON_PAGE_RE.test(id.split('?')[0]) || /^\/cdn-cgi\//.test(id);
const relsOf = (node) => (getAttr(node, 'rel') || '').toLowerCase().split(/\s+/).filter(Boolean);

function baseOf(doc, pageUrl) {
  let base = new URL(pageUrl);
  walkTree(doc, n => {
    if (n.tagName === 'base' && getAttr(n, 'href')) {
      try { base = new URL(getAttr(n, 'href'), pageUrl); } catch { /* keep page URL */ }
    }
  });
  return base;
}

const CSS_IMPORT_RE = /(@import\s+)(['"])([^'"]+)\2/gi;   // @import "x": the form with no url()
export const cssUrls = (css) => {
  const out = [];
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")\s][^'")]*)\1\s*\)/gi)) out.push(m[2]);
  for (const m of css.matchAll(CSS_IMPORT_RE)) out.push(m[3]);
  return out;
};

/** One parse per fetched page: same-origin page links + every asset reference,
 *  and the links that are not opened: signin and feeds (addresses of the old
 *  site's machinery) and queryLinks (addresses whose ending after the question
 *  mark is dropped, so the report can count them).
 *  (any origin — the crawler decides later what to localize). */
export function extractRefs(html, pageUrl) {
  const doc = parse(html);
  const base = baseOf(doc, pageUrl);
  const pages = new Set(), assets = new Set();
  const left = { signin: new Set(), feeds: new Set() }, queryLinks = new Set();
  const asset = (val) => {
    if (!val || /^(data:|blob:|#)/i.test(String(val).trim())) return;
    try { const u = new URL(String(val).trim(), base); if (/^https?:$/.test(u.protocol)) assets.add(siteKey(u, base)); } catch { /* skip */ }
  };
  const srcset = (val) => String(val).split(',').forEach(part => asset(part.trim().split(/\s+/)[0]));
  walkTree(doc, n => {
    switch (n.tagName) {
      case 'a': {
        const href = getAttr(n, 'href') || '';
        const id = pageIdentity(href, base);
        if (!id || isFileId(id)) break;
        const u = new URL(href, base);
        const kind = leftOutKind(u);
        // one sign-in page is one address, however many "come back to" endings its links carry
        if (kind) { left[kind].add(kind === 'signin' ? u.pathname : u.pathname + u.search); break; }
        pages.add(id);
        const s = splitSearch(u);
        if (!s.page && s.other) queryLinks.add(u.pathname + u.search);
        break;
      }
      case 'img': case 'source':
        for (const at of ['src', ...LAZY_SRC, 'data-image']) asset(getAttr(n, at));
        for (const at of ['srcset', ...LAZY_SRCSET]) if (getAttr(n, at)) srcset(getAttr(n, at));
        break;
      case 'link': {
        const rels = relsOf(n);
        if (rels.includes('stylesheet') || rels.some(r => ICON_RELS.includes(r))) asset(getAttr(n, 'href'));
        // a style sheet asked for early (rel="preload" as="style") is how many themes ask a font service
        else if (rels.includes('preload') && (getAttr(n, 'as') || '').toLowerCase() === 'style') asset(getAttr(n, 'href'));
        break;
      }
      case 'meta': {
        const key = (getAttr(n, 'property') || getAttr(n, 'name') || '').toLowerCase();
        if (PREVIEW_METAS.includes(key) || TILE_RE.test(key)) asset(getAttr(n, 'content'));
        break;
      }
      case 'use': asset(getAttr(n, 'href') || getAttr(n, 'xlink:href')); break;   // svg sprites
      case 'style': cssUrls(textOf(n)).forEach(asset); break;
    }
    if (n.attrs && getAttr(n, 'style')?.includes('url(')) cssUrls(getAttr(n, 'style')).forEach(asset);
  });
  return { pages: [...pages], assets: [...assets], signin: [...left.signin], feeds: [...left.feeds], queryLinks: [...queryLinks] };
}

// ─── pure: CSS url() rewriting ───────────────────────────────────────────────

/**
 * Rewrite url() refs in CSS text. Localized assets (assetMap: assetKey →
 * assets/rescued/x) → local path: sameDir:true emits just the basename (for
 * CSS files living in that same folder), else a root-relative
 * /assets/rescued/x. A same-site file that was not copied → its full address
 * on the old site, so it still shows (reported in leftBehind). Anything else
 * is left and reported in offOrigin.
 */
export function rewriteCssUrls(css, opts = {}) {
  const base = new URL(opts.base || 'http://localhost/');
  const assetMap = opts.assetMap || new Map();
  const offOrigin = new Set(), leftBehind = new Set();
  // one address → what the copy should say in its place, or null to leave it
  const to = (ref) => {
    if (/^(data:|blob:|#)/i.test(ref)) return null;
    let u; try { u = new URL(ref, base); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const local = assetMap.get(siteKey(u, base));
    if (local) return (opts.sameDir ? local.split('/').pop() : '/' + local) + (u.hash || '');
    if (!sameSite(u, base)) { offOrigin.add(u.href); return null; }
    leftBehind.add(siteKey(u, base));
    return base.origin + u.pathname + u.search + u.hash;
  };
  const out = css
    .replace(/url\(\s*(['"]?)([^'")\s][^'")]*)\1\s*\)/gi, (m, q, ref) => { const r = to(ref); return r === null ? m : `url(${q}${r}${q})`; })
    .replace(CSS_IMPORT_RE, (m, lead, q, ref) => { const r = to(ref); return r === null ? m : `${lead}${q}${r}${q}`; });
  return { css: out, offOrigin: [...offOrigin], leftBehind: [...leftBehind] };
}

// ─── pure: page cleaning ─────────────────────────────────────────────────────

/**
 * Clean one page: strip the builder's runtime (<script>s — JSON-LD survives if
 * it parses as JSON), preconnect/dns-prefetch/preload-as-script link tags, meta
 * generator, tracker iframes and noscript pixels, <base>; rewrite same-origin
 * absolute URLs to root-relative, links to crawled pages to their pretty URL,
 * and localized asset refs to /assets/rescued/…; a same-site file that was
 * not copied (a picture past the size limit, a PDF, a video) gets its full
 * address on the old site, so it keeps showing until that site is switched off.
 *
 * opts: { baseUrl, pageMap (identity → file), assetMap (assetKey → local path),
 *         keepScripts, folder }. folder ('/shop-demo') is the folder the site
 * lived in on its host: it becomes the top of the copy, so addresses inside
 * it lose its name, and a link to a page of the host outside it keeps its
 * full address on the old site. oldHead (returned) counts the canonical link
 * and og:url, which still name the old address.
 * Returns { html, scripts, cruft, kinds, previews, offOrigin, leftBehind } —
 * scripts/cruft = removal counts, kinds = what the removed scripts were
 * ({ own, inline, visitors: { host: n }, outside: { host: n } }), previews =
 * link-preview pictures given a full address, offOrigin = other sites' asset
 * URLs left as they were, leftBehind = same-site files now loaded from the
 * old site.
 */
export function cleanPage(html, opts = {}) {
  const pageMap = opts.pageMap || new Map();
  const assetMap = opts.assetMap || new Map();
  const folder = opts.folder || '';
  const doc = parse(html);
  const base = baseOf(doc, opts.baseUrl || 'http://localhost/');
  const offOrigin = new Set(), leftBehind = new Set();
  let scripts = 0, cruft = 0, previews = 0, oldHead = 0;
  const removals = [];
  // parts the old site kept hidden until a script showed them (see REVEAL)
  const shownNodes = new Set();
  let needSheet = false, head = null;
  const reveal = (n) => {
    const cls = classesOf(n);
    let next = cls, did = false;
    for (const r of REVEAL) {
      if (r.cls ? !cls.includes(r.cls) : getAttr(n, r.attr) === undefined) continue;
      next = next.filter(c => !(r.off || []).includes(c));
      for (const c of r.on || []) if (!next.includes(c)) next.push(c);
      did = true;
    }
    if (did) putAttr(n, 'class', next.join(' '));
    if (cls.some(c => REVEAL_BY_SHEET.includes(c))) { needSheet = true; did = true; }
    // WooCommerce writes opacity: 0 on a product's pictures and its script
    // fades them in: take the hidden start out of the part's own style
    if (cls.includes('woocommerce-product-gallery')) {
      const style = getAttr(n, 'style') || '';
      if (HIDDEN_START_RE.test(style)) {
        setAttr(n, 'style', style.replace(HIDDEN_START_RE, '$1').replace(/(^|;)\s*transition\s*:\s*opacity[^;]*/i, '$1').replace(/^[\s;]+|[\s;]+$/g, '').replace(/;\s*;+/g, ';'));
        did = true;
      }
    }
    if (did) shownNodes.add(n);
  };
  // what each script taken out was: the site's own, written into the page,
  // a visitor counter, or something loaded from another site (a chat box, a
  // cookie notice, a booking widget), so the report can say what was lost
  const kinds = { own: 0, inline: 0, visitors: {}, outside: {} };
  const noteScript = (n) => {
    scripts++;
    const src = String(getAttr(n, 'src') || '').trim();
    if (!src) { kinds.inline++; return; }
    let u; try { u = new URL(src, base); } catch { kinds.own++; return; }
    if (VISITOR_RE.test(u.href)) kinds.visitors[u.hostname] = (kinds.visitors[u.hostname] || 0) + 1;
    else if (sameSite(u, base) || BUILDER_CDN_RE.test(u.hostname)) kinds.own++;
    else kinds.outside[u.hostname] = (kinds.outside[u.hostname] || 0) + 1;
  };

  // one URL value → rewritten string, or null to leave it alone.
  // kind: 'page' (a[href] — may map to a crawled page), 'asset' (report if
  // off-origin and not localized), 'plain' (root-relative same-origin only)
  const rw = (val, kind) => {
    const v = String(val ?? '').trim();
    if (!v || /^(#|data:|blob:)/i.test(v)) return null;
    let u; try { u = new URL(v, base); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const local = assetMap.get(siteKey(u, base));
    if (local) return '/' + local + (u.hash || '');
    if (!sameSite(u, base)) {
      if (kind === 'asset') offOrigin.add(u.href);
      return null;
    }
    if (kind === 'page') {
      const file = pageMap.get(pageIdentity(u.href, base));
      if (file) return fileToHref(file) + splitSearch(u).rest + u.hash;
    }
    // a file of this site that was not copied: a root-relative path would find
    // nothing in the copy, so point at it where it still is
    if (kind === 'asset' || NON_PAGE_RE.test(u.pathname)) {
      leftBehind.add(siteKey(u, base));
      return base.origin + u.pathname + u.search + u.hash;
    }
    if (folder && inFolder(u.pathname, folder)) return stripFolder(u.pathname, folder) + u.search + u.hash;
    if (folder && kind === 'page') return base.origin + u.pathname + u.search + u.hash;
    return u.pathname + u.search + u.hash;
  };
  const rwAttr = (n, name, kind) => { const r = rw(getAttr(n, name), kind); if (r !== null) setAttr(n, name, r); };
  const rwSrcset = (n, name) => {
    const val = getAttr(n, name);
    if (!val) return;
    setAttr(n, name, String(val).split(',').map(part => {
      const m = part.trim().match(/^(\S+)([\s\S]*)$/);
      if (!m) return part.trim();
      return (rw(m[1], 'asset') ?? m[1]) + m[2];
    }).filter(Boolean).join(', '));
  };
  const rwCssText = (text, sameDir = false) => {
    const r = rewriteCssUrls(text, { base: base.href, assetMap, sameDir });
    r.offOrigin.forEach(u => offOrigin.add(u));
    r.leftBehind.forEach(u => leftBehind.add(u));
    return r.css;
  };

  walkTree(doc, n => {
    if (n.tagName === 'head' && !head) head = n;
    if (n.attrs && !opts.keepScripts) reveal(n);
    switch (n.tagName) {
      case 'script': {
        const type = (getAttr(n, 'type') || '').toLowerCase();
        if (opts.keepScripts) { rwAttr(n, 'src', 'plain'); break; }
        if (type.includes('ld+json')) {   // structured data is content, not runtime
          try { JSON.parse(textOf(n)); } catch { removals.push(n); noteScript(n); }
        } else { removals.push(n); noteScript(n); }
        break;
      }
      case 'link': {
        const rels = relsOf(n);
        const as = (getAttr(n, 'as') || '').toLowerCase();
        const linkType = (getAttr(n, 'type') || '').toLowerCase();
        if (rels.some(r => ['preconnect', 'dns-prefetch', 'modulepreload'].includes(r)) ||
            (rels.includes('preload') && as === 'script')) { removals.push(n); cruft++; }
        // CMS leftovers that point back into the machinery that is gone:
        // WordPress's pingback/xmlrpc, Windows Live Writer, the REST root,
        // short links, and oEmbed/feed discovery whose endpoints die with it
        else if (rels.some(r => ['pingback', 'edituri', 'wlwmanifest', 'shortlink', 'https://api.w.org/'].includes(r)) ||
            (rels.includes('alternate') && /(json\+oembed|xml\+oembed|rss\+xml|atom\+xml)/.test(linkType))) { removals.push(n); cruft++; }
        // a web manifest describes an app to install, and its file is not
        // copied: left in, every page would ask for it and get a 404
        else if (rels.includes('manifest')) { removals.push(n); cruft++; }
        // the canonical address is a full address, like og:url: left as it is
        else if (rels.includes('canonical')) { oldHead++; break; }
        else if (rels.includes('stylesheet') || rels.some(r => ICON_RELS.includes(r))) rwAttr(n, 'href', 'asset');
        // a style sheet or a font asked for early points at the copied file when there is one
        else if (rels.includes('preload') && (as === 'style' || as === 'font')) rwAttr(n, 'href', 'asset');
        else rwAttr(n, 'href', 'plain');
        break;
      }
      case 'meta': {
        const key = (getAttr(n, 'property') || getAttr(n, 'name') || '').toLowerCase();
        if (key === 'generator') { removals.push(n); cruft++; }
        else if (PREVIEW_METAS.includes(key)) {
          // the services that draw link previews need the picture's full
          // address, so a copied one keeps the site's name in front of it.
          // A site that lived in a folder has no such address yet (the old
          // host never had /assets/rescued/), so its pages name the picture
          // by its place in the copy and the report says what to do.
          const r = rw(getAttr(n, 'content'), 'asset');
          if (r !== null) { setAttr(n, 'content', r.startsWith('/') && !folder ? base.origin + r : r); if (r.startsWith('/')) previews++; }
        }
        else if (TILE_RE.test(key)) rwAttr(n, 'content', 'asset');
        else if (key === 'og:url') oldHead++;
        break;
      }
      case 'iframe':
        if (TRACKER_RE.test(getAttr(n, 'src') || '')) { removals.push(n); cruft++; }
        else rwAttr(n, 'src', 'plain');
        break;
      case 'noscript':
        if (TRACKER_RE.test(textOf(n))) { removals.push(n); cruft++; }
        break;
      case 'base': removals.push(n); cruft++; break;   // resolution already honored it
      case 'a': rwAttr(n, 'href', 'page'); break;
      case 'img': case 'source': {
        rwAttr(n, 'src', 'asset'); rwSrcset(n, 'srcset');
        for (const at of LAZY_SRC) rwAttr(n, at, 'asset');
        rwAttr(n, 'data-image', 'asset');
        for (const at of LAZY_SRCSET) rwSrcset(n, at);
        // the lazy-loader that would promote data-src at runtime is gone — do its job now.
        // A picture with no src, or with a stand-in written into the page
        // (a data: address) while the real one waits in a data- attribute,
        // gets the real one. A picture with a real src keeps it: WooCommerce
        // puts the full-size file in data-src beside a working src.
        const lazySrc = LAZY_SRC.map(at => getAttr(n, at)).find(Boolean);
        const lazySet = LAZY_SRCSET.map(at => getAttr(n, at)).find(Boolean);
        const src = String(getAttr(n, 'src') || '').trim();
        const standIn = !opts.keepScripts && /^data:/i.test(src);
        if ((!src || standIn) && lazySrc) { putAttr(n, 'src', lazySrc); if (!opts.keepScripts) shownNodes.add(n); }
        if (lazySet && (!getAttr(n, 'srcset') || standIn)) { putAttr(n, 'srcset', lazySet); if (!opts.keepScripts) shownNodes.add(n); }
        const lazySizes = LAZY_SIZES.map(at => getAttr(n, at)).find(Boolean);
        if (lazySizes && lazySizes !== 'auto' && !getAttr(n, 'sizes') && getAttr(n, 'srcset')) putAttr(n, 'sizes', lazySizes);
        break;
      }
      case 'video': case 'audio': rwAttr(n, 'src', 'asset'); rwAttr(n, 'poster', 'asset'); break;
      case 'use': rwAttr(n, 'href', 'asset'); rwAttr(n, 'xlink:href', 'asset'); break;
      case 'style': {
        const t = n.childNodes?.[0];
        if (t && t.value?.includes('url(')) t.value = rwCssText(textOf(n));
        break;
      }
      case 'form': rwAttr(n, 'action', 'plain'); break;
      case 'html': {
        // Themes that draw their icons as SVG (WordPress's Twenty Seventeen is
        // one) print no-svg on <html>, and their script changes it to svg when
        // the browser can draw SVG, which every browser now can. Left as
        // no-svg, the theme hides each icon and shows its name as words.
        const cls = classesOf(n);
        if (!opts.keepScripts && cls.includes('no-svg')) setAttr(n, 'class', cls.map(c => c === 'no-svg' ? 'svg' : c).filter((c, i, a) => a.indexOf(c) === i).join(' '));
        break;
      }
      case 'body': {
        // WooCommerce prints woocommerce-no-js on every page of a shop, and
        // the first thing its script does is add woocommerce-js. Themes write
        // the shop's layout against the second (Astra has 600 such rules), so
        // without it the products and the side column come out squeezed.
        // The first class stays too: its rules open what a script would have.
        const cls = classesOf(n);
        if (!opts.keepScripts && cls.includes('woocommerce-no-js') && !cls.includes('woocommerce-js')) setAttr(n, 'class', [...cls, 'woocommerce-js'].join(' '));
        break;
      }
    }
    if (n.attrs && getAttr(n, 'style')?.includes('url(')) setAttr(n, 'style', rwCssText(getAttr(n, 'style')));
  });
  for (const n of removals) {
    const kids = n.parentNode?.childNodes;
    const i = kids ? kids.indexOf(n) : -1;
    if (i >= 0) kids.splice(i, 1);
  }
  if (needSheet && head) {
    head.childNodes.push({ nodeName: 'link', tagName: 'link', namespaceURI: 'http://www.w3.org/1999/xhtml', childNodes: [], parentNode: head,
      attrs: [{ name: 'rel', value: 'stylesheet' }, { name: 'href', value: '/' + SHOWN_SHEET }] });
  }
  return { html: serialize(doc), scripts, cruft, kinds, previews, oldHead, offOrigin: [...offOrigin], leftBehind: [...leftBehind],
    shown: { parts: shownNodes.size, sheet: needSheet } };
}

// ─── pure: parts the old site showed with a script ──────────────────────────

const classesOf = (node) => (getAttr(node, 'class') || '').split(/\s+/).filter(Boolean);
// setAttr changes an attribute a part already has: this one also adds it
const putAttr = (node, name, value) => { const a = node.attrs.find(x => x.name === name); if (a) a.value = value; else node.attrs.push({ name, value }); };

// where a lazy-loading script keeps a picture's real address until it runs
const LAZY_SRC = ['data-src', 'data-lazy-src', 'data-original'];
const LAZY_SRCSET = ['data-srcset', 'data-lazy-srcset'];
const LAZY_SIZES = ['data-sizes', 'data-lazy-sizes'];

// A part that starts hidden and waits for a script to show it. The copy has no
// scripts, so cleanPage leaves each one the way the script's first run would:
// cls or attr is how the part is known, off and on are the classes the script
// takes off and puts on.
const REVEAL = [
  { cls: 'elementor-invisible', off: ['elementor-invisible'] },      // Elementor: parts that fade in
  { attr: 'data-aos', on: ['aos-init', 'aos-animate'] },             // AOS, "animate on scroll"
  { attr: 'data-sal', on: ['sal-animate'] },                         // sal.js
  { cls: 'lazyload', off: ['lazyload'], on: ['lazyloaded'] },        // lazysizes: pictures that load late
];
// Parts hidden by a rule in the site's own style sheets. That rule differs
// from site to site, so these are shown by one added style sheet (SHOWN_CSS):
// WOW.js, animate.css, "reveal on scroll", WPBakery, Beaver Builder, Divi.
const REVEAL_BY_SHEET = ['wow', 'animate__animated', 'reveal', 'wpb_animate_when_almost_visible', 'fl-animation', 'et-waypoint'];
const HIDDEN_START_RE = /(^|;)\s*opacity\s*:\s*0(?:\.0+)?\s*(?=;|$)/i;

/** Where the added style sheet goes in the copy, and what it says. */
export const SHOWN_SHEET = 'assets/rescued/shown-without-scripts.css';
export const SHOWN_CSS = `/* shown-without-scripts.css
   Added by "kiln rescue". The old site kept some parts hidden until one of its
   scripts showed them, such as words and pictures that fade in as the page
   scrolls. This copy has no scripts, so this sheet shows those parts from the
   start. Take a class out of the list below if a part shows that should not. */
${REVEAL_BY_SHEET.map(c => '.' + c).join(',\n')} {
  opacity: 1 !important;
  visibility: visible !important;
}
`;

/** The report's line for parts the old site kept hidden until a script showed
 *  them. pages: [{ href, parts, sheet }] (cleanPage's shown, per page). '' when there are none. */
export function shownLine(pages = []) {
  const on = pages.filter(p => p.parts > 0);
  if (!on.length) return '';
  const n = on.reduce((sum, p) => sum + p.parts, 0), one = n === 1;
  const sheet = on.some(p => p.sheet) ? ` Some are kept visible by one small style sheet added to the copy, ${SHOWN_SHEET}, and its first lines say what it is for.` : '';
  return `- Parts made visible: ${n}, on ${whereList(on.map(p => p.href))}. The old site kept ${one ? 'this part' : 'these parts'} hidden until one of its scripts showed ${one ? 'it' : 'them'}: words and pictures that fade in as the page scrolls, a product's pictures, pictures that load late. The copy has no scripts, so it shows ${one ? 'it' : 'them'} from the start.${sheet} Open ${on.length === 1 ? 'that page' : 'those pages'} and check that nothing shows that should stay hidden.`;
}

// ─── pure: sitemap, Kiln wiring, the "what was lost" report ──────────────────

/** Same-origin page paths listed in one sitemap file. A sitemap INDEX (a sitemap
 *  of sitemaps, the WordPress and Yoast default) lists only .xml files, which
 *  NON_PAGE_RE filters out — read its children with sitemapIndexChildren. */
export function sitemapPages(xml, origin, folder = '') {
  const out = [];
  for (const m of String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const loc = m[1].replace(/&amp;/g, '&');
    const id = pageIdentity(loc, origin);
    // a host's sitemap lists every site on it: only the pages under the
    // folder this site lives in are this site's pages
    if (!id || isFileId(id) || !inFolder(id, folder) || out.includes(id)) continue;
    if (leftOutKind(new URL(loc, origin))) continue;
    out.push(id);
  }
  return out;
}

/** Same-origin child sitemap URLs when the XML is a sitemap index, else []. */
export function sitemapIndexChildren(xml, origin) {
  if (!/<sitemapindex[\s>]/i.test(String(xml))) return [];
  const base = new URL(origin).origin;
  const out = [];
  for (const m of String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    let u; try { u = new URL(m[1].replace(/&amp;/g, '&'), base); } catch { continue; }
    if (sameSite(u, base) && /^https?:$/.test(u.protocol) && !out.includes(u.href)) out.push(u.href);
  }
  return out;
}

/** Add one page's script counts (kinds from cleanPage) to a run's total. */
export function addKinds(total, k) {
  total.own += k.own; total.inline += k.inline;
  for (const g of ['visitors', 'outside']) for (const [h, n] of Object.entries(k[g])) total[g][h] = (total[g][h] || 0) + n;
  return total;
}

/** What the scripts taken out were, as a sentence for the report. '' when there is nothing to say. */
export function scriptKindsLine(k) {
  if (!k) return '';
  const group = (o) => { const e = Object.entries(o).sort((a, b) => b[1] - a[1]); return { n: e.reduce((t, [, c]) => t + c, 0), names: e.slice(0, 5).map(([h]) => h).join(', ') + (e.length > 5 ? ` and ${e.length - 5} more` : '') }; };
  const was = (n) => (n === 1 ? 'was' : 'were');
  const v = group(k.visitors), o = group(k.outside), parts = [];
  if (k.own) parts.push(`${k.own} ${was(k.own)} the old site's own`);
  if (k.inline) parts.push(`${k.inline} ${was(k.inline)} written into the pages themselves`);
  if (v.n) parts.push(`${v.n} counted visitors (${v.names})`);
  if (o.n) parts.push(`${o.n} came from other sites (${o.names})`);
  if (!parts.length) return '';
  return `Of these, ${parts.join(', ')}.${v.n || o.n ? ' Whatever those did is gone from the copy: if you count visitors, or had a chat box, a cookie notice or a booking widget, add it again on the new site.' : ''}`;
}

/** The page's title when it reads like an error page, else ''. */
export function looksLikeErrorPage(html) {
  const title = (String(html).match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim();
  return /\b(not found|404|unavailable|no longer available|access denied|forbidden)\b/i.test(title) ? title : '';
}

/**
 * True when a page, as the server sends it, has nothing on it to read: it
 * loads a script, and its body holds no words to speak of and nothing but
 * empty wrappers (the `<div id="root"></div>` of a site drawn by JavaScript).
 * A heading, a paragraph, a link, a picture or a form makes it a real page,
 * however short, so a "Thanks!" page is never called blank.
 */
const BLANK_WRAPPERS = new Set(['div', 'span', 'main', 'section', 'article', 'header', 'footer', 'link', 'meta', 'br']);
const BLANK_UNSEEN = new Set(['script', 'style', 'noscript', 'template', 'svg']);
export function looksBlank(html) {
  const doc = parse(String(html));
  let body = null, scripts = 0;
  walkTree(doc, n => {
    if (n.tagName === 'body' && !body) body = n;
    if (n.tagName === 'script' && !(getAttr(n, 'type') || '').toLowerCase().includes('json')) scripts++;
  });
  if (!body || !scripts) return false;
  let text = '', real = false;
  (function walk(n) {
    for (const c of n.childNodes || []) {
      if (real) return;
      if (c.nodeName === '#text') { text += c.value; continue; }
      if (!c.tagName || BLANK_UNSEEN.has(c.tagName)) continue;
      if (!BLANK_WRAPPERS.has(c.tagName)) { real = true; return; }
      walk(c);
    }
  })(body);
  return !real && text.replace(/\s+/g, ' ').trim().length < 20;
}

export const RENDER_NEEDS = 'It needs two things: Chrome, Edge, Brave or Chromium on this computer, and the playwright-core package in the folder you run the command in (npm install playwright-core, which is small and downloads no browser).';

/** The same rescue, with --render: the command to give someone whose plain copy came out blank. */
export function renderCommand(url, args = {}) {
  const flags = [];
  for (const k of ['out', 'max-pages', 'delay', 'max-asset-mb', 'max-total-mb']) if (typeof args[k] === 'string' || typeof args[k] === 'number') flags.push(`--${k}=${quoteArg(String(args[k]))}`);
  for (const k of ['no-tag', 'try']) if (args[k] === true) flags.push(`--${k}`);
  return `npx github:kilncms/kiln#release rescue ${quoteArg(String(url))} --render${flags.length ? ' ' + flags.join(' ') : ''}`;
}

/** The same rescue again, with the options it was run with and the ones in `add` (names without dashes). */
export function againCommand(url, args = {}, add = []) {
  const flags = [];
  for (const k of ['out', 'max-pages', 'delay', 'max-asset-mb', 'max-total-mb', 'browser']) if (typeof args[k] === 'string' || typeof args[k] === 'number') flags.push(`--${k}=${quoteArg(String(args[k]))}`);
  for (const k of ['render', 'menu-shim', 'keep-scripts', 'no-tag', 'try']) if (args[k] === true || add.includes(k)) flags.push(`--${k}`);
  return `npx github:kilncms/kiln#release rescue ${quoteArg(String(url))}${flags.length ? ' ' + flags.join(' ') : ''}`;
}

/**
 * When more than half of the addresses tried have moved to one other site:
 * { host, count, tried, command, sentence }, else null. failedPages entries
 * that moved carry movedTo (the other site's origin).
 */
export function elsewhereOf(failedPages, tried, args = {}) {
  const byOrigin = new Map();
  for (const f of failedPages) if (f.movedTo) byOrigin.set(f.movedTo, (byOrigin.get(f.movedTo) || 0) + 1);
  const top = [...byOrigin].sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] * 2 <= tried) return null;
  const [to, count] = top, host = new URL(to).host;
  const flags = [];
  for (const k of ['render', 'menu-shim', 'no-tag', 'try']) if (args[k] === true) flags.push(`--${k}`);
  for (const k of ['max-pages', 'delay']) if (typeof args[k] === 'string' || typeof args[k] === 'number') flags.push(`--${k}=${quoteArg(String(args[k]))}`);
  const command = `npx github:kilncms/kiln#release rescue ${to}${flags.length ? ' ' + flags.join(' ') : ''}`;
  return { host, count, tried, command,
    sentence: `${count} of the ${tried} addresses tried have moved to ${host}, so most of this site lives there now. To copy those pages, run the rescue on that address: ${command}` };
}

/**
 * The report section about blank pages. b: { ids, read, drawn, command }, where
 * ids are the blank pages, read is how many pages were read in all, and drawn
 * says the site as a whole is drawn by JavaScript. [] when no page was blank.
 */
export function blankLines(b) {
  if (!b?.ids?.length) return [];
  const n = b.ids.length, kept = b.read - n;
  const L = [b.drawn ? '## This copy is not finished' : '## Blank pages left out', ''];
  L.push(`${n === b.read ? `All ${n}` : `${n} of the ${b.read}`} pages read ${n === 1 ? 'is' : 'are'} blank. This site draws ${n === 1 && !b.drawn ? 'that page' : 'its pages'} with JavaScript: the server sends a page with no words on it, and a script fills it in once it is open in a browser. A plain copy of such a page is an empty page, so ${n === 1 ? 'it was' : 'they were'} left out of this folder.${kept ? ` The ${kept === 1 ? 'one page that has' : `${kept} pages that have`} words on ${kept === 1 ? 'it was' : 'them were'} copied.` : ''}`, '');
  L.push('To copy the pages as they look once they are drawn, run the rescue again with `--render`, from the same folder you ran it in:', '', '```', b.command, '```', '');
  L.push(`\`--render\` opens each page in a browser and saves what it shows. ${RENDER_NEEDS}`, '');
  L.push(n === 1 ? 'The blank page:' : 'The blank pages:', '');
  for (const id of b.ids.slice(0, 20)) L.push(`- ${id}`);
  if (n > 20) L.push(`- and ${n - 20} more`);
  L.push('');
  return L;
}

const KILN_TAGS = ['<script src="/assets/kiln-config.js"></script>', '<script src="/assets/kiln.js" defer></script>'];

/**
 * Add Kiln's two script tags before </body> (opts.kiln), and the phone-menu
 * script and its one style rule (opts.menuStyle). Adding twice is a no-op.
 */
export function wireKiln(html, opts = {}) {
  let out = html;
  const tags = [];
  if (opts.menuStyle && !/assets\/kiln-menu\.js/.test(out)) {
    const h = out.search(/<\/head>/i);
    if (h !== -1) out = out.slice(0, h) + opts.menuStyle + out.slice(h);
    tags.push('<script src="/assets/kiln-menu.js" defer></script>');
  }
  if (opts.kiln !== false && !/assets\/kiln\.js/.test(out)) tags.push(...KILN_TAGS);
  if (!tags.length) return out;
  const block = tags.join('\n') + '\n';
  const i = out.toLowerCase().lastIndexOf('</body>');
  return i === -1 ? out + '\n' + block : out.slice(0, i) + block + out.slice(i);
}

/** Scripts still in a page that are not structured data and not Kiln's own. */
export function appScripts(html) {
  let n = 0;
  walkTree(parse(html), node => {
    if (node.tagName !== 'script') return;
    if ((getAttr(node, 'type') || '').toLowerCase().includes('ld+json')) return;
    if (/^\/assets\/kiln(-config|-menu)?\.js$/.test(getAttr(node, 'src') || '')) return;
    n++;
  });
  return n;
}

const whereList = (hrefs) => { const u = [...new Set(hrefs)]; return u.length > 4 ? `${u.slice(0, 4).join(', ')} and ${u.length - 4} more` : u.join(', '); };
const deepText = (node) => { let t = ''; walkTree(node, c => { if (c.nodeName === '#text') t += c.value; }); return t; };

/**
 * The phone menu of a plain copy. On a narrow screen a button opens the menu,
 * and the script that ran the button is one of those taken out. This looks
 * for the button in the ways the common themes write it. With opts.apply it
 * also marks the button, what it opens and what closes it, with the marks
 * assets/kiln-menu.js reads (the ones render.mjs writes after watching a
 * browser): data-kiln-menu-toggle, data-kiln-menu-swap (the classes of the
 * open state) and data-kiln-menu-close.
 *
 * Returns { html, found, known, label }: found says a menu button is there,
 * known says the rescue knows what opening it means. Known today: WordPress
 * block themes, Astra's slide-in drawer, Bootstrap's navbar, and the classic
 * WordPress themes' .menu-toggle. A theme whose page says it has a fallback
 * for no script (class "no-js" on <html>) is left alone.
 */
export function plainMenu(html, opts = {}) {
  const src = String(html);
  if (/\sdata-kiln-menu-toggle[\s=>]/.test(src)) return { html: src, found: true, known: true, label: 'menu' };
  const doc = parse(src);
  const cls = (n) => (getAttr(n, 'class') || '').split(/\s+/).filter(Boolean);
  const has = (n, c) => cls(n).includes(c);
  const byId = new Map(), buttons = [];
  let root = null;
  walkTree(doc, n => {
    if (!n.attrs) return;
    const id = getAttr(n, 'id');
    if (id && !byId.has(id)) byId.set(id, n);
    if (n.tagName === 'html') root = n;
    if (n.tagName === 'button' || (n.tagName === 'a' && getAttr(n, 'role') === 'button')) buttons.push(n);
  });
  const up = (n, test) => { for (let p = n.parentNode; p; p = p.parentNode) if (p.attrs && test(p)) return p; return null; };
  const all = (from, test) => { const out = []; walkTree(from, n => { if (n.attrs && test(n)) out.push(n); }); return out; };
  const open = (n, add) => [n, [...cls(n), ...add.filter(c => !has(n, c))].join(' ')];
  const fallback = !!root && has(root, 'no-js');
  let toggles, swaps = [], closers = [];

  // WordPress block themes: the menu's box is in the page, and two classes show it
  toggles = buttons.filter(b => has(b, 'wp-block-navigation__responsive-container-open'));
  if (toggles.length) {
    swaps = all(doc, n => has(n, 'wp-block-navigation__responsive-container')).map(n => open(n, ['has-modal-open', 'is-menu-open']));
    closers = all(doc, n => has(n, 'wp-block-navigation__responsive-container-close'));
  }
  // Astra: a drawer that slides in from the side
  if (!toggles.length) {
    toggles = buttons.filter(b => has(b, 'main-header-menu-toggle'));
    const drawer = byId.get('ast-mobile-popup');
    if (toggles.length && drawer) {
      swaps = [open(drawer, ['active', 'show'])];
      closers = all(drawer, n => has(n, 'menu-toggle-close') || has(n, 'ast-mobile-popup-overlay'));
    }
  }
  // Bootstrap: the button names what it opens, and "show" opens it
  if (!toggles.length) {
    toggles = buttons.filter(b => has(b, 'navbar-toggler'));
    for (const b of toggles) {
      const t = byId.get(String(getAttr(b, 'data-bs-target') || getAttr(b, 'data-target') || '').replace(/^#/, ''));
      if (t && !swaps.some(s => s[0] === t)) swaps.push(open(t, ['show']));
    }
  }
  // classic WordPress themes: the navigation around the button is marked as toggled
  if (!toggles.length && !fallback) {
    toggles = buttons.filter(b => has(b, 'menu-toggle') && getAttr(b, 'aria-controls'));
    for (const b of toggles) {
      const nav = up(b, p => p.tagName === 'nav' || has(p, 'main-navigation'));
      if (nav && !swaps.some(s => s[0] === nav)) swaps.push(open(nav, ['toggled', 'toggled-on']));
    }
  }
  // any other button in the header that says it opens a menu: found, not known
  if (!toggles.length && !fallback) {
    toggles = buttons.filter(b => {
      const words = `${getAttr(b, 'aria-label') || ''} ${getAttr(b, 'class') || ''} ${getAttr(b, 'aria-controls') || ''}`;
      return /menu|navigation|hamburger|burger/i.test(words) && !/close|sub-?menu|search|cart|account|language|dropdown/i.test(words)
        && (getAttr(b, 'aria-expanded') !== undefined || getAttr(b, 'aria-controls') || getAttr(b, 'aria-haspopup'))
        && !!up(b, p => p.tagName === 'header' || p.tagName === 'nav');
    }).slice(0, 1);
  }
  if (!toggles.length) return { html: src, found: false, known: false, label: '' };
  const label = (getAttr(toggles[0], 'aria-label') || deepText(toggles[0]) || getAttr(toggles[0], 'title') || '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'menu';
  const known = swaps.length > 0;
  if (!opts.apply || !known) return { html: src, found: true, known, label };
  for (const b of toggles) b.attrs.push({ name: 'data-kiln-menu-toggle', value: '' });
  for (const [n, to] of swaps) n.attrs.push({ name: 'data-kiln-menu-swap', value: to });
  for (const n of closers) n.attrs.push({ name: 'data-kiln-menu-close', value: '' });
  return { html: serialize(doc), found: true, known, label };
}

/**
 * The report's line about the phone menu of a plain copy, '' when no page has
 * a menu button. menus: [{ href, found, known, label }] (plainMenu per page),
 * asked: --menu-shim was given, cmds: { shim, render } the commands to offer.
 */
export function plainMenuLine(menus, asked, cmds = {}) {
  const found = menus.filter(m => m.found);
  if (!found.length) return '';
  const known = found.filter(m => m.known), unknown = found.filter(m => !m.known);
  if (!asked) return `- Phone menu: the button "${found[0].label}" does not open the menu on a phone (on ${whereList(found.map(m => m.href))}). One of the old site's scripts ran it, and those were taken out. Run the rescue again with \`--menu-shim\` added, from the same folder you ran it in, to add a small script that opens it: \`${cmds.shim}\``;
  const cannot = (list) => `the rescue could not tell from the page alone what the button "${list[0].label}" opens. Run it with \`--render --menu-shim\`, which opens each page in a browser and watches what the button does (\`${cmds.render}\`), or add the links to the page by hand.`;
  if (!unknown.length) return `- Phone menu: the button "${known[0].label}" opens the menu through assets/kiln-menu.js, a small script of Kiln's own, on ${whereList(known.map(m => m.href))}. Open a page on a phone and press the button to check it.`;
  if (!known.length) return `- Phone menu: the button does not open the menu on a phone, and ${cannot(unknown)}`;
  return `- Phone menu: the button "${known[0].label}" opens the menu through assets/kiln-menu.js on ${whereList(known.map(m => m.href))}. Open a page on a phone and press the button to check it. On ${whereList(unknown.map(m => m.href))}, ${cannot(unknown)}`;
}

/**
 * A shop, recognised from its pages: WooCommerce (an add-to-cart link or
 * button, the cart or checkout form), Shopify (a form that posts to
 * /cart/add) or Squarespace (its add-to-cart button). pages: [{ href, html }].
 * Returns { kind, on: [href] } or null.
 */
export function shopOf(pages) {
  const on = [];
  let kind = '';
  for (const { href, html } of pages) {
    let k = '';
    walkTree(parse(String(html)), n => {
      if (k || !n.attrs) return;
      const c = ` ${getAttr(n, 'class') || ''} `;
      if (n.tagName === 'a' && /[?&]add-to-cart=/.test(getAttr(n, 'href') || '')) k = 'WooCommerce';
      else if (/ (add_to_cart_button|single_add_to_cart_button) /.test(c)) k = 'WooCommerce';
      else if (n.tagName === 'form' && / (woocommerce-cart-form|woocommerce-checkout|variations_form) /.test(c)) k = 'WooCommerce';
      else if (n.tagName === 'form' && /\/cart\/add(\.js)?\/?$/.test(String(getAttr(n, 'action') || '').split('?')[0])) k = 'Shopify';
      else if (/ sqs-add-to-cart-button /.test(c)) k = 'Squarespace';
    });
    if (k) { on.push(href); kind = kind || k; }
  }
  return on.length ? { kind, on } : null;
}

/** The report's paragraph for a shop (from shopOf): what does not come across and what to do. */
export function shopLines(shop) {
  if (!shop) return [];
  return ['## This site is a shop', '',
    `The shop itself does not come across. The copy keeps the shop's pages as they looked on the day of the copy, with their words, pictures and prices. The cart, the checkout, the filters and the stock count were worked out by the old site (${shop.kind}) each time a visitor asked, and a folder of plain pages cannot do that: the buttons are still drawn, and they do nothing. There are two ways forward. Keep the shop where it is, and link to it from the new pages. Or put a payment link (from Stripe, PayPal or a similar service) on each product page in place of its button. Shop parts were found on ${whereList(shop.on)}.`, ''];
}

/**
 * What a WooCommerce shop's pages still show differently once its scripts are
 * gone, for the report: a product's tabs, the price slider, a product's
 * pictures. pages: [{ href, html }]. Returns { tabs, slider, gallery }, each
 * a list of hrefs, or null when no page has any of them.
 */
export function shopChangesOf(pages) {
  const found = { tabs: [], slider: [], gallery: [] };
  for (const { href, html } of pages) {
    const has = { tabs: false, slider: false, gallery: false };
    walkTree(parse(String(html)), n => {
      if (!n.attrs) return;
      const cls = classesOf(n);
      if (cls.includes('wc-tabs')) has.tabs = true;
      if (cls.includes('price_slider_wrapper') || cls.includes('price_slider')) has.slider = true;
      if (cls.includes('woocommerce-product-gallery')) has.gallery = true;
    });
    for (const k of Object.keys(found)) if (has[k]) found[k].push(href);
  }
  return found.tabs.length || found.slider.length || found.gallery.length ? found : null;
}

/** The report's lines for shopChangesOf: what the owner will see on the shop's pages, and what to do. */
export function shopChangeLines(c) {
  if (!c) return [];
  const lines = ['The shop\'s pages keep their layout. These parts of them look different from the old site, because the old site drew them with a script. Nothing is missing from them, and you may want to tidy them:', ''];
  if (c.tabs.length) lines.push(`- A product's sections (such as Description, Additional information and Reviews) all show, one under the other. The old site showed one at a time, behind tabs. The row of tab names is still there, and clicking a name jumps down to its section. This is on ${whereList(c.tabs)}.`);
  if (c.slider.length) lines.push(`- The price filter shows as two boxes with a number in each, and a button. On the old site it was a slider. It filters nothing in the copy, so you can take it out of the page. This is on ${whereList(c.slider)}.`);
  if (c.gallery.length) lines.push(`- A product's pictures show as one large picture with the others small in a row under it. Clicking one opens that picture on its own. It does not move into the large one's place, and the large one does not zoom. This is on ${whereList(c.gallery)}.`);
  lines.push('');
  return lines;
}

/** The report's line for links whose ending after the question mark was dropped. '' when there are none. */
export function queryLinksLine(links = []) {
  const n = links.length;
  if (!n) return '';
  const ending = (links[0].match(/\?[^=&#]+(=[^&#]*)?/) || ['?…'])[0];
  return `- Links not followed: ${n} ${n === 1 ? 'address ends' : 'addresses end'} in a question mark and more, like ${ending}. An ending like that told the old site to draw the page another way (sorted, filtered, in another language), and the copy has no old site behind it to do that. Each of these links now opens the page as it was copied, without the ending. Open ${n === 1 ? 'it' : 'them'} on the old site: if ${n === 1 ? 'it' : 'one'} shows something you need that the copy lacks, add that page by hand, or take the link out. ${n > 5 ? 'The first five' : (n === 1 ? 'The address' : 'The addresses')}: ${links.slice(0, 5).join(', ')}`;
}

/** The report's line for addresses the rescue never opens. '' when none were linked. */
export function leftOutLine(signin = [], feeds = []) {
  const parts = [];
  if (signin.length) parts.push(`${signin.length} sign-in or admin address${signin.length === 1 ? '' : 'es'} of the old site (wp-login, wp-admin)`);
  if (feeds.length) parts.push(`${feeds.length} feed${feeds.length === 1 ? '' : 's'}`);
  if (!parts.length) return '';
  return `- Left out on purpose: ${parts.join(' and ')}. These belong to the machinery of the old site and are not pages to read, so the rescue did not open them. Take the links to them out of the pages.`;
}

/**
 * The report's lines for a site that lived in a folder of its host.
 * f: { origin, folder, outside } where outside lists the pages of the host
 * outside the folder that the copied pages link to. [] for a site at the top.
 */
export function folderLines(f) {
  if (!f?.folder) return [];
  const host = new URL(f.origin).host, name = f.folder + '/';
  const L = [`- This is a copy of the part of ${f.origin} that lives in the folder ${name}. The copy is a site of its own: its home page is index.html at the top of this folder, and every link and file address in it starts from there. Serve or deploy this folder as the top of a site, not inside a folder named ${f.folder.split('/').pop()}.`];
  const out = f.outside || [];
  if (out.length) L.push(`- Links to pages of ${host} outside ${name}: ${out.length} (${out.slice(0, 5).join(', ')}${out.length > 5 ? ` and ${out.length - 5} more` : ''}). Those pages were not copied, and the links to them still go to the old site. To copy the whole of ${host}, run the rescue on ${f.origin}/ instead.`);
  return L;
}

/** The report section for files that were already gone from the old site (it answered 404 or 410). */
export function missingLines(gone) {
  if (!gone.length) return [];
  const n = gone.length;
  const L = ['## Files already missing on the old site', '',
    `${n} file${n === 1 ? '' : 's'} these pages ask for ${n === 1 ? 'is' : 'are'} already missing on the old site: it answered "not found" for ${n === 1 ? 'it' : 'each one'}. ${n === 1 ? 'It was' : 'They were'} broken before the copy was made, and switching the old site off changes nothing for ${n === 1 ? 'it' : 'them'}. A missing picture shows as a broken picture, and a missing font is replaced by another one. Put each file back if you have it, or take it out of the page.`, ''];
  for (const f of gone.slice(0, 15)) {
    let name = f.url; try { name = decodeURIComponent(new URL(f.url).pathname.split('/').pop()) || f.url; } catch { /* keep the address */ }
    L.push(`- ${name}: ${f.url}`);
  }
  if (n > 15) L.push(`- and ${n - 15} more`);
  L.push('');
  return L;
}

/**
 * What stopped working when the pages were frozen, as report lines.
 * pages: [{ href, rendered }] where rendered is what render.mjs returned.
 */
export function lostLines(pages) {
  const list = pages.filter(p => p.rendered);
  if (!list.length) return [];
  const L = ['## What to check', '',
    'These pages are plain files now, with nothing running behind them. Anything the old site worked out as it went, or did with a script after a page was drawn, no longer happens. Check each item below.', ''];
  const where = (hrefs) => { const u = [...new Set(hrefs)]; return u.length > 4 ? `${u.slice(0, 4).join(', ')} and ${u.length - 4} more` : u.join(', '); };
  const group = (items, keyOf) => { const m = new Map(); for (const it of items) { const k = keyOf(it); if (!m.has(k)) m.set(k, []); m.get(k).push(it.href); } return m; };

  const forms = list.flatMap(p => p.rendered.lost.forms.map(f => ({ ...f, href: p.href })));
  if (forms.length) {
    L.push(`- Forms: ${forms.length}. A form the app sent by script now sends nowhere. Point each one at a form service, or replace it with an email link.`);
    for (const [k, hrefs] of group(forms, f => `"${f.label}" (${f.fields} field${f.fields === 1 ? '' : 's'}${f.action ? `, posts to ${f.action}` : ''})`)) L.push(`  - ${k} on ${where(hrefs)}`);
  } else L.push('- Forms: none.');

  const controls = list.flatMap(p => p.rendered.lost.controls.filter(c => c.kind !== 'the phone menu button').map(c => ({ ...c, href: p.href })));
  if (controls.length) {
    const g = group(controls, c => `${c.kind} "${c.label}"`);
    L.push(`- Controls that needed script: ${g.size}. They are still drawn and no longer do anything.`);
    let n = 0;
    for (const [k, hrefs] of g) { if (n++ === 40) { L.push(`  - and ${g.size - 40} more`); break; } L.push(`  - ${k} on ${where(hrefs)}`); }
  } else L.push('- Controls that needed script: none.');

  const withMenu = list.filter(p => p.rendered.menu?.found);
  const shimmed = withMenu.filter(p => p.rendered.menu.shimmed);
  if (!withMenu.length) L.push('- Phone menu: no menu button found.');
  else if (shimmed.length === withMenu.length) L.push(`- Phone menu: works. The button "${withMenu[0].rendered.menu.label}" opens it through assets/kiln-menu.js, a small script of Kiln's own, on ${where(shimmed.map(p => p.href))}.`);
  else if (shimmed.length) L.push(`- Phone menu: works on ${where(shimmed.map(p => p.href))}. On ${where(withMenu.filter(p => !p.rendered.menu.shimmed).map(p => p.href))} the button could not be made to work: add the links to the page by hand.`);
  else if (list.some(p => p.rendered.menu?.tried)) L.push(`- Phone menu: the button "${withMenu[0].rendered.menu.label}" does not open, and --menu-shim could not work out what it shows. Add the links to the page by hand.`);
  else L.push(`- Phone menu: the button "${withMenu[0].rendered.menu.label}" does not open. Run again with --menu-shim to add a small script that opens it.`);

  const nav = list.flatMap(p => (p.rendered.navButtons || []).map(b => ({ ...b, href: p.href })));
  for (const b of nav) L.push(`- The button "${b.label}" changed page by script (it went to ${new URL(b.url).pathname}). Replace it with a link.`);

  const changed = list.filter(p => p.rendered.changed);
  if (changed.length) {
    L.push(`- Pages that came out differently on a second visit: ${changed.length}. The copy keeps what the first visit showed.`);
    for (const p of changed) L.push(`  - ${p.href}: "${p.rendered.changed.was}" then "${p.rendered.changed.now}"`);
  } else L.push('- Pages that came out differently on a second visit: none.');

  const invisible = list.filter(p => p.rendered.lost.invisible.length);
  if (invisible.length) {
    L.push(`- Text that was invisible when the page was saved (it was waiting for an animation) on ${where(invisible.map(p => p.href))}:`);
    for (const p of invisible) for (const t of p.rendered.lost.invisible) L.push(`  - "${t}"`);
  }
  const count = (key) => list.filter(p => p.rendered.lost[key] > 0).map(p => p.href);
  if (count('canvases').length) L.push(`- Drawn on a canvas by script, so not copied: ${where(count('canvases'))}.`);
  if (count('blobs').length) L.push(`- Pictures or video that existed only in the browser's memory, so not copied: ${where(count('blobs'))}.`);
  if (count('shadow').length) L.push(`- Custom elements that draw their own insides, now empty: ${where(count('shadow'))}.`);
  const scripted = list.filter(p => p.rendered.scripted).map(p => p.href);
  if (scripted.length) L.push(`- Phone layout chosen by script on ${where(scripted)}: the copy keeps the desktop version at every width. Look at it on a phone.`);
  const styles = list.reduce((n, p) => n + p.rendered.lost.styles, 0);
  if (styles) L.push(`- Styles that existed only in memory and are now written into the pages: ${styles}.`);
  L.push('');
  return L;
}

/**
 * What a plain (non-rendered) freeze costs, read from the pages' own HTML:
 * forms that posted back into the CMS, search boxes, comment threads, links to
 * the old sign-in. pages: [{ href, html }] with href the pretty output URL.
 * Returns report lines, or [] when there is nothing to say.
 */
export function staticLostLines(pages, origin, opts = {}) {
  let base = null; try { base = new URL(origin); } catch { /* relative actions stay dead-ish */ }
  const dead = [], outside = [], searches = [], comments = [], logins = new Set();
  for (const { href, html } of pages) {
    const doc = parse(String(html));
    walkTree(doc, n => {
      if (n.tagName === 'a') {
        if (/wp-login\.php|\/wp-admin\b/i.test(getAttr(n, 'href') || '')) logins.add(href);
        return;
      }
      if (n.tagName !== 'form') return;
      const action = String(getAttr(n, 'action') || '').trim();
      let u = null; try { u = action ? new URL(action, base || 'http://localhost/') : null; } catch { /* unparsable action */ }
      let fields = 0, searchInput = false;
      walkTree(n, c => {
        if (!['input', 'textarea', 'select'].includes(c.tagName)) return;
        if ((getAttr(c, 'name') || '') === 's') searchInput = true;
        if ((getAttr(c, 'type') || '').toLowerCase() !== 'hidden') fields++;
      });
      const label = getAttr(n, 'aria-label') || getAttr(n, 'id') || getAttr(n, 'name')
        || (getAttr(n, 'class') || '').split(/\s+/).filter(Boolean)[0] || 'form';
      const isComment = /wp-comments-post\.php/i.test(action) || /^comment/i.test(getAttr(n, 'id') || '');
      const isSearch = (getAttr(n, 'role') || '').toLowerCase() === 'search' || searchInput
        || /(^|[\s-])search(form)?([\s-]|$)/i.test(getAttr(n, 'class') || '') || /[?&]s=/.test(action);
      if (isComment) { comments.push(href); return; }
      if (isSearch) { searches.push(href); return; }
      const rec = { label, fields, action: u ? u.pathname : action, href };
      if (u && base && !sameSite(u, base)) outside.push({ ...rec, host: u.hostname });
      else dead.push(rec);
    });
  }
  if (!dead.length && !outside.length && !searches.length && !comments.length && !logins.size && !opts.menuLine) return [];
  const where = (hrefs) => { const u = [...new Set(hrefs)]; return u.length > 4 ? `${u.slice(0, 4).join(', ')} and ${u.length - 4} more` : u.join(', '); };
  const group = (items, keyOf) => { const m = new Map(); for (const it of items) { const k = keyOf(it); if (!m.has(k)) m.set(k, []); m.get(k).push(it.href); } return m; };
  const L = ['## What to check', '',
    'These pages are plain files now, with nothing running behind them, so anything the old site worked out as it went no longer happens. Check each item below.', ''];
  if (dead.length) {
    // the number is the number of lines under it: one form on four pages is one form
    const forms = group(dead, f => `"${f.label}" (${f.fields} field${f.fields === 1 ? '' : 's'}${f.action ? `, posted to ${f.action}` : ''})`);
    const onPages = new Set(dead.map(f => f.href)).size;
    L.push(`- Forms that posted into the old site: ${forms.size}${onPages > 1 ? `, on ${onPages} pages` : ''}. They now send nowhere. Point each one at a form service, or replace it with an email link.`);
    for (const [k, hrefs] of forms) L.push(`  - ${k} on ${where(hrefs)}`);
  } else L.push('- Forms that posted into the old site: none.');
  if (outside.length) {
    L.push(`- Forms that post to an outside service, which should still work. Send one test from the new site:`);
    for (const [k, hrefs] of group(outside, f => `"${f.label}" (posts to ${f.host})`)) L.push(`  - ${k} on ${where(hrefs)}`);
  }
  if (searches.length) L.push(`- Search boxes on ${where(searches)}: the old server answered them, and it is gone. Remove them, or point them at a search service.`);
  if (comments.length) L.push(`- Comment threads on ${where(comments)}: what was said is kept as shown, and new comments cannot be left.`);
  if (logins.size) L.push(`- Links to the old sign-in (wp-login, wp-admin) on ${where([...logins])}: remove them. Editing happens through Kiln now.`);
  if (opts.menuLine) L.push(opts.menuLine);
  L.push('');
  return L;
}

/** Every file the pages use that is not in the copy: what the download loop
 *  skipped ({ url, reason, bytes? }), then same-site files it never fetches
 *  (a PDF, a video), as [{ url, reason, bytes? }]. */
/**
 * What the copy still asks a font service for: [{ url, name, why }].
 * skipped = files the rescue asked for and did not get ({ url, reason });
 * offOrigin = addresses the pages and style sheets still carry.
 */
export function fontsLeftOf(offOrigin = [], skipped = [], localized = []) {
  const out = new Map();
  const add = (url, reason) => {
    const f = fontService(url);
    if (!f || out.has(url) || localized.includes(url)) return;
    out.set(url, { url, name: f.name, why: !f.copy ? 'lent' : reason ? `It could not be copied this time (${reason}). Run the rescue again to try once more.` : 'unread' });
  };
  for (const s of skipped) add(s.url, s.reason);
  for (const u of offOrigin) add(u, '');
  return [...out.values()];
}

/** The report's section for them: says the site still depends on the font service, and what to do about each. */
export function fontServiceLines(left = []) {
  if (!left.length) return [];
  const names = [...new Set(left.map(f => f.name))];
  const said = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
  const WHY = {
    lent: 'This service lends its fonts to the account that pays for them, so they may not be copied. Keep that account open, or choose another font for the site.',
    unread: 'The page asks for it in a way the rescue does not follow. It still works. To stop depending on the service, save the file into the site and point the page at it.',
  };
  const L = ['## Fonts that still come from a font service', '',
    `This copy still depends on ${said} for ${left.length === 1 ? 'one file' : left.length + ' files'}: the fonts themselves, or the style sheets that name them. The pages look right for as long as the service answers, and they show another typeface if it ever stops. None of this depends on the old site, so switching it off changes nothing here.`, ''];
  for (const f of left.slice(0, 20)) L.push(`- ${f.name}: ${f.url} ${WHY[f.why] || f.why}`);
  if (left.length > 20) L.push(`- and ${left.length - 20} more from the same ${names.length > 1 ? 'services' : 'service'}.`);
  L.push('');
  return L;
}

export function notCopiedOf(skippedAssets, leftBehind = []) {
  const out = new Map();
  for (const s of skippedAssets) if (!out.has(s.url)) out.set(s.url, s);
  for (const u of leftBehind) if (!out.has(u)) out.set(u, { url: u, reason: 'a kind of file the rescue does not copy' });
  return [...out.values()];
}

const quoteArg = (v) => /^[\w@%+=:,./-]+$/.test(v) ? v : `'${String(v).replace(/'/g, `'\\''`)}'`;

/**
 * The report section for files the copy still loads from the old site, with
 * the command that copies them (when bigger limits would). notCopied as from
 * notCopiedOf; again: { url, args, totalBytes, maxAssetBytes, maxTotalBytes,
 * capped }. [] when everything was copied.
 */
export function notCopiedLines(all, again) {
  // a file the old site no longer has is not one that "will disappear": it gets its own words
  return [...stillThereLines(all.filter(f => !f.missing), again), ...missingLines(all.filter(f => f.missing))];
}
function stillThereLines(notCopied, again) {
  if (!notCopied.length) return [];
  const n = notCopied.length;
  const L = ['## Files not copied', '',
    `${n} file${n === 1 ? '' : 's'} used by these pages ${n === 1 ? 'was' : 'were'} not copied into this folder. The pages still show ${n === 1 ? 'it' : 'them'} by loading ${n === 1 ? 'it' : 'them'} from the old site, at ${n === 1 ? 'its' : 'their'} full address. When you switch the old site off, ${n === 1 ? 'this file' : 'these files'} will disappear from your pages. Copy ${n === 1 ? 'it' : 'them'} before you do.`, ''];
  const capped = notCopied.filter(f => f.capped), tooBig = notCopied.filter(f => f.tooBig);
  if (again.capped) L.push(`- ${capped.length} ${capped.length === 1 ? 'was' : 'were'} left out because the copy reached its limit of ${mb(again.maxTotalBytes)} for the whole run.`);
  if (tooBig.length) L.push(`- ${tooBig.length} ${tooBig.length === 1 ? 'was' : 'were'} bigger than the limit of ${mb(again.maxAssetBytes)} for one file.`);
  const other = n - capped.length - tooBig.length;
  if (other) L.push(`- ${other} could not be downloaded, or ${other === 1 ? 'is' : 'are'} a kind of file the rescue does not copy (the reason is given for each one below).`);
  L.push('', n > 15 ? 'The 15 largest:' : (n === 1 ? 'The file:' : 'The files, largest first:'), '');
  const sorted = [...notCopied].sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
  for (const f of sorted.slice(0, 15)) {
    let name = f.url; try { name = decodeURIComponent(new URL(f.url).pathname.split('/').pop()) || f.url; } catch { /* keep the address */ }
    L.push(`- ${name}, ${f.bytes ? mb(f.bytes) : 'size not known'}: ${f.reason}. ${f.url}`);
  }
  if (n > 15) L.push(`- and ${n - 15} more`);
  L.push('');
  if (again.capped || tooBig.length) {
    const MB = 1024 * 1024;
    const known = notCopied.reduce((t, f) => t + (f.capped || f.tooBig ? f.bytes || 0 : 0), 0);
    const roundUp = (x, step) => Math.ceil(x / step) * step;
    const flags = [];
    for (const k of ['out', 'max-pages', 'delay', 'browser']) if (typeof again.args[k] === 'string' || typeof again.args[k] === 'number') flags.push(`--${k}=${quoteArg(String(again.args[k]))}`);
    for (const k of ['render', 'menu-shim', 'keep-scripts', 'no-tag', 'try']) if (again.args[k] === true) flags.push(`--${k}`);
    let total = again.maxTotalBytes / MB;
    if (again.capped) total = Math.max(total * 2, roundUp((again.totalBytes + known) * 1.25 / MB, 50));
    flags.push(`--max-total-mb=${Math.ceil(total)}`);
    const biggest = Math.max(0, ...tooBig.map(f => f.bytes || 0));
    if (tooBig.length) flags.push(`--max-asset-mb=${Math.min(PAGES_FILE_LIMIT_MB, Math.max(Math.ceil(biggest / MB), Math.ceil(again.maxAssetBytes / MB) + 1))}`);
    L.push('To copy them too, run the rescue again with bigger limits, from the same folder you ran it in:', '', '```',
      `npx github:kilncms/kiln#release rescue ${quoteArg(again.url)} ${flags.join(' ')}`, '```', '');
    if (biggest > PAGES_FILE_LIMIT_MB * MB) L.push(`Some files are bigger than ${PAGES_FILE_LIMIT_MB} MB, and Cloudflare Pages does not accept a file that big. Make them smaller first, or put them somewhere else (a video belongs on a video site) and link to them there.`, '');
  }
  return L;
}

// ─── crawl + download + write ────────────────────────────────────────────────

const get = (url) => fetch(url, {
  headers: headersFor(url),
  redirect: 'follow',
  signal: AbortSignal.timeout(15000),
});

function assetFileName(key, ct) {
  const u = new URL(key);
  let base = fileSeg(u.pathname.split('/').pop() || '').slice(0, 60) || 'asset';
  if (!/\.[a-z0-9]{2,5}$/i.test(base)) base += EXT_BY_CT[(ct || '').split(';')[0].trim()] || '';
  return `${createHash('sha256').update(key).digest('hex').slice(0, 8)}-${base}`;
}

export async function rescueCmd(startUrl, args = {}) {
  hr('kiln rescue');
  info('Rescue is for migrating YOUR OWN site. Respect the source\'s terms.');
  let start;
  try {
    if (!startUrl) throw new Error('missing url');
    start = new URL(/^https?:\/\//i.test(startUrl) ? startUrl : `https://${startUrl}`);
  } catch { fail('Usage: kiln rescue <url> [--out=dir] [--max-pages=N] [--delay=ms] [--max-asset-mb=N] [--max-total-mb=N] [--keep-scripts] [--no-tag] [--dry] [--menu-shim] [--render [--browser=path]] [--try]'); info('What each option does: npx github:kilncms/kiln#release rescue --help'); process.exit(1); }
  let origin = start.origin;
  const out = args.out || `rescued-${start.hostname}`;
  const maxPages = Math.max(1, Number(args['max-pages']) || 50);
  const delay = args.delay !== undefined ? Math.max(0, Number(args.delay) || 0) : 250;
  const keepScripts = !!args['keep-scripts'];
  const dry = !!args.dry;
  // WordPress media libraries outgrow the defaults: --max-asset-mb / --max-total-mb raise them
  const mbOf = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 1024 * 1024) : 0; };
  const maxAssetBytes = mbOf(args['max-asset-mb']) || MAX_ASSET_BYTES;
  const maxTotalBytes = mbOf(args['max-total-mb']) || MAX_TOTAL_BYTES;
  if (maxAssetBytes > PAGES_FILE_LIMIT_MB * 1024 * 1024) warn(`--max-asset-mb is above ${PAGES_FILE_LIMIT_MB}. Cloudflare Pages refuses any file bigger than ${PAGES_FILE_LIMIT_MB} MB, so a file that big can be copied but not put online there.`);

  // ── --render: a real browser draws each page before it is saved ──
  let renderer = null;
  if (args.render) {
    if (keepScripts) { fail('--keep-scripts cannot be used with --render. A frozen page that still ran the app would be redrawn by it, and edits would be lost.'); process.exit(1); }
    const { openRenderer } = await import('./render.mjs');
    renderer = await openRenderer({ browser: args.browser, menuShim: !!args['menu-shim'], maxAssetBytes, maxTotalBytes });
    if (renderer.error) { fail(renderer.error); process.exit(1); }
    info(`rendering with ${renderer.browserPath}`);
  }

  // ── crawl: same-origin BFS, sequential + polite ──
  hr(`${renderer ? 'Rendering' : 'Crawling'} ${origin} (max ${maxPages} pages, ${delay}ms delay)`);
  let startId = pageIdentity(start.href, origin) || '/';
  const queue = [startId], seen = new Set(queue);
  const pages = new Map();          // identity → { html, url }
  const aliases = new Map();        // redirect-target identity → crawled identity
  const failedPages = [];           // { path, reason }
  const assetRefs = new Set();      // assetKey strings, discovery order
  // The address given may only forward to the real one (a builder's subdomain
  // to the owner's domain, or to www). Follow that once, for the first page.
  const moved = (landedUrl) => {
    if (pages.size || failedPages.length) return false;
    origin = new URL(landedUrl).origin;
    info(`${start.origin} forwards to ${origin}: copying that site`);
    return true;
  };
  // WordPress and Yoast publish sitemap INDEXES (a sitemap of sitemaps); most
  // builders publish one plain file. Once the first page is in hand, try the
  // usual addresses, follow an index into its children politely, and feed every
  // page found into the crawl queue. Capped so a huge archive cannot stall a run.
  let sitemapNote = null;
  // A site that lives in a folder of its host (https://host/shop-demo/) is
  // copied with that folder as the top of the copy, and nothing outside it is
  // tried. Decided once, from the first page (see siteFolder).
  let folder = '';
  const outside = new Set();        // pages of the host outside the folder: linked, not copied
  const leftOut = { signin: new Set(), feeds: new Set(), queryLinks: new Set() };
  const SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml'];
  const MAX_CHILD_SITEMAPS = 20;
  const sitemapSweep = async () => {
    // a site in a folder may publish its own sitemap there: that one first.
    // The host's sitemap lists every site on the host, so only the entries
    // under the folder count, and only a few of its child files are read.
    for (const at of folder ? [folder, ''] : ['']) for (const p of SITEMAP_PATHS) {
      let xml;
      try { const res = await get(origin + at + p); if (!res.ok) continue; xml = await res.text(); } catch { continue; }
      if (!/<(urlset|sitemapindex)[\s>]/i.test(xml)) continue;
      let children = sitemapIndexChildren(xml, origin);
      const under = (c) => { try { return inFolder(new URL(c).pathname, folder); } catch { return false; } };
      if (folder) children = [...children.filter(under), ...children.filter(c => !under(c))];
      const cap = folder && !at ? 5 : MAX_CHILD_SITEMAPS;
      const found = sitemapPages(xml, origin, folder);
      let read = 1;
      for (const c of children.slice(0, cap)) {
        await sleep(delay);
        try { const r = await get(c); if (r.ok) { found.push(...sitemapPages(await r.text(), origin, folder)); read++; } } catch { /* skip this child */ }
      }
      return { path: at + p, read, skipped: Math.max(0, children.length - cap), pages: [...new Set(found)] };
    }
    return null;
  };
  // --max-pages counts every address tried, not only the ones that became a
  // page: a sitemap of hundreds of addresses that all lead away from the site
  // must end the run at the limit, not keep it going for an hour.
  let tried = 0;
  const skip = (id, reason, more = {}) => { failedPages.push({ path: id, reason, ...more }); console.log(`         skipped: ${reason}`); };
  const movedAway = (id, to) => skip(id, `it has moved to another site, ${new URL(to).host}`, { movedTo: new URL(to).origin });
  while (queue.length && tried < maxPages) {
    let id = queue.shift();
    if (pages.has(id)) continue;   // already kept under this address (a numbered address forwarded to it)
    if (tried) await sleep(delay);
    tried++;
    console.log(`  [${tried}/${maxPages}] ${id}`);
    let html, landedUrl, rendered = null;
    if (renderer) {
      // An address that only forwards to another site is found out with one
      // plain request, before a browser is opened for it. (One that is sent
      // away by script once the page is open is caught in the browser, at once.)
      if (tried > 1) {
        let to = null;
        try { const pre = await get(origin + id); pre.body?.cancel?.().catch(() => {}); if (!sameSite(pre.url, origin)) to = pre.url; }
        catch { /* the browser will say what is wrong with it */ }
        if (to) { movedAway(id, to); continue; }
      }
      let r;
      try { r = await renderer.render(origin + id, { first: tried === 1 }); }
      catch (e) { skip(id, String(e.message).split('\n')[0]); continue; }
      if (r.reason) { skip(id, r.reason); continue; }
      if (r.moved) { movedAway(id, r.moved); continue; }
      if (new URL(r.url).origin !== origin) {
        if (!moved(r.url) && !sameSite(r.url, origin)) { movedAway(id, r.url); continue; }
      }
      if (r.status >= 400) { skip(id, `the site answered with an error (HTTP ${r.status})`); continue; }
      if (r.html === undefined) { skip(id, `it is not a page (${(r.contentType || '').split(';')[0]})`); continue; }
      html = r.html; landedUrl = r.url; rendered = r;
    } else {
      let res;
      try { res = await get(origin + id); }
      catch (e) { skip(id, e.name === 'TimeoutError' ? 'the site took too long to answer' : `it could not be reached (${String(e.cause?.code || e.message)})`); continue; }
      const landed = new URL(res.url);
      if (landed.origin !== origin && !moved(res.url) && !sameSite(landed, origin)) { movedAway(id, res.url); continue; }
      if (!res.ok) { skip(id, `the site answered with an error (HTTP ${res.status})`); continue; }
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct && !ct.includes('text/html')) { skip(id, `it is not a page (${ct.split(';')[0]})`); continue; }
      html = await res.text(); landedUrl = res.url;
    }
    const finalId = pageIdentity(landedUrl, origin);
    if (finalId && finalId !== id) {
      // redirected within the origin: same page under two paths — keep one copy
      if (pages.has(finalId)) { aliases.set(id, finalId); console.log(`         the same page as ${finalId}, already read`); continue; }
      // an address that names a page by number (?p=14) and forwards to the
      // page's proper address: keep the page under the proper one
      if (id.includes('?') && !finalId.includes('?')) { aliases.set(id, finalId); seen.add(finalId); id = finalId; }
      else aliases.set(finalId, id);
    }
    const firstPage = !pages.size;
    const refs = extractRefs(html, landedUrl);
    if (firstPage) {
      folder = siteFolder(landedUrl, refs.pages);
      // the address given forwarded into the folder the site lives in: keep
      // the page under the address it landed on, so it becomes the home page
      if (folder && finalId && finalId !== id && !inFolder(id, folder)) {
        aliases.delete(finalId); aliases.set(id, finalId); seen.add(finalId);
        if (id === startId) startId = finalId;
        id = finalId;
      }
      if (folder) info(`${origin}${folder}/ is a site in a folder of its own: copying what is under ${folder}/, with its home page at the top of the copy`);
    }
    // a plain request to a site drawn by JavaScript gets the empty shell
    const blank = !renderer && looksBlank(html);
    if (blank) console.log('         blank: nothing is on this page until its JavaScript runs');
    pages.set(id, { html, url: landedUrl, rendered, blank });
    const found = [...refs.pages];
    // addresses the app moved to by script, and (after the first page) the sitemap
    for (const r of rendered?.routes || []) { const p = pageIdentity(r, origin); if (p && !isFileId(p)) found.push(p); }
    if (firstPage) {
      const sm = await sitemapSweep();
      if (sm) {
        sitemapNote = { path: sm.path, read: sm.read, skipped: sm.skipped, found: sm.pages.length };
        info(`sitemap ${sm.path}: ${sm.pages.length} page${sm.pages.length === 1 ? '' : 's'} listed (${sm.read} file${sm.read === 1 ? '' : 's'} read${sm.skipped ? `, ${sm.skipped} more child sitemaps skipped` : ''})`);
        found.push(...sm.pages);
      }
    }
    for (const p of found) {
      if (seen.has(p)) continue;
      if (!inFolder(p, folder)) { outside.add(p); continue; }
      seen.add(p); queue.push(p);
    }
    for (const k of Object.keys(leftOut)) for (const a of refs[k]) if (inFolder(a.split('?')[0], folder)) leftOut[k].add(a);
    for (const a of refs.assets) assetRefs.add(a);
  }
  if (renderer) await renderer.close();
  const unvisited = queue.length;
  // Blank pages are never written and never counted as copied. When the first
  // page or half the pages are blank, the site as a whole is drawn by
  // JavaScript: the run ends by saying so, with the command to use instead.
  const blankIds = [...pages].filter(([, p]) => p.blank).map(([id]) => id);
  const read = pages.size;
  for (const id of blankIds) pages.delete(id);
  const blank = { ids: blankIds, read, drawn: blankIds.length > 0 && (blankIds.includes(startId) || blankIds.length * 2 >= read), command: renderCommand(startUrl, args) };
  const sayBlank = () => {
    if (!blankIds.length) return;
    const n = blankIds.length;
    const what = `${n === read ? `All ${n}` : `${n} of the ${read}`} pages read from ${origin} ${n === 1 ? 'is' : 'are'} blank. This site draws ${n === 1 && !blank.drawn ? 'that page' : 'its pages'} with JavaScript, so a plain copy of ${n === 1 ? 'it is an empty page' : 'them is empty pages'}.`;
    const kept = pages.size ? ` ${n === 1 ? 'It was' : 'They were'} left out, and the ${pages.size === 1 ? 'one page that has' : `${pages.size} pages that have`} words on ${pages.size === 1 ? 'it was' : 'them were'} ${dry ? 'read' : 'copied'}.` : ' Nothing was written.';
    console.log('');
    (blank.drawn ? fail : warn)(what + kept + (blank.drawn && pages.size ? ' This copy is not finished: do not put it online as it is.' : ''));
    info('Run this instead. It opens each page in a browser and saves it as it looks once it is drawn:');
    console.log(`\n      ${blank.command}\n`);
    info(RENDER_NEEDS);
  };
  // When most of what was tried has moved to one other site, that is the thing
  // to say, once and by name. The address-by-address list goes in the report.
  const elsewhere = elsewhereOf(failedPages, tried, args);
  if (pages.size) (blank.drawn ? warn : ok)(`crawled ${read} page${read === 1 ? '' : 's'}${blankIds.length ? `, ${blankIds.length} of them blank` : ''}${failedPages.length ? `, ${failedPages.length} address${failedPages.length === 1 ? '' : 'es'} skipped` : ''}${unvisited ? ` (${unvisited} more found beyond --max-pages)` : ''}`);
  if (elsewhere) warn(elsewhere.sentence);
  if (!pages.size) {
    if (!elsewhere) for (const f of failedPages) fail(`${f.path}: ${f.reason}`);
    if (blankIds.length) sayBlank();
    else fail(elsewhere ? 'No page of this address could be copied.' : 'nothing crawled — check the URL and try again');
    process.exit(1);
  }

  // A host that answers "no such site" with a normal page cannot be told from
  // a real one by its status. Its title usually gives it away.
  const firstTitle = looksLikeErrorPage([...pages.values()][0].html);
  if (firstTitle) warn(`the first page is titled "${firstTitle}". If that is an error page, the address is wrong or the site is not published`);

  // ── decide which assets to localize ──
  // same-origin always; off-origin when it's a known builder CDN, or when one
  // host serves >3 assets (that's the site's real CDN, whatever it's called)
  const hostCount = new Map();
  for (const key of assetRefs) { const h = new URL(key).hostname; hostCount.set(h, (hostCount.get(h) || 0) + 1); }
  const localize = [...assetRefs].filter(key => {
    const u = new URL(key);
    // a font service's style sheet and fonts are copied when its terms allow it, and never when they do not
    const fonts = fontService(u);
    if (fonts) return fonts.copy;
    return sameSite(u, origin) || BUILDER_CDN_RE.test(u.hostname) || hostCount.get(u.hostname) > 3;
  });

  // page identity → output file (aliases: both sides of a redirect are one page)
  const pageMap = mapUrls([...pages.keys()], folder);
  for (const [from, to] of aliases) if (!pageMap.has(from) && pageMap.has(to)) pageMap.set(from, pageMap.get(to));

  // what stopped working, read from the pages themselves; --render builds a richer one
  const hrefPages = [...pages].map(([id, p]) => ({ href: fileToHref(pageMap.get(id)), html: p.html }));
  // the phone menu of a plain copy: the script that ran its button is taken out
  const menus = renderer || keepScripts ? [] : hrefPages.map(p => { const m = plainMenu(p.html); return { href: p.href, found: m.found, known: m.known, label: m.label }; });
  const menuLine = plainMenuLine(menus, !!args['menu-shim'], { shim: againCommand(startUrl, args, ['menu-shim']), render: againCommand(startUrl, args, ['render', 'menu-shim']) });
  const plainLost = renderer ? [] : staticLostLines(hrefPages, origin, { menuLine });
  // what the dry run and the real run both say
  const shared = {
    folder, outside: [...outside], maxPages, wantKiln: !args['no-tag'], shop: shopOf(hrefPages), shopLooks: renderer || keepScripts ? null : shopChangesOf(hrefPages),
    leftOut: { signin: [...leftOut.signin], feeds: [...leftOut.feeds], queryLinks: [...leftOut.queryLinks] },
    noHome: !new Set(pageMap.values()).has('index.html'), firstHref: fileToHref(pageMap.get([...pages.keys()][0])),
  };

  if (dry) {
    let scripts = 0;
    const kinds = { own: 0, inline: 0, visitors: {}, outside: {} };
    for (const [, p] of pages) { const c = cleanPage(p.html, { baseUrl: p.url, pageMap, keepScripts, folder }); scripts += c.scripts; addKinds(kinds, c.kinds); }
    printReport({ origin, out, pages, pageMap, failedPages, unvisited, dry, scripts, cruft: 0, kinds,
      localized: [], localizedBytes: 0, planned: localize.length, offOrigin: [...assetRefs].filter(k => !localize.includes(k)),
      skippedAssets: [], tally: null, firstTitle, sitemapNote, plainLost, blank, elsewhere, ...shared });
    sayBlank();
    process.exit(blank.drawn ? 1 : 0);
  }

  // ── download assets (incl. url() refs one level deep inside downloaded CSS) ──
  // no number here: style sheets bring in more files than the pages name, so
  // it never agreed with the count printed when the copying is done
  hr('Localizing assets');
  const downloads = new Map();      // assetKey → { buf, ct }
  const skippedAssets = [];         // { url, reason }
  let totalBytes = 0, capped = false;
  const dlQueue = localize.map(key => ({ key, scan: true }));
  while (dlQueue.length) {
    const { key, scan } = dlQueue.shift();
    if (downloads.has(key)) continue;
    if (capped) { skippedAssets.push({ url: key, reason: 'the limit for the whole run was reached', capped: true }); continue; }
    // the browser already fetched most of these while rendering: no second request
    const held = renderer?.cache.get(key);
    let buf, ct;
    if (held) { buf = held.buf; ct = held.ct; }
    else {
      await sleep(delay);
      let res;
      try { res = await get(key); }
      catch (e) { skippedAssets.push({ url: key, reason: e.name === 'TimeoutError' ? 'timeout' : String(e.cause?.code || e.message) }); continue; }
      // a file the old site itself no longer has was broken before the copy: the report says so in its own words
      if (res.status === 404 || res.status === 410) { skippedAssets.push({ url: key, reason: `the old site no longer has it (HTTP ${res.status})`, missing: true }); continue; }
      if (!res.ok) { skippedAssets.push({ url: key, reason: `HTTP ${res.status}` }); continue; }
      const len = Number(res.headers.get('content-length') || 0);
      if (len > maxAssetBytes) { skippedAssets.push({ url: key, reason: 'bigger than the limit for one file', bytes: len, tooBig: true }); res.body?.cancel?.(); continue; }
      try { buf = Buffer.from(await res.arrayBuffer()); }
      catch { skippedAssets.push({ url: key, reason: 'download failed' }); continue; }
      ct = (res.headers.get('content-type') || '').toLowerCase();
    }
    if (buf.length > maxAssetBytes) { skippedAssets.push({ url: key, reason: 'bigger than the limit for one file', bytes: buf.length, tooBig: true }); continue; }
    if (totalBytes + buf.length > maxTotalBytes) {
      capped = true;
      console.log('');
      warn(`reached the limit of ${mb(maxTotalBytes)} for the whole run, so the files not copied yet stay on the old site. The pages load them from there by their full address, and they will disappear when the old site is switched off. RESCUE-REPORT.md lists them, with the command to copy them too.`);
      skippedAssets.push({ url: key, reason: 'the limit for the whole run was reached', bytes: buf.length, capped: true });
      continue;
    }
    totalBytes += buf.length;
    downloads.set(key, { buf, ct });
    process.stdout.write(`\r  ${downloads.size}/${localize.length}+ downloaded (${mb(totalBytes)})   `);
    // one level deep: fonts/images referenced by a stylesheet we just localized
    if (scan && (ct.includes('text/css') || /\.css$/i.test(new URL(key).pathname))) {
      for (const ref of cssUrls(buf.toString('utf8'))) {
        try {
          const u = new URL(ref, key);
          // a font service's style sheet named by this one (@import) is read too, for the font files it names
          const fonts = fontService(u);
          if (fonts && !fonts.copy) continue;
          if (/^https?:$/.test(u.protocol) && !downloads.has(siteKey(u, new URL(key)))) dlQueue.push({ key: siteKey(u, new URL(key)), scan: !!fonts });
        } catch { /* skip */ }
      }
    }
  }
  console.log('');
  // the size of what the limit kept out, so the report can name the biggest
  // (a HEAD request each, for the first 50: it downloads nothing)
  for (const s of skippedAssets.filter(x => x.capped && !x.bytes).slice(0, 50)) {
    await sleep(delay);
    try {
      const res = await fetch(s.url, { method: 'HEAD', headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      const len = Number(res.headers.get('content-length') || 0);
      if (res.ok && len) s.bytes = len;
    } catch { /* size stays unknown */ }
  }
  const assetMap = new Map();
  for (const [key, d] of downloads) assetMap.set(key, `assets/rescued/${assetFileName(key, d.ct)}`);

  // ── write: assets (CSS rewritten), then cleaned pages ──
  mkdirSync(path.join(out, 'assets', 'rescued'), { recursive: true });
  const leftBehind = new Set();     // same-site files the copy loads from the old site
  for (const [key, d] of downloads) {
    const dest = path.join(out, assetMap.get(key));
    if (d.ct.includes('text/css') || /\.css$/i.test(new URL(key).pathname)) {
      const r = rewriteCssUrls(d.buf.toString('utf8'), { base: key, assetMap, sameDir: true });
      r.leftBehind.forEach(u => leftBehind.add(u));
      writeFileSync(dest, r.css);
    } else writeFileSync(dest, d.buf);
  }
  ok(`localized ${downloads.size} assets (${mb(totalBytes)}) into ${path.join(out, 'assets', 'rescued')}/`);

  hr('Cleaning pages');
  let scripts = 0, cruft = 0, previews = 0, oldHead = 0;
  const kinds = { own: 0, inline: 0, visitors: {}, outside: {} };
  const shown = [];   // per page: parts the old site showed with a script
  const offOrigin = new Set(skippedAssets.map(s => s.url));
  for (const [id, p] of pages) {
    const cleaned = cleanPage(p.html, { baseUrl: p.url, pageMap, assetMap, keepScripts, folder });
    scripts += cleaned.scripts; cruft += cleaned.cruft; previews += cleaned.previews; oldHead += cleaned.oldHead; addKinds(kinds, cleaned.kinds);
    cleaned.offOrigin.forEach(u => offOrigin.add(u));
    cleaned.leftBehind.forEach(u => leftBehind.add(u));
    const file = pageMap.get(id);
    shown.push({ href: fileToHref(file), ...cleaned.shown });
    mkdirSync(path.join(out, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(out, file), cleaned.html);
    console.log(`  ✓ ${file}  (${cleaned.scripts} scripts stripped)`);
  }
  // the one added style sheet, only when a page needs it
  if (shown.some(p => p.sheet)) writeFileSync(path.join(out, SHOWN_SHEET), SHOWN_CSS);

  // ── auto-tag for Kiln editing ──
  let tally = null;
  if (!args['no-tag']) {
    hr('Auto-tagging for Kiln');
    const { autotag } = await import(pathToFileURL(path.join(PKG_ROOT, 'src', 'autotag.js')).href);
    tally = { fields: 0, images: 0, repeats: 0, menu: 0 };
    for (const file of new Set(pageMap.values())) {
      const p = path.join(out, file);
      const raw = readFileSync(p, 'utf8');
      const { html, counts } = autotag(raw);
      if (html !== raw) writeFileSync(p, html);
      for (const k of Object.keys(tally)) tally[k] += counts[k];
    }
    ok(`tagged ${tally.fields} text fields · ${tally.images} images · ${tally.repeats} block lists · ${tally.menu} menus`);
  }

  // ── Kiln's script tags and bundles, so the copy is ready to edit once pushed ──
  const wantKiln = !args['no-tag'];
  const plainShim = !!args['menu-shim'] && menus.some(m => m.known);
  const shimmed = plainShim || [...pages.values()].some(p => p.rendered?.menu?.shimmed);
  let menuStyle = '', left = 0;
  if (shimmed) {
    const { MENU_SHIM, MENU_STYLE } = await import('./render.mjs');
    menuStyle = MENU_STYLE;
    writeFileSync(path.join(out, 'assets', 'kiln-menu.js'), MENU_SHIM);
  }
  for (const [id, p] of pages) {
    const fp = path.join(out, pageMap.get(id));
    const raw = readFileSync(fp, 'utf8');
    // a plain copy: mark the menu button and what it opens, for assets/kiln-menu.js
    const marked = plainShim ? plainMenu(raw, { apply: true }) : null;
    const wired = wireKiln(marked?.known ? marked.html : raw, { kiln: wantKiln, menuStyle: p.rendered?.menu?.shimmed || marked?.known ? menuStyle : '' });
    if (wired !== raw) writeFileSync(fp, wired);
    if (!keepScripts) left += appScripts(wired);
  }
  if (plainShim) ok('added a small script that opens the phone menu (assets/kiln-menu.js)');
  let tryOut = false;
  if (wantKiln) {
    const bundles = ['kiln.js', 'kiln-editor.js', 'kiln-features.js'];
    if (bundles.every(f => existsSync(path.join(PKG_ROOT, 'dist', f)))) {
      for (const f of bundles) cpSync(path.join(PKG_ROOT, 'dist', f), path.join(out, 'assets', f));
      ok('added Kiln\'s two script tags to every page and its files to assets/');
    } else warn('Kiln\'s script tags were added, but its files were not found to copy. The setup wizard will add them.');
    const cfgFile = path.join(out, 'assets', 'kiln-config.js');
    if (args.try && !existsSync(cfgFile)) {
      writeFileSync(cfgFile, TRY_CONFIG);
      tryOut = true;
      ok('wrote a try-out config: serve this folder and click a word (edits stay in your browser)');
    }
  }

  printReport({ origin, out, pages, pageMap, failedPages, unvisited, dry: false, scripts, cruft, kinds, previews, shown,
    localized: [...downloads.keys()], localizedBytes: totalBytes, planned: localize.length,
    offOrigin: [...offOrigin], skippedAssets, tally, rendered: !!args.render, left, wantKiln, tryOut, firstTitle,
    requests: renderer?.requests, sitemapNote, plainLost, blank, elsewhere, ...shared, oldHead,
    notCopied: notCopiedOf(skippedAssets, leftBehind),
    again: { url: startUrl, args, totalBytes, maxAssetBytes, maxTotalBytes, capped } });
  sayBlank();
  // a copy that is mostly blank pages did not work, whatever was written
  process.exit(blank.drawn ? 1 : 0);
}

const TRY_CONFIG = `// Try-out copy written by "kiln rescue --try": edits stay in this browser and
// nothing is published. Delete this file before running the setup wizard
// (npx github:kilncms/kiln#release), which writes the real one.
window.KILN = {
  repo:   'local/try-out',
  branch: 'main',
  worker: '',
  sandbox: true,
  styles: [],
};
`;

function printReport(r) {
  const written = new Set(r.pageMap.values()).size;
  const lines = [];
  lines.push(`# ${r.dry ? 'What would be copied from' : 'What was copied from'} ${r.origin}${r.folder ? r.folder + '/' : ''}`);
  lines.push('');
  const more = r.unvisited ? ` ${r.unvisited} more address${r.unvisited === 1 ? ' was' : 'es were'} found and not tried, because the run was set to stop after ${r.maxPages} page${r.maxPages === 1 ? '' : 's'} (--max-pages). To copy ${r.unvisited === 1 ? 'it' : 'them'} too, run again with a bigger --max-pages.` : '';
  // Blank pages have a line of their own just below, and addresses that were
  // skipped have theirs further down, so this line counts what was copied.
  const noFile = r.pages.size - written;
  lines.push(r.dry
    ? `- Pages found: ${r.pages.size}. This was a trial run, so nothing was copied.${more}`
    : `- Pages copied: ${written}.${noFile > 0 ? ` ${r.pages.size} pages were read, and ${noFile} of them ${noFile === 1 ? 'was' : 'were'} not given a file of ${noFile === 1 ? 'its' : 'their'} own.` : ''}${more}`);
  lines.push(...folderLines(r));
  if (r.noHome) lines.push(`- Check this: the copy has no home page. A site opens the file index.html at its top first, and this copy has none there, because the address given was not the site's home page. The first page copied is at ${r.firstHref}. Run the rescue on the address of the home page, or copy the file of the page you want as the home page to index.html at the top of this folder.`);
  lines.push(r.dry
    ? `- Pictures, styles, fonts and other files to copy: at least ${r.planned}. Style sheets usually bring in more (fonts, background pictures), and those are counted when they are copied.`
    : `- Pictures, styles, fonts and other files copied: ${r.localized.length} (${mb(r.localizedBytes)})`);
  if (r.sitemapNote) {
    const sm = r.sitemapNote, was = (n) => (n === 1 ? 'was' : 'were');
    const files = sm.skipped
      ? ` The list is split into several files: ${sm.read} ${was(sm.read)} read and ${sm.skipped} more ${was(sm.skipped)} not, because the rescue reads only so many in one run.`
      : sm.read > 1 ? ` The list is split into ${sm.read} files, and all of them were read.` : '';
    lines.push(`- The site's own list of its pages (${sm.path}) names ${sm.found} page${sm.found === 1 ? '' : 's'}.${files}`);
  }
  const kindsLine = r.scripts ? scriptKindsLine(r.kinds) : '';
  lines.push(`- Scripts taken out: ${r.scripts}${r.cruft ? ` (and ${r.cruft} leftover tag${r.cruft === 1 ? '' : 's'} of the tool that built the site)` : ''}${kindsLine ? `. ${kindsLine}` : ''}`);
  const shownSays = shownLine(r.shown);
  if (shownSays) lines.push(shownSays);
  if (r.previews && r.folder) lines.push(`- The picture for link previews (og:image, twitter:image) is in the copy, and the pages name it by its place there, /assets/rescued/…. The services that draw previews need a full address, and the copy has none yet: the old site lived in the folder ${r.folder}/, and this copy is made to be the top of a site. When the copy is live, put its address in front on each page, like https://your-address/assets/rescued/….`);
  else if (r.previews) lines.push(`- The picture for link previews (og:image, twitter:image) is written with this site's full address, ${r.origin}/assets/rescued/…, because the services that draw previews need a full address. If the copy goes live at a different address, change it on each page.`);
  if (r.firstTitle) lines.push(`- Check this first: the first page is titled "${r.firstTitle}". If that is an error page, the address is wrong or the site is not published, and this is a copy of the error.`);
  if (r.rendered && !r.dry) lines.push(`- Opened in a browser: every page was opened, scrolled to the end and saved as it looked. Scripts of the old site left in the pages: ${r.left}. Times the browser asked a website for something along the way: ${r.requests}`);
  const some = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  if (r.tally) lines.push(`- Marked so you can edit them: ${some(r.tally.fields, 'piece of text', 'pieces of text')}, ${some(r.tally.images, 'picture', 'pictures')}, ${some(r.tally.repeats, 'list of blocks', 'lists of blocks')}, ${some(r.tally.menu, 'menu', 'menus')}`);
  // The file names every skipped address. The terminal names the first ten
  // when there are many: hundreds of lines would bury everything else.
  const SKIPPED_HERE = '\u0000skipped';
  let skippedFull = [], skippedShort = [];
  if (r.failedPages.length) {
    const n = r.failedPages.length;
    const row = (f) => `  - ${f.path}: ${f.reason}`;
    const why = r.elsewhere ? ` ${r.elsewhere.sentence}` : '';
    skippedFull = [`- Addresses skipped: ${n}.${why}${why ? ' Each one, with the reason:' : ''}`, ...r.failedPages.map(row)];
    skippedShort = n > 12 && !r.dry
      ? [`- Addresses skipped: ${n}.${why} The first 10 are below, and RESCUE-REPORT.md lists them all with the reason:`, ...r.failedPages.slice(0, 10).map(row), `  - and ${n - 10} more`]
      : skippedFull;
    lines.push(SKIPPED_HERE);
  }
  const emit = () => {
    const text = (block) => lines.flatMap(l => (l === SKIPPED_HERE ? block : [l])).join('\n');
    if (!r.dry) writeFileSync(path.join(r.out, 'RESCUE-REPORT.md'), text(skippedFull) + '\n');
    hr(r.dry ? 'Report (trial run, nothing copied)' : 'Report');
    console.log(text(skippedShort).split('\n').map(l => `  ${l}`).join('\n'));
    if (!r.dry) (r.blank?.drawn ? info : ok)(`full report saved to ${path.join(r.out, 'RESCUE-REPORT.md')}`);
  };
  const fontsLeft = fontsLeftOf(r.offOrigin, r.skippedAssets, r.localized);
  const fromFontService = (u) => fontsLeft.some(f => f.url === u);
  const notCopied = (r.notCopied || []).filter(f => !fromFontService(f.url));
  const gone = notCopied.filter(f => f.missing).length, stillThere = notCopied.length - gone;
  if (fontsLeft.length) lines.push(`- Files still coming from a font service: ${fontsLeft.length} (see "Fonts that still come from a font service" below)`);
  if (stillThere) lines.push(`- Files not copied, still loading from the old site: ${stillThere} (see "Files not copied" below)`);
  if (gone) lines.push(`- Files already missing on the old site: ${gone} (see "Files already missing on the old site" below)`);
  const left = r.offOrigin.filter(u => !r.localized.includes(u) && !notCopied.some(f => f.url === u) && !fromFontService(u));
  if (left.length) {
    lines.push(`- Things the pages still load from other websites, left as they were: ${left.length}`);
    for (const u of left.slice(0, 30)) lines.push(`  - ${u}`);
    if (left.length > 30) lines.push(`  - …and ${left.length - 30} more`);
  }
  if (r.blank?.ids.length) lines.splice(3, 0, `- Blank pages left out: ${r.blank.ids.length} of the ${r.blank.read} read (see "${r.blank.drawn ? 'This copy is not finished' : 'Blank pages left out'}" below)`);
  if (r.folder && r.oldHead) lines.push(`- The head of each page still names the page's old address under ${r.origin}${r.folder}/ (the canonical link and og:url, ${r.oldHead} in all). When the copy is live at its own address, change them to it, or search engines will go on pointing at the old one.`);
  const leftOutSays = leftOutLine(r.leftOut?.signin, r.leftOut?.feeds), queriesSay = queryLinksLine(r.leftOut?.queryLinks);
  if (leftOutSays) lines.push(leftOutSays);
  if (queriesSay) lines.push(queriesSay);
  lines.push('');
  lines.push(...shopLines(r.shop), ...shopChangeLines(r.shopLooks));
  lines.push(...blankLines(r.blank));
  if (!r.dry) lines.push(...notCopiedLines(notCopied, r.again), ...fontServiceLines(fontsLeft));
  if (r.rendered) {
    lines.push(...lostLines([...r.pages].map(([id, p]) => ({ href: fileToHref(r.pageMap.get(id)), rendered: p.rendered }))));
  } else if (r.plainLost?.length) {
    lines.push(...r.plainLost);
  }
  lines.push('## Next steps');
  lines.push('');
  if (r.blank?.drawn) {
    // most of the site is missing: the steps that put a copy online are not offered
    lines.push('Run the command under "This copy is not finished" first. Most of the site is missing from this folder, so do not put it online as it is.');
    lines.push('');
    return emit();
  }
  if (r.tryOut) {
    lines.push('To try editing now: serve this folder (`npx serve .`), open it and click a word. Nothing is published from a try-out copy.');
    lines.push('Before step 3, delete `assets/kiln-config.js`: the wizard writes the real one.');
    lines.push('');
  }
  lines.push('```');
  lines.push(`cd ${r.out} && git init -b main && git add -A && git commit -m "Rescued from ${r.origin}"`);
  lines.push('```');
  lines.push('');
  lines.push('1. Create a GitHub repo and push (`gh repo create my-site --private --source . --push`).');
  lines.push('2. Deploy on Cloudflare Pages: Connect to Git, build command EMPTY, output directory `/`.');
  lines.push(r.wantKiln
    ? '3. Connect Kiln: `npx github:kilncms/kiln#release` in this folder. Every page already loads Kiln, so after that you open `/kiln`, sign in and click a word.'
    : '3. Wire up Kiln editing: `npx github:kilncms/kiln#release` in this folder.');
  lines.push('');
  emit();
}
