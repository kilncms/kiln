/**
 * When a publish uses a saved draft up (src/editor/resumed-draft.js, and
 * where main.js uses it).
 *
 * A tester lost a draft this way: resume it, save it as a draft again, come
 * back, press "Later", publish some other change. The editor had noted only
 * "this tab resumed the draft", so that publish counted as the draft's own:
 * the draft was marked as published, its words never went live, and it was
 * not offered again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resumedNote, readResumed, draftWasPublished, noteIsStale } from '../src/editor/resumed-draft.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40);

test('the note names the draft and the parts it brought back, each once', () => {
  assert.deepEqual(JSON.parse(resumedNote(A, ['about_title', 'about_intro', 'about_title'])), { sha: A, keys: ['about_title', 'about_intro'] });
  assert.deepEqual(readResumed(resumedNote(A, ['about_title'])), { sha: A, keys: ['about_title'] });
  // An older editor left only the draft's id: it is read, and it names no parts.
  assert.deepEqual(readResumed(A), { sha: A, keys: [] });
  for (const none of [null, undefined, '', 'not json', '{}', '[]', '{"sha":""}', '{"keys":["x"]}', 7]) assert.equal(readResumed(none), null, String(none));
});

test('a publish is the draft\'s own only when every part the draft brought back was written by it', () => {
  const note = resumedNote(A, ['about_title', 'about_intro']);
  assert.equal(draftWasPublished(note, A, ['about_title', 'about_intro']), true, 'the resumed parts, published');
  assert.equal(draftWasPublished(note, A, ['about_title', 'about_intro', 'about_cta']), true, 'with something more typed after the resume');
  assert.equal(draftWasPublished(note, A, ['about_cta']), false, 'some other change: the draft stays a draft');
  assert.equal(draftWasPublished(note, A, ['about_title']), false, 'one of its parts was dropped from the publish: the draft still holds it');
  assert.equal(draftWasPublished(note, A, []), false);
  assert.equal(draftWasPublished(note, B, ['about_title', 'about_intro']), false, 'the draft was saved again since: it is another draft now');
  assert.equal(draftWasPublished(note, null, ['about_title', 'about_intro']), false, 'no draft on the branch');
  // A note that names no parts never counts: this is the case that lost a draft.
  assert.equal(draftWasPublished(A, A, ['about_cta']), false);
  assert.equal(draftWasPublished(A, A, ['about_title', 'about_intro']), false);
  assert.equal(draftWasPublished(resumedNote(A, []), A, ['about_title']), false);
  assert.equal(draftWasPublished(null, A, ['about_title']), false);
});

test('a note about a draft that is no longer the one on the branch is stale', () => {
  const note = resumedNote(A, ['about_title']);
  assert.equal(noteIsStale(note, A), false);
  assert.equal(noteIsStale(note, B), true);
  assert.equal(noteIsStale(note, null), true);
  assert.equal(noteIsStale('nonsense', A), true);
});

test('main.js: resume notes the parts, saving a draft again throws the note away, and publish hands over what it wrote', () => {
  const main = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'editor', 'main.js'), 'utf8');
  assert.match(main, /sessionStorage\.setItem\(draftResumedKey\(\), resumedNote\(draft\.sha, brought\)\)/, 'resume notes the parts it brought back');
  const save = main.slice(main.indexOf('message: draftSaveMessage('), main.indexOf("setStatus('Draft saved ✓"));
  assert.match(save, /forgetResumedDraft\(\);/, 'a draft saved again is a draft like any other');
  assert.match(main, /retireResumedDraft\(\[\.\.\.appliedKeys\]\)/, 'the publish says which parts it wrote');
  const retire = main.slice(main.indexOf('async function retireResumedDraft('), main.indexOf('function forgetResumedDraft()'));
  assert.ok(retire.indexOf('if (!draftWasPublished(note, now.sha, publishedKeys)) return;') > 0, 'something else was published: the draft is left where it is');
  assert.ok(retire.indexOf('draftWasPublished(') < retire.indexOf("request('DELETE'"), 'and that is decided before anything is taken off the drafts branch');
  assert.ok(retire.indexOf('draftWasPublished(') < retire.indexOf('putFile('), 'for an invited editor too');
});
