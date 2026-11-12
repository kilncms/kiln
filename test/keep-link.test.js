/**
 * A heading or paragraph that is one link keeps the link when its words are
 * typed over (src/editor/keep-link.js, and where main.js uses it).
 *
 * A tester pressed "+ Add block" on a list of posts, selected the new card's
 * title, typed another, and published: the title was plain words, with no
 * link, for visitors too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wholeLink, keepLink, LINK_KEPT } from '../src/editor/keep-link.js';
import { autotag } from '../src/autotag.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = readFileSync(path.join(ROOT, 'src', 'editor', 'main.js'), 'utf8');

const TITLE = '<a href="/blog/the-monday-brine.html">The Monday Brine</a>';

test('a part that is one link around all of its words is known as that', () => {
  assert.deepEqual(wholeLink(TITLE), { open: '<a href="/blog/the-monday-brine.html">', inside: 'The Monday Brine' });
  assert.deepEqual(wholeLink(`\n  ${TITLE}\n`), { open: '<a href="/blog/the-monday-brine.html">', inside: 'The Monday Brine' });
  assert.equal(wholeLink('<a class="t" href="/a"><span>On the <em>Perfect</em> Crunch</span></a>').inside, '<span>On the <em>Perfect</em> Crunch</span>');
  // a wrapper around the link is still one link around all the words
  assert.equal(wholeLink('<span class="k"><a href="/a">Title</a></span>').open, '<a href="/a">');
});

test('anything else is not: words outside, two links, no address, no words, a picture beside it', () => {
  assert.equal(wholeLink('Plain words'), null);
  assert.equal(wholeLink('Read <a href="/a">this</a>'), null);
  assert.equal(wholeLink('<a href="/a">this</a>.'), null);
  assert.equal(wholeLink('<a href="/a">One</a> <a href="/b">Two</a>'), null);
  assert.equal(wholeLink('<a name="top">Title</a>'), null);
  assert.equal(wholeLink('<a href="">Title</a>'), null);
  assert.equal(wholeLink('<a href="/a"><img src="/p.jpg" alt=""></a>'), null);
  assert.equal(wholeLink('<img src="/p.jpg" alt=""><a href="/a">Title</a>'), null);
  assert.equal(wholeLink(''), null);
  assert.equal(wholeLink(null), null);
});

test('new words typed over the title go inside the link it had', () => {
  assert.equal(keepLink(TITLE, 'QA added block'), '<a href="/blog/the-monday-brine.html">QA added block</a>');
  // what browsers leave behind: a line break at the end, or the old link with nothing in it
  assert.equal(keepLink(TITLE, 'QA added block<br>'), '<a href="/blog/the-monday-brine.html">QA added block</a>');
  assert.equal(keepLink(TITLE, '<a href="/blog/the-monday-brine.html"></a>QA added block'), '<a href="/blog/the-monday-brine.html">QA added block</a>');
  assert.equal(keepLink(TITLE, '<a href="/blog/the-monday-brine.html"><br></a>QA added block'), '<a href="/blog/the-monday-brine.html">QA added block</a>');
  // formatting in the new words stays, and so does every attribute the link had
  assert.equal(keepLink('<a class="card-link" href="/a" target="_blank" rel="noopener">Old</a>', 'A <em>new</em> title'),
    '<a class="card-link" href="/a" target="_blank" rel="noopener">A <em>new</em> title</a>');
});

test('a link that is still there is left exactly as it is', () => {
  const edited = '<a href="/blog/the-monday-brine.html">The Tuesday Brine</a>';
  assert.equal(keepLink(TITLE, edited), edited);
  const other = 'See <a href="/elsewhere">the other page</a>';
  assert.equal(keepLink(TITLE, other), other);
});

test('a link the person took off stays off, and so does one whose part changed its shape', () => {
  // "Remove link" leaves the same words with no link
  assert.equal(keepLink(TITLE, 'The Monday Brine'), 'The Monday Brine');
  assert.equal(keepLink(TITLE, '  The Monday   Brine '), '  The Monday   Brine ');
  // emptied: there is nothing to be a link
  assert.equal(keepLink(TITLE, ''), '');
  assert.equal(keepLink(TITLE, '<br>'), '<br>');
  // a block of text that became paragraphs or a list
  assert.equal(keepLink(TITLE, '<p>One</p><p>Two</p>'), '<p>One</p><p>Two</p>');
  assert.equal(keepLink(TITLE, '<ul><li>One</li></ul>'), '<ul><li>One</li></ul>');
});

test('a part that was not one link is never given one', () => {
  assert.equal(keepLink('Plain title', 'Another title'), 'Another title');
  assert.equal(keepLink('Read <a href="/a">this</a> first', 'Read this first, please'), 'Read this first, please');
  assert.equal(keepLink(null, 'Words'), 'Words');
  assert.equal(keepLink(TITLE, null), '');
});

test('the first pass still marks the heading, so pages that are marked already and new ones are edited alike', () => {
  const page = `<!doctype html><html><head><title>t</title></head><body><main><ul class="posts">
    <li class="card"><h3><a href="/blog/a.html">First post</a></h3><p>About the first.</p></li>
    <li class="card"><h3><a href="/blog/b.html">Second post</a></h3><p>About the second.</p></li>
    <li class="card"><h3><a href="/blog/c.html">Third post</a></h3><p>About the third.</p></li>
  </ul></main></body></html>`;
  const out = autotag(page).html;
  assert.match(out, /<h3 data-cms="[a-z_]+_items_title"><a href="\/blog\/a\.html">First post<\/a><\/h3>/);
  assert.doesNotMatch(out, /<a [^>]*data-cms/);
});

test('main.js: a field that is committed has its one link put back, through the sanitizer, and the person is told', () => {
  const commit = main.slice(main.indexOf('function commitEdit('), main.indexOf('function committedHtml('));
  assert.match(main, /import \{ keepLink, LINK_KEPT \} from '\.\/keep-link\.js';/);
  // from what the part held when the person began, never for a plain-text part
  assert.match(commit, /keepLink\(activeOriginalHtml, html\)/);
  assert.match(commit, /plain \|\| state\.active !== el/);
  assert.match(commit, /DOMPurify\.sanitize\(linked, SANITIZE\)/);
  // before anything is staged: a block in a list is staged from the page
  assert.ok(commit.indexOf('keepLink(') < commit.indexOf('stageContainer('));
  assert.ok(commit.indexOf('keepLink(') < commit.indexOf('const unchanged'));
  assert.match(commit, /setStatus\(LINK_KEPT/);
});

test('what the person reads is plain', () => {
  assert.doesNotMatch(LINK_KEPT, /—|href|anchor|<a/);
  assert.match(LINK_KEPT, /still a link/);
});
