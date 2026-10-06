import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDocumentWrite, checkFragment, isHtmlPath } from '../worker/sanitize-guard.js';

const PAGE = '<!doctype html><html><head><title>t</title></head><body>' +
  '<h1 data-cms="h">Hi</h1><script src="/assets/kiln.js" defer></script></body></html>';

test('editing text on an existing page keeps the owner boot script → allowed', () => {
  assert.equal(checkDocumentWrite(PAGE, PAGE.replace('Hi', 'Hello world')), null);
});

test('an editor injecting an inline script into an existing page → blocked', () => {
  const bad = checkDocumentWrite(PAGE, PAGE.replace('Hi', 'Hi<script>steal()</script>'));
  assert.ok(bad && bad.startsWith('script-inline:'));
});

test('an editor injecting an on* handler → blocked', () => {
  const bad = checkDocumentWrite(PAGE, PAGE.replace('Hi', '<img src=x onerror=alert(1)>'));
  assert.ok(bad && bad.startsWith('on:'));
});

test('a javascript: URL (even tab-obfuscated) → blocked', () => {
  assert.ok(checkDocumentWrite(PAGE, PAGE.replace('Hi', '<a href="javascript:e()">x</a>')));
  assert.ok(checkDocumentWrite(PAGE, PAGE.replace('Hi', '<a href="java\tscript:e()">x</a>')));
});

test('an editor injecting an iframe/object/form → blocked', () => {
  assert.ok(checkDocumentWrite(PAGE, PAGE.replace('Hi', '<iframe src="//evil"></iframe>')));
  assert.ok(checkDocumentWrite(PAGE, PAGE.replace('Hi', '<form action="//evil"></form>')));
});

test('a brand-new page may reference a relative script but not an absolute one', () => {
  const newRel = '<!doctype html><body><h1>New</h1><script src="/assets/kiln.js"></script></body>';
  assert.equal(checkDocumentWrite(null, newRel), null);
  const newAbs = newRel.replace('/assets/kiln.js', 'https://evil.com/x.js');
  assert.ok(checkDocumentWrite(null, newAbs));
  const newProto = newRel.replace('/assets/kiln.js', '//evil.com/x.js');
  assert.ok(checkDocumentWrite(null, newProto));
});

test('a brand-new page with an inline script → blocked', () => {
  assert.ok(checkDocumentWrite(null, '<body><script>evil()</script></body>'));
});

test('fragment guard rejects any executable markup, allows clean rich text', () => {
  assert.ok(checkFragment('hi <script>x</script>'));
  assert.ok(checkFragment('<a href="javascript:x()">y</a>'));
  assert.equal(checkFragment('<b>bold</b> <a href="/x">link</a>'), null);
  assert.equal(checkFragment('<img src="/a.jpg" style="width:200px">'), null);
});

test('isHtmlPath', () => {
  assert.equal(isHtmlPath('blog/index.html'), true);
  assert.equal(isHtmlPath('about.htm'), true);
  assert.equal(isHtmlPath('assets/app.js'), false);
  assert.equal(isHtmlPath('assets/photo.png'), false);
});

// The control-character class is written with escapes (\x00-\x20) so the file
// is text to git and its diffs can be read. Same class as before: every
// character from NUL to space, placed anywhere inside the scheme, is ignored
// the way a browser ignores it, so the URL is still seen as javascript:.
test('a javascript: URL hidden behind any control character or space (0x01 to 0x20) → blocked', () => {
  for (let c = 1; c <= 0x20; c++) {
    const ch = String.fromCharCode(c);
    for (const url of [`java${ch}script:alert(1)`, `${ch}javascript:alert(1)`, `j${ch}a${ch}vascript:alert(1)`]) {
      const html = `<p><a href="${url.replace(/"/g, '&quot;')}">x</a></p>`;
      assert.ok(checkFragment(html), `0x${c.toString(16)} in ${JSON.stringify(url)}`);
    }
  }
  // 0x21 and up are real characters: "java!script:" is not a javascript: URL.
  assert.equal(checkFragment('<p><a href="java!script:alert(1)">x</a></p>'), null);
  // A NUL never reaches the class: the HTML parser turns it into U+FFFD, as a
  // browser does, and the result is not a javascript: URL in either.
  assert.equal(checkFragment('<p><a href="java\u0000script:alert(1)">x</a></p>'), checkFragment('<p><a href="java\uFFFDscript:alert(1)">x</a></p>'));
});

test('worker/sanitize-guard.js holds no raw control characters, so git treats it as text', async () => {
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(new URL('../worker/sanitize-guard.js', import.meta.url));
  const raw = [...bytes].filter(b => (b < 0x20 && b !== 0x0a && b !== 0x09) || b === 0x7f);
  assert.deepEqual(raw, []);
});
