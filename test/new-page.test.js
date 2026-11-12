/**
 * "New post or page" (src/editor/new-page.js, and where main.js uses it).
 *
 * A tester made a page on a site whose starting page had neither Kiln's two
 * script lines nor a line naming its character set: the new page had no Kiln
 * button and showed "L'Ã©tÃ©" for "L'été". And a post could not be made at
 * all, with a message about a data-cms-list container.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readyPage, kilnFilesOn, missingWords, noPostList, CHARSET_TAG, KILN_FILES } from '../src/editor/new-page.js';
import { notDone, said } from '../src/editor/plain-failure.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = readFileSync(path.join(ROOT, 'src', 'editor', 'main.js'), 'utf8');

const CONFIG = '<script src="/assets/kiln-config.js"></script>';
const EDITOR = '<script src="/assets/kiln.js" defer></script>';

// The starting page of the tester's site, in short: no character set, no Kiln.
const BARE = `<!doctype html>
<html lang="en">
<head>
  <title>{{title}} — Kiln E2e</title>
  <link rel="stylesheet" href="/assets/site.css">
</head>
<body>
  <main><h1 data-cms="page_title">Title</h1><p data-cms="page_body">Start writing here.</p></main>
</body>
</html>
`;

test('a starting page with neither gets its character set first in the head and Kiln before </body>', () => {
  const out = readyPage(BARE);
  assert.deepEqual(out.added, ['charset', 'config', 'editor']);
  assert.equal(out.html, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{{title}} — Kiln E2e</title>
  <link rel="stylesheet" href="/assets/site.css">
</head>
<body>
  <main><h1 data-cms="page_title">Title</h1><p data-cms="page_body">Start writing here.</p></main>
${CONFIG}
${EDITOR}
</body>
</html>
`);
  // the settings come before the editor that reads them
  assert.ok(out.html.indexOf(CONFIG) < out.html.indexOf(EDITOR));
});

test('a page that has them already is returned exactly as it is', () => {
  const once = readyPage(BARE).html;
  assert.deepEqual(readyPage(once), { html: once, added: [] });
  const old = '<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><title>t</title></head><body><script src="/assets/kiln-config.js"></script><script src="/assets/kiln.js?v=3" defer></script></body></html>';
  assert.deepEqual(readyPage(old), { html: old, added: [] });
  // a byte order mark at the top says the character set
  const bom = '﻿<html><head><title>t</title></head><body>' + CONFIG + EDITOR + '</body></html>';
  assert.deepEqual(readyPage(bom), { html: bom, added: [] });
});

test('only what is missing is added, and nothing else on the page moves', () => {
  const noCharset = `<html>\n<head>\n\t<title>t</title>\n</head>\n<body>\n\t<p>Hi</p>\n\t${CONFIG}\n\t${EDITOR}\n</body>\n</html>`;
  const a = readyPage(noCharset);
  assert.deepEqual(a.added, ['charset']);
  assert.equal(a.html, noCharset.replace('<head>\n\t<title>', `<head>\n\t${CHARSET_TAG}\n\t<title>`));

  const noKiln = `<html><head><meta charset="utf-8"><title>t</title></head>\n<body>\n  <p>Hi</p>\n  </body></html>`;
  const b = readyPage(noKiln);
  assert.deepEqual(b.added, ['config', 'editor']);
  assert.equal(b.html, noKiln.replace('  </body>', `  ${CONFIG}\n  ${EDITOR}\n  </body>`));

  // the editor is there and its settings are not: they go in front of it, on a line of their own
  const noConfig = `<html><head><meta charset="utf-8"></head><body>\n  <p>Hi</p>\n  ${EDITOR}\n</body></html>`;
  const c = readyPage(noConfig);
  assert.deepEqual(c.added, ['config']);
  assert.equal(c.html, noConfig.replace(`  ${EDITOR}`, `  ${CONFIG}\n  ${EDITOR}`));
});

test('a page with everything on one line, with no head, or with no body still comes out working', () => {
  const line = readyPage('<html><head><title>t</title></head><body><p>x</p></body></html>').html;
  assert.equal(line, `<html><head>${CHARSET_TAG}<title>t</title></head><body><p>x</p>${CONFIG}\n${EDITOR}\n</body></html>`);

  const noHead = readyPage('<!doctype html>\n<html>\n<body><p>x</p></body>\n</html>');
  assert.deepEqual(noHead.added, ['charset', 'config', 'editor']);
  assert.match(noHead.html, /^<!doctype html>\n<html>\n<meta charset="utf-8">\n<body>/);

  const scrap = readyPage('<h1>Hi</h1>');
  assert.equal(scrap.html, `${CHARSET_TAG}\n<h1>Hi</h1>\n${CONFIG}\n${EDITOR}\n`);
  assert.deepEqual(readyPage(scrap.html).added, []);

  const noBody = readyPage('<html><head><meta charset="utf-8"></head><p>x</p>\n</html>').html;
  assert.equal(noBody, `<html><head><meta charset="utf-8"></head><p>x</p>\n${CONFIG}\n${EDITOR}\n</html>`);
  assert.deepEqual(readyPage('').added, ['charset', 'config', 'editor']);
});

test('what is inside a comment does not count as being there', () => {
  const page = `<html><head><!-- <meta charset="utf-8"> --><title>t</title></head><body><!-- ${EDITOR} --></body></html>`;
  assert.deepEqual(readyPage(page).added, ['charset', 'config', 'editor']);
});

test('Kiln is loaded from where this site\'s pages load it', () => {
  // read off the page that is open: an address written from where that page is becomes one from the top of the site
  assert.deepEqual(kilnFilesOn(['/assets/site.js', '../assets/kiln-config.js', '../assets/kiln.js?v=2'], 'https://a.example/blog/post.html'),
    { config: '/assets/kiln-config.js', editor: '/assets/kiln.js?v=2' });
  assert.deepEqual(kilnFilesOn(['/kiln/kiln-config.js', 'https://cdn.example/kiln.js'], 'https://a.example/'),
    { config: '/kiln/kiln-config.js', editor: 'https://cdn.example/kiln.js' });
  assert.deepEqual(kilnFilesOn([null, '', '/assets/site.js'], 'https://a.example/'), { config: null, editor: null });

  const out = readyPage(BARE, { config: '/kiln/kiln-config.js', editor: '/kiln/kiln.js' });
  assert.match(out.html, /<script src="\/kiln\/kiln-config\.js"><\/script>\n<script src="\/kiln\/kiln\.js" defer><\/script>\n<\/body>/);
  // a site whose pages load no settings file is not given one; the editor is always loaded
  const bare = readyPage(BARE, kilnFilesOn([], 'https://a.example/'));
  assert.deepEqual(bare.added, ['charset', 'editor']);
  assert.ok(bare.html.includes(`<script src="${KILN_FILES.editor}" defer></script>`));
  // a page that sets Kiln up in a script of its own is not given the settings file on top
  const inline = '<html><head><meta charset="utf-8"></head><body><script>window.KILN_CONFIG = { repo: "a/b" };</script></body></html>';
  assert.deepEqual(readyPage(inline).added, ['editor']);
});

test('a missing file is told in plain words, with what the owner can do', () => {
  for (const what of ['page', 'post', 'card', 'blog']) {
    const s = notDone('Nothing was created.', said(missingWords(what)));
    assert.match(s, /^Nothing was created\. This site has no /);
    assert.doesNotMatch(s, /—|\btemplates?\b|container|see the docs|attribute|\brepo\b/i, what);
    assert.match(s, /\.$/);
  }
  assert.match(missingWords('page'), /_templates\/page\.html/);
  assert.match(missingWords('page'), /Whoever set up the site can add it/);
  assert.match(missingWords('post'), /_templates\/post\.html/);
  assert.match(missingWords('post'), /choose Page above/);
  assert.match(missingWords('card'), /_templates\/post-card\.html/);
  assert.match(missingWords('blog'), /blog\/index\.html/);
});

test('a blog page with no list for posts: what is missing, and what can be done today', () => {
  const withBlocks = noPostList({ blocks: true });
  assert.match(withBlocks, /^Kiln does not know which part of the blog page is the list of posts/);
  assert.match(withBlocks, /What you can do today: choose Page above/);
  assert.match(withBlocks, /"\+ Add block"/);
  assert.match(withBlocks, /link button/);
  const without = noPostList();
  assert.doesNotMatch(without, /Add block/);
  assert.match(without, /link to it from the blog page yourself/);
  // the one thing to pass on to whoever set the site up comes last
  for (const s of [withBlocks, without]) {
    assert.match(s, /whoever set up the site marks that list in blog\/index\.html with data-cms-list="post_list"\.$/);
    assert.doesNotMatch(s, /—|container|needs a/);
  }
});

test('main.js: every page it makes goes through readyPage, and a missing file or list is told in these words', () => {
  const make = main.slice(main.indexOf('function newContent()'), main.indexOf('function menuEditor()'));
  assert.match(main, /import \{ readyPage, kilnFilesOn, missingWords, noPostList \} from '\.\/new-page\.js';/);
  assert.match(make, /kilnFilesOn\(\[\.\.\.document\.scripts\]\.map\(s => s\.getAttribute\('src'\)\), location\.href\)/);
  // the post and the page alike, after the title and any draft are in
  assert.equal((make.match(/ready\(await aiDraft\(/g) || []).length, 2);
  assert.match(make, /need\('_templates\/post\.html', 'post'\)/);
  assert.match(make, /need\('_templates\/post-card\.html', 'card'\)/);
  assert.match(make, /need\('blog\/index\.html', 'blog'\)/);
  assert.match(make, /need\('_templates\/page\.html', 'page'\)/);
  assert.match(make, /said\(noPostList\(/);
  assert.doesNotMatch(make, /see the docs|needs a data-cms-list/);
});
