/**
 * Uploads that are waiting for Publish, kept in this browser.
 *
 * Unpublished edits already survive a closed tab or a crash (they are saved to
 * localStorage and offered back on the next visit). A picture or file added in
 * those edits did not: the edit came back pointing at a file that was never
 * committed. The bytes are too large for localStorage, so they are kept in
 * IndexedDB under the same page key and restored with the edits.
 *
 * filesToRestore, siteAddress and syncPlan are pure and exported for tests.
 * Every storage call may reject (private windows, blocked storage): callers
 * treat that as "nothing was kept", which is how things were before.
 */

const DB = 'kiln-pending-files';
const STORE = 'files';
const MAX_AGE = 7 * 24 * 3600 * 1000;   // the same week the saved edits are offered for

function open() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch (err) { reject(err); return; }
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

const idOf = (page, path) => `${page}\n${path}`;

/** Keep one queued upload. */
export function keepFile(page, path, base64) {
  return run('readwrite', s => s.put({ id: idOf(page, path), page, path, base64, ts: Date.now() }));
}

/** Forget queued uploads for a page: the named ones, or all of them when `paths` is null. */
export async function forgetFiles(page, paths = null) {
  const all = paths ? null : await run('readonly', s => s.getAll());
  const ids = paths ? paths.map(p => idOf(page, p)) : all.filter(f => f.page === page).map(f => f.id);
  if (!ids.length) return;
  await run('readwrite', s => { for (const id of ids) s.delete(id); });
}

/** The uploads kept for a page, newest state. Entries older than a week are dropped. */
export async function keptFiles(page, now = Date.now()) {
  const all = (await run('readonly', s => s.getAll())) || [];
  const old = all.filter(f => now - f.ts > MAX_AGE);
  if (old.length) run('readwrite', s => { for (const f of old) s.delete(f.id); }).catch(() => {});
  return all.filter(f => f.page === page && now - f.ts <= MAX_AGE).map(f => ({ path: f.path, base64: f.base64 }));
}

// ─── pure ────────────────────────────────────────────────────────────────────

/**
 * Of the kept uploads, the ones a set of restored edits still points at.
 * edits: { key: { html?, attrs? } }, and source: { ref: { value } } for the
 * content files. A file no edit mentions was abandoned (its swap was undone)
 * and stays behind.
 */
export function filesToRestore(files, edits, source = {}) {
  const hay = [
    ...Object.values(edits || {}).map(e => `${e.html ?? ''}\n${Object.values(e.attrs || {}).join('\n')}`),
    ...Object.values(source || {}).map(e => String(e?.value ?? '')),
  ].join('\n');
  return (files || []).filter(f => { const name = String(f.path).split('/').pop(); return !!name && hay.includes(name); });
}

/** A repository path as the address the page uses: 'site/assets/uploads/a.webp' with root 'site' → '/assets/uploads/a.webp'. */
export function siteAddress(path, root = '') {
  const pre = String(root || '').replace(/^\/+|\/+$/g, '');
  const p = String(path).replace(/^\/+/, '');
  return '/' + (pre && p.startsWith(pre + '/') ? p.slice(pre.length + 1) : p);
}

/** What to write and what to remove so that what is kept matches what is queued. */
export function syncPlan(queued, kept) {
  const q = new Set(queued), k = new Set(kept);
  return { add: [...q].filter(p => !k.has(p)), remove: [...k].filter(p => !q.has(p)) };
}
