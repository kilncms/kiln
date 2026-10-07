/**
 * Putting a field's HTML back on the page without making its elements new.
 *
 * Undo, Redo, Esc, "Drop" in the publish sheet, History's preview, a draft,
 * "Pick up where you left off?" and the demo's own stored publishes all hand
 * the editor a field's HTML to show. That HTML is what the page's FILE would
 * hold (file-state.js): it has none of what the site's scripts put on the
 * page. Written with innerHTML, every element in it is brand new, and the
 * site's scripts have never seen those. A headline whose lines an animation
 * library slides in, or a paragraph hidden until a script marks it as in
 * view, is then on the page where nobody can see it.
 *
 * So an element that is already there stays the element it is, with whatever
 * the site's scripts have done to it and are still doing: an animation that is
 * running goes on running on it. An element that was typed away is kept
 * aside from the moment the person begins to edit, and is the one put back.
 * An element that really is new is given what the scripts gave another of its
 * kind in the same field.
 *
 * Two elements are of a kind when they are the same tag with the same
 * classes, as the file has them.
 */

import { fileFor, noteAs, styleDecls } from './file-state.js';

const KEPT_MAX = 120;   // elements kept aside per field
const kept = new WeakMap();   // field → elements that were inside it, oldest first

const CHROME = '.kiln-item-ctl, .kiln-ctl-cell, .kiln-repeat-add, #kiln-toolbar';
const isChrome = (node) => node.nodeType === 1 && node.matches(CHROME);
const tokens = (cls) => String(cls || '').split(/\s+/).filter(Boolean);
const elements = (el, out = []) => {
  for (const c of el.children) { if (isChrome(c)) continue; out.push(c); elements(c, out); }
  return out;
};

/** Whether `el`, on the page or kept aside, is the kind of element `want` is. */
function sameKind(el, want) {
  if (el.tagName !== want.tagName) return false;
  const mine = tokens(want.getAttribute('class'));
  const file = fileFor(el);
  if (!file) {
    // The file is not known for it: it has at least the classes asked for (a script only adds).
    const has = tokens(el.getAttribute('class'));
    return mine.every(t => has.includes(t));
  }
  const theirs = tokens(file.getAttribute('class'));
  return mine.length === theirs.length && mine.every(t => theirs.includes(t));
}

/** What the site's scripts have put on `el`: the classes and style declarations it has beyond `than`. */
function given(el, than) {
  const base = tokens(than.getAttribute('class'));
  const was = new Map(styleDecls(than.getAttribute('style')));
  return {
    classes: tokens(el.getAttribute('class')).filter(t => !base.includes(t)),
    style: styleDecls(el.getAttribute('style')).filter(([p, v]) => !was.has(p) || was.get(p) !== v),
  };
}

/** Give `el` the class and style `want` has, plus what the scripts gave. */
function wear(el, want, extra) {
  const cls = [...tokens(want.getAttribute('class')), ...extra.classes.filter(t => !tokens(want.getAttribute('class')).includes(t))];
  const style = new Map(styleDecls(want.getAttribute('style')));
  for (const [p, v] of extra.style) style.set(p, v);
  const set = (name, value) => { if (value == null) el.removeAttribute(name); else if (el.getAttribute(name) !== value) el.setAttribute(name, value); };
  const plain = !extra.classes.length && want.hasAttribute('class') ? want.getAttribute('class') : null;
  set('class', plain ?? (cls.length ? cls.join(' ') : null));
  const asIs = !extra.style.length && want.hasAttribute('style') ? want.getAttribute('style') : null;
  set('style', asIs ?? (style.size ? [...style].map(([p, v]) => `${p}: ${v};`).join(' ') : null));
}

/**
 * An element that stays becomes what `want` says: its attributes are the new
 * HTML's, and what the scripts gave it stays on it. From now on the file's
 * element for it is `want`.
 */
function become(el, want) {
  const file = fileFor(el);
  const extra = given(el, file || want);
  // Attributes the file named and the new HTML does not are gone; one neither names is a script's, and stays.
  if (file) for (const a of [...file.attributes]) if (!want.hasAttribute(a.name) && a.name !== 'class' && a.name !== 'style') el.removeAttribute(a.name);
  for (const a of [...want.attributes]) if (a.name !== 'class' && a.name !== 'style' && el.getAttribute(a.name) !== a.value) el.setAttribute(a.name, a.value);
  wear(el, want, extra);
  noteAs(el, want.cloneNode(false));
}

/**
 * The person begins to edit a field: every element inside it is remembered,
 * so that one typed away can come back as itself.
 */
export function rememberInside(field) {
  const have = kept.get(field) || [];
  kept.set(field, [...have, ...elements(field).filter(el => !have.includes(el))].slice(-KEPT_MAX));
}

/**
 * Make `field` hold `html`, keeping every element that is already there (or
 * was) and is of the kind the HTML asks for at its place.
 */
export function writeInside(field, html) {
  const want = field.cloneNode(false);
  want.innerHTML = html;
  const before = elements(field);
  const pool = [...(kept.get(field) || []).filter(el => !before.includes(el)), ...before];
  const taken = new Set();
  const fill = (live, wanted) => {
    const here = [...live.children].filter(c => !isChrome(c));
    const out = [];
    for (const node of [...wanted.childNodes]) {
      if (node.nodeType !== 1) { out.push(node); continue; }
      // the element at this place; else one that was typed away, the one that read the same first
      let el = here.find(c => !taken.has(c) && sameKind(c, node));
      if (!el) {
        const spare = pool.filter(c => !taken.has(c) && !field.contains(c) && sameKind(c, node));
        el = spare.find(c => c.textContent === node.textContent) || spare[spare.length - 1] || null;
      }
      if (el) {
        taken.add(el);
        become(el, node);
        fill(el, node);
        out.push(el);
        continue;
      }
      // new: what the HTML says of it is what the file would say; on the page it is given what another of its kind was
      for (const fresh of [node, ...elements(node)]) {
        const like = pool.find(c => sameKind(c, fresh));
        const extra = like ? given(like, fileFor(like) || fresh) : null;
        noteAs(fresh, fresh.cloneNode(false));
        if (extra) wear(fresh, fresh.cloneNode(false), extra);
      }
      out.push(node);
    }
    // Only what has to move is moved; the editor's own controls stay where they are.
    let at = live.firstChild;
    const skip = () => { while (at && isChrome(at)) at = at.nextSibling; };
    for (const node of out) {
      skip();
      if (node === at) at = at.nextSibling;
      else live.insertBefore(node, at);
    }
    skip();
    while (at) {
      const next = at.nextSibling;
      if (!isChrome(at)) at.remove();
      at = next;
    }
  };
  fill(field, want);
  kept.set(field, pool.slice(-KEPT_MAX));
}
