/**
 * What the editor says when a file chosen as a picture was not added
 * (src/editor/picture-not-added.js, and where main.js uses it).
 *
 * A tester renamed a text file to end in `.png`, chose it as a picture, and
 * was told only "Image upload failed".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pictureNotAdded, PICTURE_NOT_ADDED, NOT_OPENED_AS_PICTURE } from '../src/editor/picture-not-added.js';
import { FILE_MESSAGES, UPLOAD_MAX_BYTES } from '../src/file-policy.js';
import { said } from '../src/editor/plain-failure.js';

const bytes = (...b) => { const a = new Uint8Array(48); a.set(b); return a; };
const TEXT = new TextEncoder().encode('Notes for Tuesday. Bring the list of names and the keys.').slice(0, 48);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPG = bytes(0xff, 0xd8, 0xff, 0xe0);
// What a browser throws when it cannot read a file as a picture.
const unreadable = () => Object.assign(new Error('The source image could not be decoded.'), { name: 'InvalidStateError' });

test('picture not added: a text file renamed .png is said to hold something else, with what to do', () => {
  const line = pictureNotAdded({ name: 'notes.png', size: 56, head: TEXT }, unreadable());
  assert.equal(line, 'The picture was not added. That file is named like an image, but it holds something else. Check the file and try again.');
  assert.equal(line, `${PICTURE_NOT_ADDED} ${FILE_MESSAGES.mismatch('image')}`);
});

test('picture not added: a picture the browser cannot read is to be saved as a JPG or PNG', () => {
  // A photo straight from a phone, a kind the editor does not take.
  assert.equal(pictureNotAdded({ name: 'IMG_0412.heic', size: 2_000_000, head: bytes(0, 0, 0, 0x18) }, unreadable()),
    `${PICTURE_NOT_ADDED} ${NOT_OPENED_AS_PICTURE}`);
  // A file that begins as a JPG does and is damaged further in.
  assert.equal(pictureNotAdded({ name: 'garden.jpg', size: 90_000, head: JPG }, unreadable()),
    `${PICTURE_NOT_ADDED} ${NOT_OPENED_AS_PICTURE}`);
  // A drawing as SVG: the same advice, for the owner and for an invited editor alike.
  assert.equal(pictureNotAdded({ name: 'logo.svg', size: 900, head: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">') }, unreadable()),
    `${PICTURE_NOT_ADDED} ${NOT_OPENED_AS_PICTURE}`);
  // A document chosen by mistake.
  assert.equal(pictureNotAdded({ name: 'minutes.pdf', size: 40_000, head: new TextEncoder().encode('%PDF-1.7') }, unreadable()),
    `${PICTURE_NOT_ADDED} ${NOT_OPENED_AS_PICTURE}`);
});

test('picture not added: a file over the size limit is told the limit', () => {
  const line = pictureNotAdded({ name: 'poster.png', size: UPLOAD_MAX_BYTES + 1, head: PNG }, unreadable());
  assert.equal(line, `${PICTURE_NOT_ADDED} ${FILE_MESSAGES.size}`);
  assert.match(line, /15 MB/);
});

test('picture not added: when the first bytes could not be read, the file is still not called something it may not be', () => {
  assert.equal(pictureNotAdded({ name: 'notes.png', size: 56 }, unreadable()), `${PICTURE_NOT_ADDED} ${NOT_OPENED_AS_PICTURE}`);
});

test('picture not added: trouble that is not about the file is not blamed on the file', () => {
  // A real picture, and something else went wrong after the browser had read it.
  const own = pictureNotAdded({ name: 'garden.png', size: 90_000, head: PNG }, new TypeError("Cannot read properties of null (reading 'request')"));
  assert.equal(own, 'The picture was not added. Kiln had a problem of its own, so please reload the page and try again.');
  const ended = pictureNotAdded({ name: 'garden.png', size: 90_000, head: PNG }, Object.assign(new Error('GitHub 401'), { status: 401 }));
  assert.ok(ended.startsWith(`${PICTURE_NOT_ADDED} `));
  assert.ok(!ended.includes(NOT_OPENED_AS_PICTURE));
  // An explanation written for the person goes as it is.
  assert.equal(pictureNotAdded({ name: 'garden.png', size: 90_000, head: PNG }, said('Pictures cannot be added to this part')),
    'The picture was not added. Pictures cannot be added to this part.');
});

test('picture not added: every line says what was not done, in plain words, and never shows what the browser threw', () => {
  const lines = [
    pictureNotAdded({ name: 'notes.png', size: 56, head: TEXT }, unreadable()),
    pictureNotAdded({ name: 'IMG_0412.heic', size: 2_000_000 }, unreadable()),
    pictureNotAdded({ name: 'poster.png', size: UPLOAD_MAX_BYTES + 1, head: PNG }, unreadable()),
    pictureNotAdded({ name: 'garden.png', size: 90_000, head: PNG }, new Error('boom')),
    pictureNotAdded(undefined, undefined),
  ];
  for (const line of lines) {
    assert.ok(line.startsWith(`${PICTURE_NOT_ADDED} `), line);
    assert.ok(line.length > PICTURE_NOT_ADDED.length + 20, line);
    assert.doesNotMatch(line, /—|could not be decoded|boom|undefined|upload failed/i, line);
    assert.match(line, /\.$/, line);
  }
});

test('picture not added: both places a picture is chosen say why, and "Image upload failed" is gone', () => {
  const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
  assert.ok(!main.includes('Image upload failed'));
  const body = (name) => {
    const at = main.indexOf(`function ${name}(`);
    assert.ok(at > 0, name);
    return main.slice(at, main.indexOf('\n}\n', at));   // to the end of that function
  };
  for (const name of ['pickImage', 'insertInlineImage']) {
    assert.match(body(name), /catch \(err\) \{[^}]*await sayPictureNotAdded\(file, err\);/, name);
  }
  // The file's first bytes are read after the browser has failed with it, not before.
  assert.match(body('sayPictureNotAdded'), /file\.slice\(0, 48\)\.arrayBuffer\(\)/);
  assert.match(body('sayPictureNotAdded'), /setStatus\(pictureNotAdded\(\{ name: file\.name, size: file\.size, head \}, err\), 'error'\)/);
});
