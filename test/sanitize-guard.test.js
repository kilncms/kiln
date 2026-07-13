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
