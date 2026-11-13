/**
 * Every save the editor sends is counted (src/editor/sending.js), so the
 * browser asks "Leave site?" while any of them is on its way to the service.
 *
 * 0.6.5 counted Publish and "Site menu > Save to all pages" only. A tester
 * left the page during one of the other saves and the change was lost without
 * a word. Each action below writes to the site's repository, and each is
 * pinned here to the line that counts it: take the counting away from one and
 * the assertion that names it fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(ROOT, 'src', 'editor', f), 'utf8');
const main = read('main.js');
const theme = read('theme.js');
const suggest = read('suggest.js');

const part = (src, from, to) => {
  const a = src.indexOf(from);
  assert.ok(a !== -1, `not found: ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b !== -1, `not found after it: ${to}`);
  return src.slice(a, b);
};
const counted = (src, line, action) => assert.ok(src.includes(line), `${action} is not counted as a save being sent`);

test('every save: find and replace, Theme, Page settings and Settings', () => {
  counted(main, 'await whileSending(() => replaceEverywhere({ gh: state.gh,', 'Find and replace, "Replace everywhere"');
  counted(theme, "const result = await whileSending(() => editFile(state.gh, cfg.repo, path, cfg.branch || 'main', (text) => {", "Theme's Apply");
  counted(theme, '}, themeCommitMessage(edits.map(e => e.phrase))));', "Theme's Apply, to the end of the save");
  counted(main, 'journalAdd, djb2, stopped, whileSending,', 'Theme (it is handed the counting by the editor)');
  counted(main, "const result = await whileSending(() => editFile(state.gh, cfg.repo, state.page.path, cfg.branch || 'main',\n        (text) => editHead(", "Page settings' Publish");
  counted(main, "const result = await whileSending(() => editFile(state.gh, cfg.repo, cfgPath, cfg.branch || 'main', (text) => {", "Settings' Save");
  counted(main, "}, 'Kiln settings (via Kiln)'));", "Settings' Save, to the end of the save");
});

test('every save: making, duplicating and removing a post or a page', () => {
  // A new post or page on a site of plain pages: from the press, through the reading of the templates, until the files are written.
  const make = part(main, "m.querySelector('#kiln-np-go').onclick", 'function menuEditor()');
  const start = make.indexOf('const sent = cfg.sandbox ? () => {} : state.sending.start();');
  const write = make.indexOf('await commitFiles(state.gh, cfg.repo, branch, files,');
  assert.ok(start > 0 && start < make.indexOf("await getFile(state.gh, cfg.repo, filePath, branch)") && start < write, 'Making a new post or page is not counted from the press of the button');
  assert.ok(make.indexOf('} finally { sent(); }') > write, 'Making a new post or page does not stop being counted when it has answered or failed');
  counted(main, "await whileSending(() => entryCall('/source/create', { file, fields, ...(copyOf && { copyOf }) }));", 'Making or duplicating a post on a site built from content files');
  counted(main, "const r = await whileSending(() => entryCall('/source/remove', { file }));", 'Removing a post on a site built from content files');
  assert.match(main, /await whileSending\(\(\) => state\.gh\.request\('DELETE', [^\n]+\n\s+\{ message: `Delete \$\{state\.page\.path\} \(via Kiln\)`, sha: file\.sha, branch: cfg\.branch \|\| 'main' \}\)\);/,
    'Deleting a page (Page settings) is not counted as a save being sent');
});

test('every save: drafts', () => {
  const save = part(main, 'async function saveDraft()', 'function draftDialog(');
  const start = save.indexOf('const sent = state.sending.start();');
  assert.ok(start > 0 && start < save.indexOf('await ensureDraftBranch();'), 'Save as draft is not counted from the start');
  assert.ok(save.indexOf('} finally { sent(); }') > save.indexOf('await putFile(state.gh, cfg.repo, state.page.path, {'), 'Save as draft does not stop being counted when it has answered or failed');
  // The demo keeps a draft in the browser and returns before anything is counted.
  assert.ok(save.indexOf('if (cfg.sandbox) { saveDraftSandbox(); return; }') < start);
  assert.match(main, /await whileSending\(\(\) => state\.gh\.request\('DELETE', [^\n]+\n\s+\{ message: draftDeleteMessage\(state\.page\.path\), sha: draft\.sha, branch: DRAFT_BRANCH \}\)\);/,
    'Deleting a saved draft (as the owner) is not counted as a save being sent');
  counted(main, 'await whileSending(() => putFile(state.gh, cfg.repo, state.page.path,\n          { text: state.page.text, sha: draft.sha, branch: DRAFT_BRANCH, message: draftDeleteMessage(state.page.path) }));',
    'Deleting a saved draft (as an invited editor)');
});

test('every save: scheduling a change and cancelling one', () => {
  counted(main, "const data = await whileSending(() => ask('/schedule', { method: 'POST',\n        body: { repo: cfg.repo, path: state.page.path,", 'Schedule for later');
  counted(main, "await whileSending(() => ask('/schedule', { method: 'POST', body: { repo: cfg.repo, branch: cfg.branch || 'main', at: new Date(when).toISOString(),", 'Scheduling edits on a site built from content files');
  counted(main, "const data = await whileSending(() => ask('/schedule', { method: 'POST', body: { repo: cfg.repo, branch: cfg.branch || 'main', at: new Date(at).toISOString(),", '"Put it on the site later" for a draft post');
  counted(main, "await whileSending(() => ask('/schedule/cancel', { method: 'POST', body: { repo: cfg.repo, id: s.id } }));", 'Cancelling a scheduled change');
});

test('every save: suggestions', () => {
  counted(suggest, 'return deps.whileSending(() => sendSuggestionNow(note, onStatus));', 'Sending a suggestion');
  counted(suggest, "data = await deps.whileSending(() => ask('/suggestions/decide', { method: 'POST',", 'Approving or declining a suggestion');
  counted(main, 'flattenPending, retireStaged, whileSending,', 'Suggestions (they are handed the counting by the editor)');
  // The preview branch of a suggestion is written inside the sending of it.
  const send = part(suggest, 'async function sendSuggestionNow(note, onStatus) {', '\n}\n');
  assert.ok(send.includes('await writePreviewBranch(edits)') && send.includes("await ask('/suggestions', { method: 'POST', body });"));
});

test('every save: going back, undoing, and the saves of a site built from content files', () => {
  counted(main, 'const r = await whileSending(() => revertPublish({ gh: state.gh,', 'Undo, just after a publish');
  counted(main, "const r = await whileSending(() => entryCall('/source/revert', { file: f, toSha: sha }));", 'History\'s "Go back to this" on a site built from content files');
  counted(main, "if (c.created) await whileSending(() => entryCall('/source/remove', { file: c.file }));", 'Undo of a new post after the site failed to build');
  counted(main, "else await whileSending(() => ask('/source/revert', { method: 'POST', body }));", 'Undo of a publish after the site failed to build');
  counted(main, 'try { await whileSending(() => commitStagedFiles([...refs].map(', "Page settings' Publish on a site built from content files (its pictures)");
  counted(main, "await whileSending(() => publishSource('', { only: refs }));", "Page settings' Publish on a site built from content files");
  counted(main, 'if (mine.size) return whileSending(() => publishSource(note, { only: mine }));', '"Use mine", after someone else changed the same field');
  counted(main, "await whileSending(() => state.gh.request('POST', `/repos/${cfg.repo}/git/refs`,\n          { ref: `refs/tags/kiln/", 'Naming a version in History');
});

test('every save: "Make this whole page editable" and the first reusable block', () => {
  const whole = part(main, 'async function wholePage(btn) {', '\n}\n');
  const sent = whole.indexOf('const result = await whileSending(() => editFile(state.gh, cfg.repo, path, branch, (text) => {');
  const over = whole.indexOf('}, wholePageMessage(path, plan.counts)));');
  assert.ok(sent > 0 && over > sent, '"Make this whole page editable" is not counted as a save being sent');
  // The editor reloads the page itself once the save has answered: by then nothing is being sent, so the browser does not ask.
  assert.ok(whole.indexOf('location.reload();') > over);
  counted(main, 'putRepoFile: (path, opts) => whileSending(() => putFile(state.gh, cfg.repo, path, opts))', 'Adding the first reusable block');
});

test('every save: no call that writes for one of these actions is left uncounted', () => {
  // Each of these writes to the repository wherever it is called. A new call
  // of one of them has to be counted too, or say here why it is not.
  const writes = /\b(entryCall\('\/source\/(create|remove|revert)'|ask\('\/schedule(\/cancel)?'|ask\('\/source\/revert'|replaceEverywhere\(\{|revertPublish\(\{|state\.gh\.request\('(POST|PUT|PATCH)')/;
  const inside = new Set([
    // Save as draft makes the drafts branch the first time: counted by saveDraft, from its start.
    "await state.gh.request('POST', `/repos/${cfg.repo}/git/refs`, { ref: `refs/heads/${DRAFT_BRANCH}`, sha: main.object.sha });",
  ]);
  const left = main.split('\n')
    .filter(l => writes.test(l) && !/^\s*(\/\/|\*)/.test(l))
    .filter(l => !l.includes('whileSending(() => ') && !inside.has(l.trim()));
  assert.deepEqual(left.map(l => l.trim().slice(0, 100)), []);
});
