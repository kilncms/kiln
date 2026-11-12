/**
 * A picture's full-size original (data-kiln-master) is saved with the publish
 * that names it (src/editor/main.js, resampleToDisplay).
 *
 * Dragging a picture's corner makes a copy of it at the new size. The largest
 * version Kiln holds is named on the picture as data-kiln-master, so that a
 * later drag to a bigger size starts from it and stays sharp.
 *
 * A tester put a picture inside a paragraph, dragged its corner and
 * published. The page visitors got named /assets/uploads/qa-small-….webp as
 * the original, and that address answered 404: the file was never saved.
 * The cause: a drag drops the upload a previous drag queued, so that a pile
 * of in-between sizes is not published, and it found that upload by the
 * picture's data-kiln-src. For a picture inside a paragraph (and for one made
 * smaller with a size button) the first file queued is the original itself.
 * The first drag named it as the original and, one line later, dropped it
 * from what Publish saves.
 *
 * The drag is browser work (canvas, bitmaps), so what is tested here is that
 * the rule is in the code that does it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = readFileSync(path.join(ROOT, 'src', 'editor', 'main.js'), 'utf8');
const resample = main.slice(main.indexOf('async function resampleToDisplay('), main.indexOf('function stageImageEl('));

test('a drag never drops the upload that the picture names as its original', () => {
  assert.match(resample, /const prev = img\.getAttribute\('data-kiln-src'\);\n\s+if \(prev && safeUrl\(prev\) !== master\) state\.pendingBinaries\.delete\(/);
  assert.doesNotMatch(resample, /if \(prev\) state\.pendingBinaries\.delete\(/);
  // one drop only, and the original is named before it
  assert.equal((resample.match(/state\.pendingBinaries\.delete\(/g) || []).length, 1);
  assert.ok(resample.indexOf("img.setAttribute('data-kiln-master', master)") < resample.indexOf('state.pendingBinaries.delete('));
});

test('the original is what the picture already names, else the file waiting for Publish, else the one on the site', () => {
  assert.match(resample, /let master = img\.getAttribute\('data-kiln-master'\)\s*\n\s*\|\| img\.getAttribute\('data-kiln-src'\) \|\| img\.getAttribute\('src'\);/);
  assert.match(resample, /master = safeUrl\(master\);/);
});

test('the pictures this is about queue their first file under the address a first drag takes as the original', () => {
  // a picture put inside a paragraph
  const inline = main.slice(main.indexOf('function insertInlineImage('), main.indexOf('function uploadAnyFile('));
  assert.match(inline, /stageBinary\(repoPath, base64\);/);
  assert.match(inline, /data-kiln-src="\$\{urlPath\}"/);
  // a picture made smaller with a size button, or swapped
  const swap = main.slice(main.indexOf('async function stageImageSwap('), main.indexOf('function applyImageSize('));
  assert.match(swap, /stageBinary\(repoPath, base64\);/);
  assert.match(swap, /img\.setAttribute\('data-kiln-src', urlPath\);/);
});

test('Publish saves every queued file that what is published names, so an original that is still queued goes with it', () => {
  const commit = main.slice(main.indexOf('async function commitStagedFiles('), main.indexOf('async function publish('));
  assert.match(commit, /const named = \(path\) => \{ const base = path\.split\('\/'\)\.pop\(\); return !!base && haystack\.includes\(base\); \};/);
  assert.match(commit, /const files = \[\.\.\.state\.pendingBinaries\]\.filter\(\(\[path\]\) => named\(path\)\)/);
});
