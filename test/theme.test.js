import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  discoverTokens, applyTokenEdits, fontName, fallbackFor, fontChoices, controlHtml,
  whatChanges, themeCommitMessage, SET_IN_SHEET, THEME_LIVE,
} from '../src/editor/theme.js';
import { tokenName, tokenPhrase } from '../src/editor/names.js';

// Every discovered offset must reproduce its own value — the whole feature
// rests on start/end being exact.
function assertOffsetsExact(css, tokens) {
  for (const t of tokens) assert.equal(css.slice(t.start, t.end), t.value, `${t.name} offsets`);
}

test('discoverTokens: multiple :root blocks, comments, non-:root rules ignored', () => {
  const css = `/* brand palette */
:root {
  --brand-primary: #b8472a;   /* terracotta */
  --font-display: 'Fraunces', serif;
}
.card { color: var(--brand-primary); --not-root: 12px; }
:root {
  --space-hero: 6.5rem;
  --brand-primary: oklch(0.62 0.14 40);
}`;
  const t = discoverTokens(css, 'styles.css');
  assert.deepEqual(t.map(x => x.name),
    ['--brand-primary', '--font-display', '--space-hero', '--brand-primary']);
  assertOffsetsExact(css, t);
  assert.equal(t[0].value, '#b8472a');
  assert.equal(t[0].kind, 'color');
  assert.equal(t[1].value, "'Fraunces', serif");
  assert.equal(t[1].kind, 'font');
  assert.equal(t[2].kind, 'size');
  // Both occurrences surface (in file order) — the panel's cascade dedupe keeps the last.
  assert.equal(t[3].value, 'oklch(0.62 0.14 40)');
  assert.equal(t[3].kind, 'color');
  // The .card rule's custom property is NOT a :root token.
  assert.equal(t.some(x => x.name === '--not-root'), false);
  assert.equal(t.every(x => x.path === 'styles.css'), true);
});

test('discoverTokens: minified single-line CSS, last declaration without semicolon', () => {
  const css = ':root{--a:#fff;--b:12px;--c:var(--a);--d:linear-gradient(90deg,#000,#fff);--e:url(img.png)}';
  const t = discoverTokens(css);
  assert.deepEqual(t.map(x => [x.name, x.kind]), [
    ['--a', 'color'], ['--b', 'size'],
    // var() references, gradients, and urls are read-only ('other') — editing
    // them as flat strings would break the reference/composite.
    ['--c', 'other'], ['--d', 'other'], ['--e', 'other'],
  ]);
  assertOffsetsExact(css, t);
  assert.equal(t[4].value, 'url(img.png)');   // no ';' before '}' — still exact
});

test('discoverTokens: :root inside @media, and url(data:…;base64) semicolons survive', () => {
  const css = '@media (prefers-color-scheme: dark){ :root { --brand-primary:#000; } }\n'
    + ':root{--tex:url(data:image/png;base64,AAAA);--after:#123456}';
  const t = discoverTokens(css);
  assert.deepEqual(t.map(x => x.name), ['--brand-primary', '--tex', '--after']);
  assertOffsetsExact(css, t);
  // The ';' inside url(data:…) must not split the declaration.
  assert.equal(t[1].value, 'url(data:image/png;base64,AAAA)');
  assert.equal(t[2].kind, 'color');
});

test('discoverTokens: kind classification — named colors, font stacks, sizes, oklch', () => {
  const css = `:root {
  --c1: tomato; --c2: rebeccapurple; --c3: rgb(20 20 30 / .5); --c4: hsl(210, 40%, 30%);
  --c5: oklch(62% 0.14 40deg); --c6: #ab34cd80;
  --f1: Georgia, serif; --f2: "Space Grotesk", sans-serif; --f3: ui-monospace, monospace;
  --s1: 100%; --s2: 90vw; --s3: -2px; --s4: .75em;
  --o1: bananas; --o2: 1.5; --o3: 0 2px 8px rgba(0,0,0,.2); --o4: bold;
}`;
  const kinds = Object.fromEntries(discoverTokens(css).map(t => [t.name, t.kind]));
  for (const c of ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6']) assert.equal(kinds[c], 'color', c);
  for (const f of ['--f1', '--f2', '--f3']) assert.equal(kinds[f], 'font', f);
  for (const s of ['--s1', '--s2', '--s3', '--s4']) assert.equal(kinds[s], 'size', s);
  // Unknown words, bare numbers, shadows, keywords: conservative 'other' (read-only).
  for (const o of ['--o1', '--o2', '--o3', '--o4']) assert.equal(kinds[o], 'other', o);
});

test('discoverTokens: selector lists, comment-wrapped selectors, braces in comments', () => {
  const css = '/* } :root{--fake:#000} */\n:root/* why not */, .theme { --real: #222; }\n'
    + 'html:root { --scoped: #333; }';   // not the bare ':root' selector — skipped
  const t = discoverTokens(css);
  assert.deepEqual(t.map(x => x.name), ['--real']);
  assertOffsetsExact(css, t);
});

test('applyTokenEdits: exact splices, right-to-left ordering, bytes around edits untouched', () => {
  const css = ':root {\n  --a:   #111;/*keep me*/\n  --b: 2rem;\n}\n.x{color:var(--a)}';
  const toks = discoverTokens(css);
  // Deliberately pass edits in ascending offset order with LONGER replacements —
  // only right-to-left application keeps the second splice's offsets valid.
  const edits = toks.map(t => ({ ...t, newValue: t.name === '--a' ? '#222222' : '3.25rem' }));
  const r = applyTokenEdits(css, edits);
  assert.deepEqual(r.mismatched, []);
  assert.deepEqual(r.applied, ['--a', '--b']);
  assert.equal(r.css, ':root {\n  --a:   #222222;/*keep me*/\n  --b: 3.25rem;\n}\n.x{color:var(--a)}');
  // Re-discovery of the result finds the new values at fresh offsets.
  const again = discoverTokens(r.css);
  assert.deepEqual(again.map(x => x.value), ['#222222', '3.25rem']);
});

test('applyTokenEdits: upstream change → nothing applied, mismatch signals re-discovery', () => {
  const css = ':root{--a: #111;--b: 2rem}';
  const edits = discoverTokens(css).map(t => ({ ...t, newValue: 'x' }));
  const drifted = css.replace('#111', '#181');   // same length: --b's offsets still line up
  const r = applyTokenEdits(drifted, edits);
  // All-or-nothing: --b alone still matches at its recorded offsets, but a drifted
  // file makes every recorded offset suspect — the caller re-discovers by name.
  assert.deepEqual(r.mismatched, ['--a']);
  assert.deepEqual(r.applied, []);
  assert.equal(r.css, drifted);
  // The signalled path: re-discover on the drifted text and re-apply by name.
  const fresh = new Map(discoverTokens(drifted).map(t => [t.name, t]));
  const redone = edits
    .filter(e => fresh.has(e.name))
    .map(e => ({ ...fresh.get(e.name), newValue: e.newValue }));
  const r2 = applyTokenEdits(drifted, redone);
  assert.deepEqual(r2.mismatched, []);
  assert.equal(r2.css, ':root{--a: x;--b: x}');
  // A vanished token simply isn't in `fresh` — the caller skips it by name.
  assert.equal(fresh.has('--gone'), false);
});

test('applyTokenEdits: unicode content around the edit is preserved exactly', () => {
  const css = '/* thème — café ☕ */\n:root{--name:"Père’s Café";--ink:#111;}\n/* 終 */';
  const toks = discoverTokens(css);
  const ink = toks.find(t => t.name === '--ink');
  const r = applyTokenEdits(css, [{ ...ink, newValue: '#2b2b2b' }]);
  assert.equal(r.css, '/* thème — café ☕ */\n:root{--name:"Père’s Café";--ink:#2b2b2b;}\n/* 終 */');
  // The quoted unicode value itself was discovered intact too.
  assert.equal(toks.find(t => t.name === '--name').value, '"Père’s Café"');
});

// ─── What a shop owner reads in Theme (0.6.5) ────────────────────────────────
// A tester saw "R sm", "Maxw" and "Cream 2" for names, a shadow's raw value, a
// font as a raw list with "Inter, serif" among the choices, no way back to the
// font the site started with, and "Theme: 2 tokens" in the history.

// The settings of the starter site's style sheet (kiln-demo, assets/site.css), as written there.
const STARTER = `:root {
  /* palette */
  --cream:     #f4ecd9;  /* kraft paper background */
  --brine:     #2f5d3a;  /* deep brine green (primary) */
  --dill:      #6b9b4a;  /* brighter dill green (accent) */
  --mustard:   #e0a72e;  /* mustard-gold pop */
  --ink:       #2a2722;  /* warm near-black */
  --edge:      #e4d9bf;  /* soft border edge */
  --cream-2:   #fbf6ea;  /* lifted card surface */
  --brine-ink: #21422a;  /* darker brine for footer */

  /* type */
  --display: "Fraunces", Georgia, "Times New Roman", serif;
  --body: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;

  /* shape */
  --r-sm: 8px;
  --r-md: 14px;
  --r-lg: 22px;
  --shadow-sm: 0 1px 2px rgba(42, 39, 34, .06), 0 4px 14px rgba(42, 39, 34, .05);
  --shadow-md: 0 2px 6px rgba(42, 39, 34, .08), 0 18px 40px rgba(42, 39, 34, .10);

  /* layout */
  --maxw: 1140px;
  --gutter: clamp(20px, 5vw, 56px);
}
`;
const starter = discoverTokens(STARTER, 'assets/site.css');
const setting = (name) => starter.find(t => t.name === name);
const DISPLAY = '"Fraunces", Georgia, "Times New Roman", serif';
const BODY = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const themeSrc = readFileSync(new URL('../src/editor/theme.js', import.meta.url), 'utf8');
const mainSrc = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');

test('Theme names: every setting in the starter\'s style sheet has a name a shop owner understands', () => {
  const labels = Object.fromEntries(starter.map(t => [t.name, tokenName(t.name, t.kind)]));
  assert.deepEqual(labels, {
    '--cream': 'Cream',
    '--brine': 'Brine',
    '--dill': 'Dill',
    '--mustard': 'Mustard',
    '--ink': 'Ink colour',
    '--edge': 'Edge',
    '--cream-2': 'Cream, second shade',
    '--brine-ink': 'Brine ink',
    '--display': 'Heading font',
    '--body': 'Text font',
    '--r-sm': 'Corner roundness, small',
    '--r-md': 'Corner roundness, medium',
    '--r-lg': 'Corner roundness, large',
    '--shadow-sm': 'Shadow, small',
    '--shadow-md': 'Shadow, medium',
    '--maxw': 'Widest the page gets',
    '--gutter': 'Space at the page’s edges',
  });
  for (const [name, label] of Object.entries(labels)) {
    assert.ok(label.replace(/[^a-z]/gi, '').length >= 4, `${name}: “${label}” is shorter than four letters`);
    assert.equal(/R |Maxw/.test(label), false, `${name}: “${label}” is a cut-down name`);
    assert.equal(/\b(r|s|sm|md|lg|xs|xl|maxw|bg|btn|\d)\b/i.test(label.replace(/’s\b/g, '')), false, `${name}: “${label}” has a bare abbreviation`);
    assert.equal(/[—–]|--/.test(label), false, `${name}: “${label}” has a dash`);
  }
});

test('Theme names: what a setting is for is told from its name, and an unknown name keeps its words', () => {
  assert.equal(tokenName('--s-1', 'size'), 'Spacing, step 1');
  assert.equal(tokenName('--space-4', 'size'), 'Spacing, step 4');
  assert.equal(tokenName('--space-hero', 'size'), 'Spacing, hero');
  assert.equal(tokenName('--radius-lg', 'size'), 'Corner roundness, large');
  assert.equal(tokenName('--r-2xl', 'size'), 'Corner roundness, extra extra large');
  assert.equal(tokenName('--max-width', 'size'), 'Widest the page gets');
  for (const name of ['--body', '--sans', '--text-font', '--font-body']) assert.equal(tokenName(name, 'font'), 'Text font', name);
  assert.equal(tokenName('--mono', 'font'), 'Font for code');
  assert.equal(tokenName('--font-accent', 'font'), 'Accent font');
  assert.equal(tokenName('--brand-ink', 'color'), 'Brand ink');
  assert.equal(tokenName('--gray-100', 'color'), 'Gray, shade 100');
  assert.equal(tokenName('--bg', 'color'), 'Background');
  // the same word means something else in another group: a colour called "body" is not a font
  assert.equal(tokenName('--body', 'color'), 'Body');
  // in the middle of a sentence
  assert.equal(tokenPhrase('--mustard', 'color'), 'the mustard colour');
  assert.equal(tokenPhrase('--cream-2', 'color'), 'the second shade of cream');
  assert.equal(tokenPhrase('--display', 'font'), 'the heading font');
  assert.equal(tokenPhrase('--r-sm', 'size'), 'the small corner roundness');
  assert.equal(tokenPhrase('--maxw', 'size'), 'how wide the page gets');
  assert.equal(tokenPhrase('--s-1', 'size'), 'step 1 of the spacing');
});

test('Theme fonts: a font is shown by its first family\'s name, never as a raw list', () => {
  assert.equal(fontName(DISPLAY), 'Fraunces');
  assert.equal(fontName(BODY), 'Inter');
  assert.equal(fontName("'Playfair Display', serif"), 'Playfair Display');
  assert.equal(fontName('system-ui, sans-serif'), 'The device’s own font');
  assert.equal(fontName('ui-monospace, Menlo, monospace'), 'The device’s own font for code');
  const display = setting('--display');
  const choices = fontChoices(DISPLAY, { faces: ['Fraunces', 'Inter'], siteFonts: [DISPLAY, BODY] });
  const html = controlHtml(display, DISPLAY, choices, esc);
  assert.equal(html, '<select class="kiln-th-select"><option selected>Fraunces (as it is now)</option><option>Inter</option></select>');
  assert.equal(/serif|Georgia|&quot;|,/.test(html), false, 'the raw list is on the page');
});

test('Theme fonts: the font the site had is always offered, and choosing it writes the style sheet back byte for byte', () => {
  // as the dialog opens: the style sheet's own value comes first, and Inter comes with the site's own list for it
  const first = fontChoices(DISPLAY, { faces: ['Fraunces', 'Inter'], siteFonts: [DISPLAY, BODY] });
  assert.deepEqual(first, [
    { value: DISPLAY, label: 'Fraunces (as it is now)' },
    { value: BODY, label: 'Inter' },
  ]);
  // the owner picks Inter and applies it
  const display = setting('--display');
  const changed = applyTokenEdits(STARTER, [{ ...display, newValue: first[1].value }]).css;
  assert.match(changed, /--display: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;/);
  // the list still offers what the heading font was when Theme was opened
  const now = discoverTokens(changed).find(t => t.name === '--display');
  const second = fontChoices(now.value, { before: DISPLAY, faces: ['Fraunces', 'Inter'], siteFonts: [now.value, BODY, DISPLAY] });
  assert.deepEqual(second, [
    { value: BODY, label: 'Inter (as it is now)' },
    { value: DISPLAY, label: 'Fraunces (as it was before)' },
  ]);
  // and choosing it puts the style sheet back exactly
  assert.equal(applyTokenEdits(changed, [{ ...now, newValue: second[1].value }]).css, STARTER);
  // a choice made and not applied yet stays in the list when the dialog is opened again
  assert.deepEqual(fontChoices(DISPLAY, { staged: 'Lora, serif' }).map(c => c.label), ['Fraunces (as it is now)', 'Lora']);
  // the dialog takes the choice by its place in the list, so the text never comes back out of the page
  assert.match(themeSrc, /sel\.onchange = \(\) => stage\(token, choices\[sel\.selectedIndex\]\.value\)/);
  assert.match(themeSrc, /before: asOpened\.get\(token\.name\)/);
});

test('Theme fonts: no choice pairs a face with a fallback of the wrong kind', () => {
  assert.equal(fallbackFor('Inter'), 'sans-serif');
  assert.equal(fallbackFor('Fraunces'), 'serif');
  assert.equal(fallbackFor('Noto Sans'), 'sans-serif');
  assert.equal(fallbackFor('Roboto Slab'), 'serif');
  assert.equal(fallbackFor('JetBrains Mono'), 'monospace');
  assert.equal(fallbackFor('Inter Variable'), 'sans-serif');
  assert.equal(fallbackFor('Shop Hand'), '');
  // a serif heading font, with no list of the site's own for the other faces
  const faces = ['Inter', 'Lora', 'Playfair Display', 'JetBrains Mono', 'Open Sans', 'Shop Hand'];
  const choices = fontChoices(DISPLAY, { faces });
  assert.deepEqual(choices.map(c => c.value), [
    DISPLAY, 'Inter, sans-serif', 'Lora, serif', "'Playfair Display', serif", "'JetBrains Mono', monospace",
    "'Open Sans', sans-serif", "'Shop Hand'",
  ]);
  assert.deepEqual(choices.map(c => c.label), ['Fraunces (as it is now)', ...faces]);
  // and the other way round: a sans-serif text font is never given "serif" faces as sans-serif
  for (const now of [DISPLAY, BODY]) {
    for (const c of fontChoices(now, { faces: ['Inter', 'Fraunces', 'Lora', 'Roboto', 'Georgia'] })) {
      const ending = c.value.split(',').pop().trim();
      const kind = fallbackFor(fontName(c.value));
      if (kind) assert.equal(ending, kind, `${c.value} pairs ${fontName(c.value)} with ${ending}`);
    }
  }
  // a face is listed once: the one the setting has is not offered again with a shorter list
  assert.deepEqual(fontChoices(DISPLAY, { faces: ['Fraunces'] }), [{ value: DISPLAY, label: 'Fraunces (as it is now)' }]);
});

test('Theme: a value that is not a colour, a size or a font shows "Set in the style sheet" and nothing to type in', () => {
  const css = ':root{--shadow-sm: 0 1px 2px rgba(42, 39, 34, .06), 0 4px 14px rgba(42, 39, 34, .05);'
    + '--glow: rgba(0, 0, 0, .2) 0 1px 2px;--fade: linear-gradient(90deg, #000, #fff);'
    + '--ease: cubic-bezier(.2, .8, .2, 1);--gutter: clamp(20px, 5vw, 56px);--ink: rgba(42, 39, 34, .9);--r-sm: 8px}';
  const tokens = discoverTokens(css);
  assert.deepEqual(tokens.map(t => [t.name, t.kind]), [
    ['--shadow-sm', 'other'], ['--glow', 'other'], ['--fade', 'other'], ['--ease', 'other'], ['--gutter', 'other'],
    ['--ink', 'color'], ['--r-sm', 'size'],
  ]);
  assert.equal(SET_IN_SHEET, 'Set in the style sheet');
  for (const t of tokens.filter(x => x.kind === 'other')) {
    const html = controlHtml(t, t.value, [], esc);
    assert.equal(html, '<span class="kiln-th-fixed">Set in the style sheet</span>', t.name);
    assert.equal(/<input|<select|<textarea|rgba|\d/.test(html), false, `${t.name} shows its raw value or a box`);
  }
  // the starter's two shadows and its gutter are among them
  for (const name of ['--shadow-sm', '--shadow-md', '--gutter']) assert.equal(setting(name).kind, 'other', name);
  // a colour and a size still get their box
  assert.match(controlHtml(tokens[5], tokens[5].value, [], esc), /<input type="text" value="rgba\(42, 39, 34, \.9\)">/);
  assert.equal(controlHtml(tokens[6], '8px', [], esc), '<input type="text" value="8px">');
  assert.equal(controlHtml(setting('--mustard'), '#e0a72e', [], esc), '<input type="color" value="#e0a72e">');
});

test('Theme: before Apply publishes, one sentence says what will change', () => {
  const phrases = ['--mustard', '--display', '--r-sm', '--maxw'].map(n => tokenPhrase(n, setting(n).kind));
  assert.equal(whatChanges(phrases.slice(0, 1)), 'This changes the mustard colour on every page.');
  assert.equal(whatChanges(phrases.slice(0, 2)), 'This changes the mustard colour and the heading font on every page.');
  assert.equal(whatChanges(phrases.slice(0, 3)), 'This changes the mustard colour, the heading font and 1 more on every page.');
  assert.equal(whatChanges(phrases), 'This changes the mustard colour, the heading font and 2 more on every page.');
  assert.equal(whatChanges([]), '');
  // nothing is saved in the demo, and the sentence does not say it is
  assert.equal(whatChanges(phrases.slice(0, 1), { demo: true }), 'On a real site, this changes the mustard colour on every page.');
  // it sits above the buttons and is written whenever a choice is made or taken back
  assert.match(themeSrc, /<p class="kiln-th-what" id="kiln-th-what"><\/p>\n<div class="kiln-modal-actions">/);
  assert.match(themeSrc, /what\.textContent = whatChanges\(/);
});

test('Theme: the history entry and the status line say what changed in plain words', () => {
  const phrases = ['--mustard', '--display', '--r-sm', '--maxw'].map(n => tokenPhrase(n, setting(n).kind));
  assert.equal(themeCommitMessage(phrases.slice(0, 1)), 'Theme: mustard colour (via Kiln)');
  assert.equal(themeCommitMessage(phrases.slice(0, 2)), 'Theme: mustard colour, heading font (via Kiln)');
  assert.equal(themeCommitMessage(phrases), 'Theme: mustard colour, heading font and 2 more (via Kiln)');
  assert.equal(themeCommitMessage([tokenPhrase('--maxw', 'size')]), 'Theme: how wide the page gets (via Kiln)');
  assert.match(themeSrc, /themeCommitMessage\(edits\.map\(e => e\.phrase\)\)/);
  // nobody is told about tokens, and a file is not "committed" to them
  const dialog = themeSrc.slice(themeSrc.indexOf('export async function openThemePanel('));
  assert.equal(/\btokens?\b[^\n]*\(via Kiln\)|Saved \$\{committed\} token|Committing/.test(dialog), false);
  // the status line: a theme change brings its own sentence, a page edit keeps its own
  assert.equal(THEME_LIVE, 'The new theme is live ✓');
  assert.equal(/Your page edit|—/.test(THEME_LIVE), false);
  assert.match(themeSrc, /journalAdd\(\{ type: 'compare', target: '\/' \+ path, [^\n]*desc: 'The new theme', live: THEME_LIVE/);
  // "View site" is not offered for a theme change: what it would open is the style sheet
  assert.match(mainSrc, /if \(e\.live\) setStatus\(e\.live, 'saved', \{ hold, rest: true \}\);\n\s+else if \(e\.deployed\) setStatus\('Live ✓ View site'/);
  // every other publish says what it always said
  assert.match(mainSrc, /else setStatus\(`\$\{e\.desc\}: live ✓`, 'saved', \{ hold, rest: true \}\);/);
  assert.match(mainSrc, /function watchDeploy\(sha, committedText, desc = 'Your page edit'\)/);
});
