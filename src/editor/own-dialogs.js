/**
 * The editor's own questions.
 *
 * (Two more act on a demo or a draft and used to ask nothing at all: "Start
 * over" and "Delete draft". They ask here too, and say what will be lost.)
 *
 * Four things were still asked in the browser's own grey box, which looks
 * like nothing else in the editor and says "OK" for whatever it is about to
 * do: deleting a comment thread, deleting a page (a box, then a second one to
 * type the file's name into), signing out with edits waiting, and the note
 * that goes with declining a suggestion. Each is one dialog of the editor's
 * now, whose buttons say what they do. So is the last of them: making text
 * editable whose words in the page's file are not the words on screen.
 *
 * ownDialogCopy and answerOf are pure and tested in node; askFirst needs a page.
 *
 * A fifth kind of question has two real answers and is asked by askWhich:
 * whose version of a field stands, when someone else changed it meanwhile.
 */

/**
 * What a question says: { title, body, go, cancel } and, when something is
 * typed into it, `input`: { label } for a note, { label, match } for a name
 * that has to be typed before the button works.
 */
export function ownDialogCopy(kind, info = {}) {
  if (kind === 'delete-thread') {
    return { title: 'Delete this comment thread?',
      body: 'It is removed for everyone who can see comments, and it can’t be brought back.',
      cancel: 'Keep it', go: 'Delete thread' };
  }
  if (kind === 'delete-page') {
    const name = String(info.path || '').split('/').pop();
    return { title: 'Delete this page?',
      body: `${info.path} comes off the site about a minute after it is deleted. It stays in the site’s history, so the site’s owner can bring it back. Its link in the menu is not removed: take that out in Site menu.`,
      input: { label: `To confirm, type the page’s file name: ${name}`, match: name },
      cancel: 'Keep the page', go: 'Delete page' };
  }
  if (kind === 'sign-out') {
    const one = info.edits === 1;
    return { title: `Sign out and discard your edit${one ? '' : 's'}?`,
      body: `You have ${info.edits} unpublished edit${one ? '' : 's'} on this page. Signing out throws ${one ? 'it' : 'them'} away.`,
      cancel: 'Stay signed in', go: 'Discard and sign out' };
  }
  if (kind === 'decline') {
    return { title: 'Decline this suggestion?',
      body: 'Nothing on the site changes. The person who suggested it sees that it was declined, with your note if you write one.',
      input: { label: 'A note for them (optional)' },
      cancel: 'Cancel', go: 'Decline' };
  }
  if (kind === 'reads-differently') {
    return { title: 'This text reads differently in the page’s file',
      body: `On screen: “${info.onScreen}”. In the file: “${info.inFile}”. A script on the site may change it when the page loads. If you make it editable, edits replace the words in the file, and the script may go on changing what visitors see.`,
      cancel: 'Leave it', go: 'Make it editable' };
  }
  if (kind === 'remove-entry') {
    return { title: `Remove “${info.title}”?`,
      body: `It comes off the site once the site has rebuilt, in a minute or two. ${info.path} stays in the site’s history, and History can bring it back.`,
      cancel: 'Keep it', go: 'Remove' };
  }
  if (kind === 'go-back') {
    return { title: 'Go back to this version?',
      body: `${info.path} is put back as it was ${info.when}, and the site rebuilds with it. The version it has now stays in History.`,
      cancel: 'Cancel', go: 'Go back to this' };
  }
  if (kind === 'start-over') {
    // The demo: what this browser holds of it, named, so the question says what the answer costs.
    const n = info.unpublished || 0;
    const held = [info.published && 'what you published', info.draft && 'your saved draft',
      n && (n === 1 ? 'your unpublished edit' : `your ${n} unpublished edits`)].filter(Boolean);
    const list = held.length > 1 ? `${held.slice(0, -1).join(', ')} and ${held[held.length - 1]}` : (held[0] || 'everything you did here');
    return { title: 'Start the demo over?',
      body: `This clears your private demo in this browser: ${list}. Every page goes back to how it first was, and none of it can be brought back.`,
      cancel: 'Keep my demo', go: 'Start over' };
  }
  if (kind === 'delete-draft') {
    const n = info.changes || 0;
    return { title: 'Delete this draft?',
      body: `${n ? `The draft and the ${n} change${n === 1 ? '' : 's'} in it are` : 'The draft is'} thrown away, and can’t be brought back. ${info.demo ? 'What you have published stays as it is.' : 'The page that is live stays as it is.'}`,
      cancel: 'Keep the draft', go: 'Delete draft' };
  }
  throw new Error(`no such question: ${kind}`);
}

/**
 * What the dialog answers when its button is pressed with `typed` in its box:
 * true for a plain question, the words for a note, the name once it is the
 * name. null while a name does not match yet (the button does nothing).
 */
export function answerOf(copy, typed) {
  if (!copy.input) return true;
  const words = String(typed ?? '').trim();
  if (copy.input.match !== undefined) return words === copy.input.match ? words : null;
  return words;
}

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Ask. `modal` is main.js's dialog; the question goes over whatever panel is
 * open and gives it back when it is put away. Resolves with the answer
 * (answerOf), or null when it was put away any other way: the other button,
 * the ✕, Escape, a click outside.
 */
export function askFirst(modal, copy) {
  return new Promise((resolve) => {
    let answer = null;
    const m = modal(`
      <h3>${esc(copy.title)}</h3>
      <p class="kiln-dim">${esc(copy.body)}</p>
      ${copy.input ? `<label>${esc(copy.input.label)}
        <input type="text" id="kiln-ask-in" autocomplete="off" autocapitalize="off" spellcheck="false"></label>` : ''}
      <div class="kiln-modal-actions">
        <button class="kiln-btn-ghost" data-close>${esc(copy.cancel)}</button>
        <button class="kiln-btn-publish kiln-btn-risky" id="kiln-ask-go">${esc(copy.go)}</button>
      </div>`, { over: true, onClose: () => resolve(answer) });
    m.classList.add('kiln-ask');
    const input = m.querySelector('#kiln-ask-in');
    const go = m.querySelector('#kiln-ask-go');
    const sync = () => { go.disabled = answerOf(copy, input ? input.value : '') === null; };
    if (input) {
      input.addEventListener('input', sync);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
    }
    sync();
    go.onclick = () => {
      const a = answerOf(copy, input ? input.value : '');
      if (a === null) return;
      answer = a;
      m._kilnClose();
    };
    // The keyboard starts on the box when there is one, and otherwise on the
    // button that changes nothing: Enter must not delete anything by itself.
    (input || m.querySelector('.kiln-modal-actions [data-close]')).focus();
  });
}

/**
 * Ask which of two versions of one field stands, when someone else changed it
 * since the page was built (source-fields.js theirsOrMine): both are shown,
 * and each button says whose it keeps. Resolves 'theirs', 'mine', or null
 * when it was put away without choosing (the ✕, Escape, a click outside).
 * The keyboard starts on the button that leaves the site as it is.
 */
export function askWhich(modal, copy) {
  return new Promise((resolve) => {
    let answer = null;
    const m = modal(`
      <h3>${esc(copy.title)}</h3>
      <p class="kiln-dim">${esc(copy.body)}</p>
      <div class="kiln-which"><strong>Theirs</strong><div class="kiln-which-text">${esc(copy.theirs)}</div></div>
      <div class="kiln-which"><strong>Yours</strong><div class="kiln-which-text">${esc(copy.mine)}</div></div>
      <p class="kiln-dim">${esc(copy.note)}</p>
      <div class="kiln-modal-actions">
        <button class="kiln-btn-ghost" id="kiln-which-theirs">${esc(copy.keep)}</button>
        <button class="kiln-btn-publish" id="kiln-which-mine">${esc(copy.use)}</button>
      </div>`, { over: true, onClose: () => resolve(answer) });
    m.classList.add('kiln-ask', 'kiln-ask-which');
    const pick = (which) => () => { answer = which; m._kilnClose(); };
    m.querySelector('#kiln-which-theirs').onclick = pick('theirs');
    m.querySelector('#kiln-which-mine').onclick = pick('mine');
    m.querySelector('#kiln-which-theirs').focus();
  });
}
