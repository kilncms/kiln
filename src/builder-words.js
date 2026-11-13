/**
 * The words of the tools that build pages, as opposed to the words of a page.
 *
 * A page made with WordPress, Elementor, Squarespace or Wix carries that
 * tool's own class names on every part ("elementor-widget-container",
 * "astra-shop-thumbnail-wrap", "wp-block-group", "et_pb_section"). They say
 * which tool made the part and nothing about what the part is, so they are no
 * name for it: a shop owner who is shown "Elementor widg featured products"
 * does not know what a "widg" is.
 *
 * Two readers: the first pass (src/autotag.js) does not make names out of
 * these, and the editor (src/editor/names.js) leaves them out of the name it
 * shows for a part that was named before this existed. No imports, so the
 * editor's bundle takes nothing else with it.
 */

// A tool's name anywhere in a class or id makes it the tool's.
const ANYWHERE = new Set(['elementor', 'elementskit', 'widget', 'widg', 'woocommerce', 'wordpress', 'gutenberg', 'astra',
  'wix', 'squarespace', 'shopify', 'webflow', 'divi', 'avada', 'kadence', 'generateblocks', 'swiper', 'hentry', 'wpforms']);

// The short mark a tool puts at the front of its classes: wp-block-group,
// et_pb_section, fl-row, sqs-block, e-con, ast-container, entry-content.
const FIRST = new Set(['wp', 'wc', 'woo', 'et', 'fl', 'sqs', 'ast', 'hfe', 'uagb', 'vc', 'wpb', 'kt', 'kb', 'gb', 'brxe', 'oxy',
  'ct', 'tve', 'thrv', 'jet', 'eael', 'ekit', 'e', 'entry', 'fusion', 'avia', 'nectar', 'tdb', 'wsite']);

// What WordPress writes on every post, page and product: post-12, type-page, status-publish, product_cat-shoes.
const WP_POST_RE = /^(post|page|product|attachment|comment|menu-item|page-item|page-id|postid|term|cat|tag|category|parent-pageid)[-_]\d+$|^(type|status|format)-(post|page|product|attachment|publish|draft|private|standard|aside|gallery|link|image|quote|video|audio|chat)$|^product[-_](cat|tag|type)-/;

/** True when an id or class is a page builder's, a theme's or a shop plugin's own, so it is no name for a part of the page. */
export function isBuilderName(name) {
  const n = String(name).toLowerCase();
  if (WP_POST_RE.test(n)) return true;
  const parts = n.split(/[-_]+/).filter(Boolean);
  if (parts.some(p => ANYWHERE.has(p))) return true;
  return parts.length > 1 && FIRST.has(parts[0]);
}

// At the front of a name that was made from such a class: the tool's word,
// then the word its class had next, whole or cut short by the 14 letters a
// name's first half was once held to ("elementor_widg", "elementor_imag").
const LEAD = new Set([...ANYWHERE, 'wp', 'wc', 'woo', 'sqs', 'ast', 'hfe', 'uagb', 'vc', 'wpb', 'brxe', 'eael', 'ekit']);
const NEXT = new Set(['widg', 'widget', 'imag', 'elem', 'element', 'sect', 'section', 'colu', 'column', 'cont', 'container',
  'block', 'pb', 'module', 'row', 'col', 'inner', 'infocard']);

/**
 * The words of a stored name without the tool's words in front:
 * [elementor, widg, featured, products] → [featured, products],
 * [astra, shop, img, 2] → [shop, img, 2]. Words further in are the page's
 * own and stay ("our widget range"). Lower-case words in, the rest out.
 */
export function withoutBuilderLead(words) {
  let i = 0, met = false;
  for (; i < words.length; i++) {
    const w = words[i];
    if (LEAD.has(w)) { met = true; continue; }
    if ((w === 'et' && words[i + 1] === 'pb') || (w === 'fl' && NEXT.has(words[i + 1]))) { met = true; continue; }
    if (met && NEXT.has(w)) continue;
    break;
  }
  return words.slice(i);
}
