import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlockManifest, blockTitleFromPath, collectCmsKeys, uniquifyCmsKeys, EXAMPLE_BLOCK } from '../src/editor/blocks.js';
import { indexHtml, insertAfterNthTag } from '../src/engine.js';

// ─── parseBlockManifest ──────────────────────────────────────────────────────

test('parseBlockManifest: first-line manifest names the block and is stripped', () => {
  const src = '<!-- kiln-block: {"title":"Hero with photo","description":"Big image, headline."} -->\n<section><h1 data-cms="hero">Hi</h1></section>';
  const b = parseBlockManifest(src);
  assert.equal(b.title, 'Hero with photo');
  assert.equal(b.description, 'Big image, headline.');
  assert.equal(b.html, '<section><h1 data-cms="hero">Hi</h1></section>');
});

test('parseBlockManifest: no manifest → nulls, html untouched', () => {
  const src = '<section>plain</section>';
  const b = parseBlockManifest(src);
  assert.equal(b.title, null);
  assert.equal(b.description, null);
  assert.equal(b.html, src);
});

test('parseBlockManifest: broken JSON still strips the comment, yields no title', () => {
  const b = parseBlockManifest('<!-- kiln-block: {title: nope} -->\n<section>x</section>');
  assert.equal(b.title, null);
  assert.equal(b.html, '<section>x</section>');
});

test('parseBlockManifest: a kiln-block comment NOT on the first line is content, not manifest', () => {
  const src = '<section>x</section>\n<!-- kiln-block: {"title":"Late"} -->';
  const b = parseBlockManifest(src);
  assert.equal(b.title, null);
  assert.equal(b.html, src);
});

test('parseBlockManifest: BOM and leading spaces before the manifest are tolerated', () => {
  const b = parseBlockManifest('﻿  <!-- kiln-block: {"title":"T"} -->\r\n<section>x</section>');
  assert.equal(b.title, 'T');
  assert.equal(b.html, '<section>x</section>');
});

// ─── blockTitleFromPath ──────────────────────────────────────────────────────

test('blockTitleFromPath: humanizes the filename', () => {
  assert.equal(blockTitleFromPath('_blocks/feature-cards.html'), 'Feature cards');
  assert.equal(blockTitleFromPath('_blocks/photo_strip.html'), 'Photo strip');
  assert.equal(blockTitleFromPath('hero.html'), 'Hero');
  assert.equal(blockTitleFromPath('_blocks/two--column__text.html'), 'Two column text');
});

// ─── collectCmsKeys ──────────────────────────────────────────────────────────

test('collectCmsKeys: finds data-cms, -repeat, -menu, -list; ignores -attr and -plain', () => {
  const html = `<section data-cms-repeat="cards" data-kiln-gallery>
    <h3 data-cms="card_title">A</h3>
    <img data-cms="pic" data-cms-attr="src" src="x.jpg">
    <span data-cms='single_quoted' data-cms-plain>text</span>
    <nav data-cms-menu="main"></nav>
    <div data-cms-list="post_list"></div>
  </section>`;
  const keys = collectCmsKeys(html);
  assert.deepEqual([...keys].sort(), ['card_title', 'cards', 'main', 'pic', 'post_list', 'single_quoted']);
  assert.equal(keys.has('src'), false);   // data-cms-attr's value is an attr NAME, never a key
});

test('collectCmsKeys: dedupes repeated keys and reads unquoted values', () => {
  const keys = collectCmsKeys('<div data-cms=one></div><p data-cms="one"></p><p data-cms="two"></p>');
  assert.deepEqual([...keys].sort(), ['one', 'two']);
});

// ─── uniquifyCmsKeys ─────────────────────────────────────────────────────────

test('uniquifyCmsKeys: no collision → unchanged', () => {
  const html = '<section><h2 data-cms="fresh">x</h2></section>';
  const out = uniquifyCmsKeys(html, new Set(['other']));
  assert.equal(out.html, html);
  assert.equal(out.renames.size, 0);
});

test('uniquifyCmsKeys: colliding keys get _2 (then _3…) suffixes', () => {
  const out = uniquifyCmsKeys('<h2 data-cms="title">x</h2>', new Set(['title', 'title_2']));
  assert.equal(out.renames.get('title'), 'title_3');
  assert.equal(out.html, '<h2 data-cms="title_3">x</h2>');
});

test('uniquifyCmsKeys: a key repeated inside the block renames consistently', () => {
  const html = '<div data-cms-repeat="cards"><h3 data-cms="card_t">A</h3><h3 data-cms="card_t">B</h3></div>';
  const out = uniquifyCmsKeys(html, new Set(['cards', 'card_t']));
  assert.equal(out.renames.get('cards'), 'cards_2');
  assert.equal(out.renames.get('card_t'), 'card_t_2');
  assert.equal(out.html,
    '<div data-cms-repeat="cards_2"><h3 data-cms="card_t_2">A</h3><h3 data-cms="card_t_2">B</h3></div>');
});

test('uniquifyCmsKeys: covers -repeat, -menu and -list; leaves data-cms-attr alone', () => {
  const html = '<nav data-cms-menu="main"></nav><div data-cms-list="posts"></div>'
    + '<img data-cms="img" data-cms-attr="src">';
  const out = uniquifyCmsKeys(html, new Set(['main', 'posts', 'img']));
  assert.equal(out.html,
    '<nav data-cms-menu="main_2"></nav><div data-cms-list="posts_2"></div>'
    + '<img data-cms="img_2" data-cms-attr="src">');
});

test('uniquifyCmsKeys: a rename never collides with another key already in the block', () => {
  // "a" collides with the page; "a_2" is already used INSIDE the block → a → a_3.
  const html = '<p data-cms="a">x</p><p data-cms="a_2">y</p>';
  const out = uniquifyCmsKeys(html, new Set(['a']));
  assert.equal(out.renames.get('a'), 'a_3');
  assert.equal(out.html, '<p data-cms="a_3">x</p><p data-cms="a_2">y</p>');
});

test('uniquifyCmsKeys: preserves single quotes and quotes bare values', () => {
  const out = uniquifyCmsKeys("<p data-cms='k'>x</p><p data-cms=k>y</p>", new Set(['k']));
  assert.equal(out.html, `<p data-cms='k_2'>x</p><p data-cms="k_2">y</p>`);
});

// ─── the starter block ───────────────────────────────────────────────────────

test('EXAMPLE_BLOCK: carries a valid manifest and the keys the docs promise', () => {
  const { title, html } = parseBlockManifest(EXAMPLE_BLOCK);
  assert.equal(title, 'Feature cards');
  const keys = collectCmsKeys(html);
  assert.equal(keys.has('cards'), true);        // the data-cms-repeat container
  assert.equal(keys.has('cards_title'), true);
  assert.equal(html.includes('<script'), false);
});

// ─── the whole staging pipeline, minus the DOM ───────────────────────────────

test('uniquified block splices into a page via insertAfterNthTag and indexes cleanly', () => {
  const page = '<html><body><main><section id="hero"><h1 data-cms="cards_title">Hi</h1></section></main></body></html>';
  const taken = new Set(indexHtml(page).fields.keys());        // { cards_title }
  const { html } = uniquifyCmsKeys(parseBlockManifest(EXAMPLE_BLOCK).html, taken);
  const out = insertAfterNthTag(page, 'section', 0, '\n' + html.trim() + '\n');
  const { fields, warnings } = indexHtml(out);
  assert.equal(fields.get('cards_title').key, 'cards_title');  // the page's own key survives
  assert.equal(fields.get('cards_title_2').tag, 'h2');         // the block's renamed heading
  assert.equal(fields.get('cards').kind, 'repeat');            // the repeat container arrives intact
  assert.equal(warnings.length, 0);                            // no duplicate-key warnings
});
