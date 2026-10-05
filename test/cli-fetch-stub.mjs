/**
 * Preloaded with `node --import` so the REAL cli/index.mjs runs against canned
 * network answers (see cli-doctor.test.js). KILN_TEST_FETCH is a JSON map of
 * URL (or URL prefix) → { status?, json?, body?, headers? } | "down". Anything
 * not in the map fails the way an unreachable host does, so a test never
 * touches the network. Not a test file itself.
 */
const table = JSON.parse(process.env.KILN_TEST_FETCH || '{}');
const keys = Object.keys(table).sort((a, b) => b.length - a.length);   // longest match wins

globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  const key = keys.find(k => url === k || url.startsWith(k));
  const hit = key === undefined ? 'down' : table[key];
  if (hit === 'down') throw new TypeError('fetch failed');
  const body = hit.body !== undefined ? hit.body : JSON.stringify(hit.json ?? {});
  const status = hit.status ?? 200;
  return new Response([204, 302, 304].includes(status) ? null : body,
    { status, headers: hit.headers ?? { 'Content-Type': 'application/json' } });
};
