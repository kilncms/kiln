import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sitemapPages, wireKiln, appScripts, lostLines, looksLikeErrorPage } from '../cli/rescue.mjs';
import { browserCandidates, findBrowser, firstDifference, applyMenu, loadPlaywright, MENU_STYLE, NO_BROWSER, NO_PLAYWRIGHT } from '../cli/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli', 'index.mjs');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'kiln-render-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const run = (args, opts = {}) => new Promise(resolve => {
  execFile(process.execPath, [CLI, ...args], { cwd: opts.cwd || TMP, env: opts.env || process.env, timeout: 120000 },
    (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout) + String(stderr) }));
});

// ─── no browser needed ───────────────────────────────────────────────────────

test('render: browsers are looked for in the usual places on each system', () => {
  assert.ok(browserCandidates('darwin', {}, '/Users/x').includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.ok(browserCandidates('linux', { PATH: '/usr/bin' }, '/home/x').includes('/usr/bin/chromium'));
  assert.ok(browserCandidates('win32', { PROGRAMFILES: 'C:\\Program Files' }, 'C:\\Users\\x')
    .includes('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'));
});

test('render: findBrowser takes --browser, then an installed browser, then a Playwright Chromium, newest first', () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const brave = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
  const pw = (rev) => `/Users/x/Library/Caches/ms-playwright/chromium-${rev}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
  const deps = (files) => ({
    platform: 'darwin', env: {}, home: '/Users/x', exists: (p) => files.includes(p),
    readdir: (d) => d.endsWith('ms-playwright') ? ['chromium-1208', 'chromium-1223', 'ffmpeg-1011'] : ['chrome-mac-arm64'],
  });
  assert.deepEqual(findBrowser('/opt/my-browser', deps(['/opt/my-browser', chrome])), { path: '/opt/my-browser' });
  assert.match(findBrowser('/opt/nothing', deps([chrome])).error, /no browser at \/opt\/nothing/i);
  assert.deepEqual(findBrowser(undefined, deps([chrome, pw(1223)])), { path: chrome });
  assert.deepEqual(findBrowser(undefined, deps([pw(1208), pw(1223)])), { path: pw(1223) });
  assert.deepEqual(findBrowser(undefined, deps([brave, pw(1208)])), { path: pw(1208) }, 'Brave is the last resort');
  assert.deepEqual(findBrowser(undefined, deps([brave])), { path: brave });
  assert.deepEqual(findBrowser(undefined, { ...deps([chrome]), env: { KILN_BROWSER: chrome } }), { path: chrome });
  assert.equal(findBrowser(undefined, deps([])).error, NO_BROWSER);
});

test('render: with no browser the command stops and says how to get one, in two sentences', async () => {
  const r = await run(['rescue', 'http://127.0.0.1:9/', '--render', '--browser', path.join(TMP, 'no-such-browser')],
    { env: { ...process.env, KILN_PLAYWRIGHT: path.join(ROOT, 'test', 'fake-playwright') } });
  assert.equal(r.code, 1);
  assert.match(r.out, /There is no browser at .*no-such-browser\. Check the path given to --browser\./);
  assert.equal(NO_BROWSER.split('. ').length, 2);
  assert.equal(NO_PLAYWRIGHT.split('. ').length, 2);
  assert.ok(!/[\u2014\u2013]/.test(NO_BROWSER + NO_PLAYWRIGHT));
});

test('render: without playwright-core the command stops and names the one thing to install', async (t) => {
  if (loadPlaywright({}, TMP)) return t.skip('playwright-core is installed beside Kiln on this machine');
  const env = { ...process.env }; delete env.KILN_PLAYWRIGHT;
  const r = await run(['rescue', 'http://127.0.0.1:9/', '--render'], { env });
  assert.equal(r.code, 1);
  assert.ok(r.out.includes('npm install playwright-core'), r.out);
});

test('render: --keep-scripts is refused together with --render', async () => {
  const r = await run(['rescue', 'http://127.0.0.1:9/', '--render', '--keep-scripts']);
  assert.equal(r.code, 1);
  assert.match(r.out, /--keep-scripts cannot be used with --render/);
});

test('render: playwright-core is not a dependency and is an optional peer', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['playwright-core'], undefined);
  assert.equal(pkg.devDependencies['playwright-core'], undefined);
  assert.ok(pkg.peerDependencies['playwright-core']);
  assert.equal(pkg.peerDependenciesMeta['playwright-core'].optional, true);
  // and nothing on the ordinary path imports the renderer up front
  for (const f of ['cli/index.mjs', 'cli/rescue.mjs']) {
    assert.ok(!/^import .*render\.mjs/m.test(readFileSync(path.join(ROOT, f), 'utf8')), `${f} loads render.mjs only on demand`);
  }
});

test('render: sitemapPages keeps same-origin pages and drops files', () => {
  const xml = `<urlset><url><loc>https://s.com/</loc></url><url><loc> https://s.com/about/ </loc></url>
    <url><loc>https://s.com/a?x=1&amp;y=2</loc></url><url><loc>https://other.com/x</loc></url>
    <url><loc>https://s.com/file.pdf</loc></url><url><loc>https://s.com/about</loc></url></urlset>`;
  assert.deepEqual(sitemapPages(xml, 'https://s.com'), ['/', '/about', '/a']);
  assert.deepEqual(sitemapPages('<!doctype html><div id="root"></div>', 'https://s.com'), []);
});

test('render: wireKiln adds the two Kiln tags once, before </body>', () => {
  const html = '<html><head><title>x</title></head><body><h1>Hi</h1></body></html>';
  const once = wireKiln(html);
  assert.ok(once.includes('<script src="/assets/kiln-config.js"></script>\n<script src="/assets/kiln.js" defer></script>\n</body>'));
  assert.equal(wireKiln(once), once);
  assert.equal(wireKiln(html, { kiln: false }), html);
  const menu = wireKiln(html, { menuStyle: MENU_STYLE });
  assert.ok(menu.includes(MENU_STYLE + '</head>'));
  assert.ok(menu.indexOf('kiln-menu.js') < menu.indexOf('kiln-config.js'));
  assert.equal(wireKiln(menu, { menuStyle: MENU_STYLE }), menu);
  assert.equal(appScripts(menu), 0, 'Kiln\'s own tags are not app scripts');
  assert.equal(appScripts('<script src="/assets/index-abc.js"></script><script type="application/ld+json">{}</script><script>x()</script>'), 2);
});

test('rescue: a first page titled like an error page is called out', () => {
  assert.equal(looksLikeErrorPage('<html><head><title>Website Not Found - Bolt</title></head></html>'), 'Website Not Found - Bolt');
  assert.equal(looksLikeErrorPage('<title>404</title>'), '404');
  assert.equal(looksLikeErrorPage('<title>Crumb Bakery</title>'), '');
  assert.equal(looksLikeErrorPage('<title>Lost and found office</title>'), '');
  assert.equal(looksLikeErrorPage('<p>no title</p>'), '');
});

test('render: firstDifference names the line that changed', () => {
  assert.equal(firstDifference('a\nb', 'a\nb'), null);
  assert.deepEqual(firstDifference('Title\n12 visitors\nEnd', 'Title\n15 visitors\nEnd'), { was: '12 visitors', now: '15 visitors' });
  assert.deepEqual(firstDifference('a', 'a\nb'), { was: '(nothing)', now: 'b' });
});

test('render: applyMenu puts the captured menu back, closed, and removes the numbering', () => {
  const html = '<html><head></head><body data-kf="body"><header data-kf="0"><button data-kf="1" data-kiln-menu-toggle="">Menu</button></header><main data-kf="2" class="shut">x</main></body></html>';
  const r = applyMenu(html, {
    panels: [{ parent: '0', after: '1', html: '<div data-kiln-menu-panel=""><a href="/about">About</a></div>' },
      { parent: 'body', after: null, html: '<div data-kiln-menu-panel="backdrop"></div>' }],
    swaps: [{ kf: '2', open: 'open' }],
  });
  assert.equal(r.panels, 2); assert.equal(r.swaps, 1);
  assert.ok(!r.html.includes('data-kf'));
  assert.ok(r.html.includes('<button data-kiln-menu-toggle="">Menu</button><div data-kiln-menu-panel=""><a href="/about">About</a></div></header>'));
  assert.ok(r.html.includes('<body><div data-kiln-menu-panel="backdrop"></div><header>'));
  assert.ok(r.html.includes('<main class="shut" data-kiln-menu-swap="open">'));
  assert.ok(!applyMenu(html, null).html.includes('data-kf'));
});

test('render: the report says what stopped working, page by page', () => {
  const lost = (o = {}) => ({ forms: [], controls: [], styles: 0, invisible: [], shadow: 0, canvases: 0, blobs: 0, ...o });
  const lines = lostLines([
    { href: '/', rendered: { lost: lost({ forms: [{ label: 'Contact us', fields: 3, action: '' }], controls: [{ kind: 'button', label: 'Order now' }, { kind: 'the phone menu button', label: 'Menu' }], styles: 2, canvases: 1 }),
      menu: { found: true, label: 'Menu', shimmed: false }, changed: { was: '12 visitors', now: '15 visitors' }, navButtons: [{ label: 'Prices', url: 'http://x/prices' }], scripted: true } },
    { href: '/about/', rendered: { lost: lost({ controls: [{ kind: 'button', label: 'Order now' }] }), menu: { found: true, label: 'Menu', shimmed: false }, changed: null } },
    { href: '/plain/', rendered: null },
  ]).join('\n');
  assert.match(lines, /## What freezing cost/);
  assert.match(lines, /Forms: 1\./);
  assert.match(lines, /"Contact us" \(3 fields\) on \//);
  assert.match(lines, /Controls that needed script: 1\./);
  assert.match(lines, /button "Order now" on \/, \/about\//);
  assert.match(lines, /Phone menu: the button "Menu" does not open\. Run again with --menu-shim/);
  assert.match(lines, /The button "Prices" changed page by script \(it went to \/prices\)/);
  assert.match(lines, /differently on a second visit: 1\./);
  assert.match(lines, /\/: "12 visitors" then "15 visitors"/);
  assert.match(lines, /canvas by script, so not copied: \//);
  assert.match(lines, /Phone layout chosen by script on \//);
  assert.match(lines, /now written into the pages: 2\./);
  assert.ok(!/[\u2014\u2013]/.test(lines), 'no dashes used as punctuation');
  assert.deepEqual(lostLines([{ href: '/', rendered: null }]), []);
  const fine = lostLines([{ href: '/', rendered: { lost: lost(), menu: { found: true, label: 'Menu', shimmed: true, tried: true }, changed: null } }]).join('\n');
  assert.match(fine, /Phone menu: works\. The button "Menu" opens it through assets\/kiln-menu\.js/);
});

// ─── with a browser ──────────────────────────────────────────────────────────
// These open real pages. They need playwright-core (set KILN_PLAYWRIGHT to its
// folder when it is not installed here) and a Chromium-based browser.

const pw = loadPlaywright();
const browser = pw ? findBrowser() : { error: 'no playwright-core' };
const SKIP = !pw ? 'needs playwright-core: set KILN_PLAYWRIGHT=/path/to/node_modules/playwright-core to run the --render tests'
  : browser.error ? 'needs a browser: install Chrome, or set KILN_BROWSER=/path/to/browser to run the --render tests' : false;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.xml': 'application/xml' };

/** Serve a folder; unknown paths answer with index.html when spa is set. */
function serve(dir, { spa = false } = {}) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = path.join(dir, p.endsWith('/') ? p + 'index.html' : p);
      if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
      if (!existsSync(file) && existsSync(file + '/index.html')) file += '/index.html';
      if (!existsSync(file) || !path.extname(file)) {
        if (!spa || path.extname(p)) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
        file = path.join(dir, 'index.html');
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(readFileSync(file));
    }).listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) }));
  });
}

const shell = (body, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Loading</title>
<meta name="viewport" content="width=device-width, initial-scale=1">${head}</head><body>${body}</body></html>`;

const FIXTURES = {
  // 1. the whole page is drawn by script into #root
  root: {
    'index.html': shell(`<div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript>
<script type="application/ld+json">{"@type":"Bakery","name":"Crumb"}</script>
<script type="module" src="/app.js"></script>`, '<link rel="modulepreload" href="/app.js">'),
    'app.js': `document.title = 'Crumb Bakery';
const root = document.getElementById('root');
root.innerHTML = '<main><h1>Fresh bread every morning</h1><p>Baked on Mill Lane since 1998, from flour milled nine miles away.</p>'
  + '<p id="n">Loaves sold today: ' + Math.floor(Math.random() * 1e9) + '</p>'
  + '<button id="order">Order now</button>'
  + '<section><h2>Write to us</h2><form id="f"><input name="email"><textarea name="msg"></textarea><button>Send</button></form></section></main>';
document.getElementById('order').addEventListener('click', () => alert('ordered'));
document.getElementById('f').addEventListener('submit', (e) => e.preventDefault());`,
  },
  // 2. one HTML file, addresses changed by script
  routes: {
    'index.html': shell('<div id="root"></div><script src="/router.js"></script>'),
    'sitemap.xml': '<?xml version="1.0"?><urlset><url><loc>ORIGIN/</loc></url><url><loc>ORIGIN/contact</loc></url></urlset>',
    'router.js': `const pages = { '/': 'Welcome to the workshop', '/about': 'About the two of us', '/prices': 'What it costs', '/contact': 'Where to find us' };
function draw() {
  const title = pages[location.pathname] || 'Page not found';
  document.getElementById('root').innerHTML = '<nav><a href="/">Home</a> <a href="/about">About</a> <button id="prices">Prices</button></nav><main><h1>' + title + '</h1><p>This paragraph belongs to the page called ' + title + ', and is long enough to edit.</p></main>';
  document.getElementById('prices').onclick = () => { history.pushState({}, '', '/prices'); draw(); };
  for (const a of document.querySelectorAll('nav a')) a.onclick = (e) => { e.preventDefault(); history.pushState({}, '', a.getAttribute('href')); draw(); };
}
addEventListener('popstate', draw); draw();`,
  },
  // 3. styles that exist only in memory
  styles: {
    'index.html': shell('<div id="root"><h1 class="hero">Painted by script</h1><p class="badge">A badge with a border drawn from memory.</p></div><script src="/paint.js"></script>'),
    'paint.js': `const s = document.createElement('style'); document.head.appendChild(s);
s.sheet.insertRule('.hero { color: rgb(200, 30, 30); }');
const sheet = new CSSStyleSheet(); sheet.replaceSync('.badge { border: 3px solid rgb(10, 120, 60); }');
document.adoptedStyleSheets = [sheet];`,
  },
  // 4. pictures that load only when scrolled to
  lazy: {
    'index.html': shell(`<h1>A long page of pictures</h1><div style="height:4000px"></div>
<img id="a" data-lazy="/pics/oven.png" alt="The oven" width="40" height="40">
<img id="b" loading="lazy" src="/pics/loaf.png" alt="A loaf" width="40" height="40">
<script src="/lazy.js"></script>`),
    'pics/oven.png': PNG, 'pics/loaf.png': PNG,
    'lazy.js': `new IntersectionObserver((es, io) => { for (const e of es) if (e.isIntersecting) { e.target.src = e.target.dataset.lazy; io.unobserve(e.target); } }).observe(document.getElementById('a'));`,
  },
  // 5. a phone menu the app draws when its button is pressed
  menu: {
    'index.html': shell('<div id="root"></div><script src="/menu.js"></script>',
      '<style>.burger{display:none}.links{display:flex;gap:12px}@media (max-width:767px){.burger{display:inline-block}.links{display:none}}.sheet{display:flex;flex-direction:column}</style>'),
    'menu.js': `let open = false;
function draw() {
  document.getElementById('root').innerHTML = '<header><nav class="links"><a href="/">Home</a><a href="/#visit">Visit</a></nav>'
    + '<button class="burger" aria-label="Toggle menu" aria-expanded="' + open + '">☰</button>'
    + (open ? '<div class="sheet"><a href="/">Home</a><a href="/#visit">Visit us on Mill Lane</a></div>' : '')
    + '</header><main><h1>The menu is drawn by script</h1><p>On a phone the links hide behind a button that needs script.</p></main>';
  document.querySelector('.burger').onclick = () => { open = !open; draw(); };
}
draw();`,
  },
};

const sites = {};
before(async () => {
  if (SKIP) return;
  await Promise.all(Object.entries(FIXTURES).map(async ([name, files]) => {
    const dir = path.join(TMP, 'site-' + name);
    const server = await serve((mkdirSync(dir, { recursive: true }), dir), { spa: name === 'routes' });
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), typeof body === 'string' ? body.replaceAll('ORIGIN', server.url) : body);
    }
    const out = path.join(TMP, 'out-' + name);
    const extra = name === 'menu' ? ['--menu-shim', '--try'] : [];
    const r = await run(['rescue', server.url, '--render', '--out', out, '--delay', '0', ...extra]);
    const read = (f) => readFileSync(path.join(out, f), 'utf8');
    sites[name] = { ...r, out, read, server, report: existsSync(path.join(out, 'RESCUE-REPORT.md')) ? read('RESCUE-REPORT.md') : '' };
  }));
});
after(async () => { for (const s of Object.values(sites)) await s.server.close(); });

test('render: a page drawn by script into #root is saved with its words, tagged, without the app', { skip: SKIP }, () => {
  const s = sites.root;
  assert.equal(s.code, 0, s.out);
  const html = s.read('index.html');
  assert.ok(html.includes('Fresh bread every morning'), 'the heading the script drew');
  assert.ok(html.includes('Baked on Mill Lane since 1998'));
  assert.ok(html.includes('<title>Crumb Bakery</title>'), 'the title the script set');
  assert.equal(appScripts(html), 0);
  assert.ok(!html.includes('app.js'), 'neither the script nor its preload');
  assert.ok(html.includes('"@type":"Bakery"'), 'structured data stays');
  assert.ok(!/enable JavaScript/i.test(html), 'the "enable JavaScript" notice is gone');
  assert.match(html, /<h1 data-cms="[^"]+">Fresh bread every morning<\/h1>/);
  assert.ok(html.includes('<script src="/assets/kiln-config.js"></script>\n<script src="/assets/kiln.js" defer></script>'));
  for (const f of ['kiln.js', 'kiln-editor.js', 'kiln-features.js']) assert.ok(existsSync(path.join(s.out, 'assets', f)), f);
  assert.ok(!existsSync(path.join(s.out, 'assets', 'kiln-config.js')), 'no config: the wizard writes the real one');
  assert.match(s.report, /App scripts left in the pages: 0/);
  assert.match(s.report, /Forms: 1\./);
  assert.match(s.report, /"Write to us" \(2 fields\) on \//);
  assert.match(s.report, /button "Order now" on \//);
  assert.match(s.report, /differently on a second visit: 1\./);
  assert.match(s.report, /"Loaves sold today: \d+" then "Loaves sold today: \d+"/);
});

test('render: routes reached by link, by button and from the sitemap each become a page', { skip: SKIP }, () => {
  const s = sites.routes;
  assert.equal(s.code, 0, s.out);
  assert.ok(s.read('index.html').includes('Welcome to the workshop'));
  assert.ok(s.read('about/index.html').includes('About the two of us'), 'a link in the drawn navigation');
  assert.ok(s.read('prices/index.html').includes('What it costs'), 'a button that changed the address by script');
  assert.ok(s.read('contact/index.html').includes('Where to find us'), 'listed only in sitemap.xml');
  assert.ok(s.read('index.html').includes('<a href="/about/">About</a>'), 'links point at the saved pages');
  for (const f of ['index.html', 'about/index.html', 'prices/index.html', 'contact/index.html']) assert.equal(appScripts(s.read(f)), 0, f);
  assert.match(s.report, /The button "Prices" changed page by script \(it went to \/prices\)/);
  assert.match(s.report, /Pages crawled: 4, written: 4/);
});

test('render: styles that existed only in memory are written into the page', { skip: SKIP }, () => {
  const s = sites.styles;
  assert.equal(s.code, 0, s.out);
  const html = s.read('index.html');
  assert.match(html, /<style>\.hero \{ color: rgb\(200, 30, 30\); \}<\/style>/);
  assert.match(html, /\.badge \{ border: 3px solid rgb\(10, 120, 60\); \}/);
  assert.equal(appScripts(html), 0);
  assert.match(s.report, /now written into the pages: 2\./);
});

test('render: lazy pictures are loaded, copied and pointed at the copy', { skip: SKIP }, () => {
  const s = sites.lazy;
  assert.equal(s.code, 0, s.out);
  const html = s.read('index.html');
  const oven = html.match(/<img id="a"[^>]*\ssrc="(\/assets\/rescued\/[^"]+oven\.png)"/);
  const loaf = html.match(/<img id="b"[^>]*\ssrc="(\/assets\/rescued\/[^"]+loaf\.png)"/);
  assert.ok(oven, 'the picture a script swapped in on scroll: ' + html);
  assert.ok(loaf, 'the browser-lazy picture');
  for (const m of [oven, loaf]) assert.deepEqual(readFileSync(path.join(s.out, m[1])), PNG);
  assert.match(html, /data-cms-attr="[^"]*"/, 'pictures are tagged for editing');
  assert.equal(appScripts(html), 0);
});

test('render: --menu-shim makes the phone menu open on the frozen page', { skip: SKIP }, async () => {
  const s = sites.menu;
  assert.equal(s.code, 0, s.out);
  const html = s.read('index.html');
  assert.ok(html.includes('data-kiln-menu-toggle'));
  assert.match(html, /<div class="sheet" data-kiln-menu-panel="">/);
  assert.ok(html.includes('Visit us on Mill Lane'));
  assert.ok(html.includes(MENU_STYLE));
  assert.ok(html.includes('<script src="/assets/kiln-menu.js" defer></script>'));
  assert.ok(!html.includes('data-kf'), 'the numbering is removed');
  assert.equal(appScripts(html), 0);
  assert.ok(readdirSync(path.join(s.out, 'assets')).includes('kiln-menu.js'));
  assert.match(s.report, /Phone menu: works\. The button "Toggle menu" opens it through assets\/kiln-menu\.js/);
  assert.match(readFileSync(path.join(s.out, 'assets', 'kiln-config.js'), 'utf8'), /sandbox: true/, '--try writes a try-out config');
  assert.match(s.report, /To try editing now/);

  // open the frozen copy on a phone-sized screen and press the button
  const frozen = await serve(s.out);
  const b = await pw.chromium.launch({ executablePath: browser.path, headless: true });
  try {
    const page = await b.newPage({ viewport: { width: 390, height: 800 } });
    await page.goto(frozen.url + '/');
    const sheet = page.locator('.sheet');
    assert.equal(await sheet.isVisible(), false, 'closed to begin with');
    await page.locator('[data-kiln-menu-toggle]').click();
    assert.equal(await sheet.isVisible(), true, 'open after a press');
    assert.equal(await page.locator('[data-kiln-menu-toggle]').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await sheet.isVisible(), false, 'Escape closes it');
    // and the editor starts on the frozen copy: a word can be clicked
    await page.waitForSelector('#kiln-fab, #kiln-bar, [data-kiln-sandbox]', { timeout: 10000 });
  } finally { await b.close(); await frozen.close(); }
});

test('render: without --menu-shim the report says the menu button does not open', { skip: SKIP }, async () => {
  const out = path.join(TMP, 'out-menu-plain');
  const r = await run(['rescue', sites.menu.server.url, '--render', '--out', out, '--delay', '0']);
  assert.equal(r.code, 0, r.out);
  const html = readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.ok(!html.includes('kiln-menu.js'));
  assert.ok(!html.includes('data-kiln-menu-panel'));
  assert.match(readFileSync(path.join(out, 'RESCUE-REPORT.md'), 'utf8'), /Phone menu: the button "Toggle menu" does not open\. Run again with --menu-shim/);
});
