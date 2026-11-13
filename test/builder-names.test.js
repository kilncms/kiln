import { test } from 'node:test';
import assert from 'node:assert';
import { autotag } from '../src/autotag.js';
import { isBuilderName, withoutBuilderLead } from '../src/builder-words.js';
import { readableName, plainName } from '../src/editor/names.js';

const keysOf = (html) => [...html.matchAll(/data-cms(?:-repeat)?="([^"]*)"/g)].map(m => m[1]);
const page = (inner) => `<!doctype html><html><head><title>t</title></head><body>${inner}</body></html>`;

test('isBuilderName: a page builder\'s, a theme\'s and a shop plugin\'s own classes', () => {
  for (const n of ['elementor-widget-container', 'elementor-element-3f2a1b', 'elementor', 'e-con-inner', 'wp-block-group',
    'astra-shop-thumbnail-wrap', 'ast-container', 'et_pb_section', 'fl-row', 'sqs-block-content', 'wix-rich-text',
    'woocommerce', 'woocommerce-loop-product__title', 'hfe-infocard', 'swiper-slide', 'post-12', 'type-page',
    'status-publish', 'entry-content', 'hentry', 'product_cat-women', 'sidebar-widget']) {
    assert.strictEqual(isBuilderName(n), true, n);
  }
});

test('isBuilderName: a page\'s own names are not a builder\'s', () => {
  for (const n of ['hero', 'about-us', 'team', 'products', 'product', 'site-header', 'footer', 'pricing-table', 'post',
    'entry', 'e', 'status-bar', 'type-scale', 'testimonials', 'contact', 'page']) {
    assert.strictEqual(isBuilderName(n), false, n);
  }
});

const ELEMENTOR = page(`<div class="elementor elementor-12"><div class="elementor-element elementor-element-3f2a1b e-con">
  <div class="elementor-element elementor-widget elementor-widget-heading"><div class="elementor-widget-container"><h2 class="elementor-heading-title">Featured Products</h2></div></div>
  <div class="elementor-element elementor-widget elementor-widget-text-editor"><div class="elementor-widget-container"><p>Raining offers for hot summer days.</p></div></div>
  <div class="elementor-element elementor-widget elementor-widget-image"><div class="elementor-widget-container"><img src="a.jpg" alt="Worldwide shipping"></div></div>
  <div class="elementor-element elementor-widget elementor-widget-image"><div class="elementor-widget-container"><img src="b.jpg" alt=""></div><div class="elementor-widget-container"><img src="c.jpg"></div></div>
</div></div>`);

test('autotag: on a page builder\'s page a part is named from its words, a picture from its description or its place', () => {
  const keys = keysOf(autotag(ELEMENTOR).html);
  assert.deepStrictEqual(keys, ['featured_products_heading', 'raining_offers_for', 'worldwide_shipping_img', 'page_img', 'page_img_2']);
});

test('autotag: no name carries a builder\'s word or a word cut short', () => {
  const shop = page(`<div class="ast-container"><ul class="products columns-4">
    <li class="ast-article-post product type-product post-49"><div class="astra-shop-thumbnail-wrap"><a href="/p/1"><img src="1.jpg" alt=""></a></div><div class="astra-shop-summary-wrap"><h2 class="woocommerce-loop-product__title">DNK Yellow Shoes</h2></div></li>
    <li class="ast-article-post product type-product post-50"><div class="astra-shop-thumbnail-wrap"><a href="/p/2"><img src="2.jpg" alt=""></a></div><div class="astra-shop-summary-wrap"><h2 class="woocommerce-loop-product__title">Dark Brown Jeans</h2></div></li>
  </ul></div><div class="wp-block-group"><p>A commitment to quality.</p></div><div class="et_pb_section"><div class="fl-row"><p>Our story so far.</p></div></div>`);
  const keys = [...keysOf(autotag(ELEMENTOR).html), ...keysOf(autotag(shop).html)];
  assert.ok(keys.includes('shop_img') && keys.includes('shop_img_2'), keys.join(' '));
  assert.ok(keys.includes('dnk_yellow_shoes_heading') && keys.includes('a_commitment_to') && keys.includes('our_story_so'), keys.join(' '));
  for (const k of keys) {
    assert.doesNotMatch(k, /(^|_)(elementor|widg|widget|imag|wp|block|astra|ast|woocommerce|et|pb|fl|sqs|wix|post|type)(_|$)/, k);
  }
});

test('autotag: a shop\'s list of products is named for the shop', () => {
  const li = (n) => `<li class="ast-article-post product type-product"><div class="astra-shop-thumbnail-wrap"><img src="${n}.jpg" alt=""></div><h2 class="woocommerce-loop-product__title">Product number ${n}</h2></li>`;
  const html = autotag(page(`<div class="woocommerce"><ul class="products">${li(1)}${li(2)}${li(3)}</ul></div>`)).html;
  assert.match(html, /<ul class="products" data-cms-repeat="shop_items">/);
  assert.ok(keysOf(html).includes('shop_items_title') && keysOf(html).includes('shop_items_img'));
});

test('autotag: in a builder\'s header and footer the place comes first', () => {
  const html = autotag(page(`<header class="site-header"><div class="ast-builder-layout-element"><p>Free delivery this week</p><img src="logo.png"></div></header>
    <main><div class="elementor-widget-container"><h1>Welcome to the shop</h1></div></main>`)).html;
  // The header's picture is marked now (its words are not), and its name puts the place first too.
  assert.deepStrictEqual(keysOf(html), ['header_img', 'welcome_to_the_heading']);
  const all = autotag(page(`<header><div class="ast-builder-layout-element"><p>Free delivery this week</p><img src="logo.png"></div></header><aside><div class="widget"><h3>Recent posts</h3></div></aside>`)).html;
  assert.deepStrictEqual(keysOf(all), ['header_free_delivery_this', 'header_img', 'sidebar_recent_posts_heading']);
});

test('autotag: a page that names its own parts is named as before', () => {
  const html = autotag(page(`<section class="hero"><h1>Welcome home</h1><img src="x.jpg" alt="A house"></section><div><p>Some words here</p></div>`)).html;
  assert.deepStrictEqual(keysOf(html), ['hero_welcome_home', 'hero_img', 'page_some_words_here']);
});

test('autotag: a name is never cut in the middle of a word', () => {
  const html = autotag(page(`<section class="testimonials-section"><p>International organisation conference</p></section>`)).html;
  assert.deepStrictEqual(keysOf(html), ['testimonials_international_organisation']);
});

test('autotag: a part that already has a name keeps it, builder\'s words and all', () => {
  const marked = page(`<div class="elementor-widget-container"><h2 data-cms="elementor_widg_featured_products">Featured Products</h2><p>New words beside it.</p></div>`);
  const html = autotag(marked).html;
  assert.match(html, /<h2 data-cms="elementor_widg_featured_products">Featured Products<\/h2>/);
  assert.deepStrictEqual(keysOf(html), ['elementor_widg_featured_products', 'new_words_beside']);
});

test('readableName: a name made from a builder\'s class is shown without the builder\'s words', () => {
  assert.strictEqual(readableName('elementor_widg_featured_products'), 'Featured products');
  assert.strictEqual(readableName('astra_shop_img_2'), 'Shop picture 2');
  assert.strictEqual(readableName('elementor_imag_img_3'), 'Picture 3');
  assert.strictEqual(readableName('wp_block_a_commitment_to'), 'A commitment to');
  assert.strictEqual(readableName('swiper_slide_img_5'), 'Slide picture 5');
  assert.strictEqual(readableName('hfe_infocard_special_edition'), 'Special edition');
  assert.strictEqual(readableName('et_pb_our_story'), 'Our story');
  assert.strictEqual(plainName('elementor_widg'), 'a section');
});

test('readableName: the new names and a page\'s own names read as they are', () => {
  assert.strictEqual(readableName('featured_products_heading'), 'Featured products heading');
  assert.strictEqual(readableName('shop_img_2'), 'Shop picture 2');
  assert.strictEqual(readableName('hero_headline'), 'Hero headline');
  assert.strictEqual(readableName('footer_quick_links'), 'Footer quick links');
  assert.strictEqual(readableName('our_widget_range'), 'Our widget range');
  assert.strictEqual(readableName('e_mail_address'), 'E mail address');
  assert.deepStrictEqual(withoutBuilderLead(['et', 'voila']), ['et', 'voila']);
});
