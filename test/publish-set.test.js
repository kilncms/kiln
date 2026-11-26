/**
 * Publishing many pages together (src/editor/publish-set.js; the commit is
 * commitFilesOn in src/github.js).
 *
 * The tools that already write many pages (the Site menu, Find and replace, a
 * shared part) read the pages by the branch's name and then build the commit
 * on whatever the branch holds a moment later. Somebody else's publish to one
 * of those pages in between is put back to its older text, and nobody is told.
 * A set is built the other way round: everything is read at one commit, each
 * part is compared with what the person saw, the commit is made on that
 * commit, and the branch is moved without force. These tests hold it to that,
 * against a repository with a true git history (test/github-fake.js), and
 * once through the real service as an invited editor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFragment, serialize, serializeOuter, defaultTreeAdapter as T, html as H } from 'parse5';
import worker from '../worker/index.js';
import { publishSet, planSet, setRequests, setStepText, setConflictText, SET_TRIES, SET_PICTURES_MAX } from '../src/editor/publish-set.js';
import { makeGh, commitFilesOn, branchHead, isHeadMoved, HeadMoved } from '../src/github.js';
import { readValues, attrNameAllowed } from '../src/engine.js';
import { CONTAINER_SANITIZE } from '../src/editor/sanitize.js';
import { fakeGitHub } from './github-fake.js';
import { editorEnv, withFetch, REPO, SESSION, ORIGIN } from './worker-harness.js';

const page = (n, extra = '') => `<!doctype html>\n<html><head><title>Page ${n}</title></head><body>\n<h1 data-cms="title">Title ${n}</h1>\n<p data-cms="intro">Intro ${n}</p>\n<img data-cms="photo" src="/img/old.jpg" alt="">${extra}\n<footer data-cms-partial="footer"><p data-cms="footer_note">Open daily</p></footer>\n</body></html>\n`;
const pathOf = (i) => (i ? `pages/p${i}.html` : 'index.html');
const site = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [pathOf(i), page(i)]));
const B64 = (s) => Buffer.from(s).toString('base64');

/** The editor's own transport, straight to the stand-in GitHub. */
const ghFor = (fake) => makeGh({ mode: 'direct', token: () => 'T', fetchImpl: async (url, init) => (await fake.handler(url, init)) || new Response('{"message":"Not Found"}', { status: 404 }) });
const blobOf = (fake, path) => fake.trees.get(fake.commits.get(fake.head()).tree).get(path)?.sha;

/** The saved copy a page would hold now for these changes ({ key: html, or { attrs } }), as section 2.9 of the design fixes it. */
function saved(fake, path, changes, { ts = 1000, shared = [] } = {}) {
  const values = readValues(fake.read(path));
  const edits = {}, more = {};
  for (const [key, v] of Object.entries(changes)) {
    edits[key] = typeof v === 'string' ? { html: v } : v;
    more[key] = { was: values[key] ?? undefined, ...(shared.includes(key) ? { shared: true } : {}) };
  }
  return { ts, edits, more, page: { path, url: `/${path}`, title: path, sha: blobOf(fake, path) } };
}
const message = (plan) => `Publish ${plan.files.length} pages together (via Kiln)`;
const send = (fake, copies, opts = {}) => publishSet({ gh: ghFor(fake), repo: fake.repo, branch: 'main', copies, message, wait: async () => {}, ...opts });
const writes = (fake, from = 0) => fake.calls.slice(from).filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`);

test('set: thirty pages and two pictures are one commit, in N + P + 6 requests, and a picture nothing names is not sent', async () => {
  const fake = fakeGitHub({ files: { ...site(30), 'assets/site.css': 'body{}' } });
  const start = fake.head();
  const copies = Array.from({ length: 30 }, (_, i) => saved(fake, pathOf(i), { title: `New title ${i}` }));
  copies[0] = saved(fake, 'index.html', { title: 'New title 0', photo: { attrs: { src: '/uploads/sun.jpg' } } });
  copies[1] = saved(fake, pathOf(1), { title: 'New title 1', intro: 'See <img src="/uploads/moon.png" alt="The moon">' });
  const pictures = new Map([['uploads/sun.jpg', B64('sun')], ['uploads/moon.png', B64('moon')], ['uploads/orphan.jpg', B64('orphan')]]);
  const steps = [];
  const out = await send(fake, copies, { pictures, onStep: (s) => steps.push(setStepText(s)) });

  assert.equal(fake.calls.length, 30 + 2 + 6);
  assert.equal(fake.calls.length, setRequests({ pages: 30, pictures: 2 }));
  assert.deepEqual(writes(fake), ['POST /git/blobs', 'POST /git/blobs', 'POST /git/trees', 'POST /git/commits', 'PATCH /git/refs/heads/main']);
  assert.equal(fake.commits.size, 2);
  assert.equal(fake.head(), out.commit.sha);
  assert.deepEqual(fake.commits.get(fake.head()).parents, [start]);
  assert.equal(fake.commits.get(fake.head()).message, 'Publish 30 pages together (via Kiln)');
  for (let i = 0; i < 30; i++) assert.ok(fake.read(pathOf(i)).includes(`<h1 data-cms="title">New title ${i}</h1>`), pathOf(i));
  assert.ok(fake.read('index.html').includes('src="/uploads/sun.jpg"'));
  assert.equal(fake.read('uploads/sun.jpg'), 'sun');
  assert.equal(fake.read('uploads/moon.png'), 'moon');
  assert.equal(fake.read('uploads/orphan.jpg'), null);
  assert.deepEqual(out.pictures.unnamed, ['uploads/orphan.jpg']);
  assert.equal(fake.read('assets/site.css'), 'body{}');
  assert.equal(out.published.length, 30);
  assert.deepEqual(out.published[0], { path: 'index.html', keys: ['title', 'photo'] });
  assert.deepEqual([out.left, out.dropped, out.conflicts, out.blocked, out.over], [[], [], [], [], null]);
  assert.deepEqual(steps, ['Reading 30 pages…', 'Checking that nobody else changed them…', 'Saving 30 pages as one change…']);
});

test('set: somebody else\'s change to another part of the same page stands beside mine', async () => {
  const fake = fakeGitHub({ files: site(3) });
  const copies = [saved(fake, pathOf(1), { title: 'Mine' }), saved(fake, pathOf(2), { title: 'Mine too' })];
  const theirs = fake.commit({ [pathOf(1)]: page(1).replace('Intro 1', 'Their intro') });
  const out = await send(fake, copies);
  assert.equal(out.conflicts.length, 0);
  assert.deepEqual(fake.commits.get(out.commit.sha).parents, [theirs]);
  assert.ok(fake.read(pathOf(1)).includes('>Mine</h1>'));
  assert.ok(fake.read(pathOf(1)).includes('Their intro'));
});

test('set: a part somebody else changed is handed back as a conflict and nothing at all is written', async () => {
  const fake = fakeGitHub({ files: site(3) });
  const copies = [saved(fake, pathOf(1), { title: 'Mine' }), saved(fake, pathOf(2), { title: 'Mine too' })];
  const theirs = fake.commit({ [pathOf(1)]: page(1).replace('Title 1', 'Their title') });
  const out = await send(fake, copies);
  assert.equal(out.ok, false);
  assert.equal(out.commit, null);
  assert.deepEqual(out.conflicts, [{ path: pathOf(1), key: 'title', was: 'Title 1', theirs: 'Their title', mine: 'Mine', shared: false }]);
  assert.deepEqual(writes(fake), []);
  assert.equal(fake.head(), theirs);
  assert.ok(fake.read(pathOf(2)).includes('Title 2'), 'the page with no conflict was not published either');
  assert.equal(setConflictText(1), '1 of these was changed by someone else since you edited it. Nothing has been published yet.');
  assert.equal(setConflictText(2), '2 of these were changed by someone else since you edited them. Nothing has been published yet.');

  // "Keep theirs": that one edit goes, the rest is published.
  const kept = await send(fake, copies, { answers: out.conflicts.map(c => ({ ...c, pick: 'theirs' })) });
  assert.deepEqual(kept.dropped, [{ path: pathOf(1), key: 'title', reason: 'theirs' }]);
  assert.deepEqual(kept.published, [{ path: pathOf(2), keys: ['title'] }]);
  assert.ok(fake.read(pathOf(1)).includes('Their title'));
  assert.ok(fake.read(pathOf(2)).includes('Mine too'));
});

test('set: "Use mine" writes over the words the person was shown, and asks again when they have changed once more', async () => {
  const fake = fakeGitHub({ files: site(2) });
  const copies = [saved(fake, pathOf(1), { title: 'Mine' })];
  fake.commit({ [pathOf(1)]: page(1).replace('Title 1', 'Their title') });
  const first = await send(fake, copies);
  const answers = first.conflicts.map(c => ({ ...c, pick: 'mine' }));
  fake.commit({ [pathOf(1)]: page(1).replace('Title 1', 'Their second title') });
  const again = await send(fake, copies, { answers });
  assert.equal(again.commit, null);
  assert.equal(again.conflicts[0].theirs, 'Their second title');
  const done = await send(fake, copies, { answers: again.conflicts.map(c => ({ ...c, pick: 'mine' })) });
  assert.ok(done.commit);
  assert.ok(fake.read(pathOf(1)).includes('>Mine</h1>'));
});

test('set: a part or a page that is no longer there leaves that edit waiting, and the rest is published', async () => {
  const fake = fakeGitHub({ files: site(4) });
  const copies = [
    saved(fake, pathOf(1), { title: 'Mine 1', intro: 'Still here <img src="/uploads/a.jpg" alt="">' }),
    saved(fake, pathOf(2), { title: 'Mine 2 <img src="/uploads/b.jpg" alt="">' }),
    saved(fake, pathOf(3), { title: 'Mine 3' }),
  ];
  fake.commit({ [pathOf(1)]: page(1).replace('<h1 data-cms="title">Title 1</h1>', '<h1>A heading nobody can edit</h1>'), [pathOf(2)]: null });
  const pictures = [{ path: 'uploads/a.jpg', base64: B64('a') }, { path: 'uploads/b.jpg', base64: B64('b') }];
  const out = await send(fake, copies, { pictures });
  assert.deepEqual(out.left, [
    { path: pathOf(1), key: 'title', reason: 'part_gone' },
    { path: pathOf(2), key: 'title', reason: 'page_gone' },
  ]);
  assert.deepEqual(out.published, [{ path: pathOf(1), keys: ['intro'] }, { path: pathOf(3), keys: ['title'] }]);
  assert.equal(fake.commits.size, 3, 'one commit of mine on top of theirs');
  assert.ok(fake.read(pathOf(1)).includes('A heading nobody can edit'));
  assert.ok(fake.read(pathOf(1)).includes('Still here'));
  assert.equal(fake.read(pathOf(2)), null, 'a page that was removed is not put back');
  assert.ok(fake.read(pathOf(3)).includes('Mine 3'));
  // The picture of the edit still waiting waits with it.
  assert.equal(fake.read('uploads/a.jpg'), 'a');
  assert.equal(fake.read('uploads/b.jpg'), null);
  assert.deepEqual(out.pictures.kept, ['uploads/b.jpg']);
});

test('set: the branch moving while the commit is made is tried again from the new head, and the other person\'s commit is kept', async () => {
  const fake = fakeGitHub({ files: site(4) });
  const copies = [saved(fake, pathOf(1), { title: 'Mine 1', photo: { attrs: { src: '/uploads/sun.jpg' } } }), saved(fake, pathOf(2), { title: 'Mine 2' })];
  let theirs = null;
  fake.onWrite((api) => { if (!theirs) theirs = api.commit({ [pathOf(2)]: page(2).replace('Intro 2', 'Their intro'), 'new.html': page(9) }); });
  const steps = [];
  const out = await send(fake, copies, { pictures: [{ path: 'uploads/sun.jpg', base64: B64('sun') }], onStep: (s) => steps.push(setStepText(s)) });
  assert.equal(out.tries, 2);
  assert.ok(steps.includes('Somebody else published at the same moment. Checking again…'));
  assert.deepEqual(fake.commits.get(fake.head()).parents, [theirs]);
  assert.ok(fake.read(pathOf(2)).includes('Their intro'), 'their change to the page I also changed');
  assert.ok(fake.read(pathOf(2)).includes('Mine 2'));
  assert.equal(fake.read('new.html'), page(9));
  assert.ok(fake.read(pathOf(1)).includes('Mine 1'));
  assert.equal(writes(fake).filter(w => w === 'POST /git/blobs').length, 1, 'the picture was sent once');
  assert.equal(writes(fake).filter(w => w === 'PATCH /git/refs/heads/main').length, 2);
  // The second try read again only the page that had changed.
  assert.equal(fake.calls.filter(c => c.method === 'GET' && c.path === `/contents/${pathOf(1)}`).length, 1);
  assert.equal(fake.calls.filter(c => c.method === 'GET' && c.path === `/contents/${pathOf(2)}`).length, 2);
});

test('set: when the commit that moved the branch changed the same part, the second try stops and asks', async () => {
  const fake = fakeGitHub({ files: site(3) });
  const copies = [saved(fake, pathOf(1), { title: 'Mine' })];
  let theirs = null;
  fake.onWrite((api) => { if (!theirs) theirs = api.commit({ [pathOf(1)]: page(1).replace('Title 1', 'Their title') }); });
  const out = await send(fake, copies);
  assert.equal(out.commit, null);
  assert.equal(out.conflicts[0].theirs, 'Their title');
  assert.equal(fake.head(), theirs);
  assert.ok(fake.read(pathOf(1)).includes('Their title'));
});

test('set: a branch that keeps moving stops after three tries with nothing of mine on it', async () => {
  const fake = fakeGitHub({ files: site(3) });
  const copies = [saved(fake, pathOf(1), { title: 'Mine' })];
  let n = 0;
  fake.onWrite((api) => { api.commit({ 'log.txt': `push ${++n}` }); });
  await assert.rejects(send(fake, copies), (err) => err instanceof HeadMoved && err.code === 'head_moved');
  assert.equal(writes(fake).filter(w => w.startsWith('PATCH')).length, SET_TRIES);
  assert.ok(fake.read(pathOf(1)).includes('Title 1'));
  assert.equal(fake.commits.get(fake.head()).message, 'outside change');
});

// The editor reads a list with the browser and its cleaner. Here the same reading is done on parse5 with the
// editor's own allowlist, as test/list-as-file.test.js does: what is not on the list goes.
const TAGS = new Set(CONTAINER_SANITIZE.ALLOWED_TAGS);
const ATTRS = new Set(CONTAINER_SANITIZE.ALLOWED_ATTR);
const GOES_WHOLE = new Set(['svg', 'iframe', 'script', 'style', 'template', 'math', 'noscript', 'video', 'audio']);
const ctx = (tag) => T.createElement(tag, H.NS.HTML, []);
const attr = (n, name) => n.attrs.find(a => a.name === name)?.value;
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
function readList(tag, html) {
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
}
const staged = (tag, html) => readList(tag, html).map(b => b.html).join('');

test('set: a list is written from the file\'s own text, so a drawing the cleaner does not know stays in every card', async () => {
  const DRAW = (d) => `<svg class="icon" viewBox="0 0 24 24"><path d="${d}"/></svg>`;
  const CARDS = `\n  <article class="card" x-data="{ open: false }">${DRAW('M4 12h16')}<h3 data-cms="card_title">First</h3></article>\n  <article class="card" x-data="{ open: false }">${DRAW('M12 4v16')}<h3 data-cms="card_title">Second</h3></article>\n`;
  const fake = fakeGitHub({ files: { 'index.html': page(0, `\n<div class="cards" data-cms-repeat="cards">${CARDS}</div>`), 'about.html': page(1) } });
  const base = staged('div', CARDS);
  assert.doesNotMatch(base, /svg/, 'the cleaner takes the drawing out, as in the browser');
  const list = saved(fake, 'index.html', { cards: base.replace('Second', 'Second, changed') });
  list.more.cards.base = base;
  const copies = [list, saved(fake, 'about.html', { title: 'About us' })];

  // Without a way to read the list, nothing is written: not that page, and not the other one.
  const blind = await send(fake, copies);
  assert.deepEqual(blind.blocked, [{ path: 'index.html', key: 'cards', reason: 'list' }]);
  assert.equal(blind.commit, null);
  assert.deepEqual(writes(fake), []);

  const out = await send(fake, copies, { readList });
  assert.equal(out.files.length, 2);
  const now = fake.read('index.html');
  assert.equal(now, page(0, `\n<div class="cards" data-cms-repeat="cards">${CARDS.replace('Second', 'Second, changed')}</div>`), 'only the one title differs');
  assert.ok(fake.read('about.html').includes('About us'));
  assert.equal(fake.commits.size, 2);
});

test('set: a change to a shared part reaches every page that has it, in the same one commit as the other changes', async () => {
  const bare = '<!doctype html>\n<html><body><h1 data-cms="title">No footer here</h1></body></html>\n';
  const fake = fakeGitHub({ files: { ...site(6), 'plain.html': bare, 'notes.txt': 'data-cms="footer_note"' } });
  const copies = [
    saved(fake, pathOf(1), { title: 'Mine 1', footer_note: 'Open at weekends' }, { shared: ['footer_note'], ts: 2000 }),
    saved(fake, pathOf(2), { title: 'Mine 2', footer_note: 'An older try' }, { shared: ['footer_note'], ts: 1000 }),
  ];
  const plainBefore = blobOf(fake, 'plain.html');
  const out = await send(fake, copies);
  assert.equal(fake.commits.size, 2);
  for (let i = 0; i < 6; i++) assert.ok(fake.read(pathOf(i)).includes('<p data-cms="footer_note">Open at weekends</p>'), pathOf(i));
  assert.ok(fake.read(pathOf(1)).includes('Mine 1'));
  assert.ok(fake.read(pathOf(2)).includes('Mine 2'));
  assert.equal(blobOf(fake, 'plain.html'), plainBefore);
  assert.equal(out.files.length, 6);
  assert.deepEqual(out.dropped, [{ path: pathOf(2), key: 'footer_note', reason: 'older' }]);
  // The pages come oldest copy first.
  assert.deepEqual(out.published, [{ path: pathOf(2), keys: ['title'] }, { path: pathOf(1), keys: ['title', 'footer_note'] }]);
  // Two pages of the set, the five other pages read for the shared part, and six.
  assert.equal(fake.calls.length, setRequests({ pages: 2, others: 5 }));
});

test('set: a shared part somebody else changed is asked about before any other page is read', async () => {
  const fake = fakeGitHub({ files: site(5) });
  const copies = [saved(fake, pathOf(1), { footer_note: 'Mine' }, { shared: ['footer_note'] })];
  fake.commit(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [pathOf(i), page(i).replace('Open daily', 'Their note')])));
  const out = await send(fake, copies);
  assert.deepEqual(out.conflicts.map(c => [c.path, c.key, c.theirs, c.shared]), [[pathOf(1), 'footer_note', 'Their note', true]]);
  assert.equal(fake.calls.length, setRequests({ pages: 1 }) - 3, 'the head, the list of files and the one page: nothing else was read and nothing sent');
});

test('set: over a limit nothing is written and the limit is named; two different pictures under one name stop it too', async () => {
  const fake = fakeGitHub({ files: site(4) });
  const copies = [1, 2, 3].map(i => saved(fake, pathOf(i), { title: `Mine ${i}` }));
  const over = await send(fake, copies, { maxFiles: 2 });
  assert.deepEqual(over.over, { what: 'files', count: 3, max: 2 });
  assert.equal(over.commit, null);

  const many = Array.from({ length: SET_PICTURES_MAX + 1 }, (_, i) => ({ path: `uploads/pic${i}.jpg`, base64: B64(`p${i}`) }));
  const album = saved(fake, pathOf(1), { intro: many.map(p => `<img src="/${p.path}" alt="">`).join('') });
  assert.deepEqual((await send(fake, [album], { pictures: many })).over, { what: 'pictures', count: SET_PICTURES_MAX + 1, max: SET_PICTURES_MAX });

  const twice = await send(fake, [saved(fake, pathOf(1), { intro: '<img src="/uploads/cat.jpg" alt="">' })],
    { pictures: [{ path: 'uploads/cat.jpg', base64: B64('one cat') }, { path: 'uploads/cat.jpg', base64: B64('another cat') }] });
  assert.deepEqual(twice.blocked, [{ path: 'uploads/cat.jpg', key: null, reason: 'picture' }]);
  assert.deepEqual(writes(fake), []);
});

test('set: a copy from before the additions is published without the check of its parts, and one that names no file is left waiting', async () => {
  const fake = fakeGitHub({ files: site(3) });
  const old = { ts: 1, edits: { title: { html: 'From an older editor' } }, page: { path: pathOf(1) } };
  const nameless = { ts: 2, edits: { title: { html: 'Where does this go?' } } };
  const tampered = { ts: 3, edits: { title: { html: 'x' } }, page: { path: '../outside.html' } };
  fake.commit({ [pathOf(1)]: page(1).replace('Title 1', 'Their title') });
  const out = await send(fake, [old, nameless, tampered, null, 'nonsense', { edits: 7 }]);
  assert.ok(fake.read(pathOf(1)).includes('From an older editor'));
  assert.deepEqual(out.left.map(l => [l.path, l.key, l.reason, l.copy]), [[null, 'title', 'no_page', nameless], [null, 'title', 'no_page', tampered]]);
  assert.equal(fake.commits.size, 3);
});

test('set: when every page already reads as the changes want it, no commit is made', async () => {
  const fake = fakeGitHub({ files: site(2) });
  const copies = [saved(fake, pathOf(1), { title: 'Mine' })];
  fake.commit({ [pathOf(1)]: page(1).replace('Title 1', 'Mine') });
  const out = await send(fake, copies);
  assert.equal(out.commit, null);
  assert.equal(out.ok, true);
  assert.deepEqual(out.published, [{ path: pathOf(1), keys: ['title'] }]);
  assert.deepEqual(writes(fake), []);
});

test('set: planSet sends nothing, and reads only through what it is handed', async () => {
  const texts = { 'a.html': page(1), 'b.html': page(2) };
  const read = [];
  const copy = { ts: 1, edits: { title: { html: 'A' } }, more: { title: { was: 'Title 1' } }, page: { path: 'a.html', sha: 'sha-a' } };
  const plan = await planSet({ copies: [copy], files: new Map([['a.html', 'sha-a'], ['b.html', 'sha-b']]), read: async (p) => { read.push(p); return texts[p]; } });
  assert.deepEqual(read, ['a.html']);
  assert.deepEqual(plan.files, [{ path: 'a.html', text: page(1).replace('Title 1', 'A') }]);
  assert.equal(plan.ok, true);
});

test('commitFilesOn: builds on the commit it is given without reading the branch, and a refused move is HeadMoved', async () => {
  const fake = fakeGitHub({ files: site(2) });
  const gh = ghFor(fake);
  const head = await branchHead(gh, fake.repo, 'main');
  assert.deepEqual(head, { sha: fake.head(), tree: fake.commits.get(fake.head()).tree });
  const from = fake.calls.length;
  const sent = new Map();
  const commit = await commitFilesOn(gh, fake.repo, 'main', head, [{ path: 'a.html', text: '<p>a</p>' }, { path: 'pic.png', base64: B64('png') }, { path: 'empty.txt', text: '' }], 'three files', { sent });
  assert.deepEqual(fake.calls.slice(from).map(c => `${c.method} ${c.path}`), ['POST /git/blobs', 'POST /git/blobs', 'POST /git/trees', 'POST /git/commits', 'PATCH /git/refs/heads/main']);
  assert.equal(fake.calls.at(-1).body.force, undefined, 'never forced');
  assert.deepEqual(fake.commits.get(commit.sha).parents, [head.sha]);
  assert.deepEqual([...sent.keys()], ['pic.png']);

  // The same head again: the branch has moved on (to the commit just made), so the move is refused.
  const before = fake.head();
  await assert.rejects(commitFilesOn(gh, fake.repo, 'main', head, [{ path: 'a.html', text: '<p>late</p>' }], 'late'), HeadMoved);
  assert.equal(fake.head(), before);
  assert.equal(fake.read('a.html'), '<p>a</p>');

  assert.equal(isHeadMoved({ status: 422, data: { message: 'Update is not a fast forward' } }), true);
  assert.equal(isHeadMoved({ status: 403, data: { error: 'a branch can only move to a commit made directly on top of its current head', code: 'ref_not_direct' } }), true);
  assert.equal(isHeadMoved({ status: 422, data: { message: 'Object does not exist' } }), false);
  assert.equal(isHeadMoved({ status: 403, data: { code: 'ref_foreign_commit' } }), false);
  assert.equal(isHeadMoved({ status: 429, data: { code: 'too_often' } }), false);
  assert.equal(isHeadMoved(null), false);
});

test('set: an invited editor\'s set goes through the service as one commit in their name, and its refusal of a moved branch is tried again', async () => {
  const fake = fakeGitHub({ repo: REPO, files: { ...site(4), '.github/workflows/build.yml': 'on: push' } });
  const env = editorEnv();
  const gh = makeGh({ mode: 'proxy', worker: 'https://worker.example', session: SESSION,
    fetchImpl: (url, init) => worker.fetch(new Request(url, { method: init.method, body: init.body, headers: { ...init.headers, Origin: ORIGIN } }), env) });
  const copies = [saved(fake, pathOf(1), { title: 'Mine 1' }), saved(fake, pathOf(2), { title: 'Mine 2' })];
  let theirs = null;
  const refusals = [];
  await withFetch((url, init) => fake.handler(url, init), async () => {
    fake.onWrite((api) => { if (!theirs) theirs = api.commit({ [pathOf(3)]: page(3).replace('Intro 3', 'Their intro') }); });
    const out = await publishSet({ gh, repo: REPO, branch: 'main', copies, message, wait: async () => {}, onStep: (s) => { if (s.step === 'again') refusals.push(s); } });
    assert.equal(out.tries, 2);
    assert.equal(refusals.length, 1, 'the service said ref_not_direct once');
    assert.deepEqual(fake.commits.get(fake.head()).parents, [theirs]);
    // The service's own stamp for this session, which is what lets it move the branch to this commit.
    assert.equal(fake.commits.get(fake.head()).author.email, 'kiln-editor@users.noreply.github.com');
    assert.match(fake.commits.get(fake.head()).author.name, /Sam/);
    assert.ok(fake.read(pathOf(1)).includes('Mine 1'));
    assert.ok(fake.read(pathOf(2)).includes('Mine 2'));
    assert.ok(fake.read(pathOf(3)).includes('Their intro'));

    // A copy that names a file an editor may not write: the service refuses the whole set, and nothing moves.
    const head = fake.head();
    const bad = { ts: 9, edits: { title: { html: 'Mine again' } }, page: { path: pathOf(1) } };
    const outside = { ts: 9, edits: { title: { html: '<script>alert(1)</script>' } }, page: { path: pathOf(2) } };
    await assert.rejects(publishSet({ gh, repo: REPO, branch: 'main', copies: [bad, outside], message, wait: async () => {} }), (err) => err.status === 403 || err.status === 422);
    assert.equal(fake.head(), head);
  });
});
