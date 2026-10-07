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
