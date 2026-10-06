/**
 * The first minute of editing.
 *
 * Small pure helpers behind the always-visible Publish button. Kept apart from
 * main.js so node tests can check them without a browser.
 */

/** Label for a Publish control: "Publish", "Publish 1 edit", "Publish 3 edits". */
export function publishLabel(n, { suggest = false } = {}) {
  if (suggest) return 'Suggest changes';
  return n > 0 ? `Publish ${n} edit${n > 1 ? 's' : ''}` : 'Publish';
}

/** The commit message a page publish gets; `keys` are the edited fields, in order. */
export function editCommitMessage(path, keys) {
  return `Edit ${path}: ${keys.join(', ')} (via Kiln)`;
}
