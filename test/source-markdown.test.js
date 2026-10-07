// Formatted text on a site Astro builds: the page edited with the toolbar,
// the file written back as Markdown, changed only where the page was.
// The pages are what Astro 7.3.6 built from test/fixtures/astro-formatted/src.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { page } from './tiny-dom.js';
import * as md from '../src/adapters/markdown.js';
import { prepare, plan, readPage, bodyOf, prepSentence, planSentence, keepSentence, KEEP_ATTR } from '../src/editor/source-rich.js';
import astro from '../src/adapters/astro.js';
import { lockReason, parseSourceCapabilities } from '../src/editor/source-fields.js';
import { parseSourceRef } from '../src/adapters/pointer.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'astro-formatted');
const file = (name) => readFileSync(path.join(FIX, 'src', 'content', 'posts', name), 'utf8');
/** The element the page's body was rendered into, as the editor finds it. */
function built(id) {
  const html = readFileSync(path.join(FIX, 'built', `${id}.html`), 'utf8');
  const inner = /<div class="post-body"[^>]*>([\s\S]*)<\/div>\s*<\/body>/.exec(html)[1];
  return page(`<div>${inner}</div>`);
}
const elements = (el) => el.childNodes.filter(n => n.nodeType === 1);
const textNodes = (el, out = []) => { for (const c of el.childNodes) { if (c.nodeType === 3) out.push(c); else if (c.childNodes) textNodes(c, out); } return out; };
/** Type into the page: replace words in the text node that has them. */
function type(el, from, to) {
  const t = textNodes(el).find(n => n.data.includes(from));
  assert.ok(t, `no text "${from}" on the page`);
  t.data = t.data.replace(from, to);
}
function insert(parent, at, html) {
  const n = page(html);
  n.parentNode = parent;
  parent.childNodes.splice(at, 0, n);
  return n;
}
/** Lines that differ between two texts, for asserting how little changed. */
function changedLines(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  return { removed: x.filter(l => !y.includes(l)), added: y.filter(l => !x.includes(l)) };
}
/** Edit the page, plan, and write the result into the file through the adapter. */
function publish(fileName, el, prep) {
  const r = plan(el, prep);
  assert.ok(r.text, `planned: ${JSON.stringify(r)}`);
  const src = file(fileName);
  const out = astro.applyEdits(src, [{ pointer: '/body', value: r.text, key: 'b' }], `src/content/posts/${fileName}`);
  assert.deepEqual(out.applied, ['b'], JSON.stringify(out.skipped));
  assert.equal(astro.validate(out.content, fileName), null);
  return { src, out: out.content, body: r.text };
}

const SPRING = file('spring-fair.md');
const springBody = bodyOf(SPRING).body;

test('markdown blocks: every top-level block of a real entry, in order, and an MDX one', () => {
  assert.deepEqual(md.markdownBlocks(springBody).map(b => b.kind + (b.level || '')),
    ['paragraph', 'heading2', 'paragraph', 'list', 'blockquote', 'table', 'code', 'paragraph', 'comment', 'paragraph', 'linkdef']);
  const mdx = bodyOf(file('with-parts.mdx')).body;
  assert.deepEqual(md.markdownBlocks(mdx, { mdx: true }).map(b => b.kind), ['esm', 'esm', 'paragraph', 'jsx', 'paragraph', 'paragraph']);
  // Nested lists and a quote with a list inside are one block each, read item by item.
  const list = md.markdownBlocks(springBody).find(b => b.kind === 'list');
  assert.deepEqual(md.listItems(springBody.slice(list.start, list.end)), ['Stalls\n1. Plants\n2. Books, *second hand*', 'Music\n- The brass band at noon', 'Food']);
});

test('editing nothing leaves the file byte for byte as it was', () => {
  for (const [name, id, mdx] of [['spring-fair.md', 'spring-fair'], ['autumn.md', 'autumn'], ['with-parts.mdx', 'with-parts', true]]) {
    const el = built(id);
    const r = prepare(el, bodyOf(file(name)).body, { mdx });
    assert.equal(r.ok, true, `${name}: ${r.why}`);
    assert.deepEqual(plan(el, r.prep), { unchanged: true }, name);
    // The plan over an unchanged page is the file itself.
    assert.equal(md.planBody({ text: r.prep.text, source: r.prep.source, before: r.prep.before, after: r.prep.before, kept: r.prep.kept, opts: r.prep.opts }).text, r.prep.text);
  }
});

test('a changed word in a wrapped paragraph rewrites that word and nothing else', () => {
  const el = built('spring-fair');
  const { prep } = prepare(el, springBody);
  type(el, 'ten until four', 'ten until five');
  const { src, out } = publish('spring-fair.md', el, prep);
  assert.deepEqual(changedLines(src, out), {
    removed: ['The **spring fair** is on the green, from ten until four. Entry is'],
    added: ['The **spring fair** is on the green, from ten until five. Entry is'],
  });
  // The line break inside the paragraph, the front matter and its comments are untouched.
  assert.ok(out.startsWith('---\n# The fair page.'));
  assert.equal(out.length, src.length);
});

test('bold, italic and a removed mark: the file keeps its own marks around everything else', () => {
  const el = built('spring-fair');
  const { prep } = prepare(el, springBody);
  // Bold "green" (the toolbar's Bold leaves a <b>) and take the bold off "spring fair".
  elements(el)[0].innerHTML = 'The spring fair is on the <b>green</b>, from ten until four. Entry is\nfree; bring a bag for the <em>plant stall</em>.';
  const { src, out } = publish('spring-fair.md', el, prep);
  const diff = changedLines(src, out);
  assert.deepEqual(diff.added, ['The spring fair is on the **green**, from ten until four. Entry is']);
  assert.ok(out.includes('free; bring a bag for the _plant stall_.'), 'the next line keeps its underscores');
});

test('a link in a heading: its words change, the link stays where it pointed', () => {
  const el = built('spring-fair');
  const { prep } = prepare(el, springBody);
  type(el, 'Getting there', 'How to get there');
  type(el, 'the map', 'our map');
  const { src, out } = publish('spring-fair.md', el, prep);
  assert.deepEqual(changedLines(src, out).added, ['## How to get there, with [our map](https://example.com/map)']);
});

test('hard breaks of both kinds survive an edit to the same paragraph', () => {
  const el = built('spring-fair');
  const { prep } = prepare(el, springBody);
  type(el, 'Walk past the hall', 'Walk past the old hall');
  const { out } = publish('spring-fair.md', el, prep);
  assert.ok(out.includes('Take the 12 bus to the church.  \nWalk past the old hall\\\nand the fair is on your left.'), out);
});

test('nested lists: an item added deep inside, in the list\'s own numbering and indent', () => {
  const el = built('spring-fair');
  const { prep } = prepare(el, springBody);
  const ul = elements(el).find(n => n.tagName === 'UL');
  const ol = elements(elements(ul)[0]).find(n => n.tagName === 'OL');
  insert(ol, ol.childNodes.length, '<li>Cakes</li>');
  type(el, 'The brass band at noon', 'The brass band at one');
  const { src, out } = publish('spring-fair.md', el, prep);
  assert.ok(out.includes('  1. Plants\n  2. Books, *second hand*\n  3. Cakes\n- Music\n  - The brass band at one\n- Food'), out);
  assert.deepEqual(changedLines(src, out).removed, ['  - The brass band at noon']);
});

test('a new paragraph, a paragraph made a heading, and one removed: blank lines as Markdown wants them', () => {
  const el = built('spring-fair');
  const { prep } = prepare(el, springBody);
  const blocks = elements(el);
  // After the heading, a new paragraph.
  insert(el, el.childNodes.indexOf(blocks[1]) + 1, '<p>Parking is at the school.</p>');
  // The last paragraph becomes a heading.
  const last = blocks[blocks.length - 1];
  const h3 = page('<h3>x</h3>');
  h3.childNodes = last.childNodes; h3.childNodes.forEach(c => { c.parentNode = h3; });
  h3.parentNode = el;
  el.childNodes.splice(el.childNodes.indexOf(last), 1, h3);
  // The quote goes.
  el.childNodes.splice(el.childNodes.indexOf(blocks.find(n => n.tagName === 'BLOCKQUOTE')), 1);
  const { out } = publish('spring-fair.md', el, prep);
  assert.ok(out.includes('## Getting there, with [the map](https://example.com/map)\n\nParking is at the school.\n\nTake the 12 bus'), out);
  assert.ok(out.includes('### Questions? Write to [the committee][c].\n\n[c]: mailto:fair@example.org\n'), out);
  assert.ok(!out.includes('Last year we raised'));
  assert.ok(out.includes('- Food\n\n| Time  | What        |'), 'the list is followed by the table with one blank line');
});

test('a table is read-only, says why, and is written back exactly as it was', () => {
  const el = built('spring-fair');
  const { prep } = prepare(el, springBody);
  const table = elements(el).find(n => n.tagName === 'TABLE');
  assert.match(table.getAttribute(KEEP_ATTR), /^b\d+$/);
  assert.equal(table.getAttribute('contenteditable'), 'false');
  assert.match(keepSentence(table), /table/i);
  assert.match(keepSentence(elements(el).find(n => n.tagName === 'PRE')), /code/i);
  type(el, 'Food', 'Food and drink');
  const { out } = publish('spring-fair.md', el, prep);
  assert.ok(out.includes('| Time  | What        |\n| ----- | ----------- |\n| 10:00 | Doors open  |\n| 12:00 | Brass band  |'));
  // Taking a kept part away is not written: it is said, and Revert puts it back.
  const el2 = built('spring-fair');
  const r2 = prepare(el2, springBody);
  el2.childNodes.splice(el2.childNodes.indexOf(elements(el2).find(n => n.tagName === 'TABLE')), 1);
  assert.deepEqual(plan(el2, r2.prep), { error: 'kept-moved' });
  assert.match(planSentence('kept-moved'), /Revert/);
});

test('a picture shown at another address goes back as the file wrote it', () => {
  const el = built('spring-fair');
  const img = (function find(n) { for (const c of n.childNodes || []) { if (c.tagName === 'IMG') return c; const f = find(c); if (f) return f; } return null; })(el);
  img.setAttribute('src', '/_astro/hall.Bx12.webp');   // what Astro's image service writes
  const { prep } = prepare(el, springBody);
  const p = img.parentNode;
  insert(p, p.childNodes.length, '<span>x</span>').childNodes[0].data = ' From the green.';
  const { out } = publish('spring-fair.md', el, prep);
  assert.ok(out.includes('![The hall from the green](/img/hall.png) From the green.'), out);
  assert.ok(!out.includes('_astro'));
});

test('front matter in YAML: a title edit keeps the comments, the quoting and the folded summary', () => {
  const out = astro.applyEdits(SPRING, [{ pointer: '/frontmatter/title', value: 'Spring fete', key: 't' }], 'spring-fair.md');
  assert.deepEqual(changedLines(SPRING, out.content), { removed: ['title: "Spring fair"   # shown in the menu too'], added: ['title: "Spring fete"   # shown in the menu too'] });
});

test('front matter in TOML: read and written with its comments; a broken one is never written', () => {
  const AUTUMN = file('autumn.md');
  const parsed = astro.parse(AUTUMN, 'autumn.md');
  assert.equal(parsed.format, 'toml');
  assert.equal(astro.read(parsed, '/frontmatter/title'), 'Autumn walk');
  assert.equal(astro.read(parsed, '/frontmatter/draft'), false);
  const out = astro.applyEdits(AUTUMN, [
    { pointer: '/frontmatter/title', value: 'Autumn "long" walk', key: 't' },
    { pointer: '/frontmatter/summary', value: "Leaves, a picnic, and tea.", key: 's' },
    { pointer: '/frontmatter/draft', value: true, type: 'boolean', key: 'd' },
  ], 'autumn.md');
  assert.deepEqual(out.applied, ['t', 's', 'd']);
  assert.ok(out.content.startsWith('+++\n# TOML front matter, with comments\ntitle = "Autumn \\"long\\" walk" # the heading\nsummary = \'Leaves, a picnic, and tea.\'\ndraft = true\n+++\n'), out.content);
  assert.equal(astro.validate(out.content, 'autumn.md'), null);
  const broken = '+++\ntitle = "unclosed\n+++\nBody.\n';
  const r = astro.applyEdits(broken, [{ pointer: '/frontmatter/title', value: 'x', key: 't' }], 'e.md');
  assert.deepEqual(r.applied, []);
  assert.match(r.skipped[0].reason, /not valid TOML/);
  assert.match(astro.validate(broken, 'e.md'), /not valid TOML/);
});

test('typeset quotes, dashes and dots on the page still match the file, which keeps its own', () => {
  const el = built('autumn');
  const r = prepare(el, bodyOf(file('autumn.md')).body);
  assert.equal(r.ok, true, r.why);
  type(el, 'Ask Sam’s dog.', 'Ask Sam’s dog first.');
  const { out } = publish('autumn.md', el, r.prep);
  assert.ok(out.includes('It\'s "the" best walk -- really... Ask Sam\'s dog first.\n'), out);
});

test('MDX: prose is edited, components and expressions are kept read-only and written exactly', () => {
  const MDX = file('with-parts.mdx');
  const el = built('with-parts');
  const r = prepare(el, bodyOf(MDX).body, { mdx: true });
  assert.equal(r.ok, true, r.why);
  const [year, callout, badge, plain] = elements(el);
  for (const kept of [year, callout, badge]) assert.match(kept.getAttribute(KEEP_ATTR) || '', /^b\d+$/, kept.tagName);
  assert.equal(plain.getAttribute(KEEP_ATTR), null);
  type(el, 'Plain prose after the parts', 'Plain words after the parts');
  const { src, out } = publish('with-parts.mdx', el, r.prep);
  assert.deepEqual(changedLines(src, out), { removed: ['Plain prose after the parts, with a [link](/about).'], added: ['Plain words after the parts, with a [link](/about).'] });
  assert.match(keepSentence(callout), /component|as it is/i);
});

test('a page that no longer says what the file says is not edited: someone changed it since it was built', () => {
  const el = built('spring-fair');
  const r = prepare(el, springBody.replace('ten until four', 'nine until four'));
  assert.deepEqual([r.ok, r.why], [false, 'changed']);
  assert.match(prepSentence('changed'), /changed on the site after this page was made/);
});

test('a Markdown field rendered inside one element (?type=markdown) is edited the same way', () => {
  const el = page('<p class="summary">A day of <strong>stalls</strong>, music and food.</p>');
  const text = 'A day of **stalls**, music\nand food.\n';
  const r = prepare(el, text);
  assert.equal(r.ok, true, r.why);
  type(el, 'music and', 'brass music and');
  assert.deepEqual(plan(el, r.prep), { text: 'A day of **stalls**, brass music\nand food.\n' });
  // The field is then written into the front matter as the block it was.
  const file = '---\ntitle: Fair\nsummary: |\n  A day of **stalls**, music\n  and food.\n---\n\nBody.\n';
  const out = astro.applyEdits(file, [{ pointer: '/frontmatter/summary', type: 'markdown', value: 'A day of **stalls**, brass music\nand food.\n', key: 's' }], 'fair.md');
  assert.equal(out.content, file.replace('**stalls**, music', '**stalls**, brass music'));
});

test('which texts are offered with the toolbar: only where the worker takes Markdown back', () => {
  const caps = parseSourceCapabilities({ ok: true, modes: ['html', 'source'], adapters: ['astro'], sourceMarkdown: true });
  const old = parseSourceCapabilities({ ok: true, modes: ['html', 'source'], adapters: ['astro'] });
  assert.equal(caps.markdown, true);
  assert.equal(old.markdown, false);
  const body = parseSourceRef('src/content/posts/a.md#/body');
  const mdxBody = parseSourceRef('src/content/posts/a.mdx#/body');
  const field = parseSourceRef('src/content/posts/a.md#/frontmatter/summary?type=markdown');
  // A worker that takes Markdown back: a formatted body, an MDX body and a formatted Markdown field are open.
  for (const parsed of [body, mdxBody, field]) assert.equal(lockReason({ parsed, caps, plain: false, rich: true }), null, parsed.path);
  // An older worker: each stays read-only, with the sentence it always had.
  assert.match(lockReason({ parsed: body, caps: old, plain: false }), /has formatting/);
  assert.match(lockReason({ parsed: mdxBody, caps: old, plain: true }), /written as code/);
  assert.match(lockReason({ parsed: field, caps: old, plain: false }), /has formatting/);
  // …but a plain one is edited as words, as before.
  assert.equal(lockReason({ parsed: field, caps: old, plain: true }), null);
});
