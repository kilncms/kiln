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

/**
 * The guide "Help" opens, by who is signed in: the owner's, a member's, or the
 * editor's (which is also the right one for a visitor trying the demo).
 */
export function helpUrl(who) {
  if (who.mode === 'admin' && !who.sandbox) return 'https://kilncms.com/owners';
  if (who.role === 'member') return 'https://kilncms.com/members';
  return 'https://kilncms.com/editors';
}

/**
 * The line a signed-in person reads first: what they can do on this page, in
 * one true sentence. It used to tell everyone to click any outlined text,
 * including a comment-only editor, for whom nothing is outlined.
 *
 *   who: { user, touch, scopeMode, comments, pageFile }
 *   comments   the Comments tool is theirs (granted, or the owner)
 *   pageFile   the page is a file of its own in the repository. A page the
 *              site builds from content files is not, and neither a
 *              suggestion nor a comment can be filed against it yet.
 */
export function startLine(who) {
  const hello = `Signed in as ${who.user}.`;
  const built = 'because the site builds this page from its content files';
  if (who.scopeMode === 'review') {
    if (!who.comments) return `${hello} You can read this page. Nothing on it can be changed with this sign-in.`;
    return who.pageFile ? `${hello} You can comment on this page. Comments is in the menu.` : `${hello} Comments can’t be left here yet, ${built}.`;
  }
  if (who.scopeMode === 'suggest' && !who.pageFile) return `${hello} Suggestions can’t be made here yet, ${built}.`;
  return `${hello} ${who.touch ? 'Tap' : 'Click'} any outlined text to edit.`;
}
