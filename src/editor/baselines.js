/**
 * What Undo goes back to.
 *
 * For every editable part the editor keeps a baseline: the words and the
 * attributes it had before this session's unpublished changes. Undo, Esc,
 * "Drop" and the "before" column of the publish sheet all read it.
 *
 * It used to be copied once, as the editor started. A page is not finished
 * then: its entrance animation is running, a lazy loader has not yet put the
 * real picture in. So the baseline is taken again whenever the person begins
 * to change a part (a click on it, its toolbar opening, a press on one of a
 * list's buttons), for as long as no change to that part is waiting. Once one
 * is, the baseline stays: it is what that change is measured against.
 *
 * Pure, and tested in node.
 */

/**
 * The attributes of an editable element that have a baseline: the one it is
 * edited through (a picture's src, a link's href), a link's address, and a
 * picture's description and size. `style`: the picture's style as the file
 * would hold it, when the caller knows it. null when it has none.
 */
export function readAttrs(el, style) {
  const name = el.getAttribute('data-cms-attr');
  const out = {};
  if (name) out[name] = el.getAttribute(name) || '';
  if (el.tagName === 'A' && el.hasAttribute('href')) out.href = el.getAttribute('href');
  if (el.tagName === 'IMG') {
    out.alt = el.getAttribute('alt') || '';
    if (style !== undefined) out.style = style || '';
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Take the baseline of `key` from what the page shows now.
 *   stage  { pending, undoBase, undoBaseAttrs } (Maps)
 *   now    { html?, attrs? }: the part's HTML as it would be published, and its attributes
 * A part with a change waiting keeps the baseline it has: the words when its
 * words are waiting, each attribute when that attribute is.
 */
export function takeBase(stage, key, now) {
  const waiting = stage.pending.get(key);
  if (now.html !== undefined && waiting?.html === undefined) stage.undoBase.set(key, now.html);
  if (now.attrs) {
    const base = { ...(stage.undoBaseAttrs.get(key) || {}) };
    for (const [name, value] of Object.entries(now.attrs)) {
      if (!waiting?.attrs || !(name in waiting.attrs)) base[name] = value;
    }
    stage.undoBaseAttrs.set(key, base);
  }
}
