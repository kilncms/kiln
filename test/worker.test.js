import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathInScope, isSensitivePath, normalizePaths, keyInScope, apiPageFilter, apiFieldsFor, apiPageCandidates, validateApiEdits } from '../worker/index.js';

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

test('keyInScope: empty grants all, otherwise exact or prefix (editor semantics)', () => {
  assert.equal(keyInScope('hero_headline', []), true);
  assert.equal(keyInScope('hero_headline', undefined), true);
  assert.equal(keyInScope('hero_headline', ['hero_headline']), true);
  assert.equal(keyInScope('hero_headline', ['hero']), true);       // prefix
  assert.equal(keyInScope('specials', ['hero']), false);
  assert.equal(keyInScope('hero', ['hero_headline']), false);      // prefix goes one way
});

test('apiPageFilter: html blobs only, excludes templates/functions/sensitive/out-of-scope, caps at 500', () => {
  const tree = [
    { type: 'blob', path: 'index.html' },
    { type: 'blob', path: 'blog/post.html' },
    { type: 'tree', path: 'blog' },                       // not a blob
    { type: 'blob', path: 'style.css' },                  // not html
    { type: 'blob', path: '_templates/post.html' },       // template source
    { type: 'blob', path: 'functions/api/x.html' },       // host-executed dir
    { type: 'blob', path: '.github/pages/x.html' },       // sensitive
    null,
  ];
  assert.deepEqual(apiPageFilter(tree, ['']), ['index.html', 'blog/post.html']);
  assert.deepEqual(apiPageFilter(tree, ['blog']), ['blog/post.html']);
  const big = Array.from({ length: 600 }, (_, i) => ({ type: 'blob', path: `p/${i}.html` }));
  assert.equal(apiPageFilter(big, ['']).length, 500);
});

test('apiFieldsFor: {key: {value, kind}} map, filtered by section keys', () => {
  const raw = '<main><h1 data-cms="hero_headline">Hi</h1>'
    + '<ul data-cms-repeat="cards"><li data-cms="card_title">A</li></ul>'
    + '<img data-cms="hero_img" data-cms-attr="src" src="/a.png"></main>';
  const all = apiFieldsFor(raw, []);
  assert.deepEqual(all.hero_headline, { value: 'Hi', kind: 'field' });
  assert.equal(all.cards.kind, 'repeat');
  assert.equal(all.hero_img.value, null);                 // void tag: no inner html
  assert.deepEqual(Object.keys(apiFieldsFor(raw, ['hero'])), ['hero_headline', 'hero_img']);
});

test('apiPageCandidates: URL-ish paths resolve via pageFileCandidates, scope-filtered', () => {
  assert.deepEqual(apiPageCandidates('/', ['']), { candidates: ['index.html'] });
  assert.deepEqual(apiPageCandidates('/about/', ['']), { candidates: ['about/index.html'] });
  assert.deepEqual(apiPageCandidates('/about', ['']), { candidates: ['about.html', 'about/index.html'] });
  assert.deepEqual(apiPageCandidates('blog/post.html', ['blog']), { candidates: ['blog/post.html'] });
  assert.deepEqual(apiPageCandidates('/about', ['about']), { candidates: ['about/index.html'] }); // about.html out of scope
  assert.deepEqual(apiPageCandidates('/about.html', ['blog']), { error: 403 });
  assert.deepEqual(apiPageCandidates('/blog/../CNAME', ['']), { error: 403 });   // traversal → sensitive → dropped
  assert.deepEqual(apiPageCandidates('/functions/x.html', ['']), { error: 403 }); // sensitive
  assert.deepEqual(apiPageCandidates('/style.css', ['']), { error: 400 });
});

test('validateApiEdits: shape, size, key scope, fragment guard', () => {
  assert.equal(validateApiEdits([{ key: 'hero', html: '<b>hi</b>' }], []), null);
  assert.equal(validateApiEdits([{ key: 'hero_img', attr: 'src', value: '/a.png' }], []), null);
  assert.equal(validateApiEdits('nope', []).status, 400);
  assert.equal(validateApiEdits([], []).status, 400);
  assert.equal(validateApiEdits(Array.from({ length: 501 }, () => ({ key: 'k', html: 'x' })), []).status, 400);
  assert.equal(validateApiEdits([{ html: 'x' }], []).status, 400);                       // no key
  assert.equal(validateApiEdits([{ key: 'k' }], []).status, 400);                        // neither html nor attr
  assert.equal(validateApiEdits([{ key: 'k', html: 'x', attr: 'src', value: 'y' }], []).status, 400); // both
  assert.equal(validateApiEdits([{ key: 'k', attr: 'src' }], []).status, 400);           // attr without value
  assert.equal(validateApiEdits([{ key: 'k', attr: '1 bad', value: 'x' }], []).status, 400);
  // Section scope: a scoped token may only touch its granted keys.
  assert.equal(validateApiEdits([{ key: 'specials', html: 'x' }], ['hero']).status, 403);
  assert.equal(validateApiEdits([{ key: 'hero_headline', html: 'x' }], ['hero']), null);
  // Fragment guard: executable markup is rejected with the offending token.
  const bad = validateApiEdits([{ key: 'k', html: '<img src=x onerror=alert(1)>' }], []);
  assert.equal(bad.status, 422);
  assert.match(bad.detail, /^on:/);
  assert.equal(validateApiEdits([{ key: 'k', html: '<script>x()</script>' }], []).status, 422);
  // attrNameAllowed stays the engine's call: "onclick" is letters-only, so the
  // validator passes it and applyEdits reports it in `skipped` instead.
  assert.equal(validateApiEdits([{ key: 'k', attr: 'onclick', value: 'x' }], []), null);
});
