/**
 * kiln rescue — escape hatch from walled-garden site builders.
 *
 * Crawls a live site you own (Squarespace, Wix, WordPress.com, Google Sites…),
 * writes a clean static-HTML copy with localized assets, strips the builder's
 * runtime scripts, and auto-tags it for Kiln editing. Output is a folder ready
 * to `git init` and push to any static host.
 *
 *   npx github:kilncms/kiln rescue <url> [--out=dir] [--max-pages=N]
 *        [--delay=ms] [--keep-scripts] [--no-tag] [--dry]
 *
 * The pure helpers (pageIdentity, mapUrls, fileToHref, cleanPage,
 * rewriteCssUrls, extractRefs) are exported for tests — no network there.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, serialize } from 'parse5';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// git checkout: assets live one level up; published create-kiln: vendored next to us
const PKG_ROOT = existsSync(path.join(HERE, 'dist', 'kiln.js')) ? HERE : path.resolve(HERE, '..');

const UA = 'kiln-rescue/0.1 (+https://kilncms.com)';
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
// off-origin hosts that are really "the builder's disk" — localize these too
const BUILDER_CDN_RE = /(^|\.)(squarespace-cdn\.com|squarespace\.com|wixstatic\.com|parastorage\.com|wp\.com|wordpress\.com|googleusercontent\.com|cloudfront\.net|fastly\.net|fastly\.com)$/i;
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

function walkTree(node, fn) {
  fn(node);
  for (const c of [...(node.childNodes || [])]) walkTree(c, fn);
  if (node.content) walkTree(node.content, fn);   // <template>
}

// ─── pure: URL → file mapping ────────────────────────────────────────────────

/** Page identity: same-origin pathname, ?query and #fragment stripped, trailing
 *  slash dropped (so /about and /about/ are one page). null = not a page URL. */
export function pageIdentity(href, base) {
  let u; try { u = new URL(href, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (base && u.origin !== new URL(base).origin) return null;
  return u.pathname.length > 1 ? (u.pathname.replace(/\/+$/, '') || '/') : u.pathname;
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
    try { const u = new URL(String(val).trim(), base); if (/^https?:$/.test(u.protocol)) assets.add(assetKey(u)); } catch { /* skip */ }
  };
  const srcset = (val) => String(val).split(',').forEach(part => asset(part.trim().split(/\s+/)[0]));
  walkTree(doc, n => {
    switch (n.tagName) {
      case 'a': {
        const id = pageIdentity(getAttr(n, 'href') || '', base);
        if (id && !NON_PAGE_RE.test(id)) pages.add(id);
        break;
      }
      case 'img': asset(getAttr(n, 'src')); if (getAttr(n, 'srcset')) srcset(getAttr(n, 'srcset')); break;
      case 'source': asset(getAttr(n, 'src')); if (getAttr(n, 'srcset')) srcset(getAttr(n, 'srcset')); break;
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
      case 'style': cssUrls(textOf(n)).forEach(asset); break;
    }
    if (n.attrs && getAttr(n, 'style')?.includes('url(')) cssUrls(getAttr(n, 'style')).forEach(asset);
  });
  return { pages: [...pages], assets: [...assets] };
}

// ─── pure: CSS url() rewriting ───────────────────────────────────────────────

/**
 * Rewrite url() refs in CSS text. Same-origin absolutes → root-relative;
 * localized assets (assetMap: assetKey → assets/rescued/x) → local path —
 * sameDir:true emits just the basename (for CSS files living in that same
 * folder), else a root-relative /assets/rescued/x. Anything else is left and
 * reported in offOrigin.
 */
export function rewriteCssUrls(css, opts = {}) {
  const base = new URL(opts.base || 'http://localhost/');
  const assetMap = opts.assetMap || new Map();
  const offOrigin = new Set();
  const out = css.replace(/url\(\s*(['"]?)([^'")\s][^'")]*)\1\s*\)/gi, (m, q, ref) => {
    if (/^(data:|blob:|#)/i.test(ref)) return m;
    let u; try { u = new URL(ref, base); } catch { return m; }
    if (!/^https?:$/.test(u.protocol)) return m;
    const local = assetMap.get(assetKey(u));
    if (local) return `url(${q}${opts.sameDir ? local.split('/').pop() : '/' + local}${u.hash || ''}${q})`;
    if (u.origin !== base.origin) { offOrigin.add(u.href); return m; }
    return `url(${q}${u.pathname}${u.search}${u.hash}${q})`;
  });
  return { css: out, offOrigin: [...offOrigin] };
}

// ─── pure: page cleaning ─────────────────────────────────────────────────────

/**
 * Clean one page: strip the builder's runtime (<script>s — JSON-LD survives if
 * it parses as JSON), preconnect/dns-prefetch/preload-as-script link tags, meta
 * generator, tracker iframes and noscript pixels, <base>; rewrite same-origin
 * absolute URLs to root-relative, links to crawled pages to their pretty URL,
 * and localized asset refs to /assets/rescued/…
 *
 * opts: { baseUrl, pageMap (identity → file), assetMap (assetKey → local path),
 *         keepScripts }.
 * Returns { html, scripts, cruft, offOrigin } — scripts/cruft = removal counts,
 * offOrigin = asset URLs referenced but not localized.
 */
export function cleanPage(html, opts = {}) {
  const pageMap = opts.pageMap || new Map();
  const assetMap = opts.assetMap || new Map();
  const doc = parse(html);
  const base = baseOf(doc, opts.baseUrl || 'http://localhost/');
  const origin = base.origin;
  const offOrigin = new Set();
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
    const local = assetMap.get(assetKey(u));
    if (local) return '/' + local + (u.hash || '');
    if (u.origin !== origin) {
      if (kind === 'asset') offOrigin.add(u.href);
      return null;
    }
    if (kind === 'page') {
      const file = pageMap.get(pageIdentity(u.href, base));
      if (file) return fileToHref(file) + u.search + u.hash;
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
        if (rels.some(r => ['preconnect', 'dns-prefetch', 'modulepreload'].includes(r)) ||
            (rels.includes('preload') && as === 'script')) { removals.push(n); cruft++; }
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
      case 'img': rwAttr(n, 'src', 'asset'); rwSrcset(n, 'srcset'); break;
      case 'source': rwAttr(n, 'src', 'asset'); rwSrcset(n, 'srcset'); break;
      case 'video': case 'audio': rwAttr(n, 'src', 'asset'); rwAttr(n, 'poster', 'asset'); break;
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
  return { html: serialize(doc), scripts, cruft, offOrigin: [...offOrigin] };
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
  } catch { fail('Usage: kiln rescue <url> [--out=dir] [--max-pages=N] [--delay=ms] [--keep-scripts] [--no-tag] [--dry]'); process.exit(1); }
  const origin = start.origin;
  const out = args.out || `rescued-${start.hostname}`;
  const maxPages = Math.max(1, Number(args['max-pages']) || 50);
  const delay = args.delay !== undefined ? Math.max(0, Number(args.delay) || 0) : 250;
  const keepScripts = !!args['keep-scripts'];
  const dry = !!args.dry;

  // ── crawl: same-origin BFS, sequential + polite ──
  hr(`Crawling ${origin} (max ${maxPages} pages, ${delay}ms delay)`);
  const startId = pageIdentity(start.href, origin) || '/';
  const queue = [startId], seen = new Set(queue);
  const pages = new Map();          // identity → { html, url }
  const aliases = new Map();        // redirect-target identity → crawled identity
  const failedPages = [];           // { path, reason }
  const assetRefs = new Set();      // assetKey strings, discovery order
  while (queue.length && pages.size < maxPages) {
    const id = queue.shift();
    if (pages.size || failedPages.length) await sleep(delay);
    console.log(`  [${pages.size + 1}/${maxPages}] ${id}`);
    let res;
    try { res = await get(origin + id); }
    catch (e) { failedPages.push({ path: id, reason: e.name === 'TimeoutError' ? 'timeout' : String(e.cause?.code || e.message) }); continue; }
    const landed = new URL(res.url);
    if (landed.origin !== origin) { failedPages.push({ path: id, reason: `redirected off-origin → ${landed.origin}` }); continue; }
    if (!res.ok) { failedPages.push({ path: id, reason: `HTTP ${res.status}` }); continue; }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.includes('text/html')) { failedPages.push({ path: id, reason: `not HTML (${ct.split(';')[0]})` }); continue; }
    const html = await res.text();
    pages.set(id, { html, url: res.url });
    const finalId = pageIdentity(res.url, origin);
    if (finalId && finalId !== id && !pages.has(finalId)) aliases.set(finalId, id);
    const refs = extractRefs(html, res.url);
    for (const p of refs.pages) if (!seen.has(p)) { seen.add(p); queue.push(p); }
    for (const a of refs.assets) assetRefs.add(a);
  }
  const unvisited = queue.length;
  ok(`crawled ${pages.size} page${pages.size === 1 ? '' : 's'}${failedPages.length ? `, ${failedPages.length} failed` : ''}${unvisited ? ` (${unvisited} more found beyond --max-pages)` : ''}`);
  if (!pages.size) { fail('nothing crawled — check the URL and try again'); process.exit(1); }

  // ── decide which assets to localize ──
  // same-origin always; off-origin when it's a known builder CDN, or when one
  // host serves >3 assets (that's the site's real CDN, whatever it's called)
  const hostCount = new Map();
  for (const key of assetRefs) { const h = new URL(key).hostname; hostCount.set(h, (hostCount.get(h) || 0) + 1); }
  const localize = [...assetRefs].filter(key => {
    const u = new URL(key);
    return u.origin === origin || BUILDER_CDN_RE.test(u.hostname) || hostCount.get(u.hostname) > 3;
  });

  // page identity → output file (aliases: a redirect target counts as its page)
  const pageMap = mapUrls([...pages.keys()]);
  for (const [target, src] of aliases) if (!pageMap.has(target)) pageMap.set(target, pageMap.get(src));

  if (dry) {
    let scripts = 0;
    for (const [, p] of pages) scripts += cleanPage(p.html, { baseUrl: p.url, pageMap, keepScripts }).scripts;
    printReport({ origin, out, pages, pageMap, failedPages, unvisited, dry, scripts, cruft: 0,
      localized: [], localizedBytes: 0, planned: localize.length, offOrigin: [...assetRefs].filter(k => !localize.includes(k)),
      skippedAssets: [], tally: null });
    process.exit(0);
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
    if (capped) { skippedAssets.push({ url: key, reason: '25 MB total cap reached' }); continue; }
    await sleep(delay);
    let res;
    try { res = await get(key); }
    catch (e) { skippedAssets.push({ url: key, reason: e.name === 'TimeoutError' ? 'timeout' : String(e.cause?.code || e.message) }); continue; }
    if (!res.ok) { skippedAssets.push({ url: key, reason: `HTTP ${res.status}` }); continue; }
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_ASSET_BYTES) { skippedAssets.push({ url: key, reason: `${mb(len)} > 5 MB` }); res.body?.cancel?.(); continue; }
    let buf;
    try { buf = Buffer.from(await res.arrayBuffer()); }
    catch { skippedAssets.push({ url: key, reason: 'download failed' }); continue; }
    if (buf.length > MAX_ASSET_BYTES) { skippedAssets.push({ url: key, reason: `${mb(buf.length)} > 5 MB` }); continue; }
    if (totalBytes + buf.length > MAX_TOTAL_BYTES) {
      capped = true;
      warn(`hit the 25 MB total asset cap — remaining assets keep their original URLs`);
      skippedAssets.push({ url: key, reason: '25 MB total cap reached' });
      continue;
    }
    totalBytes += buf.length;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    downloads.set(key, { buf, ct });
    process.stdout.write(`\r  ${downloads.size}/${localize.length}+ downloaded (${mb(totalBytes)})   `);
    // one level deep: fonts/images referenced by a stylesheet we just localized
    if (scan && (ct.includes('text/css') || /\.css$/i.test(new URL(key).pathname))) {
      for (const ref of cssUrls(buf.toString('utf8'))) {
        try {
          const u = new URL(ref, key);
          if (/^https?:$/.test(u.protocol) && !downloads.has(assetKey(u))) dlQueue.push({ key: assetKey(u), scan: false });
        } catch { /* skip */ }
      }
    }
  }
  console.log('');
  const assetMap = new Map();
  for (const [key, d] of downloads) assetMap.set(key, `assets/rescued/${assetFileName(key, d.ct)}`);

  // ── write: assets (CSS rewritten), then cleaned pages ──
  mkdirSync(path.join(out, 'assets', 'rescued'), { recursive: true });
  for (const [key, d] of downloads) {
    const dest = path.join(out, assetMap.get(key));
    if (d.ct.includes('text/css') || /\.css$/i.test(new URL(key).pathname)) {
      writeFileSync(dest, rewriteCssUrls(d.buf.toString('utf8'), { base: key, assetMap, sameDir: true }).css);
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

  printReport({ origin, out, pages, pageMap, failedPages, unvisited, dry: false, scripts, cruft,
    localized: [...downloads.keys()], localizedBytes: totalBytes, planned: localize.length,
    offOrigin: [...offOrigin], skippedAssets, tally });
  process.exit(0);
}

function printReport(r) {
  const written = new Set(r.pageMap.values()).size;
  const lines = [];
  lines.push(`# Rescue report — ${r.origin}`);
  lines.push('');
  lines.push(`- Pages crawled: ${r.pages.size}${r.dry ? ' (dry run — nothing written)' : `, written: ${written}`}${r.unvisited ? ` — ${r.unvisited} more links found beyond --max-pages` : ''}`);
  lines.push(r.dry
    ? `- Assets to localize: ${r.planned}`
    : `- Assets localized: ${r.localized.length} (${mb(r.localizedBytes)})`);
  lines.push(`- Scripts stripped: ${r.scripts}${r.cruft ? ` (+ ${r.cruft} builder cruft tags removed)` : ''}`);
  if (r.tally) lines.push(`- Kiln-tagged: ${r.tally.fields} text fields · ${r.tally.images} images · ${r.tally.repeats} block lists · ${r.tally.menu} menus`);
  if (r.failedPages.length) {
    lines.push(`- Pages that failed:`);
    for (const f of r.failedPages) lines.push(`  - ${f.path} — ${f.reason}`);
  }
  const left = r.offOrigin.filter(u => !r.localized.includes(u));
  if (left.length) {
    lines.push(`- Off-origin references left as-is: ${left.length}`);
    for (const u of left.slice(0, 30)) lines.push(`  - ${u}`);
    if (left.length > 30) lines.push(`  - …and ${left.length - 30} more`);
  }
  const skipped = r.skippedAssets.filter(s => !left.includes(s.url));
  if (skipped.length) {
    lines.push(`- Assets skipped:`);
    for (const s of skipped.slice(0, 20)) lines.push(`  - ${s.url} — ${s.reason}`);
    if (skipped.length > 20) lines.push(`  - …and ${skipped.length - 20} more`);
  }
  lines.push('');
  lines.push('## Next steps');
  lines.push('');
  lines.push('```');
  lines.push(`cd ${r.out} && git init -b main && git add -A && git commit -m "Rescued from ${r.origin}"`);
  lines.push('```');
  lines.push('');
  lines.push('1. Create a GitHub repo and push (`gh repo create my-site --private --source . --push`).');
  lines.push('2. Deploy on Cloudflare Pages: Connect to Git, build command EMPTY, output directory `/`.');
  lines.push('3. Wire up Kiln editing: `npx github:kilncms/kiln` in this folder.');
  lines.push('');
  const report = lines.join('\n');
  if (!r.dry) writeFileSync(path.join(r.out, 'RESCUE-REPORT.md'), report + '\n');
  hr(r.dry ? 'Report (dry run)' : 'Report');
  console.log(report.split('\n').map(l => `  ${l}`).join('\n'));
  if (!r.dry) ok(`full report saved to ${path.join(r.out, 'RESCUE-REPORT.md')}`);
}
