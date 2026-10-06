/**
 * Which menu tools an invited editor is offered.
 *
 * The owner sees every tool. An invited editor sees a tool when People &
 * access grants it; with nothing chosen there, the defaults below apply. The
 * worker holds the same list for the writes it can tell apart (see
 * writeGrantNeeded in worker/index.js). Pure: no DOM, no state of its own.
 */

/** What an invited editor gets when the owner has not chosen anything. */
export const EDITOR_DEFAULT_FEATURES = ['pagesettings', 'history', 'draft'];

/**
 * who: { mode: 'admin' | 'editor', sandbox, features, scopeMode, pageInScope }
 * features is the array from People & access, or null / undefined for the defaults.
 */
export function hasGrant(who, feature) {
  if (who.mode === 'admin' || who.sandbox) return true;   // the demo shows everything
  const list = Array.isArray(who.features) ? who.features : EDITOR_DEFAULT_FEATURES;
  return list.includes(feature);
}

/**
 * "Make text/images editable" and "Add a gallery or events" change the page's
 * structure, which is published as an ordinary edit of this page. So beyond
 * the grant itself: the page must be one this editor can write, and the editor
 * must be one who publishes (a suggestion carries text edits only, and a
 * review seat only comments).
 */
export function offersMakeEditable(who) {
  if (!hasGrant(who, 'makeeditable')) return false;
  if (who.mode === 'admin' || who.sandbox) return true;
  if (who.scopeMode === 'suggest' || who.scopeMode === 'review') return false;
  return who.pageInScope !== false;
}
