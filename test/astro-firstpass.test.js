/**
 * The reader for a site Astro builds (src/astro-firstpass.js): which text
 * elements of an .astro template hold words only, so that a first pass could
 * take them, where exactly each one is, and why every other one is left. It
 * reads and counts; nothing here writes a file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readAstro, tallyAstro, TEXT_TAGS } from '../src/astro-firstpass.js';

const NONE = { mixed: 0, fromCode: 0, withTags: 0, inLoop: 0, marked: 0 };
const words = (text) => readAstro(text).safe.map(s => s.words);
/** The file is read, `safe` of its text elements are safe, and the rest are left as `left` says. */
function counts(text, safe, left = {}, more = null) {
  const r = readAstro(text);
  assert.notEqual(r.unread, true, `read: ${JSON.stringify(text.slice(0, 80))}`);
  assert.equal(r.safe.length, safe, `safe in ${JSON.stringify(text.slice(0, 80))}: ${JSON.stringify(r)}`);
  assert.deepEqual(r.left, { ...NONE, ...left }, JSON.stringify(text.slice(0, 80)));
  assert.equal(r.total, safe + Object.values(r.left).reduce((a, b) => a + b, 0));
  if (more) for (const [k, v] of Object.entries(more)) assert.equal(r.more[k], v, `more.${k} in ${JSON.stringify(text.slice(0, 80))}`);
  return r;
}
/** Every safe element's numbers cut what they say out of the text. */
function placed(text) {
  const r = readAstro(text);
  for (const s of r.safe) {
    assert.equal(text.slice(s.innerStart, s.innerEnd), s.words);
    assert.equal(s.words, s.words.trim());
    assert.ok(text.startsWith(`<${s.tag}`, s.start), 'start is the < of the opening tag');
    assert.equal(text[s.openEnd - 1], '>');
    assert.ok(/^<\/[a-z0-9]+\s*>$/.test(text.slice(text.lastIndexOf('</', s.end - 1), s.end)), 'end is after the closing tag');
    assert.equal(text.slice(s.openEnd, text.lastIndexOf('</', s.end - 1)).trim(), s.words, 'nothing but the words and space is inside');
    assert.equal(s.line, text.slice(0, s.start).split('\n').length);
  }
  return r;
}

test('astro reader: it looks at the same tags as the first pass for a plain site', () => {
  const m = /const FIELD_TAGS = new Set\(\[([^\]]+)\]\)/.exec(readFileSync(new URL('../src/autotag.js', import.meta.url), 'utf8'));
  assert.ok(m, 'FIELD_TAGS is still where it was in src/autotag.js');
  assert.deepEqual(TEXT_TAGS, m[1].split(',').map(s => s.trim().replace(/'/g, '')));
});

test('astro reader: words written in one of the text tags are safe, in any of the tags and no other', () => {
  for (const tag of TEXT_TAGS) assert.deepEqual(words(`<${tag}>Some words</${tag}>`), ['Some words'], tag);
  counts('<div>Words</div><li>Words</li><span>Words</span><a href="/">Words</a><button>Words</button><td>Words</td>', 0);
  // A tag with a capital letter, a dot or a colon is a component, whatever its name spells.
  counts('<P>Words</P><Text.p>Words</Text.p><x:p>Words</x:p>', 0);
});

test('astro reader: text inside { } is left as in a loop or a condition', () => {
  counts('<p>Outside</p>', 1);
  counts('{show && <p>Only sometimes</p>}', 0, { inLoop: 1 });
  counts('{items.map((item) => (\n  <article>\n    <h3>Fixed heading</h3>\n    <p>{item.text}</p>\n  </article>\n))}', 0, { inLoop: 1, fromCode: 1 });
  counts('{ok ? <p>One way</p> : <p>The other way</p>}', 0, { inLoop: 2 });
  // Once the { } is over, the template goes on.
  assert.deepEqual(words('<ul>{items.map((i) => <li>{i}</li>)}</ul>\n<p>After the list</p>'), ['After the list']);
});

test('astro reader: content that is not words only is left under the reason that fits', () => {
  counts('<p>Plain words, with "quotes" and an apostrophe\'s mark.</p>', 1);
  counts('<p>Hello {name}</p>', 0, { mixed: 1 });
  counts('<p>Posted on {date} by <b>{author}</b></p>', 0, { mixed: 1 });
  counts('<h1>{title}</h1>', 0, { fromCode: 1 });
  counts('<p>\n  {entry.data.intro}\n</p>', 0, { fromCode: 1 });
  counts('<p>{first} {last}</p>', 0, { fromCode: 1 });
  counts('<p><Content /></p><p><slot /></p>', 0, { fromCode: 2 });
  counts('<p>Hello <b>there</b></p>', 0, { withTags: 1 });
  counts('<p>Read <a href={url}>the guide</a></p>', 0, { withTags: 1 });
  counts('<p><Icon name="pin" /> Find us</p>', 0, { withTags: 1 });
  counts('<p>Words <!-- a note --></p>', 0, { withTags: 1 });
  counts('<p>Fish &amp; chips</p>', 0, { withTags: 1 });
  counts('<p>&copy; 2024</p>', 0, { withTags: 1 });
  counts('<p>Fish & chips</p>', 0, { withTags: 1 });
  counts('<p>one < two</p>', 0, { withTags: 1 });
});

test('astro reader: an element whose attributes hold code, or that has set:html or set:text, is left', () => {
  counts('<p class="lead" id=intro data-x=\'1\' hidden>Words</p>', 1);
  // Braces inside a quoted value are part of the value, not code.
  counts('<p x-data="{ open: false }" title="a > b">Words</p>', 1);
  counts('<p class={cls}>Words</p>', 0, { mixed: 1 }, { attrValue: 1 });
  counts('<p {...props}>Words</p>', 0, { mixed: 1 }, { attrValue: 1 });
  counts('<p {id}>Words</p>', 0, { mixed: 1 }, { attrValue: 1 });
  counts('<p class:list={["a", { b: on }]}>Words</p>', 0, { mixed: 1 }, { attrValue: 1 });
  counts('<p class=`lead ${size}`>Words</p>', 0, { mixed: 1 }, { attrValue: 1 });
  counts('<p set:html={html} />', 0, { fromCode: 1 });
  counts('<p set:text={text}></p>', 0, { fromCode: 1 });
  counts('<p set:html="<b>fixed</b>">Words</p>', 0, { fromCode: 1 });
});

test('astro reader: what is already marked, or sits inside something marked, is left as marked', () => {
  counts('<p data-cms="intro">Words</p>', 0, { marked: 1 });
  counts('<p data-kiln-source="src/content/site/home.md#/frontmatter/intro">Words</p>', 0, { marked: 1 });
  counts('<h1 {...kilnSource(home, \'heading\')}>{home.data.heading}</h1>', 0, { marked: 1 });
  counts('<h3 {...kilnEntry(post)}>Words</h3>', 0, { marked: 1 });
  counts('<div {...kilnBody(entry)}><p>First</p><p>Second</p></div>', 0, { marked: 2 });
  counts('<div data-cms="body"><p>First</p></div><p>Outside it</p>', 1, { marked: 1 });
  // An entry's own mark says which file a list item is; the text inside it is not editable by that.
  counts('<li {...kilnEntry(post)}><p>Words</p></li>', 1);
  // A spread of something else is code in an attribute, not a mark.
  counts('<p {...attrs}>Words</p>', 0, { mixed: 1 });
});

test('astro reader: only the template is read, not the code fence, the head, scripts, styles or comments', () => {
  counts('---\nconst a = "<p>Not the template</p>";\nconst b = `<h1>Nor this</h1>`;\n// <p>nor this</p>\n---\n<p>The template</p>', 1);
  counts('<html><head><title>Title</title><p>In the head</p></head><body><p>In the body</p></body></html>', 1);
  counts('<script>const a = "<p>no</p>"; if (a) { b = "</p>"; }</script>\n<p>After the script</p>', 1);
  counts('<script is:inline define:vars={{ a: 1 }}>document.write("<h1>no</h1>")</script><p>After</p>', 1);
  counts('<style>p { color: red } /* <p>no</p> */</style>\n<p>After the style</p>', 1);
  counts('<!-- <p>Old words</p> -->\n<p>New words</p>', 1);
  counts('{/* <p>Old words</p> */}\n<p>New words</p>', 1);
  counts('<!doctype html>\n<p>Words</p>', 1);
  // A script that closes itself has no body: what follows it is the template.
  assert.deepEqual(words('<script type="application/ld+json" set:html={JSON.stringify({ "@type": "Thing", a: { b: 1 } })} />\n<h1>After it</h1>\n<script>let x = 1;</script>'), ['After it']);
});

test('astro reader: text in a component\'s slot or in a fragment counts when its own tag is plain', () => {
  counts('<Layout title="Home">\n  <h1>Inside a slot</h1>\n  <Card.Body><p>Deeper</p></Card.Body>\n</Layout>', 2);
  counts('<><p>In a fragment</p></>', 1);
  counts('<Fragment slot="aside"><p>In a named slot</p></Fragment>', 1);
  counts('<Card {...kilnBody(entry)}><p>Words</p></Card>', 0, { marked: 1 });
});

test('astro reader: an element with no letter in it, or that holds other text elements, is not counted', () => {
  counts('<p></p><p>   </p><p>2024</p><p>&nbsp;</p><p><img src="a.png"></p><p><br /></p><p />', 0, {}, { noWords: 7 });
  const r = counts('<blockquote>\n  <p>Quoted words</p>\n  <p>More of them</p>\n</blockquote>', 2, {}, { holdsText: 1 });
  assert.deepEqual(r.safe.map(s => s.tag), ['p', 'p']);
  counts('<figure><img src="a.png" alt=""><figcaption>Words under it</figcaption></figure>', 1);
});

test('astro reader: the numbers cut exactly the words out of the text', () => {
  const text = [
    '---',
    'import Layout from "../layouts/Layout.astro";',
    'const { title } = Astro.props;',
    '---',
    '<Layout>',
    '  <h1 class="big">A heading</h1>',
    '  <p>',
    '    A paragraph that runs',
    '    over two lines.',
    '  </p>',
    '  <p>{title}</p>',
    '  <figcaption >Tight</figcaption >',
    '</Layout>',
    '',
  ].join('\n');
  const r = placed(text);
  assert.deepEqual(r.safe.map(s => [s.tag, s.line, s.words]), [
    ['h1', 6, 'A heading'],
    ['p', 7, 'A paragraph that runs\n    over two lines.'],
    ['figcaption', 12, 'Tight'],
  ]);
  assert.equal(text.slice(r.safe[0].start, r.safe[0].end), '<h1 class="big">A heading</h1>');
  assert.equal(text.slice(r.safe[2].start, r.safe[2].end), '<figcaption >Tight</figcaption >');
  // Put a value in place of each one's words, last first, and nothing else moves.
  let out = text;
  [...r.safe].reverse().forEach((s, i) => { out = `${out.slice(0, s.innerStart)}{w.t${r.safe.length - i}}${out.slice(s.innerEnd)}`; });
  assert.equal(out, text.replace('A heading', '{w.t1}').replace('A paragraph that runs\n    over two lines.', '{w.t2}').replace('Tight', '{w.t3}'));
});

test('astro reader: code inside { } and inside attributes is stepped over, whatever it holds', () => {
  // Nested braces, a string holding } and one holding <, a comparison, a comment holding a quote.
  const text = [
    '<ul>',
    '  {items.filter((i) => { return i.label !== "}" && i.n < 3; }).map((i) => {',
    '    /* don\'t count } this */',
    '    const mark = \'<p>Not an element</p>\';   // nor } this',
    '    return <li class={i.on ? "on" : "off"}>{i.label}</li>;',
    '  })}',
    '</ul>',
    '<p>After all of it</p>',
  ].join('\n');
  assert.deepEqual(placed(text).safe.map(s => s.words), ['After all of it']);
  counts(text, 1);
  // A string that holds a tag is not a tag.
  counts('{show ? "<p>Not this</p>" : \'<h1>Nor this</h1>\'}<p>This</p>', 1);
  counts('{`<p>${a ? `<b>${b}</b>` : "}"}</p>`}<p>This</p>', 1);
  // Attributes: a quoted > and }, an object, a template string with ${ } in it, an arrow function.
  counts('<a title="a > b }" data-x={fn({ a: "}", b: [1, 2] })} href={`/to/${slug}?q=${a > b ? "}" : ">"}`} onclick={() => { go(); }}>x</a>\n<p>After the link</p>', 1);
  counts('<div class={`card ${open ? "is-open" : ""}`}>\n  <p>Inside the card</p>\n</div>', 1);
  counts('<Chart data={{ rows: [{ a: 1 }], label: "<p>no</p>" }} />\n<p>Under the chart</p>', 1);
});

test('astro reader: tags that close themselves, tags that need no closing, and a tag left unclosed', () => {
  counts('<br /><img src="a.png" /><Icon /><div /><input><hr>\n<p>After them</p>', 1);
  counts('<p>Line one<br>line two</p>', 0, { withTags: 1 });
  counts('<br></br><p>After a closed break</p>', 1);
  // The paragraph is never closed: where its words end cannot be told, so it is not counted.
  const r = counts('<div>\n  <p>Never closed\n  <div>Inside</div>\n</div>\n<p>Closed properly</p>', 1, {}, { unclosed: 1 });
  assert.deepEqual(r.safe.map(s => s.words), ['Closed properly']);
  counts('<ul><li>One<li>Two</ul><p>After the list</p>', 1);
  counts('<html><body><p>Words</p>', 1);
  counts('<main><h2>Left open', 0, {}, { unclosed: 1 });
});

test('astro reader: a file with no code fence, with Windows line ends, or with a byte-order mark', () => {
  assert.deepEqual(placed('<h1>No fence here</h1>\n<p>Just a template.</p>\n').safe.map(s => s.words), ['No fence here', 'Just a template.']);
  const win = '---\r\nconst a = 1;\r\n---\r\n<main>\r\n  <h1>Windows</h1>\r\n  <p>\r\n    Two\r\n    lines\r\n  </p>\r\n</main>\r\n';
  assert.deepEqual(placed(win).safe.map(s => [s.line, s.words]), [[5, 'Windows'], [6, 'Two\r\n    lines']]);
  const bom = '﻿---\nconst a = "<p>no</p>";\n---\n<p>After a mark</p>\n';
  assert.deepEqual(placed(bom).safe.map(s => s.words), ['After a mark']);
  assert.equal(bom.slice(readAstro(bom).safe[0].start).startsWith('<p>After'), true);
  // An empty fence, and space before the fence.
  assert.deepEqual(words('---\n---\n<h1>Hi</h1>'), ['Hi']);
  assert.deepEqual(words('\n\n---\nconst a = 1\n---\n<h1>Hi</h1>'), ['Hi']);
});

test('astro reader: a file it cannot follow answers unread, and nothing throws', () => {
  const garbage = [
    '---\nconst a = `never closed; <p>{{{',            // a fence with no end
    '---\nconst md = `\n---\n`;\n---\n<p>Words</p>',     // a --- line inside a string: the two ways of finding the end disagree
    '<div><p>{{ </p>',                                   // a { that never closes
    '</p>}}}',                                           // a closing tag with nothing open
    '<p>Words</p> } <p>More</p>',                        // a } that closes nothing
    '{show && </div>}',                                  // a closing tag straight inside { }
    '<div>{show && <p>Words</div>}',                     // a close that would reach out of its { }
    '<p class="never closed',                            // a tag with no end
    '<p class={fn(</p>',                                 // code in an attribute with no end
    '<p>Words</p></section>',                            // a closing tag that matches nothing
    '<pre is:raw>{ not code }</pre><p>Words</p>',        // is:raw is not followed
    '<script>never closed',
    '\u0000\u0001<<<{{{>>>`${',
    '{`${'.repeat(50000),
    '<a '.repeat(3) + '{'.repeat(200000),
  ];
  for (const g of garbage) assert.deepEqual(readAstro(g), { unread: true }, JSON.stringify(g.slice(0, 40)));
  for (const g of [undefined, null, 7, {}, [], Buffer.from('<p>x</p>')]) assert.deepEqual(readAstro(g), { unread: true });
  // Plain text with no element in it is read: it holds nothing.
  assert.deepEqual(readAstro('just some words'), { safe: [], left: NONE, total: 0, more: { unclosed: 0, noWords: 0, holdsText: 0, attrValue: 0 } });
  assert.deepEqual(readAstro(''), { safe: [], left: NONE, total: 0, more: { unclosed: 0, noWords: 0, holdsText: 0, attrValue: 0 } });
});

test('astro reader: the fixture site\'s page has five text elements, one safe and four already marked', () => {
  const text = readFileSync(new URL('./fixtures/astro-site/src/pages/index.astro', import.meta.url), 'utf8');
  const r = placed(text);
  assert.equal(r.total, 5);
  assert.deepEqual(r.left, { ...NONE, marked: 4 });
  assert.deepEqual(r.safe.map(s => [s.tag, s.line, s.words]), [
    ['p', 30, 'This sentence is written in src/pages/index.astro itself. It is part of the template, so it cannot be edited on the page.'],
  ]);
  assert.equal(text.slice(r.safe[0].start, r.safe[0].openEnd), '<p class="fixed">');
});

test('astro reader: the numbers over many files, with the unread ones named and the richest file first', () => {
  const t = tallyAstro([
    { path: 'src/pages/b.astro', text: '<h1>One</h1><p>{x}</p>' },
    { path: 'src/pages/a.astro', text: '<h1>One</h1><p>Two</p><p>Three <b>bold</b></p>' },
    { path: 'src/layouts/Base.astro', text: '<html><head><title>{t}</title></head><body><slot /></body></html>' },
    { path: 'src/pages/broken.astro', text: '<p>{{{' },
    { path: 'src/pages/huge.astro', text: undefined },
    { path: 'src/components/c.astro', text: '{list.map((i) => <p>Same each time</p>)}<p data-cms="x">Marked</p><p>Hi {name}</p>' },
  ]);
  assert.deepEqual(t, {
    files: 6, total: 8, safe: 3,
    left: { mixed: 1, fromCode: 1, withTags: 1, inLoop: 1, marked: 1 },
    unread: ['src/pages/broken.astro', 'src/pages/huge.astro'],
    perFile: [
      { path: 'src/pages/a.astro', total: 3, safe: 2, left: { ...NONE, withTags: 1 } },
      { path: 'src/pages/b.astro', total: 2, safe: 1, left: { ...NONE, fromCode: 1 } },
      { path: 'src/components/c.astro', total: 3, safe: 0, left: { ...NONE, mixed: 1, inLoop: 1, marked: 1 } },
      { path: 'src/layouts/Base.astro', total: 0, safe: 0, left: NONE },
    ],
  });
  assert.deepEqual(tallyAstro([]), { files: 0, total: 0, safe: 0, left: NONE, unread: [], perFile: [] });
});
