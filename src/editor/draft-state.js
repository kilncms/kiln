/**
 * Which pages have a saved draft (the Drafts tool in main.js).
 *
 * Drafts live on one branch, `kiln-drafts`. The first "Save as draft" makes
 * that branch from the published one, so it starts as a copy of the WHOLE
 * site as it was that day. A file on it that differs from the page is
 * therefore not yet a draft: every page published since the branch was made
 * differs from its old copy there. Offering those copies as drafts put a
 * page's old words in front of people with a "Publish it now" button.
 *
 * The rule: a page has a draft only if someone saved a draft of that page and
 * it has not been published or deleted since. The branch says so by itself.
 * Every save of a draft is a commit the editor writes, with a message only it
 * writes, so the LAST commit that changed the page's file on `kiln-drafts`
 * tells the whole story:
 *
 *   "Draft: <page> (via Kiln)"            someone saved a draft: there is one
 *   "Discard draft: …", "Draft published: …"   it was deleted or used: none
 *   anything else (a publish from before the branch was made, a commit made
 *   by hand)                              a leftover copy: none
 *
 * One request reads that commit, and only when the two texts differ.
 *
 * A draft also says which version of the page it was made from (the git name
 * of the page's file, on a line of its own in the commit). When the page is
 * still that version, the draft is the newer of the two. When it is not, the
 * page has been published since the draft was saved, the draft holds OLDER
 * words than the page, and the person is told that before they resume or
 * publish it. A draft saved by an editor from before 0.6.2 has no such line:
 * for those alone a second request asks when the page was last published,
 * and the two days are compared.
 *
 * Pure of the page: tested in node (test/draft-state.test.js).
 */

export const DRAFT_BRANCH = 'kiln-drafts';

const SHA_RE = /^[0-9a-f]{40}$/;
const FROM_RE = /^Kiln-Draft-Of: ([0-9a-f]{40})\s*$/m;

/** The commit that saves a draft. `from`: the version of the page it was made from (blobSha), if known. */
export function draftSaveMessage(path, from) {
  return `Draft: ${path} (via Kiln)${SHA_RE.test(from || '') ? `\n\nKiln-Draft-Of: ${from}` : ''}`;
}
/** The commit that deletes a draft. */
export const draftDeleteMessage = (path) => `Discard draft: ${path} (via Kiln)`;
/** The commit that puts away a draft once it has been published. */
export const draftPublishedMessage = (path) => `Draft published: ${path} (via Kiln)`;

/**
 * The last commit that changed one file on one branch. The same request the
 * History tool makes (older-versions.js commitsPageUrl), with the branch
 * named, so the service passes it for an invited editor as it does History's.
 */
export function lastChangeUrl(repo, path, branch) {
  return `/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}&per_page=1`;
}

/**
 * The name git gives a file with this text (its blob sha): the same text has
 * the same name, whoever asks and whenever. null where the browser cannot
 * work it out (a page not served over https has no `crypto.subtle`).
 */
export async function blobSha(text, subtle = globalThis.crypto?.subtle) {
  if (!subtle || typeof text !== 'string') return null;
  try {
    const body = new TextEncoder().encode(text);
    const head = new TextEncoder().encode(`blob ${body.length}\0`);
    const all = new Uint8Array(head.length + body.length);
    all.set(head);
    all.set(body, head.length);
    return [...new Uint8Array(await subtle.digest('SHA-1', all))].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

/**
 * Is this commit (one row of GitHub's list) a save of a draft of `path`?
 * Returns { from, by, when }, or null when it is anything else.
 */
export function readDraftSave(commit, path) {
  const message = commit && commit.commit && commit.commit.message;
  if (typeof message !== 'string' || !path) return null;
  if (message.split('\n')[0].trim() !== `Draft: ${path} (via Kiln)`) return null;
  const from = FROM_RE.exec(message);
  const who = commit.commit.author || {};
  return {
    from: from ? from[1] : null,
    by: typeof who.name === 'string' ? who.name.trim() : '',
    when: (commit.commit.committer && commit.commit.committer.date) || who.date || '',
  };
}

/**
 * Does the draft hold older words than the page? true: the page has been
 * published since the draft was saved. false: it has not. null: not known.
 *   pageSha      blobSha of the page as it is now
 *   lastPublish  the last commit that changed the page on the published
 *                branch, for a draft that does not say what it was made from
 */
export function olderThanPage(saved, { pageSha = null, lastPublish = null } = {}) {
  if (saved.from && pageSha) return saved.from !== pageSha;
  const c = lastPublish && lastPublish.commit;
  const published = Date.parse((c && ((c.committer && c.committer.date) || (c.author && c.author.date))) || '');
  const savedAt = Date.parse(saved.when || '');
  if (Number.isNaN(published) || Number.isNaN(savedAt)) return null;
  return published > savedAt;
}

/**
 * The draft of a page whose file on the drafts branch differs from the page:
 * null when that file is not a draft, else { from, by, when, older }.
 * One request; a second only for a draft from before 0.6.2 (see the top).
 * Throws what the first request threw: the caller then offers nothing, since
 * a copy that cannot be told from a draft is not put in front of anyone.
 */
export async function draftOfPage({ gh, repo, path, branch, pageText, subtle }) {
  const rows = await gh.request('GET', lastChangeUrl(repo, path, DRAFT_BRANCH));
  const saved = readDraftSave(Array.isArray(rows) ? rows[0] : null, path);
  if (!saved) return null;
  const pageSha = saved.from ? await blobSha(pageText, subtle) : null;
  let lastPublish = null;
  if (!(saved.from && pageSha)) {
    try {
      const pub = await gh.request('GET', lastChangeUrl(repo, path, branch));
      lastPublish = Array.isArray(pub) ? pub[0] || null : null;
    } catch { /* said as not known */ }
  }
  return { ...saved, older: olderThanPage(saved, { pageSha, lastPublish }) };
}

const dayOf = (when) => {
  const d = new Date(when);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
};

/**
 * What the dialog says about a draft: { title, body }.
 *   canDelete  this person is shown "Delete draft"
 *   day        how a date is written (the browser's own way unless told)
 */
export function draftWords(draft, { canDelete = true, day = dayOf } = {}) {
  const on = draft.when ? day(draft.when) : '';
  const saved = draft.by && on ? `${draft.by} saved it on ${on}. `
    : draft.by ? `${draft.by} saved it. `
    : on ? `It was saved on ${on}. ` : '';
  const who = canDelete ? '' : ' The site’s owner can delete it, and so can anyone who has the Drafts tool.';
  const safe = 'Nothing goes live until you publish, and you are shown every change first.';
  if (draft.older === true) {
    return {
      title: 'This page has a draft that is older than the page',
      body: `${saved}The page has been published since then, so the draft holds older words than the page does. Resuming it puts the draft’s words back on the page for you to look over. ${safe}${who}`,
    };
  }
  if (draft.older === null) {
    return {
      title: "There's a saved draft of this page",
      body: `${saved}Kiln could not check whether the page has been published since then. If it has, the draft holds older words than the page does. ${safe}${who}`,
    };
  }
  return {
    title: "There's a saved draft of this page",
    body: `${saved}It isn’t live. Resume editing it, publish it as it is, or leave it for later.${who}`,
  };
}

/** The line when an invited editor's sign-in was not let to delete a draft. */
export const DRAFT_DELETE_REFUSED = 'The draft was not deleted. The Kiln service did not let this sign-in do it. The site’s owner can delete it.';
