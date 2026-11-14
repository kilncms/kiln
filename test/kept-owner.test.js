/**
 * An owner who has no GitHub account. Kiln keeps the site's files in a
 * repository of its own, which the owner can never open, and the sign-in
 * service says so in its answer to GET /auth/session (`kept: true`).
 *
 * The editor reads right for them: no sentence names GitHub or a repository
 * (src/editor/kept-words.js) and no link leads to github.com. Signing in
 * again is in kept-owner-sign-in.test.js. Everybody else reads every
 * sentence exactly as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ownerWords, KEPT_SENTENCES } from '../src/editor/kept-words.js';
import { PEOPLE_WORDS } from '../src/editor/first-edits.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'editor');
const read = (name) => readFileSync(path.join(dir, name), 'utf8');
const editor = readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'kept-words.js').map(read).join('\n');

const NAMES_GITHUB = /GitHub|github|repositor|\brepo\b/;

// ─── The words ───────────────────────────────────────────────────────────────

test('kept words: everybody else reads every sentence exactly as it is written', () => {
  for (const [written] of KEPT_SENTENCES) {
    assert.equal(ownerWords(written), written);
    assert.equal(ownerWords(written, false), written);
    assert.equal(ownerWords(written, undefined), written);
    assert.equal(ownerWords(written, 'yes'), written);   // only the service's own `true` counts
  }
});

test('kept words: an owner without GitHub reads no sentence that names GitHub or a repository', () => {
  assert.ok(KEPT_SENTENCES.length >= 10);
  for (const [written, kept] of KEPT_SENTENCES) {
    assert.equal(ownerWords(written, true), kept);
    assert.notEqual(kept, written);
    assert.doesNotMatch(kept, NAMES_GITHUB, kept);
    assert.doesNotMatch(kept, /—/, 'a plain sentence has no dash in it: ' + kept);
  }
  assert.equal(ownerWords('Publishing: saving to GitHub…', true), 'Publishing: saving…');
  assert.equal(ownerWords('Published to GitHub ✓', true), 'Published ✓');
  assert.equal(ownerWords('Saving to GitHub…', true), 'Saving…');
  assert.equal(ownerWords('Can’t reach GitHub right now. Check your connection and reload.', true),
    'Kiln cannot reach your site’s files right now. Check your connection and reload.');
  assert.equal(ownerWords(PEOPLE_WORDS.membersRead, true),
    'Members-only pages are kept with the rest of your site’s files, so every editor you invite can read them.');
});

test('kept words: a sentence that is not listed is the same for everyone', () => {
  assert.equal(ownerWords('Signed in as Rosa Diaz.', true), 'Signed in as Rosa Diaz.');
  assert.equal(ownerWords('', true), '');
});

test('kept words: every listed sentence is still written in the editor, and is said through ownerWords there', () => {
  // A sentence reworded where it is used would otherwise lose its kept form without anyone noticing.
  for (const [written] of KEPT_SENTENCES) {
    const said = written === PEOPLE_WORDS.membersRead
      ? editor.includes('ownerWords(PEOPLE_WORDS.membersRead, ')
      : editor.includes(`ownerWords('${written}', `) || editor.includes(`ownerWords("${written}", `);
    assert.ok(editor.includes(written), 'no longer written in the editor: ' + written);
    assert.ok(said, 'not said through ownerWords: ' + written);
  }
});

test('kept owner: the editor shows no link to github.com that they cannot open', () => {
  const main = read('main.js');
  const links = [...main.matchAll(/https:\/\/github\.com\/\$\{/g)];
  assert.equal(links.length, 2, 'the two links to a commit');
  // Each is left out for an owner the service calls kept.
  for (const m of links) assert.match(main.slice(m.index - 260, m.index), /state\.kept \? /);
  // No other module links to a repository: the one link left is to Kiln's own public documentation.
  const others = [...editor.matchAll(/https:\/\/github\.com\/[^$\s"'`]+/g)].map(m => m[0]);
  assert.deepEqual(others, ['https://github.com/kilncms/kiln/blob/main/docs/for-site-owners.md#theme-tokens']);
});
