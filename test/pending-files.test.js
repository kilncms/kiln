import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { filesToRestore, siteAddress, syncPlan } from '../src/editor/pending-files.js';

const file = (path) => ({ path, base64: 'AAAA' });

test('restore: the uploads a saved edit points at come back with it', () => {
  const files = [file('assets/uploads/img-m1abc.webp'), file('assets/uploads/master-m1abc.webp'), file('assets/uploads/img-undone.webp'), file('assets/files/minutes.pdf')];
  const edits = {
    hero_img: { attrs: { src: '/assets/uploads/img-m1abc.webp', 'data-kiln-master': '/assets/uploads/master-m1abc.webp' } },
    notes: { html: 'Read the <a href="/assets/files/minutes.pdf">minutes</a>.' },
  };
  assert.deepEqual(filesToRestore(files, edits).map(f => f.path),
    ['assets/uploads/img-m1abc.webp', 'assets/uploads/master-m1abc.webp', 'assets/files/minutes.pdf'],
    'the picture, its full-size original and the document; not the swap that was undone');
  assert.deepEqual(filesToRestore(files, { title: { html: 'Just words' } }), []);
  assert.deepEqual(filesToRestore(null, edits), []);
  assert.deepEqual(filesToRestore(files, null), []);
});

test('restore: a picture inside a list of blocks is found in the list\'s HTML', () => {
  const edits = { products: { html: '<article><img src="/assets/uploads/tee-9z.webp" alt="Tee"></article>' } };
  assert.deepEqual(filesToRestore([file('assets/uploads/tee-9z.webp'), file('assets/uploads/other.webp')], edits).map(f => f.path), ['assets/uploads/tee-9z.webp']);
});

test('restore: a repository path becomes the address the page uses', () => {
  assert.equal(siteAddress('assets/uploads/a.webp'), '/assets/uploads/a.webp');
  assert.equal(siteAddress('site/assets/uploads/a.webp', 'site/'), '/assets/uploads/a.webp');
  assert.equal(siteAddress('/assets/uploads/a.webp', ''), '/assets/uploads/a.webp');
  assert.equal(siteAddress('other/a.webp', 'site'), '/other/a.webp');
});

test('restore: what is kept follows what is queued', () => {
  assert.deepEqual(syncPlan(['a', 'b'], []), { add: ['a', 'b'], remove: [] });
  assert.deepEqual(syncPlan(['b'], ['a', 'b']), { add: [], remove: ['a'] }, 'published or undone: no longer kept');
  assert.deepEqual(syncPlan([], ['a']), { add: [], remove: ['a'] });
  assert.deepEqual(syncPlan(['a'], ['a']), { add: [], remove: [] });
});

test('restore: the editor keeps queued uploads beside the saved edits and reads them before tidying', () => {
  const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
  const offer = main.slice(main.indexOf('function offerPendingRestore()'), main.indexOf('function escapeHtml('));
  assert.ok(offer.indexOf('keptFiles(pendingStorageKey())') < offer.indexOf('keptReady = true'), 'an earlier visit\'s files are read before this visit may remove any');
  assert.ok(offer.includes('state.pendingBinaries.set(f.path, f.base64)'), 'restored files are queued for the next Publish');
  assert.ok(offer.includes("img.setAttribute('data-kiln-src', url)"), 'and shown from the kept bytes, as a fresh upload is');
  const save = main.slice(main.indexOf('function savePendingToStorage()'), main.indexOf('function clearSavedPending()'));
  assert.ok(save.indexOf('if (!keptReady) return;') !== -1 && save.indexOf('if (!keptReady) return;') < save.indexOf('localStorage.removeItem'),
    'saved edits are not erased at boot before they can be offered back (an editor\'s first presence answer refreshes Publish with nothing staged)');
  assert.ok(save.includes('syncKeptFiles();'));
  assert.match(main, /if \(!keptReady \|\| cfg\.sandbox\) return;/, 'never in the demo, never before the restore offer has looked');
});
