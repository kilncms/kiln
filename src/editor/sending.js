/**
 * Whether a save or a publish is on its way to the service right now.
 *
 * "Site menu > Save to all pages" writes many pages and takes ten seconds or
 * more. A tester closed the tab in that time, the save was lost, and nothing
 * had warned them: the browser's "Leave site?" question was asked only while
 * the page held unpublished edits, and a menu being saved is not one of those.
 *
 * A count, not a yes or no, because two saves can overlap (a publish started
 * while a menu is still being saved) and the first to finish must not say that
 * nothing is being sent. Each save ends once, whether the service answered or
 * the attempt failed, and ending it twice changes nothing.
 *
 * main.js keeps one of these (state.sending), starts it at the press of the
 * button, and reads `any` when the page is about to be left.
 *
 * Pure, and tested in node (test/sending.test.js).
 */
export function makeSending() {
  let n = 0;

  /** A save has begun. Returns the function that ends it. */
  function start() {
    n++;
    let over = false;
    return () => {
      if (over) return;
      over = true;
      n--;
    };
  }

  /** Runs `work` as a save being sent: counted from now until it has answered or failed. */
  async function during(work) {
    const done = start();
    try {
      return await work();
    } finally {
      done();
    }
  }

  return {
    start,
    during,
    /** Something is being sent right now. */
    get any() { return n > 0; },
    /** How many saves are being sent right now. */
    get count() { return n; },
  };
}

/**
 * Whether leaving the page asks the browser's own "Leave site?" question.
 *   toSignIn     the person chose to leave to sign in again, in a dialog that said what is kept
 *   unpublished  the page holds edits that are not published (asked since before this file)
 *   sending      a save or a publish is on its way to the service
 * It asks in those two cases and in no other.
 */
export function asksBeforeLeaving({ toSignIn = false, unpublished = false, sending = false } = {}) {
  if (toSignIn) return false;
  return !!(unpublished || sending);
}
