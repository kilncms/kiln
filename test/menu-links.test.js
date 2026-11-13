/**
 * The site menu keeps what it was not asked to change
 * (src/editor/menu-links.js, used by the Site menu tool in main.js and saved
 * through src/editor/menu-save.js).
 *
 * A tester's "Save to all pages" turned
 * `<a class="is-cta" href="/members-login.html">Members</a>` into
 * `<a href="/members-login.html">Members</a>` on every page and both
 * templates, so a styled button became a plain link, and it changed the
 * indentation of the first link and of `</nav>`. The menu was written afresh
 * from each link's words and address alone. These tests hold a save to
 * changing only what the person changed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { menuLinks, rewriteMenu, matchLinks } from '../src/editor/menu-links.js';
import { saveMenuEverywhere, menuInner, MENU_SAME } from '../src/editor/menu-save.js';
import { applyEdits } from '../src/engine.js';

const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');

const HOME = `
        <a href="/">Home</a>
        <a href="/shop.html">Shop</a>
        <a href="/blog/">Brine Time</a>
        <a href="/about.html">Our story</a>
        <a class="is-cta" href="/members-login.html">Members</a>
      `;
const rowsOf = (inner) => menuLinks(inner).map((l, i) => ({ ...l, from: i }));

test('menu links: the dialog lists each link with its words and its address', () => {
  assert.deepEqual(menuLinks(HOME), [
    { label: 'Home', href: '/' }, { label: 'Shop', href: '/shop.html' }, { label: 'Brine Time', href: '/blog/' },
    { label: 'Our story', href: '/about.html' }, { label: 'Members', href: '/members-login.html' },
  ]);
  assert.deepEqual(menuLinks('<ul><li><a href="/a?x=1&amp;y=2"><b>Salt</b> &amp;\n  vinegar</a></li></ul>'), [{ label: 'Salt & vinegar', href: '/a?x=1&y=2' }]);
});

test('menu links: add one, rename one, move one, and the styled button keeps its class and the whitespace stays', () => {
  const origin = menuLinks(HOME);
  const r = rowsOf(HOME);
  const rows = [r[0], r[1], r[3], { ...r[2], label: 'Brine Blog' }, r[4], { label: 'Visit us', href: '/visit.html', from: null }];
  assert.equal(rewriteMenu(HOME, origin, rows), `
        <a href="/">Home</a>
        <a href="/shop.html">Shop</a>
        <a href="/about.html">Our story</a>
        <a href="/blog/">Brine Blog</a>
        <a class="is-cta" href="/members-login.html">Members</a>
        <a href="/visit.html">Visit us</a>
      `);
});

test('menu links: a menu nobody changed comes back byte for byte', () => {
  const odd = '\n\t<a  href = "/"\n\t   class="a  b">Home</a>   <!-- then -->\n<a href=/x id=x>X &amp; Y</a>';
  for (const inner of [HOME, odd, '<ul>\n<li><a href="/">Home</a>\n</ul>']) {
    assert.equal(rewriteMenu(inner, menuLinks(inner), rowsOf(inner)), inner);
  }
});

test('menu links: every other attribute of a link stays when its address or its words change', () => {
  const inner = `<a href='/join.html' target=_blank rel="noopener" id=m data-plan='paid' aria-label="Join us">Join</a> <a href="/x">X</a>`;
  const r = rowsOf(inner);
  assert.equal(rewriteMenu(inner, menuLinks(inner), [{ ...r[0], href: '/members.html' }, r[1]]),
    `<a href="/members.html" target=_blank rel="noopener" id=m data-plan='paid' aria-label="Join us">Join</a> <a href="/x">X</a>`);
  assert.equal(rewriteMenu(inner, menuLinks(inner), [{ ...r[0], label: 'Members' }, r[1]]),
    `<a href='/join.html' target=_blank rel="noopener" id=m data-plan='paid' aria-label="Join us">Members</a> <a href="/x">X</a>`);
});

test('menu links: new words go where the words were, and a drawing beside them stays', () => {
  const inner = '<a href="/shop.html"><svg class="i" viewBox="0 0 1 1"><path d="M0 0"/></svg> Shop</a>\n<a href="/"><img src="/logo.png" alt=""></a>';
  const r = rowsOf(inner);
  assert.equal(r[1].label, '');
  assert.equal(rewriteMenu(inner, menuLinks(inner), [{ ...r[0], label: 'Store & more' }, r[1]]),
    '<a href="/shop.html"><svg class="i" viewBox="0 0 1 1"><path d="M0 0"/></svg> Store &amp; more</a>\n<a href="/"><img src="/logo.png" alt=""></a>',
    'a link that is only a picture has no words, and is kept whole');
});

test('menu links: each page keeps what its own copy of a link carries', () => {
  const blog = '\n  <a href="../">Home</a>\n  <a href="../shop.html">Shop</a>\n  <a href="./" class="active" aria-current="page">Brine Time</a>\n  <a href="../about.html">Our story</a>\n  <a class="is-cta" href="../members-login.html" data-plan="paid">Members</a>\n';
  const origin = menuLinks(HOME);
  const r = rowsOf(HOME);
  const rows = [r[0], r[1], r[3], { ...r[2], label: 'Brine Blog' }, { ...r[4], href: '/join.html' }];
  assert.equal(rewriteMenu(blog, origin, rows),
    '\n  <a href="../">Home</a>\n  <a href="../shop.html">Shop</a>\n  <a href="../about.html">Our story</a>\n  <a href="./" class="active" aria-current="page">Brine Blog</a>\n  <a class="is-cta" href="/join.html" data-plan="paid">Members</a>\n');
  assert.deepEqual(matchLinks(origin, menuLinks(blog)), [0, 1, 2, 3, 4]);
  assert.deepEqual(matchLinks([{ label: 'A', href: '/a' }, { label: 'B', href: '/b' }], [{ label: 'B', href: '/b' }]), [-1, 0]);
});

test('menu links: in a list, a link moves with its list item, and a new one is written like its neighbours', () => {
  const inner = `
  <ul class="nav">
    <li class="item"><a class="link" href="/">Home</a></li>
    <li class="item" id="shop"><a class="link" href="/shop.html">Shop</a></li>
    <li class="item"><a class="link cta" href="/join.html">Join</a></li>
  </ul>
`;
  const r = rowsOf(inner);
  assert.equal(rewriteMenu(inner, menuLinks(inner), [r[2], r[0], r[1], { label: 'Visit', href: '/visit.html', from: null }]), `
  <ul class="nav">
    <li class="item"><a class="link cta" href="/join.html">Join</a></li>
    <li class="item"><a class="link" href="/">Home</a></li>
    <li class="item" id="shop"><a class="link" href="/shop.html">Shop</a></li>
    <li class="item"><a class="link" href="/visit.html">Visit</a></li>
  </ul>
`);
  const one = '<ul>\n  <li><a href="/">Home</a></li>\n</ul>';
  assert.equal(rewriteMenu(one, menuLinks(one), [...rowsOf(one), { label: 'Shop', href: '/shop.html', from: null }]),
    '<ul>\n  <li><a href="/">Home</a></li>\n  <li><a href="/shop.html">Shop</a></li>\n</ul>', 'a list of one link stays one list');
});

test('menu links: a new link takes a class only when every link of the page has it', () => {
  const all = '<a class="nav-link" href="/">Home</a> | <a class="nav-link active" href="/a">A</a>';
  assert.equal(rewriteMenu(all, menuLinks(all), [...rowsOf(all), { label: 'B', href: '/b', from: null }]),
    '<a class="nav-link" href="/">Home</a> | <a class="nav-link active" href="/a">A</a> | <a class="nav-link" href="/b">B</a>');
  const r = rowsOf(HOME);
  assert.match(rewriteMenu(HOME, menuLinks(HOME), [...r, { label: 'B', href: '/b', from: null }]), /\n        <a href="\/b">B<\/a>\n      $/);
});

test('menu links: removing a link takes it out whole and leaves the rest as it was', () => {
  const r = rowsOf(HOME);
  assert.equal(rewriteMenu(HOME, menuLinks(HOME), [r[0], r[1], r[3], r[4]]), `
        <a href="/">Home</a>
        <a href="/shop.html">Shop</a>
        <a href="/about.html">Our story</a>
        <a class="is-cta" href="/members-login.html">Members</a>
      `);
  assert.equal(rewriteMenu(HOME, menuLinks(HOME), [r[0], r[1], r[2], r[3], { ...r[4], label: ' ' }]).includes('Members'), false, 'a link whose words were cleared is removed');
});

test('menu links: what is typed can never become markup or a script', () => {
  const r = rowsOf(HOME);
  const out = rewriteMenu(HOME, menuLinks(HOME), [{ ...r[0], label: '<img src=x onerror=alert(1)>', href: 'javascript:alert(1)' }, ...r.slice(1), { label: '"><script>x</script>', href: '/a"onmouseover="x', from: null }]);
  assert.doesNotMatch(out, /javascript:|<script|<img|onmouseover="x"/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;<\/a>/);
  assert.equal(menuLinks(out).length, 6);
});

// ─── the save ────────────────────────────────────────────────────────────────

const page = (inner, more = '') => `<!doctype html>\n<html><head><title>T</title></head><body>\n      <nav class="site-nav" data-cms-menu="main">${inner}</nav>\n<p>Words.</p>${more}\n</body></html>\n`;
function fakeSite(files) {
  const commits = [];
  return {
    commits,
    args: {
      gh: { async request() { return { tree: Object.keys(files).map(path => ({ type: 'blob', path })) }; } },
      repo: 'o/r', branch: 'main', menuKey: 'main', applyEdits,
      getFile: async (gh, repo, path) => ({ text: files[path] }),
      commitFiles: async (gh, repo, branch, changed, message) => { commits.push({ changed, message }); return { sha: 'c1' }; },
    },
  };
}

test('menu save: the tester\'s save leaves the Members button styled on every page, and each file differs only where asked', async () => {
  const sub = HOME.replace('<a href="/blog/">', '<a href="/blog/" aria-current="page">');
  const files = { 'index.html': page(HOME), 'blog/index.html': page(sub), '_templates/post.html': page(HOME), 'plain.html': '<html><body><p>No menu.</p></body></html>' };
  const site = fakeSite(files);
  const origin = menuLinks(menuInner(files['index.html'], 'main'));
  const r = origin.map((l, i) => ({ ...l, from: i }));
  const rows = [r[0], r[1], r[3], { ...r[2], label: 'Brine Blog' }, r[4], { label: 'QA item', href: '/qa.html', from: null }];
  const got = await saveMenuEverywhere({ ...site.args, rewrite: (inner) => rewriteMenu(inner, origin, rows) });
  assert.equal(got.changed.length, 3);
  assert.equal(got.skipped, 1);
  assert.equal(site.commits.length, 1);
  assert.equal(site.commits[0].message, 'Update menu on 3 pages (via Kiln)');
  for (const c of got.changed) {
    assert.match(c.text, /<a class="is-cta" href="\/members-login\.html">Members<\/a>/, `${c.path} keeps the button's class`);
    assert.match(c.text, /<nav class="site-nav" data-cms-menu="main">\n        <a href="\/">Home<\/a>\n/, 'the first link keeps its indentation');
    assert.match(c.text, /<a href="\/qa\.html">QA item<\/a>\n      <\/nav>/, 'and so does the closing tag');
  }
  assert.match(got.changed.find(c => c.path === 'blog/index.html').text, /<a href="\/blog\/" aria-current="page">Brine Blog<\/a>/);
});

test('menu save: a page whose menu does not change is not written, and a save that changes nothing makes no commit', async () => {
  const without = HOME.replace('        <a href="/blog/">Brine Time</a>\n', '');
  const files = { 'index.html': page(HOME), 'about.html': page(without) };
  const site = fakeSite(files);
  const origin = menuLinks(HOME);
  const r = origin.map((l, i) => ({ ...l, from: i }));
  const same = await saveMenuEverywhere({ ...site.args, rewrite: (inner) => rewriteMenu(inner, origin, r) });
  assert.deepEqual({ changed: same.changed.length, same: same.same, commit: same.commit }, { changed: 1, same: 1, commit: { sha: 'c1' } },
    'about.html lacked a link the menu has: it is given it, and index.html is left alone');
  assert.deepEqual(site.commits[0].changed.map(c => c.path), ['about.html']);
  assert.equal(site.commits[0].changed[0].text, files['index.html'].replace('about', 'about'), 'the page ends up with the same menu as the others');
  const again = fakeSite({ 'index.html': page(HOME), 'two.html': page(HOME) });
  const none = await saveMenuEverywhere({ ...again.args, rewrite: (inner) => rewriteMenu(inner, origin, r) });
  assert.deepEqual({ changed: none.changed.length, same: none.same, commit: none.commit }, { changed: 0, same: 2, commit: null });
  assert.equal(again.commits.length, 0);
  assert.doesNotMatch(MENU_SAME, /—/);
});

test('menu save: the Site menu tool writes no link by itself', () => {
  const tool = main.slice(main.indexOf('function menuEditor()'), main.indexOf('// ─── People & access (admin only)'));
  assert.match(tool, /rewrite: \(inner\) => rewriteMenu\(inner, origin, asked\)/);
  assert.match(tool, /menuLinks\(innerHtml\)/);
  assert.doesNotMatch(tool, /<a href="\$\{|newInner|DOMParser/, 'the menu is not built afresh from words and addresses');
  assert.match(tool, /if \(!commit && same\) \{ status\.textContent = MENU_SAME; return; \}/);
});
