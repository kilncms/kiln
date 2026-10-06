/**
 * Names for the person editing (src/editor/names.js). The toolbar said
 * "hero_headline", the hover hint "Edit: hero_headline", Search & jump listed
 * "hero img" and "rotation sub" (and "hero" for the headline), and Theme
 * listed "--color-peri" to someone signed in as an editor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { plainName, readableName, tokenName } from '../src/editor/names.js';
import { rowScore } from '../src/editor/palette.js';
import { CARD_STAYS, guideCardCopy } from '../src/editor/firstrun.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(ROOT, 'src', 'editor', f), 'utf8');
const main = read('main.js');

test('names: a field\'s name is made readable from the stored one', () => {
  assert.equal(readableName('hero_headline'), 'Hero headline');
  assert.equal(readableName('hero_img'), 'Hero picture');
  assert.equal(readableName('rotation_sub'), 'Rotation subheading');
  assert.equal(readableName('shirts_sub'), 'Shirts subheading');
  assert.equal(readableName('card_desc'), 'Card description');
  assert.equal(readableName('footer_email'), 'Footer email');
  assert.equal(readableName('facts'), 'Facts');
  assert.equal(readableName('faq_title'), 'FAQ title');
  assert.equal(readableName('heroHeadline'), 'Hero headline');
  assert.equal(readableName('about-us-body'), 'About us body');
  assert.equal(readableName('demo_banner_text'), 'Demo banner text');
});

test('names: a whole word is never cut off as if it were a stamp', () => {
  // "hero_headline" used to be shown as "hero": the last word was taken for a generated suffix
  assert.equal(plainName('hero_headline'), 'hero headline');
  assert.equal(plainName('rotation_headline'), 'rotation headline');
  assert.equal(plainName('closing_headline'), 'closing headline');
  assert.equal(plainName('footer_copyright'), 'footer copyright');
  // a stamp the editor itself adds is letters and digits mixed: that is what goes, wherever it sits
  assert.equal(plainName('gallery_mf3k2a9x'), 'gallery');
  assert.equal(plainName('gallery_mf3k2a9x_title'), 'gallery title');
  assert.equal(plainName('events_lz81q0k2'), 'events');
  // short things with a digit in them are part of the name
  assert.equal(plainName('hiw2_body'), 'hiw2 body');
  assert.equal(plainName('step_3'), 'step 3');
});

test('names: in the middle of a sentence the name is in small letters, and "a section" stands in for none', () => {
  assert.equal(plainName('hero_img'), 'hero picture');
  assert.equal(plainName('+hero_img'), 'hero picture');
  assert.equal(plainName('-old_block'), 'old block');
  for (const none of [undefined, null, '', 'undefined']) assert.equal(plainName(none), 'a section');
  assert.equal(readableName(undefined), 'A section');
  // a name made only of a stamp is shown as it is rather than as nothing
  assert.equal(plainName('mf3k2a9x'), 'mf3k2a9x');
});

test('names: a theme setting is named without the stylesheet\'s dashes, or the word its group already says', () => {
  assert.equal(tokenName('--color-peri', 'color'), 'Peri');
  assert.equal(tokenName('--color-ink-soft', 'color'), 'Ink soft');
  assert.equal(tokenName('--colour-accent', 'color'), 'Accent');
  assert.equal(tokenName('--font-sans', 'font'), 'Sans');
  assert.equal(tokenName('--font-display', 'font'), 'Display');
  assert.equal(tokenName('--text-xs--line-height', 'size'), 'Text xs line height');
  assert.equal(tokenName('--brand-primary', 'color'), 'Brand primary');
  // the one word a name has is kept, even when it is the group's own
  assert.equal(tokenName('--color', 'color'), 'Color');
  assert.equal(tokenName('--radius', 'other'), 'Radius');
});

test('names: nothing stored is changed, only what is shown', () => {
  // the commit message, the saved copy and what is sent to the worker are built from the key itself
  assert.match(read('firstrun.js'), /return `Edit \$\{path\}: \$\{keys\.join\(', '\)\} \(via Kiln\)`;/);
  assert.match(main, /editCommitMessage\(file, \[\.\.\.flattenPending\(\)\.map\(e => e\.key\)/);
  assert.equal(/readableName\([^)]*\)[^;\n]*(stagePending|state\.pending\.set|localStorage\.setItem)/.test(main), false);
  // and what a readable name is made from is still on screen for the owner
  const toolbar = main.slice(main.indexOf('function renderToolbar('), main.indexOf('function removeToolbar('));
  assert.match(toolbar, /<span class="kiln-tb-label" title="\$\{escapeHtml\(key\)\}">\$\{escapeHtml\(readableName\(key\)\)\}<\/span>/);
});

test('names: every place the editor showed a raw field name shows the readable one', () => {
  // the hover hint
  const decorate = main.slice(main.indexOf('function decorateField('), main.indexOf('// ─── Repeatable blocks'));
  assert.match(decorate, /el\.title = fieldHint\(key\);/);
  assert.match(main, /function fieldHint\(key\) \{\s*\n\s*return mode === 'admin' \? `Edit: \$\{readableName\(key\)\} \(\$\{key\}\)` : `Edit: \$\{readableName\(key\)\}`;/);
  // the picture toolbar
  const image = main.slice(main.indexOf('function imageToolbar('), main.indexOf('function enableImageDragResize('));
  assert.match(image, /<span class="kiln-tb-label" title="\$\{escapeHtml\(key\)\}">\$\{escapeHtml\(readableName\(key\)\)\}<\/span>/);
  // Search & jump
  assert.match(read('palette.js'), /const name = readableName\(key\);/);
  // "Pick up where you left off?"
  const offer = main.slice(main.indexOf('function offerPendingRestore('), main.indexOf('async function restoreSaved('));
  assert.match(offer, /Object\.keys\(saved\.edits\)\.map\(readableName\)/);
  // the publish sheet's rows, History's lines ("Edited hero headline")
  assert.match(main, /label: readableName\(key\), parts, warnings/);
  assert.match(main, /function humanizeKey\(k\) \{\s*\n\s*return plainName\(k\);/);
  // no label is the bare key any more
  assert.equal(/<span class="kiln-tb-label">\$\{escapeHtml\(key\)\}<\/span>/.test(main), false);
  assert.equal(/el\.title = `Edit: \$\{key\}`/.test(main), false);
});

test('names: Theme speaks to an editor, and shows the stylesheet\'s names to the owner only', () => {
  const theme = read('theme.js');
  assert.equal(/CSS custom properties\./.test(theme.slice(theme.indexOf('export async function openThemePanel('))), false, 'the editor is told about CSS custom properties');
  assert.match(theme, /The site’s colours and type sizes\./);
  assert.match(theme, /tokenName\(token\.name, token\.kind\)/);
  // the raw name is the row's title for anyone, and small print for the owner
  assert.match(theme, /title="\$\{escapeHtml\(token\.name\)\}"/);
  assert.match(theme, /mode === 'admin' \? `<small class="kiln-th-raw">\$\{escapeHtml\(token\.name\)\}<\/small>` : ''/);
});

test('names: Search & jump finds what was typed, not a scatter of its letters', () => {
  const hero = { name: 'Hero picture', text: 'Hero picture hero_img Six Muskrat & Rorke tees in garment-dyed colors laid out on a sunlit studio worktable' };
  const shirts = { name: 'Shirts subheading', text: 'Shirts subheading shirts_sub Twenty-eight originals, each one drawn by hand' };
  const history = { name: 'History & restore', text: 'History & restore' };
  // typing "history" used to bring up "hero img" and "shirts sub": h-i-s-t-o-r-y can be picked out of nearly any sentence
  assert.equal(rowScore('history', hero), -1);
  assert.equal(rowScore('history', shirts), -1);
  assert.ok(rowScore('history', history) > 0);
  // a word of the text on the page finds its part, and so does the readable name, and the stored one
  assert.ok(rowScore('garment', hero) > 0);
  assert.ok(rowScore('picture', hero) > 0);
  assert.ok(rowScore('hero_img', hero) > 0);
  assert.ok(rowScore('HERO PIC', hero) > 0);
  // a few letters of the short name still do
  assert.ok(rowScore('hpic', hero) >= 0);
  assert.equal(rowScore('zebra', hero), -1);
  // found as typed ranks above found letter by letter
  assert.ok(rowScore('shirts', shirts) > rowScore('shsub', shirts));
});

test('names: the last card of the guide puts itself away, and an invited editor is never told about Git', () => {
  assert.ok(CARD_STAYS >= 15000 && CARD_STAYS <= 30000, String(CARD_STAYS));
  const guide = read('firstrun.js');
  const show = guide.slice(guide.indexOf('function showCard()'), guide.indexOf('function guideCss('));
  assert.match(show, /closeCardLater\(card\);/);
  const later = guide.slice(guide.indexOf('function closeCardLater('), guide.indexOf('function removeTip()'));
  assert.match(later, /else finish\(\);/);
  assert.equal(/:hover/.test(later.replace(/\/\*[\s\S]*?\*\//g, '')), false, 'a pointer resting where it last clicked must not keep the card up');
  assert.match(guide, /function finish\(\) \{\s*\n\s*done = true;\s*\n\s*clearTimeout\(cardTimer\);/);
  // "That was a Git commit" is for the buyer in the demo; an invited editor on a real site gets other words
  const invited = guideCardCopy({ invited: true, message: 'Edit index.html: hero_headline (via Kiln)' });
  assert.equal(invited.title, 'That is published');
  assert.equal(invited.message, null);
  assert.equal(/Git|commit|repo/i.test(`${invited.title} ${invited.sub}`), false);
  assert.equal(guideCardCopy({ invited: false, message: 'm' }).title, 'That was a Git commit');
});
