/**
 * Try-out mode, the public demo (src/editor/tryout.js): what the demo says
 * where something cannot act without a real site, and that Save as draft
 * works there without asking anything of a repository.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { demoSays, demoShort, DEMO_ITEMS, DEMO_DRAFT_SAVED } from '../src/editor/tryout.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(ROOT, 'src', 'editor', f), 'utf8');
const main = read('main.js');

function assertPlain(text) {
  assert.equal(/!/.test(text), false, `an exclamation mark in: ${text}`);
  assert.equal(/[—–]|\s-\s/.test(text), false, `a dash as punctuation in: ${text}`);
}

test('try-out: every demo-only sentence has one shape, and says what a real site does', () => {
  assert.ok(DEMO_ITEMS.length >= 10);
  for (const item of DEMO_ITEMS) {
    const text = demoSays(item);
    assert.match(text, /^(Nothing|Nobody) [a-z ]+ in the demo\. On a real site, .+\.$/, text);
    assertPlain(text);
    assert.equal(/error|forbidden|failed|cannot|can't|repo\b|branch|commit|backend|API/i.test(text), false, `a developer's word, or a no, in: ${text}`);
    assert.ok(text.length < 200, text);
  }
  assert.equal(demoSays('schedule'), 'Nothing is scheduled in the demo. On a real site, you pick a time and Kiln publishes these edits for you then.');
});

test('try-out: Save as draft is kept in this browser, and says so', () => {
  assert.equal(DEMO_DRAFT_SAVED, 'Draft saved in this browser. Nothing is published, and this page will offer it back when you open it again.');
  assertPlain(DEMO_DRAFT_SAVED);
  // it never reaches the code that asks the repository, which is what failed with "Cannot read properties of null"
  const save = main.slice(main.indexOf('async function saveDraft()'), main.indexOf('async function checkForDraft()'));
  const demo = save.indexOf("if (cfg.sandbox) { saveDraftSandbox(); return; }");
  assert.ok(demo !== -1 && demo < save.indexOf('ensureDraftBranch()'), 'the demo branches off before the draft branch is asked for');
  const kept = main.slice(main.indexOf('function saveDraftSandbox()'), main.indexOf('function offerDraftSandbox()'));
  assert.equal(/state\.gh|\bask\(|fetch\(/.test(kept), false, 'the demo\'s draft asks nothing of a site');
  assert.match(kept, /s\.drafts\[sandboxPath\(\)\] = \{ ts: Date\.now\(\), edits: Object\.fromEntries\(state\.pending\) \}/);
  assert.match(kept, /setStatus\(DEMO_DRAFT_SAVED, 'saved'\)/);
});

test('try-out: a draft saved in the demo is offered back as the page opens, with the real site\'s question', () => {
  const offer = main.slice(main.indexOf('function offerDraftSandbox()'), main.indexOf('async function checkForDraft()'));
  assert.match(offer, /draftDialog\(true\)/);
  for (const id of ['kiln-dr-resume', 'kiln-dr-pub', 'kiln-dr-del']) assert.ok(offer.includes(`#${id}`), id);
  const boot = main.slice(main.indexOf('async function initSandbox()'));
  assert.ok(boot.slice(0, boot.indexOf('\n}\n')).includes('offerDraftSandbox'), 'offered as the demo starts');
  // one dialog for both: the demo shows what a real site shows
  assert.match(main, /const m = draftDialog\(mode === 'admin'\);/);
  assert.equal((main.match(/<h3>There's a saved draft of this page<\/h3>/g) || []).length, 1);
});

test('try-out: "Schedule for later" asks nothing of the worker, and says what a real site does', () => {
  // the demo used to ask the real worker for its schedules and print the answer: "forbidden"
  const panel = main.slice(main.indexOf('function schedulePanel('), main.indexOf('// ─── Settings (admin)'));
  const demoList = panel.indexOf("if (cfg.sandbox) { list.innerHTML = `<p class=\"kiln-dim\">${escapeHtml(demoSays('schedule'))}</p>`; return; }");
  assert.ok(demoList !== -1 && demoList < panel.indexOf('await ask(`/schedules'), 'the list is not asked for in the demo');
  const go = panel.slice(panel.indexOf("#kiln-sc-go').onclick"));
  assert.ok(go.indexOf('if (cfg.sandbox)') !== -1 && go.indexOf('if (cfg.sandbox)') < go.indexOf("await ask('/schedule'"), 'nothing is sent in the demo');
  assert.equal(demoShort('schedule'), 'Nothing is scheduled in the demo.');
  for (const item of DEMO_ITEMS) assert.equal(demoSays(item).startsWith(demoShort(item)), true);
});

test('try-out: every other item that cannot act in the demo says it in the same shape', () => {
  const suggest = read('suggest.js'), theme = read('theme.js'), blocks = read('blocks.js');
  // the sentences these had of their own, each in another shape, some with a developer's words
  for (const [name, src] of [['suggest.js', suggest], ['theme.js', theme], ['blocks.js', blocks]]) {
    assert.equal(/The demo (has no|lives only|previews only|publishes only)|Nothing here in the demo —/.test(src), false, `${name} still has a sentence of its own for the demo`);
  }
  assert.match(suggest, /demoSays\('preview'\)/);
  assert.equal((suggest.match(/demoSays\('suggestions'\)/g) || []).length, 2);
  assert.match(theme, /status\.textContent = demoSays\('theme'\);/);
  // "+ Add section" opens the dialog a real site opens, with the sentence in it, where the person is looking
  const picker = blocks.slice(blocks.indexOf('async function openPicker('), blocks.indexOf('let blocks;'));
  assert.match(picker, /if \(cfg\.sandbox\) \{[\s\S]*modal\(`<h3>Add a section<\/h3>[\s\S]*demoSays\('blocks'\)/);
  // a gallery added in the demo says how long it stays
  assert.match(main, /is added for this visit to the demo\. On a real site, Publish keeps it\./);
});

test('try-out: the ✨ button says what it is and where it works, beside the button, when pressed', () => {
  const assist = read('assist.js');
  // it used to put one line in the status corner, far from the button, and read as a button that does nothing
  assert.equal(/The demo has no AI backend/.test(assist), false);
  assert.equal(/function sandboxNote\(/.test(assist), false);
  assert.match(assist, /if \(cfg\.sandbox\) \{ demoNote\(anchor, 'ai'\); return; \}/);
  assert.match(assist, /if \(cfg\.sandbox\) \{ demoNote\(anchor, 'alt'\); return; \}/);
  const note = assist.slice(assist.indexOf('function demoNote('), assist.indexOf('const MENU_ITEMS'));
  // one note at a time, in the place (and on a phone the sheet) of the menu a real site opens
  assert.ok(note.indexOf('closeMenu();') !== -1 && note.indexOf('closeMenu();') < note.indexOf("document.createElement('div')"));
  assert.match(note, /note\.id = 'kiln-ai-menu';/);
  assert.match(note, /text\.textContent = demoSays\(what\);/);
  assert.match(note, /placeBy\(note, anchor\)/);
  assert.match(note, /ok\.textContent = 'Got it';/);
  // a click inside it does not end the edit the person is in the middle of
  assert.match(main, /closest\('#kiln-toolbar, #kiln-imgpop, #kiln-ai-menu, \.kiln-img-handle'\)/);
  // the picture's own ✨ hands over its button, so the note opens beside it
  assert.match(main, /assistAltText\(img, key, altInput, aiAltBtn\)/);
  for (const what of ['ai', 'alt']) {
    assert.match(demoSays(what), /^Nothing here in the demo\. On a real site, this (rewrites|writes)/);
    assert.match(demoSays(what), /using the site owner’s own AI key\.$/);
  }
});
