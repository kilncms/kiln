/**
 * The change for a site Astro builds (src/astro-firstpass.js: changeAstro and
 * checkAstroChange; worker/firstpass.js: planAstroChange): the words that are
 * safe to take move out of a template into a words file Kiln can edit, and
 * each one is left showing in the same place. Plain functions over strings:
 * nothing here needs the database stand-in or the network. What the service
 * answers, and the commit it makes, are in cloud-firstpass.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readAstro, changeAstro, checkAstroChange, wordsPathFor, wordsImportFor, yamlWords } from '../src/astro-firstpass.js';
import { planAstroChange, readWordsFile, astroBeforeSentences, astroAfterSentences, astroReportSentences } from '../worker/firstpass.js';
import { frontmatterRange, readFrontmatterValue } from '../src/adapters/frontmatter.js';
import { parseSourceRef } from '../src/adapters/pointer.js';
import { validateSourceRequest, refuseSourcePath } from '../worker/source.js';
import { isSensitivePath, pathInScope } from '../worker/index.js';

const FIXTURE = readFileSync(new URL('./fixtures/astro-site/src/pages/index.astro', import.meta.url), 'utf8');
const FIXED = 'This sentence is written in src/pages/index.astro itself. It is part of the template, so it cannot be edited on the page.';
const IMPORT = (rel) => `import { frontmatter as kilnWords } from '${rel}';`;
const ATTR = (file, key) => ` data-kiln-source="${file}#/frontmatter/${key}"`;
const chr = (...codes) => String.fromCodePoint(...codes);
const TAB = chr(9), BACKSLASH = chr(92), PARTY = chr(0x1F389), LINE_SEP = chr(0x2028), NO_BREAK = chr(0xA0), NEXT_LINE = chr(0x85), MARK = chr(0xFEFF);

/** A change, with its words read back from the words file the way the service reads front matter. */
function changed(path, text) {
  const c = changeAstro(path, text);
  assert.ok(c.text, `changed: ${JSON.stringify(c).slice(0, 80)}`);
  const words = readWordsFile(c.wordsText, c.pieces.map(p => p.key));
  return { ...c, words };
}
const check = (path, before, after, words) => checkAstroChange({ path, before, after, words });

test('the change: the fixture gives one words file with one key, and its template changes in exactly three places', () => {
  const c = changed('src/pages/index.astro', FIXTURE);
  assert.equal(c.wordsPath, 'src/kiln/pages/index.md');
  assert.equal(c.wordsText, `---\np_1: "${FIXED}"\n---\n`);
  assert.deepEqual(c.pieces, [{ key: 'p_1', tag: 'p', words: FIXED, line: 30 }]);
  assert.equal(c.fenceAdded, false);

  const once = (s, part, to) => { assert.equal(s.split(part).length, 2, `once: ${part.slice(0, 40)}`); return s.replace(part, () => to); };
  let expected = once(FIXTURE, '\n---\n<html lang="en">', `\n${IMPORT('../kiln/pages/index.md')}\n---\n<html lang="en">`);   // the import, last line of the fence
  expected = once(expected, '<p class="fixed">', `<p class="fixed"${ATTR('src/kiln/pages/index.md', 'p_1')}>`);                // the attribute
  expected = once(expected, `${FIXED}</p>`, '{kilnWords.p_1}</p>');                                                           // the words
  assert.equal(c.text, expected);
  const was = FIXTURE.split('\n'), now = c.text.split('\n');
  assert.equal(now.length, was.length + 1);
  assert.deepEqual(now.filter(l => !was.includes(l)), [
    IMPORT('../kiln/pages/index.md'),
    `    <p class="fixed"${ATTR('src/kiln/pages/index.md', 'p_1')}>{kilnWords.p_1}</p>`,
  ]);

  assert.deepEqual(c.words, { p_1: FIXED });
  assert.equal(check('src/pages/index.astro', FIXTURE, c.text, c.words), null);
  // The attribute names the words file and the key the way the editor reads it.
  const ref = parseSourceRef(/data-kiln-source="(src\/kiln[^"]+)"/.exec(c.text)[1]);
  assert.equal(ref.file ?? ref.path, 'src/kiln/pages/index.md');

  // A second press finds nothing safe left in it: the moved words count as marked.
  assert.deepEqual(changeAstro('src/pages/index.astro', c.text), { none: true });
  const again = readAstro(c.text);
  assert.equal(again.safe.length, 0);
  assert.equal(again.left.marked, 5);
});

const TRICKY_WORDS = [
  `It's "quoted" here`,
  `Line one,\n    line two: with a colon # and a hash ${PARTY} and a${TAB}tab and a back${BACKSLASH}slash${BACKSLASH}n`,
  'null',
  '- item: one, [two], > three | four',
  `@handle, %percent, !important, *star and ${BACKSLASH}"`,
  `A no-break${NO_BREAK}space, a line${LINE_SEP}separator and a next${NEXT_LINE}line`,
  `Windows\r\n  line ends`,
  'Yes',
];
const TRICKY = `---\nconst title = 'Words';\n---\n<main>\n  <h2 id="top">${TRICKY_WORDS[0]}</h2>\n  <p>\n    ${TRICKY_WORDS[1]}\n  </p>\n`
  + `  <p>${TRICKY_WORDS[2]}</p>\n  <p class="a"  >${TRICKY_WORDS[3]}</p>\n  <blockquote\n    class="q"\n  >${TRICKY_WORDS[4]}</blockquote>\n`
  + `  <figcaption>${TRICKY_WORDS[5]}</figcaption>\n  <h2>${TRICKY_WORDS[6]}</h2>\n  <p class=plain>${TRICKY_WORDS[7]}</p>\n  <p>{title}</p>\n</main>\n`;

test('the change: words on several lines, with quotes, a backslash, a colon, a #, an emoji and a tab keep every byte through the words file', () => {
  const c = changed('src/pages/words.astro', TRICKY);
  assert.deepEqual(c.pieces.map(p => p.key), ['h2_1', 'p_1', 'p_2', 'p_3', 'blockquote_1', 'figcaption_1', 'h2_2', 'p_4']);
  assert.deepEqual(c.pieces.map(p => p.words), TRICKY_WORDS);

  // The words file: front matter only, one line each, and the service's YAML reader gives back the same words.
  const lines = c.wordsText.split('\n');
  assert.equal(lines.length, TRICKY_WORDS.length + 3);
  assert.equal(lines[0], '---');
  assert.equal(lines[lines.length - 2], '---');
  assert.equal(lines[lines.length - 1], '');
  assert.equal(lines[1], 'h2_1: "It\'s \\"quoted\\" here"');
  assert.match(lines[2], /^p_1: "Line one,\\n    line two: with a colon # and a hash .+ and a\\ttab and a back\\\\slash\\\\n"$/);
  assert.equal(/[^\n\x20-\x7e]/.test(c.wordsText.replace(PARTY, '').replace(NO_BREAK, '')), false, 'nothing else is written but plain characters and escapes');
  const fm = frontmatterRange(c.wordsText);
  assert.equal(fm.format, 'yaml');
  assert.equal(c.wordsText.slice(fm.bodyStart), '', 'nothing below the front matter');
  const yaml = c.wordsText.slice(fm.fmStart, fm.fmEnd);
  c.pieces.forEach((p, i) => assert.equal(readFrontmatterValue('yaml', yaml, [p.key]), TRICKY_WORDS[i], p.key));
  assert.deepEqual(Object.values(c.words), TRICKY_WORDS);

  // The template: nothing else changed, not a space.
  assert.equal(check('src/pages/words.astro', TRICKY, c.text, c.words), null);
  assert.ok(c.text.includes(`<h2 id="top"${ATTR('src/kiln/pages/words.md', 'h2_1')}>{kilnWords.h2_1}</h2>`));
  assert.ok(c.text.includes(`<p${ATTR('src/kiln/pages/words.md', 'p_1')}>\n    {kilnWords.p_1}\n  </p>`));
  assert.ok(c.text.includes(`<p class="a"${ATTR('src/kiln/pages/words.md', 'p_3')}  >{kilnWords.p_3}</p>`), 'after the last attribute');
  assert.ok(c.text.includes(`<blockquote\n    class="q"${ATTR('src/kiln/pages/words.md', 'blockquote_1')}\n  >{kilnWords.blockquote_1}</blockquote>`));
  assert.ok(c.text.includes(`<p class=plain${ATTR('src/kiln/pages/words.md', 'p_4')}>{kilnWords.p_4}</p>`));
  assert.ok(c.text.includes('<p>{title}</p>'), 'a value from code is left as it is');
  assert.deepEqual(changeAstro('src/pages/words.astro', c.text), { none: true });
});

test('the change: every character a YAML string would not take plainly is written as an escape and read back the same', () => {
  let all = '';
  for (let code = 1; code < 0x3000; code++) all += chr(code);
  all += chr(0xD7FF, 0xE000, 0xFEFF, 0xFFFD, 0xFFFE, 0xFFFF, 0x10000, 0x1F389, 0x10FFFF);
  const text = `---\nwords: ${yamlWords(all)}\n---\n`;
  assert.equal(text.split('\n').length, 4, 'on one line');
  assert.deepEqual(readWordsFile(text, ['words']), { words: all });
  // A file that holds anything below the front matter, or a value that is not words, does not read as a words file.
  assert.equal(readWordsFile('---\np_1: "a"\n---\nBody\n', ['p_1']), null);
  assert.equal(readWordsFile('---\np_1: 3\n---\n', ['p_1']), null);
  assert.equal(readWordsFile('---\np_1: "a"\n---\n', ['p_1', 'p_2']), null);
});

test('the change: a template with no code fence gets one at the top, and the check still holds', () => {
  const plain = '<html>\n<body>\n  <h1>Hello there</h1>\n  <p>Welcome to the club.</p>\n</body>\n</html>\n';
  const c = changed('src/pages/about.astro', plain);
  assert.equal(c.fenceAdded, true);
  assert.equal(c.text, `---\n${IMPORT('../kiln/pages/about.md')}\n---\n<html>\n<body>\n  <h1${ATTR('src/kiln/pages/about.md', 'h1_1')}>{kilnWords.h1_1}</h1>\n  <p${ATTR('src/kiln/pages/about.md', 'p_1')}>{kilnWords.p_1}</p>\n</body>\n</html>\n`);
  assert.equal(check('src/pages/about.astro', plain, c.text, c.words), null);

  // Windows line ends and a byte-order mark stay, and the added lines end the way the file's lines do.
  const windows = `${MARK}<h1>Hello there</h1>\r\n<p>Welcome\r\n  to the club.</p>\r\n`;
  const w = changed('src/pages/about.astro', windows);
  assert.ok(w.text.startsWith(`${MARK}---\r\n${IMPORT('../kiln/pages/about.md')}\r\n---\r\n<h1 data-kiln-source=`));
  assert.equal(w.words.p_1, 'Welcome\r\n  to the club.');
  assert.equal(check('src/pages/about.astro', windows, w.text, w.words), null);

  const fenced = '---\r\nconst a = 1;\r\n---\r\n<p>Welcome</p>\r\n';
  const f = changed('src/pages/about.astro', fenced);
  assert.equal(f.text, `---\r\nconst a = 1;\r\n${IMPORT('../kiln/pages/about.md')}\r\n---\r\n<p${ATTR('src/kiln/pages/about.md', 'p_1')}>{kilnWords.p_1}</p>\r\n`);
  assert.equal(check('src/pages/about.astro', fenced, f.text, f.words), null);

  // An empty fence, and one whose closing line is set in.
  for (const text of ['---\n---\n<p>Welcome</p>\n', '---\nconst a = 1\n  ---\n<p>Welcome</p>\n']) {
    const e = changed('src/pages/about.astro', text);
    assert.equal(e.fenceAdded, false);
    assert.equal(check('src/pages/about.astro', text, e.text, e.words), null);
    assert.match(e.text, /\nimport \{ frontmatter as kilnWords \} from '\.\.\/kiln\/pages\/about\.md';\n[ ]*---\n/);
  }
});

test('the change: the words file sits under src/kiln at the template\'s own path, and the import reaches it from any folder', () => {
  const cases = [
    ['src/pages/index.astro', 'src/kiln/pages/index.md', '../kiln/pages/index.md'],
    ['src/pages/blog/post.astro', 'src/kiln/pages/blog/post.md', '../../kiln/pages/blog/post.md'],
    ['src/components/ui/cards/Card.astro', 'src/kiln/components/ui/cards/Card.md', '../../../kiln/components/ui/cards/Card.md'],
    ['src/Top.astro', 'src/kiln/Top.md', './kiln/Top.md'],
    ['src/pages/[...slug].astro', 'src/kiln/pages/[...slug].md', '../kiln/pages/[...slug].md'],
  ];
  for (const [template, file, rel] of cases) {
    assert.equal(wordsPathFor(template), file);
    assert.equal(wordsImportFor(template), rel);
    const c = changed(template, '<p>Welcome</p>\n');
    assert.equal(c.wordsPath, file);
    assert.ok(c.text.includes(IMPORT(rel)), template);
    assert.ok(c.text.includes(ATTR(file, 'p_1')), template);
    assert.equal(check(template, '<p>Welcome</p>\n', c.text, c.words), null);
  }
  // A path that could not stand in a quoted import or before a `#`, and anything that is not a template under src/.
  for (const odd of ["src/pages/it's.astro", 'src/pages/a b.astro', 'src/pages/a#b.astro', 'src/pages/a"b.astro', 'pages/index.astro', 'src/pages/index.md', 'src/../x.astro', 'astro.config.mjs', 'src/content.config.ts']) {
    assert.equal(wordsPathFor(odd), null, odd);
    assert.equal(wordsImportFor(odd), null, odd);
  }
  assert.deepEqual(changeAstro("src/pages/it's.astro", '<p>Welcome</p>'), { left: 'path' });
});

test('the change: a template that uses the name kilnWords, one whose words file is there, and one the reader cannot follow are left alone and named, and the rest is done', () => {
  const files = [
    { path: 'src/pages/broken.astro', mode: '100644', text: '<p>Words</p>\n<p>{{{' },
    { path: 'src/pages/huge.astro', mode: '100644', text: undefined },               // too large, or not text: it was not read
    { path: 'src/pages/named.astro', mode: '100644', text: '---\nconst kilnWords = 1;\n---\n<p>Words</p>\n' },
    { path: 'src/pages/once.astro', mode: '100644', text: '<p>Words</p>\n' },
    { path: 'src/pages/Twice.astro', mode: '100644', text: '<p>Words</p>\n' },
    { path: 'src/pages/code.astro', mode: '100644', text: '---\nconst t = 1;\n---\n<p>{t}</p>\n' },   // nothing safe: not changed, not named
    { path: 'src/layouts/Base.astro', mode: '100755', text: '---\nconst { title } = Astro.props;\n---\n<h1>{title}</h1>\n<p>Made by hand.</p>\n<slot />\n' },
    { path: 'src/pages/blog/post.astro', mode: '100644', text: '<h2>A post</h2>\n<p>First</p>\n<p>Second</p>\n' },
  ];
  const paths = [...files.map(f => f.path), 'astro.config.mjs', 'src/content/site/home.md', 'src/kiln/pages/once.md', 'src/kiln/pages/twice.md/readme.txt'];
  const plan = planAstroChange(files, paths);
  assert.deepEqual(plan.astro, {
    pieces: 4, files: 2,
    left: [
      { path: 'src/pages/Twice.astro', why: 'words_file' },     // a folder of that name is there, in other capitals
      { path: 'src/pages/broken.astro', why: 'unread' },
      { path: 'src/pages/huge.astro', why: 'unread' },
      { path: 'src/pages/named.astro', why: 'name' },
      { path: 'src/pages/once.astro', why: 'words_file' },
    ],
  });
  assert.deepEqual(plan.changes.map(c => [c.path, c.mode]), [
    ['src/layouts/Base.astro', '100755'], ['src/kiln/layouts/Base.md', '100644'],
    ['src/pages/blog/post.astro', '100644'], ['src/kiln/pages/blog/post.md', '100644'],
  ]);
  assert.equal(plan.changes[1].text, '---\np_1: "Made by hand."\n---\n');
  assert.equal(plan.changes[3].text, '---\nh2_1: "A post"\np_1: "First"\np_2: "Second"\n---\n');
  assert.ok(plan.changes[2].text.startsWith(`---\n${IMPORT('../../kiln/pages/blog/post.md')}\n---\n<h2`));
  // Only templates and their words files are ever written.
  assert.ok(plan.changes.every(c => /^src\/(?!kiln\/).+\.astro$/.test(c.path) || /^src\/kiln\/.+\.md$/.test(c.path)));

  // A file where one of the words file's folders would have to be.
  assert.deepEqual(planAstroChange([files[3]], ['src/kiln']).astro.left, [{ path: 'src/pages/once.astro', why: 'words_file' }]);
  assert.deepEqual(planAstroChange([files[3]], ['src/kiln/pages']).astro.left, [{ path: 'src/pages/once.astro', why: 'words_file' }]);
  // A site where everything safe is done: nothing to change, nobody named.
  const done = plan.changes.filter(c => c.path.endsWith('.astro'));
  assert.deepEqual(planAstroChange(done, [...paths, ...plan.changes.map(c => c.path)]), { changes: [], astro: { pieces: 0, files: 0, left: [] } });
});

test('the check: a sound change passes, and each of these broken ones is caught', () => {
  const path = 'src/pages/club.astro';
  const before = '---\nconst show = true;\n---\n<main>\n  <h1 class="big">The club</h1>\n  <p>\n    We meet on\n    Tuesdays.\n  </p>\n  <p>Come along.</p>\n  {show && <p>Only sometimes</p>}\n</main>\n';
  const good = changed(path, before);
  const file = 'src/kiln/pages/club.md';
  assert.deepEqual(good.words, { h1_1: 'The club', p_1: 'We meet on\n    Tuesdays.', p_2: 'Come along.' });
  assert.equal(check(path, before, good.text, good.words), null);
  const swap = (s, a, b) => { assert.ok(s.includes(a), a); return s.replace(a, () => b); };

  // 1. The words were tidied on their way into the words file: put back, the template is not what it was.
  assert.equal(check(path, before, good.text, { ...good.words, p_1: 'We meet on Tuesdays.' }), 'differs');
  // 2. Two attributes changed places: each element would save to the other's words.
  const crossed = swap(swap(swap(good.text, ATTR(file, 'p_1'), '@@'), ATTR(file, 'p_2'), ATTR(file, 'p_1')), '@@', ATTR(file, 'p_2'));
  assert.equal(check(path, before, crossed, good.words), 'place');
  // 3. The import line is missing, is there twice, or is not in the code fence.
  assert.equal(check(path, before, swap(good.text, `${IMPORT('../kiln/pages/club.md')}\n`, ''), good.words), 'import');
  assert.equal(check(path, before, swap(good.text, `${IMPORT('../kiln/pages/club.md')}\n`, `${IMPORT('../kiln/pages/club.md')}\n`.repeat(2)), good.words), 'import');
  assert.equal(check(path, before, swap(swap(good.text, `${IMPORT('../kiln/pages/club.md')}\n`, ''), '<main>\n', `<main>\n${IMPORT('../kiln/pages/club.md')}\n`), good.words), 'import');
  assert.equal(check(path, before, swap(good.text, "'../kiln/pages/club.md'", "'../kiln/pages/other.md'"), good.words), 'import');
  // 4. Something else in the file changed: one space, far from any piece.
  assert.equal(check(path, before, swap(good.text, 'const show = true;', 'const show =true;'), good.words), 'differs');
  assert.equal(check(path, before, swap(good.text, '<h1 class="big"', '<h1 class="large"'), good.words), 'differs');
  // 5. A piece was moved that the reader did not call safe (it shows only sometimes): put back it is the same file, but the counts have moved.
  const loop = swap(good.text, '<p>Only sometimes</p>', `<p${ATTR(file, 'p_3')}>{kilnWords.p_3}</p>`);
  assert.equal(check(path, before, loop, { ...good.words, p_3: 'Only sometimes' }), 'counts');
  // 6. An attribute is missing, or names another file.
  assert.equal(check(path, before, swap(good.text, ATTR(file, 'p_2'), ''), good.words), 'attribute');
  assert.equal(check(path, before, swap(good.text, ATTR(file, 'p_2'), ATTR('src/kiln/pages/other.md', 'p_2')), good.words), 'attribute');
  // 7. A value is shown twice, or not at all.
  assert.equal(check(path, before, swap(good.text, '</main>', '{kilnWords.p_2}</main>'), good.words), 'value');
  assert.equal(check(path, before, swap(good.text, '{kilnWords.p_2}', 'Come along.'), good.words), 'value');
  // 8. The attribute is on the element around the one that shows the value.
  const outer = swap(swap(good.text, ATTR(file, 'h1_1'), ''), '<main>', `<main${ATTR(file, 'h1_1')}>`);
  assert.equal(check(path, before, outer, good.words), 'place');
  // 9. Words that would be code in a template, and no words at all.
  assert.equal(check(path, before, good.text, { ...good.words, p_2: 'Come {along}.' }), 'words');
  assert.equal(check(path, before, good.text, {}), 'words');
  assert.equal(check(path, before, good.text, { ...good.words, p_2: 7 }), 'words');
  // 10. A piece the words file does not hold (its value is still in the template).
  const { p_2: dropped, ...fewer } = good.words;
  assert.equal(dropped, 'Come along.');
  assert.equal(check(path, before, good.text, fewer), 'value');
  // The check never throws, whatever it is handed.
  assert.equal(check(path, before, undefined, good.words), 'unread');
  assert.equal(check("src/pages/it's.astro", before, good.text, good.words), 'unread');
});

test('the change: what the owner reads before and after, word for word', () => {
  const COUNTS = 'This counts the text written in your page templates. A line inside a list that repeats counts once here, however many times it shows on the site.';
  const plan = (pieces, files, safe, total, left = [], unread = []) => ({ astro: { pieces, files, left }, report: { safe, total, unread } });
  assert.deepEqual(astroBeforeSentences(plan(189, 11, 189, 345)), [
    'Kiln will move 189 pieces of text out of 11 template files into files it can edit, and leave each one showing in the same place. Your pages will look the same. Press Mark them to make this change.',
    'The other 156 come from your content files or from code, or mix words with a value, and a developer marks those with one line each.',
    COUNTS,
  ]);
  assert.deepEqual(astroBeforeSentences(plan(1, 1, 1, 2, [], ['a.astro'])), [
    'Kiln will move 1 piece of text out of 1 template file into a file it can edit, and leave it showing in the same place. Your pages will look the same. Press Mark them to make this change.',
    'The other one comes from your content files or from code, or mixes words with a value, and a developer marks it with one line.',
    COUNTS,
    'Kiln could not read 1 of the template files, so they are not counted.',
  ]);
  assert.deepEqual(astroBeforeSentences(plan(3, 1, 3, 3)), [
    'Kiln will move 3 pieces of text out of 1 template file into a file it can edit, and leave each one showing in the same place. Your pages will look the same. Press Mark them to make this change.',
    COUNTS,
  ]);
  // The report's own sentence, when the rest is one.
  assert.deepEqual(astroReportSentences({ safe: 4, total: 5, unread: [] }), [
    'Kiln can make 4 of 5 headings and paragraphs on this site\'s templates editable by itself. The other one comes from your content files or from code, or mixes words with a value, and a developer marks it with one line.',
    COUNTS,
  ]);

  assert.deepEqual(astroAfterSentences(plan(189, 11, 189, 345)), [
    '189 pieces of text can now be edited. Your site is building again. When it is done, open a page, sign in and click any of them.',
  ]);
  assert.deepEqual(astroAfterSentences(plan(1, 1, 1, 2, [{ path: 'src/pages/a.astro', why: 'name' }])), [
    '1 piece of text can now be edited. Your site is building again. When it is done, open a page, sign in and click it.',
    'Kiln left 1 template file as it was, because it could not be sure the change was safe there.',
  ]);
  assert.deepEqual(astroAfterSentences(plan(7, 2, 9, 9, [{ path: 'a', why: 'name' }, { path: 'b', why: 'unread' }, { path: 'c', why: 'words_file' }])), [
    '7 pieces of text can now be edited. Your site is building again. When it is done, open a page, sign in and click any of them.',
    'Kiln left 3 template files as they were, because it could not be sure the change was safe there.',
  ]);
});

test('the change: afterwards the editor may save to the words file, and a save to the template is still refused', () => {
  const deps = { isSensitivePath, pathInScope };
  const editor = { name: 'Sam', email: 's@x.com', paths: [''], keys: [], mode: null, admin: false };
  const save = (file, actor = editor) => validateSourceRequest({ adapter: 'astro', file, edits: [{ pointer: '/frontmatter/p_1', value: 'New words', type: 'string' }], actor }, deps);

  // What the page carries: data-kiln-source="src/kiln/pages/index.md#/frontmatter/p_1".
  const c = changed('src/pages/index.astro', FIXTURE);
  const ref = /data-kiln-source="(src\/kiln\/[^"#]+)#(\/frontmatter\/p_1)"/.exec(c.text);
  assert.deepEqual([ref[1], ref[2]], ['src/kiln/pages/index.md', '/frontmatter/p_1']);
  const ok = save(ref[1]);
  assert.equal(ok.error, undefined);
  assert.equal(ok.file, 'src/kiln/pages/index.md');
  assert.equal(ok.adapter.id, 'astro');
  assert.deepEqual(ok.cleanEdits, [{ pointer: '/frontmatter/p_1', value: 'New words', type: 'string', key: '/frontmatter/p_1' }]);
  assert.deepEqual(refuseSourcePath('src/kiln/pages/blog/[...slug].md', editor, deps, { anyEditable: true }), { file: 'src/kiln/pages/blog/[...slug].md' });

  // The template itself, Astro's settings and code are refused, for an admin too.
  const admin = { name: 'admin', admin: true };
  for (const actor of [editor, admin]) {
    assert.deepEqual(save('src/pages/index.astro', actor), { status: 400, error: 'file type not editable by this adapter' });
    assert.equal(refuseSourcePath('src/pages/index.astro', actor, deps, { anyEditable: true }).status, 400);
    assert.equal(save('astro.config.mjs', actor).status, 403);
    assert.equal(save('src/content.config.ts', actor).status, 403);
    assert.equal(save('src/kiln/pages/index.mjs', actor).status, 403);
  }
  // An editor kept to one folder cannot reach the words files from outside it.
  assert.equal(save('src/kiln/pages/index.md', { ...editor, paths: ['src/content/'] }).status, 403);
});
