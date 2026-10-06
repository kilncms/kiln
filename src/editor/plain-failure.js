/**
 * Why something did not go through, in a sentence.
 *
 * An ended sign-in, a refusal and trouble on the way have their own words
 * (sign-in-ended.js). This is for everything else, which used to be shown as
 * whatever the error object happened to say: "Draft failed: Cannot read
 * properties of null (reading 'request')", "Failed: GitHub 422: Reference
 * already exists". The text of an exception is never shown to a person. It
 * goes to the console, where the owner or a developer can read it.
 *
 * Pure, so it is tested in node.
 */
import { readFailure } from './sign-in-ended.js';

const period = (s) => { const t = String(s).trim(); return /[.!?…]$/.test(t) ? t : t + '.'; };

/**
 * An explanation the editor itself gives, thrown so that it reaches the
 * person as written ("/about.html already exists, so please pick another
 * title").
 */
export function said(message) {
  const err = new Error(message);
  err.said = true;
  return err;
}

/** The reason alone, as one or two sentences. */
export function whyNot(err) {
  if (err && (err.said || err.code === 'NOT_UTF8') && err.message) return period(err.message);
  const f = readFailure(err);
  if (f.kind === 'ended') return 'Your sign-in has ended.';
  if (f.kind === 'refused') return `The site did not allow it.${f.reason ? ` The answer was: ${period(f.reason)}` : ''}`;
  if (f.kind === 'trouble') {
    return f.trouble === 'unreachable' ? 'The site could not be reached, so please check your connection and try again.'
      : f.trouble === 'busy' ? 'Too much was asked of the site just now, so please try again in a minute.'
        : 'The site had a problem just now, so please try again in a moment.';
  }
  // No answer from the site at all: something went wrong inside the editor.
  if (!f.status) return 'Kiln had a problem of its own, so please reload the page and try again.';
  if (f.status === 404) return 'The site could not find it.';
  if (f.status === 413) return 'It is too large for the site to take.';
  if (f.status === 409 || f.status === 422) return 'The site did not accept it. It may have changed while you were working, so please reload the page and try again.';
  // The worker's own words are worth passing on; GitHub's are not written for the person editing.
  const words = typeof err?.data?.error === 'string' ? err.data.error.trim().slice(0, 300) : '';
  return `The site did not accept it.${words ? ` The answer was: ${period(words)}` : ''}`;
}

/**
 * What was not done, then why: notDone('The draft was not saved.', err).
 * `lead` is a whole sentence.
 */
export function notDone(lead, err) {
  return `${period(lead)} ${whyNot(err)}`;
}
