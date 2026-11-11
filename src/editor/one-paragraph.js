/**
 * Lists and block styles, and the parts of a page that cannot hold them.
 *
 * Many editable parts are a single paragraph, heading, line or link:
 * `<p data-cms>`, `<h2 data-cms>`, `<span data-cms>`. The toolbar's Bullet
 * list and Numbered list buttons and the Style menu's Body, Heading,
 * Subheading and Quote used to run on them anyway. The browser put a `<ul>`
 * or an `<h3>` inside the `<p>`, the page looked much the same while editing,
 * and that markup was staged and published; a browser reading the page again
 * moves the list out of the paragraph, so on the site the words landed outside
 * their box. Now, in a part that cannot hold them, those buttons say why
 * instead (main.js `renderToolbar`), and nothing is changed.
 *
 * A part that can hold blocks (a `<div data-cms>` rich area, a table cell, a
 * list item) keeps both. Two things the browser gets wrong there are put
 * right: it nests the new list inside the paragraph it came from
 * (`<p><ul>…</ul></p>`), and it puts the cursor at the start of the line, so
 * the next words typed land in the wrong place.
 *
 * Pure, and tested in node (on test/tiny-dom.js); main.js does the reading
 * of the page and the setting of the cursor.
 */

/** Elements that may hold paragraphs, lists and headings of their own. */
const HOLDS_BLOCKS = new Set([
  'div', 'section', 'article', 'aside', 'main', 'header', 'footer', 'nav', 'search',
  'li', 'td', 'th', 'dd', 'blockquote', 'figure', 'figcaption', 'details', 'dialog',
  'form', 'fieldset', 'body',
]);

/** Can an editable part with this tag name hold a list, a heading or a quote? */
export function holdsBlocks(tagName) {
  return HOLDS_BLOCKS.has(String(tagName || '').toLowerCase());
}

/** The toolbar commands and Style menu choices that make blocks. */
export const BLOCK_CMDS = ['insertUnorderedList', 'insertOrderedList'];

/** What the status line says when one of them is tried where it cannot go. */
export const NO_LIST_HERE = 'A list can’t go in this part of the page. It holds a single paragraph, so a list would spill out of it on your site.';
export const NO_FORMAT_HERE = 'This part of the page can’t be made a heading, a quote or body text. It holds a single paragraph, so it keeps its own look. Bold, italic and the site styles still work.';
/** The button's own hint, read when the pointer rests on it. */
export const NO_LIST_TITLE = 'A list can’t go in this part of the page';

const isText = (n) => n && n.nodeType === 3;
const isList = (n) => n && n.nodeType === 1 && /^(UL|OL)$/.test(n.tagName);
const textLen = (n) => (n.data ?? n.nodeValue ?? '').length;

/**
 * Where a point in `root` (a node and an offset, as a Range or a Selection
 * gives them) falls in its words, counted in characters. Kept before the
 * browser rebuilds the markup, so the point can be found again after.
 */
export function wordsBefore(root, node, offset) {
  let count = 0;
  let done = false;
  const walk = (n) => {
    if (done) return;
    if (n === node) {
      if (isText(n)) count += offset;
      else for (let i = 0; i < offset && i < n.childNodes.length; i++) walk(n.childNodes[i]);
      done = true;
      return;
    }
    if (isText(n)) { count += textLen(n); return; }
    for (const c of n.childNodes || []) { walk(c); if (done) return; }
  };
  walk(root);
  return count;
}

/** The point `count` characters into `root`'s words: { node, offset }, at the end of a run of words rather than the start of the next. */
export function pointAfter(root, count) {
  let left = count;
  let last = null;
  const walk = (n) => {
    if (isText(n)) {
      last = n;
      if (left <= textLen(n)) return { node: n, offset: left };
      left -= textLen(n);
      return null;
    }
    for (const c of n.childNodes || []) { const hit = walk(c); if (hit) return hit; }
    return null;
  };
  return walk(root) || (last ? { node: last, offset: textLen(last) } : { node: root, offset: (root.childNodes || []).length });
}

const empty = (p) => !p.textContent.replace(/[\s ​]/g, '')
  && !Array.from(p.childNodes || []).some(n => n.nodeType === 1 && n.tagName !== 'BR');

/**
 * Lists the browser nested inside a paragraph (`<p><ul>…</ul></p>`, which no
 * browser keeps as written) are moved out of it, into the place where the
 * paragraph was. Words before and after the list stay in paragraphs of their
 * own; a paragraph left empty goes. Returns how many paragraphs were mended.
 */
export function liftLists(root) {
  const paras = [];
  const find = (n) => { for (const c of n.childNodes || []) { if (c.nodeType !== 1) continue; if (c.tagName === 'P') paras.push(c); find(c); } };
  find(root);
  let mended = 0;
  for (const p of paras) {
    if (!Array.from(p.childNodes).some(isList)) continue;
    const parent = p.parentNode;
    const pieces = [];
    let cur = p.cloneNode(false);
    for (const n of Array.from(p.childNodes)) {
      if (isList(n)) { pieces.push(cur, n); cur = p.cloneNode(false); } else cur.appendChild(n);
    }
    pieces.push(cur);
    for (const piece of pieces) if (isList(piece) || !empty(piece)) parent.insertBefore(piece, p);
    p.remove();
    mended++;
  }
  return mended;
}
