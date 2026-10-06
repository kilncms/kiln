/**
 * Undo after publishing.
 *
 * A publish is one commit to one page file. Undoing it is another ordinary
 * commit that puts that file back to exactly what it was: the same write every
 * publish and every History restore ends in, with the file's current sha, so
 * it can never be a force push. Before writing, and again inside the write's
 * retry, the file must still be what was published. If it is not, someone else
 * has published to it since, and nothing is written.
 */
import { getFile, editFile } from '../github.js';

class ChangedSince extends Error {}

/** The commit message for an undo: names what was undone, in History's own form. */
export function undoMessage(published) {
  const what = String(published || 'a change').split('\n')[0].replace(/\s*\(via Kiln\)\s*$/, '').replace(/"/g, "'").trim().slice(0, 72);
  return `Undo "${what || 'a change'}" (via Kiln)`;
}

/**
 * Put `path` back to `before`, but only while it still reads `after`.
 * Returns { ok: true, commit, text } or { ok: false, reason: 'changed' }.
 * Throws only when GitHub itself refuses for another reason.
 */
export async function revertPublish({ gh, repo, branch, path, before, after, message }) {
  const fresh = await getFile(gh, repo, path, branch, true);
  if (fresh.text !== after) return { ok: false, reason: 'changed' };
  try {
    const res = await editFile(gh, repo, path, branch, (text) => {
      if (text !== after) throw new ChangedSince('the file changed');
      return before;
    }, undoMessage(message));
    return { ok: true, commit: res.commit || null, text: before };
  } catch (err) {
    if (err instanceof ChangedSince) return { ok: false, reason: 'changed' };
    throw err;
  }
}

/**
 * What to remember about a publish so it can be undone: the staged entries it
 * retired (as JSON), and the baselines they replaced.
 */
export function publishRecord(fields) {
  return { entries: new Map(), prevBase: new Map(), prevBaseAttrs: new Map(), structural: [], ...fields };
}

/**
 * Put a published record's edits back into the stage. `stage` is
 * { pending, undoBase, undoBaseAttrs, structural } (Maps and an array).
 * An edit made to the same field since the publish is newer and is kept.
 * Returns the keys that are pending again.
 */
export function restage(rec, stage) {
  const back = [];
  for (const [key, json] of rec.entries) {
    if (rec.prevBase.has(key)) {
      const v = rec.prevBase.get(key);
      if (v === undefined) stage.undoBase.delete(key); else stage.undoBase.set(key, v);
    }
    if (rec.prevBaseAttrs.has(key)) {
      const v = rec.prevBaseAttrs.get(key);
      if (v === undefined) stage.undoBaseAttrs.delete(key); else stage.undoBaseAttrs.set(key, v);
    }
    if (!stage.pending.has(key)) stage.pending.set(key, JSON.parse(json));
    back.push(key);
  }
  for (const op of rec.structural) if (!stage.structural.includes(op)) stage.structural.push(op);
  return back;
}
