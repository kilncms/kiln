import { test } from 'node:test';
import assert from 'node:assert';
import { autotag } from '../src/autotag.js';

const PAGE = `<!DOCTYPE html>
<html><head><title>T</title></head><body>
<header>
  <nav class="links"><a href="/">Home</a><a href="/a">A</a><a href="/b">B</a></nav>
</header>
<main>
  <section class="hero" id="hero">
    <h1>Welcome to the Bakery</h1>
    <p>Fresh bread every morning since 1982.</p>
    <img src="/img/hero.jpg" alt="bread">
  </section>
  <section class="cards">
    <div class="card"><h3>Sourdough</h3><p>Tangy and slow.</p><img src="/i/1.jpg"></div>
    <div class="card"><h3>Rye</h3><p>Dense and dark.</p><img src="/i/2.jpg"></div>
    <div class="card"><h3>Baguette</h3><p>Crisp crust.</p><img src="/i/3.jpg"></div>
  </section>
</main>
<footer><p>Call us: 555-0100</p></footer>
</body></html>`;

test('autotag: fields, image, repeat, menu, footer', () => {
  const { html, counts } = autotag(PAGE);
  assert.ok(counts.menu === 1 && /nav class="links" data-cms-menu="main"/.test(html));
  assert.ok(/<h1 data-cms="hero_welcome_to_the"/.test(html));
  assert.ok(/<p data-cms="hero_fresh_bread_every"/.test(html));
  assert.ok(/data-cms="hero_img" data-cms-attr="src"/.test(html));
  assert.equal(counts.repeats, 1);
  assert.ok(/<section class="cards" data-cms-repeat="cards_items">/.test(html));
  // shared keys across all three cards
  assert.equal((html.match(/data-cms="cards_items_title"/g) || []).length, 3);
  assert.equal((html.match(/data-cms="cards_items_body"/g) || []).length, 3);
  assert.equal((html.match(/data-cms="cards_items_img" data-cms-attr="src"/g) || []).length, 3);
  assert.ok(/footer_call_us/.test(html));
  // formatting preserved
  assert.ok(html.includes('<!DOCTYPE html>'));
});

test('autotag: idempotent — running twice adds nothing', () => {
  const once = autotag(PAGE).html;
  const twice = autotag(once);
  assert.equal(twice.html, once);
  assert.deepEqual(twice.counts, { fields: 0, images: 0, repeats: 0, menu: 0 });
});

test('autotag: leaves existing annotations + their subtrees alone', () => {
  const raw = '<html><body><main><section class="x"><p data-cms="mine">Keep me</p><p>Tag me please</p></section></main></body></html>';
  const { html } = autotag(raw);
  assert.equal((html.match(/data-cms="mine"/g) || []).length, 1);
  assert.ok(/<p data-cms="x_tag_me_please">Tag me please/.test(html));
});

test('autotag: no repeat on tables or menus; nothing inside nav tagged', () => {
  const raw = `<html><body><main>
    <table><tbody><tr><td>a</td></tr><tr><td>b</td></tr><tr><td>c</td></tr></tbody></table>
    <nav><a href="/">x</a><a href="/">y</a><a href="/">z</a><p>Nav text</p></nav>
  </main></body></html>`;
  const { html, counts } = autotag(raw);
  assert.ok(!/tbody[^>]*data-cms-repeat|tr[^>]*data-cms-repeat/.test(html), 'no table repeats');
  assert.ok(!/<p[^>]*data-cms[^>]*>Nav text/.test(html), 'nothing tagged inside nav');
});

test('autotag: annotation-only — stripping annotations recovers the original byte-for-byte', () => {
  const raw = `<html><body><main><section class="hero">
  <h1>Hi there</h1>
  <p>Body text here.</p>
</section></main></body></html>`;
  const { html } = autotag(raw);
  const stripped = html.replace(/ data-cms(-repeat|-menu|-attr|-plain)?(="[^"]*")?/g, '');
  assert.equal(stripped, raw);
});

test('autotag: utility class names are skipped for key prefixes', () => {
  const raw = '<html><body><main><section class="reveal wrap intro-block"><p>Some intro text.</p></section></main></body></html>';
  const { html } = autotag(raw);
  assert.ok(/data-cms="intro_block_some_intro_text"/.test(html), html);
});

// ── A part that is already marked keeps its inside and its outside ──

const strip = (html) => html.replace(/ data-cms(-repeat|-menu|-attr|-plain)?(="[^"]*")?/g, '');

test('autotag: nothing inside a part that is already marked is marked', () => {
  const raw = `<html><body><main><section class="story">
    <div data-cms="story_body">
      <p>In 2019 it started with one crock.</p>
      <p>Six years later we still brine the same way.</p>
      <img src="/crock.jpg" alt="">
    </div>
    <p>A paragraph outside it.</p>
  </section></main></body></html>`;
  const { html, counts } = autotag(raw);
  assert.deepEqual(counts, { fields: 1, images: 0, repeats: 0, menu: 0 });
  assert.match(html, /<p data-cms="story_a_paragraph_outside">A paragraph outside it\./);
  assert.match(html, /<div data-cms="story_body">\s*<p>In 2019/, 'the marked block is as it was, inside too');
});

test('autotag: nothing that holds a marked part is marked', () => {
  const raw = `<html><body><main><section class="posts">
    <h3 class="title"><a data-cms="teaser_1_link" href="/a">The Monday Brine</a></h3>
    <p class="center"><a class="btn" data-cms="journal_cta" href="/blog">Read the journal</a></p>
    <blockquote><span data-cms="quote_text">Best pickle in the state.</span> said nobody yet.</blockquote>
    <figure><img data-cms="pic" data-cms-attr="src" src="/a.jpg"><figcaption>A caption with <b data-cms="cap_bold">a marked word</b></figcaption></figure>
    <h3>A heading with no mark in it</h3>
  </section></main></body></html>`;
  const { html, counts } = autotag(raw);
  assert.deepEqual(counts, { fields: 1, images: 0, repeats: 0, menu: 0 });
  assert.match(html, /<h3 data-cms="posts_a_heading_with">A heading with no mark in it/);
  assert.match(html, /<h3 class="title"><a data-cms="teaser_1_link"/, 'the heading around a marked link is left alone');
  assert.match(html, /<p class="center"><a class="btn" data-cms="journal_cta"/);
  assert.match(html, /<blockquote><span data-cms="quote_text">/);
  assert.match(html, /<figcaption>A caption with/);
});

test('autotag: a group with a mark anywhere inside is not turned into a list', () => {
  const card = (n, mark) => `<div class="card"><h3${mark ? ` data-cms="card_${n}_title"` : ''}>Card ${n}</h3><p>Words for card ${n}.</p></div>`;
  const raw = `<html><body><main><section class="cards">${card(1, true)}${card(2, false)}${card(3, false)}</section></main></body></html>`;
  const { html, counts } = autotag(raw);
  assert.equal(counts.repeats, 0);
  assert.doesNotMatch(html, /data-cms-repeat/);
  assert.match(html, /<h3 data-cms="card_1_title">Card 1</, 'the mark someone made is as it was');
  // What is not marked in those cards is still found, each as its own part.
  assert.match(html, /<p data-cms="card_words_for_card">Words for card 1\./);
  assert.match(html, /<h3 data-cms="card_card_2">Card 2</);
  assert.equal(counts.fields, 5);
  assert.equal(strip(html), strip(raw));
});

test('autotag: a row of short labels with nothing to mark inside them is not made a list', () => {
  const raw = `<html><body><main><section class="hero">
    <div class="pill-row"><span class="pill">No high-fructose anything</span><span class="pill">Fermented, not faked</span><span class="pill">Annoyingly good crunch</span></div>
    <ul class="plain"><li>One</li><li>Two</li><li>Three</li></ul>
    <ul class="rich"><li><p>One with a paragraph</p></li><li><p>Two with a paragraph</p></li><li><p>Three with a paragraph</p></li></ul>
  </section></main></body></html>`;
  const { html, counts } = autotag(raw);
  assert.equal(counts.repeats, 1, 'only the list whose blocks hold something that can be reworded');
  assert.match(html, /<ul class="rich" data-cms-repeat="hero_items">/);
  assert.doesNotMatch(html, /pill-row" data-cms-repeat|class="plain" data-cms-repeat/);
});

test('autotag: a menu that is already marked, wherever it is, is left alone inside', () => {
  const raw = `<html><body><main><div class="side" data-cms-menu="side"><p>Menu words</p><a href="/">a</a></div><p>Outside words here.</p></main></body></html>`;
  const { html, counts } = autotag(raw);
  assert.deepEqual(counts, { fields: 1, images: 0, repeats: 0, menu: 0 });
  assert.match(html, /<p>Menu words<\/p>/);
});

test('autotag: a footer inside <main> is passed over once, and no element is ever marked twice', () => {
  const raw = `<html><body><main><section class="a"><p>Some words here.</p></section>
    <footer><blockquote><p>Words in the footer.</p></blockquote><h4>Say hello</h4></footer></main></body></html>`;
  const { html, counts } = autotag(raw);
  assert.equal(counts.fields, 3);
  assert.doesNotMatch(html, /data-cms="[^"]*"\s+data-cms="/, 'one mark each');
  assert.doesNotMatch(html, /<blockquote data-cms/, 'the quote holds the paragraph that was marked');
  assert.equal(autotag(html).html, html, 'and a second run adds nothing');
});

test('autotag: with a footer outside <main>, parts already marked in it keep their inside and outside', () => {
  const raw = `<html><body><main><p>Some words here.</p></main>
    <footer><div data-cms="foot_block"><p>Inside a marked block.</p></div><p><a data-cms="foot_link" href="/x">A marked link</a></p>
    <ul data-cms-repeat="foot_links"><li><p>In a list already</p></li></ul><h4>Say hello</h4></footer></body></html>`;
  const { html, counts } = autotag(raw);
  assert.equal(counts.fields, 2, 'the paragraph in <main> and the footer heading');
  assert.match(html, /<h4 data-cms="footer_say_hello">/);
  assert.match(html, /<div data-cms="foot_block"><p>Inside a marked block\.<\/p>/);
  assert.match(html, /<p><a data-cms="foot_link"/);
  assert.match(html, /<li><p>In a list already<\/p><\/li>/);
});
