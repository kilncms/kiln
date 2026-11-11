/**
 * Where the round Kiln button sits once a person has dragged it.
 *
 * It used to end up stuck in the top-left corner, over the site's logo: while
 * the button was hidden (make-editable mode, for one) a resize measured an
 * empty box at 0,0, "clamped" that to 8,8 and saved it, so every later visit
 * started there. Now a hidden button is left alone, a position saved on a
 * screen of another size keeps its distance from the nearest edges, and a spot
 * in the top band of the screen, where a site keeps its header, is not a place
 * for it at all: the button goes back to its bottom corner.
 */

export const FAB_EDGE = 8;     // closest it comes to an edge of the screen
export const FAB_SIZE = 56;    // room it needs (the pencil and its shadow)

/** The top band no button may sit in: where a site's header and logo are. */
export function headerBand(screenHeight) {
  return Math.max(160, Math.round(screenHeight * 0.2));
}

/** A box with no size is a hidden element: it says nothing about where it is. */
export function isHiddenBox(r) {
  return !r || !(r.width > 0) || !(r.height > 0);
}

/**
 * pos: { x, y, w?, h? } (w and h: the screen it was saved on). screen: { w, h }.
 * Returns { x, y } to put the button at, or null for its own bottom corner.
 */
export function fabSpot(pos, screen) {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return null;
  let { x, y } = pos;
  // Saved on another screen size: keep its distance from the edges nearest it.
  if (Number.isFinite(pos.w) && pos.w > 0 && pos.w !== screen.w && x > pos.w / 2) x = screen.w - (pos.w - x);
  if (Number.isFinite(pos.h) && pos.h > 0 && pos.h !== screen.h && y > pos.h / 2) y = screen.h - (pos.h - y);
  x = Math.min(Math.max(x, FAB_EDGE), screen.w - FAB_SIZE);
  y = Math.min(Math.max(y, FAB_EDGE), screen.h - FAB_SIZE);
  if (y < headerBand(screen.h)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}
