/**
 * A heading or paragraph that is one link stays that link when its words are
 * typed over.
 *
 * A card in a list of posts has a title like `<h3><a href="/post">Title</a></h3>`,
 * and the part that is marked for editing is the heading. Selecting the title
 * and typing a new one makes the browser throw the link away with the old
 * words, so the new title was plain words: for the person editing, and after
 * Publish for every visitor, on the one card whose title was changed.
 *
 * Nobody who retypes a title means to take its link off. So when a part was
 * exactly one link around all of its words, and after editing it has words
 * and no link at all, the new words are put inside the link it had. The link
 * is left off in three cases, each of them the person's own doing: the words
 * are the same as before (the link was taken off with "Remove link"), another
 * link was made, or the part now holds paragraphs or a list.
 *
 * The first pass (src/autotag.js) goes on marking the heading, not the link.
 * Pages that are marked already are never marked again, so only the editor
 * can keep their links, and with the editor doing it the heading stays one
 * part with one name.
 *
 * Pure: it reads and writes HTML as text, and is tested in node.
 */

const words = (html) => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim();
const OPEN = /<a\b[^>]*>/gi;
// What a browser can leave behind when a link's words are typed over: the link, with nothing in it.
const EMPTY_LINK = /<a\b[^>]*>(?:\s|&nbsp;|<br\s*\/?>)*<\/a>/gi;
const BLOCKS = /<(?:p|div|ul|ol|li|h[1-6]|blockquote|table|figure|pre|hr|section|article)\b/i;

/**
 * The one link around all the words of a part, as `{ open, inside }` (its
 * opening tag as the file has it, and what it holds), or null when the part
 * is anything else: no link, two links, a link with no address, words or a
 * picture outside the link.
 */
export function wholeLink(html) {
  const s = String(html ?? '');
  const opens = s.match(OPEN) || [];
  if (opens.length !== 1) return null;
  const open = opens[0];
  if (!/\shref\s*=\s*["']?[^"'\s>]/i.test(open)) return null;
  const start = s.indexOf(open);
  const end = s.toLowerCase().lastIndexOf('</a>');
  if (end < start) return null;
  const before = s.slice(0, start), after = s.slice(end + 4);
  if (words(before) || words(after) || /<img\b/i.test(before + after)) return null;
  const inside = s.slice(start + open.length, end);
  if (!words(inside)) return null;
  return { open, inside };
}

/**
 * What a part holds after editing, with its one link kept when the words were
 * typed over. `before` is the part's inside when the person began, `after`
 * what it holds now. Comes back as `after`, untouched, whenever the link is
 * not to be put back.
 */
export function keepLink(before, after) {
  const now = String(after ?? '');
  const link = wholeLink(before);
  if (!link) return now;
  const rest = now.replace(EMPTY_LINK, '').replace(/(?:\s*<br\s*\/?>\s*)+$/i, '');
  if (/<a\b/i.test(rest)) return now;                    // it holds a link still, or a new one
  if (!words(rest)) return now;                          // no words left to be a link
  if (BLOCKS.test(rest)) return now;                     // paragraphs or a list now: not one line of words any more
  if (words(rest) === words(link.inside)) return now;    // the same words without the link: it was taken off on purpose
  return `${link.open}${rest}</a>`;
}

/** What the status line says when the link was kept. */
export const LINK_KEPT = 'The new words are still a link, to the same place as before. To change where it goes or take the link off, select the words and press the link button.';
