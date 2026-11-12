/**
 * Saving the site menu to every page (the Site menu tool in main.js).
 *
 * The menu is written into each page's own file, so a save reads every page,
 * puts the new menu into the ones that carry it, and commits them all as ONE
 * change: either every page has the new menu or none has. Nothing is written
 * until every page has been read, so a refusal part-way (the service or
 * GitHub saying "asked too often", a page that cannot be read) leaves the site
 * exactly as it was.
 *
 * It asks as little as it can, because every request counts towards what the
 * Kiln service and GitHub allow in a minute: one request to list the files,
 * one to read each page, and five to commit, however many pages changed (the
 * pages' new text rides in the request that builds the tree, see
 * commitFiles' `inlineText`). For a site of N pages that is N + 6 requests,
 * where it used to be 2N + 6.
 *
 * Pure of the page: everything it needs is handed in, so it is tested in node
 * (test/menu-save.test.js).
 */

/** No more pages than this are given the menu in one save. */
export const MENU_PAGES_MAX = 100;

/** The pages of a repository's file listing that a menu save looks at. */
export function menuPages(tree) {
  return ((tree && tree.tree) || [])
    .filter(t => t.type === 'blob' && typeof t.path === 'string' && t.path.endsWith('.html'))
    .map(t => t.path)
    .slice(0, MENU_PAGES_MAX);
}

/** How many requests one save of the menu makes on a site of `pages` pages. */
export const menuSaveRequests = (pages) => pages + 6;

/** The line the dialog shows for each step of a save. */
export function menuStepText(step) {
  if (step.step === 'finding') return 'Step 1 of 3 · Finding the site’s pages…';
  if (step.step === 'reading') return `Step 1 of 3 · Reading the site’s pages… ${step.done}/${step.of}`;
  if (step.step === 'committing') return `Saving the menu on ${step.pages} page${step.pages === 1 ? '' : 's'} as one change…`;
  return '';
}

/**
 * Put `newInner` into the menu `menuKey` on every page that has it, as one
 * commit. Returns { changed, skipped, commit }: `changed` is each page with
 * its new text, `skipped` how many pages had no such menu, and `commit` is
 * null when no page had it (nothing was written). Throws what a request threw;
 * nothing has been written unless the commit itself was made.
 *
 * `getFile`, `applyEdits` and `commitFiles` are the editor's own (github.js,
 * engine.js); `onStep` is told { step: 'finding' | 'reading' | 'committing' }.
 */
export async function saveMenuEverywhere({ gh, repo, branch, menuKey, newInner, getFile, applyEdits, commitFiles, onStep = () => {} }) {
  onStep({ step: 'finding' });
  const tree = await gh.request('GET', `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const pages = menuPages(tree);
  const changed = [];
  let skipped = 0;
  for (let i = 0; i < pages.length; i++) {
    onStep({ step: 'reading', done: i + 1, of: pages.length });
    const file = await getFile(gh, repo, pages[i], branch);
    const result = applyEdits(file.text, [{ key: menuKey, html: newInner }]);
    if (result.applied.length) changed.push({ path: pages[i], text: result.html });
    else skipped++;
  }
  if (!changed.length) return { changed, skipped, commit: null };
  onStep({ step: 'committing', pages: changed.length });
  const commit = await commitFiles(gh, repo, branch, changed,
    `Update menu on ${changed.length} page${changed.length === 1 ? '' : 's'} (via Kiln)`, { inlineText: true });
  return { changed, skipped, commit };
}
