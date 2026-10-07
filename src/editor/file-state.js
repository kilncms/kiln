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
 *                               style of a picture, a video or a frame (the
 *                               size it was dragged to); every other
 *                               attribute, its class first of all, is the
 *                               file's
 *   inside an editable field    nothing: the words and their formatting are
 *                               what was typed
 *
 * Deliberately left alone: an element the file does not have at that place
 * (one a script added, or a list a script re-ordered or re-drew, where
 * nothing can be paired safely); an element a script removed; words a script
 * changed outside a field; and, on an editable field, the address of a link
 * or a picture when a script changes it too (a lazy loader on an editable
 * picture). Those are published as they are on the page, as before.
 *
 * publishedAttrs, pairTrees and sameWords are pure and tested in node; the
 * rest needs a page.
 */

const fileOf = new WeakMap();   // an element on the page → the element the file has for it (detached)

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
    for (const [l, f] of pairTrees(block, file[i], kids)) fileOf.set(l, f);
    n++;
  });
  return n;
}

/** A block made from HTML that was staged (Undo, Redo, a draft): what it says is what the file would say. */
export function noteAsWritten(block) {
  const copy = block.cloneNode(true);
  for (const [l, f] of pairTrees(block, copy, kids)) fileOf.set(l, f);
}

/** A block copied from another (Duplicate, "+ Add block"): it is published as the file has its original. */
export function noteCopy(from, to) {
  for (const [t, f] of pairTrees(to, from, kids)) {
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
    if (field) return;
  } else if (isField(live)) return;
  const mine = [...copy.children], theirs = [...live.children];
  if (mine.length !== theirs.length) return;
  mine.forEach((c, i) => fileTrue(c, theirs[i]));
}
