/**
 * src/file-policy.js — which file types an invited editor's session may write
 * (KLN-01). Pure functions; the worker's use of them is covered in
 * worker-uploads.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorFileKind, isUploadKind, fileExt, uploadProblem, FILE_MESSAGES } from '../src/file-policy.js';

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
  assert.equal(fileExt('drawing.svg.png'), 'png');
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
  assert.equal(uploadProblem('a.png'), null);
});
