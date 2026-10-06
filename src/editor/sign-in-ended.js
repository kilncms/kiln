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
 *   kind 'ended'    the sign-in is over (a 401, whatever its body says)
 *   kind 'refused'  signed in, but this is not allowed (a 403)
 *   kind 'other'    anything else; nothing is concluded about the sign-in
 *
 * `ownerMust` is true when the worker says the site's owner has something to
 * correct first (`code: "repo_changed"`); `message` is the worker's sentence
 * about it. `reason` is what a 403 gave as its reason, in the answer's own
 * words.
 */
export function readFailure(err) {
  const status = Number.isInteger(err?.status) ? err.status : 0;
  const data = err?.data && typeof err.data === 'object' ? err.data : {};
  const out = { kind: 'other', status, ownerMust: false, message: '', reason: '' };
  if (err?.signIn === 'ended' || (!err?.signIn && status === 401)) {
    out.kind = 'ended';
    out.ownerMust = data.code === 'repo_changed';
    if (out.ownerMust && typeof data.message === 'string') out.message = data.message.trim();
  } else if (status === 403 && !rateLimited(data)) {
    out.kind = 'refused';
    const said = [data.error, data.message].find(v => typeof v === 'string' && v.trim());
    out.reason = said ? said.trim().slice(0, 300) : '';
  }
  return out;
}

/** GitHub answers 403 when it is asked too often: that is about the hour, not about the person. */
function rateLimited(data) {
  return /rate limit/i.test(`${typeof data.message === 'string' ? data.message : ''} ${typeof data.error === 'string' ? data.error : ''}`);
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

// ─── At Publish ──────────────────────────────────────────────────────────────

const editsAre = (n) => (n === 1 ? 'Your edit is' : `Your ${n} edits are`);

/**
 * Signing in again loads the page afresh. What of the unpublished work is
 * still there afterwards?
 *
 * counts: { edits, source, structural, files } as staged now (text edits to
 * the page, text edits to content files, changes to what is editable or to
 * sections, queued uploads).
 * saved: the browser's saved copy was read back and holds every text edit.
 * filesKept: how many of the queued uploads are kept beside it.
 *
 * Text edits and their uploads are what the saved copy holds ("Pick up where
 * you left off?"). Changes to what is editable, and added or removed
 * sections, are not in it.
 */
export function whatSurvives(counts, { saved = false, filesKept = 0 } = {}) {
  const text = counts.edits + counts.source;
  const textKept = text > 0 && saved;
  const filesLost = Math.max(0, counts.files - (textKept ? filesKept : 0));
  return { text, textKept, structuralLost: counts.structural, filesLost, all: textKept && !counts.structural && !filesLost };
}

/**
 * What the person is told when something they did found out that the sign-in
 * has ended. `publishing` is true when that something was Publish. Nothing
 * staged has been touched: this only says where things stand, before the
 * person leaves the page.
 *
 * Returns { title, text, detail, status, signIn, copy, copyFirst }: `signIn`
 * offers "Sign in again", `copy` offers "Copy my text", and `copyFirst` says
 * the words would not survive signing in, so copying is the thing to do first.
 */
export function publishEnded({ way, ownerMust = false, message = '', counts, survives, publishing = true }) {
  const n = counts.edits + counts.source;
  const anything = n + counts.structural + counts.files > 0;
  const lead = publishing && anything ? 'Nothing was published. ' : '';
  const out = {
    title: 'Your sign-in has ended',
    status: publishing && anything ? 'Not published: your sign-in has ended.' : 'Your sign-in has ended.',
    text: '', detail: '', signIn: !ownerMust, copy: false, copyFirst: false,
  };
  if (ownerMust) {
    out.detail = message ? `For the owner: ${message}` : '';
    out.text = `${lead}The site’s owner has something to correct before anyone can sign in again, so please ask them.`;
    if (n) {
      out.copy = true;
      out.text += survives.textKept
        ? ` ${editsAre(n)} saved in this browser for a week: copy your text to keep it longer.`
        : ` ${editsAre(n)} still on this page, but only until it is closed: copy your text to keep it.`;
    }
    return out;
  }
  if (!anything) {
    out.text = `Please sign in again with ${wayName(way)} to carry on.`;
    return out;
  }
  if (survives.all) {
    out.text = `${lead}${editsAre(n)} saved in this browser and will be back on this page when you have signed in again with ${wayName(way)}.`;
    return out;
  }
  const parts = [`${lead}Signing in again with ${wayName(way)} loads this page afresh.`];
  if (n && survives.textKept) parts.push(`${editsAre(n)} saved in this browser and will be back.`);
  if (n && !survives.textKept) parts.push(`This browser could not save ${n === 1 ? 'your edit, so it' : 'your edits, so they'} will not be here afterwards.`);
  if (survives.structuralLost) parts.push('Parts you made editable, added or removed cannot be saved and will need doing again.');
  if (survives.filesLost) parts.push('The pictures or files you added could not be saved and will need adding again.');
  if (n) { parts.push('Copy your text first to be sure of it.'); out.copy = true; out.copyFirst = !survives.textKept; }
  out.text = parts.join(' ');
  return out;
}

/**
 * What the person is told when a publish is answered 403: they are signed
 * in, and this change is not theirs to make (taken off this page, a kind of
 * access that does not include it, or a change only the owner may make).
 * Signing in again would not help, so it is not offered; the text can be
 * copied.
 */
export function publishRefused({ way, reason = '', counts }) {
  const n = counts.edits + counts.source;
  const ask = way === 'github' ? 'check that you can still write to the repository on GitHub' : 'ask the site’s owner';
  return {
    title: 'This was not published',
    status: 'Not published: your sign-in does not allow this change.',
    text: 'Your sign-in does not allow this change, so nothing was published. '
      + (n ? `${editsAre(n)} still on this page: copy your text to keep it, and ${ask}.` : `Please ${ask}.`),
    detail: reason ? `The answer was: ${reason}` : '',
    signIn: false,
    copy: n > 0,
  };
}

/** The unpublished text as something to paste elsewhere: each edit's name, then its words. */
export function editsAsText(items) {
  return (items || [])
    .map(i => ({ label: String(i?.label ?? '').trim(), text: String(i?.text ?? '').trim() }))
    .filter(i => i.text)
    .map(i => (i.label ? `${i.label}\n${i.text}` : i.text))
    .join('\n\n');
}

/** The status line once the edits are back after signing in again. */
export function backAfterSignIn(n, files = 0) {
  return `You are signed in again, and ${n === 1 ? 'your edit is' : `your ${n} edits are`} back on this page${files ? ', with the files they added' : ''}. Publish when ready.`;
}
