// Pictures and link addresses in content files: where a new picture goes,
// what the field then says, and what the site's own schema takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { picturePlace, pictureValue, pictureFileName } from '../src/adapters/pictures.js';

const POST = 'src/content/posts/spring-fair.md';

test('pictures: a path from the entry is a file beside it, written back in the same style', () => {
  const dot = picturePlace(POST, './images/green.png');
  assert.deepEqual(dot, { kind: 'relative', path: 'src/content/posts/images/green.png', folder: 'src/content/posts/images', style: 'dot' });
  assert.equal(pictureValue(POST, dot, 'src/content/posts/images/hall-k2.webp'), './images/hall-k2.webp');

  const up = picturePlace(POST, '../../assets/posts/green.jpg');
  assert.equal(up.path, 'src/assets/posts/green.jpg');
  assert.equal(up.folder, 'src/assets/posts');
  assert.equal(pictureValue(POST, up, 'src/assets/posts/hall-k2.webp'), '../../assets/posts/hall-k2.webp');

  const bare = picturePlace(POST, 'images/green.png');
  assert.equal(bare.path, 'src/content/posts/images/green.png');
  assert.equal(pictureValue(POST, bare, 'src/content/posts/images/a b.webp'), 'images/a%20b.webp');
});

test('pictures: an address from the site root is a file under public/', () => {
  const pub = picturePlace(POST, '/img/hall.png');
  assert.deepEqual(pub, { kind: 'public', path: 'public/img/hall.png', folder: 'public/img', style: 'root' });
  assert.equal(pictureValue(POST, pub, 'public/img/new-k2.webp'), '/img/new-k2.webp');
  assert.equal(picturePlace(POST, '/hall.png').folder, 'public');
  assert.equal(picturePlace(POST, '/img/a%20b.png').path, 'public/img/a b.png');
});

test('pictures: what has no folder to follow says why', () => {
  assert.deepEqual(picturePlace(POST, ''), { why: 'empty' });
  assert.deepEqual(picturePlace(POST, 'https://cdn.example.com/a.png'), { why: 'remote' });
  assert.deepEqual(picturePlace(POST, '//cdn.example.com/a.png'), { why: 'remote' });
  assert.deepEqual(picturePlace(POST, '~/assets/a.png'), { why: 'alias' });
  assert.deepEqual(picturePlace(POST, '@images/a.png'), { why: 'alias' });
  assert.deepEqual(picturePlace(POST, '../../../../../etc/a.png'), { why: 'outside' });
  assert.deepEqual(picturePlace(POST, '/../src/a.png'), { why: 'outside' });
  assert.deepEqual(picturePlace(POST, './a.png?raw'), { why: 'outside' });
  assert.deepEqual(picturePlace(POST, './notes.pdf'), { why: 'not-picture' });
});

test('pictures: an upload is named from its own name and never takes an existing file name', () => {
  assert.equal(pictureFileName('IMG_2041.HEIC', 'jpg', 'k2x9'), 'img-2041-k2x9.jpg');
  assert.equal(pictureFileName('Fête du village.png', 'webp', 'a1'), 'fete-du-village-a1.webp');
  assert.equal(pictureFileName('', 'png', 'a1'), 'picture-a1.png');
  assert.equal(pictureFileName('....', 'png', 'a1'), 'picture-a1.png');
  assert.ok(pictureFileName('x'.repeat(200), 'png', 'a1').length < 50);
});

// ─── The site's schema ────────────────────────────────────────────────────────

import { readSchemaDoc, fieldSchema, valueProblem, problemSentence } from '../src/editor/source-schema.js';
import { readFileSync } from 'node:fs';

// What Astro 7 wrote for the fixture's collection (.astro/collections/posts.schema.json), as the integration publishes it.
const SCHEMA = JSON.parse(readFileSync(new URL('./fixtures/astro-media/built/kiln-schema.json', import.meta.url), 'utf8'));

test('schema: a field is found under its collection, with whether the site requires it', () => {
  assert.ok(readSchemaDoc(SCHEMA));
  assert.equal(readSchemaDoc({ version: 2, collections: {} }), null);
  assert.equal(readSchemaDoc(null), null);
  assert.deepEqual(fieldSchema(SCHEMA, 'posts', ['title']), { node: { type: 'string', maxLength: 80 }, required: true });
  assert.equal(fieldSchema(SCHEMA, 'posts', ['coverAlt']).required, false);
  assert.equal(fieldSchema(SCHEMA, 'posts', ['cta', 'href']).node.format, 'uri');
  assert.equal(fieldSchema(SCHEMA, 'posts', ['cta', 'href']).required, true);
  assert.equal(fieldSchema(SCHEMA, 'posts', ['nope']), null);
  assert.equal(fieldSchema(SCHEMA, 'pages', ['title']), null);
  assert.equal(fieldSchema(SCHEMA, '__proto__', ['title']), null);
  assert.equal(fieldSchema(SCHEMA, 'posts', ['tags', '0']).node.type, 'string');
  // .nullable() is a union with null: the other branch is the field
  assert.deepEqual(fieldSchema({ version: 1, collections: { a: { type: 'object', properties: { x: { anyOf: [{ type: 'string', maxLength: 3 }, { type: 'null' }] } } } } }, 'a', ['x']).node, { type: 'string', maxLength: 3 });
});

test('schema: a value the build would turn away is named before it is kept', () => {
  const at = (...segs) => fieldSchema(SCHEMA, 'posts', segs);
  assert.equal(valueProblem(at('title'), 'Spring fair'), null);
  assert.deepEqual(valueProblem(at('title'), ''), { code: 'required' });
  assert.deepEqual(valueProblem(at('title'), 'x'.repeat(81)), { code: 'too-long', n: 80 });
  assert.equal(valueProblem(at('title'), 'é'.repeat(80)), null);
  assert.equal(valueProblem(at('coverAlt'), ''), null);
  assert.deepEqual(valueProblem(at('website'), '/about'), { code: 'full-address' });
  assert.equal(valueProblem(at('website'), 'https://example.com/a'), null);
  assert.equal(valueProblem(at('website'), ''), null);   // not required: it may be left empty
  assert.deepEqual(valueProblem(at('cta', 'href'), ''), { code: 'required' });
  assert.deepEqual(valueProblem(at('kind'), 'blog'), { code: 'not-in-list', list: ['news', 'event'] });
  assert.equal(valueProblem(at('kind'), 'event'), null);
  assert.equal(valueProblem(null, ''), null);   // no schema: nothing is guessed
  for (const code of ['required', 'too-long', 'too-short', 'full-address', 'email', 'not-in-list', 'pattern']) {
    const s = problemSentence({ code, n: 3, list: ['a', 'b'] });
    assert.match(s, /^[A-Z].*\.$/);
    assert.equal(/[!—–]| - /.test(s), false, s);
  }
});

// ─── What the editor says and decides ────────────────────────────────────────

import { pictureTarget, placeSentence, inlinePicture, pictureName } from '../src/editor/source-media.js';
import { lockReason, parseSourceCapabilities, skipSentence } from '../src/editor/source-fields.js';
import { parseSourceRef } from '../src/adapters/pointer.js';

test('a new picture\'s folder, or why there is none: before anyone picks a file', () => {
  assert.deepEqual(pictureTarget({ file: POST, value: './images/green.png' }).place.folder, 'src/content/posts/images');
  assert.equal(pictureTarget({ file: POST, value: '/img/hall.png', paths: ['public/img'] }).place.folder, 'public/img');
  const scope = pictureTarget({ file: POST, value: '/img/hall.png', paths: ['src/content/posts'] });
  assert.equal(scope.why, 'scope');
  assert.match(scope.sentence, /public\/img, a folder you were not given/);
  // the schema wants a full web address: an uploaded picture can't be one
  const uri = pictureTarget({ file: POST, value: '/img/hall.png', field: fieldSchema(SCHEMA, 'posts', ['website']) });
  assert.equal(uri.why, 'full-address');
  assert.equal(pictureTarget({ file: POST, value: '', field: null }).why, 'empty');
  assert.equal(pictureTarget({ file: POST, value: 'https://cdn.example.com/a.png' }).why, 'remote');
  for (const why of ['empty', 'remote', 'alias', 'scope', 'full-address', 'outside']) {
    const s = placeSentence(why, 'public/img');
    assert.match(s, /^[A-Z].*\.$/);
    assert.equal(/[!—–]| - /.test(s), false, s);
    assert.match(s, /Ask the site’s owner/);
  }
});

test('a picture in Markdown is read as the file wrote it, a reference one too', () => {
  assert.deepEqual(inlinePicture('![Stalls on the green](./images/green.png "The green at noon")'), { alt: 'Stalls on the green', url: './images/green.png', title: 'The green at noon' });
  assert.deepEqual(inlinePicture('![The hall](/img/hall.png)'), { alt: 'The hall', url: '/img/hall.png', title: '' });
  assert.deepEqual(inlinePicture('![The hall][h]', { h: { url: '/img/hall.png', title: '' } }), { alt: 'The hall', url: '/img/hall.png', title: '' });
  assert.equal(inlinePicture('not a picture'), null);
  assert.equal(pictureName('./images/fete-du-village-a1.webp'), 'fete-du-village-a1.webp');
  assert.equal(pictureName('/img/a%20b.png'), 'a b.png');
});

test('pictures and link addresses are offered only where the worker takes them back', () => {
  const caps = parseSourceCapabilities({ ok: true, modes: ['html', 'source'], adapters: ['astro'], sourceMarkdown: true, sourceMedia: true });
  const old = parseSourceCapabilities({ ok: true, modes: ['html', 'source'], adapters: ['astro'], sourceMarkdown: true });
  assert.equal(caps.media, true);
  assert.equal(old.media, false);
  const cover = parseSourceRef(`${POST}#/frontmatter/cover?type=image&c=posts`);
  const site = parseSourceRef(`${POST}#/frontmatter/website?type=url&c=posts`);
  assert.equal(cover.collection, 'posts');
  assert.equal(lockReason({ parsed: cover, tag: 'IMG', caps, media: true }), null);
  assert.equal(lockReason({ parsed: site, tag: 'A', caps, media: true }), null);
  assert.match(lockReason({ parsed: cover, tag: 'IMG', caps: old, media: false }), /Pictures that come from the site’s content can’t be changed here yet/);
  assert.match(lockReason({ parsed: site, tag: 'A', caps: old, media: false }), /link’s address/);
  // a picture field shown as words, or words put on a picture, stay as they were
  assert.match(lockReason({ parsed: parseSourceRef(`${POST}#/frontmatter/title`), tag: 'IMG', caps, media: true }), /Pictures/);
});

test('what the worker said about a picture, as a sentence', () => {
  assert.equal(skipSentence('needs to be a picture on this site'), 'This needs to be a picture kept in the site’s own files.');
  assert.equal(skipSentence('picture not found: public/img/x.webp'), 'The picture it points to is not in the site’s files. Choose or upload the picture again, then publish.');
});

// ─── Pictures and links inside the Markdown text ─────────────────────────────

import { page } from './tiny-dom.js';
import { prepare, plan, bodyOf, KEEP_ATTR } from '../src/editor/source-rich.js';
import astro from '../src/adapters/astro.js';

const MEDIA = new URL('./fixtures/astro-media/', import.meta.url);
const FAIR = readFileSync(new URL('src/content/posts/spring-fair.md', MEDIA), 'utf8');
const FAIR_BODY = bodyOf(FAIR).body;
function mediaBody() {
  const html = readFileSync(new URL('built/spring-fair.html', MEDIA), 'utf8');
  return page(`<div>${/<div class="post-body"[^>]*>([\s\S]*)<\/div><\/body>/.exec(html)[1]}</div>`);
}
const all = (n, out = []) => { for (const c of n.childNodes || []) { if (c.nodeType === 1) { out.push(c); all(c, out); } } return out; };
const lineDiff = (a, b) => { const x = a.split('\n'), y = b.split('\n'); return { removed: x.filter(l => !y.includes(l)), added: y.filter(l => !x.includes(l)) }; };

test('a picture in the text, replaced: only its line changes, its title stays, and the file still builds', () => {
  const el = mediaBody();
  const r = prepare(el, FAIR_BODY);
  assert.ok(r.ok, JSON.stringify(r));
  const imgs = all(el).filter(n => n.tagName === 'IMG');
  assert.equal(imgs.length, 2);
  assert.deepEqual(imgs.map(i => i.getAttribute(KEEP_ATTR)), ['0', '1']);
  // what the editor does when a new picture is chosen for the second one
  const stalls = imgs[1];
  const was = inlinePicture(r.prep.kept[1]);
  assert.deepEqual(was, { alt: 'Stalls on the green', url: './images/green.png', title: 'The green at noon' });
  stalls.removeAttribute(KEEP_ATTR);
  stalls.setAttribute('src', 'blob:https://site.example/1');
  stalls.setAttribute('data-kiln-md-src', './images/stalls-a1.webp');
  stalls.setAttribute('alt', 'Stalls at noon');
  const p = plan(el, r.prep);
  assert.ok(p.text, JSON.stringify(p));
  assert.deepEqual(lineDiff(FAIR_BODY, p.text), {
    removed: ['![Stalls on the green](./images/green.png "The green at noon")'],
    added: ['![Stalls at noon](./images/stalls-a1.webp "The green at noon")'],
  });
  const out = astro.applyEdits(FAIR, [{ pointer: '/body', value: p.text, key: 'b' }], 'src/content/posts/spring-fair.md');
  assert.deepEqual(out.applied, ['b']);
  assert.equal(astro.validate(out.content, 'spring-fair.md'), null);
});

test('a link\'s address and words in the text: only that link changes', () => {
  const el = mediaBody();
  const r = prepare(el, FAIR_BODY);
  assert.ok(r.ok);
  const map = all(el).find(n => n.tagName === 'A' && n.textContent === 'the map');
  map.setAttribute('href', 'https://example.com/fair-map');
  map.childNodes[0].data = 'the fair map';
  const p = plan(el, r.prep);
  assert.ok(p.text, JSON.stringify(p));
  assert.deepEqual(lineDiff(FAIR_BODY, p.text), {
    removed: ['The fair is on the green, from ten until four. See [the map](https://example.com/map)'],
    added: ['The fair is on the green, from ten until four. See [the fair map](https://example.com/fair-map)'],
  });
  // a reference link keeps its definition when only its words change
  const el2 = mediaBody();
  const r2 = prepare(el2, FAIR_BODY);
  const c = all(el2).find(n => n.tagName === 'A' && n.textContent === 'the committee');
  c.childNodes[0].data = 'our committee';
  const p2 = plan(el2, r2.prep);
  assert.deepEqual(lineDiff(FAIR_BODY, p2.text), { removed: ['or write to [the committee][c].'], added: ['or write to [our committee][c].'] });
});

test('a field named for markup is called by what it is', async () => {
  const { sourceLabel } = await import('../src/editor/source-fields.js');
  assert.equal(sourceLabel(parseSourceRef(`${POST}#/frontmatter/coverAlt`)), 'Cover description · Spring fair');
  assert.equal(sourceLabel(parseSourceRef(`${POST}#/frontmatter/cta/href`)), 'Button link · Spring fair');
  assert.equal(sourceLabel(parseSourceRef(`${POST}#/frontmatter/alt`)), 'Description · Spring fair');
  assert.equal(sourceLabel(parseSourceRef(`${POST}#/frontmatter/title`)), 'Title · Spring fair');
});

// ─── Saved in this browser, brought back after a reload ──────────────────────

import { readDraft, draftRecord } from '../src/editor/saved-edits.js';
import { filesToRestore } from '../src/editor/pending-files.js';

test('a saved formatted text comes back as Markdown, and a picture field with its upload', () => {
  const body = `${POST}#/body`;
  const cover = `${POST}#/frontmatter/cover?type=image&c=posts`;
  const pending = new Map();
  const source = new Map([
    [body, { value: 'The **green**.\n', md: true, html: '<p>The <strong>green</strong>.</p>', words: 'The green.' }],
    [cover, { value: './images/a-k2.webp', type: 'image', display: 'blob:https://site.example/1', upload: 'src/content/posts/images/a-k2.webp' }],
  ]);
  const saved = JSON.parse(JSON.stringify(draftRecord(pending, source)));
  const back = readDraft(saved);
  assert.deepEqual(back.source[body], { value: 'The **green**.\n', md: true, html: '<p>The <strong>green</strong>.</p>', words: 'The green.' });
  // The address the picture was shown from is gone with the page; the file is kept beside the draft.
  assert.deepEqual(back.source[cover], { value: './images/a-k2.webp', type: 'image', upload: 'src/content/posts/images/a-k2.webp' });
  // Whatever a stored copy holds, only words are taken back.
  const odd = readDraft({ ts: Date.now(), edits: {}, source: { [body]: { value: 'x', md: 'yes', html: 7, upload: '../../x' } } });
  assert.deepEqual(odd.source[body], { value: 'x' });
  // The uploads a content-file edit names come back with it.
  const files = [{ path: 'src/content/posts/images/a-k2.webp', base64: 'AA' }, { path: 'src/content/posts/images/old.webp', base64: 'AA' }];
  assert.deepEqual(filesToRestore(files, {}, back.source).map(f => f.path), ['src/content/posts/images/a-k2.webp']);
});
