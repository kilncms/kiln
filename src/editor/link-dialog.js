/**
 * The link button's dialog: what it says.
 *
 * The toolbar's link button used to ask with the browser's own box ("Link to
 * (URL or /page):"), the one grey thing in an editor that is otherwise its
 * own design, and the first thing many people try. It now opens the editor's
 * dialog (main.js `linkDialog`): one box for the address, filled in with the
 * present address when the selection is inside a link, and a way to take the
 * link off again.
 *
 * What an address may be has not changed. It is taken as it is typed, as the
 * browser's box took it, except that a plain web domain or email address is
 * made whole (`fullAddress`, below). When the edit is kept, the field's HTML goes through
 * the sanitizer as it always has (sanitize.js, KILN_URI_REGEXP): http, https,
 * mailto and tel addresses, addresses on this site ("/page", "#part",
 * "page.html") stay; an address with any other scheme ("javascript:") is
 * dropped, and the words stay without a link. The publish sheet still warns
 * about a link that goes nowhere.
 *
 * Pure, so it is tested in node.
 */

/**
 * `current`: the address of the link the selection is inside, or null when
 * it is inside none (an empty string is a link with no address yet).
 */
export function linkDialogCopy(current) {
  const has = typeof current === 'string';
  return {
    title: has ? 'Change this link' : 'Add a link',
    go: has ? 'Change link' : 'Add link',
    remove: has,
    value: has ? current : '',
  };
}

/**
 * The address as it is meant. Typed without "https://" ("muskratandrorke.com"),
 * a web address used to become a link to a missing page of the person's own
 * site ("/muskratandrorke.com"). Now an address that is plainly a web domain
 * gets "https://" put in front, and a bare email address becomes a "mailto:"
 * link. Everything else is left exactly as typed: an address with a scheme
 * ("https://", "mailto:", "javascript:", which the sanitizer still drops),
 * one on this site ("/page", "#part", "?q", "../up.html") and a file beside
 * this page ("about.html", "docs/guide.pdf", "menu.pdf": the ending names a
 * kind of file, not a web domain). The sanitizer decides what stays, as it
 * always has, when the edit is kept.
 */
const FILE_ENDINGS = new Set(('html htm xhtml shtml php asp aspx jsp cgi pdf doc docx xls xlsx ppt pptx odt ods odp rtf txt csv tsv ' +
  'md markdown json xml rss atom ics vcf epub jpg jpeg png gif svg webp avif bmp tif tiff heic ico mp3 mp4 m4a m4v mov webm ' +
  'ogg wav flac zip gz tar rar 7z dmg exe css js mjs map woff woff2 ttf otf eps psd ai key pages numbers').split(' '));

export function fullAddress(typed) {
  const value = String(typed ?? '');
  const t = value.trim();
  if (!t || /\s/.test(t)) return value;
  if (/^[\/#?.]/.test(t)) return value;                                    // on this site
  if (/^[^\s@\/:?#]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(t)) return `mailto:${t}`;   // pat@example.com
  // "example.com:8080/x" reads like a scheme; any other scheme ("https:", "mailto:", "tel:", "javascript:") stays as typed
  const host = t.split(/[\/?#]/)[0];
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^:]+\.[^:]+:\d+$/.test(host)) return value;
  const m = host.match(/^((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+)([a-z]{2,24})(:\d{1,5})?$/i);
  if (!m) return value;
  const www = /^www\./i.test(host);
  if (!www && FILE_ENDINGS.has(m[2].toLowerCase())) return value;         // about.html, menu.pdf
  return `https://${t}`;
}

/** What the status line says when the button is pressed with nothing selected and no link under the cursor. */
export const LINK_NEEDS_WORDS = 'Select the words to turn into a link first.';
