import { test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  REPO_PLACEHOLDER, checkTargetDir, depersonalizeConfig, personalizeHtml,
  setConfigSiteName, siteNameOf, titleOf, siteGuide, writeSiteGuide,
} from '../cli/new.mjs';

test('new: siteGuide says what the folder is, how to look at it and put it online, and what to change first', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kiln-new-guide-'));
  const plain = mkdtempSync(path.join(tmpdir(), 'kiln-new-guide-'));
  try {
    for (const f of ['blog', 'members', 'functions/members']) mkdirSync(path.join(dir, f), { recursive: true });
    writeFileSync(path.join(dir, 'index.html'), '<title>My Shop</title><footer>Big Dill Pickle Co. All rights brined.</footer>');
    writeFileSync(path.join(dir, 'about.html'), '<title>About · My Shop</title><img alt="Big Dill pickle jars">');
    writeFileSync(path.join(dir, 'contact.html'), '<title>Contact</title><p>Big Dillon is someone else</p>');
    for (const f of ['index.html', 'hello-from-the-editor-mr566orv.html', 'the-monday-brine.html']) writeFileSync(path.join(dir, 'blog', f), '<p>post</p>');
    writeFileSync(path.join(dir, 'members-login.html'), '');
    writeFileSync(path.join(dir, '_routes.json'), '{}');
    const g = siteGuide(dir, { name: 'My Shop', from: 'kilncms/kiln-demo', brand: 'Big Dill' });
    assert.match(g, /^# My Shop\n/);
    assert.match(g, /complete example website/);
    assert.match(g, /made-up pickle company, Big Dill/);
    assert.match(g, /npx serve \./);
    assert.match(g, /npx github:kilncms\/kiln#release/);
    assert.match(g, /Look for "Big Dill" in about\.html and index\.html,/, 'names the pages still carrying the old name, not contact.html');
    assert.match(g, /blog\/hello-from-the-editor-mr566orv\.html and blog\/the-monday-brine\.html\./);
    assert.match(g, /delete the members\/ folder, members-login\.html, the functions\/ folder and _routes\.json/);
    assert.ok(!/[—–]/.test(g), 'no dashes used as punctuation');
    // the demo's own README is replaced; another template's own is kept
    assert.equal(writeSiteGuide(dir, g, 'kilncms/kiln-demo'), 'written');
    assert.equal(writeSiteGuide(dir, g, 'kilncms/kiln-demo'), 'replaced');
    writeFileSync(path.join(dir, 'README.md'), 'theirs');
    assert.equal(writeSiteGuide(dir, g, 'someone/template'), 'kept');
    assert.equal(readFileSync(path.join(dir, 'README.md'), 'utf8'), 'theirs');
    // another template: no pickles, and nothing to delete that is not there
    writeFileSync(path.join(plain, 'index.html'), '<title>X</title>');
    assert.doesNotMatch(siteGuide(plain, { name: 'X', from: 'someone/template' }), /pickle|members|blog|What to change/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

// ─── kiln-config.js de-personalization ───────────────────────────────────────

// mirrors the live demo template's config, plus keys `kiln new` knows nothing about
const CONFIG = `window.KILN = {
  repo:   'kilncms/kiln-demo',
  branch: 'main',
  worker: 'https://auth.kilncms.com',
  siteName: 'Big Dill',
  sandbox: true,   // demo: every visitor edits a private, local-only, auto-resetting copy
  styles: [],
  logoutRedirect: '/thanks.html',
};
`;

test('new: depersonalizeConfig — repo/worker reset, sandbox line gone, everything else byte-for-byte', () => {
  const { src, changes } = depersonalizeConfig(CONFIG);
  // unknown keys (branch, siteName, styles, logoutRedirect), alignment spacing,
  // and quote style all survive untouched — assert the exact bytes
  assert.equal(src, `window.KILN = {
  repo:   '${REPO_PLACEHOLDER}',
  branch: 'main',
  worker: '',
  siteName: 'Big Dill',
  styles: [],
  logoutRedirect: '/thanks.html',
};
`);
  assert.equal(changes.length, 3, 'one reported change per rewrite');
});

test('new: depersonalizeConfig is idempotent — a second pass reports nothing', () => {
  const once = depersonalizeConfig(CONFIG).src;
  const twice = depersonalizeConfig(once);
  assert.equal(twice.src, once);
  assert.deepEqual(twice.changes, []);
});

test('new: depersonalizeConfig — double quotes kept, inline sandbox removed without eating neighbors', () => {
  const { src } = depersonalizeConfig(`window.KILN = { repo: "a/b", worker: "https://w.dev", sandbox: true, styles: [] };`);
  assert.equal(src, `window.KILN = { repo: "${REPO_PLACEHOLDER}", worker: "", styles: [] };`);
});

test('new: depersonalizeConfig — a sandbox line sharing other keys loses only the pair', () => {
  const { src } = depersonalizeConfig(`window.KILN = {\n  sandbox: true, styles: ['/a.css'],\n};\n`);
  assert.equal(src, `window.KILN = {\n  styles: ['/a.css'],\n};\n`);
});

test('new: depersonalizeConfig — missing keys are not invented', () => {
  const bare = `window.KILN = {\n  styles: [],\n};\n`;
  const { src, changes } = depersonalizeConfig(bare);
  assert.equal(src, bare);
  assert.deepEqual(changes, []);
});

test('new: setConfigSiteName — value swapped, quote style kept, quotes in the name escaped', () => {
  const r = setConfigSiteName(`  siteName: 'Big Dill',\n`, "Rosie's Diner");
  assert.equal(r.changed, true);
  assert.equal(r.src, `  siteName: 'Rosie\\'s Diner',\n`);
  assert.equal(setConfigSiteName(`  worker: '',\n`, 'X').changed, false, 'no siteName key → untouched');
  assert.equal(setConfigSiteName(`  siteName: "Old",\n`, 'New').src, `  siteName: "New",\n`);
});

// ─── title discovery ─────────────────────────────────────────────────────────

test('new: titleOf + siteNameOf — name is the part before a space-padded separator', () => {
  assert.equal(titleOf('<head><title>Big Dill — Small-batch pickles</title></head>'), 'Big Dill — Small-batch pickles');
  assert.equal(titleOf('<p>no title here</p>'), null);
  assert.equal(siteNameOf('Big Dill — Small-batch pickles, taken too seriously'), 'Big Dill');
  assert.equal(siteNameOf('Acme | Home'), 'Acme');
  assert.equal(siteNameOf('Cedar Bakery'), 'Cedar Bakery', 'no separator → the whole title');
  assert.equal(siteNameOf('Anna-Maria Bakery'), 'Anna-Maria Bakery', 'hyphen without spaces is part of the name');
  assert.equal(siteNameOf('Big Dill - pickles'), 'Big Dill', 'spaced hyphen is a separator');
});

// ─── title personalization (the conservatism contract) ───────────────────────

const TITLE = 'Big Dill — Small-batch pickles, taken too seriously';
const PAGE = `<head>
<title>${TITLE}</title>
<meta name="description" content="Big Dill makes small-batch pickles in stoneware crocks." />
</head><body>
<header><a class="brand" href="/" aria-label="Big Dill home"><span class="brand__word">Big Dill</span></a></header>
<p>Kind of a big dill. Welcome to Big Dill — est. 2020. Not Big Dillon though.</p>
<footer>© 2026 Big Dill Pickle Co.</footer>
</body>`;

test('new: personalizeHtml — homepage title, brand element, and aria-label change; prose does not', () => {
  const { html, count } = personalizeHtml(PAGE, { title: TITLE, name: 'Big Dill', newName: 'Cedar Bakery' });
  assert.ok(html.includes('<title>Cedar Bakery</title>'), 'full template title → the new name alone');
  assert.ok(html.includes('>Cedar Bakery</span>'), 'brand mark (entire element text) renamed');
  assert.ok(html.includes('aria-label="Cedar Bakery home"'), 'name inside aria-label renamed');
  // conservatism: exact strings only, and only where the name IS the content
  assert.ok(html.includes('Big Dill makes small-batch pickles'), 'meta description prose untouched');
  assert.ok(html.includes('Welcome to Big Dill — est. 2020'), 'body prose mentioning the name untouched');
  assert.ok(html.includes('Kind of a big dill'), 'lowercase variant untouched (case-sensitive)');
  assert.ok(html.includes('Not Big Dillon though'), 'longer word containing the name untouched');
  assert.ok(html.includes('© 2026 Big Dill Pickle Co.'), 'footer prose untouched');
  assert.equal(count, 3);
});

test('new: personalizeHtml — subpage titles swap just the name part', () => {
  const { html } = personalizeHtml('<title>Our story — Big Dill</title>', { title: TITLE, name: 'Big Dill', newName: 'Cedar Bakery' });
  assert.equal(html, '<title>Our story — Cedar Bakery</title>');
});

test('new: personalizeHtml — a short name never damages the longer strings containing it', () => {
  const page = '<title>Dill</title><span>Dill</span><span>Big Dill</span><p>Dilly beans</p>';
  const { html } = personalizeHtml(page, { title: 'Dill', name: 'Dill', newName: 'Cedar' });
  assert.ok(html.includes('<title>Cedar</title>'));
  assert.ok(html.includes('<span>Cedar</span>'));
  assert.ok(html.includes('<span>Big Dill</span>'), '"Dill" inside "Big Dill" survives');
  assert.ok(html.includes('Dilly beans'), '"Dill" inside "Dilly" survives');
});

test('new: personalizeHtml — regex metacharacters in the template name are literal', () => {
  const { html } = personalizeHtml('<title>C++ Corner (beta)</title><span>C++ Corner (beta)</span>',
    { title: 'C++ Corner (beta)', name: 'C++ Corner (beta)', newName: 'Cedar' });
  assert.equal(html, '<title>Cedar</title><span>Cedar</span>');
});

test('new: personalizeHtml — the new name is HTML-escaped on the way in', () => {
  const { html } = personalizeHtml('<title>Big Dill</title>', { title: 'Big Dill', name: 'Big Dill', newName: 'Fish & Chips <hq>' });
  assert.equal(html, '<title>Fish &amp; Chips &lt;hq&gt;</title>');
});

// ─── target-dir validation ───────────────────────────────────────────────────

test('new: checkTargetDir — free path or empty dir passes; anything occupied fails', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'kiln-new-test-'));
  try {
    assert.equal(checkTargetDir(path.join(base, 'not-there-yet')).ok, true, 'nonexistent path is fine');
    const empty = path.join(base, 'empty'); mkdirSync(empty);
    assert.equal(checkTargetDir(empty).ok, true, 'existing empty dir is fine');
    const full = path.join(base, 'full'); mkdirSync(full); writeFileSync(path.join(full, 'x.txt'), 'hi');
    assert.equal(checkTargetDir(full).ok, false, 'non-empty dir refused');
    const file = path.join(base, 'a-file'); writeFileSync(file, 'hi');
    assert.equal(checkTargetDir(file).ok, false, 'existing file refused');
    assert.equal(checkTargetDir('').ok, false, 'empty answer refused');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
