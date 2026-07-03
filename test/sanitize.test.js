/**
 * Regression tests for the editor sanitize configuration.
 *
 * The container allowlist gap that flattened a customer's <tbody data-cms-repeat>
 * schedule table (tr/td stripped to bare text and published) must never reopen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SANITIZE, CONTAINER_SANITIZE, KILN_URI_REGEXP } from '../src/editor/sanitize.js';

test('container allowlist keeps every table-structure tag', () => {
  for (const tag of ['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col']) {
    assert.ok(CONTAINER_SANITIZE.ALLOWED_TAGS.includes(tag), `missing table tag: ${tag}`);
  }
});

test('container allowlist keeps list/semantic structure tags', () => {
  for (const tag of ['dl', 'dt', 'dd', 'time', 'figure', 'figcaption', 'article', 'section', 'div', 'blockquote', 'picture', 'source']) {
    assert.ok(CONTAINER_SANITIZE.ALLOWED_TAGS.includes(tag), `missing structural tag: ${tag}`);
  }
});

test('container allowlist keeps table/semantic attributes', () => {
  for (const attr of ['colspan', 'rowspan', 'scope', 'datetime', 'id', 'data-cms', 'data-cms-attr', 'data-kiln-tags']) {
    assert.ok(CONTAINER_SANITIZE.ALLOWED_ATTR.includes(attr), `missing attribute: ${attr}`);
  }
});

test('field allowlist keeps inline-image essentials', () => {
  for (const tag of ['img', 'figure', 'figcaption', 'time']) {
    assert.ok(SANITIZE.ALLOWED_TAGS.includes(tag), `missing tag: ${tag}`);
  }
  for (const attr of ['src', 'alt', 'width', 'height', 'data-kiln-src']) {
    assert.ok(SANITIZE.ALLOWED_ATTR.includes(attr), `missing attribute: ${attr}`);
  }
});

test('script-bearing tags stay banned in both configs', () => {
  for (const cfg of [SANITIZE, CONTAINER_SANITIZE]) {
    for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input']) {
      assert.ok(!cfg.ALLOWED_TAGS.includes(tag), `dangerous tag allowed: ${tag}`);
    }
    for (const attr of ['onclick', 'onerror', 'onload', 'srcdoc']) {
      assert.ok(!cfg.ALLOWED_ATTR.includes(attr), `dangerous attribute allowed: ${attr}`);
    }
  }
});

test('URI regexp: blob previews and inline raster images pass', () => {
  assert.ok(KILN_URI_REGEXP.test('blob:https://example.com/1234-5678'));
  assert.ok(KILN_URI_REGEXP.test('data:image/webp;base64,UklGRg=='));
  assert.ok(KILN_URI_REGEXP.test('data:image/png;base64,iVBORw0KGgo='));
  assert.ok(KILN_URI_REGEXP.test('data:image/jpeg;base64,/9j/4AAQ'));
});

test('URI regexp: normal site URLs pass', () => {
  for (const url of ['/assets/uploads/photo.webp', 'https://example.com/x', 'http://example.com',
    'mailto:hi@example.com', 'tel:+14045551212', '#anchor', '?q=1', 'page.html', './rel', '../up']) {
    assert.ok(KILN_URI_REGEXP.test(url), `should allow: ${url}`);
  }
});

test('URI regexp: script-bearing schemes stay banned', () => {
  for (const url of ['javascript:alert(1)', 'vbscript:x', 'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/svg+xml;base64,PHN2Zz4=', 'data:application/pdf;base64,JVBERg==']) {
    assert.ok(!KILN_URI_REGEXP.test(url), `should ban: ${url}`);
  }
});
