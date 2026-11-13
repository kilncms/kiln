/**
 * How many unpublished edits there are, said with one number everywhere.
 *
 * A tester's menu said "Discard 2 edits", the dialog that followed asked
 * "Discard 1 unpublished edit?", and just before that the line had said
 * "1 edit restored". The Discard button counted what the publish sheet lists
 * (a picture and its description are two things), while the dialog and the
 * line counted the parts of the page that hold an edit (one picture).
 *
 * There is one count now, the one every Publish control shows: the number of
 * things the publish sheet lists (countChanges in publish-sheet.js, read
 * through changeCount() in main.js). The Discard button, its question, the
 * "Done editing" question and the line after edits are put back all say that
 * number, in the words below. The copy of the edits kept in the browser
 * remembers the number too (saved-edits.js), so the question that offers them
 * back says what the line says once they are back.
 *
 * Pure, and tested in node (test/edit-count.test.js).
 */

/** "1 edit", "3 edits". */
export const editsWord = (n) => `${n} edit${n === 1 ? '' : 's'}`;

/** The Discard button in the Kiln menu. */
export function discardLabel(n) {
  return n ? `Discard ${editsWord(n)}` : 'Discard edits';
}

/** The question the Discard button asks. `n` is the number its own label showed. */
export function discardQuestion(n) {
  return n ? `Discard ${n} unpublished edit${n === 1 ? '' : 's'}?` : 'Discard what is not published yet?';
}

/** The heading "Done editing" shows while something is not published. */
export function unpublishedHeading(n) {
  return n ? `You have ${n} unpublished edit${n === 1 ? '' : 's'}` : 'You have changes that are not published yet';
}

/** The line once saved edits are back on the page. `files`: how many uploads came back with them. */
export function restoredLine(n, files = 0) {
  return `${editsWord(n)} restored${files ? ', with the files they added' : ''}. Publish when ready.`;
}
