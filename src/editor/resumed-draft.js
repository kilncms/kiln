/**
 * When is a saved draft used up by a publish?
 *
 * "Resume draft" brings the draft's parts onto the page as edits waiting for
 * Publish. Publishing them is the end of that draft: it is taken off the
 * drafts branch so the page does not offer it again later, when its words are
 * old. For that the editor leaves itself a note when a draft is resumed.
 *
 * The note used to say only which draft was resumed, and ANY later publish in
 * the same tab then counted as the publish of that draft. So this lost a
 * draft: resume it, save it as a draft again, come back, press "Later", and
 * publish some other change. The draft was marked as published, its words
 * never went live, and it was not offered again.
 *
 * The rule now: a publish uses a draft up only when the draft is still the
 * one that was resumed AND every part it brought back was among the parts
 * that publish wrote. A note that names no parts (one left by an older
 * editor) never counts. Saving a draft again throws the note away: what is
 * on the drafts branch is then a draft like any other.
 *
 * Pure, and tested in node (test/resumed-draft.test.js).
 */

/** The note left when a draft is resumed: the draft's file id and the names of the parts it brought back. */
export function resumedNote(sha, keys) {
  return JSON.stringify({ sha: String(sha || ''), keys: [...new Set((keys || []).map(String))] });
}

/** A note read back: { sha, keys }, or null when there is none worth the name. A bare id (an older editor's note) has no parts. */
export function readResumed(note) {
  if (!note || typeof note !== 'string') return null;
  if (/^[0-9a-f]{7,64}$/i.test(note)) return { sha: note, keys: [] };
  try {
    const n = JSON.parse(note);
    if (!n || typeof n !== 'object' || typeof n.sha !== 'string' || !n.sha) return null;
    return { sha: n.sha, keys: Array.isArray(n.keys) ? n.keys.map(String) : [] };
  } catch { return null; }
}

/**
 * True when the publish that just happened was the publish of the resumed
 * draft: `draftShaNow` is the draft file's id as it is on the drafts branch
 * now, `publishedKeys` the names of the parts the publish wrote.
 */
export function draftWasPublished(note, draftShaNow, publishedKeys) {
  const n = readResumed(note);
  if (!n || !n.keys.length || !draftShaNow || n.sha !== draftShaNow) return false;
  const written = new Set((publishedKeys || []).map(String));
  return n.keys.every(k => written.has(k));
}

/** True when the note is about a draft that is no longer the one on the drafts branch (saved again, deleted, replaced): it can be thrown away. */
export function noteIsStale(note, draftShaNow) {
  const n = readResumed(note);
  return !n || !draftShaNow || n.sha !== draftShaNow;
}
