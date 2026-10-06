/**
 * "A newer Kiln editor is available": where the newest released build is read
 * from, and the command that fetches it.
 *
 * "Latest" means released. scripts/release.mjs moves the `release` branch to
 * each production release, so its dist/VERSION is the stamp of the editor the
 * install commands hand out. `main` can be ahead of that with work nobody has
 * released: an editor that compared itself with `main` would tell every owner
 * to update to something `kiln update` does not give them yet. `main` is read
 * only when there is no `release` branch at all (a fork that has never made a
 * release). A `release` that fails to answer for any other reason is not
 * replaced by `main`: saying nothing is better than a false notice.
 */

const RAW = 'https://raw.githubusercontent.com/kilncms/kiln';

/** Where the newest stamp is looked for, in order. */
export const STAMP_URLS = [`${RAW}/release/dist/VERSION`, `${RAW}/main/dist/VERSION`];

/** What the notice tells the owner to run: the tool as it was released. */
export const UPDATE_COMMAND = 'npx github:kilncms/kiln#release update';

const isStamp = (s) => /^[\w.-]{1,40}$/.test(s);

/**
 * The newest released build stamp, or null when it cannot be read. Never
 * throws: a version check must not get in the way of editing.
 */
export async function latestStamp(fetchImpl = fetch) {
  try {
    for (const url of STAMP_URLS) {
      const res = await fetchImpl(url, { cache: 'no-store' });
      if (res.status === 404) continue;   // no such branch: the next one stands in
      if (!res.ok) return null;
      const stamp = (await res.text()).trim();
      return isStamp(stamp) ? stamp : null;
    }
  } catch { /* offline, blocked or rate-limited: give up quietly */ }
  return null;
}

/** Is `mine` behind `latest`? A development build is never called stale. */
export function isStale(mine, latest) {
  return !!mine && mine !== 'dev' && !!latest && isStamp(latest) && latest !== mine;
}
