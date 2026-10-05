/**
 * src/file-policy.js — which file types an invited editor's session may write
 * (KLN-01), and the size + leading-bytes check on uploads (KLN-02). Pure
 * functions; the worker's use of them is covered in worker-uploads.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  editorFileKind, isUploadKind, fileExt, sniffFamily, uploadProblem, base64Bytes, base64Head,
  fileRefusalText, UPLOAD_MAX_BYTES, FILE_MESSAGES,
} from '../src/file-policy.js';
import { SAMPLES, bytes, pad } from './worker-harness.js';

const SVG = new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));

test('editorFileKind: pages, stylesheets and each upload family, by the last extension', () => {
  assert.equal(editorFileKind('index.html'), 'html');
  assert.equal(editorFileKind('old/page.HTM'), 'html');
  assert.equal(editorFileKind('assets/site.css'), 'css');
  for (const p of ['a.png', 'a.jpg', 'a.JPEG', 'a.gif', 'a.webp', 'a.avif', 'favicon.ico']) assert.equal(editorFileKind(p), 'image', p);
  assert.equal(editorFileKind('assets/files/report.final.pdf'), 'pdf');
  for (const p of ['f.woff', 'f.woff2', 'f.ttf', 'f.otf']) assert.equal(editorFileKind(p), 'font', p);
  for (const p of ['a.mp3', 'a.m4a', 'a.mp4', 'a.m4v', 'a.mov', 'a.webm', 'a.ogg', 'a.oga', 'a.ogv', 'a.wav']) assert.equal(editorFileKind(p), 'media', p);
  for (const p of ['a.docx', 'a.xlsx', 'a.pptx', 'a.odt', 'a.ods', 'a.odp']) assert.equal(editorFileKind(p), 'office', p);
  assert.equal(isUploadKind('image'), true);
  assert.equal(isUploadKind('html'), false);
  assert.equal(isUploadKind(null), false);
});

test('editorFileKind: types a browser can run script from are never writable', () => {
  for (const p of ['logo.svg', 'logo.SVG', 'logo.svgz', 'feed.xml', 'style.xsl', 'style.xslt', 'page.xhtml', 'page.xht',
    'feed.rss', 'feed.atom', 'eq.mathml', 'eq.mml', 'x.shtml', 'x.hta', 'x.htc']) {
    assert.equal(editorFileKind(p), null, p);
  }
});

test('editorFileKind: anything not on the list is refused — content files, data, code, no extension', () => {
  for (const p of ['notes.md', 'post.mdx', 'data.json', 'robots.txt', 'feed.csv', 'app.js', 'x.php', 'x.astro', 'site.webmanifest',
    'README', '.htaccess', '.well-known/acme-challenge/token', 'trailing.', 'dir.with.dots/file', 'legacy.doc', 'macro.docm', 'a.zip', 'a.exe', 'a.heic']) {
    assert.equal(editorFileKind(p), null, p);
  }
});

test('fileExt: the LAST extension decides, so a double extension cannot dress a file up', () => {
  assert.equal(fileExt('photo.png.svg'), 'svg');
  assert.equal(editorFileKind('photo.png.svg'), null);
  assert.equal(fileExt('drawing.svg.png'), 'png');       // an image by name — its bytes are checked next
  assert.equal(fileExt('a/b.c/d'), '');
  assert.equal(fileExt(''), '');
  assert.equal(fileExt(undefined), '');
});

test('uploadProblem: scriptable types are a 403 with a plain reason, other types a 415', () => {
  const svg = uploadProblem('assets/logo.svg');
  assert.deepEqual({ status: svg.status, code: svg.code }, { status: 403, code: 'file_active' });
  assert.equal(svg.error, FILE_MESSAGES.active);
  for (const p of ['feed.xml', 'x.xsl', 'page.xhtml']) assert.equal(uploadProblem(p).code, 'file_active', p);
  const md = uploadProblem('notes.md');
  assert.deepEqual({ status: md.status, code: md.code }, { status: 415, code: 'file_type' });
  assert.equal(md.error, FILE_MESSAGES.type);
  assert.equal(uploadProblem('index.html'), null);
  assert.equal(uploadProblem('assets/site.css'), null);
  assert.equal(uploadProblem('a.png'), null);              // by name alone; bytes are judged when given
});

test('uploadProblem: the size ceiling applies to every kind, pages included', () => {
  assert.equal(uploadProblem('a.pdf', { size: UPLOAD_MAX_BYTES, head: SAMPLES.pdf }), null);
  const big = uploadProblem('a.pdf', { size: UPLOAD_MAX_BYTES + 1, head: SAMPLES.pdf });
  assert.deepEqual({ status: big.status, code: big.code }, { status: 413, code: 'file_size' });
  assert.equal(uploadProblem('index.html', { size: UPLOAD_MAX_BYTES + 1 }).code, 'file_size');
  assert.equal(uploadProblem('site.css', { size: UPLOAD_MAX_BYTES + 1 }).code, 'file_size');
  // A refused type is refused for its type, whatever its size.
  assert.equal(uploadProblem('a.svg', { size: 10 }).code, 'file_active');
});

test('sniffFamily: recognises the leading bytes of every allowed upload', () => {
  const want = { png: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', ico: 'image', pdf: 'pdf',
    woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', mp3: 'media', mp3frame: 'media', mp4: 'media', mov: 'media',
    webm: 'media', ogg: 'media', wav: 'media', zip: 'office' };
  for (const [name, family] of Object.entries(want)) assert.equal(sniffFamily(SAMPLES[name]), family, name);
  // A PDF header may follow a byte-order mark.
  assert.equal(sniffFamily(pad(bytes([0xef, 0xbb, 0xbf], '%PDF-1.4'))), 'pdf');
  // Accepts a plain array or ArrayBuffer too.
  assert.equal(sniffFamily([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image');
});

test('sniffFamily: markup, scripts and programs belong to no family', () => {
  for (const text of ['<svg xmlns="http://www.w3.org/2000/svg">', '<?xml version="1.0"?><svg>', '<!doctype html><script>', '<html>',
    '#!/bin/sh\nrm -rf /', 'MZ\x90\x00\x03', '\x7fELF\x02\x01', 'just some words', '{"a":1}', '']) {
    assert.equal(sniffFamily(new Uint8Array(Buffer.from(text, 'latin1'))), null, JSON.stringify(text.slice(0, 20)));
  }
  assert.equal(sniffFamily(undefined), null);
  assert.equal(sniffFamily(new Uint8Array(3)), null);
});

test('uploadProblem: an upload must hold what its name says (by family)', () => {
  // The audit case: SVG markup committed under an image name.
  const dressed = uploadProblem('assets/uploads/drawing.svg.png', { size: SVG.length, head: SVG });
  assert.deepEqual({ status: dressed.status, code: dressed.code }, { status: 415, code: 'file_mismatch' });
  assert.match(dressed.error, /named like an image/);
  assert.equal(uploadProblem('a.pdf', { size: 64, head: SAMPLES.png }).code, 'file_mismatch');
  assert.equal(uploadProblem('a.jpg', { size: 20, head: new Uint8Array(Buffer.from('<html><script>x</script>')) }).code, 'file_mismatch');
  assert.equal(uploadProblem('a.woff2', { size: 64, head: SAMPLES.zip }).code, 'file_mismatch');
  assert.equal(uploadProblem('a.docx', { size: 64, head: SAMPLES.pdf }).code, 'file_mismatch');
  assert.equal(uploadProblem('a.mp4', { size: 64, head: SAMPLES.avif }).code, 'file_mismatch');
  assert.equal(uploadProblem('a.png', { size: 0, head: new Uint8Array(0) }).code, 'file_mismatch');   // empty is not an image
});

test('uploadProblem: the family matches, not the exact extension (a PNG saved as .webp is still an image)', () => {
  // Browsers that cannot encode WebP hand back PNG bytes under the .webp name
  // the editor chose. Harmless, and must keep working.
  assert.equal(uploadProblem('assets/uploads/img-abc.webp', { size: 64, head: SAMPLES.png }), null);
  assert.equal(uploadProblem('a.jpg', { size: 64, head: SAMPLES.png }), null);
  assert.equal(uploadProblem('a.mov', { size: 64, head: SAMPLES.mp4 }), null);
  assert.equal(uploadProblem('a.ttf', { size: 64, head: SAMPLES.otf }), null);
  for (const [name, head] of Object.entries(SAMPLES)) {
    const ext = { jpeg: 'jpg', mp3frame: 'mp3', zip: 'docx' }[name] || name;
    assert.equal(uploadProblem(`file.${ext}`, { size: head.length, head }), null, name);
  }
});

test('base64Bytes / base64Head: size and leading bytes without decoding the whole upload', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 100, 1000]) {
    assert.equal(base64Bytes(Buffer.alloc(n, 7).toString('base64')), n, `n=${n}`);
  }
  assert.equal(base64Bytes(undefined), 0);
  const b64 = Buffer.from(SAMPLES.png).toString('base64') + Buffer.alloc(3000, 1).toString('base64');
  assert.deepEqual([...base64Head(b64).slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(base64Head(b64).length >= 16 && base64Head(b64).length <= 64);
  // GitHub accepts line-wrapped base64; so does the head read.
  const wrapped = b64.replace(/(.{20})/g, '$1\n');
  assert.equal(sniffFamily(base64Head(wrapped)), 'image');
  // Characters outside the alphabet are skipped (as GitHub's own decoder does), never fatal.
  assert.equal(base64Head('****').length, 0);
  assert.equal(sniffFamily(base64Head('!!' + b64)), 'image');
  assert.equal(base64Head('').length, 0);
});

test('FILE_MESSAGES: plain sentences a person can act on, with the real limit', () => {
  const all = [FILE_MESSAGES.type, FILE_MESSAGES.active, FILE_MESSAGES.size, FILE_MESSAGES.mismatch('image'), FILE_MESSAGES.mismatch('pdf')];
  for (const m of all) {
    assert.ok(!/[—–]/.test(m), `no dashes: ${m}`);
    assert.ok(/[.!]$/.test(m), `a full sentence: ${m}`);
    assert.ok(m.length < 190, `short: ${m}`);
  }
  assert.match(FILE_MESSAGES.size, /15 MB/);
  assert.equal(UPLOAD_MAX_BYTES, 15 * 1024 * 1024);
  assert.match(FILE_MESSAGES.active, /only the site owner/);
});

test('fileRefusalText: the editor shows the worker\'s sentence for file refusals, and only those', () => {
  assert.equal(fileRefusalText({ error: FILE_MESSAGES.size, code: 'file_size' }), FILE_MESSAGES.size);
  assert.equal(fileRefusalText({ error: FILE_MESSAGES.active, code: 'file_active', path: 'a.svg' }), FILE_MESSAGES.active);
  assert.equal(fileRefusalText({ error: 'outside your editing scope' }), null);
  assert.equal(fileRefusalText({ message: 'Not Found' }), null);
  assert.equal(fileRefusalText(null), null);
  assert.equal(fileRefusalText({ code: 'file_type' }), null);
});
