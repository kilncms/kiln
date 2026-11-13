/**
 * Three sentences that are worked out before they are said.
 *
 * Testers read "Added a events — click “+ Add event”, then Publish", a
 * schedule dialog that said "(it checks every 5 minutes)", and "Scheduled for
 * 11/12/2026, 8:38:00 PM ✓ — safe to close." Each is a plain sentence now,
 * right for every kind and every number, with no dash and no seconds.
 *
 * Pure, and tested in node (test/said-plainly.test.js).
 */

/** What Kiln menu > Add can add: how it is named, and the button that fills it. */
const SECTIONS = {
  gallery: ['a gallery', '+ Add photos'],
  events: ['an events list', '+ Add event'],
};

/** The line once a gallery or an events list has been added to the page. */
export function addedSectionLine(kind) {
  const [what, button] = SECTIONS[kind] || [];
  return what ? `Added ${what}. Click “${button}”, then Publish.` : 'Added. Publish to keep it.';
}

/** Under the title of a schedule dialog. `n`: how many edits it is for. */
export function scheduleHow(n) {
  return `Kiln publishes ${n === 1 ? 'it' : 'them'} at the time you pick, give or take five minutes.`;
}

/** A scheduled time as a person reads it, to the minute: "11/12/2026, 8:38 PM". */
export function scheduledWhen(at, locale) {
  return new Date(at).toLocaleString(locale, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
