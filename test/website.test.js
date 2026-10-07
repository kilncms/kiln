// The website in site/: the rules every page keeps. Skipped where the folder
// is not present (the website is published from its own repository).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const HAS_SITE = existsSync(path.join(SITE, 'index.html'));
// The three legal pages wait on the owner's decisions and are left as they are.
const LEGAL = new Set(['terms.html', 'privacy.html', 'refund.html']);
const pages = HAS_SITE ? readdirSync(SITE).filter(f => f.endsWith('.html')) : [];
const ours = pages.filter(f => !LEGAL.has(f));
const read = (f) => readFileSync(path.join(SITE, f), 'utf8');

/** The words a visitor reads: no head, scripts, comments, tags or the
 *  editor's own labels quoted in <span class="ui">, which keep the editor's wording. */
function visibleText(html) {
  return html
    .replace(/<head>[\s\S]*?<\/head>/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<pre[\s\S]*?<\/pre>/g, '')
    .replace(/<span class="ui">[^<]*<\/span>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–');
}

test('site: no exclamation marks in what a visitor reads', { skip: !HAS_SITE }, () => {
  for (const f of ours) assert.doesNotMatch(visibleText(read(f)), /!/, f);
});

test('site: no dashes used as punctuation', { skip: !HAS_SITE }, () => {
  for (const f of ours) {
    const s = read(f);
    const head = (s.match(/<head>[\s\S]*?<\/head>/) || [''])[0];
    const meta = [...head.matchAll(/<(?:title>([^<]*)|meta [^>]*content="([^"]*)")/g)].map(m => m[1] || m[2] || '').join(' ');
    for (const text of [visibleText(s), meta]) {
      const hit = text.match(/.{0,30}[—–].{0,30}/);
      assert.equal(hit, null, `${f}: ${hit && hit[0]}`);
    }
  }
});

test('site: every link to another page of the site, and every #anchor, exists', { skip: !HAS_SITE }, () => {
  const ids = new Map(pages.map(f => [f, new Set([...read(f).matchAll(/\sid="([^"]+)"/g)].map(m => m[1]))]));
  const missing = [];
  for (const f of pages) {
    for (const [, href] of read(f).matchAll(/href="([^"]+)"/g)) {
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [rawPath, frag] = href.split('#');
      const clean = rawPath.split('?')[0].replace(/^\//, '');
      let target = f;
      if (clean) target = clean.endsWith('.html') || clean.includes('.') ? clean : `${clean}.html`;
      if (href === '/' || clean === '') target = rawPath ? 'index.html' : f;
      if (!existsSync(path.join(SITE, target))) { missing.push(`${f} → ${href}`); continue; }
      if (frag && target.endsWith('.html') && !ids.get(target)?.has(frag)) missing.push(`${f} → ${href} (no such anchor)`);
    }
  }
  assert.deepEqual(missing, []);
});

test('site: nothing inline that the security policy in _headers would block', { skip: !HAS_SITE }, () => {
  for (const f of ours) {
    const s = read(f);
    assert.doesNotMatch(s, /<style[\s>]/, `${f}: inline <style>`);
    assert.doesNotMatch(s, /\sstyle="/, `${f}: style attribute`);
    for (const [tag] of s.matchAll(/<script\b[^>]*>/g)) assert.match(tag, /\ssrc="/, `${f}: inline script ${tag}`);
    assert.doesNotMatch(s, /\son[a-z]+="/, `${f}: inline event handler`);
  }
});

test('site: one main landmark and a skip link to it on every page', { skip: !HAS_SITE }, () => {
  for (const f of ours) {
    const s = read(f);
    assert.equal((s.match(/<main[\s>]/g) || []).length, 1, `${f}: one <main>`);
    assert.match(s, /<main[^>]*\sid="main"/, `${f}: main has id="main"`);
    assert.match(s, /<a class="skip" href="#main">/, `${f}: skip link`);
  }
});

test('site: source mode is not described as Self-hosted only (the code offers it on every plan)', { skip: !HAS_SITE }, () => {
  for (const f of ours) {
    const text = visibleText(read(f)).replace(/\s+/g, ' ');
    for (const sentence of text.split(/(?<=\.)\s/)) {
      if (/source mode|Astro/i.test(sentence)) assert.doesNotMatch(sentence, /self-hosted only|not a fit for Kiln Cloud|not available yet/i, `${f}: ${sentence}`);
    }
  }
});
