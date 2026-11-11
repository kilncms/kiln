/**
 * Describing a picture that was just put in place of another.
 *
 * A picture's description (its alt attribute) is what a screen reader says
 * in its place. Replacing the picture used to keep the old one's words, so a
 * person who cannot see the page heard about a photo that was no longer
 * there. Now, once a new picture is in, the editor asks for its description
 * in its own dialog, with the old words in the box: they can be kept, changed,
 * or cleared on purpose (for a picture that is only decoration).
 *
 * describeCopy, describeButton and describedAlt are pure and tested in node;
 * askDescription needs a page.
 */

const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** What the dialog says. `oldAlt` is the description the picture had before. */
export function describeCopy(oldAlt) {
  const old = tidy(oldAlt);
  return {
    title: 'Describe the new picture',
    body: 'Describe this picture for people who cannot see it. A screen reader reads these words aloud in place of the picture.',
    before: old
      ? 'The words in the box described the picture that was here before. Keep them if they still fit, change them, or clear the box.'
      : 'The picture that was here before had no description.',
    label: 'What the picture shows',
    empty: 'Leave the box empty only when the picture is there just for decoration.',
    value: old,
    cancel: 'Decide later',
  };
}

/** The main button's words for what is in the box now. */
export function describeButton(typed, oldAlt) {
  const now = tidy(typed);
  if (!now) return 'Save with no description';
  return now === tidy(oldAlt) ? 'Keep this description' : 'Use this description';
}

/** The description as it is written into the page: one line, no spaces at its ends. */
export function describedAlt(typed) {
  return tidy(typed);
}

/** What the status line says when the question was put away unanswered. */
export const LATER_WORDS = 'The new picture still has the old description. Click the picture to change it.';

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Ask. `modal` is main.js's dialog. Resolves with the description to use
 * (possibly ''), or null when the dialog was put away without an answer.
 */
export function askDescription(modal, oldAlt) {
  const copy = describeCopy(oldAlt);
  return new Promise((resolve) => {
    let answer = null;
    const m = modal(`
      <h3>${esc(copy.title)}</h3>
      <p>${esc(copy.body)}</p>
      <p class="kiln-dim">${esc(copy.before)}</p>
      <label>${esc(copy.label)}
        <textarea id="kiln-describe" rows="3" maxlength="300">${esc(copy.value)}</textarea></label>
      <p class="kiln-dim" id="kiln-describe-empty" hidden>${esc(copy.empty)}</p>
      <div class="kiln-modal-actions">
        <button class="kiln-btn-ghost" data-close>${esc(copy.cancel)}</button>
        <button class="kiln-btn-publish" id="kiln-describe-go"></button>
      </div>`, { over: true, onClose: () => resolve(answer) });
    m.classList.add('kiln-describe');
    const box = m.querySelector('#kiln-describe');
    const go = m.querySelector('#kiln-describe-go');
    const sync = () => {
      go.textContent = describeButton(box.value, oldAlt);
      m.querySelector('#kiln-describe-empty').hidden = !!tidy(box.value);
    };
    box.addEventListener('input', sync);
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go.click(); } });
    sync();
    go.onclick = () => { answer = describedAlt(box.value); m._kilnClose(); };
    box.focus();
    box.select();
  });
}
