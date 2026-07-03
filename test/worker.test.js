import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathInScope, isSensitivePath, normalizePaths } from '../worker/index.js';

test('pathInScope: whole-site grants', () => {
  for (const p of [[''], ['*'], ['**'], []]) assert.equal(pathInScope('anything/here.html', p), true);
  assert.equal(pathInScope('x', undefined), true);
});

test('pathInScope: prefix scoping respects segment boundaries', () => {
  assert.equal(pathInScope('blog/post.html', ['blog']), true);
  assert.equal(pathInScope('blog', ['blog']), true);            // dir itself
  assert.equal(pathInScope('about.html', ['blog']), false);
  assert.equal(pathInScope('blogfoo/x', ['blog']), false);      // not a real prefix boundary
  assert.equal(pathInScope('/blog/x', ['blog']), true);         // leading slash normalized
  assert.equal(pathInScope('a.html', ['blog', 'a.html']), true);// multi-scope
});

test('pathInScope: rejects path traversal', () => {
  assert.equal(pathInScope('blog/../CNAME', ['blog']), false);
  assert.equal(pathInScope('./CNAME', ['']), false);
  assert.equal(pathInScope('a/./b', ['a']), false);
});

test('isSensitivePath: blocks config files and traversal', () => {
  for (const p of ['CNAME', 'cname', '_redirects', '_headers', '.github/workflows/ci.yml', '/CNAME'])
    assert.equal(isSensitivePath(p), true);
  assert.equal(isSensitivePath('blog/../CNAME'), true);
  assert.equal(isSensitivePath('blog/post.html'), false);
  assert.equal(isSensitivePath('assets/img/x.png'), false);
});

test('isSensitivePath: blocks host-executed code and build/deploy config', () => {
  // Editors must never write files a host EXECUTES at the edge or at build time.
  for (const p of ['functions/members/_middleware.js', 'functions/api/x.js', '_worker.js',
    'netlify.toml', 'vercel.json', 'wrangler.toml', 'Dockerfile', 'package.json',
    'package-lock.json', '.gitlab-ci.yml', '.github/workflows/deploy.yaml', 'render.yaml',
    'nested/.circleci.yml', '.npmrc',
    'site/functions/x.js', 'app/_worker.js', '_plugins/hack.rb', '_config.yaml',
    'Gemfile', 'sub/.github.yml'])
    assert.equal(isSensitivePath(p), true, `should block: ${p}`);
  // Ordinary content must still pass.
  for (const p of ['index.html', 'about/index.html', 'assets/uploads/a.webp',
    'assets/files/report.pdf', 'blog/post.html', 'data.json'])
    assert.equal(isSensitivePath(p), false, `should allow: ${p}`);
});

test('normalizePaths: trims, drops blanks, clamps, blank means whole-site', () => {
  assert.deepEqual(normalizePaths('blog, /about.html/'), ['blog', 'about.html']);
  assert.deepEqual(normalizePaths(''), ['']);
  assert.deepEqual(normalizePaths(undefined), ['']);
  assert.deepEqual(normalizePaths(['blog', '', 'pages']), ['blog', 'pages']);
  assert.equal(normalizePaths(Array.from({ length: 80 }, (_, i) => 'p' + i)).length, 50);
});
