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
