import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathInScope, isSensitivePath, normalizePaths, keyInScope, apiPageFilter, apiFieldsFor, apiPageCandidates, validateApiEdits, validateCommentInput, commentKey, normalizePagePath, validateSuggestionInput, suggestWriteViolation, validateAiAssist } from '../worker/index.js';

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

test('normalizePagePath: opaque string, leading slash stripped, empty/traversal/oversize rejected', () => {
  assert.equal(normalizePagePath('/about.html'), 'about.html');
  assert.equal(normalizePagePath('//blog/post.html'), 'blog/post.html');
  assert.equal(normalizePagePath('  /a  '), 'a');
  assert.equal(normalizePagePath('a'.repeat(300)), 'a'.repeat(300));   // at the cap
  assert.equal(normalizePagePath('a'.repeat(301)), null);
  for (const bad of ['', '/', '   ', 'blog/../CNAME', 'a..b', undefined, 42])
    assert.equal(normalizePagePath(bad), null, `should reject: ${bad}`);
});

test('validateCommentInput: normalizes path + text, anchor optional', () => {
  const ok = validateCommentInput({ path: '/pricing.html', text: '  needs a comma  ' });
  assert.deepEqual(ok, { page: 'pricing.html', text: 'needs a comma', anchor: null });
  assert.equal(validateCommentInput({ path: '/p.html', text: 'x'.repeat(4000) }).error, undefined);
  assert.equal(validateCommentInput({ path: '/p.html', text: 'x'.repeat(4001) }).error, 'text too long');
  assert.equal(validateCommentInput({ path: '/p.html', text: '   ' }).error, 'missing text');
  assert.equal(validateCommentInput({ path: '/p.html' }).error, 'missing text');
  assert.equal(validateCommentInput({ path: '', text: 'hi' }).error, 'bad path');
  assert.equal(validateCommentInput({ path: '/a/../b', text: 'hi' }).error, 'bad path');
  assert.equal(validateCommentInput().error, 'bad path');
});

test('validateCommentInput: anchor caps — opaque but bounded', () => {
  const good = { key: 'hero_headline', sel: 'main > h1', x: 0, y: 100, extra: 'kept' };
  assert.deepEqual(validateCommentInput({ path: '/p', text: 'hi', anchor: good }).anchor, good); // stored as sent
  assert.equal(validateCommentInput({ path: '/p', text: 'hi', anchor: null }).anchor, null);
  for (const bad of [
    'sel-as-string', ['array'], 7,                              // not a plain object
    { key: 'k'.repeat(201) },                                   // key over 200
    { sel: 42 },                                                // sel not a string
    { x: -1 }, { y: 101 }, { x: NaN }, { x: '50' },             // x/y outside 0–100 numbers
    { blob: 'x'.repeat(600) },                                  // serialized form over 600
  ])
    assert.equal(validateCommentInput({ path: '/p', text: 'hi', anchor: bad }).error, 'bad anchor',
      `should reject anchor: ${JSON.stringify(bad)}`);
});

test('validateSuggestionInput: normalizes path + note, edits get the API-write checks', () => {
  const ok = validateSuggestionInput({ path: '/about.html', edits: [{ key: 'hero', html: '<b>hi</b>' }], note: '  fix typo  ' }, []);
  assert.deepEqual(ok, { page: 'about.html', edits: [{ key: 'hero', html: '<b>hi</b>' }], note: 'fix typo', branch: null, baseSha: null });
  // A note is optional; absent/null → empty string, oversize → rejected.
  assert.equal(validateSuggestionInput({ path: '/p.html', edits: [{ key: 'k', html: 'x' }] }, []).note, '');
  assert.equal(validateSuggestionInput({ path: '/p.html', edits: [{ key: 'k', html: 'x' }], note: 'n'.repeat(501) }, []).status, 400);
  assert.equal(validateSuggestionInput({ path: '/p.html', edits: [{ key: 'k', html: 'x' }], note: 42 }, []).status, 400);
  // Bad page paths and edit batches short-circuit with the right status.
  assert.equal(validateSuggestionInput({ path: '', edits: [{ key: 'k', html: 'x' }] }, []).status, 400);
  assert.equal(validateSuggestionInput({ path: '/a/../b', edits: [{ key: 'k', html: 'x' }] }, []).status, 400);
  assert.equal(validateSuggestionInput({ path: '/p.html', edits: 'nope' }, []).status, 400);
  assert.equal(validateSuggestionInput({ path: '/p.html' }, []).status, 400);
  // Per-edit rules are validateApiEdits': fragment guard and section-key scope apply.
  assert.equal(validateSuggestionInput({ path: '/p.html', edits: [{ key: 'k', html: '<script>x()</script>' }] }, []).status, 422);
  assert.equal(validateSuggestionInput({ path: '/p.html', edits: [{ key: 'specials', html: 'x' }] }, ['hero']).status, 403);
  assert.equal(validateSuggestionInput({ path: '/p.html', edits: [{ key: 'hero_img', attr: 'src', value: '/a.png' }] }, ['hero']).status, undefined);
});

test('validateSuggestionInput: preview branch must be a kiln scratch branch, baseSha a full sha', () => {
  const withBranch = (branch) => validateSuggestionInput({ path: '/p.html', edits: [{ key: 'k', html: 'x' }], branch }, []);
  assert.equal(withBranch('kiln/suggest-erik').branch, 'kiln/suggest-erik');
  assert.equal(withBranch('kiln-drafts').branch, 'kiln-drafts');
  assert.equal(withBranch(undefined).branch, null);
  assert.equal(withBranch('').branch, null);
  for (const bad of ['main', 'kiln', 'kilnx/main', 'kiln/../main', 'kiln/' + 'b'.repeat(81), 42])
    assert.equal(withBranch(bad).status, 400, `should reject branch: ${bad}`);
  const withSha = (baseSha) => validateSuggestionInput({ path: '/p.html', edits: [{ key: 'k', html: 'x' }], baseSha }, []);
  assert.equal(withSha('a'.repeat(40)).baseSha, 'a'.repeat(40));
  assert.equal(withSha(undefined).baseSha, null);
  for (const bad of ['a'.repeat(39), 'g'.repeat(40), 'HEAD']) assert.equal(withSha(bad).status, 400);
});

test('suggestWriteViolation: PUT /contents may only target kiln branches', () => {
  const put = (body) => suggestWriteViolation('PUT', '/repos/o/r/contents/index.html', body);
  // Absent branch = the repo default; main/master/anything non-kiln = the live site.
  for (const body of [null, {}, { branch: 'main' }, { branch: 'master' }, { branch: 'feature/x' }, { branch: 42 }])
    assert.match(put(body) || '', /suggestions/, `should block: ${JSON.stringify(body)}`);
  assert.equal(put({ branch: 'kiln-drafts' }), null);
  assert.equal(put({ branch: 'kiln/suggest-erik' }), null);
  // Reads stay untouched.
  assert.equal(suggestWriteViolation('GET', '/repos/o/r/contents/index.html', null), null);
});

test('suggestWriteViolation: ref writes — only kiln heads move or appear', () => {
  // PATCH: only kiln/* heads may be advanced (encoded slashes are judged decoded).
  assert.match(suggestWriteViolation('PATCH', '/repos/o/r/git/refs/heads/main', { sha: 'x' }) || '', /suggestions/);
  assert.match(suggestWriteViolation('PATCH', '/repos/o/r/git/refs/heads%2Fmain', { sha: 'x' }) || '', /suggestions/);
  assert.equal(suggestWriteViolation('PATCH', '/repos/o/r/git/refs/heads/kiln-drafts', { sha: 'x' }), null);
  assert.equal(suggestWriteViolation('PATCH', '/repos/o/r/git/refs/heads/kiln%2Fsuggest-erik', { sha: 'x' }), null);
  // POST /git/refs: creating non-kiln heads is blocked; kiln heads and tag refs pass.
  assert.match(suggestWriteViolation('POST', '/repos/o/r/git/refs', { ref: 'refs/heads/main', sha: 'x' }) || '', /suggestions/);
  assert.equal(suggestWriteViolation('POST', '/repos/o/r/git/refs', { ref: 'refs/heads/kiln/suggest-erik', sha: 'x' }), null);
  assert.equal(suggestWriteViolation('POST', '/repos/o/r/git/refs', { ref: 'refs/tags/kiln/1-v', sha: 'x' }), null);
  // Tag moves are left to the existing rules; git-data POSTs are ref-less and pass.
  assert.equal(suggestWriteViolation('PATCH', '/repos/o/r/git/refs/tags/v1', { sha: 'x' }), null);
  assert.equal(suggestWriteViolation('POST', '/repos/o/r/git/commits', { tree: 't' }), null);
});

test('validateAiAssist: text kinds — text required and capped at 8000', () => {
  for (const kind of ['improve', 'shorten']) {
    const ok = validateAiAssist({ kind, text: 'Our <b>famous</b> pies.' });
    assert.deepEqual(ok, { kind, text: 'Our <b>famous</b> pies.', instruction: '' });
  }
  assert.equal(validateAiAssist({ kind: 'improve', text: 'x'.repeat(8000) }).error, undefined);   // at the cap
  assert.equal(validateAiAssist({ kind: 'improve', text: 'x'.repeat(8001) }).error, 'text too long');
  for (const bad of [undefined, '', '   ', 42, ['x']])
    assert.equal(validateAiAssist({ kind: 'improve', text: bad }).error, 'missing text', `should reject text: ${bad}`);
});

test('validateAiAssist: tone/translate/custom need an instruction, capped at 200', () => {
  for (const kind of ['tone', 'translate', 'custom']) {
    assert.equal(validateAiAssist({ kind, text: 'hi' }).error, `${kind} needs an instruction`);
    assert.equal(validateAiAssist({ kind, text: 'hi', instruction: '   ' }).error, `${kind} needs an instruction`);
    assert.equal(validateAiAssist({ kind, text: 'hi', instruction: 42 }).error, `${kind} needs an instruction`);
    assert.deepEqual(validateAiAssist({ kind, text: 'hi', instruction: ' warmer ' }),
      { kind, text: 'hi', instruction: 'warmer' });
    assert.equal(validateAiAssist({ kind, text: 'hi', instruction: 'i'.repeat(201) }).error, 'bad instruction');
  }
  // Improve/shorten take no instruction, but a stray (valid) one is tolerated — oversize still isn't.
  assert.equal(validateAiAssist({ kind: 'improve', text: 'hi', instruction: 'zestier' }).instruction, 'zestier');
  assert.equal(validateAiAssist({ kind: 'improve', text: 'hi', instruction: 'i'.repeat(201) }).error, 'bad instruction');
});

test('validateAiAssist: alt — absolute http(s) imageUrl only, private hosts refused', () => {
  assert.deepEqual(validateAiAssist({ kind: 'alt', imageUrl: 'https://site.com/a.webp' }),
    { kind: 'alt', imageUrl: 'https://site.com/a.webp' });
  assert.equal(validateAiAssist({ kind: 'alt', imageUrl: 'http://site.com/a.png' }).error, undefined);
  for (const bad of [undefined, '', 42, '/assets/a.png', 'not a url', 'x'.repeat(2001)])
    assert.equal(validateAiAssist({ kind: 'alt', imageUrl: bad }).error, 'bad imageUrl', `should reject: ${bad}`);
  for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'ftp://x/a.png'])
    assert.equal(validateAiAssist({ kind: 'alt', imageUrl: bad }).error, 'imageUrl must be http(s)', `should reject: ${bad}`);
  // The worker fetches this URL — loopback / RFC-1918 / link-local metadata stay out of reach.
  for (const host of ['localhost', 'sub.localhost', '127.0.0.1', '0.0.0.0', '[::1]',
    '10.0.0.5', '192.168.1.1', '172.16.0.9', '172.31.255.1', '169.254.169.254'])
    assert.equal(validateAiAssist({ kind: 'alt', imageUrl: `https://${host}/a.png` }).error,
      'imageUrl host not allowed', `should reject host: ${host}`);
  assert.equal(validateAiAssist({ kind: 'alt', imageUrl: 'https://172.32.0.1/a.png' }).error, undefined); // outside 172.16–31
});

test('validateAiAssist: fill — brief + up to 20 keyed fields, hints optional and capped', () => {
  const ok = validateAiAssist({ kind: 'fill', brief: '  A pie shop in Decatur  ', fields: [{ key: 'hero_headline', hint: 'hero headline' }, { key: 'about_body' }] });
  assert.deepEqual(ok, { kind: 'fill', brief: 'A pie shop in Decatur', fields: [{ key: 'hero_headline', hint: 'hero headline' }, { key: 'about_body' }] });
  assert.equal(validateAiAssist({ kind: 'fill', brief: '', fields: [{ key: 'k' }] }).error, 'missing brief');
  assert.equal(validateAiAssist({ kind: 'fill', brief: 'b'.repeat(2001), fields: [{ key: 'k' }] }).error, 'brief too long');
  for (const bad of [undefined, [], 'nope', Array.from({ length: 21 }, (_, i) => ({ key: 'k' + i }))])
    assert.equal(validateAiAssist({ kind: 'fill', brief: 'x', fields: bad }).error, 'bad fields', `should reject fields: ${JSON.stringify(bad)?.slice(0, 40)}`);
  assert.equal(validateAiAssist({ kind: 'fill', brief: 'x', fields: [{ hint: 'no key' }] }).error, 'every field needs a key');
  assert.equal(validateAiAssist({ kind: 'fill', brief: 'x', fields: [{ key: 'k'.repeat(201) }] }).error, 'every field needs a key');
  assert.equal(validateAiAssist({ kind: 'fill', brief: 'x', fields: [{ key: 'a' }, { key: 'a' }] }).error, 'duplicate field key');
  assert.equal(validateAiAssist({ kind: 'fill', brief: 'x', fields: [{ key: 'a', hint: 42 }] }).error, 'bad hint');
  assert.equal(validateAiAssist({ kind: 'fill', brief: 'x', fields: [{ key: 'a', hint: 'h'.repeat(201) }] }).error, 'bad hint');
});

test('validateAiAssist: unknown kinds and junk bodies rejected', () => {
  for (const bad of [{}, { kind: 'summon' }, { kind: 42 }, { kind: 'IMPROVE', text: 'x' }, undefined, null])
    assert.equal(validateAiAssist(bad).error, 'unknown kind', `should reject: ${JSON.stringify(bad)}`);
});

test('commentKey: URI-encoded page keeps `:`-delimited keys unambiguous', () => {
  const key = commentKey('owner/repo', 'blog/a:b c.html', 'abc123def456');
  assert.equal(key, 'cmt:owner/repo:blog%2Fa%3Ab%20c.html:abc123def456');
  // Round-trip: repo and the encoded page contain no raw `:`, so the key always
  // splits into exactly [cmt, repo, page, id].
  const parts = key.split(':');
  assert.equal(parts.length, 4);
  assert.equal(decodeURIComponent(parts[2]), 'blog/a:b c.html');
  assert.equal(parts[3], 'abc123def456');
  // The id-less form is the page's list prefix — and can't bleed into a sibling
  // page that shares a text prefix.
  const prefix = commentKey('owner/repo', 'about', '');
  assert.equal(commentKey('owner/repo', 'about', 'abc123def456').startsWith(prefix), true);
  assert.equal(commentKey('owner/repo', 'about2', 'abc123def456').startsWith(prefix), false);
});
