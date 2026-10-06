/**
 * The demo keeps its way to get Kiln in sight.
 *
 * The demo exists to make someone put Kiln on their own site. The one link
 * that did that was the button on the card shown after a first publish, and
 * that card closes (by itself, or with "Keep exploring"). After it, there was
 * no link to Kiln anywhere in the demo. The demo's own pill now carries it:
 * once this browser's demo has had a publish, whenever the card is not on
 * screen, on this visit and on later ones while the demo's state lasts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hasPublished } from '../src/editor/tryout.js';
import { START_URL, START_LABEL } from '../src/editor/firstrun.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(ROOT, 'src', 'editor', f), 'utf8');
const main = read('main.js');
const guide = read('firstrun.js');
const part = (from, to) => main.slice(main.indexOf(from), main.indexOf(to, main.indexOf(from) + from.length));

test('get Kiln: the demo\'s own state says whether there has been a publish, for as long as it lasts', () => {
  assert.equal(hasPublished({ _published: true }), true);
  // a demo published with an earlier version of the editor has no mark, but it has pages
  assert.equal(hasPublished({ _createdAt: 1, pages: { '/': { hero_headline: { html: 'Hello' } } } }), true);
  assert.equal(hasPublished({ history: { '/': [{ id: 'a' }] } }), true);
  // a publish that was undone still counts: the mark stays when the page goes back
  assert.equal(hasPublished({ _published: true, pages: {} }), true);
  // nothing yet: a new visitor, a draft only, state that was started over or has run out
  assert.equal(hasPublished({}), false);
  assert.equal(hasPublished({ _createdAt: 1, drafts: { '/': { ts: 1, edits: { a: { html: 'x' } } } } }), false);
  assert.equal(hasPublished({ pages: { '/': {} }, history: { '/': [] } }), false);
  for (const none of [null, undefined, 'x', 3]) assert.equal(hasPublished(none), false);
  // what is read back from the browser's storage is not taken on trust
  assert.equal(hasPublished({ _published: 'yes', pages: 'x', history: 7 }), false);
});

test('get Kiln: the pill and the card offer the same link, in the same words', () => {
  assert.equal(START_URL, 'https://kilncms.com/get-started.html');
  assert.equal(START_LABEL, 'Put Kiln on my site');
  // the card
  assert.match(guide, /invited \? 'Read the guide' : START_LABEL\)/);
  assert.match(guide, /go\.href = invited \? \(deps\.guideUrl \|\| 'https:\/\/kilncms\.com\/editors'\) : START_URL;/);
  // the pill: the same two, a new tab like the card's button
  const pill = part('function renderSandboxBanner()', 'function syncSandboxLink()');
  assert.match(pill, /<a id="kiln-sandbox-get" href="\$\{START_URL\}" target="_blank" rel="noopener">\$\{START_LABEL\}<\/a>/);
  assert.equal((main.match(/kilncms\.com\/get-started/g) || []).length, 0, 'the address is written once, in firstrun.js');
});

test('get Kiln: the link shows once there has been a publish and the card is not on screen', () => {
  const sync = part('function syncSandboxLink()', '\n}\n');
  assert.match(sync, /pill\.classList\.toggle\('kiln-sbx-get', hasPublished\(sandboxStore\(\)\) && !document\.getElementById\('kiln-guide-card'\)\);/);
  // looked at when the pill is drawn (a later visit), after a publish, and when the card goes
  assert.match(part('function renderSandboxBanner()', 'function syncSandboxLink()'), /syncSandboxLink\(\);\s*\n\}/);
  const publish = part('function publishSandbox(', '\n}\n');
  assert.match(publish, /s\._published = true;/);
  assert.ok(publish.indexOf('guidePublished(told);') < publish.indexOf('syncSandboxLink();'), 'after the card has been put up');
  assert.match(part('async function initSandbox()', '\n}\n'), /initGuide\(\{ cfg, mobileMq: MOBILE_MQ, cardGone: syncSandboxLink,/);
  // every way the card goes ends in one place, which says so: by itself, "Keep exploring", the link, Escape, a second publish
  const finish = guide.slice(guide.indexOf('function finish()'), guide.indexOf('function closeCardLater('));
  assert.match(finish, /document\.getElementById\('kiln-guide-card'\)\?\.remove\(\);[\s\S]*deps\?\.cardGone\?\.\(\);/);
  assert.equal((guide.match(/getElementById\('kiln-guide-card'\)\?\.remove\(\)/g) || []).length, 1, 'the card is taken down in one place');
});

test('get Kiln: on a phone the pill holds the link and "Start over", and gives up its other words', () => {
  const css = part('function renderSandboxBanner()', 'document.head.appendChild(st);');
  // hidden until the pill is marked
  assert.match(css, /#kiln-sandbox-get\{display:none;/);
  assert.match(css, /\.kiln-sbx-get #kiln-sandbox-get\{display:inline-block\}/);
  // below a wide window (phones included) the name goes, so that the pill is no wider than it was
  const narrow = css.slice(css.indexOf('@media (max-width:1179px){'), css.indexOf('@media ${MOBILE_MQ}{'));
  assert.match(narrow, /\.kiln-sbx-get \.kiln-sbx-words\{display:none\}/);
  const phone = css.slice(css.indexOf('@media ${MOBILE_MQ}{'));
  assert.match(phone, /\.kiln-sbx-get #kiln-sandbox-get\{display:inline-flex;align-items:center;flex:none;box-sizing:border-box;min-height:34px;/);
  // the pill still keeps the pencil's column free, and still steps aside for the toolbar and the menu
  assert.match(phone, /max-width:calc\(100vw - 108px\)/);
  assert.match(phone, /\.kiln-tb-open #kiln-sandbox-banner,\.kiln-menu-open #kiln-sandbox-banner\{display:none\}/);
  // in a wide window the long sentence makes way for the link
  assert.match(css, /\.kiln-sbx-get \.kiln-sbx-more\{display:none\}/);
});

test('get Kiln: nothing changes for an invited editor on a real site', () => {
  // the pill is drawn in try-out mode only
  assert.equal((main.match(/renderSandboxBanner\(\);/g) || []).length, 1);
  assert.match(part('async function initSandbox()', '\n}\n'), /renderSandboxBanner\(\);/);
  // and the card an invited editor gets keeps its own link and closes as before
  assert.match(guide, /closeCardLater\(card\);/);
});
