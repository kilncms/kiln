/**
 * What the page FILE says about the blocks of a list.
 *
 * A list is published as one piece of HTML, and that HTML used to be read off
 * the live page. A live page is not the file: the site's own scripts have been
 * at it. A block that faded in carries the class the fade-in added, a block
 * hidden by a filter carries display:none, a slider marks its slides
 * aria-hidden, a lazy loader swaps a picture's address. All of that went into
 * the file with the next publish: state from one visit, written into the
 * source.
 *
 * So the editor notes, for each element of a list, the element the file has
 * at that place, and publishes that element's attributes instead of the live
 * one's. What the editor itself changes is still taken from the page:
 *
 *   outside an editable field   every attribute is the file's, except the
 *                               editor's own (data-kiln-*, data-cms*: a
 *                               block's tags, what marks a part as editable)
 *   an editable field           a link's address, a picture and its description
 *                               are the editor's to change, and so is the
 *                               size a picture, a video or a frame was
 *                               dragged to (its style: the file's, plus what
 *                               the person changed); every other attribute,
 *                               its class first of all, is the file's
 *   inside an editable field    the words and their formatting are what
 *                               was typed. An element the file has there
 *                               keeps the file's class and style, plus what
 *                               the person changed on it while editing
 *                               (insideAttrs); every other attribute is
 *                               taken from the page
 *
 * A field that is not in a list is published as its inside alone, by the
 * same rule: an animation library's opacity and transform on a headline's
 * lines, or the class a fade-in adds to a paragraph, are a visit's state and
 * stay out of the file. What tells the person's change from a script's is
 * what the element had when the person began to edit the field (beginInside):
 * whatever differed from the file by then is the script's, and stays the
 * script's however its value moves on.
 *
 * Deliberately left alone: an element the file does not have at that place
 * (one a script added, or a list a script re-ordered or re-drew, where
 * nothing can be paired safely); an element a script removed; words a script
 * changed outside a field, or split into pieces inside one; a class or style
 * a script first sets on an element while it is being edited; and, on an
 * editable field, the address of a link or a picture when a script changes
 * it too (a lazy loader on an editable picture). Those are published as they
 * are on the page, as before.
 *
 * publishedAttrs, insideAttrs, styleDecls, pairTrees and sameWords are pure
 * and tested in node; the rest needs a page (the tests give it a small one).
 */

const fileOf = new WeakMap();   // an element on the page → the element the file has for it (detached)
const beganOf = new WeakMap();  // an element inside a field → the class and style it had when the person began to edit the field

const OWN = /^data-(kiln|cms)(-|$)/;   // attributes the editor itself sets
const FIELD_OWN = new Set(['href', 'src', 'alt']);   // what the editor changes on a field: a link's address, a picture, its description
const MEDIA = /^(IMG|VIDEO|IFRAME|PICTURE|SOURCE)$/;
const isField = (el) => el.hasAttribute('data-cms');
const CHROME = '.kiln-item-ctl, .kiln-ctl-cell, .kiln-repeat-add, #kiln-toolbar';
const kids = (el) => [...el.children].filter(c => !c.matches(CHROME));

/**
 * The attributes an element is published with, as [name, value] pairs.
 *   live   its attributes on the page now
 *   file   its attributes in the file
 *   field  it is an editable field;  media  it is a picture, a video or a frame
 */
export function publishedAttrs(live, file, { field = false, media = false } = {}) {
  // What is taken from the page: the editor's own attributes, and on a field
  // the few things the editor changes there.
  const fromPage = (name) => OWN.test(name) || (field && (FIELD_OWN.has(name) || (media && name === 'style')));
  const onPage = new Map(live), inFile = new Map(file);
  const out = [];
  for (const [name, value] of file) {
    if (!fromPage(name)) out.push([name, value]);
    else if (onPage.has(name)) out.push([name, onPage.get(name)]);   // changed in the editor, or left as it was
  }
  for (const [name, value] of live) if (fromPage(name) && !inFile.has(name)) out.push([name, value]);
  return out;
}

/** Whether a block on the page says what the file's block says: the same kind of element, the same words. */
export function sameWords(live, file) {
  const words = (el) => String(el.textContent || '').replace(/\s+/g, ' ').trim();
  return live.tagName === file.tagName && words(live) === words(file);
}

const tokens = (cls) => String(cls || '').split(/\s+/).filter(Boolean);

/** A style attribute as [property, value] pairs, in order. A semicolon inside brackets or quotes ends nothing. */
export function styleDecls(style) {
  const out = [];
  let depth = 0, quote = '', from = 0;
  const text = String(style || '');
  const take = (to) => {
    const part = text.slice(from, to), colon = part.indexOf(':');
    if (colon > 0 && part.slice(0, colon).trim()) out.push([part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim()]);
    from = to + 1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && !depth) take(i);
  }
  take(text.length);
  return out;
}

/**
 * The class and style an element INSIDE a field is published with.
 *   live   { class, style } on the page now (null: no such attribute)
 *   file   { class, style } in the file
 *   began  { class, style } when the person began to edit the field; without
 *          it nothing on the page is the person's, and the file's are returned
 * What differed from the file when the edit began is the site's scripts'
 * doing, and is never written, whatever its value has become since. What the
 * person changed after that is: a class or a declaration added, changed or
 * taken off. Untouched, the file's own text comes back byte for byte.
 */
export function insideAttrs(live, file, began = null) {
  const b = began || live;
  // class
  const L = tokens(live.class), F = tokens(file.class), B = tokens(b.class);
  const cls = F.filter(t => !(B.includes(t) && !L.includes(t)));
  for (const t of L) if (!B.includes(t) && !cls.includes(t) && !t.startsWith('kiln-')) cls.push(t);
  const sameClass = cls.length === F.length && cls.every((t, i) => t === F[i]);
  // style
  const lm = new Map(styleDecls(live.style)), fm = new Map(styleDecls(file.style)), bm = new Map(styleDecls(b.style));
  const scripts = (p) => bm.has(p) && (!fm.has(p) || fm.get(p) !== bm.get(p));
  const out = new Map(fm);
  let touched = false;
  for (const p of fm.keys()) if (bm.has(p) && !scripts(p) && !lm.has(p)) { out.delete(p); touched = true; }
  for (const [p, v] of lm) {
    if (scripts(p) || (bm.has(p) && bm.get(p) === v)) continue;
    if (out.get(p) !== v) { out.set(p, v); touched = true; }
  }
  return {
    class: sameClass ? file.class : (cls.length ? cls.join(' ') : null),
    style: !touched ? file.style : (out.size ? [...out].map(([p, v]) => `${p}: ${v};`).join(' ') : null),
  };
}

/**
 * Pair an element of the page with the element of the file at the same place,
 * and their children as far down as the two agree (as many children, of the
 * same kinds). Not below an editable field. Returns [[live, file], …].
 */
export function pairTrees(live, file, children = (el) => [...el.children]) {
  if (!live || !file || live.tagName !== file.tagName) return [];
  const pairs = [[live, file]];
  if (isField(live)) return pairs;
  const mine = children(live), theirs = children(file);
  if (mine.length !== theirs.length || mine.some((c, i) => c.tagName !== theirs[i].tagName)) return pairs;
  mine.forEach((c, i) => pairs.push(...pairTrees(c, theirs[i], children)));
  return pairs;
}

/**
 * Note what the file says for a list on the page. `fileHtml` is the list's
 * HTML as the file has it. Blocks are paired by place, and only when the page
 * has as many blocks as the file; a block that does not say what the file's
 * block says at its place (the page is older than the file, a script
 * re-ordered the list) is not paired. Returns how many blocks were.
 */
export function noteList(list, fileHtml) {
  const box = list.cloneNode(false);
  box.innerHTML = fileHtml;
  const live = kids(list), file = [...box.children];
  if (live.length !== file.length) return 0;
  // What a block says, without the editor's own buttons on it.
  const bare = (block) => {
    const copy = block.cloneNode(true);
    copy.querySelectorAll(CHROME).forEach(c => c.remove());
    return copy;
  };
  let n = 0;
  live.forEach((block, i) => {
    if (!sameWords(bare(block), file[i])) return;
    for (const [l, f] of pairDeep(block, file[i])) fileOf.set(l, f);
    n++;
  });
  return n;
}

/** pairTrees, and below each editable field too: what is inside a field is paired the same way. */
function pairDeep(live, file) {
  const pairs = pairTrees(live, file, kids);
  for (const [l, f] of [...pairs]) if (isField(l)) pairs.push(...pairInside(l, f, true));
  return pairs;
}

/**
 * The elements inside a field, paired with the file's. `sure`: the field is
 * known to say what the file says, so place alone decides. Otherwise (the
 * page is older than the file, or a script changed the words) an element is
 * paired only when it has every class the file's element has: a script adds
 * classes to what it finds, and two different lines seldom share all of them.
 */
function pairInside(live, file, sure) {
  const mine = kids(live), theirs = kids(file);
  if (mine.length !== theirs.length) return [];
  const pairs = [];
  mine.forEach((c, i) => {
    const f = theirs[i];
    if (c.tagName !== f.tagName) return;
    if (!sure && !tokens(f.getAttribute('class')).every(t => tokens(c.getAttribute('class')).includes(t))) return;
    pairs.push([c, f], ...pairInside(c, f, sure));
  });
  return pairs;
}

/**
 * Note what the file says is inside a field that is not in a list.
 * `fileHtml` is the field's inner HTML as the file has it. Returns how many
 * elements were paired.
 */
export function noteInside(field, fileHtml) {
  const box = field.cloneNode(false);
  box.innerHTML = fileHtml;
  const copy = field.cloneNode(true);
  for (const c of [...copy.children]) if (c.matches(CHROME)) c.remove();
  const pairs = pairInside(field, box, sameWords(copy, box));
  for (const [l, f] of pairs) fileOf.set(l, f);
  return pairs.length;
}

/** The element the file has for one on the page, if that is known. */
export function fileFor(el) {
  return fileOf.get(el) || null;
}

/** Say what the file has for an element: `as` is a detached element with those attributes. */
export function noteAs(el, as) {
  fileOf.set(el, as);
  beganOf.delete(el);   // written by the editor: nothing on it is a change the person is in the middle of
}

/**
 * HTML an earlier editor kept with a visit's state in it, read as the file
 * would have it: an element the file has at that place takes the file's class
 * and style. `shell` is the field it belongs to (for its tag); nothing on the
 * page is touched.
 */
export function asFileHtml(shell, html, fileHtml) {
  const box = shell.cloneNode(false), file = shell.cloneNode(false);
  box.innerHTML = html;
  file.innerHTML = fileHtml;
  for (const [l, f] of pairInside(box, file, sameWords(box, file))) {
    put(l, 'class', f.getAttribute('class'));
    put(l, 'style', f.getAttribute('style'));
  }
  return box.innerHTML;
}

const read = (el) => ({ class: el.getAttribute('class'), style: el.getAttribute('style') });
const put = (el, name, value) => { if (value == null) el.removeAttribute(name); else if (el.getAttribute(name) !== value) el.setAttribute(name, value); };
/** Every element inside `el`, the editor's own controls left out. */
function inside(el, out = []) {
  for (const c of kids(el)) { out.push(c); inside(c, out); }
  return out;
}
/** An element as it is on the page now, standing in for a file that does not have it. */
function asItIs(el) {
  const copy = el.cloneNode(false);
  const cls = tokens(copy.getAttribute('class')).filter(t => !t.startsWith('kiln-'));
  put(copy, 'class', cls.length ? cls.join(' ') : null);
  return copy;
}

/**
 * The person begins to edit a field. What each element inside it has now is
 * remembered: from here on, a change to its class or style is the person's.
 * An element the file is not known to have counts as the file's as it is.
 */
export function beginInside(field) {
  for (const el of inside(field)) {
    if (!fileOf.has(el)) fileOf.set(el, asItIs(el));
    beganOf.set(el, read(el));
  }
}

/**
 * The edit is kept. For every element inside the field, what the file would
 * now say of it is worked out once and noted: the file's class and style plus
 * what the person changed. An element made while editing is published as it
 * is, unless the browser made it by copying one that was there (Enter in the
 * middle of a line): then it is published as that one is.
 */
export function settleInside(field) {
  const all = inside(field);
  const known = all.filter(el => fileOf.has(el));
  const next = new Map();
  for (const el of known) next.set(el, insideAttrs(read(el), read(fileOf.get(el)), beganOf.get(el)));
  const same = (a, b) => a.class === b.class && a.style === b.style;
  for (const el of all) {
    if (fileOf.has(el)) continue;
    const mine = read(el);
    const from = known.find(k => k.tagName === el.tagName && (same(read(k), mine) || (beganOf.has(k) && same(beganOf.get(k), mine))));
    fileOf.set(el, from ? fileOf.get(from).cloneNode(false) : asItIs(el));
    next.set(el, from ? next.get(from) : read(fileOf.get(el)));
  }
  for (const el of all) {
    const as = fileOf.get(el).cloneNode(false);
    put(as, 'class', next.get(el).class);
    put(as, 'style', next.get(el).style);
    fileOf.set(el, as);
    beganOf.delete(el);
  }
}

// ─── A field's own element, when it is a picture ─────────────────────────────
// The one thing the editor changes on a field's own element beyond its address
// and description is the size a picture is dragged to, which is written into
// its style. That style is told apart from a script's the same way: by what
// the picture had when the person began (beginOn), until they are done (endOn).

/** The person is about to change a picture that is a field. */
export function beginOn(el) {
  if (!fileOf.has(el)) fileOf.set(el, asItIs(el));
  beganOf.set(el, read(el));
}

/** They are done with it: nothing that happens to it from now on is theirs. */
export function endOn(el) {
  beganOf.delete(el);
}

/** The style the picture would have in the file now: the file's, plus what the person changed since beginOn. */
export function ownStyle(el) {
  const file = fileOf.get(el);
  return file ? insideAttrs(read(el), read(file), beganOf.get(el)).style : el.getAttribute('style');
}

/** That style has been staged: it is what the file would say from now on, and the person goes on from here. */
export function settleOn(el) {
  const file = fileOf.get(el);
  if (!file) return;
  const as = file.cloneNode(false);
  put(as, 'style', ownStyle(el));
  fileOf.set(el, as);
  if (beganOf.has(el)) beganOf.set(el, read(el));
}

/**
 * Show `style` (as a file would hold it) on a picture that is a field,
 * leaving on it what the site's scripts put there: Undo of a resize, a way
 * back from History.
 */
export function showStyle(el, style) {
  const file = fileOf.get(el) || asItIs(el);
  const was = new Map(styleDecls(file.getAttribute('style')));
  const out = new Map(styleDecls(style));
  for (const [p, v] of styleDecls(el.getAttribute('style'))) if (!was.has(p) || was.get(p) !== v) out.set(p, v);
  put(el, 'style', out.size ? [...out].map(([p, v]) => `${p}: ${v};`).join(' ') : null);
  const as = file.cloneNode(false);
  put(as, 'style', style || null);
  fileOf.set(el, as);
  if (beganOf.has(el)) beganOf.set(el, read(el));
}

/**
 * `copy` is a deep copy of the field `live`, made with cloneNode(true). Every
 * element inside it that the file knows gets the class and style it is
 * published with.
 */
export function insideAsFile(copy, live) {
  const mine = kids(copy), theirs = kids(live);
  if (mine.length !== theirs.length) return;
  mine.forEach((c, i) => {
    const l = theirs[i], file = fileOf.get(l);
    if (file) {
      const want = insideAttrs(read(l), read(file), beganOf.get(l));
      put(c, 'class', want.class);
      put(c, 'style', want.style);
    }
    insideAsFile(c, l);
  });
}

/** A block made from HTML that was staged (Undo, Redo, a draft): what it says is what the file would say. */
export function noteAsWritten(block) {
  const copy = block.cloneNode(true);
  for (const [l, f] of pairDeep(block, copy)) fileOf.set(l, f);
}

/** A block copied from another (Duplicate, "+ Add block"): it is published as the file has its original. */
export function noteCopy(from, to) {
  for (const [t, f] of pairDeep(to, from)) {
    if (fileOf.has(f)) fileOf.set(t, fileOf.get(f));
  }
}

/**
 * `copy` is a deep copy of `live`, made with cloneNode(true). Every element
 * of it that the file knows gets the attributes it is published with.
 */
export function fileTrue(copy, live) {
  const file = fileOf.get(live);
  if (file) {
    const field = isField(live);
    const attrs = (el) => [...el.attributes].map(a => [a.name, a.value]);
    const want = publishedAttrs(attrs(live), attrs(file), { field, media: MEDIA.test(live.tagName) });
    for (const a of [...copy.attributes]) copy.removeAttribute(a.name);
    for (const [name, value] of want) copy.setAttribute(name, value);
    // A picture's style holds the size it was dragged to: the person's change, on top of the file's, and nothing a script put there.
    if (field && MEDIA.test(live.tagName)) put(copy, 'style', insideAttrs(read(live), read(file), beganOf.get(live)).style);
    if (field) { insideAsFile(copy, live); return; }
  } else if (isField(live)) { insideAsFile(copy, live); return; }
  const mine = [...copy.children], theirs = [...live.children];
  if (mine.length !== theirs.length) return;
  mine.forEach((c, i) => fileTrue(c, theirs[i]));
}
