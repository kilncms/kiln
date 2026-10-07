/**
 * A block's buttons under a site's own bar.
 *
 * A header that stays at the top of the screen (position: fixed or sticky)
 * covers whatever scrolls under it. Kiln's buttons on a block are stacked
 * above everything on the page so that nothing of the site's can hide them,
 * and so they showed on top of that header while their block went under it.
 * They are hidden for as long as any part of them is under such a bar.
 *
 * Only a bar at the top is looked for, and only one the site pinned there. A
 * pinned layer that fills the screen is not a bar, and one behind the page's
 * content covers nothing.
 *
 * Pure, so it is tested in node; main.js reads the page (hideUnderBar).
 */

/**
 * How far down the screen the site's own bar reaches, in pixels from the top;
 * 0 when there is none.
 *   stack       what is painted at one point near the top of the screen,
 *               topmost first: { kiln, pinned } where `kiln` is one of Kiln's
 *               own elements and `pinned` is the box { top, bottom, height }
 *               of the fixed or sticky element it belongs to, or null
 *   viewHeight  the height of the screen
 */
export function coverBottom(stack, viewHeight) {
  const top = (stack || []).find(s => !s.kiln);   // Kiln's own are painted above: look through them
  if (!top || !top.pinned) return 0;
  const p = top.pinned;
  if (p.height > viewHeight / 2 || p.bottom <= 0) return 0;
  return p.bottom;
}

/** Whether a button with this box { top, bottom } is, in any part, under a bar that reaches down to `cover`. */
export function isUnder(rect, cover) {
  return cover > 0 && rect.bottom > 0 && rect.top < cover;
}

/**
 * Whether a box is one of the site's own bars at the top of the screen, for
 * placing the editor's line of words below them on a phone (it used to lie on
 * the site's logo).
 *   box    { top, bottom, width, pinned, named }: `pinned` when it is fixed
 *          or sticky, `named` when it is a header, a nav or a banner
 *   from   how far down the screen the bars found so far reach
 *   screen { width, height, atTop }: `atTop` when the page is not scrolled
 * A bar spans the screen, begins where the last one ended and is a strip, not
 * a section. One the site pinned or named counts anywhere. At the very top of
 * the page so does any such strip (a banner, an announcement): scrolled, a
 * strip that is not pinned is only a line of the page going by.
 */
export function isSiteBar(box, from, screen) {
  const height = box.bottom - box.top;
  if (box.width < screen.width * 0.9 || box.top > from + 4 || box.bottom <= from + 4) return false;
  if (height > Math.min(screen.height * 0.25, 180) || box.bottom > screen.height * 0.45) return false;
  return !!(box.pinned || box.named || screen.atTop);
}
