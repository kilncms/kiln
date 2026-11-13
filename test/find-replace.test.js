/**
 * Find & replace across the site (src/editor/find-replace.js, used by the
 * Find & replace tool in main.js; the commit is commitFiles in src/github.js).
 *
 * The service counts a signed-in person's requests, 120 to the minute. The
 * tool read every page once for its preview and then sent every page with a
 * match in a request of its own before committing: up to 2N + 6 requests for
 * N pages, so a site of more than about 57 pages was told to wait part-way.
 * It now asks N + 7, as the Site menu tool does (test/menu-save.test.js), and
 * these tests hold it to one commit that is all or nothing, and to what it
 * finds and replaces being exactly what it found and replaced before.
 *
 * It also replaced in the whole text of each file, so replacing "brine"
 * rewrote href="/blog/the-monday-brine.html" and the link went nowhere. The
 * second half of this file holds it to the rule: only words a visitor reads
 * or hears are changed, and nothing else in the file changes by a single byte.
 */
import { parse } from 'parse5';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  findEverywhere, replaceEverywhere, findPages, findReplaceRequests, countMatches, replaceWords, leftAloneText, previewText, noMatchText, replacedText,
  changedSinceText, FIND_PAGES_MAX,
} from '../src/editor/find-replace.js';
import { getFile, commitFiles, encodeContent } from '../src/github.js';

const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
const REPO = 'acme/site';
const page = (n, words = 'Call 404-555-0100 or 404-555-0100.') => `<!doctype html>\n<html><head><title>Page ${n}</title></head><body>\n<p data-cms="p${n}">${words}</p>\n</body></html>\n`;
const site = (n, quiet = () => false) => Object.fromEntries(Array.from({ length: n }, (_, i) =>
  [i ? `pages/p${i}.html` : 'index.html', quiet(i) ? page(i, 'Nothing to see.') : page(i)]));
const shaOf = (text) => createHash('sha1').update(text).digest('hex');

/** A repository as the editor's requests see it: files, trees, commits and the branch, all in memory. */
function fakeRepo(files) {
  const calls = [];
  const trees = new Map([['t0', new Map(Object.entries(files))]]);
  const commits = new Map([['c0', { tree: 't0' }]]);
  let head = 'c0', n = 0, refuse = null;
  const live = () => trees.get(commits.get(head).tree);
  const gh = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (refuse && refuse({ method, path, nth: calls.length })) {
        throw Object.assign(new Error('GitHub 429: '), { status: 429, data: { error: 'Too much was asked of the Kiln service from here in the last minute. Please wait a minute, then try again.', code: 'too_often', retry_after: 60 } });
      }
      let m;
      if (method === 'GET' && /\/git\/trees\/main\?recursive=1$/.test(path)) {
        return { tree: [...live()].map(([p, text]) => ({ type: 'blob', path: p, sha: shaOf(text) })).concat([{ type: 'tree', path: 'pages', sha: 'dir' }]) };
      }
      if (method === 'GET' && (m = /\/contents\/(.+)\?ref=main/.exec(path))) { const text = live().get(decodeURIComponent(m[1])); return { content: encodeContent(text), sha: shaOf(text) }; }
      if (method === 'GET' && /\/git\/ref\/heads%2Fmain$/.test(path)) return { object: { sha: head } };
      if (method === 'GET' && (m = /\/git\/commits\/(\w+)$/.exec(path))) return { tree: { sha: commits.get(m[1]).tree } };
      if (method === 'POST' && /\/git\/trees$/.test(path)) {
        const next = new Map(trees.get(body.base_tree));
        for (const e of body.tree) next.set(e.path, e.content);
        const sha = `t${++n}`; trees.set(sha, next); return { sha };
      }
      if (method === 'POST' && /\/git\/commits$/.test(path)) { const sha = `c${++n}`; commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message }); return { sha }; }
      if (method === 'PATCH' && /\/git\/refs\/heads%2Fmain$/.test(path)) { head = body.sha; return {}; }
      throw Object.assign(new Error(`unexpected ${method} ${path}`), { status: 500 });
    },
  };
  /** Somebody else publishes a page: a commit of their own on the branch. */
  const publish = (path, text) => { const next = new Map(live()); next.set(path, text); const t = `t${++n}`; trees.set(t, next); const c = `c${++n}`; commits.set(c, { tree: t }); head = c; };
  return { gh, calls, live, head: () => head, commits, publish, refuseWhen(fn) { refuse = fn; } };
}
const FIND = '404-555-0100', REPL = '470-555-0199';
const find = (repo, extra = {}) => findEverywhere({ gh: repo.gh, repo: REPO, branch: 'main', find: FIND, getFile, ...extra });
const replace = (repo, hits) => replaceEverywhere({ gh: repo.gh, repo: REPO, branch: 'main', hits, find: FIND, repl: REPL, commitFiles });

test('find & replace: sixty pages, every one with a match, take N + 7 requests and one commit', async () => {
  const repo = fakeRepo(site(60));
  const steps = [];
  const { pages, hits } = await find(repo, { onStep: s => steps.push(`${s.done}/${s.of}`) });
  assert.equal(pages, 60);
  assert.equal(hits.length, 60);
  assert.equal(repo.calls.length, 61, 'one listing and one read of each page, for the preview');
  assert.deepEqual([steps[0], steps[59]], ['1/60', '60/60']);
  const { changed, commit } = await replace(repo, hits);
  assert.equal(repo.calls.length, findReplaceRequests(60));
  assert.equal(findReplaceRequests(60), 67, 'it was 126: over the 120 the service allows in a minute');
  assert.ok(findReplaceRequests(FIND_PAGES_MAX) < 120, 'the most pages it ever searches fit in a minute');
  assert.equal(repo.calls.filter(c => /\/git\/blobs$/.test(c.path)).length, 0, 'no page is sent in a request of its own');
  assert.equal(repo.calls.filter(c => c.method === 'POST' && /\/git\/commits$/.test(c.path)).length, 1, 'one commit');
  assert.equal(repo.head(), commit.sha);
  assert.equal(repo.commits.get(commit.sha).message, 'Replace “404-555-0100” → “470-555-0199” on 60 pages (via Kiln)');
  assert.equal(changed.length, 60);
  for (const [path, text] of repo.live()) {
    assert.equal(countMatches(text, FIND), 0, path);
    assert.equal(countMatches(text, REPL), 2, path);
  }
});

test('find & replace: it finds what it found before, and changes only the pages with a match', async () => {
  const repo = fakeRepo({ ...site(6, i => i % 2 === 1), 'notes.txt': 'Call 404-555-0100', 'assets/app.js': '"404-555-0100"' });
  const before = new Map(repo.live());
  const { pages, hits } = await find(repo);
  assert.equal(pages, 6, 'web pages only');
  assert.deepEqual(hits.map(h => `${h.path}:${h.count}`), ['index.html:2', 'pages/p2.html:2', 'pages/p4.html:2']);
  const { changed } = await replace(repo, hits);
  assert.deepEqual(changed.map(c => c.path), ['index.html', 'pages/p2.html', 'pages/p4.html']);
  for (const [path, text] of repo.live()) {
    if (changed.some(c => c.path === path)) assert.equal(text, before.get(path).split(FIND).join(REPL), path);
    else assert.equal(text, before.get(path), `${path} is as it was`);
  }
  // as written: capitals count, and so do characters that mean something to a pattern
  assert.equal(countMatches('Tea. tea. TEA.', 'tea'), 1);
  assert.equal(countMatches('a.b a.b axb', 'a.b'), 2);
  assert.equal(replaceWords('<p>$5 and $5</p>', '$5', '$&').text, '<p>$&amp; and $&amp;</p>');
  assert.equal(replaceWords('<p>one</p>', 'one', '').text, '<p></p>');
});

test('find & replace: a refusal at any point leaves every page as it was (all or nothing)', async () => {
  // during the preview's reads
  let repo = fakeRepo(site(14));
  let before = new Map(repo.live());
  repo.refuseWhen(({ nth }) => nth === 6);
  await assert.rejects(find(repo), e => e.status === 429 && e.data.code === 'too_often');
  assert.deepEqual([...repo.live()], [...before]);
  assert.equal(repo.calls.filter(c => c.method !== 'GET').length, 0, 'nothing was written');
  // at each request of the replace itself: the second listing, then the five of the commit
  for (let at = 1; at <= 6; at++) {
    repo = fakeRepo(site(14));
    before = new Map(repo.live());
    const { hits } = await find(repo);
    const done = repo.calls.length;
    repo.refuseWhen(({ nth }) => nth === done + at);
    await assert.rejects(replace(repo, hits), e => e.status === 429, `refused at request ${at} of the replace`);
    assert.equal(repo.head(), 'c0', `refused at request ${at}: the branch has not moved`);
    assert.deepEqual([...repo.live()], [...before]);
  }
});

test('find & replace: a page somebody published after the preview does not get its older words back', async () => {
  const repo = fakeRepo(site(5));
  const { hits } = await find(repo);
  const newer = page(2, 'New words, published while the preview was on the screen. Call 404-555-0100.');
  repo.publish('pages/p2.html', newer);
  const head = repo.head();
  const writes = repo.calls.filter(c => c.method !== 'GET').length;
  await assert.rejects(replace(repo, hits), e => {
    assert.deepEqual(e.changedSince, ['pages/p2.html']);
    assert.equal(e.message, 'Nothing was replaced. pages/p2.html has been changed since the matches were found. Press “Preview matches” again, then replace.');
    return true;
  });
  assert.equal(repo.head(), head);
  assert.equal(repo.live().get('pages/p2.html'), newer);
  assert.equal(repo.calls.filter(c => c.method !== 'GET').length, writes, 'nothing was written');
  // previewed again, it goes through, on the newer words
  const again = await find(repo);
  await replace(repo, again.hits);
  assert.equal(repo.live().get('pages/p2.html'), newer.split(FIND).join(REPL));
  assert.equal(changedSinceText(['a.html', 'b.html', 'c.html', 'd.html', 'e.html']), 'Nothing was replaced. a.html, b.html, c.html and 2 more have been changed since the matches were found. Press “Preview matches” again, then replace.');
});

test('find & replace: only web pages are searched, a hundred at the most', () => {
  const tree = { tree: [{ type: 'blob', path: 'index.html', sha: 'a' }, { type: 'tree', path: 'blog', sha: 'b' }, { type: 'blob', path: 'style.css', sha: 'c' },
    ...Array.from({ length: 150 }, (_, i) => ({ type: 'blob', path: `blog/p${i}.html`, sha: `s${i}` }))] };
  const pages = findPages(tree);
  assert.equal(pages.length, FIND_PAGES_MAX);
  assert.deepEqual(pages[0], { path: 'index.html', sha: 'a' });
  assert.deepEqual(findPages(null), []);
});

test('find & replace: the tool in the editor works through this, and says what it said before', () => {
  const panel = main.slice(main.indexOf('function findReplacePanel()'), main.indexOf('// ─── Drafts (kiln-drafts branch)'));
  assert.match(panel, /await findEverywhere\(\{ gh: state\.gh, repo: cfg\.repo, branch, find, getFile,/);
  assert.match(panel, /await replaceEverywhere\(\{ gh: state\.gh, repo: cfg\.repo, branch, hits, find, repl, commitFiles \}\)/);
  assert.equal(/getFile\(state\.gh/.test(panel), false, 'no page is read anywhere else');
  assert.equal(/await commitFiles\(/.test(panel), false, 'and none is saved anywhere else');
  // the same handling as the Site menu tool when the service says to wait
  assert.match(panel, /stopped\(err, 'replaced', typedIn\(m\)\) \|\| notDone\('Nothing was replaced\.', err\)/);
  assert.match(panel, /stopped\(err, '', typedIn\(m\)\) \|\| notDone\('The pages could not be searched\.', err\)/);
  for (const said of ['Scanning every page…', 'Scanning… ${done}/${of}', 'Replacing…', 'Replace in ${nPlaces(count)}']) assert.ok(panel.includes(said), said);
  // what it says comes from find-replace.js, where it is tested: nothing is said about a count the tool did not make
  assert.match(panel, /const \{ hits, left \} = await findEverywhere\(/);
  assert.match(panel, /if \(!hits\.length\) \{ status\.textContent = noMatchText\(find, left\); return; \}/);
  assert.match(panel, /status\.textContent = previewText\(find, count, hits\.length, left\);/);
  assert.match(panel, /const \{ changed, commit, count: done \} = await replaceEverywhere\(/);
  assert.match(panel, /status\.textContent = replacedText\(done, changed\.length, left, !!thisPage\);/);
  // the preview shows each page's count and its first places, as they are and as they would be, every word of it escaped
  assert.match(panel, /<small>\$\{nPlaces\(h\.count\)\}<\/small>/);
  assert.match(panel, /<div><span>Now<\/span> \$\{shown\(s, find\)\}<\/div><div><span>After<\/span> \$\{shown\(s, repl\)\}<\/div>/);
  assert.match(panel, /const shown = \(s, word\) => `\$\{escapeHtml\(s\.pre\)\}<mark>\$\{escapeHtml\(word\)\}<\/mark>\$\{escapeHtml\(s\.post\)\}`;/);
  assert.equal(/anywhere in the page source/.test(panel), false, 'it no longer replaces anywhere in the page source');
  assert.equal(/[—–]/.test(panel.replace(/\/\/[^\n]*/g, '')), false, 'no dashes in what the tool says');
  // a second preview takes the first one's "Replace all" away with it
  assert.match(panel, /m\.querySelectorAll\('\.kiln-fr-act'\)\.forEach\(old => old\.remove\(\)\);/);
  assert.match(panel, /if \(err\.changedSince\) \{ status\.textContent = changedSinceText\(err\.changedSince\); act\.remove\(\); out\.innerHTML = ''; return; \}/);
});

// ── What is changed, and what is left alone ─────────────────────────────────

const els = (html) => { let n = 0; const walk = (node) => { for (const c of node.childNodes || []) { if (c.tagName) n++; walk(c); } if (node.content) walk(node.content); }; walk(parse(html)); return n; };
const SHOP = `<!doctype html>\r\n<html lang="en"><head>\n<title>The Monday brine</title>\n<meta name="description" content="How we make brine">\n<meta property="og:title" content="brine, by us">\n<meta property="og:description" content='Our brine'>\n<meta name="twitter:title" content="brine today">\n<meta name="twitter:description" content="More brine">\n<meta property="og:image" content="/img/brine.png">\n<meta property="og:url" content="https://shop.example/brine/">\n<meta name="keywords" content="brine">\n<link rel="stylesheet" href="/css/brine.css">\n<style>.brine { color: teal }</style>\n</head>\n<body class="brine page" id="brine" data-page="brine">\n<!-- the brine page -->\n<nav><a href="/blog/the-monday-brine.html" class="brine-link" title="Read about brine" aria-label="Open the brine post" data-cms="brine-link">The Monday brine</a></nav>\n<img src="/img/brine.jpg" srcset="/img/brine@2x.jpg 2x" alt="A jar of brine" style="border-color: brine">\n<input name="brine" value="brine" placeholder="Search brine">\n<p data-cms="brine-intro">Our brine is salty.</p>\n<template><p>brine</p></template>\n<noscript><p>brine</p></noscript>\n<script>window.brine = "brine";</script>\n<script type="application/ld+json">{"name":"brine"}</script>\n</body></html>\n`;

test('find & replace: the word in a link’s text and in its address: the text changes, the address does not', () => {
  const page = '<p>See <a href="/blog/the-monday-brine.html">The Monday brine</a>.</p>\n';
  const r = replaceWords(page, 'brine', 'pickle');
  assert.equal(r.text, '<p>See <a href="/blog/the-monday-brine.html">The Monday pickle</a>.</p>\n');
  assert.equal(r.count, 1, 'one replacement');
  assert.equal(r.left, 1, 'and one place counted as left alone: the address');
  assert.deepEqual(r.samples, [{ where: '', pre: 'The Monday ', post: '' }]);
});

test('find & replace: every kind of words for people is changed, and nothing else in the file by a single byte', () => {
  const r = replaceWords(SHOP, 'brine', 'pickle');
  const want = SHOP
    .replace('<title>The Monday brine</title>', '<title>The Monday pickle</title>')
    .replace('content="How we make brine"', 'content="How we make pickle"')
    .replace('content="brine, by us"', 'content="pickle, by us"')
    .replace("content='Our brine'", "content='Our pickle'")
    .replace('content="brine today"', 'content="pickle today"')
    .replace('content="More brine"', 'content="More pickle"')
    .replace('title="Read about brine"', 'title="Read about pickle"')
    .replace('aria-label="Open the brine post"', 'aria-label="Open the pickle post"')
    .replace('>The Monday brine</a>', '>The Monday pickle</a>')
    .replace('alt="A jar of brine"', 'alt="A jar of pickle"')
    .replace('placeholder="Search brine"', 'placeholder="Search pickle"')
    .replace('>Our brine is salty.<', '>Our pickle is salty.<');
  assert.equal(r.text, want);
  assert.equal(r.count, 12);
  // put the word back and the file is the one we started with, byte for byte (the \r\n too)
  assert.equal(r.text.split('pickle').join('brine'), SHOP);
  assert.equal(els(r.text), els(SHOP), 'no element came or went');
  // never: addresses, classes, ids, data-*, the names Kiln marks parts with, style, a comment, scripts, styles, template, noscript
  for (const kept of ['content="/img/brine.png"', 'content="https://shop.example/brine/"', '<meta name="keywords" content="brine">', 'href="/css/brine.css"', '<style>.brine { color: teal }</style>',
    '<body class="brine page" id="brine" data-page="brine">', '<!-- the brine page -->', 'href="/blog/the-monday-brine.html"', 'class="brine-link"', 'data-cms="brine-link"',
    'src="/img/brine.jpg"', 'srcset="/img/brine@2x.jpg 2x"', 'style="border-color: brine"', '<input name="brine" value="brine"', 'data-cms="brine-intro"',
    '<template><p>brine</p></template>', '<noscript><p>brine</p></noscript>', '<script>window.brine = "brine";</script>', '{"name":"brine"}']) assert.ok(r.text.includes(kept), kept);
  assert.equal(r.left, countMatches(r.text, 'brine'), 'every place left alone is counted, and no other');
  assert.equal(r.left, 23);
  assert.deepEqual(r.samples, [{ where: 'Page title', pre: 'The Monday ', post: '' }, { where: 'Description for search engines', pre: 'How we make ', post: '' }, { where: 'Link preview', pre: '', post: ', by us' }]);
  // a tag's own name is not words either
  const t = replaceWords('<p>A table.</p><table><tr><td>table</td></tr></table>', 'table', 'desk');
  assert.equal(t.text, '<p>A desk.</p><table><tr><td>desk</td></tr></table>');
  assert.deepEqual([t.count, t.left], [2, 2]);
});

test('find & replace: text the file writes with entities is found as it reads, and what is typed can never become markup', () => {
  const page = '<p title="Salt &amp; vinegar" data-x=\'1\'>Salt &amp; vinegar, caf&eacute; &#38; bar. AT&T &lt;here&gt;</p>\n<img alt=\'Salt &amp; vinegar\'><img alt=Vinegar src=v.png>\n';
  const typed = 'Fish <b>&</b> "chips" & \'peas\'';
  const r = replaceWords(page, 'Salt & vinegar', typed);
  assert.equal(r.count, 3);
  assert.equal(r.text, '<p title="Fish &lt;b&gt;&amp;&lt;/b&gt; &quot;chips&quot; &amp; \'peas\'" data-x=\'1\'>Fish &lt;b&gt;&amp;&lt;/b&gt; "chips" &amp; \'peas\', caf&eacute; &#38; bar. AT&T &lt;here&gt;</p>\n'
    + '<img alt=\'Fish &lt;b&gt;&amp;&lt;/b&gt; "chips" &amp; &#39;peas&#39;\'><img alt=Vinegar src=v.png>\n');
  // read back by a browser's rules it shows exactly as typed, and it made no element
  const body = parse(r.text).childNodes[0].childNodes[1];
  const [p, img] = body.childNodes.filter(n => n.tagName);
  assert.equal(p.attrs.find(a => a.name === 'title').value, typed);
  assert.equal(p.childNodes[0].value, `${typed}, café & bar. AT&T <here>`);
  assert.equal(img.attrs.find(a => a.name === 'alt').value, typed);
  assert.equal(els(r.text), els(page));
  // the entity beside a match is left as the file wrote it; a word written with an entity is found by how it reads
  assert.equal(replaceWords(page, 'café', 'tea room').text, page.replace('caf&eacute;', 'tea room'));
  assert.equal(replaceWords(page, '& bar', 'and bar').text, page.replace('&#38; bar', 'and bar'));
  assert.equal(replaceWords(page, '<here>', 'here').text, page.replace('&lt;here&gt;', 'here'));
  assert.equal(replaceWords(page, 'AT&T', 'the phone company').text, page.replace('AT&T', 'the phone company'));
  // the name of an entity is not a word on the page
  assert.deepEqual([replaceWords(page, 'amp', 'x').count, replaceWords(page, 'eacute', 'x').count, replaceWords(page, 'amp', 'x').text], [0, 0, page]);
  // a value written without quotes: what is typed stays one value, and an emptied one is written ""
  const bare = replaceWords(page, 'Vinegar', 'Malt vinegar > all');
  assert.equal(bare.text, page.replace('alt=Vinegar', 'alt=Malt&#32;vinegar&#32;&#62;&#32;all'));
  const imgs = parse(bare.text).childNodes[0].childNodes[1].childNodes.filter(n => n.tagName === 'img');
  assert.deepEqual(imgs[1].attrs.map(a => `${a.name}=${a.value}`), ['alt=Malt vinegar > all', 'src=v.png']);
  assert.equal(replaceWords(page, 'Vinegar', '').text, page.replace('alt=Vinegar', 'alt=""'));
  // a line break straight after <pre>, which the parser drops, does not put the place out
  assert.equal(replaceWords('<pre>\nsalt &amp; brine</pre>', 'brine', 'pickle').text, '<pre>\nsalt &amp; pickle</pre>');
  assert.equal(replaceWords('<p>one &amp;\r\ntwo brine</p>', 'brine', 'pickle').text, '<p>one &amp;\r\ntwo pickle</p>');
});

test('find & replace: a word split between two elements is not found, and capitals count', () => {
  const split = '<p><b>br</b>ine and br<i>ine</i></p>';
  const r = replaceWords(split, 'brine', 'pickle');
  assert.deepEqual([r.text, r.count, r.left, r.samples.length], [split, 0, 0, 0]);
  assert.equal(noMatchText('brine', 0), 'No matches for “brine”. Capitals count, and a word that is partly in bold or partly in a link is not found.');
  const caps = replaceWords('<p>Tea. tea. TEA.</p>', 'tea', 'coffee');
  assert.deepEqual([caps.text, caps.count], ['<p>Tea. coffee. TEA.</p>', 1]);
});

test('find & replace: the preview says how many places on each page, shows the words around the first few, and counts what is left alone', async () => {
  const repo = fakeRepo({
    'index.html': SHOP,
    'about.html': '<!doctype html><html><head><title>About</title></head><body><p>Nothing here. See <a href="/blog/the-monday-brine.html">the post</a>.</p></body></html>',
    'blog/the-monday-brine.html': `<!doctype html><html><head><title>Monday</title></head><body><p>${'It was a long week at the stall and we were glad of the rest. '.repeat(2)}Then the brine came good, and the whole street could smell it by the time we opened on Tuesday morning.</p><p>brine</p><p>brine</p><p>brine</p></body></html>`,
  });
  const { pages, hits, left } = await findEverywhere({ gh: repo.gh, repo: REPO, branch: 'main', find: 'brine', getFile });
  assert.equal(pages, 3);
  assert.deepEqual(hits.map(h => `${h.path}:${h.count}`), ['index.html:12', 'blog/the-monday-brine.html:4'], 'about.html has the word only in an address: nothing there would change');
  assert.equal(left, 24, '23 on the home page and the address on the about page');
  assert.equal(hits[1].samples.length, 3, 'the first few places of a page, not all of them');
  assert.deepEqual(hits[1].samples[0], { where: '', pre: '…and we were glad of the rest. Then the ', post: ' came good, and the whole street could…' });
  assert.equal(previewText('brine', 16, 2, 24), '16 places on 2 pages would change. Only words a visitor reads or hears are replaced. Addresses of links and pictures, style names and scripts are left alone: “brine” is also in 24 such places on this site, and they will not be changed.');
  assert.equal(previewText('brine', 1, 1, 1), '1 place on 1 page would change. Only words a visitor reads or hears are replaced. Addresses of links and pictures, style names and scripts are left alone: “brine” is also in 1 such place on this site, and it will not be changed.');
  assert.equal(leftAloneText('brine', 0), 'Addresses of links and pictures, style names and scripts are left alone.');
  // someone who meant to rename a page is told this tool did not
  const only = await findEverywhere({ gh: repo.gh, repo: REPO, branch: 'main', find: 'the-monday-brine', getFile });
  assert.deepEqual([only.hits.length, only.left], [0, 2]);
  assert.equal(noMatchText('the-monday-brine', 2), '“the-monday-brine” is not in any words a visitor reads, so nothing would be replaced. Addresses of links and pictures, style names and scripts are left alone: “the-monday-brine” is also in 2 such places on this site, and they will not be changed. Capitals count, and a word that is partly in bold or partly in a link is not found.');
  for (const said of [previewText('a', 2, 1, 3), noMatchText('a', 0), noMatchText('a', 2), leftAloneText('a', 1), replacedText(2, 1, 3, true), replacedText(1, 1, 0, false)]) assert.equal(/[—–]/.test(said), false, said);
});

test('find & replace: what is saved is what the preview showed, and the count said afterwards is the count really changed', async () => {
  const repo = fakeRepo({ 'index.html': SHOP, 'about.html': '<p>About the <a href="/brine.html">brine</a>.</p>', 'plain.html': '<p>Nothing.</p>' });
  const before = new Map(repo.live());
  const { hits, left } = await findEverywhere({ gh: repo.gh, repo: REPO, branch: 'main', find: 'brine', getFile });
  const { changed, count } = await replaceEverywhere({ gh: repo.gh, repo: REPO, branch: 'main', hits, find: 'brine', repl: 'pickle', commitFiles });
  assert.equal(count, 13);
  assert.equal(count, hits.reduce((n, h) => n + h.count, 0), 'the preview counted the same places');
  assert.deepEqual(changed.map(c => `${c.path}:${c.count}`), ['index.html:12', 'about.html:1']);
  assert.equal(repo.live().get('about.html'), '<p>About the <a href="/brine.html">pickle</a>.</p>');
  assert.equal(repo.live().get('plain.html'), before.get('plain.html'));
  let really = 0;
  for (const [path, text] of repo.live()) {
    really += countMatches(text, 'pickle');
    assert.equal(text.split('pickle').join('brine'), before.get(path), `${path}: nothing but the words changed`);
  }
  assert.equal(really, count, 'the number said is the number of places in the saved files');
  assert.equal(repo.calls.filter(c => c.method === 'POST' && /\/git\/commits$/.test(c.path)).length, 1, 'still one commit');
  assert.equal(replacedText(count, changed.length, left, true), 'Replaced in 13 places on 2 pages. The site is updating, and Kiln will say when this page shows it. You can close this. 24 other places in addresses, style names or scripts were left as they were.');
  assert.equal(replacedText(1, 1, 1, false), 'Replaced in 1 place on 1 page. The site is updating, and will show it in a minute or two. You can close this. 1 other place in addresses, style names or scripts was left as it was.');
  assert.equal(replacedText(2, 1, 0, false), 'Replaced in 2 places on 1 page. The site is updating, and will show it in a minute or two. You can close this.');
});

test('find & replace: a page that is not UTF-8 stops the search as it did before, and nothing is written anywhere', async () => {
  const repo = fakeRepo(site(3));
  const before = new Map(repo.live());
  const gh = { request: async (method, path, body) => (method === 'GET' && /\/contents\/pages\/p1\.html\?/.test(path)
    ? { content: Buffer.from([0x3c, 0x70, 0x3e, 0x34, 0x30, 0x34, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]).toString('base64'), sha: 'latin1' }
    : repo.gh.request(method, path, body)) };
  await assert.rejects(findEverywhere({ gh, repo: REPO, branch: 'main', find: FIND, getFile }), e => e.code === 'NOT_UTF8');
  assert.deepEqual([...repo.live()], [...before]);
  assert.equal(repo.calls.filter(c => c.method !== 'GET').length, 0);
});
