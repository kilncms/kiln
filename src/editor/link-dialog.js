/**
 * The link button's dialog: what it says.
 *
 * The toolbar's link button used to ask with the browser's own box ("Link to
 * (URL or /page):"), the one grey thing in an editor that is otherwise its
 * own design, and the first thing many people try. It now opens the editor's
 * dialog (main.js `linkDialog`): one box for the address, filled in with the
 * present address when the selection is inside a link, and a way to take the
 * link off again.
 *
 * What an address may be has not changed. It is taken as it is typed, as the
 * browser's box took it. When the edit is kept, the field's HTML goes through
 * the sanitizer as it always has (sanitize.js, KILN_URI_REGEXP): http, https,
 * mailto and tel addresses, addresses on this site ("/page", "#part",
 * "page.html") stay; an address with any other scheme ("javascript:") is
 * dropped, and the words stay without a link. The publish sheet still warns
 * about a link that goes nowhere.
 *
 * Pure, so it is tested in node.
 */

/**
 * `current`: the address of the link the selection is inside, or null when
 * it is inside none (an empty string is a link with no address yet).
 */
export function linkDialogCopy(current) {
  const has = typeof current === 'string';
  return {
    title: has ? 'Change this link' : 'Add a link',
    go: has ? 'Change link' : 'Add link',
    remove: has,
    value: has ? current : '',
  };
}

/** What the status line says when the button is pressed with nothing selected and no link under the cursor. */
export const LINK_NEEDS_WORDS = 'Select the words to turn into a link first.';
