import { test } from 'node:test';
import assert from 'node:assert';
import { fontService, headersFor, extractRefs, cleanPage, rewriteCssUrls, cssUrls, fontsLeftOf, fontServiceLines } from '../cli/rescue.mjs';

const SITE = 'https://site.com';
const GF = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;700&display=swap';
const WOFF = 'https://fonts.gstatic.com/s/dmsans/v15/rP2Hp2ywxg089UriCZOIHQ.woff2';

test('fontService: knows the font services, and which of them may be copied', () => {
  assert.deepStrictEqual(fontService(GF), { name: 'Google Fonts', copy: true });
  assert.deepStrictEqual(fontService(WOFF), { name: 'Google Fonts', copy: true });
  assert.strictEqual(fontService('https://fonts.bunny.net/css?family=lato:400').copy, true);
  assert.strictEqual(fontService('https://use.fontawesome.com/releases/v5.15.4/css/all.css').copy, true);
  // fonts lent to a paying account stay where they are
  assert.deepStrictEqual(fontService('https://use.typekit.net/abc1def.css'), { name: 'Adobe Fonts', copy: false });
  assert.strictEqual(fontService('https://fast.fonts.net/cssapi/1234.css').copy, false);
  assert.strictEqual(fontService('https://pro.fontawesome.com/releases/v5.15.4/css/all.css').copy, false);
});

test('fontService: an icon font on a shared file host counts, the host\'s other files do not', () => {
  assert.strictEqual(fontService('https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css').copy, true);
  assert.strictEqual(fontService('https://maxcdn.bootstrapcdn.com/font-awesome/4.7.0/css/font-awesome.min.css').copy, true);
  assert.strictEqual(fontService('https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js'), null);
  assert.strictEqual(fontService(SITE + '/fonts/lato.woff2'), null);
  assert.strictEqual(fontService('not an address'), null);
  assert.strictEqual(fontService('data:font/woff2;base64,AAAA'), null);
});

test('headersFor: a font service is asked as a current desktop browser, so it names woff2 files', () => {
  const fonts = headersFor(GF)['user-agent'];
  assert.match(fonts, /^Mozilla\/5\.0 .*Chrome\/\d+/);
  assert.doesNotMatch(fonts, /kiln/);
  // every other file is asked for under Kiln's own name, as before
  assert.match(headersFor(SITE + '/style.css')['user-agent'], /^kiln-rescue\//);
  assert.match(headersFor('https://cdn.example.com/a.jpg')['user-agent'], /^kiln-rescue\//);
});

test('extractRefs: finds a font service style sheet however the page asks for it', () => {
  const html = `<html><head>
    <link rel="stylesheet" href="${GF.replace(/&/g, '&amp;')}">
    <link rel="preload" as="style" href="https://fonts.googleapis.com/css?family=Lato" onload="this.rel='stylesheet'">
    <link rel="preload" as="script" href="https://cdn.example.com/app.js">
    <style>@import "https://fonts.bunny.net/css?family=inter:400"; @import url(https://fonts.googleapis.com/icon?family=Material+Icons);</style>
    </head><body><p>Hello there</p></body></html>`;
  const { assets } = extractRefs(html, SITE + '/');
  assert.ok(assets.includes(GF));
  assert.ok(assets.includes('https://fonts.googleapis.com/css?family=Lato'));
  assert.ok(assets.includes('https://fonts.bunny.net/css?family=inter:400'));
  assert.ok(assets.includes('https://fonts.googleapis.com/icon?family=Material+Icons'));
  assert.ok(!assets.some(a => a.endsWith('app.js')), 'a script asked for early is not a file to copy');
});

test('cssUrls: reads both ways a style sheet names another file', () => {
  assert.deepStrictEqual(cssUrls(`@import 'a.css'; @import url("b.css"); .x{background:url(c.png)}`).sort(), ['a.css', 'b.css', 'c.png']);
});

test('cleanPage: the link to a copied font style sheet points at the copy', () => {
  const html = `<html><head><link rel="stylesheet" href="${GF.replace(/&/g, '&amp;')}"><link rel="preload" as="style" href="${GF.replace(/&/g, '&amp;')}"></head><body><p>Hello there</p></body></html>`;
  const key = extractRefs(html, SITE + '/').assets.find(a => a.includes('googleapis'));
  const r = cleanPage(html, { baseUrl: SITE + '/', pageMap: new Map(), assetMap: new Map([[key, 'assets/rescued/1a2b3c4d-css2.css']]) });
  assert.strictEqual(r.html.split('href="/assets/rescued/1a2b3c4d-css2.css"').length - 1, 2);
  assert.doesNotMatch(r.html, /fonts\.googleapis\.com/);
  assert.deepStrictEqual(r.offOrigin, []);
});

test('cleanPage: a font style sheet that was not copied keeps its link, and the page says so', () => {
  const html = `<html><head><link rel="stylesheet" href="https://use.typekit.net/abc1def.css"></head><body><p>Hello there</p></body></html>`;
  const r = cleanPage(html, { baseUrl: SITE + '/', pageMap: new Map(), assetMap: new Map() });
  assert.match(r.html, /href="https:\/\/use\.typekit\.net\/abc1def\.css"/);
  assert.deepStrictEqual(r.offOrigin, ['https://use.typekit.net/abc1def.css']);
});

test('rewriteCssUrls: the font service\'s style sheet names the copied font files', () => {
  const css = `@font-face{font-family:'DM Sans';src:url(${WOFF}) format('woff2')}`;
  const r = rewriteCssUrls(css, { base: GF, assetMap: new Map([[WOFF, 'assets/rescued/9f8e7d6c-rP2Hp2ywxg089UriCZOIHQ.woff2']]), sameDir: true });
  assert.strictEqual(r.css, `@font-face{font-family:'DM Sans';src:url(9f8e7d6c-rP2Hp2ywxg089UriCZOIHQ.woff2) format('woff2')}`);
  assert.deepStrictEqual(r.offOrigin, []);
});

test('rewriteCssUrls: @import "x" is rewritten like url(x)', () => {
  const map = new Map([['https://fonts.googleapis.com/css?family=Lato', 'assets/rescued/aaaa1111-css.css']]);
  const r = rewriteCssUrls(`@import "https://fonts.googleapis.com/css?family=Lato";\n@import 'more.css';\nbody{margin:0}`, { base: SITE + '/wp/style.css', assetMap: map, sameDir: true });
  assert.match(r.css, /@import "aaaa1111-css\.css";/);
  // a style sheet of the old site that was not copied is named by its full address, so it still loads
  assert.match(r.css, /@import 'https:\/\/site\.com\/wp\/more\.css';/);
  assert.deepStrictEqual(r.leftBehind, ['https://site.com/wp/more.css']);
  // a font service file that was not copied stays as it was and is reported
  const kept = rewriteCssUrls(`@import "https://use.typekit.net/abc1def.css";`, { base: SITE + '/style.css' });
  assert.strictEqual(kept.css, `@import "https://use.typekit.net/abc1def.css";`);
  assert.deepStrictEqual(kept.offOrigin, ['https://use.typekit.net/abc1def.css']);
});

test('cleanPage: icons drawn as SVG show, because no-svg on <html> becomes svg as the theme\'s script would have made it', () => {
  const html = `<html lang="en-US" class="no-js no-svg"><head><script>document.documentElement.className='js svg'</script></head><body><p>Hello there</p></body></html>`;
  const r = cleanPage(html, { baseUrl: SITE + '/', pageMap: new Map(), assetMap: new Map() });
  assert.match(r.html, /<html lang="en-US" class="no-js svg">/);
  // a copy that keeps its scripts is left for the script to change
  const kept = cleanPage(html, { baseUrl: SITE + '/', pageMap: new Map(), assetMap: new Map(), keepScripts: true });
  assert.match(kept.html, /class="no-js no-svg"/);
  // a page without the class is not touched
  assert.match(cleanPage(`<html class="js"><body><p>Hello there</p></body></html>`, { baseUrl: SITE + '/' }).html, /<html class="js">/);
});

test('fontsLeftOf + fontServiceLines: the report says the site still depends on the font service, and why', () => {
  const left = fontsLeftOf(
    ['https://use.typekit.net/abc1def.css', GF, 'https://cdn.example.com/a.jpg', 'https://fonts.bunny.net/css?family=inter:400'],
    [{ url: WOFF, reason: 'timeout' }, { url: SITE + '/big.mp4', reason: 'bigger than the limit for one file' }],
    [GF]);
  assert.deepStrictEqual(left.map(f => f.url), [WOFF, 'https://use.typekit.net/abc1def.css', 'https://fonts.bunny.net/css?family=inter:400']);
  const text = fontServiceLines(left).join('\n');
  assert.match(text, /^## Fonts that still come from a font service/);
  assert.match(text, /still depends on Google Fonts, Adobe Fonts and Bunny Fonts for 3 files/);
  assert.match(text, /Adobe Fonts: https:\/\/use\.typekit\.net\/abc1def\.css This service lends its fonts/);
  assert.match(text, /could not be copied this time \(timeout\)\. Run the rescue again/);
  assert.match(text, /does not follow/);
  assert.doesNotMatch(text, /—/, 'no em dash in words a person reads');
  // nothing left on a font service, nothing said
  assert.deepStrictEqual(fontServiceLines(fontsLeftOf(['https://cdn.example.com/a.jpg'], [], [])), []);
  assert.match(fontServiceLines(fontsLeftOf(['https://use.typekit.net/x.css']))[2], /depends on Adobe Fonts for one file/);
});
