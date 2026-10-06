/**
 * Names, the way the person editing reads them.
 *
 * A field's name is the developer's ("hero_headline", "hero_img") and a theme
 * setting's is the stylesheet's ("--color-peri"). The editor showed them as
 * they are, or cut down wrongly ("hero_headline" became "hero"), to people
 * who were invited to change some words. These make a readable name out of
 * the stored one. Nothing stored changes: the page, the saved copy, the
 * commit message and every key the worker sees keep the name as it is, and
 * the raw name stays on screen for the owner (a title on the toolbar's label,
 * small print in Theme).
 *
 * Pure, so they are tested in node.
 */

// What developers shorten, said in full. Only whole words are changed.
const WORDS = {
  img: 'picture', image: 'picture', pic: 'picture', photo: 'picture',
  desc: 'description', sub: 'subheading', btn: 'button', cta: 'button', bg: 'background',
  txt: 'text', nav: 'menu', hdr: 'header', ftr: 'footer', addr: 'address', tel: 'phone',
  num: 'number', url: 'link', faq: 'FAQ',
};

/** A stamp the editor itself put into a name ("gallery_mf3k2a9x"): letters and digits mixed, never a word. */
const isStamp = (word) => word.length >= 5 && /\d/.test(word) && /^[a-z0-9]+$/i.test(word);

function wordsOf(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')   // heroHeadline
    .split(/[_\-\s.]+/)
    .filter(w => w && !isStamp(w))
    .map(w => WORDS[w.toLowerCase()] || w.toLowerCase());
}

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** "hero_headline" → "hero headline", for the middle of a sentence ("Edited hero headline"). */
export function plainName(key) {
  if (key === undefined || key === null || key === '' || key === 'undefined') return 'a section';
  const words = wordsOf(String(key).replace(/^[+-]/, ''));
  return words.join(' ') || String(key);
}

/** "hero_headline" → "Hero headline", "hero_img" → "Hero picture": a label on its own. */
export function readableName(key) {
  return capital(plainName(key));
}

// The word a stylesheet puts in front of each kind of setting, which the group's heading already says.
const LEAD = { color: /^(color|colour|clr)$/, font: /^(font|family|typeface)$/ };

/**
 * A theme setting's name: "--color-ink-soft" under Colors → "Ink soft",
 * "--font-sans" under Fonts → "Sans", "--text-xs--line-height" → "Text xs line height".
 * `kind` is the group it is listed in ('color', 'font', 'size', 'other').
 */
export function tokenName(name, kind = 'other') {
  let words = String(name).replace(/^--/, '').split(/[_\-\s]+/).filter(Boolean).map(w => w.toLowerCase());
  const lead = LEAD[kind];
  while (lead && words.length > 1 && lead.test(words[0])) words = words.slice(1);
  return capital(words.join(' ')) || String(name);
}
