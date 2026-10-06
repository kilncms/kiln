/**
 * Putting a list's blocks back on the page without making them new.
 *
 * Undo, Redo, "Drop" in the publish sheet, History's preview, a draft and
 * "Pick up where you left off?" all hand the editor a list's HTML to show.
 * Written with innerHTML, every block in it becomes a brand-new element, and
 * the site's own scripts have never seen those. On a site whose blocks fade in
 * as they scroll into view (hidden until a script adds a class to each one),
 * the whole list then stays invisible: the blocks are on the page, and nobody
 * can see them.
 *
 * So a block that is already on the page stays the element it is, with
 * whatever the site's scripts have done to it. A block taken off the page is
 * kept aside, and is the one put back if the list is asked to hold it again.
 * A block that really is new takes the classes the site gave to the block it
 * stands in for, or to its neighbours.
 *
 * What is compared is how a block reads apart from the site's own state:
 * outside the editable fields, class and style are the site's (the editor
 * never changes them), so they are left out of the comparison and are never
 * taken off an element that stays.
 *
 * planBlocks and carriedClass are pure and tested in node; the rest needs a page.
 */

const KEPT_MAX = 80;   // blocks kept aside per list
let aside = new WeakMap();   // list element → blocks taken off the page, oldest first

/**
 * Where each block of the list as it should be comes from.
 *   target: how each wanted block reads, in order
 *   live:   how each block on the page reads, in order
 *   kept:   how each block kept aside reads, oldest first
 * A null never matches. Returns one entry per wanted block:
 *   { from: 'live', at }   the block on the page at that place
 *   { from: 'kept', at }   a block kept aside
 *   { from: 'new', like }  a new element; `like` is the place of the block on
 *                          the page it stands in for, or null
 */
export function planBlocks(target, live, kept = []) {
  const plan = target.map(() => null);
  const usedLive = new Set(), usedKept = new Set();
  // a block that is where it should be stays there
  target.forEach((shape, i) => {
    if (shape != null && live[i] === shape) { plan[i] = { from: 'live', at: i }; usedLive.add(i); }
  });
  // a block that moved
  target.forEach((shape, i) => {
    if (plan[i] || shape == null) return;
    const at = live.findIndex((s, j) => s === shape && !usedLive.has(j));
    if (at !== -1) { plan[i] = { from: 'live', at }; usedLive.add(at); }
  });
  // a block that was taken off the page: the one taken off last, first
  target.forEach((shape, i) => {
    if (plan[i] || shape == null) return;
    for (let at = kept.length - 1; at >= 0; at--) {
      if (kept[at] === shape && !usedKept.has(at)) { plan[i] = { from: 'kept', at }; usedKept.add(at); break; }
    }
  });
  // what is left is new, and stands in for a block that is leaving, in order
  const leaving = live.map((_, j) => j).filter(j => !usedLive.has(j));
  target.forEach((_, i) => {
    if (!plan[i]) plan[i] = { from: 'new', like: leaving.length ? leaving.shift() : null };
  });
  return plan;
}

const words = (cls) => String(cls || '').split(/\s+/).filter(Boolean);

/**
 * The class attribute a new element takes from the one it stands in for (or
 * from its neighbours): its own classes, then the ones the site's scripts had
 * added to the other. Only when the other has every class the new one has, so
 * that they are the same kind of thing. The editor's own classes are never
 * carried. null: leave the new element as it was written.
 */
export function carriedClass(fresh, ...others) {
  const mine = words(fresh);
  let extra = null;
  for (const other of others) {
    const theirs = words(other);
    if (!mine.every(w => theirs.includes(w))) return null;
    const more = theirs.filter(w => !mine.includes(w) && !w.startsWith('kiln-'));
    extra = extra ? extra.filter(w => more.includes(w)) : more;
  }
  return extra && extra.length ? [...mine, ...extra].join(' ') : null;
}

const CHROME = '.kiln-item-ctl, .kiln-ctl-cell, .kiln-repeat-add';
const isBlock = (node) => node.nodeType === 1 && !node.matches(CHROME);
const parts = (el) => [...el.children].filter(isBlock);

/** How a block reads, apart from the site's own state: `el` is changed in place (hand in a copy). */
function shapeOf(el) {
  const strip = (node) => {
    node.removeAttribute('class');
    if (node.hasAttribute('data-cms')) return;   // a field: its style, and everything inside it, is the editor's to change
    node.removeAttribute('style');
    for (const child of node.children) strip(child);
  };
  strip(el);
  return el.outerHTML;
}

/**
 * Give a new element what the site's scripts gave another, part by part.
 * `place`: the other is the block this one stands in for, so it takes that
 * block's place on the page too (its inline style, which is where a script
 * that lays blocks out puts each one). Otherwise the others are neighbours:
 * `also` is the neighbour on the other side, and only what both were given is
 * taken.
 */
function carry(to, from, { place = false, also = null } = {}) {
  if (!from || from.tagName !== to.tagName) return;
  if (also && also.tagName !== to.tagName) also = null;
  const cls = carriedClass(to.getAttribute('class'), from.getAttribute('class'), ...(also ? [also.getAttribute('class')] : []));
  if (cls !== null) to.setAttribute('class', cls);
  if (to.hasAttribute('data-cms')) return;
  if (place && !to.hasAttribute('style') && from.hasAttribute('style')) to.setAttribute('style', from.getAttribute('style'));
  const mine = parts(to), theirs = parts(from), others = also ? parts(also) : null;
  if (mine.length !== theirs.length) return;
  mine.forEach((child, i) => carry(child, theirs[i], { place, also: others && others.length === mine.length ? others[i] : null }));
}

/** A block the editor took off the page itself (the ✕ on a block): kept, so that Undo puts the same one back. */
export function keepAside(list, block) {
  aside.set(list, [...(aside.get(list) || []), block].slice(-KEPT_MAX));
}

/** Forget every block kept aside (a publish: nothing from before it comes back by Undo). */
export function forgetBlocks() {
  aside = new WeakMap();
}

/**
 * Make `list` hold the blocks of `html`, keeping every block that is already
 * there. `tidy(box)` takes a detached copy of the list and leaves it the way
 * its HTML would be staged (the editor's own controls and classes off,
 * sanitized), in place.
 */
export function writeBlocks(list, html, tidy) {
  const want = list.cloneNode(false);
  want.innerHTML = html;
  const wanted = [...want.children];
  const live = parts(list);
  const kept = aside.get(list) || [];
  const read = (nodes) => {
    const box = list.cloneNode(false);
    for (const n of nodes) box.appendChild(n.cloneNode(true));
    tidy(box);
    // a block the tidying dropped or split cannot be told apart safely: none of them is matched
    return box.children.length === nodes.length ? [...box.children].map(shapeOf) : nodes.map(() => null);
  };
  const plan = planBlocks(read(wanted), read(live), read(kept));
  const usedLive = new Set(), usedKept = new Set(), alone = [];
  let i = 0;
  const out = [...want.childNodes].map((node) => {
    if (node.nodeType !== 1) return node;
    const p = plan[i++];
    if (p.from === 'live') { usedLive.add(p.at); return live[p.at]; }
    if (p.from === 'kept') { usedKept.add(p.at); return kept[p.at]; }
    if (p.like === null) alone.push(node); else carry(node, live[p.like], { place: true });
    return node;
  });
  aside.set(list, [...kept.filter((_, j) => !usedKept.has(j)), ...live.filter((_, j) => !usedLive.has(j))].slice(-KEPT_MAX));
  // Only what has to move is moved: an element that is taken out and put back starts over (a video, a frame).
  let at = list.firstChild;
  for (const node of out) {
    if (node === at) at = at.nextSibling;
    else list.insertBefore(node, at);
  }
  while (at) { const next = at.nextSibling; at.remove(); at = next; }
  // A new block with no block to stand in for takes what both its neighbours were given.
  const settled = (node, step) => {
    for (let n = node[step]; n; n = n[step]) if (isBlock(n) && !alone.includes(n)) return n;
    return null;
  };
  for (const node of alone) {
    const before = settled(node, 'previousElementSibling'), after = settled(node, 'nextElementSibling');
    carry(node, before || after, { also: before && after ? after : null });
  }
}
