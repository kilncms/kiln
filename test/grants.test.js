import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { hasGrant, offersMakeEditable, helpUrl, EDITOR_DEFAULT_FEATURES } from '../src/editor/grants.js';

const editor = (over = {}) => ({ mode: 'editor', sandbox: false, features: null, scopeMode: null, pageInScope: true, ...over });

test('grants: the owner and the demo have every tool; an editor has what was granted', () => {
  assert.equal(hasGrant({ mode: 'admin' }, 'makeeditable'), true);
  assert.equal(hasGrant({ mode: 'editor', sandbox: true }, 'theme'), true);
  assert.equal(hasGrant(editor(), 'history'), true, 'a default tool');
  assert.equal(hasGrant(editor(), 'makeeditable'), false, 'not a default tool');
  assert.equal(hasGrant(editor({ features: ['makeeditable'] }), 'makeeditable'), true);
  assert.equal(hasGrant(editor({ features: ['makeeditable'] }), 'history'), false, 'a chosen list replaces the defaults');
  assert.equal(hasGrant(editor({ features: [] }), 'draft'), false, 'an empty list is a choice: nothing');
  assert.deepEqual(EDITOR_DEFAULT_FEATURES, ['pagesettings', 'history', 'draft']);
});

test('grants: "Make things editable" is offered to an invited editor who was granted it', () => {
  assert.equal(offersMakeEditable(editor({ features: ['makeeditable', 'history'] })), true);
  assert.equal(offersMakeEditable(editor()), false, 'not granted: not offered');
  assert.equal(offersMakeEditable(editor({ features: ['history', 'blocks'] })), false);
  assert.equal(offersMakeEditable({ mode: 'admin', sandbox: false }), true);
  assert.equal(offersMakeEditable({ mode: 'editor', sandbox: true }), true);
});

test('grants: granted, but not on a page outside their folders, and not for a seat that cannot publish', () => {
  const granted = { features: ['makeeditable'] };
  assert.equal(offersMakeEditable(editor({ ...granted, pageInScope: false })), false, 'a read-only page');
  assert.equal(offersMakeEditable(editor({ ...granted, scopeMode: 'suggest' })), false, 'a suggestion carries text edits only');
  assert.equal(offersMakeEditable(editor({ ...granted, scopeMode: 'review' })), false, 'a review seat only comments');
});

test('grants: both menus draw the two tools from the grant, not from being the owner', () => {
  const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
  for (const id of ['kiln-addsection', 'kiln-makeblock']) {
    const lines = main.split('\n').filter(l => l.includes(`<button id="${id}"`));
    assert.equal(lines.length, 2, `${id} is drawn in the pencil menu and in the top bar`);
    for (const l of lines) {
      assert.ok(l.includes('canMakeEditable() ?'), `${id} follows the grant`);
      assert.ok(!new RegExp(`mode === 'admin' \\|\\| cfg\\.sandbox \\? '<button id="${id}"`).test(l), `${id} is not owner-only`);
    }
  }
  // the grant the People form offers, the one the menu checks and the one the worker stores are the same word
  assert.ok(main.includes("{ v: 'makeeditable', label: 'Make things editable'"));
  assert.ok(main.includes("'kiln-makeblock': 'makeeditable', 'kiln-addsection': 'makeeditable'"));
  const worker = readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
  assert.match(worker, /GRANTABLE_FEATURES = \[[^\]]*'makeeditable'/);
});

test('help: the menu opens the guide for whoever is signed in, in a new tab', () => {
  assert.equal(helpUrl({ mode: 'admin', sandbox: false }), 'https://kilncms.com/owners');
  assert.equal(helpUrl({ mode: 'editor', sandbox: false, role: 'editor' }), 'https://kilncms.com/editors');
  assert.equal(helpUrl({ mode: 'editor', sandbox: false, role: null }), 'https://kilncms.com/editors');
  assert.equal(helpUrl({ mode: 'editor', sandbox: false, role: 'member' }), 'https://kilncms.com/members');
  assert.equal(helpUrl({ mode: 'editor', sandbox: true }), 'https://kilncms.com/editors', 'a visitor trying the demo is editing');
  const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
  assert.equal(main.split('\n').filter(l => l.includes('<button id="kiln-help"')).length, 2, 'in the pencil menu and in the top bar');
  assert.ok(main.includes("window.open(helpLink(), '_blank', 'noopener')"), 'a new tab that cannot reach back into the editor');
  const palette = readFileSync(new URL('../src/editor/palette.js', import.meta.url), 'utf8');
  for (const id of ['kiln-help', 'kiln-makeblock', 'kiln-addsection']) assert.ok(palette.includes(`{ id: '${id}'`), `${id} can be found from Search`);
});
