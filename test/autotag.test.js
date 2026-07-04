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
