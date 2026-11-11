/**
 * The editor from the keyboard (src/editor/keyboard.js, and where main.js uses
 * it): every editable part can be reached with Tab and is named, and nothing
 * the editor added for that ever reaches what Publish writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOCUS_MARK, FOCUS_ATTRS, reachable, typing, isReachable, unreach, stripFocus, partLabel, shortWords, TOOL_NAMES, TOGGLES, arrowStep } from '../src/editor/keyboard.js';
import { SANITIZE, CONTAINER_SANITIZE, BLOCK_SANITIZE } from '../src/editor/sanitize.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = readFileSync(path.join(ROOT, 'src', 'editor', 'main.js'), 'utf8');

/** Just enough of an element: attributes, children, and querySelectorAll('[attr]'). */
function el(attrs = {}, children = []) {
  const a = new Map(Object.entries(attrs));
  const node = {
    children,
    getAttribute: (n) => (a.has(n) ? a.get(n) : null),
    setAttribute: (n, v) => { a.set(n, String(v)); },
    removeAttribute: (n) => { a.delete(n); },
    hasAttribute: (n) => a.has(n),
    attrs: () => Object.fromEntries(a),
    querySelectorAll(sel) {
      const want = sel.match(/^\[([^\]]+)\]$/)[1];
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (c.hasAttribute(want)) out.push(c); walk(c); } };
      walk(node);
      return out;
    },
  };
  return node;
}

/** The attributes a field's copy would be published with, as the attribute string Publish writes. */
const written = (node) => Object.entries(node.attrs()).map(([k, v]) => `${k}="${v}"`).join(' ');

test('a part at rest is a button in the tab order, named for what it is and holds', () => {
  const h = el({ 'data-cms': 'hero_headline', class: 'kiln-field' });
  reachable(h, partLabel('Hero headline', false, 'Kind of a big dill.'));
  assert.equal(h.getAttribute('tabindex'), '0');
  assert.equal(h.getAttribute('role'), 'button');
  assert.equal(h.getAttribute('aria-label'), 'Edit Hero headline: Kind of a big dill.');
  assert.equal(isReachable(h), true);
});

test('a picture is named as one, with its description', () => {
  assert.equal(partLabel('Prod picture', true, 'A pickle jar'), 'Change picture: Prod picture. A pickle jar');
  assert.equal(partLabel('Prod picture', true, ''), 'Change picture: Prod picture');
  assert.equal(partLabel('Footer note', false, '   '), 'Edit Footer note');
});

test('long words are cut at a word, with an ellipsis', () => {
  const s = shortWords('one two three four five six seven eight nine ten eleven twelve thirteen', 30);
  assert.ok(s.length <= 31 && s.endsWith('…') && !/\s…$/.test(s), s);
});

test('a part being typed in is a text box named for the part; at rest again it is a button', () => {
  const p = el({ 'data-cms': 'about_body' });
  reachable(p, 'Edit About body: Hello');
  typing(p, 'About body', true);
  assert.equal(p.getAttribute('role'), 'textbox');
  assert.equal(p.getAttribute('aria-label'), 'About body');
  assert.equal(p.getAttribute('aria-multiline'), 'true');
  reachable(p, 'Edit About body: Hello there');
  assert.equal(p.getAttribute('role'), 'button');
  assert.equal(p.getAttribute('aria-multiline'), null);
});

test('the site\'s own tabindex, role and label are left as they are, and kept when the editor\'s go', () => {
  const link = el({ 'data-cms': 'cta', tabindex: '-1', 'aria-label': 'Order now' });
  reachable(link, 'Edit Cta: Order');
  assert.equal(link.getAttribute('tabindex'), '-1');
  assert.equal(link.getAttribute('aria-label'), 'Order now');
  assert.equal(link.getAttribute('role'), 'button');
  unreach(link);
  assert.deepEqual(link.attrs(), { 'data-cms': 'cta', tabindex: '-1', 'aria-label': 'Order now' });
});

test('a published field holds no tabindex, role or label the editor put there', () => {
  const inner = el({ 'data-cms': 'prod_name', class: 'kiln-field' });
  const pic = el({ 'data-cms': 'prod_img', 'data-cms-attr': 'src', src: 'a.jpg', alt: 'Jar' });
  const block = el({ class: 'card' }, [inner, pic]);
  const list = el({ 'data-cms-repeat': 'products' }, [block]);
  reachable(inner, 'Edit Prod name: Dill');
  typing(inner, 'Prod name', true);
  reachable(pic, 'Change picture: Prod picture. Jar');
  stripFocus(list);
  for (const n of [inner, pic, block, list]) assert.doesNotMatch(written(n), /tabindex|role=|aria-|data-kiln-focus/, written(n));
  assert.deepEqual(pic.attrs(), { 'data-cms': 'prod_img', 'data-cms-attr': 'src', src: 'a.jpg', alt: 'Jar' });
});

test('the sanitizers that write a field or a list never let the editor\'s attributes through either', () => {
  for (const cfg of [SANITIZE, CONTAINER_SANITIZE, BLOCK_SANITIZE]) {
    for (const a of [...FOCUS_ATTRS, FOCUS_MARK]) assert.ok(!cfg.ALLOWED_ATTR.includes(a), a);
  }
});

test('main.js strips them wherever a list or a field is copied to be staged, kept for Undo, or un-made editable', () => {
  const body = (name) => main.slice(main.indexOf(`function ${name}(`), main.indexOf('\n}\n', main.indexOf(`function ${name}(`)));
  assert.match(body('cleanBlocks'), /stripFocus\(clone\)/);
  assert.match(body('baseHtml'), /stripFocus\(clone\)/);
  assert.match(main, /el\.removeAttribute\('title'\);\n\s+unreach\(el\);/);
  assert.match(body('decorateField'), /reachable\(el, restLabel\(el, key\)\)/);
});

test('every toolbar button has a name in words, and the on/off ones are listed', () => {
  for (const [cmd, said] of Object.entries(TOOL_NAMES)) assert.match(said, /^[A-Z][a-z]+( [a-z]+)*$/, cmd);
  assert.equal(TOOL_NAMES.insertUnorderedList, 'Bullet list');
  assert.equal(TOOL_NAMES.insertOrderedList, 'Numbered list');
  assert.equal(TOOL_NAMES.link, 'Add a link');
  for (const t of TOGGLES) assert.ok(TOOL_NAMES[t], t);
  for (const cmd of ['bold', 'italic', 'underline', 'insertUnorderedList', 'insertOrderedList', 'link', 'img', 'doc', 'removeFormat', 'hist']) {
    assert.ok(main.includes(`data-cmd="${cmd}"`), `the toolbar has ${cmd}`);
  }
  assert.match(main, /tb\.setAttribute\('role', 'toolbar'\);\n\s+tb\.setAttribute\('aria-label', `Text tools: /);
  assert.match(main, /tb\.setAttribute\('aria-label', `Picture tools: /);
});

test('arrow keys walk a row of buttons and wrap at the ends', () => {
  assert.equal(arrowStep('ArrowRight', 0, 3), 1);
  assert.equal(arrowStep('ArrowRight', 2, 3), 0);
  assert.equal(arrowStep('ArrowLeft', 0, 3), 2);
  assert.equal(arrowStep('ArrowLeft', -1, 3), 2);
  assert.equal(arrowStep('Home', 2, 3), 0);
  assert.equal(arrowStep('End', 0, 3), 2);
  assert.equal(arrowStep('a', 0, 3), null);
  assert.equal(arrowStep('ArrowRight', 0, 0), null);
});

test('every editor dialog is named by its heading and gives the keyboard back when it closes', () => {
  const modal = main.slice(main.indexOf('function modal(bodyHtml'), main.indexOf('function refreshPublishButton'));
  assert.match(modal, /role="dialog" aria-modal="true"/);
  assert.match(modal, /nameDialog\(wrap\.querySelector\('\.kiln-modal-card'\)\)/);
  assert.match(modal, /const cameFrom = /);
  assert.match(modal, /back\?\.focus\(/);
  assert.match(modal, /aria-labelledby/);
  // declared above the init() call: a dialog can open while the editor starts (esbuild hoists const/let to var)
  assert.ok(main.indexOf('let dialogNames = 0;') < main.indexOf('\ninit()'));
});
