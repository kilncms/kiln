/**
 * What a person types counts as an edit while they type it.
 *
 * A tester clicked into a heading, typed a sentence and did not click
 * anywhere else. The Kiln button showed no count, the Publish button still
 * read "Publish", and closing the tab asked nothing, because the editor took
 * a change in only when the part was left. One click outside it and the count
 * was 1.
 *
 * Now, a short moment after the last key (TYPING_PAUSE), the count is drawn
 * again and the copy of the edits kept in the browser is written, both reading
 * the staged edits with the words of the open part laid over them, as if the
 * part had been left (withOpenBox in main.js, openBoxEdit and openListEdit in
 * saved-edits.js). When the page is about to be left the same is done at once,
 * without waiting, and the "Leave site?" question counts the open part too.
 *
 * Nothing is staged while a person types. The part is staged once, when it is
 * left, as it always was. That is what keeps Undo as it was: staging a part a
 * second time makes a second step that goes back only to the first, so a part
 * staged at every pause would have taken a sentence back one pause at a time.
 * Typing more in a part changes the one edit that is counted for it, and
 * words put back as they were are no edit at all.
 *
 * Pure, and tested in node (test/typing-counts.test.js).
 */

/** How long after the last key the count and the kept copy are brought up to date, in milliseconds. */
export const TYPING_PAUSE = 400;

/**
 * Runs `run` once, `wait` milliseconds after the last key of a burst of typing.
 * `key()` is called at every key and starts the wait again. `now()` runs it at
 * once, for the moment the page is about to go, and ends a wait that was on.
 * The timers are given in a test.
 */
export function afterLastKey(run, wait = TYPING_PAUSE, { set = (fn, ms) => setTimeout(fn, ms), clear = (t) => clearTimeout(t) } = {}) {
  let timer = null;
  const stop = () => { if (timer !== null) { clear(timer); timer = null; } };
  return {
    key() { stop(); timer = set(() => { timer = null; run(); }, wait); },
    now() { stop(); run(); },
    /** True while a key was pressed and the short moment has not passed. */
    get waiting() { return timer !== null; },
  };
}
