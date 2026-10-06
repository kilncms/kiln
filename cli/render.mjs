/**
 * kiln rescue --render: freeze a site that is drawn by JavaScript.
 *
 * A site made with Lovable, v0 or Bolt is usually a React app: the server
 * sends an empty shell and the words arrive when the script runs. This module
 * opens each page in a real browser, waits until it has finished, and hands
 * back the finished document so rescue.mjs can clean, localise and tag it like
 * any other page.
 *
 * The browser is one that is already on the machine (Chrome, Edge, Brave,
 * Chromium, or a Playwright Chromium). It is driven through `playwright-core`,
 * an optional peer that is looked up only when --render is passed. Nothing is
 * downloaded.
 *
 * browserCandidates, findBrowser, firstDifference and applyMenu are pure and
 * exported for tests.
 */
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parse, parseFragment, serialize } from 'parse5';

export const NO_BROWSER = 'No Chrome, Edge, Brave or Chromium was found on this machine. Install Google Chrome, or pass --browser with the path to a Chromium-based browser.';
export const NO_PLAYWRIGHT = 'Rendering needs the playwright-core package, which Kiln does not install for you. Run `npm install playwright-core` in this folder (it is small and downloads no browser), then run the same command again.';

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 800 };

// ─── finding a browser ───────────────────────────────────────────────────────

/** Fixed places a Chromium-based browser is installed, most common first. */
export function browserCandidates(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') {
    const apps = [
      ['Google Chrome', 'Google Chrome'], ['Microsoft Edge', 'Microsoft Edge'],
      ['Chromium', 'Chromium'], ['Brave Browser', 'Brave Browser'],
    ];
    return ['/Applications', path.join(home, 'Applications')]
      .flatMap(root => apps.map(([app, bin]) => `${root}/${app}.app/Contents/MacOS/${bin}`));
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    const rel = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe',
      'Chromium\\Application\\chrome.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'];
    return roots.flatMap(r => rel.map(x => `${r}\\${x}`));
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
  const dirs = [...String(env.PATH || '').split(':').filter(Boolean), '/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/google/chrome'];
  return [...new Set(dirs.flatMap(d => names.map(n => `${d}/${n}`)))];
}

/** Where Playwright keeps the browsers it downloaded, newest revision first. */
function playwrightBrowsers(platform, env, home, fs) {
  const root = env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0'
    ? env.PLAYWRIGHT_BROWSERS_PATH
    : platform === 'darwin' ? path.join(home, 'Library', 'Caches', 'ms-playwright')
      : platform === 'win32' ? path.join(env.LOCALAPPDATA || home, 'ms-playwright')
        : path.join(home, '.cache', 'ms-playwright');
  let dirs = [];
  try { dirs = fs.readdir(root); } catch { return []; }
  const rev = (d) => Number(d.split('-').pop()) || 0;
  const out = [];
  for (const d of dirs.filter(x => /^chromium-\d+$/.test(x)).sort((a, b) => rev(b) - rev(a))) {
    let subs = [];
    try { subs = fs.readdir(path.join(root, d)); } catch { continue; }
    for (const s of subs.filter(x => x.startsWith('chrome-'))) {
      const base = path.join(root, d, s);
      out.push(
        path.join(base, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(base, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        path.join(base, 'chrome'), path.join(base, 'chrome.exe'),
      );
    }
  }
  return out;
}

/**
 * The browser to drive: --browser when given (an error if it is not there),
 * else the first installed one. Returns { path } or { error }.
 */
export function findBrowser(explicit, deps = {}) {
  const fs = { exists: deps.exists || existsSync, readdir: deps.readdir || readdirSync };
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const home = deps.home || os.homedir();
  if (explicit && explicit !== true) {
    return fs.exists(explicit) ? { path: explicit } : { error: `There is no browser at ${explicit}. Check the path given to --browser.` };
  }
  if (env.KILN_BROWSER && fs.exists(env.KILN_BROWSER)) return { path: env.KILN_BROWSER };
  // Brave last: its ad blocking can leave things out of the saved page
  const fixed = browserCandidates(platform, env, home);
  const brave = (p) => /brave/i.test(p);
  for (const p of [...fixed.filter(p => !brave(p)), ...playwrightBrowsers(platform, env, home, fs), ...fixed.filter(brave)]) {
    if (fs.exists(p)) return { path: p };
  }
  return { error: NO_BROWSER };
}

/** playwright-core, from KILN_PLAYWRIGHT, the folder the command runs in, or
 *  next to Kiln itself. null when it is not installed anywhere. */
export function loadPlaywright(env = process.env, cwd = process.cwd()) {
  const tries = [];
  const here = createRequire(import.meta.url);
  if (env.KILN_PLAYWRIGHT) tries.push(() => here(path.resolve(env.KILN_PLAYWRIGHT)));
  const local = createRequire(path.join(cwd, 'package.json'));
  for (const name of ['playwright-core', 'playwright']) {
    tries.push(() => local(name), () => here(name));
  }
  for (const t of tries) {
    try { const m = t(); if (m?.chromium) return m; } catch { /* next */ }
  }
  return null;
}

// ─── in the page ─────────────────────────────────────────────────────────────

/** Runs before any of the page's own scripts: notes which elements were given
 *  an event handler and which addresses the app moved to without a page load. */
function initScript() {
  const EV = /^(click|mousedown|mouseup|pointerdown|pointerup|touchstart|touchend|keydown|keyup|change|input|submit)$/;
  const handlers = new Map();
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    try {
      if (this instanceof Element && EV.test(type)) {
        if (!handlers.has(this)) handlers.set(this, new Set());
        handlers.get(this).add(type);
      }
    } catch { /* never get in the page's way */ }
    return add.call(this, type, fn, opts);
  };
  const routes = new Set();
  for (const k of ['pushState', 'replaceState']) {
    const orig = history[k];
    history[k] = function (state, title, url) {
      try { if (url != null) routes.add(new URL(url, location.href).href); } catch { /* ignore */ }
      return orig.apply(this, arguments);
    };
  }
  window.__kilnRender = { handlers, routes };
}

/** Walk down the page so lazy pictures and scroll-triggered sections load. */
async function scrollThrough() {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const el = document.scrollingElement || document.documentElement;
  const step = Math.max(200, Math.floor(innerHeight * 0.8));
  for (let y = 0, n = 0; y < el.scrollHeight && n < 80; y += step, n++) {
    el.scrollTo({ top: y, behavior: 'instant' });
    await sleep(120);
  }
  el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
  await sleep(200);
  el.scrollTo({ top: 0, behavior: 'instant' });
  await sleep(100);
  await Promise.race([
    Promise.all([...document.images].filter(i => !i.complete && (i.currentSrc || i.src)).map(i => new Promise(r => {
      i.addEventListener('load', r, { once: true });
      i.addEventListener('error', r, { once: true });
    }))),
    sleep(5000),
  ]);
}

function pageText() {
  return (document.body?.innerText || '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

/** Buttons in the header or navigation that cannot be seen at this width. */
function noteHiddenButtons() {
  const seen = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const all = [...document.querySelectorAll('header button, nav button, header [role=button], nav [role=button], button[aria-label*="menu" i], button[aria-controls], button[class*="menu" i], button[class*="burger" i], button[class*="nav" i]')];
  window.__kilnRender.hiddenWide = new Set(all.filter(b => !seen(b)));
  return document.body.querySelectorAll('*').length;
}

/** At phone width: the button that appeared is the menu button. Marks it. */
function markMenuToggle() {
  const R = window.__kilnRender;
  const seen = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const score = (b) => (/menu|nav|toggle/i.test(label(b) + ' ' + (b.getAttribute('class') || '') + ' ' + (b.getAttribute('aria-controls') || '')) ? 2 : 0)
    + (b.hasAttribute('aria-expanded') ? 2 : 0) + (!b.innerText.trim() && b.querySelector('svg, span, i') ? 1 : 0);
  const cands = [...(R.hiddenWide || [])].filter(b => b.isConnected && seen(b)).sort((a, b) => score(b) - score(a));
  const elements = document.body.querySelectorAll('*').length;
  if (!cands.length) return { found: false, elements };
  cands[0].setAttribute('data-kiln-menu-toggle', '');
  return { found: true, label: label(cands[0]) || 'menu', elements };
}

/** Number every element, so a piece captured later can be put back in place. */
function stampElements() {
  let n = 0;
  for (const el of document.body.querySelectorAll('*')) el.setAttribute('data-kf', String(n++));
  document.body.setAttribute('data-kf', 'body');
}

/** Start watching what the menu button adds, removes or changes when it is pressed. */
function watchMenu() {
  const M = window.__kilnRender.menu = { added: [], removed: [], classes: new Map() };
  new MutationObserver(list => {
    for (const m of list) {
      if (m.type === 'childList') {
        m.addedNodes.forEach(n => { if (n.nodeType === 1) M.added.push(n); });
        m.removedNodes.forEach(n => { if (n.nodeType === 1) M.removed.push({ node: n, parent: m.target }); });
      } else if (!M.classes.has(m.target)) M.classes.set(m.target, m.oldValue || '');
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
}

/** After the press: the pieces that appeared, and the classes that changed. */
function collectMenu() {
  const M = window.__kilnRender.menu;
  const toggle = document.querySelector('[data-kiln-menu-toggle]');
  const kf = (el) => (el && el.getAttribute ? el.getAttribute('data-kf') : null);
  const sig = (el) => el.tagName + '.' + (el.getAttribute('class') || '');
  const fresh = [];   // { parent, after, node }: an element that was not there before the press
  // An app that redraws a whole part hands back a copy of what was there plus
  // the menu. Walk old and new side by side and keep only what has no partner.
  const compare = (was, now) => {
    const olds = [...was.children];
    let i = 0, last = null;
    for (const c of now.children) {
      let j = i;
      while (j < olds.length && sig(olds[j]) !== sig(c)) j++;
      if (j < olds.length) { compare(olds[j], c); last = olds[j]; i = j + 1; }
      else fresh.push({ parent: kf(was), after: kf(last), node: c });
    }
  };
  const paired = new Set();
  const tops = [...new Set(M.added)].filter(n => n.isConnected && kf(n) === null && !(toggle && toggle.contains(n))
    && kf(n.parentElement) !== null && !/^(SCRIPT|STYLE|LINK)$/.test(n.tagName));
  for (const n of tops) {
    const old = M.removed.find(r => !paired.has(r.node) && r.parent === n.parentElement && kf(r.node) !== null && sig(r.node) === sig(n));
    if (old) { paired.add(old.node); compare(old.node, n); continue; }
    let prev = n.previousElementSibling;
    while (prev && kf(prev) === null) prev = prev.previousElementSibling;
    fresh.push({ parent: kf(n.parentElement), after: kf(prev), node: n });
  }
  const linked = (n) => n.matches('a[href]') || !!n.querySelector('a[href]');
  const panels = [];
  if (fresh.some(f => linked(f.node))) {
    for (const f of fresh) {
      if (f.parent === null) continue;
      const clone = f.node.cloneNode(true);
      clone.setAttribute('data-kiln-menu-panel', linked(f.node) ? '' : 'backdrop');
      panels.push({ parent: f.parent, after: f.after, html: clone.outerHTML });
    }
  }
  const swaps = [];
  for (const [el, was] of M.classes) {
    if (!el.isConnected || kf(el) === null || (toggle && toggle.contains(el))) continue;
    const now = el.getAttribute('class') || '';
    if (now !== was) swaps.push({ kf: kf(el), open: now });
  }
  return { panels, swaps };
}

/**
 * Freeze the page as it stands: write styles that exist only in memory into
 * their <style>, list what will stop working without script, return the HTML.
 */
function freeze() {
  const R = window.__kilnRender || { handlers: new Map(), routes: new Set() };
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const label = (el) => clean(el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('alt'));

  // styles a script inserted rule by rule: the element is empty, the sheet is not
  let styles = 0;
  for (const s of document.querySelectorAll('style')) {
    let rules; try { rules = s.sheet && s.sheet.cssRules; } catch { continue; }
    if (!rules || !rules.length) continue;
    const text = s.textContent || '';
    let same = false;
    if (text.trim()) {
      try { const probe = new CSSStyleSheet(); probe.replaceSync(text); same = probe.cssRules.length >= rules.length; } catch { same = true; }
    }
    if (!same) { s.textContent = [...rules].map(r => r.cssText).join('\n'); styles++; }
  }
  for (const sheet of document.adoptedStyleSheets || []) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    if (!rules.length) continue;
    const s = document.createElement('style');
    s.textContent = [...rules].map(r => r.cssText).join('\n');
    document.head.appendChild(s);
    styles++;
  }

  // "You need to enable JavaScript": no longer true of this page
  for (const n of document.querySelectorAll('noscript')) if (/javascript/i.test(n.textContent || '')) n.remove();

  const frameworkHandler = (el) => {
    for (const k of Object.keys(el)) {
      if (k.startsWith('__reactProps$')) {
        const p = el[k] || {};
        return Object.keys(p).some(n => /^on(Click|Change|Submit|MouseDown|PointerDown|KeyDown|Input|Toggle|Select)/.test(n) && typeof p[n] === 'function');
      }
      if (k === '_vei') return Object.keys(el[k] || {}).length > 0;
    }
    return false;
  };
  const hasHandler = (el) => {
    if (el.hasAttribute('onclick') || el.hasAttribute('onchange') || el.hasAttribute('onsubmit')) return true;
    const own = R.handlers.get(el);
    if (own && own.size && own.size < 8) return true;   // 8 or more kinds: a framework's root, not a control
    return frameworkHandler(el);
  };

  const forms = [...document.querySelectorAll('form')].map(f => {
    const head = f.querySelector('legend, h1, h2, h3, h4') || f.closest('section, article, div')?.querySelector('h1, h2, h3, h4');
    const submit = f.querySelector('[type=submit], button:not([type=button])');
    const action = f.getAttribute('action') || '';
    return { label: clean(head?.innerText) || clean(submit?.innerText) || 'form', fields: f.querySelectorAll('input:not([type=hidden]), select, textarea').length,
      action: /^https?:|^\//.test(action) ? action : '' };
  });

  const controls = [], reported = [];
  const ARIA = '[aria-expanded], [aria-haspopup], [role=tab], [aria-roledescription=carousel]';
  for (const el of document.body.querySelectorAll('*')) {
    if (reported.some(r => r.contains(el))) continue;
    const tag = el.tagName.toLowerCase();
    if (/^(script|style|svg|path|html|body|form|option|label)$/.test(tag) || el.closest('svg')) continue;
    const aria = el.matches(ARIA);
    if (!aria && !hasHandler(el)) continue;
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      if (href && href !== '#' && !/^javascript:/i.test(href)) continue;   // a real link works without script
    }
    if (/^(input|select|textarea|button)$/.test(tag) && el.closest('form')) continue;   // counted with its form
    if (tag === 'summary' || tag === 'details') continue;
    if (el.id === 'root' || el.id === '__next' || el.id === 'app') continue;
    const kind = el.hasAttribute('data-kiln-menu-toggle') ? 'the phone menu button'
      : el.matches('[role=tab]') ? 'tab'
        : el.matches('[aria-roledescription=carousel]') ? 'carousel'
          : el.matches('[aria-expanded], [aria-haspopup]') ? 'opens something'
            : /^(input|select|textarea)$/.test(tag) ? 'input'
              : /^(button|a)$/.test(tag) || el.getAttribute('role') === 'button' ? 'button' : 'clickable area';
    reported.push(el);
    if (kind === 'clickable area' && !label(el)) continue;   // a wrapper with nothing to name it by
    controls.push({ kind, label: label(el) || tag });
  }

  const invisible = [];
  for (const el of document.querySelectorAll('[style*="opacity"]')) {
    if (invisible.length >= 5) break;
    if (Number(getComputedStyle(el).opacity) < 0.05 && clean(el.innerText) && el.getBoundingClientRect().height > 0
      && !invisible.some(t => t === clean(el.innerText))) invisible.push(clean(el.innerText));
  }
  let shadow = 0;
  for (const el of document.body.querySelectorAll('*')) if (el.shadowRoot) shadow++;

  const dt = document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : '<!DOCTYPE html>';
  return {
    html: dt + '\n' + document.documentElement.outerHTML,
    lost: {
      forms, controls, styles, invisible, shadow,
      canvases: document.querySelectorAll('canvas').length,
      blobs: document.querySelectorAll('img[src^="blob:"], video[src^="blob:"], source[src^="blob:"]').length,
    },
    routes: [...R.routes],
  };
}

/** Press each button in the navigation and note where the app goes. */
async function clickNavButtons() {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const found = [];
  const start = location.href;
  const cands = [...document.querySelectorAll('nav button, header button, [role=navigation] button, nav [role=link], header [role=link], nav [role=button], nav li')]
    .filter(b => !b.hasAttribute('data-kiln-menu-toggle') && !b.hasAttribute('aria-expanded') && !b.hasAttribute('aria-haspopup')
      && !b.closest('form') && !b.querySelector('a[href], button') && (b.innerText || '').trim()).slice(0, 12);
  for (const b of cands) {
    const text = b.innerText.replace(/\s+/g, ' ').trim().slice(0, 60);
    try { b.click(); } catch { continue; }
    await sleep(150);
    if (location.origin + location.pathname !== new URL(start).origin + new URL(start).pathname) {
      found.push({ label: text, url: location.href });
      history.back();
      await sleep(200);
    }
  }
  return found;
}

// ─── pure helpers ────────────────────────────────────────────────────────────

/** The first line two renderings of a page disagree on, or null. */
export function firstDifference(a, b) {
  if (a === b) return null;
  const A = String(a).split('\n'), B = String(b).split('\n');
  const setB = new Set(B), setA = new Set(A);
  const was = A.find(l => !setB.has(l)), now = B.find(l => !setA.has(l));
  const cut = (s) => (s === undefined ? '(nothing)' : s.length > 70 ? s.slice(0, 67) + '...' : s);
  if (was === undefined && now === undefined) return { was: '(same lines, different order)', now: '' };
  return { was: cut(was), now: cut(now) };
}

const getAttr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
function walk(node, fn) {
  fn(node);
  for (const c of [...(node.childNodes || [])]) walk(c, fn);
  if (node.content) walk(node.content, fn);
}

/** The script a frozen page loads to make its phone menu open and close. */
export const MENU_SHIM = `/* Kiln menu: opens and closes the phone menu on a page frozen by "kiln rescue --render". */
(function () {
  var toggles = document.querySelectorAll('[data-kiln-menu-toggle]');
  if (!toggles.length) return;
  var open = false;
  function each(sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); }
  function set(next) {
    if (next === open) return;
    open = next;
    each('[data-kiln-menu-toggle]', function (b) { b.setAttribute('aria-expanded', String(open)); });
    each('[data-kiln-menu-panel]', function (p) { if (open) p.setAttribute('data-kiln-open', ''); else p.removeAttribute('data-kiln-open'); });
    each('[data-kiln-menu-swap]', function (e) {
      var now = e.getAttribute('class') || '';
      e.setAttribute('class', e.getAttribute('data-kiln-menu-swap'));
      e.setAttribute('data-kiln-menu-swap', now);
    });
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-kiln-menu-toggle]')) { ev.preventDefault(); set(!open); return; }
    if (!open) return;
    var panel = t.closest('[data-kiln-menu-panel]');
    if (!panel) return;
    var btn = t.closest('button');
    if (panel.getAttribute('data-kiln-menu-panel') === 'backdrop' || t.closest('a[href]') ||
        (btn && (/close|dismiss/i.test((btn.getAttribute('aria-label') || '') + ' ' + btn.textContent) || !btn.textContent.trim()))) set(false);
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') set(false); });
})();
`;
export const MENU_STYLE = '<style data-kiln-menu>[data-kiln-menu-panel]:not([data-kiln-open]){display:none!important}</style>';

/**
 * Put what the menu button revealed back into the frozen page, closed, and
 * remove the numbering. `menu` is { panels, swaps } from collectMenu, or null
 * to only remove the numbering. Returns { html, panels, swaps }.
 */
export function applyMenu(html, menu) {
  if (!/\sdata-kf="/.test(html)) return { html, panels: 0, swaps: 0 };
  const doc = parse(html);
  const byKf = new Map();
  walk(doc, n => { const k = n.attrs && getAttr(n, 'data-kf'); if (k !== undefined) byKf.set(k, n); });
  let panels = 0, swaps = 0;
  for (const p of menu?.panels || []) {
    const parent = byKf.get(p.parent);
    if (!parent) continue;
    const nodes = parseFragment(p.html).childNodes.filter(n => n.tagName);
    const after = p.after !== null ? byKf.get(p.after) : null;
    let at = after ? parent.childNodes.indexOf(after) + 1 : 0;
    for (const n of nodes) { n.parentNode = parent; parent.childNodes.splice(at++, 0, n); panels++; }
  }
  for (const s of menu?.swaps || []) {
    const el = byKf.get(s.kf);
    if (!el) continue;
    el.attrs.push({ name: 'data-kiln-menu-swap', value: s.open });
    swaps++;
  }
  walk(doc, n => { if (n.attrs) n.attrs = n.attrs.filter(a => a.name !== 'data-kf'); });
  return { html: serialize(doc), panels, swaps };
}

// ─── the renderer ────────────────────────────────────────────────────────────

/**
 * Start a browser. Returns { render(url, { first }), close(), cache, requests }
 * or { error } with a sentence for the person at the keyboard.
 *
 * cache: every response body the browser fetched (assetKey → { buf, ct }), so
 * rescue does not ask the site for the same file twice.
 */
export async function openRenderer(opts = {}) {
  const pw = loadPlaywright();
  if (!pw) return { error: NO_PLAYWRIGHT };
  const found = findBrowser(opts.browser);
  if (found.error) return { error: found.error };
  let browser;
  try { browser = await pw.chromium.launch({ executablePath: found.path, headless: true }); }
  catch (e) { return { error: `The browser at ${found.path} did not start (${String(e.message).split('\n')[0]}). Pass --browser with the path to another one.` }; }
  const context = await browser.newContext({ viewport: DESKTOP, reducedMotion: 'reduce', userAgent: opts.userAgent });
  await context.addInitScript(initScript);

  const cache = new Map(), pending = new Set();
  const maxOne = opts.maxAssetBytes || 5 * 1024 * 1024, maxAll = opts.maxTotalBytes || 25 * 1024 * 1024;
  let held = 0, requests = 0;
  context.on('request', () => { requests++; });
  context.on('response', (res) => {
    if (res.request().method() !== 'GET' || res.status() !== 200) return;
    const type = res.request().resourceType();
    if (!['stylesheet', 'image', 'font', 'media'].includes(type)) return;
    let key; try { const u = new URL(res.url()); if (!/^https?:$/.test(u.protocol)) return; key = u.origin + u.pathname + u.search; } catch { return; }
    if (cache.has(key)) return;
    const p = res.body().then(buf => {
      if (buf.length > maxOne || held + buf.length > maxAll || cache.has(key)) return;
      held += buf.length;
      cache.set(key, { buf, ct: (res.headers()['content-type'] || '').toLowerCase() });
    }).catch(() => { /* gone before it could be read */ }).finally(() => pending.delete(p));
    pending.add(p);
  });

  const timeout = opts.timeout || 30000;
  const settle = async (page) => {
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true)).catch(() => {});
    await page.evaluate(scrollThrough).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(opts.settle ?? 600);
  };
  const open = async (url) => {
    const page = await context.newPage();
    let res;
    try { res = await page.goto(url, { waitUntil: 'load', timeout }); }
    catch (e) { await page.close().catch(() => {}); return { reason: /Timeout/i.test(e.message) ? 'timeout' : String(e.message).split('\n')[0] }; }
    return { page, res };
  };

  /**
   * Render one page. Returns { reason } when it could not be loaded, else
   * { html, url, status, contentType, lost, routes, menu, changed, scripted }.
   */
  async function render(url, { first = false } = {}) {
    const o = await open(url);
    if (o.reason) return o;
    const { page, res } = o;
    try {
      const status = res ? res.status() : 200;
      const contentType = res ? (res.headers()['content-type'] || '').toLowerCase() : '';
      if (status >= 400 || (contentType && !contentType.includes('html'))) return { url: page.url(), status, contentType };
      // The phone menu button is the one that is only there on a narrow screen.
      // Looked for before the page is scrolled: an app that redraws when the
      // width changes starts its scroll-triggered animations over, and they
      // must have run by the time the page is saved.
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      const wide = await page.evaluate(noteHiddenButtons);
      await page.setViewportSize(PHONE);
      await page.waitForTimeout(250);
      const toggle = await page.evaluate(markMenuToggle);
      await page.setViewportSize(DESKTOP);
      await page.waitForTimeout(250);
      const scripted = Math.abs(toggle.elements - wide) > 2;
      await settle(page);
      const text = await page.evaluate(pageText);
      if (toggle.found && !(await page.locator('[data-kiln-menu-toggle]').count())) toggle.found = false;   // redrawn since

      if (opts.menuShim && toggle.found) await page.evaluate(stampElements);
      const frozen = await page.evaluate(freeze);
      let html = frozen.html;
      const menu = { found: toggle.found, label: toggle.label, shimmed: false, tried: !!opts.menuShim };
      if (opts.menuShim && toggle.found) {
        let got = null;
        try {
          await page.setViewportSize(PHONE);
          await page.waitForTimeout(250);
          await page.evaluate(watchMenu);
          await page.locator('[data-kiln-menu-toggle]').first().click({ timeout: 3000 });
          await page.waitForTimeout(700);
          got = await page.evaluate(collectMenu);
        } catch { /* the button could not be pressed: reported as not shimmed */ }
        const applied = applyMenu(html, got);
        html = applied.html;
        menu.shimmed = applied.panels + applied.swaps > 0;
        await page.keyboard.press('Escape').catch(() => {});
        await page.setViewportSize(DESKTOP).catch(() => {});
      }

      // routes the app reaches from buttons, not links (first page only)
      const routes = [...frozen.routes];
      const navButtons = first ? await page.evaluate(clickNavButtons).catch(() => []) : [];
      for (const b of navButtons) routes.push(b.url);

      // a second visit: a page that comes out differently cannot be frozen faithfully
      let changed = null;
      if (opts.secondVisit !== false) {
        const again = await open(url);
        if (again.page) {
          try { await settle(again.page); changed = firstDifference(text, await again.page.evaluate(pageText)); }
          catch { /* could not compare */ }
          await again.page.close().catch(() => {});
        }
      }
      return { html, url: page.url(), status, contentType, lost: frozen.lost, routes, navButtons, menu, changed, scripted };
    } finally {
      await page.close().catch(() => {});
    }
  }

  return {
    browserPath: found.path,
    cache,
    get requests() { return requests; },
    render,
    async close() {
      await Promise.allSettled([...pending]);
      await browser.close().catch(() => {});
    },
  };
}
