/**
 * The link button's dialog (src/editor/link-dialog.js, main.js `linkDialog`).
 * The button used to ask with the browser's own box. What an address may be
 * is what it was: taken as typed, and decided by the sanitizer when the edit
 * is kept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { linkDialogCopy, LINK_NEEDS_WORDS } from '../src/editor/link-dialog.js';
import { KILN_URI_REGEXP } from '../src/editor/sanitize.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = readFileSync(path.join(ROOT, 'src', 'editor', 'main.js'), 'utf8');
const toolbar = main.slice(main.indexOf('function renderToolbar('), main.indexOf('function linkDialog('));
const dialog = main.slice(main.indexOf('function linkDialog('), main.indexOf('function removeToolbar('));

test('link dialog: it says "Add" for words with no link, and "Change" with a way to remove for a link', () => {
  assert.deepEqual(linkDialogCopy(null), { title: 'Add a link', go: 'Add link', remove: false, value: '' });
  assert.deepEqual(linkDialogCopy('/about'), { title: 'Change this link', go: 'Change link', remove: true, value: '/about' });
  // a link with no address yet is still a link: it can be given one, or taken off
  assert.deepEqual(linkDialogCopy(''), { title: 'Change this link', go: 'Change link', remove: true, value: '' });
  assert.deepEqual(linkDialogCopy(undefined), linkDialogCopy(null));
  for (const text of [LINK_NEEDS_WORDS, ...Object.values(linkDialogCopy(null)), ...Object.values(linkDialogCopy('x'))].filter(t => typeof t === 'string')) {
    assert.equal(/!|[—–]|\s-\s/.test(text), false, text);
  }
});

test('link dialog: the toolbar\'s link button no longer asks in the browser\'s own box', () => {
  assert.equal(/\bprompt\(/.test(toolbar), false, 'the browser\'s box is still asked');
  assert.equal(/Link to \(URL or \/page\)/.test(main), false);
  assert.match(toolbar, /if \(cmd === 'link'\) \{\s*\n\s*linkDialog\(el\);\s*\n\s*return;/);
  // the editor's own dialog, with one box, the buttons asked for, and Cancel
  assert.match(dialog, /const m = modal\(`/);
  assert.match(dialog, /<input type="text" id="kiln-link-url" value="\$\{escapeHtml\(copy\.value\)\}"/);
  assert.match(dialog, /\$\{copy\.remove \? '<button class="kiln-btn-ghost" id="kiln-link-remove">Remove link<\/button>' : ''\}/);
  assert.match(dialog, /<button class="kiln-btn-ghost" data-close>Cancel<\/button>/);
  assert.match(dialog, /<button class="kiln-btn-publish" id="kiln-link-go">\$\{copy\.go\}<\/button>/);
  // Enter submits (Escape is the dialog's own, like every other dialog of the editor)
  assert.match(dialog, /if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); go\(\); \}/);
});

test('link dialog: the edit stays open, and the cursor and the selection come back by every way out', () => {
  // a click inside the dialog is not a click away from the field, which would end the edit
  assert.match(dialog, /m\.classList\.add\('kiln-keeps-edit'\);/);
  assert.match(main, /closest\('#kiln-toolbar, #kiln-imgpop, #kiln-ai-menu, \.kiln-img-handle, \.kiln-keeps-edit'\)/);
  // the selection is copied before the dialog takes the cursor, and put back when the dialog goes: Cancel, ✕, Escape, a click outside, or a button
  assert.match(dialog, /sel\.getRangeAt\(0\)\.cloneRange\(\)/);
  assert.match(dialog, /\{ onClose: back \}/);
  const back = dialog.slice(dialog.indexOf('const back = () => {'), dialog.indexOf('const m = modal('));
  assert.match(back, /el\.focus\(\);[\s\S]*s\.removeAllRanges\(\);[\s\S]*s\.addRange\(range\);[\s\S]*then\?\.\(\);/);
  // the change itself is made after that, with the selection in place
  assert.match(dialog, /const finish = \(fn\) => \{ then = fn; m\._kilnClose\(\); \};/);
  // with nothing selected and no link under the cursor it says so, and opens nothing
  assert.match(dialog, /if \(!link && \(!range \|\| range\.collapsed\)\) \{\s*\n\s*setStatus\(LINK_NEEDS_WORDS, 'idle'\);/);
});

test('link dialog: what an address may be is unchanged', () => {
  // taken as typed, as the browser's box took it: no check of its own, no trimming, no rewriting
  assert.match(dialog, /const url = input\.value;/);
  assert.match(dialog, /if \(link\) link\.setAttribute\('href', url\); else document\.execCommand\('createLink', false, url\);/);
  assert.equal(/safeUrl\(|KILN_URI|\.trim\(\)|new URL\(/.test(dialog), false, 'the dialog judges the address itself');
  // and decided where it always was: the field's sanitizer, when the edit is kept
  for (const ok of ['https://example.com/x', 'http://example.com', 'mailto:pat@example.com', 'tel:+15551234', '/about', '#part', '?q=1', 'page.html', '../up.html']) {
    assert.equal(KILN_URI_REGEXP.test(ok), true, `${ok} stays`);
  }
  for (const no of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'vbscript:x', 'data:text/html,<script>1</script>', 'file:///etc/passwd']) {
    assert.equal(KILN_URI_REGEXP.test(no), false, `${no} is dropped`);
  }
  // the edit is still committed through the sanitizer
  const commit = main.slice(main.indexOf('function fieldValue('), main.indexOf('function commitEdit('));
  assert.match(commit, /return DOMPurify\.sanitize\(d\.innerHTML, SANITIZE\);/);
});

test('link dialog: a link the selection is wholly inside is changed in place, or taken off with its words kept', () => {
  assert.match(dialog, /const node = range \? range\.commonAncestorContainer : null;/);
  // never the field itself, when the field is a link: that one has its own address box on the toolbar
  assert.match(dialog, /const link = found && found !== el && el\.contains\(found\) \? found : null;/);
  assert.match(dialog, /remove\.onclick = \(\) => finish\(\(\) => link\.replaceWith\(\.\.\.link\.childNodes\)\);/);
});
