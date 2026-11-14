/**
 * The editor's words for an owner who has no GitHub account.
 *
 * A site's owner used to sign in with GitHub always, and the site's files
 * were in a repository of their own, so the editor's sentences say "GitHub"
 * and "your repo" to an owner. An owner whose site Kiln keeps has neither:
 * the files are in a repository of Kiln's that they can never open, and they
 * come in from Kiln's dashboard or with Google. The sign-in service says so
 * in its answer to GET /auth/session (`kept: true`).
 *
 * For that owner each such sentence says the same thing without the name.
 * Every sentence stays written where it is used, exactly as everybody else
 * reads it, and goes through ownerWords() there: this module only knows what
 * a kept owner reads in its place. A sentence that is not listed here is the
 * same for everyone.
 *
 * Pure: no DOM and no storage, so all of it is tested in node.
 */

/** The sentence (or the part of one) as it is written in the editor → what an owner without GitHub reads. */
const KEPT = new Map([
  // The status line.
  ['Publishing: saving to GitHub…', 'Publishing: saving…'],
  ['Published to GitHub ✓', 'Published ✓'],
  ['Can’t reach GitHub right now. Check your connection and reload.',
    'Kiln cannot reach your site’s files right now. Check your connection and reload.'],
  // The line that led to the commit on github.com, which this owner cannot open.
  ['Build failed. See the change on GitHub to find out why.', 'Build failed. The site still shows the version from before.'],
  // A new page being made.
  ['Saving to GitHub…', 'Saving…'],
  // A page with no file of its own.
  ["Kiln edits the HTML file for this page in your repository, but couldn't find one",
    "Kiln edits the HTML file for this page in your site’s files, but couldn't find one"],
  // Settings.
  ['This site (applies to everyone, saved to the repository)', 'This site (applies to everyone)'],
  // People.
  ['Members-only pages are kept in your site’s GitHub repository, so every editor you invite can read them.',
    'Members-only pages are kept with the rest of your site’s files, so every editor you invite can read them.'],
  // Add a section.
  ['(<code>_blocks/</code> in the repository)', '(<code>_blocks/</code> in your site’s files)'],
  ['at the repository root', 'at the top of your site’s files'],
]);

/** Every sentence a kept owner reads differently, as [written, read] pairs (for the tests and the notes). */
export const KEPT_SENTENCES = [...KEPT];

/**
 * A sentence as this person reads it: the one given, unless they are an owner
 * without GitHub (`kept`) and the sentence names GitHub or a repository.
 */
export function ownerWords(sentence, kept = false) {
  return kept === true && KEPT.has(sentence) ? KEPT.get(sentence) : sentence;
}
