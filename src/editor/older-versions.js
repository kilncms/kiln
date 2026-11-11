// ─── History, a page of versions at a time ───────────────────────────────────
// GitHub hands back a file's commits a page at a time. History shows the newest
// page first, and "Show older versions" asks for the next one, until GitHub
// sends back fewer than a full page: that one ends with the first version.

export const VERSIONS_PER_PAGE = 20;

export const OLDER_LABEL = 'Show older versions';
export const OLDER_LOADING = 'Loading older versions…';
export const OLDER_FAILED = 'The older versions could not be read.';
export const FIRST_OF_PAGE = 'This is the first version of this page.';
export const FIRST_OF_PART = 'This is the first version of this section.';

/** The commits that changed one file, one page of them (page 1 is the newest). */
export function commitsPageUrl(repo, path, page, perPage = VERSIONS_PER_PAGE) {
  return `/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=${perPage}&page=${page}`;
}

/**
 * Reads a file's commits one page at a time through `gh` (the same transport
 * the editor uses for everything else: the owner's own calls, or an invited
 * editor's calls through the sign-in service).
 *   next()  → the next page's commits, never one already handed out (a publish
 *             made while History is open moves every page along by one).
 *             While a page is loading, asking again gets the same answer.
 *             A failed page is not counted, so asking again tries it again.
 *   done    → true once GitHub sent back fewer than a full page.
 */
export function commitPager(gh, repo, path, perPage = VERSIONS_PER_PAGE) {
  let page = 0;
  let done = false;
  let loading = null;
  const seen = new Set();
  const pager = {
    get done() { return done; },
    get loading() { return !!loading; },
    next() {
      if (done) return Promise.resolve([]);
      if (loading) return loading;
      loading = (async () => {
        try {
          const got = await gh.request('GET', commitsPageUrl(repo, path, page + 1, perPage));
          const list = Array.isArray(got) ? got : [];
          page += 1;
          if (list.length < perPage) done = true;
          const fresh = list.filter(c => c && c.sha && !seen.has(c.sha));
          fresh.forEach(c => seen.add(c.sha));
          return fresh;
        } finally { loading = null; }
      })();
      return loading;
    },
  };
  return pager;
}

/**
 * A section's history: from commits (newest first) with the section's value in
 * each, the versions where it changed. `rows` is what is already listed; the
 * new rows are added to it and returned. A commit without the section is
 * skipped (it was not on the page then).
 */
export function addPartRows(rows, items) {
  const added = [];
  let last = rows.length ? rows[rows.length - 1].v : null;
  for (const { c, v } of items) {
    if (v === undefined) continue;
    if (v !== last) { const row = { c, v }; rows.push(row); added.push(row); last = v; }
  }
  return added;
}
