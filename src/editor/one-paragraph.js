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

// ─── What a single paragraph, heading or line may hold ───────────────────────
//
// A part that is one paragraph or one heading holds words and inline
// formatting. A browser reading the page ends a paragraph at the first
// heading, paragraph, list or table inside it, so anything of that kind put
// into such a part lands outside it on the site: the part comes out empty,
// and the rest sits where no tool of the editor can reach it. That is what
// text pasted from a web page did. Two things keep it out. A paste into such
// a part is brought in as words with the formatting the toolbar itself offers
// (`inlineHtml` with `strict`). And when an edit is kept, whatever block
// markup the part holds all the same (the browser makes a `<div>` for each
// Enter) is turned into line breaks (`inlineHtml`).

/** Elements that end a paragraph or a heading when they are put inside one. */
const BLOCKS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CAPTION', 'CENTER', 'DD', 'DETAILS',
  'DIALOG', 'DIR', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4',
  'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'HTML', 'LI', 'MAIN', 'MENU', 'NAV', 'OL', 'P', 'PRE', 'SEARCH', 'SECTION',
  'SUMMARY', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR', 'UL']);
const CELLS = new Set(['TD', 'TH']);
/** Never brought in by a paste: pictures, embeds, code and form controls. */
const NOT_PASTED = new Set(['IMG', 'PICTURE', 'SOURCE', 'SVG', 'MATH', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED',
  'CANVAS', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK', 'BASE', 'INPUT', 'SELECT',
  'TEXTAREA', 'BUTTON', 'MAP', 'AREA']);
/** The formatting the toolbar offers (bold, italic, underline, a link): what a paste may bring with its words. */
const PASTED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'A']);
const VOID = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'SOURCE', 'TRACK', 'WBR']);
/** An address a pasted link may keep: on this site, or the web, an email, a phone. */
const LINK_OK = /^(?:https?:|mailto:|tel:|[^a-z]|[a-z0-9+.-]*(?:[^a-z0-9+.:-]|$))/i;

const tagOf = (n) => String(n.tagName || '').toUpperCase();
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const styleOf = (n) => (n.getAttribute && n.getAttribute('style')) || '';
const wordless = (n) => !String(n.textContent || '').replace(/[\s​]/g, '');

/** Does this part hold markup that a single paragraph or heading cannot? */
export function holdsBlockMarkup(root) {
  for (const c of root.childNodes || []) {
    if (c.nodeType !== 1) continue;
    if (BLOCKS.has(tagOf(c)) || CELLS.has(tagOf(c)) || holdsBlockMarkup(c)) return true;
  }
  return false;
}

/**
 * The inside of `root` as a single paragraph or heading can hold it: its
 * words and inline elements, with a line break where a block began or ended
 * and a space between the cells of a table.
 *
 * As it is, the page's own inline elements are kept exactly (a `<span>` with
 * the site's class, a picture that was already in the line). With `strict`,
 * for what is pasted from elsewhere: only bold, italic, underline and links
 * are kept, with no class and no style; a link keeps its address and nothing
 * else; pictures, embeds and code are left out.
 */
export function inlineHtml(root, { strict = false } = {}) {
  let out = '';
  let gap = '';   // what stands before the next words: nothing, a space or a line break
  const put = (s) => { if (out) out += gap; gap = ''; out += s; };
  const brk = () => { if (out) gap = '<br>'; };
  const space = () => { if (out && !gap) gap = ' '; };
  const walk = (node) => {
    const kids = Array.from(node.childNodes || []);
    kids.forEach((c, at) => {
      if (c.nodeType === 3) {
        let t = String(c.data ?? c.nodeValue ?? '');
        if (strict) t = t.replace(/[ \t\r\n\f]+/g, ' ');
        if (!/[^ \t\r\n\f]/.test(t)) { if (t) space(); return; }
        if (!out || gap) t = t.replace(/^[ \t\r\n\f]+/, '');
        put(escText(t));
        return;
      }
      if (c.nodeType !== 1) return;   // a comment
      const tag = tagOf(c);
      if (tag === 'BR') {
        // the last thing in a block is the browser's own filler, not a line the person made
        const last = kids.slice(at + 1).every(k => k.nodeType !== 1 && wordless(k));
        if (last && (BLOCKS.has(tagOf(node)) || CELLS.has(tagOf(node)))) return;
        if (out) { out += (gap === '<br>' ? gap : '') + '<br>'; gap = ''; }
        return;
      }
      if (strict && NOT_PASTED.has(tag)) return;
      if (BLOCKS.has(tag)) {
        brk();
        const before = out.length;
        if (tag !== 'HR') walk(c);
        // an empty line the person made with Enter
        if (out && out.length === before && wordless(c) && Array.from(c.childNodes || []).some(k => tagOf(k) === 'BR')) out += '<br>';
        brk();
        return;
      }
      if (CELLS.has(tag)) { space(); walk(c); space(); return; }
      if (!strict) {
        let open = `<${tag.toLowerCase()}`;
        for (const a of Array.from(c.attributes || [])) open += ` ${a.name}="${escAttr(a.value)}"`;
        put(VOID.has(tag) ? `${open}>` : `${open}>${inlineHtml(c)}</${tag.toLowerCase()}>`);
        return;
      }
      // Pasted. What a word processor writes as a style is read as the formatting it stands for.
      const style = styleOf(c);
      const bold = /font-weight\s*:\s*(bold|[6-9]00)/i.test(style), plainWeight = /font-weight\s*:\s*(normal|[1-4]00)/i.test(style);
      const slanted = /font-style\s*:\s*italic/i.test(style);
      let wrap = null;
      if (tag === 'A') {
        const href = (c.getAttribute('href') || '').trim();
        if (href && LINK_OK.test(href) && !/^\s*javascript:/i.test(href)) wrap = [`<a href="${escAttr(href)}">`, '</a>'];
      } else if (PASTED.has(tag)) {
        if (!((tag === 'B' || tag === 'STRONG') && plainWeight)) wrap = [`<${tag.toLowerCase()}>`, `</${tag.toLowerCase()}>`];
      } else if (bold) wrap = ['<strong>', '</strong>'];
      else if (slanted) wrap = ['<em>', '</em>'];
      if (!wrap) { walk(c); return; }
      const inner = inlineHtml(c, { strict });
      if (inner) put(wrap[0] + inner + wrap[1]);
    });
  };
  walk(root);
  return out.replace(/(?:\s|<br>)+$/, '');
}
