/**
 * "Pick up where you left off?": unpublished edits are saved in the browser as
 * they are made and offered back the next time the page is opened. That was
 * true on a real site and not in the demo, where the saved copy was never
 * written, so an edit that was not published was gone after a reload with
 * nothing said. The shape of the saved copy is tested in saved-edits.test.js;
 * here the editor's source is read for where it is written and offered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = readFileSync(path.join(ROOT, 'src', 'editor', 'main.js'), 'utf8');
const part = (from, to) => main.slice(main.indexOf(from), main.indexOf(to, main.indexOf(from) + from.length));

test('restore offer: the demo offers unpublished edits back, as a real site does', () => {
  const boot = part('async function initSandbox()', '\n}\n');
  // the offer is what switches the saved copy on (nothing is written before it has read what an earlier visit left)
  assert.match(boot, /offerPendingRestore\(\);/);
  assert.ok(boot.indexOf('decorateFields()') < boot.indexOf('offerPendingRestore()'), 'after the fields are known');
  const save = part('function savePendingToStorage()', '\n}\n');
  assert.match(save, /if \(!keptReady\) return;/);
  assert.equal(/cfg\.sandbox/.test(save.replace(/syncKeptFiles\(\);/, '')), false, 'the saved copy is written in the demo too');
});

test('restore offer: in the demo a saved copy lasts as long as the demo does, a day', () => {
  const offer = part('function offerPendingRestore()', '\n}\n');
  assert.match(offer, /if \(cfg\.sandbox && Date\.now\(\) - ts > SANDBOX_TTL\) \{ clearSavedPending\(\); return; \}/);
});

test('restore offer: "Start over" and the demo\'s day running out forget the saved copies too', () => {
  const reset = part('function sandboxReset()', '\n}\n');
  assert.match(reset, /localStorage\.removeItem\(SANDBOX_KEY\)/);
  assert.match(reset, /const mine = `kiln_pending:\$\{cfg\.repo\}:`;/);
  assert.match(reset, /if \(key\.startsWith\(mine\)\) localStorage\.removeItem\(key\)/);
  // (it asks first now: own-dialogs.test.js)
  assert.match(part('async function startOver()', '\n}\n'), /sandboxReset\(\);\s*\n\s*location\.reload\(\);/);
  assert.match(part('function sandboxTTLCheck()', '\n}\n'), /sandboxReset\(\)/);
});

test('restore offer: a saved draft is asked about after the unpublished edits, never over them', () => {
  // on a real site the draft's dialog used to take the place of "Pick up where you left off?", and the edits were lost with the next change
  const draft = part('async function checkForDraft()', '\n}\n');
  assert.ok(draft.indexOf('await restoreAsked;') !== -1 && draft.indexOf('await restoreAsked;') < draft.indexOf('draftDialog('), 'the draft waits');
  const offer = part('function offerPendingRestore()', '\n}\n');
  assert.match(offer, /restoreAsked = new Promise\(\(resolve\) => \{ answered = resolve; \}\);/);
  // every way out of the question settles it: both buttons, and putting it away
  assert.match(offer, /\{ onClose: \(\) => answered\(\) \}/);
  assert.match(offer, /#kiln-rest-no'\)\.onclick = \(\) => \{ clearSavedPending\(\); m\.remove\(\); answered\(\); \};/);
  assert.match(offer, /#kiln-rest-yes'\)\.onclick = async \(\) => \{ await restoreSaved\(saved, kept, false\); m\.remove\(\); answered\(\); \};/);
  // and the demo asks in the same order
  assert.match(part('async function initSandbox()', '\n}\n'), /offerPendingRestore\(\);\s*\n\s*restoreAsked\.then\(offerDraftSandbox\);/);
  // declared before the editor starts, so that starting cannot be overtaken by the declaration
  assert.ok(main.indexOf('let restoreAsked = Promise.resolve();') < main.indexOf('init().catch('), 'declared above the start');
});

test('restore offer: edits thrown away with "Discard & exit" are not offered back', () => {
  const done = part('function doneEditing()', '\n}\n');
  assert.match(done, /state\.pendingSource\.clear\(\);\s*\n\s*clearSavedPending\(\);/);
});
