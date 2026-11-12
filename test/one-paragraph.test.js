/**
 * Lists and block styles in parts that cannot hold them (src/editor/one-paragraph.js,
 * main.js `renderToolbar`). A `<p data-cms>` or a heading used to take a
 * `<ul>` or an `<h3>` from the toolbar, staged and published as written. In a
 * rich area the browser nested the list in its paragraph and put the cursor
 * at the start of the line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { holdsBlocks, BLOCK_CMDS, NO_LIST_HERE, NO_FORMAT_HERE, NO_LIST_TITLE, wordsBefore, pointAfter, liftLists } from '../src/editor/one-paragraph.js';
import { page } from './tiny-dom.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = readFileSync(path.join(ROOT, 'src', 'editor', 'main.js'), 'utf8');
const toolbar = main.slice(main.indexOf('function renderToolbar('), main.indexOf('function linkDialog('));

test('one paragraph: a paragraph, a heading, a line or a link cannot hold a list or a block style; a rich area can', () => {
  for (const t of ['P', 'h1', 'H2', 'h3', 'h6', 'span', 'A', 'strong', 'em', 'label', 'button', 'small', 'dt', 'pre', 'time', '', null]) {
    assert.equal(holdsBlocks(t), false, `${t} holds no blocks`);
  }
  for (const t of ['DIV', 'div', 'section', 'article', 'aside', 'main', 'li', 'td', 'th', 'blockquote', 'figure', 'figcaption', 'dd']) {
    assert.equal(holdsBlocks(t), true, `${t} holds blocks`);
  }
  assert.deepEqual(BLOCK_CMDS, ['insertUnorderedList', 'insertOrderedList']);
});

test('one paragraph: what it says is everyday words, in whole sentences', () => {
  for (const s of [NO_LIST_HERE, NO_FORMAT_HERE]) {
    assert.match(s, /^[A-Z].*\.$/, s);
    assert.equal(/!|[—–]|\s-\s|\b(HTML|markup|element|block-level|DOM|tag|node|execCommand)\b/i.test(s), false, s);
  }
  assert.equal(/[—–!]|\b(HTML|markup|element|tag)\b/i.test(NO_LIST_TITLE), false);
});

test('one paragraph: in a part that cannot hold one, the list buttons and the Style menu\'s formats say why and change nothing', () => {
  assert.match(toolbar, /const oneBlock = !md && !holdsBlocks\(el\.tagName\);/);
  // the buttons stay, dimmed, with a hint that says why (not a dead button)
  assert.match(toolbar, /data-cmd="insertUnorderedList" title="\$\{oneBlock \? NO_LIST_TITLE : 'Bullet list'\}"\$\{noList\}/);
  assert.match(toolbar, /data-cmd="insertOrderedList" title="\$\{oneBlock \? NO_LIST_TITLE : 'Numbered list'\}"\$\{noList\}/);
  // pressed, they say why and run nothing
  assert.match(toolbar, /if \(oneBlock\) \{ setStatus\(NO_LIST_HERE, 'idle'\); el\.focus\(\); return; \}\s*\n[\s\S]*?document\.execCommand\(cmd, false, null\);/);
  const fmt = toolbar.slice(toolbar.indexOf("if (value.startsWith('fmt:')) {"), toolbar.indexOf("document.execCommand('formatBlock'"));
  assert.match(fmt, /if \(oneBlock\) \{ setStatus\(NO_FORMAT_HERE, 'idle'\); el\.focus\(\); return; \}/);
});

test('one paragraph: in a rich area the list is lifted out of its paragraph and the cursor goes back where it was', () => {
  const list = toolbar.slice(toolbar.indexOf('} else if (BLOCK_CMDS.includes(cmd)) {'), toolbar.indexOf("} else {\n        document.execCommand(cmd, false, null);"));
  assert.match(list, /wordsBefore\(el, sel\.anchorNode, sel\.anchorOffset\), wordsBefore\(el, sel\.focusNode, sel\.focusOffset\)/);
  assert.match(list, /document\.execCommand\(cmd, false, null\);\s*\n\s*liftLists\(el\);\s*\n\s*el\.focus\(\);/);
  assert.match(list, /setBaseAndExtent\(a\.node, a\.offset, f\.node, f\.offset\)/);
});

test('wordsBefore / pointAfter: a point is found again after the markup around it is rebuilt', () => {
  const before = page('<div><p>Rich <b>area</b> words</p></div>');
  const words = before.children[0].childNodes[2];   // " words"
  const at = wordsBefore(before, words, words.data.length);
  assert.equal(at, 'Rich area words'.length);
  // the end of the field, given as the field and a child count, is the end of its words
  assert.equal(wordsBefore(before, before, before.childNodes.length), at);
  assert.equal(wordsBefore(before, before, 0), 0);
  // the same words, now in a list: the point is at the end of the item, not at the start of the line
  const after = page('<div><ul><li>Rich <b>area</b> words</li></ul></div>');
  const p = pointAfter(after, at);
  assert.equal(p.node.data, ' words');
  assert.equal(p.offset, ' words'.length);
  // in the middle of a word, and between two runs (the end of the first, not the start of the next)
  assert.deepEqual([pointAfter(after, 2).node.data, pointAfter(after, 2).offset], ['Rich ', 2]);
  assert.deepEqual([pointAfter(after, 5).node.data, pointAfter(after, 5).offset], ['Rich ', 5]);
  // past the end, or with no words at all, it is the end
  assert.equal(pointAfter(after, 99).offset, ' words'.length);
  const blank = page('<div></div>');
  assert.deepEqual(pointAfter(blank, 3), { node: blank, offset: 0 });
});

test('liftLists: a list the browser put inside a paragraph is moved out, with the words around it kept', () => {
  // parse5, like a browser, never builds <p><ul>, so it is put together by hand as the browser's command leaves it
  const one = page('<div><p></p><ul><li>Rich area words</li></ul></div>');
  one.children[0].appendChild(one.children[1]);
  assert.equal(one.innerHTML, '<p><ul><li>Rich area words</li></ul></p>');
  assert.equal(liftLists(one), 1);
  assert.equal(one.innerHTML, '<ul><li>Rich area words</li></ul>');

  const around = page('<div><p class="x">Before<br></p><ol><li>b</li></ol><span>After</span><p>Next</p></div>');
  const [p0, ol, span] = around.childNodes;
  p0.appendChild(ol); p0.appendChild(span);
  assert.equal(liftLists(around), 1);
  assert.equal(around.innerHTML, '<p class="x">Before<br></p><ol><li>b</li></ol><p class="x"><span>After</span></p><p>Next</p>');

  // nothing to mend: left exactly alone
  const fine = page('<div><p>a</p><ul><li>b</li></ul></div>');
  assert.equal(liftLists(fine), 0);
  assert.equal(fine.innerHTML, '<p>a</p><ul><li>b</li></ul>');
});

// ─── What one paragraph or heading may hold: a paste, and Enter ──────────────

const { holdsBlockMarkup, inlineHtml } = await import('../src/editor/one-paragraph.js');

test('text pasted from a web page comes in as words with bold, italic and links, and nothing else', () => {
  const clip = page(`<div><!--StartFragment--><h2 class="mw-headline" style="font-family:Georgia;color:#c00;font-size:28px">Pasted heading</h2>
    <p class="MsoNormal" style="margin:0;background:yellow">A <span style="color:red;font-weight:bold">red bold</span> line with
      <a href="https://example.org/x?a=1&amp;b=2" onclick="evil()" class="ext" target="_blank">a link</a> and <a href="javascript:alert(1)">a script link</a></p>
    <img src="x" onerror="alert(1)"><table><tbody><tr><td>cell one</td><td>cell two</td></tr></tbody></table>
    <div>Second <i class="x">pasted</i> block</div><script>alert(1)</script><!--EndFragment--></div>`);
  const got = inlineHtml(clip, { strict: true });
  assert.equal(got, 'Pasted heading<br>A <strong>red bold</strong> line with <a href="https://example.org/x?a=1&amp;b=2">a link</a> and a script link<br>cell one cell two<br>Second <i>pasted</i> block');
  assert.equal(holdsBlockMarkup(page(`<p>${got}</p>`)), false, 'a paragraph can hold all of it');
  assert.ok(!/class=|style=|<img|<h2|<p|<table|onclick|javascript:|alert/.test(got));
});

test('a paste from a word processor: its styles are read as the bold and italic they stand for', () => {
  const clip = page('<div><b style="font-weight:normal" id="docs-internal-guid-1"><span style="font-weight:700">Bold</span><span style="font-weight:400"> and </span><span style="font-style:italic">slanted</span></b></div>');
  assert.equal(inlineHtml(clip, { strict: true }), '<strong>Bold</strong> and <em>slanted</em>');
});

test('each Enter in a paragraph or heading is kept as a line break, not as a block inside it', () => {
  const typed = page('<h2>Line one<div>Line two</div><div><br></div><div>Line <b>four</b><br></div></h2>');
  assert.equal(holdsBlockMarkup(typed), true);
  assert.equal(inlineHtml(typed), 'Line one<br>Line two<br><br>Line <b>four</b>');
  assert.equal(holdsBlockMarkup(page('<p>a <b>b</b><br>c <span class="accent">d</span></p>')), false);
});

test('the page\'s own inline elements are kept exactly when blocks are taken out', () => {
  const part = page('<p>Hello <span class="accent" data-x="a&quot;b">world</span> <img src="/i.png" alt="An icon"><h3>Sub</h3><ul><li>one</li><li>two</li></ul></p>'.replace('<p>', '<div>').replace('</p>', '</div>'));
  assert.equal(inlineHtml(part), 'Hello <span class="accent" data-x="a&quot;b">world</span> <img src="/i.png" alt="An icon"><br>Sub<br>one<br>two');
});

test('the editor brings a paste into a single paragraph through these rules, and keeps an edit through them', () => {
  const main = readFileSync(path.join(ROOT, 'src/editor/main.js'), 'utf8');
  assert.match(main, /addEventListener\('paste'[\s\S]{0,700}holdsBlocks\(el\.tagName\)\) return;[\s\S]{0,400}inlineHtml\([\s\S]{0,120}\{ strict: true \}\)/);
  assert.match(main, /holdsBlockMarkup\(clone\)\) return DOMPurify\.sanitize\(inlineHtml\(clone\), SANITIZE\)/);
});
