/**
 * The editor from the keyboard, and read aloud.
 *
 * While the editor is on, every editable part of the page can be reached with
 * Tab, says what it is, and opens with Enter (or Space) the way a click opens
 * it. What the editor puts on a part for that (tabindex, role, aria-label) is
 * its own, like its classes: each part notes which of them the editor added
 * (FOCUS_MARK), and they come off again before anything is published, so a
 * site's own tabindex or label is never touched and the editor's never reaches
 * the file.
 *
 * Pure DOM helpers, tested in node with a small fake element.
 */

/** The attribute that lists the attributes the editor added to a part, space-separated. */
export const FOCUS_MARK = 'data-kiln-focus';

/** The attributes the editor may add to a part so it can be reached and named. */
export const FOCUS_ATTRS = ['tabindex', 'role', 'aria-label', 'aria-multiline'];

/** The first few words of a part, on one line, for its name. */
export function shortWords(text, max = 60) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

/**
 * What a screen reader says for a part at rest.
 *   name     the part's name as a person reads it ("Hero headline")
 *   picture  true for a picture
 *   words    what the part says now (a picture: its description)
 */
export function partLabel(name, picture, words) {
  const said = shortWords(words);
  if (picture) return said ? `Change picture: ${name}. ${said}` : `Change picture: ${name}`;
  return said ? `Edit ${name}: ${said}` : `Edit ${name}`;
}

/**
 * What a screen reader says for a part that cannot be changed here: what it
 * is and holds, then why, in the same words a click shows.
 */
export function lockedLabel(name, picture, words, why) {
  const said = shortWords(words);
  const what = picture ? `Picture: ${name}` : name;
  const reason = String(why || '').trim();
  return `${what}${said ? `: ${said}` : ''}.${reason ? ` ${reason}` : ''}`.replace(/([.!?…])\./, '$1');
}

/** Set `attr` on `el` unless the site already has it there; note that the editor added it. */
function put(el, attr, value) {
  const mine = (el.getAttribute(FOCUS_MARK) || '').split(' ').filter(Boolean);
  if (!mine.includes(attr)) {
    if (el.hasAttribute(attr)) return;   // the site's own: left as it is
    mine.push(attr);
    el.setAttribute(FOCUS_MARK, mine.join(' '));
  }
  el.setAttribute(attr, value);
}

/** Take off an attribute the editor added (and only one it added). */
function drop(el, attr) {
  const mine = (el.getAttribute(FOCUS_MARK) || '').split(' ').filter(Boolean);
  if (!mine.includes(attr)) return;
  el.removeAttribute(attr);
  const left = mine.filter(a => a !== attr);
  if (left.length) el.setAttribute(FOCUS_MARK, left.join(' '));
  else el.removeAttribute(FOCUS_MARK);
}

/** A part, at rest: in the tab order, a button with a name. */
export function reachable(el, label) {
  put(el, 'tabindex', '0');
  put(el, 'role', 'button');
  put(el, 'aria-label', label);
  drop(el, 'aria-multiline');
}

/** A part being typed in: a text box named for the part (its words are its value). */
export function typing(el, name, multiline) {
  put(el, 'tabindex', '0');
  put(el, 'role', 'textbox');
  put(el, 'aria-label', name);
  if (multiline) put(el, 'aria-multiline', 'true');
}

/** True when `el` is a part the editor made reachable. */
export function isReachable(el) {
  return !!el && typeof el.getAttribute === 'function' && (el.getAttribute(FOCUS_MARK) || '').split(' ').includes('tabindex');
}

/** Everything the editor added for focus taken off one element. */
export function unreach(el) {
  const mine = (el.getAttribute(FOCUS_MARK) || '').split(' ').filter(Boolean);
  for (const a of mine) if (FOCUS_ATTRS.includes(a)) el.removeAttribute(a);
  el.removeAttribute(FOCUS_MARK);
}

/** The same for `root` and everything inside it (a detached copy about to be staged). */
export function stripFocus(root) {
  if (root.hasAttribute?.(FOCUS_MARK)) unreach(root);
  root.querySelectorAll?.(`[${FOCUS_MARK}]`).forEach(unreach);
  return root;
}

/** What each button of the text toolbar is called, by its command. */
export const TOOL_NAMES = {
  bold: 'Bold',
  italic: 'Italic',
  underline: 'Underline',
  insertUnorderedList: 'Bullet list',
  insertOrderedList: 'Numbered list',
  link: 'Add a link',
  img: 'Add a picture here',
  doc: 'Add a document here',
  removeFormat: 'Clear formatting',
  attach: 'Attach a file to this link',
  ai: 'Writing help',
  hist: 'Earlier versions of this part',
};

/** The buttons that are on or off, and say which. */
export const TOGGLES = ['bold', 'italic', 'underline', 'insertUnorderedList', 'insertOrderedList'];

/**
 * Where an arrow key goes in a row of buttons: `at` is the one focused (or -1),
 * `n` how many there are. null for a key that does not move.
 */
export function arrowStep(key, at, n) {
  if (!n) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (at + 1) % n;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return at <= 0 ? n - 1 : at - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return null;
}
