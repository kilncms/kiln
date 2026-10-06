/**
 * When a sign-in has ended.
 *
 * The worker ends an invited editor's sign-in by no longer knowing the
 * session: the person was taken off People (or taken off and added back), the
 * repository was renamed and the sessions under the old name went with it, or
 * the session ran out. From then on every request made with it is answered
 * 401. The owner's sign-in ends when the worker will no longer renew the
 * GitHub token.
 *
 * The editor used to do nothing with that answer: it did not start, showed
 * nothing, and kept the session, so /kiln sent the person straight back to a
 * page that did not start. This module says what a failed request means and
 * what the person is told. It reads only what every worker's answer already
 * carries (the status, `error`, `code`, `message`), so it works the same
 * against an older self-hosted worker.
 *
 * Pure: no DOM and no storage, so all of it is tested in node.
 */

/** How this person signs in: an invited editor with Google, the owner with GitHub. */
const WAYS = { google: 'Google', github: 'GitHub' };
const wayName = (way) => WAYS[way] || WAYS.google;

/**
 * What a failed request says about the sign-in.
 *
 * `err` is what the GitHub transport throws ({ status, data }) or the same two
 * fields read off a worker answer. `err.signIn`, when set, is what the token
 * renewal already found out, and wins over the status.
 *
 *   kind 'ended'  the sign-in is over (a 401, whatever its body says)
 *   kind 'other'  anything else; nothing is concluded about the sign-in
 *
 * `ownerMust` is true when the worker says the site's owner has something to
 * correct first (`code: "repo_changed"`); `message` is the worker's sentence
 * about it.
 */
export function readFailure(err) {
  const status = Number.isInteger(err?.status) ? err.status : 0;
  const data = err?.data && typeof err.data === 'object' ? err.data : {};
  const out = { kind: 'other', status, ownerMust: false, message: '' };
  if (err?.signIn === 'ended' || (!err?.signIn && status === 401)) {
    out.kind = 'ended';
    out.ownerMust = data.code === 'repo_changed';
    if (out.ownerMust && typeof data.message === 'string') out.message = data.message.trim();
  }
  return out;
}

/**
 * Where "Sign in again" goes: the worker's own sign-in, coming back to the
 * page the person is on (`path` starts with "/"; both workers' sign-ins have
 * always taken any such path in return_to).
 */
export function signInUrl({ worker, origin, path, repo, way }) {
  const back = String(path || '/').startsWith('/') ? String(path || '/') : '/';
  const q = `origin=${encodeURIComponent(origin)}&return_to=${encodeURIComponent(back)}`;
  return way === 'github'
    ? `${worker}/auth/login?${q}`
    : `${worker}/google/login?${q}&repo=${encodeURIComponent(repo || '')}`;
}

/**
 * What the page says when it loads with a sign-in that has ended: one
 * sentence, and a button when signing in again is what helps.
 *
 *   way        'google' | 'github'
 *   ownerMust  the worker said the owner has something to correct
 *   message    the worker's sentence for the owner
 *   draft      unpublished edits to this page are saved in this browser
 */
export function endedNotice({ way, ownerMust = false, message = '', draft = false } = {}) {
  if (ownerMust) {
    return {
      text: 'Your sign-in to edit this site has ended, and the site’s owner has something to correct before anyone can sign in again, so please ask them.'
        + (draft ? ' The edits you had not published are saved in this browser for a week.' : ''),
      detail: message ? `For the owner: ${message}` : '',
      button: '',
    };
  }
  return {
    text: `Your sign-in to edit this site has ended, so please sign in again with ${wayName(way)}`
      + (draft ? ' and the edits you had not published will be back on this page.' : '.'),
    detail: '',
    button: 'Sign in again',
  };
}

/**
 * What the editor does when the page could not be read as it starts.
 * Returns null when this is not about the sign-in (the caller carries on as
 * before), or { drop, notice }: `drop` says the stored sign-in is to be
 * removed, `notice` is what endedNotice gives.
 *
 * An invited editor's sign-in is over on a 401. The owner's is over when the
 * token could not be renewed, or GitHub answers 401 or 403 to "who am I".
 */
export function onLoadFailure(err, { mode = 'editor', draft = false } = {}) {
  const f = readFailure(err);
  const way = mode === 'admin' ? 'github' : 'google';
  const over = f.kind === 'ended' || (mode === 'admin' && !err?.signIn && f.status === 403);
  if (!over) return null;
  return { drop: true, notice: endedNotice({ way, ownerMust: f.ownerMust, message: f.message, draft }) };
}
