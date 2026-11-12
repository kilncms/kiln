/**
 * Showing the person the part that just changed, without taking them away
 * from where they are.
 *
 * Undo used to bring whatever it changed to the middle of the screen. For a
 * list that is the middle of the whole list: remove the third card of a long
 * list, press Undo, and the page ran three screens down to cards that had
 * nothing to do with it. The card came back where the person had just been
 * looking, and they were no longer there to see it.
 *
 * So the page moves only as far as it has to. What is already in front of the
 * person stays where it is; what is cut off at an edge is nudged in; only
 * what is off the screen altogether is brought to it.
 *
 * Pure, and tested in node.
 */

/**
 * How to bring a part into view.
 *   box      { top, bottom } of the part, measured from the top of the screen
 *   screen   the height of the screen
 *   covered  { top, bottom }: how much of the screen's top and bottom is
 *            under something (the editor's own buttons, a bar the site pins)
 * Returns 'stay' (do not move), 'nearest' (the least movement that shows all
 * of it), 'center' (it is out of sight, or under something: bring it to the
 * middle) or 'start' (it is taller than the screen and out of sight: show
 * where it begins).
 */
export function whereTo(box, screen, covered = {}) {
  const from = covered.top || 0, to = screen - (covered.bottom || 0);
  const room = Math.max(1, to - from);
  const height = box.bottom - box.top;
  const seen = Math.max(0, Math.min(box.bottom, to) - Math.max(box.top, from));
  if (height <= room) {
    if (seen >= height - 1) return 'stay';
    // Cut off by the edge of the screen: the least movement shows the rest. Out of
    // sight, or on the screen with something lying on part of it: to the middle.
    const onScreen = box.top >= 0 && box.bottom <= screen;
    return seen > 0 && !onScreen ? 'nearest' : 'center';
  }
  // Taller than the screen (a whole list, a long text): a good piece of it in sight is enough.
  return seen >= Math.min(room / 3, 160) ? 'stay' : 'start';
}

/**
 * How much of the screen's top and bottom is under things that stay there
 * while the page scrolls (the editor's own buttons, its line of words, the
 * demo's banner, the guide's tip).
 *   boxes   { top, bottom } of each, measured from the top of the screen
 *   screen  the height of the screen
 * Each counts for the edge it is nearer to. One that takes more than half the
 * screen (a sheet, a dialog) is not a strip along an edge and is left out, and
 * so is one that is off the screen.
 * Returns { top, bottom } in pixels.
 */
export function coveredBy(boxes, screen) {
  let top = 0, bottom = 0;
  for (const b of boxes || []) {
    if (!b || !(b.bottom > b.top) || b.bottom <= 0 || b.top >= screen || b.bottom - b.top > screen / 2) continue;
    if ((b.top + b.bottom) / 2 < screen / 2) top = Math.max(top, b.bottom);
    else bottom = Math.max(bottom, screen - b.top);
  }
  return { top, bottom };
}

/**
 * How far to move the page so that something the person has just opened can
 * be seen whole and pressed: in pixels, more than 0 to go down the page, less
 * than 0 to go up it, 0 when it already shows. It is the least that brings it
 * clear of what covers the top and the bottom of the screen, by `gap` pixels.
 *
 * On a phone a block's buttons open in a row at the foot of the block. On a
 * tall block that is a long way from the "more" button that opened them: under
 * the editor's own buttons along the bottom of the screen, or below the screen
 * altogether, where the tap seemed to do nothing.
 *   box      { top, bottom } of what was opened, from the top of the screen
 *   screen   the height of the screen
 *   covered  { top, bottom }: how much of the screen's top and bottom is
 *            under something
 * Something taller than the room there is shows where it begins.
 */
export function nudge(box, screen, covered = {}, gap = 8) {
  const from = (covered.top || 0) + gap, to = screen - (covered.bottom || 0) - gap;
  if (box.bottom - box.top > to - from) return Math.round(box.top - from);
  if (box.bottom > to) return Math.round(box.bottom - to);
  if (box.top < from) return Math.round(box.top - from);
  return 0;
}
