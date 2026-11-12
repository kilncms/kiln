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
 *        [--render [--browser=path] [--menu-shim]] [--try]
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
const MAX_ASSET_BYTES = 20 * 1024 * 1024;    // per file; --max-asset-mb changes it
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;   // per run; --max-total-mb changes it
const PAGES_FILE_LIMIT_MB = 25;              // Cloudflare Pages refuses a bigger file
// off-origin hosts that are really "the builder's disk" — localize these too
const BUILDER_CDN_RE = /(^|\.)(squarespace-cdn\.com|squarespace\.com|wixstatic\.com|parastorage\.com|wp\.com|wordpress\.com|googleusercontent\.com|cloudfront\.net|fastly\.net|fastly\.com|lovable\.app|lovableproject\.com|lovable\.dev|vercel-storage\.com|supabase\.co)$/i;
const TRACKER_RE = /googletagmanager\.com|google-analytics\.com|doubleclick\.net|googleadservices\.com|connect\.facebook\.net|facebook\.com\/tr|hotjar\.com|clarity\.ms|mc\.yandex|matomo|plausible\.io|segment\.com/i;
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

/** Page identity: same-origin pathname, ?query and #fragment stripped, trailing
 *  slash and /index.html dropped (so /about, /about/ and /about/index.html are
 *  one page). null = not a page URL. */
export function pageIdentity(href, base) {
  let u; try { u = new URL(href, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (base && !sameSite(u, new URL(base))) return null;
  const p = u.pathname.replace(/\/index\.html?$/i, '/');
  return p.length > 1 ? (p.replace(/\/+$/, '') || '/') : p;
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
 */
export function mapUrls(identities) {
  const map = new Map(), taken = new Set();
  for (const p of identities) {
    if (map.has(p)) continue;
    let file;
    if (p === '/') file = 'index.html';
    else {
      const segs = p.replace(/^\/+|\/+$/g, '').split('/').map(fileSeg);
      file = /\.html?$/i.test(segs[segs.length - 1]) ? segs.join('/') : segs.join('/') + '/index.html';
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

const cssUrls = (css) => {
  const out = [];
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")\s][^'")]*)\1\s*\)/gi)) out.push(m[2]);
  return out;
};

/** One parse per fetched page: same-origin page links + every asset reference
 *  (any origin — the crawler decides later what to localize). */
export function extractRefs(html, pageUrl) {
  const doc = parse(html);
  const base = baseOf(doc, pageUrl);
  const pages = new Set(), assets = new Set();
  const asset = (val) => {
    if (!val || /^(data:|blob:|#)/i.test(String(val).trim())) return;
    try { const u = new URL(String(val).trim(), base); if (/^https?:$/.test(u.protocol)) assets.add(siteKey(u, base)); } catch { /* skip */ }
  };
  const srcset = (val) => String(val).split(',').forEach(part => asset(part.trim().split(/\s+/)[0]));
  walkTree(doc, n => {
    switch (n.tagName) {
      case 'a': {
        const id = pageIdentity(getAttr(n, 'href') || '', base);
        if (id && !NON_PAGE_RE.test(id)) pages.add(id);
        break;
      }
      case 'img': case 'source':
        for (const at of ['src', 'data-src', 'data-image']) asset(getAttr(n, at));
        for (const at of ['srcset', 'data-srcset']) if (getAttr(n, at)) srcset(getAttr(n, at));
        break;
      case 'link': {
        const rels = relsOf(n);
        if (rels.includes('stylesheet') || rels.some(r => ICON_RELS.includes(r))) asset(getAttr(n, 'href'));
        break;
      }
      case 'meta': {
        const key = (getAttr(n, 'property') || getAttr(n, 'name') || '').toLowerCase();
        if (['og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'].includes(key)) asset(getAttr(n, 'content'));
        break;
      }
      case 'use': asset(getAttr(n, 'href') || getAttr(n, 'xlink:href')); break;   // svg sprites
      case 'style': cssUrls(textOf(n)).forEach(asset); break;
    }
    if (n.attrs && getAttr(n, 'style')?.includes('url(')) cssUrls(getAttr(n, 'style')).forEach(asset);
  });
  return { pages: [...pages], assets: [...assets] };
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
  const out = css.replace(/url\(\s*(['"]?)([^'")\s][^'")]*)\1\s*\)/gi, (m, q, ref) => {
    if (/^(data:|blob:|#)/i.test(ref)) return m;
    let u; try { u = new URL(ref, base); } catch { return m; }
    if (!/^https?:$/.test(u.protocol)) return m;
    const local = assetMap.get(siteKey(u, base));
    if (local) return `url(${q}${opts.sameDir ? local.split('/').pop() : '/' + local}${u.hash || ''}${q})`;
    if (!sameSite(u, base)) { offOrigin.add(u.href); return m; }
    leftBehind.add(siteKey(u, base));
    return `url(${q}${base.origin}${u.pathname}${u.search}${u.hash}${q})`;
  });
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
 *         keepScripts }.
 * Returns { html, scripts, cruft, offOrigin, leftBehind } — scripts/cruft =
 * removal counts, offOrigin = other sites' asset URLs left as they were,
 * leftBehind = same-site files now loaded from the old site.
 */
export function cleanPage(html, opts = {}) {
  const pageMap = opts.pageMap || new Map();
  const assetMap = opts.assetMap || new Map();
  const doc = parse(html);
  const base = baseOf(doc, opts.baseUrl || 'http://localhost/');
  const offOrigin = new Set(), leftBehind = new Set();
  let scripts = 0, cruft = 0;
  const removals = [];

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
      if (file) return fileToHref(file) + u.search + u.hash;
    }
    // a file of this site that was not copied: a root-relative path would find
    // nothing in the copy, so point at it where it still is
    if (kind === 'asset' || NON_PAGE_RE.test(u.pathname)) {
      leftBehind.add(siteKey(u, base));
      return base.origin + u.pathname + u.search + u.hash;
    }
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
    switch (n.tagName) {
      case 'script': {
        const type = (getAttr(n, 'type') || '').toLowerCase();
        if (opts.keepScripts) { rwAttr(n, 'src', 'plain'); break; }
        if (type.includes('ld+json')) {   // structured data is content, not runtime
          try { JSON.parse(textOf(n)); } catch { removals.push(n); scripts++; }
        } else { removals.push(n); scripts++; }
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
        else if (rels.includes('stylesheet') || rels.some(r => ICON_RELS.includes(r))) rwAttr(n, 'href', 'asset');
        else rwAttr(n, 'href', 'plain');
        break;
      }
      case 'meta': {
        const key = (getAttr(n, 'property') || getAttr(n, 'name') || '').toLowerCase();
        if (key === 'generator') { removals.push(n); cruft++; }
        else if (['og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'].includes(key)) rwAttr(n, 'content', 'asset');
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
        rwAttr(n, 'data-src', 'asset'); rwAttr(n, 'data-image', 'asset'); rwSrcset(n, 'data-srcset');
        // the lazy-loader that would promote data-src at runtime is gone — do its job now
        if (!getAttr(n, 'src') && getAttr(n, 'data-src')) n.attrs.push({ name: 'src', value: getAttr(n, 'data-src') });
        if (!getAttr(n, 'srcset') && getAttr(n, 'data-srcset')) n.attrs.push({ name: 'srcset', value: getAttr(n, 'data-srcset') });
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
    }
    if (n.attrs && getAttr(n, 'style')?.includes('url(')) setAttr(n, 'style', rwCssText(getAttr(n, 'style')));
  });
  for (const n of removals) {
    const kids = n.parentNode?.childNodes;
    const i = kids ? kids.indexOf(n) : -1;
    if (i >= 0) kids.splice(i, 1);
  }
  return { html: serialize(doc), scripts, cruft, offOrigin: [...offOrigin], leftBehind: [...leftBehind] };
}

// ─── pure: sitemap, Kiln wiring, the "what was lost" report ──────────────────

/** Same-origin page paths listed in one sitemap file. A sitemap INDEX (a sitemap
 *  of sitemaps, the WordPress and Yoast default) lists only .xml files, which
 *  NON_PAGE_RE filters out — read its children with sitemapIndexChildren. */
export function sitemapPages(xml, origin) {
  const out = [];
  for (const m of String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const id = pageIdentity(m[1].replace(/&amp;/g, '&'), origin);
    if (id && !NON_PAGE_RE.test(id) && !out.includes(id)) out.push(id);
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

/**
 * What stopped working when the pages were frozen, as report lines.
 * pages: [{ href, rendered }] where rendered is what render.mjs returned.
 */
export function lostLines(pages) {
  const list = pages.filter(p => p.rendered);
  if (!list.length) return [];
  const L = ['## What freezing cost', '',
    'These pages are now plain HTML. Whatever the app did with script after a page was drawn has stopped. Check each item below.', ''];
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
  else if (shimmed.length === withMenu.length) L.push(`- Phone menu: works. The button "${withMenu[0].rendered.menu.label}" opens it through assets/kiln-menu.js, a small script with no dependencies, on ${where(shimmed.map(p => p.href))}.`);
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
    L.push(`- Text that was invisible when frozen (it was waiting for an animation) on ${where(invisible.map(p => p.href))}:`);
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
export function staticLostLines(pages, origin) {
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
  if (!dead.length && !outside.length && !searches.length && !comments.length && !logins.size) return [];
  const where = (hrefs) => { const u = [...new Set(hrefs)]; return u.length > 4 ? `${u.slice(0, 4).join(', ')} and ${u.length - 4} more` : u.join(', '); };
  const group = (items, keyOf) => { const m = new Map(); for (const it of items) { const k = keyOf(it); if (!m.has(k)) m.set(k, []); m.get(k).push(it.href); } return m; };
  const L = ['## What freezing cost', '',
    'These pages are plain HTML now, with nothing running behind them. Check each item below.', ''];
  if (dead.length) {
    L.push(`- Forms that posted into the old site: ${dead.length}. They now send nowhere. Point each one at a form service, or replace it with an email link.`);
    for (const [k, hrefs] of group(dead, f => `"${f.label}" (${f.fields} field${f.fields === 1 ? '' : 's'}${f.action ? `, posted to ${f.action}` : ''})`)) L.push(`  - ${k} on ${where(hrefs)}`);
  } else L.push('- Forms that posted into the old site: none.');
  if (outside.length) {
    L.push(`- Forms that post to an outside service, which should still work — send one test from the new site:`);
    for (const [k, hrefs] of group(outside, f => `"${f.label}" (posts to ${f.host})`)) L.push(`  - ${k} on ${where(hrefs)}`);
  }
  if (searches.length) L.push(`- Search boxes on ${where(searches)}: the old server answered them, and it is gone. Remove them, or point them at a search service.`);
  if (comments.length) L.push(`- Comment threads on ${where(comments)}: what was said is kept as shown, and new comments cannot be left.`);
  if (logins.size) L.push(`- Links to the old sign-in (wp-login, wp-admin) on ${where([...logins])}: remove them. Editing happens through Kiln now.`);
  L.push('');
  return L;
}

/** Every file the pages use that is not in the copy: what the download loop
 *  skipped ({ url, reason, bytes? }), then same-site files it never fetches
 *  (a PDF, a video), as [{ url, reason, bytes? }]. */
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
export function notCopiedLines(notCopied, again) {
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
  headers: { 'user-agent': UA, accept: '*/*' },
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
  } catch { fail('Usage: kiln rescue <url> [--out=dir] [--max-pages=N] [--delay=ms] [--max-asset-mb=N] [--max-total-mb=N] [--keep-scripts] [--no-tag] [--dry] [--render [--browser=path] [--menu-shim]] [--try]'); info('What each option does: npx github:kilncms/kiln#release rescue --help'); process.exit(1); }
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
  const startId = pageIdentity(start.href, origin) || '/';
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
  const SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml'];
  const MAX_CHILD_SITEMAPS = 20;
  const sitemapSweep = async () => {
    for (const p of SITEMAP_PATHS) {
      let xml;
      try { const res = await get(origin + p); if (!res.ok) continue; xml = await res.text(); } catch { continue; }
      if (!/<(urlset|sitemapindex)[\s>]/i.test(xml)) continue;
      const children = sitemapIndexChildren(xml, origin);
      const found = sitemapPages(xml, origin);
      let read = 1;
      for (const c of children.slice(0, MAX_CHILD_SITEMAPS)) {
        await sleep(delay);
        try { const r = await get(c); if (r.ok) { found.push(...sitemapPages(await r.text(), origin)); read++; } } catch { /* skip this child */ }
      }
      return { path: p, read, skipped: Math.max(0, children.length - MAX_CHILD_SITEMAPS), pages: [...new Set(found)] };
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
    const id = queue.shift();
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
      aliases.set(finalId, id);
    }
    const firstPage = !pages.size;
    // a plain request to a site drawn by JavaScript gets the empty shell
    const blank = !renderer && looksBlank(html);
    if (blank) console.log('         blank: nothing is on this page until its JavaScript runs');
    pages.set(id, { html, url: landedUrl, rendered, blank });
    const refs = extractRefs(html, landedUrl);
    const found = [...refs.pages];
    // addresses the app moved to by script, and (after the first page) the sitemap
    for (const r of rendered?.routes || []) { const p = pageIdentity(r, origin); if (p && !NON_PAGE_RE.test(p)) found.push(p); }
    if (firstPage) {
      const sm = await sitemapSweep();
      if (sm) {
        sitemapNote = { path: sm.path, read: sm.read, skipped: sm.skipped, found: sm.pages.length };
        info(`sitemap ${sm.path}: ${sm.pages.length} page${sm.pages.length === 1 ? '' : 's'} listed (${sm.read} file${sm.read === 1 ? '' : 's'} read${sm.skipped ? `, ${sm.skipped} more child sitemaps skipped` : ''})`);
        found.push(...sm.pages);
      }
    }
    for (const p of found) if (!seen.has(p)) { seen.add(p); queue.push(p); }
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
    return sameSite(u, origin) || BUILDER_CDN_RE.test(u.hostname) || hostCount.get(u.hostname) > 3;
  });

  // page identity → output file (aliases: both sides of a redirect are one page)
  const pageMap = mapUrls([...pages.keys()]);
  for (const [from, to] of aliases) if (!pageMap.has(from) && pageMap.has(to)) pageMap.set(from, pageMap.get(to));

  // what stopped working, read from the pages themselves; --render builds a richer one
  const plainLost = renderer ? [] : staticLostLines([...pages].map(([id, p]) => ({ href: fileToHref(pageMap.get(id)), html: p.html })), origin);

  if (dry) {
    let scripts = 0;
    for (const [, p] of pages) scripts += cleanPage(p.html, { baseUrl: p.url, pageMap, keepScripts }).scripts;
    printReport({ origin, out, pages, pageMap, failedPages, unvisited, dry, scripts, cruft: 0,
      localized: [], localizedBytes: 0, planned: localize.length, offOrigin: [...assetRefs].filter(k => !localize.includes(k)),
      skippedAssets: [], tally: null, firstTitle, sitemapNote, plainLost, blank, elsewhere });
    sayBlank();
    process.exit(blank.drawn ? 1 : 0);
  }

  // ── download assets (incl. url() refs one level deep inside downloaded CSS) ──
  hr(`Localizing ${localize.length} asset${localize.length === 1 ? '' : 's'}`);
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
          if (/^https?:$/.test(u.protocol) && !downloads.has(siteKey(u, new URL(key)))) dlQueue.push({ key: siteKey(u, new URL(key)), scan: false });
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
  let scripts = 0, cruft = 0;
  const offOrigin = new Set(skippedAssets.map(s => s.url));
  for (const [id, p] of pages) {
    const cleaned = cleanPage(p.html, { baseUrl: p.url, pageMap, assetMap, keepScripts });
    scripts += cleaned.scripts; cruft += cleaned.cruft;
    cleaned.offOrigin.forEach(u => offOrigin.add(u));
    cleaned.leftBehind.forEach(u => leftBehind.add(u));
    const file = pageMap.get(id);
    mkdirSync(path.join(out, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(out, file), cleaned.html);
    console.log(`  ✓ ${file}  (${cleaned.scripts} scripts stripped)`);
  }

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
  const shimmed = [...pages.values()].some(p => p.rendered?.menu?.shimmed);
  let menuStyle = '', left = 0;
  if (shimmed) {
    const { MENU_SHIM, MENU_STYLE } = await import('./render.mjs');
    menuStyle = MENU_STYLE;
    writeFileSync(path.join(out, 'assets', 'kiln-menu.js'), MENU_SHIM);
  }
  for (const [id, p] of pages) {
    const fp = path.join(out, pageMap.get(id));
    const raw = readFileSync(fp, 'utf8');
    const wired = wireKiln(raw, { kiln: wantKiln, menuStyle: p.rendered?.menu?.shimmed ? menuStyle : '' });
    if (wired !== raw) writeFileSync(fp, wired);
    if (!keepScripts) left += appScripts(wired);
  }
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

  printReport({ origin, out, pages, pageMap, failedPages, unvisited, dry: false, scripts, cruft,
    localized: [...downloads.keys()], localizedBytes: totalBytes, planned: localize.length,
    offOrigin: [...offOrigin], skippedAssets, tally, rendered: !!args.render, left, wantKiln, tryOut, firstTitle,
    requests: renderer?.requests, sitemapNote, plainLost, blank, elsewhere,
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
  lines.push(`# Rescue report — ${r.origin}`);
  lines.push('');
  lines.push(`- Pages crawled: ${r.pages.size}${r.dry ? ' (dry run — nothing written)' : `, written: ${written}`}${r.unvisited ? ` — ${r.unvisited} more links found beyond --max-pages` : ''}`);
  lines.push(r.dry
    ? `- Assets to localize: ${r.planned}`
    : `- Assets localized: ${r.localized.length} (${mb(r.localizedBytes)})`);
  if (r.sitemapNote) lines.push(`- Sitemap ${r.sitemapNote.path}: ${r.sitemapNote.found} pages listed (${r.sitemapNote.read} sitemap file${r.sitemapNote.read === 1 ? '' : 's'} read${r.sitemapNote.skipped ? `; ${r.sitemapNote.skipped} more beyond the cap` : ''})`);
  lines.push(`- Scripts stripped: ${r.scripts}${r.cruft ? ` (+ ${r.cruft} builder cruft tags removed)` : ''}`);
  if (r.firstTitle) lines.push(`- Check this first: the first page is titled "${r.firstTitle}". If that is an error page, the address is wrong or the site is not published, and this is a copy of the error.`);
  if (r.rendered && !r.dry) lines.push(`- Rendered in a browser: every page was opened, scrolled to the end and saved as it looked. App scripts left in the pages: ${r.left}. Requests the browser made to do it: ${r.requests}`);
  if (r.tally) lines.push(`- Kiln-tagged: ${r.tally.fields} text fields · ${r.tally.images} images · ${r.tally.repeats} block lists · ${r.tally.menu} menus`);
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
    hr(r.dry ? 'Report (dry run)' : 'Report');
    console.log(text(skippedShort).split('\n').map(l => `  ${l}`).join('\n'));
    if (!r.dry) (r.blank?.drawn ? info : ok)(`full report saved to ${path.join(r.out, 'RESCUE-REPORT.md')}`);
  };
  const notCopied = r.notCopied || [];
  if (notCopied.length) lines.push(`- Files not copied, still loading from the old site: ${notCopied.length} (see "Files not copied" below)`);
  const left = r.offOrigin.filter(u => !r.localized.includes(u) && !notCopied.some(f => f.url === u));
  if (left.length) {
    lines.push(`- Off-origin references left as-is: ${left.length}`);
    for (const u of left.slice(0, 30)) lines.push(`  - ${u}`);
    if (left.length > 30) lines.push(`  - …and ${left.length - 30} more`);
  }
  if (r.blank?.ids.length) lines.splice(3, 0, `- Blank pages left out: ${r.blank.ids.length} of the ${r.blank.read} read (see "${r.blank.drawn ? 'This copy is not finished' : 'Blank pages left out'}" below)`);
  lines.push('');
  lines.push(...blankLines(r.blank));
  if (!r.dry) lines.push(...notCopiedLines(notCopied, r.again));
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
