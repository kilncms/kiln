import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverTokens, applyTokenEdits } from '../src/editor/theme.js';

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
