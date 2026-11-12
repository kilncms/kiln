/**
 * Find & replace across the site (the Find & replace tool in main.js).
 *
 * "Preview matches" reads every page once and counts the matches. "Replace
 * all" then saves every page that had one as ONE change: either each of them
 * has the new words or none has. Nothing is written until that one commit,
 * so a refusal part-way (the service or GitHub saying "asked too often", a
 * page that cannot be read) leaves the site exactly as it was.
 *
 * It asks as little as it can, because every request counts towards what the
 * Kiln service and GitHub allow in a minute: one request to list the files
 * and one to read each page for the preview; then one to list the files again
 * and five to commit, however many pages changed (the pages' new text rides in
 * the request that builds the tree, see commitFiles' `inlineText`). For a
 * site of N pages that is N + 7 requests, where it was up to 2N + 6: a second
 * request for every page that had a match.
 *
 * The second listing is there because the replacement is made in the text
 * that the preview read, and a person may look at the preview for a while. A
 * page somebody published in between would get its older words back. The
 * listing names each file's version, so one request says whether any page
 * with a match has changed since it was read; if one has, nothing is replaced
 * and the person is asked to preview again.
 *
 * Pure of the page: everything it needs is handed in, so it is tested in node
 * (test/find-replace.test.js).
 */

/** No more pages than this are searched in one go. */
export const FIND_PAGES_MAX = 100;

/** The pages of a repository's file listing that are searched, each with its version. */
export function findPages(tree) {
  return ((tree && tree.tree) || [])
    .filter(t => t.type === 'blob' && typeof t.path === 'string' && t.path.endsWith('.html'))
    .map(t => ({ path: t.path, sha: t.sha }))
    .slice(0, FIND_PAGES_MAX);
}

/** How many requests a preview and a replace make between them on a site of `pages` pages. */
export const findReplaceRequests = (pages) => pages + 7;

/** How many times `find` is in `text`, as it is written (capitals and all). */
export const countMatches = (text, find) => (find ? text.split(find).length - 1 : 0);

/** `text` with every `find` replaced by `repl`, both taken as written. */
export const replaceAll = (text, find, repl) => text.split(find).join(repl);

const listing = (gh, repo, branch) => gh.request('GET', `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);

/**
 * Read every page once and say where `find` is. Returns { pages, hits }:
 * `pages` is how many were read, `hits` is each page with a match, as
 * { path, count, text, sha }. `onStep` is told { done, of } as each is read.
 */
export async function findEverywhere({ gh, repo, branch, find, getFile, onStep = () => {} }) {
  const pages = findPages(await listing(gh, repo, branch));
  const hits = [];
  for (let i = 0; i < pages.length; i++) {
    onStep({ done: i + 1, of: pages.length });
    const file = await getFile(gh, repo, pages[i].path, branch);
    const count = countMatches(file.text, find);
    if (count) hits.push({ path: pages[i].path, count, text: file.text, sha: file.sha });
  }
  return { pages: pages.length, hits };
}

/** The line that says a page changed between the preview and the replace. */
export function changedSinceText(paths) {
  const shown = paths.slice(0, 3).join(', ');
  const more = paths.length > 3 ? ` and ${paths.length - 3} more` : '';
  return `Nothing was replaced. ${paths.length === 1 ? `${shown} has` : `${shown}${more} have`} been changed since the matches were found. Press “Preview matches” again, then replace.`;
}

/**
 * Replace `find` with `repl` on every page of `hits`, as one commit. Returns
 * { changed, commit }. Throws what a request threw, or an error whose
 * `changedSince` lists the pages that are no longer as the preview read them;
 * either way nothing has been written unless the commit itself was made.
 */
export async function replaceEverywhere({ gh, repo, branch, hits, find, repl, commitFiles }) {
  const tree = await listing(gh, repo, branch);
  const now = new Map(((tree && tree.tree) || []).filter(t => t.type === 'blob').map(t => [t.path, t.sha]));
  // A listing GitHub cut short may leave a page out: that page is not called changed.
  const moved = hits.filter(h => h.sha && (now.has(h.path) ? now.get(h.path) !== h.sha : !tree.truncated)).map(h => h.path);
  if (moved.length) {
    const err = new Error(changedSinceText(moved));
    err.changedSince = moved;
    throw err;
  }
  const changed = hits.map(h => ({ path: h.path, text: replaceAll(h.text, find, repl) }));
  const commit = await commitFiles(gh, repo, branch, changed,
    `Replace “${find}” → “${repl}” on ${changed.length} pages (via Kiln)`, { inlineText: true });
  return { changed, commit };
}
