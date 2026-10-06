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
import { demoSays, DEMO_ITEMS, DEMO_DRAFT_SAVED } from '../src/editor/tryout.js';

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
