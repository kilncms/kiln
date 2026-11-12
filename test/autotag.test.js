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

// ─── names never come from styling classes ──────────────────────────────────

test('isStylingName: utility classes of styling frameworks are told from names', async () => {
  const { isStylingName } = await import('../src/autotag.js');
  const styling = ['mx-auto', 'gap-10', 'mt-6', 'p-4', 'px-6', 'flex', 'grid', 'hidden', 'relative', 'container', 'text-lg', 'text-center',
    'md:grid-cols-3', 'hover:bg-white', 'w-1/2', 'p-[3px]', '-mt-2', '!mt-0', 'bg-white', 'bg-gray-100', 'max-w-3xl', 'min-h-screen',
    'items-center', 'justify-between', 'font-bold', 'rounded-xl', 'shadow-md', 'border-b', 'hairline-t', 'grid-cols-3', 'flex-col',
    'col-md-6', 'row-span-2', 'space-y-4', 'z-10', 'top-0', 'order-2', 'list-none', 'self-center', 'float-right', 'sr-only',
    'd-flex', 'btn-sm', 'w-full', 'leading-6', 'tracking-wide', 'opacity-50', 'duration-300', 'from-blue-500', 'col-6', 'section-2', 'root', 'app'];
  for (const c of styling) assert.equal(isStylingName(c), true, `${c} is styling`);
  const names = ['hero', 'card', 'footer', 'intro-block', 'card-1', 'teaser-1', 'cards', 'story', 'foot', 'journal', 'posts', 'quote',
    'about-us', 'site-header', 'main-nav', 'pricing', 'tonight', 'top-bar', 'order-form', 'from-the-blog', 'place-list', 'self-care',
    'content-area', 'list-events', 'hero_banner', 'Team', 'contact', 'x'];
  for (const c of names) assert.equal(isStylingName(c), false, `${c} is a name`);
});

test('autotag: on a page styled with utility classes, names come from the ids and classes that mean something', () => {
  const html = `<!doctype html><html><body><div id="root">
<section id="tonight" class="mx-auto max-w-3xl px-6">
  <div class="flex gap-10 hairline-t"><p class="mt-6 text-lg">Thursday, November 12</p><img src="/a.jpg" alt=""></div>
</section>
<section class="mx-auto py-20 pricing md:grid-cols-3"><div class="mt-6"><h2 class="text-2xl font-bold">What it costs</h2></div></section>
<div class="mx-auto mt-6"><div class="gap-10 flex"><p>The shows you would have missed.</p></div></div>
</div></body></html>`;
  const out = autotag(html).html;
  assert.match(out, /data-cms="tonight_thursday_november_12"/);
  assert.match(out, /data-cms="tonight_img"/);
  assert.match(out, /data-cms="pricing_what_it_costs"/);
  assert.match(out, /data-cms="page_the_shows_you"/, 'nothing meaningful around it: the plain "page", never a styling class or the app\'s root element');
  assert.doesNotMatch(out, /data-cms="(mx_auto|gap_10|mt_6|hairline_t|flex|root|text|py_20|md)/);
});
