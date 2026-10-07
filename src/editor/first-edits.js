/**
 * Small things a first-time client met, and what the editor says about them.
 *
 * Wording only, and the few numbers that go with it: what an empty form
 * lacks, what a bar says where there is no keyboard, how long a line with a
 * button stays, how big a picture the demo keeps. Pure, and tested in node.
 */

/** "Add event" with something missing: what to say, and which box to put the cursor in. null when nothing is. */
export function missingEvent({ title, date } = {}) {
  if (!title && !date) return { say: 'An event needs a title and a date.', at: 'title' };
  if (!title) return { say: 'Give the event a title.', at: 'title' };
  if (!date) return { say: 'Choose the date of the event.', at: 'date' };
  return null;
}

/** "Add person" with no address, or one that cannot be an address. */
export function missingPerson({ email } = {}) {
  if (!email) return { say: 'Type the Google email address of the person to add.', at: 'email' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { say: 'An email address looks like name@example.com. This one is missing a part.', at: 'email' };
  return null;
}

/** The title of the schedule dialog. */
export function scheduleTitle(n) {
  return n === 1 ? 'Schedule this edit' : `Schedule these ${n} edits`;
}

/**
 * What the bar says while a place for a new section is being chosen. Esc is
 * mentioned only where there is a keyboard; the bar has a Cancel button
 * either way.
 */
export function pickBarWords({ touch }) {
  return `<strong>Where should it go?</strong> ${touch ? 'Tap' : 'Click'} a section to add the new one right below it.`
    + (touch ? '' : ' <kbd>Esc</kbd> cancels.');
}

/**
 * How long "Removed. Undo" stays: ten seconds, the same as "Published. Undo".
 * It is the only way back that names what just happened, and reading it,
 * finding the button and reaching it with a thumb takes a few seconds; the
 * Undo button beside the pencil stays after it has gone.
 */
export function removedHold() {
  return 10000;
}

/** People & access, said to the site's owner. */
export const PEOPLE_WORDS = {
  pagesLabel: 'Pages this editor can change',
  pagesPlaceholder: 'The whole site, or choose pages below',
  pagesHint: 'Leave this empty for the whole site, or choose pages and folders below. The files that run the site itself are never theirs to change.',
  keysLabel: 'Parts of those pages they can change (optional)',
  keysPlaceholder: 'Every part, or choose parts below',
  keysHint: 'Leave this empty for every part of the pages above.',
  never: 'Never expires',
  toolsHint: 'Changing words and pictures is always allowed. People & access and the site’s Settings stay yours alone.',
  suggest: 'Their Publish sends you a suggestion to approve, under Suggestions. Nothing on the live site changes until you do.',
  signIn: 'People here sign in with their Google account. Removing someone ends their access at once, even while they are signed in.',
};

/** The largest picture the demo keeps, as it is stored: one megabyte. A browser gives a site about five for everything. */
export const DEMO_PICTURE_MAX = 1024 * 1024;

/** What the demo says to a picture it cannot keep, or null when it can. `bytes`: the picture as it would be stored. */
export function tooBigForDemo(bytes, max = DEMO_PICTURE_MAX) {
  if (bytes <= max) return null;
  const mb = (n) => (Math.ceil(n / 1024 / 1024 * 10) / 10).toFixed(1).replace(/\.0$/, '');
  return `This picture is ${mb(bytes)} MB once it is made web-sized, and the demo keeps pictures up to ${mb(max)} MB in this browser. Try a smaller one here. A real site has no such limit.`;
}

/**
 * The type of the site's own headings, as custom properties for a section the
 * editor adds (a gallery, an events list): `cs` is the computed style of the
 * nearest heading on the page. They go into the section's style attribute, so
 * nothing in them may end it.
 */
export function headingVars(cs) {
  const safe = (v) => String(v || '').replace(/"/g, "'").replace(/[;<>{}]/g, '').trim();
  const out = [];
  if (safe(cs.fontFamily)) out.push(`--kiln-h-font:${safe(cs.fontFamily)}`);
  if (safe(cs.fontWeight)) out.push(`--kiln-h-weight:${safe(cs.fontWeight)}`);
  if (safe(cs.letterSpacing) && safe(cs.letterSpacing) !== 'normal') out.push(`--kiln-h-spacing:${safe(cs.letterSpacing)}`);
  if (safe(cs.textTransform) && safe(cs.textTransform) !== 'none') out.push(`--kiln-h-case:${safe(cs.textTransform)}`);
  return out.join(';');
}

/**
 * How a section the editor adds looks on a site that has no styles of its own
 * for it: its heading in the site's heading type, each event set apart, its
 * title above its date. Sizes follow the text around them. Only for a section
 * marked `kiln-plain`, which the editor does when it finds the site styles
 * none of this itself; a site that does is left to it. The visitor's script
 * (src/features.js) carries the same rules, word for word.
 */
export const ADDED_CSS = `.kiln-plain .kiln-added-title{font-family:var(--kiln-h-font,inherit);font-weight:var(--kiln-h-weight,700);letter-spacing:var(--kiln-h-spacing,normal);text-transform:var(--kiln-h-case,none);font-size:clamp(1.6rem,4.5vw,2.4rem);line-height:1.15;margin:0 0 .5em}
.kiln-plain .kiln-event{padding:.9em 0;border-top:1px solid rgba(127,127,127,.3)}
.kiln-plain .kiln-ev-title{font-family:var(--kiln-h-font,inherit);font-weight:var(--kiln-h-weight,700);letter-spacing:var(--kiln-h-spacing,normal);font-size:1.25em;line-height:1.25;margin:0 0 .15em}
.kiln-plain .kiln-ev-when{margin:0;opacity:.75;font-variant-numeric:tabular-nums}
.kiln-plain .kiln-ev-loc,.kiln-plain .kiln-ev-desc{margin:.3em 0 0}
.kiln-plain .kiln-ev-link{text-decoration:underline}`;
