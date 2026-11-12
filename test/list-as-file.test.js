/**
 * A list of blocks is written back into the page's file without touching
 * what the owner did not change (src/editor/list-as-file.js).
 *
 * The fault this guards: one card's title was changed, and the inline SVG
 * drawing in every card of the list was deleted from the site, because the
 * whole list was written as the editor's cleaner left it.
 *
 * The editor reads a block with the browser and DOMPurify. Here the same
 * reading is done on parse5 with the editor's own allowlist
 * (CONTAINER_SANITIZE): an element not on the list goes, an attribute not on
 * the list goes. That is what took the drawings out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFragment, serialize, serializeOuter, defaultTreeAdapter as T, html as H } from 'parse5';
import { listAsFile, LIST_NOT_WHOLE } from '../src/editor/list-as-file.js';
import { CONTAINER_SANITIZE } from '../src/editor/sanitize.js';
import { applyEdits, indexHtml, attrNameAllowed } from '../src/engine.js';
import { checkDocumentWrite } from '../worker/sanitize-guard.js';

const TAGS = new Set(CONTAINER_SANITIZE.ALLOWED_TAGS);
const ATTRS = new Set(CONTAINER_SANITIZE.ALLOWED_ATTR);
const GOES_WHOLE = new Set(['svg', 'iframe', 'script', 'style', 'template', 'math', 'noscript', 'video', 'audio']);
const ctx = (tag) => T.createElement(tag, H.NS.HTML, []);
const attr = (n, name) => n.attrs.find(a => a.name === name)?.value;

/** The cleaner, on a parse5 tree: what is not on the allowlist goes. */
function scrub(parent) {
  for (const n of [...parent.childNodes]) {
    if (!n.tagName) { if (n.nodeName === '#comment') T.detachNode(n); continue; }
    if (!TAGS.has(n.tagName)) {
      if (!GOES_WHOLE.has(n.tagName)) for (const c of [...n.childNodes]) T.insertBefore(parent, c, n);
      T.detachNode(n);
      continue;
    }
    n.attrs = n.attrs.filter(a => ATTRS.has(a.name) || /^(data|aria)-/.test(a.name));
  }
  for (const n of parent.childNodes) if (n.tagName) scrub(n);
}

/** read(html) for a list with this tag: each block as the editor would stage it. */
const reader = (tag) => (html) => {
  const out = [];
  for (const node of parseFragment(ctx(tag), String(html ?? '')).childNodes.filter(n => n.tagName)) {
    const before = serializeOuter(node);
    const box = T.createDocumentFragment();
    T.detachNode(node);
    T.appendChild(box, node);
    scrub(box);
    if (box.childNodes.length !== 1 || !box.childNodes[0].tagName) continue;
    const root = box.childNodes[0];
    const after = serialize(box);
    const els = [];
    const walk = (n, top) => { if (!n.tagName) return; if (top || attr(n, 'data-cms') !== undefined) els.push(n); for (const c of n.childNodes) walk(c, false); };
    walk(root, true);
    const parts = els.map((el) => {
      const key = attr(el, 'data-cms') ?? null;
      const attrs = {};
      for (const a of el.attrs) if (attrNameAllowed(a.name)) attrs[a.name] = a.value;
      let own = null, inner = null;
      if (key != null) {
        inner = serialize(el);
        const copy = parseFragment(ctx(el.tagName), inner);
        const empty = (n) => { for (const c of n.childNodes || []) { if (!c.tagName) continue; if (attr(c, 'data-cms') !== undefined) { c.childNodes = []; c.attrs = c.attrs.filter(a => a.name === 'data-cms'); } else empty(c); } };
        empty(copy);
        own = serialize(copy);
      }
      let holder = el.parentNode;
      while (holder && holder !== box && !(holder.tagName && attr(holder, 'data-cms') !== undefined)) holder = holder.parentNode;
      return { key, html: inner, own, attrs, inside: holder && holder !== box ? els.indexOf(holder) : -1 };
    });
    out.push({ html: after, lost: before !== after, parts });
  }
  return out;
};

/** The list as the editor would stage it from the page: every block cleaned, nothing between them. */
const staged = (tag, html) => reader(tag)(html).map(b => b.html).join('');

const ICON = (d) => `<svg class="feature__icon" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
            <path d="${d}" stroke="currentColor" fill="none" stroke-width="1.5"/>
          </svg>`;
const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Crock &amp; Co</title></head>
<body>
  <h1 data-cms="headline">Three things we refuse to rush</h1>
  <div class="features" data-cms-repeat="features_items">
        <!-- the first card -->
        <article class="feature" x-data="{ open: false }" data-aos='fade-up'>
          ${ICON('M4 12h16')}
          <h3 data-cms="feature_title">Real fermentation</h3>
          <p data-cms="feature_text">Six weeks in the crock &mdash; never less.</p>
        </article>
        <article class="feature" x-data="{ open: false }" data-aos='fade-up'>
          ${ICON('M12 4v16')}
          <h3 data-cms="feature_title">Stubbornly local</h3>
          <p data-cms="feature_text">Cabbage from <a href=/farms target="_blank">four farms</a> we can cycle to.</p>
          <iframe src="https://www.youtube-nocookie.com/embed/abc123" title="The farms" loading="lazy"></iframe>
        </article>
        <article class="feature" x-data="{ open: false }" data-aos='fade-up'>
          ${ICON('M4 4l16 16')}
          <h3 data-cms="feature_title">A serious crunch</h3>
          <p data-cms="feature_text">Cut by hand, salted by weight.</p>
          <img data-cms="feature_photo" src="/img/crunch.jpg" alt="A jar">
        </article>
  </div>
  <script src="/assets/kiln.js"></script>
</body>
</html>
`;
const listOf = (page, key = 'features_items') => { const f = indexHtml(page).fields.get(key); return { tag: f.tag, text: page.slice(f.inner.start, f.inner.end) }; };
/** The page's file after a publish of this list, staged as `now`. */
function publish(page, now, { base, lost } = {}) {
  const { tag, text } = listOf(page);
  const res = listAsFile({ tag, text, now, base: base ?? staged(tag, text), lost, read: reader(tag) });
  assert.equal(res.ok, true, 'the list can be written');
  return applyEdits(page, [{ key: 'features_items', html: res.html }]).html;
}

test('the cleaner alone takes the drawings, the embed and the unknown attribute out of the list', () => {
  const { tag, text } = listOf(PAGE);
  const read = staged(tag, text);
  assert.ok(!read.includes('<svg') && !read.includes('<iframe') && !read.includes('x-data'), 'that is what used to be published');
  assert.ok(reader(tag)(text).every(b => b.lost), 'and every block is known to have lost something');
});

test('one title is changed: the file differs from the original in that one title only', () => {
  const { tag, text } = listOf(PAGE);
  const now = staged(tag, text).replace('Stubbornly local', 'Proudly local');
  const written = publish(PAGE, now);
  assert.equal(written, PAGE.replace('Stubbornly local', 'Proudly local'));
  assert.equal((written.match(/<svg/g) || []).length, 3, 'the three drawings are there');
  assert.ok(written.includes('<iframe src="https://www.youtube-nocookie.com/embed/abc123"'), 'so is the embed the owner put there');
  assert.equal(checkDocumentWrite(PAGE, written), null, 'and the service takes the write');
});

test('nothing changed: the list is written exactly as the file has it', () => {
  const { tag, text } = listOf(PAGE);
  assert.equal(publish(PAGE, staged(tag, text)), PAGE);
});

test('words changed in a paragraph: the link beside them keeps the file\'s own quoting, the rest is as typed', () => {
  const { tag, text } = listOf(PAGE);
  const now = staged(tag, text).replace('Cut by hand, salted by weight.', 'Cut by hand, <strong>salted</strong> by weight.');
  assert.equal(publish(PAGE, now), PAGE.replace('Cut by hand, salted by weight.', 'Cut by hand, <strong>salted</strong> by weight.'));
});

test('a picture replaced and described: only its address and description change', () => {
  const { tag, text } = listOf(PAGE);
  const now = staged(tag, text).replace('src="/img/crunch.jpg" alt="A jar"', 'src="/img/new &amp; improved.jpg" alt="Two &quot;jars&quot;" style="width: 60%"');
  assert.equal(publish(PAGE, now),
    PAGE.replace('src="/img/crunch.jpg" alt="A jar"', 'src="/img/new &amp; improved.jpg" alt="Two &quot;jars&quot;" style="width: 60%"'));
});

test('a block is tagged, and the tag is taken off again', () => {
  const { tag, text } = listOf(PAGE);
  const tagged = staged(tag, text).replace('<article class="feature" data-aos="fade-up">', '<article class="feature" data-aos="fade-up" data-kiln-tags="veg, local">');
  const written = publish(PAGE, tagged);
  assert.equal(written, PAGE.replace(`x-data="{ open: false }" data-aos='fade-up'>`, `x-data="{ open: false }" data-aos='fade-up' data-kiln-tags="veg, local">`));
  assert.equal(publish(written, staged(tag, listOf(written).text).replace(' data-kiln-tags="veg, local"', '')), PAGE);
});

test('blocks moved, one removed, one copied and its title changed: each block is the file\'s own text', () => {
  const { tag, text } = listOf(PAGE);
  const [a, b, c] = reader(tag)(text).map(x => x.html);
  // the third first, then the first, then a copy of the first with a new title; the second is gone
  const now = c + a + a.replace('Real fermentation', 'Slow fermentation');
  const written = publish(PAGE, now);
  const got = listOf(written).text;
  const blocks = [...text.matchAll(/<article[\s\S]*?<\/article>/g)].map(m => m[0]);
  assert.equal(got.trim().replace(/<!--.*?-->\s*/, ''), [blocks[2], blocks[0], blocks[0].replace('Real fermentation', 'Slow fermentation')].join('\n        '));
  assert.equal((got.match(/<svg/g) || []).length, 3, 'every block kept its drawing, the copy too');
  assert.ok(!got.includes('<iframe'), 'the block that was removed is gone, with its embed');
  assert.ok(got.includes('<!-- the first card -->'), 'a comment in the list stays');
  assert.equal(checkDocumentWrite(PAGE, written), null);
});

test('a script changed words on the page that the owner never touched: the file keeps its own', () => {
  const { tag, text } = listOf(PAGE);
  // the page, as it was when editing began: a script had already rewritten the first card's paragraph
  const base = staged(tag, text).replace('Six weeks in the crock — never less.', 'Six weeks in the crock, counted by a script.');
  const now = base.replace('Stubbornly local', 'Proudly local');
  assert.equal(publish(PAGE, now, { base }), PAGE.replace('Stubbornly local', 'Proudly local'));
});

test('a field inside a field: the inner one changes and the outer one\'s own markup stays', () => {
  const page = `<ul data-cms-repeat="rows">
  <li data-cms="row"><svg viewBox="0 0 1 1"><path d="M0 0"/></svg> <span data-cms="name">Ada</span> works here</li>
  <li data-cms="row"><svg viewBox="0 0 1 1"><path d="M1 1"/></svg> <span data-cms="name">Grace</span> works here</li>
</ul>`;
  const f = indexHtml(page).fields.get('rows');
  const text = page.slice(f.inner.start, f.inner.end);
  const res = listAsFile({ tag: 'ul', text, now: staged('ul', text).replace('Grace', 'Hedy'), base: staged('ul', text), read: reader('ul') });
  assert.equal(res.html, text.replace('Grace', 'Hedy'));
  // the outer field's own words change: its inside is written as cleaned, which is what the page shows after such an edit
  const outer = listAsFile({ tag: 'ul', text, now: staged('ul', text).replace('Ada</span> works here', 'Ada</span> worked here'), base: staged('ul', text), read: reader('ul') });
  assert.equal(outer.ok, true);
  assert.ok(outer.html.includes('<li data-cms="row"> <span data-cms="name">Ada</span> worked here</li>'));
  assert.ok(outer.html.includes('<path d="M1 1"/></svg> <span data-cms="name">Grace</span> works here'), 'the other row is untouched');
});

test('rows of a table are blocks too', () => {
  const text = `
      <tr class="row" hx-get="/a"><td data-cms="day">Mon</td><td data-cms="what">Kraut</td></tr>
      <tr class="row" hx-get="/b"><td data-cms="day">Tue</td><td data-cms="what">Kimchi</td></tr>
    `;
  const now = staged('tbody', text).replace('Kimchi', 'Pickles');
  assert.ok(!now.includes('hx-get'));
  const res = listAsFile({ tag: 'tbody', text, now, base: staged('tbody', text), read: reader('tbody') });
  assert.equal(res.html, text.replace('Kimchi', 'Pickles'));
});

test('a block the page made, which is in no file: written as cleaned when nothing is lost, refused when something would be', () => {
  const { tag, text } = listOf(PAGE);
  const fresh = '<article class="feature"><h3 data-cms="feature_title">New</h3></article>';
  const ok = listAsFile({ tag, text, now: staged(tag, text) + fresh, base: staged(tag, text), read: reader(tag) });
  assert.equal(ok.ok, true);
  assert.ok(ok.html.includes(fresh) && (ok.html.match(/<svg/g) || []).length === 3);
  // the same block, where the page shows a drawing in it that the cleaner would take out
  const no = listAsFile({ tag, text, now: staged(tag, text) + fresh, base: staged(tag, text), lost: [3], read: reader(tag) });
  assert.deepEqual(no, { ok: false, block: 3 });
});

test('a changed block whose places cannot be found in the file is refused, not written without its drawing', () => {
  // the file's block has a field on a <button>, which the cleaner does not keep: the fields no longer line up
  const text = '<div class="card"><svg viewBox="0 0 1 1"></svg><button data-cms="cta">Buy</button><p data-cms="blurb">Good</p></div>';
  const base = staged('div', text);
  const res = listAsFile({ tag: 'div', text, now: base.replace('Good', 'Better'), base, read: reader('div') });
  assert.equal(res.ok, false);
  // left alone, it is written as the file has it
  assert.deepEqual(listAsFile({ tag: 'div', text, now: base, base, read: reader('div') }), { ok: true, html: text });
});

test('what the editor says when it will not publish a list is a plain sentence', () => {
  const said = LIST_NOT_WHOLE('Features Items');
  assert.match(said, /^Nothing was published\./);
  assert.ok(!said.includes('—') && said.includes('“Features Items”'));
});
