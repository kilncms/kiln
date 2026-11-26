/**
 * What a waiting edit was made against, kept from when it was made.
 *
 * A page's unpublished edits are kept in this browser with what each part held
 * when the person began editing it (`was`), a list as the page showed it before
 * the edit (`base`), and the version of the file (`sha`) (saved-edits.js
 * pageRecord). Publishing compares those with the file as it is then, so a
 * change someone else published to the same part meanwhile is asked about and
 * never written over.
 *
 * When the page is loaded again and the edits are put back, the page's own
 * reading of the file is newer, and it may already hold the words someone else
 * published to that part. Taken from that fresh reading, the "before" would
 * match their words, nothing would look changed, and their words would be
 * published over without a question. So what the kept copy said is carried
 * forward for every edit that came back with it, for as long as that edit
 * stays waiting; an edit published or dropped since starts afresh if it is
 * edited again.
 *
 * Pure: tested in node (test/before.test.js).
 */
import { savedPage, savedMore, savedSourceWas } from './saved-edits.js';

/** From a copy read back from storage: what its edits were made against, or null when it says nothing. */
export function priorFacts(stored) {
  const page = savedPage(stored);
  if (!page) return null;
  const more = savedMore(stored);
  const sourceWas = savedSourceWas(stored);
  if (!Object.keys(more).length && !Object.keys(sourceWas).length) return null;
  return { path: page.path, sha: page.sha || null, more, sourceWas };
}

/** What `prior` says one part's edit was made against: { was?, base? }, or null when it says nothing for it. */
export function carried(prior, key) {
  const m = prior && prior.more && Object.hasOwn(prior.more, key) ? prior.more[key] : null;
  if (!m || typeof m !== 'object') return null;
  const out = {};
  if (typeof m.was === 'string') out.was = m.was;
  if (typeof m.base === 'string') out.base = m.base;
  return Object.keys(out).length ? out : null;
}

/** `prior` holding only the parts still waiting in `edits` and `source`, or null when none is left. */
export function keepWaiting(prior, edits, source) {
  if (!prior) return null;
  const more = {};
  for (const key of Object.keys(prior.more || {})) {
    if (edits && Object.hasOwn(edits, key)) Object.defineProperty(more, key, { value: prior.more[key], enumerable: true, writable: true, configurable: true });
  }
  const sourceWas = {};
  for (const ref of Object.keys(prior.sourceWas || {})) {
    if (source && Object.hasOwn(source, ref)) Object.defineProperty(sourceWas, ref, { value: prior.sourceWas[ref], enumerable: true, writable: true, configurable: true });
  }
  if (!Object.keys(more).length && !Object.keys(sourceWas).length) return null;
  return { ...prior, more, sourceWas };
}

/** The version of the file to keep beside the edits: the kept copy's while an edit still rests on what it said, else this reading's. */
export function factsSha(prior, path, sha) {
  if (prior && prior.path === path && prior.sha && Object.keys(prior.more || {}).length) return prior.sha;
  return sha;
}

/**
 * Which of `keys` someone else has changed in the file since the person began
 * editing them. `freshSha` and `freshValues()` are the file as it is now (the
 * values are read only when needed); `pageSha` and `baseline` are this page's
 * own reading of it; `prior` is what came back with edits that were put back.
 * With no `prior` this is exactly the check a one-page publish always made.
 */
export function changedUnder({ keys, freshSha, freshValues, pageSha, baseline = {}, prior = null }) {
  const before = (k) => {
    const c = carried(prior, k);
    return c && c.was !== undefined ? c.was : baseline[k];
  };
  // An edit put back after a reload rests on an older reading than this page's: then the file is compared even when it has not changed since the page was loaded.
  const older = keys.some(k => { const c = carried(prior, k); return !!c && c.was !== undefined && c.was !== baseline[k]; });
  if (freshSha === pageSha && !older) return [];
  const now = freshValues() || {};
  return keys.filter(k => Object.hasOwn(now, k) && before(k) !== undefined && now[k] !== before(k));
}

/**
 * After "Reload & review": the person has been shown that someone else changed
 * these parts and chose to look again, so what the file holds now becomes what
 * their edits rest on. Without this, the same question would come back after
 * every reload. Returns the new `prior`.
 */
export function reviewed(prior, { path, sha, keys, values }) {
  const base = prior && prior.path === path ? prior : { path, sha, more: {}, sourceWas: {} };
  const more = { ...base.more };
  for (const k of keys) {
    if (!Object.hasOwn(values, k)) continue;
    Object.defineProperty(more, k, { value: { ...(Object.hasOwn(more, k) ? more[k] : {}), was: values[k] }, enumerable: true, writable: true, configurable: true });
  }
  return { ...base, path, sha, more };
}
