/**
 * The links of a site menu, read from a page's own text and written back into
 * it (the Site menu tool in main.js; the save itself is menu-save.js).
 *
 * The tool used to write every page's menu afresh from two things only, each
 * link's words and its address. Whatever else a link carried was lost on every
 * page: `<a class="is-cta" href="/members-login.html">Members</a>` came back
 * without its class, and a styled button became a plain link. The whitespace
 * around the links was written afresh too.
 *
 * Now a save changes only what the person changed:
 *   - a link that was in the menu keeps its own text in each page's file, so
 *     every attribute it had there stays. Its words are written only when the
 *     words were changed, its address only when the address was changed;
 *   - moving a link moves it whole, with the element that wraps it (an `<li>`);
 *   - removing a link removes it whole;
 *   - a link the person added is written like its neighbours: wrapped as they
 *     are, set apart from them by the whitespace the page already uses, and
 *     with the class every link of that page shares, when they share one;
 *   - what is before the first link, between two links and after the last one
 *     stays as the page had it.
 * A page whose menu comes out the same is handed back unchanged, byte for
 * byte, so that the save can leave its file alone.
 *
 * Each page is worked out from its own text. The same link may carry
 * something else on another page (the page it points at often marks it as the
 * current one), and that stays as that page has it.
 *
 * Pure, and tested in node (test/menu-links.test.js).
 */
import { parseFragment } from 'parse5';
import { safeUrl } from '../engine.js';

const isEl = (n) => !!n && typeof n.tagName === 'string';
const kids = (n) => (n && n.childNodes) || [];
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const attrOf = (el, name) => (el.attrs || []).find(a => a.name === name)?.value;
const classesOf = (el) => oneLine(attrOf(el, 'class')).split(' ').filter(Boolean);

function textNodes(n, out = []) {
  for (const c of kids(n)) {
    if (c.nodeName === '#text') out.push(c);
    else if (isEl(c)) textNodes(c, out);
  }
  return out;
}

function anchorsIn(n, out = []) {
  for (const c of kids(n)) {
    if (!isEl(c)) continue;
    if (c.tagName === 'a' && c.sourceCodeLocation) out.push(c);
    else anchorsIn(c, out);
  }
  return out;
}

/**
 * The menu's items as the page's text holds them. An item is a link together
 * with the `<li>` that wraps that link alone, when it has one.
 */
function read(inner) {
  const root = parseFragment(String(inner), { sourceCodeLocationInfo: true });
  const items = anchorsIn(root).map((a) => {
    let unit = a;
    const chain = [a];
    // Only a list item counts as a link's own wrapper. Anything wider (the list, a box around several links) is the menu's, not the link's.
    while (isEl(unit.parentNode) && unit.parentNode.tagName === 'li' && unit.parentNode.sourceCodeLocation && anchorsIn(unit.parentNode).length === 1) {
      unit = unit.parentNode;
      chain.unshift(unit);
    }
    const at = unit.sourceCodeLocation;
    return { a, chain, start: at.startOffset, end: at.endOffset, label: oneLine(textNodes(a).map(t => t.value).join('')), href: attrOf(a, 'href') ?? '' };
  }).sort((x, y) => x.start - y.start);
  return items;
}

/** The links of a menu, in order, as the dialog lists them: [{ label, href }]. */
export function menuLinks(inner) {
  return read(inner).map(({ label, href }) => ({ label, href }));
}

/**
 * Which of this page's links each link of the dialog's page is: by address
 * and words, then by address, then by words, and last by its place when both
 * menus have as many links. -1 where this page has no such link.
 */
export function matchLinks(origin, here) {
  const to = origin.map(() => -1);
  const used = new Set();
  const take = (same) => origin.forEach((o, i) => {
    if (to[i] !== -1) return;
    const j = here.findIndex((h, k) => !used.has(k) && same(o, h, i, k));
    if (j !== -1) { to[i] = j; used.add(j); }
  });
  take((o, h) => o.href === h.href && o.label === h.label);
  take((o, h) => o.href === h.href);
  take((o, h) => !!o.label && o.label === h.label);
  if (origin.length === here.length) take((o, h, i, k) => i === k);
  return to;
}

/** One existing item's own text, with new words and a new address where they were changed (null: leave it). */
function edited(inner, item, label, href) {
  const at = item.a.sourceCodeLocation;
  const splices = [];
  if (href !== null) {
    const had = (at.attrs || at.startTag?.attrs || {}).href;
    const text = `href="${escAttr(href)}"`;
    if (had) splices.push({ start: had.startOffset, end: had.endOffset, text });
    else splices.push({ start: at.startOffset + 2, end: at.startOffset + 2, text: ` ${text}` });
  }
  if (label !== null) {
    const insideStart = at.startTag ? at.startTag.endOffset : at.startOffset;
    const insideEnd = at.endTag ? at.endTag.startOffset : at.endOffset;
    const words = textNodes(item.a).filter(t => t.value.trim() && t.sourceCodeLocation);
    if (words.length === 1) {
      // The words sit in one place: only they are written, and what is beside them (an icon) stays.
      const w = words[0].sourceCodeLocation;
      const raw = inner.slice(w.startOffset, w.endOffset);
      splices.push({ start: w.startOffset, end: w.endOffset, text: /^\s*/.exec(raw)[0] + escText(label) + /\s*$/.exec(raw)[0] });
    } else if (!words.length) {
      // A link with a picture and no words: the words go after the picture.
      const gap = inner.slice(insideStart, insideEnd).trim() ? ' ' : '';
      splices.push({ start: insideEnd, end: insideEnd, text: gap + escText(label) });
    } else {
      splices.push({ start: insideStart, end: insideEnd, text: escText(label) });
    }
  }
  let out = inner.slice(item.start, item.end);
  for (const s of splices.sort((x, y) => y.start - x.start)) {
    out = out.slice(0, s.start - item.start) + s.text + out.slice(s.end - item.start);
  }
  return out;
}

/** How a link added to this page is written, from the links the page has. */
function writerFor(inner, items) {
  const tagsOf = (it) => it.chain.map(e => e.tagName).join(' ');
  const alike = items.length > 0 && items.every(it => tagsOf(it) === tagsOf(items[0]));
  const shared = (els) => (els.length ? classesOf(els[0]).filter(c => els.every(e => classesOf(e).includes(c))) : []);
  const wraps = alike ? items[0].chain.slice(0, -1).map((e, level) => ({ tag: e.tagName, cls: shared(items.map(it => it.chain[level])) })) : [];
  const linkCls = shared(items.map(it => it.a));
  // The class is written before the address when the page's own links write it so.
  const model = items.find(it => attrOf(it.a, 'class') !== undefined && attrOf(it.a, 'href') !== undefined);
  const where = model && (model.a.sourceCodeLocation.attrs || model.a.sourceCodeLocation.startTag?.attrs || {});
  const classFirst = !!(where && where.class && where.href && where.class.startOffset < where.href.startOffset);
  return (label, href) => {
    const cls = linkCls.length ? `class="${escAttr(linkCls.join(' '))}"` : '';
    const adr = `href="${escAttr(href)}"`;
    let out = `<a ${[classFirst ? cls : adr, classFirst ? adr : cls].filter(Boolean).join(' ')}>${escText(label)}</a>`;
    for (const w of [...wraps].reverse()) out = `<${w.tag}${w.cls.length ? ` class="${escAttr(w.cls.join(' '))}"` : ''}>${out}</${w.tag}>`;
    return out;
  };
}

/** What sets two links apart on this page, for a place the page has no gap of its own for. */
function usualGap(gaps, lead) {
  if (gaps.length) {
    const seen = new Map();
    for (const g of gaps) seen.set(g, (seen.get(g) || 0) + 1);
    return [...seen].sort((x, y) => y[1] - x[1])[0][0];
  }
  const ws = /\s*$/.exec(lead)[0];
  return ws.includes('\n') ? ws.slice(ws.lastIndexOf('\n')) : ' ';
}

/**
 * This page's menu with the dialog's rows put into it.
 *
 * `inner`: the inside of the page's menu, as its file holds it.
 * `origin`: menuLinks() of the page the dialog was opened on.
 * `rows`: what the dialog holds now, in order: { label, href, from }, where
 *   `from` is the place the row had in `origin`, or null for a row that was added.
 * Returns the new inside, which is `inner` itself when nothing in it changes.
 */
export function rewriteMenu(inner, origin, rows) {
  inner = String(inner);
  const items = read(inner);
  const filled = (rows || []).filter(r => r && (Number.isInteger(r.from) || oneLine(r.label)));
  if (!items.length) {
    // A menu with no links yet takes them when it holds nothing else; one that holds something else is left alone.
    if (inner.trim()) return inner;
    const fresh = filled.filter(r => oneLine(r.label)).map(r => `<a href="${escAttr(safeUrl(oneLine(r.href) || '/'))}">${escText(oneLine(r.label))}</a>`);
    if (!fresh.length) return inner;
    const ws = /^\s*/.exec(inner)[0];
    const gap = ws.includes('\n') ? ws.slice(ws.lastIndexOf('\n')) : ' ';
    return (ws.includes('\n') ? ws : '') + fresh.join(gap) + (ws.includes('\n') ? inner.slice(ws.length) || '\n' : '');
  }
  const to = matchLinks(origin || [], items);
  const lead = inner.slice(0, items[0].start);
  const tail = inner.slice(items[items.length - 1].end);
  const gaps = items.slice(1).map((it, i) => inner.slice(items[i].end, it.start));
  const gap = usualGap(gaps, lead);
  const write = writerFor(inner, items);
  const out = [];
  for (const row of filled) {
    const label = oneLine(row.label);
    const was = Number.isInteger(row.from) ? origin[row.from] : null;
    const j = was ? to[row.from] : -1;
    if (was && j !== -1) {
      const newWords = label !== was.label;
      const newAddress = oneLine(row.href) !== oneLine(was.href);
      if (newWords && !label) continue;   // its words were cleared: the link is taken out, as it always was
      out.push(edited(inner, items[j], newWords ? label : null, newAddress ? safeUrl(oneLine(row.href) || '/') : null));
    } else if (label) {
      out.push(write(label, safeUrl(oneLine(row.href) || '/')));
    }
  }
  let text = lead;
  out.forEach((item, k) => { text += (k ? (k - 1 < gaps.length ? gaps[k - 1] : gap) : '') + item; });
  return text + tail;
}
