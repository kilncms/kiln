#!/usr/bin/env node
/**
 * ui-check — drive the editor in a real browser and check the first minute of
 * editing: can a person find what is editable, make an edit, and publish it,
 * with none of Kiln's own interface sitting on top of another part of it.
 *
 *   node scripts/ui-check.mjs http://localhost:8774/ [--shots <dir>] [--only <pass>]
 *
 * The URL is a locally served site in sandbox mode (`sandbox: true` in its
 * kiln-config.js), with the bundles from dist/ copied into its assets. Nothing
 * outside that server is contacted: every other request is blocked, and each
 * one counts as a failure unless it is a stylesheet the site's own page asks
 * for in its own file (its fonts, say), which is not Kiln's doing.
 *
 * Runs at 1440x900, 390x844 and 360x740, twice each — as a returning visitor
 * and as a first-time one (who gets the demo guide on top of everything else).
 * Then once more at 1440 and 390 as a signed-in editor on a real (not sandbox)
 * site, with the worker played by this script: the demo-only parts must be
 * absent, Publish must send the commit, and a refused upload must say why.
 * In sandbox mode again, the safety net: in each list a block is removed,
 * added, moved and duplicated, and after each Undo and Redo every block must
 * be there to be seen, the same elements as before. Removing asks nothing in a
 * browser box and offers its own Undo. Then what a nervous person tries next:
 * Save as draft (kept, offered back), a reload with an edit unpublished
 * ("Pick up where you left off?"), Schedule and every other menu item (each
 * opens its dialog and says what a real site does, never an error), History
 * (publish twice, get the first one back), the ✨ button, and the names a
 * person reads. On a phone: nothing of Kiln's lies on the page's buttons, on
 * the menu's items or on a list's words. The link button opens the editor's
 * own dialog (never the browser's box) and hands the cursor and the selection
 * back, and a saved draft's choices are each on one line.
 * Then Undo itself ("undo shows"): the page's first heading is edited as soon
 * as the editor is up, while the site may still be animating in. After Undo,
 * Redo, Esc, "Drop" in the publish sheet and both of History's ways back, the
 * heading's words can be seen (the computed opacity of the heading and of
 * every element inside it is 1), and what Publish writes for it holds no
 * opacity, transform or style a script put there, before and after a reload.
 * Then the rest of what a first-time client met ("first edits"): a price
 * changed in a list and a block added to the same list are both named in the
 * publish sheet, and the number on Publish is the number of things the sheet
 * lists, through an add, a move, a removal and an Undo; a tap on a copy of an
 * editable part that is not itself editable says where the editable one is,
 * and "Show me" goes there; a photo nobody marked says so; the menu is solid
 * enough to read with no blur behind it; "Removed. Undo" is still there five
 * seconds on, and Undo leaves the page where the block comes back; "Start
 * over" and "Delete draft" ask first and say what would go; "Add event" with
 * an empty form says what is missing; Search & jump finds a word deep in a
 * list and a page of the site, and lists no part that does not hold the word;
 * a picture too big for the demo is refused with its size and the limit, and
 * a normal one is published after it.
 * Then the demo's way to get Kiln: once a visitor has published and the card
 * that offers "Put Kiln on my site" has gone, the demo's pill carries the
 * link, fitting beside the pencil.
 * Then what only shows on a real site ("real sites"): a block's buttons are
 * hidden while the block is under a bar the site keeps at the top of the
 * screen; a list is published as the page's file has it, with none of the
 * classes, styles or attributes the site's scripts put on its blocks while
 * the page was open, so that one changed word changes one word in the file;
 * History shows a way back on the page itself, in no frames; and signing out
 * with an edit waiting asks in the editor's own dialog.
 * Then a page a generator built ("generated"), a small one of this script's
 * own on a site in source mode: a field someone else changed is asked about
 * with theirs and yours and each answer does what it says; a failed build's
 * banner lies on nothing else of Kiln's; Search & jump lists the site's real
 * pages and never the sign-in page; a suggest-only and a comment-only editor
 * read what they can do there and are offered nothing that would be refused.
 * Both passes go through the publish sheet (open it, drop one edit, publish)
 * and press Undo; the signed-in pass also has someone else publish in between.
 * A last pass has the worker end the editor's sign-in: on page load the page
 * must say so and /kiln must show the sign-in, and at Publish the edit must
 * stay, come back after signing in again and then be sent; a 500 and a 403
 * must drop neither the sign-in nor the edit.
 * Then the sign-in ends and they find out anywhere else: History, a version
 * (going back to it, naming it), Save as draft, Schedule and its cancel, a
 * comment and a reply, a suggestion, the site's pictures, AI assist, page
 * settings, the site menu, a new page, find and replace, the undo after a
 * publish, or the editor asking by itself. Each must show the same dialog,
 * keep what was typed on screen, and bring back what the saved copy holds.
 * A sign-in that ran out by the browser's own clock must be said once.
 * Then the site owner ("owner"), with the worker playing owner sessions: the
 * browser keeps a session and no GitHub token, nothing is asked of
 * api.github.com, Publish and People & access go through the worker, Sign
 * out ends the session there, an ended session says so, and an owner signed
 * in the old way is moved over (or, with an older worker, carries on as before).
 * And formatted text from a content file ("formatted"): the toolbar a plain
 * HTML site has, a bold word and a new list item written back as the file's
 * own Markdown with only those lines changed, a table that takes no typing
 * and says why, and Esc.
 * Lists and links ("lists and links"): in a one-paragraph part (a <p> or a
 * heading) the list buttons and the Style menu's formats say why and change
 * nothing; in a rich area a list is made, not nested in its paragraph, with
 * the cursor where it was; a link typed as "example.com" goes to https://,
 * an email address to mailto:, and "about.html" stays as typed.
 * The keyboard ("keyboard"): with no mouse, Tab reaches every editable part,
 * each with a focus ring and a name; Enter opens a part as a click does; Tab
 * goes from the box to its toolbar (every button named, Bold saying whether it
 * is on, arrows moving along it), then on to the next part with the edit kept;
 * Esc leaves the box and the keyboard stays on it. Space opens a picture's
 * toolbar and Esc closes it. What would be published holds no tabindex, role
 * or label the editor put there. The publish sheet and People & access are
 * dialogs named by their headings that hold the keyboard and give it back;
 * the Kiln button opens its menu from Enter and Esc closes it.
 * "Make this whole page editable" ("whole page"): with the grant, the bar of
 * make-editable mode offers the button; it asks in the editor's own dialog
 * with what it would mark; confirming makes exactly one write of the page's
 * file, which is the old file with only data-cms marks added, and the page
 * loads again once the site serves it, with every new part editable even
 * though the file is first answered as it was before the write (GitHub does
 * that for a moment); with a change waiting it says to
 * publish or discard first; without the grant, for an editor limited to
 * parts of a page, and in the demo, the button is not there.
 * Exits non-zero if any check fails. `--shots <dir>` also saves a screenshot
 * of each step as <step>-<width>.png. `--only <pass>` runs the passes whose
 * name has that word in it ("safety net", "signed in", "ended elsewhere"…).
 *
 * Playwright is not a dependency of this repo. Point PLAYWRIGHT_DIR at any
 * installed copy of the `playwright` package (with its Chromium downloaded).
 * Not part of `npm test` or CI.
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { wholePagePass, markedWords } from '../src/editor/whole-page.js';
import { onlyAddsMarks } from '../src/autotag.js';

// Playwright is not a dependency of this repo: point PLAYWRIGHT_DIR at an installed copy,
// or install it here (npm i --no-save playwright) and the plain name resolves.
const PLAYWRIGHT_DIR = process.env.PLAYWRIGHT_DIR || 'playwright';
const args = process.argv.slice(2);
const shotsAt = args.indexOf('--shots');
const SHOTS = shotsAt !== -1 ? args[shotsAt + 1] : null;
const onlyAt = args.indexOf('--only');
const ONLY = onlyAt !== -1 ? args[onlyAt + 1] : '';
const URL_ARG = args.find((a, i) => !a.startsWith('--') && (shotsAt === -1 || i !== shotsAt + 1) && (onlyAt === -1 || i !== onlyAt + 1));
if (!URL_ARG) {
  console.error('usage: node scripts/ui-check.mjs <url of a locally served sandbox site> [--shots <dir>] [--only <pass>]');
  process.exit(2);
}
let chromium;
try { ({ chromium } = createRequire(import.meta.url)(PLAYWRIGHT_DIR)); } catch (err) {
  console.error(`ui-check: could not load Playwright from ${PLAYWRIGHT_DIR}\n  set PLAYWRIGHT_DIR to an installed "playwright" package directory\n  (${err.message})`);
  process.exit(2);
}
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const SIZES = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 360, height: 740 }];
const ORIGIN = new URL(URL_ARG).origin;
const MARGIN = 8;

let failed = 0;
const lines = [];
function check(scope, name, ok, detail = '') {
  if (!ok) failed++;
  lines.push(`${ok ? '  ok  ' : '  FAIL'}  ${scope}  ${name}${detail ? `  (${detail})` : ''}`);
}

/** Is `el` (or something inside it) what a tap at its centre would land on? */
const hit = (locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return { ok: false, why: 'not rendered' };
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { ok: false, why: `centre off screen at ${Math.round(x)},${Math.round(y)}` };
  const top = document.elementFromPoint(x, y);
  const ok = !!top && (top === el || el.contains(top));
  const name = (n) => n ? (n.id ? `#${n.id}` : `${n.tagName.toLowerCase()}.${String(n.className).split(' ')[0]}`) : 'nothing';
  return { ok, why: ok ? '' : `covered by ${name(top)}` };
});
const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; });
const apart = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
/** scrollWidth vs clientWidth, plus (when they differ) which of Kiln's own elements stick out. */
const sideways = (page) => page.evaluate(() => {
  const d = document.documentElement;
  const out = { sw: d.scrollWidth, cw: d.clientWidth, who: '' };
  if (out.sw !== out.cw) {
    out.who = [...document.querySelectorAll('[id^="kiln-"], [class*="kiln-"]')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.right > d.clientWidth + 0.5 || r.left < -0.5); })
      .slice(0, 4).map((el) => `${el.id ? '#' + el.id : '.' + String(el.className).split(' ')[0]} ${getComputedStyle(el).position}`).join(', ');
  }
  return out;
});

/**
 * A request for something outside the local server is never let out, and it
 * counts against Kiln, with one exception: a stylesheet the site's own page
 * asks for in its own file (the test demo's page has a line for its fonts at
 * fonts.googleapis.com). That is the site's doing, with or without Kiln. Only
 * this passes uncounted: a request for a stylesheet, made by a page of the
 * local server, for an address that page's file, as the server sends it,
 * names in a <link rel="stylesheet">. Whatever Kiln's own code asks for (a
 * fetch, a script, a picture, a font, a stylesheet the file does not name)
 * still counts, at Google's addresses as much as anywhere else.
 */
const namedStylesheets = (html, base) => {
  const out = [];
  for (const [tag] of String(html).replace(/<!--[\s\S]*?-->/g, '').matchAll(/<link\b[^>]*>/gi)) {
    const attr = (name) => { const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')); return m ? (m[1] ?? m[2] ?? m[3]) : ''; };
    if (!/(^|\s)stylesheet(\s|$)/i.test(attr('rel'))) continue;
    try { out.push(new URL(attr('href').replace(/&amp;/gi, '&'), base).href); } catch { /* not an address */ }
  }
  return out;
};
const pageFiles = new Map();   // a page's address -> the stylesheets its file names
async function sitesOwnStylesheet(request) {
  if (request.resourceType() !== 'stylesheet') return false;
  let at;
  try { at = new URL(request.frame().url()); } catch { return false; }
  if (at.origin !== ORIGIN) return false;
  const file = at.origin + at.pathname;
  if (!pageFiles.has(file)) pageFiles.set(file, fetch(file).then(r => (r.ok ? r.text() : '')).then(html => namedStylesheets(html, file)).catch(() => []));
  return (await pageFiles.get(file)).includes(request.url());
}
/** Refuse a request for something outside the local server, and note it in `list` unless it is the site's own stylesheet. */
async function refuse(route, list) {
  const request = route.request();
  if (!(await sitesOwnStylesheet(request))) list.push(request.url());
  return route.abort();
}
/** Take out of `list` the requests for one address a press was meant to open (a guide, a link), and leave every other one counted. */
const forget = (list, address) => { for (let i = list.length - 1; i >= 0; i--) if (list[i].startsWith(address)) list.splice(i, 1); };

/**
 * Bring a block to where a person has it before reaching for its buttons: on
 * the screen, with its top below any bar the site keeps at the top of it. A
 * block's buttons are hidden while they are under such a bar (the "real
 * sites" pass checks that they are), and scrollIntoViewIfNeeded() is content
 * with a block whose top is under one: the test demo has a header that stays.
 */
async function inReach(page, block) {
  await block.scrollIntoViewIfNeeded();
  const bar = (await page.evaluate(roomOnScreen)).top;
  await block.evaluate((el, under) => {
    const top = el.getBoundingClientRect().top;
    if (under && top < under + 16) window.scrollBy({ top: top - under - 16, behavior: 'instant' });
  }, bar);
  await page.waitForTimeout(150);
}
/**
 * The part of the screen nothing stays on top of while the page scrolls, from
 * `top` to `bottom`: below a bar the site keeps at the top of the screen, and
 * above what Kiln keeps along the bottom of it (the pencil, Undo, Redo and
 * Publish, the demo's banner, the guide's second tip). Runs in the page.
 */
const roomOnScreen = () => {
  let top = 0, bottom = innerHeight;
  for (const e of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(e);
    if ((cs.position !== 'fixed' && cs.position !== 'sticky') || cs.visibility === 'hidden') continue;
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height || r.height > innerHeight / 2 || r.bottom <= 0 || r.top >= innerHeight) continue;
    const kiln = !!e.closest('[id^="kiln-"], .kiln-item-ctl, .kiln-repeat-add, .kiln-block-gap');
    if (!kiln && r.top <= 1 && r.width >= innerWidth * 0.9) top = Math.max(top, r.bottom);
    if (kiln && cs.position === 'fixed' && (r.top + r.bottom) / 2 > innerHeight / 2) bottom = Math.min(bottom, r.top);
  }
  return { top, bottom };
};
/**
 * What lies on the words of the guide's tip, if anything: at the start, the
 * middle and the end of them, the tip must be what a finger or an eye meets.
 * (On a phone the demo's banner lay on the first words of "Now publish it.")
 */
const overTipWords = (guide) => guide.evaluate((g) => {
  const words = g.querySelector('.kiln-guide-words') || g.querySelector('span');
  const r = words.getBoundingClientRect();
  if (!r.width || !r.height) return ['the tip has no words to read'];
  const y = r.top + r.height / 2;
  const name = (n) => (n ? (n.closest('[id]') ? `#${n.closest('[id]').id}` : n.tagName.toLowerCase()) : 'off the screen');
  return [...new Set([r.left + 2, r.left + r.width / 2, r.right - 2].map((x) => { const at = document.elementFromPoint(x, y); return at && g.contains(at) ? '' : name(at); }).filter(Boolean))];
});
/** Wait until the page has stopped moving (the editor moves it smoothly to show a block's opened buttons). */
async function atRest(page) {
  let was = NaN;
  for (let i = 0; i < 40; i++) {
    const y = await page.evaluate(() => window.scrollY);
    if (y === was) return;
    was = y;
    await page.waitForTimeout(120);
  }
}

async function run(browser, size, firstVisit) {
  const phone = size.width < 600;
  const scope = `${size.width}x${size.height} ${firstVisit ? 'first visit ' : 'returning   '}`;
  const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone, reducedMotion: 'no-preference' });
  // Hermetic: only the local server answers.
  const blocked = [];
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(ORIGIN) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    return refuse(route, blocked);
  });
  if (!firstVisit) await context.addInitScript(() => { try { localStorage.setItem('kiln_guide', '1'); } catch { /* ignore */ } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const press = (locator) => (phone ? locator.tap() : locator.click());
  const shot = async (step) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${step}-${size.width}.png`) }); };
  const pencil = page.locator('#kiln-fab');
  const menu = page.locator('#kiln-fab-menu');
  const guide = page.locator('#kiln-guide');

  await page.goto(URL_ARG, { waitUntil: 'load' });
  await pencil.waitFor({ state: 'visible', timeout: 15000 });
  check(scope, 'the site is in sandbox mode', await page.evaluate(() => window.KILN && window.KILN.sandbox === true));

  // ── at rest: editable things can be found ──────────────────────────────────
  const heading = page.locator('h1.kiln-field, h2.kiln-field, h3.kiln-field').first();
  await heading.scrollIntoViewIfNeeded();
  await page.waitForTimeout(350);
  const revealed = await heading.evaluate((el) => getComputedStyle(el).outlineColor);
  check(scope, 'editable fields show their outline when editing starts', !/, 0\)$|transparent/.test(revealed), revealed);
  if (firstVisit) {
    await guide.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    check(scope, 'guide step 1 points at the first editable heading', /^(Click|Tap) this and type\.$/.test((await guide.locator('span').first().textContent().catch(() => '')) || ''));
    if (await guide.count()) {
      // Under or over the heading, the tip is clear of the heading's whole box. Where both of those places hold
      // something to read or to press, the editor puts it on the heading's own line, after its words (firstrun.js,
      // placeBeside): the box of a heading runs the width of its column, so there the tip is inside that box and
      // must lie on none of the heading's words, begin after the last word of the first line and sit level with
      // that line, and a press on the words must still land on the heading.
      const g = await box(guide);
      const side = ((await guide.getAttribute('class')) || '').replace('kiln-guide--', '');
      const words = await heading.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const lines = [...range.getClientRects()].filter(b => b.width > 1 && b.height > 1).map(b => ({ left: b.left, top: b.top, right: b.right, bottom: b.bottom }));
        if (!lines.length) return { lines, first: null, pressed: false };
        const top = Math.min(...lines.map(b => b.top));
        const one = lines.filter(b => b.top < top + (lines[0].bottom - lines[0].top) / 2);
        const first = { left: Math.min(...one.map(b => b.left)), top, right: Math.max(...one.map(b => b.right)), bottom: Math.max(...one.map(b => b.bottom)) };
        const under = document.elementFromPoint((first.left + first.right) / 2, (first.top + first.bottom) / 2);
        return { lines, first, pressed: !!under && (under === el || el.contains(under)) };
      });
      const offWords = words.lines.length > 0 && words.lines.every(l => apart(g, l));
      const level = !!words.first && (g.top + g.bottom) / 2 > words.first.top && (g.top + g.bottom) / 2 < words.first.bottom;
      const clear = side === 'beside'
        ? offWords && level && g.left >= words.first.right && words.pressed
        : apart(g, await box(heading));
      check(scope, 'guide step 1 does not cover the heading', clear,
        `tip ${side} the heading, at x ${Math.round(g.left)} to ${Math.round(g.right)}, y ${Math.round(g.top)} to ${Math.round(g.bottom)}${words.first ? `; first line of words x ${Math.round(words.first.left)} to ${Math.round(words.first.right)}, y ${Math.round(words.first.top)} to ${Math.round(words.first.bottom)}` : ''}`);
      const over1 = await overTipWords(guide);
      check(scope, 'guide step 1\'s words can be read: nothing lies on them', over1.length === 0, over1.join(', '));
    }
    if (await guide.count()) {
      await page.waitForTimeout(2400);   // the page's own fade-ins have settled, and the tip has been looked at again
      const on = await guide.evaluate((g) => {
        const r = g.getBoundingClientRect();
        return [...document.querySelectorAll('a[href], button')].filter(el => !el.closest('[id^="kiln-"], .kiln-item-ctl, .kiln-repeat-add, .kiln-block-gap'))
          .filter((el) => { const b = el.getBoundingClientRect(); return b.width && b.height && !(b.right <= r.left || r.right <= b.left || b.bottom <= r.top || r.bottom <= b.top); })
          .map(el => (el.textContent || '').trim().slice(0, 20));
      });
      check(scope, 'guide step 1 lies on none of the page\'s own buttons or links', on.length === 0, on.join(', '));
    }
    // Read out as it appears, without taking the keyboard; its Skip is a named button in the Tab order.
    const live = await page.evaluate(() => { const r = document.getElementById('kiln-guide-said'); const g = document.getElementById('kiln-guide');
      const skip = g?.querySelector('.kiln-guide-skip');
      return { role: r?.getAttribute('role'), live: r?.getAttribute('aria-live'), said: r?.textContent || '', inGuide: !!document.activeElement?.closest('#kiln-guide'),
        modal: g?.getAttribute('aria-modal'), skip: skip ? { name: skip.getAttribute('aria-label'), tab: skip.tabIndex, tag: skip.tagName } : null }; });
    check(scope, 'guide step 1 is read out politely as it appears, naming the heading, and the keyboard stays where it was', live.role === 'status' && live.live === 'polite' && /^(Click|Tap) “.+” and type\.$/.test(live.said) && !live.inGuide && live.modal !== 'true', JSON.stringify(live));
    check(scope, 'its Skip is a button reached by Tab, named "Skip the guide"', live.skip?.tag === 'BUTTON' && live.skip.name === 'Skip the guide' && live.skip.tab >= 0, JSON.stringify(live.skip));
    // Someone who presses Tab is told what to press instead.
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    const keyed = await page.evaluate(() => ({ words: document.querySelector('#kiln-guide .kiln-guide-words')?.textContent, said: document.getElementById('kiln-guide-said')?.textContent }));
    check(scope, 'after a press of Tab, guide step 1 says to press Enter, and says so aloud', keyed.words === 'Press Enter on this and type.' && /^Press Enter on “.+” and type\.$/.test(keyed.said || ''), JSON.stringify(keyed));
    await shot('guide-1-keys');
    await page.evaluate(() => document.activeElement?.blur());
    await shot('guide-1');
  } else {
    check(scope, 'no guide for a returning visitor', (await guide.count()) === 0);
    await shot('rest');
  }
  await page.waitForTimeout(2300);   // the reveal has faded
  const resting = await heading.evaluate((el) => getComputedStyle(el).outlineColor);
  if (phone) check(scope, 'touch: a faint outline stays on editable fields', !/, 0\)$|transparent/.test(resting), resting);
  else check(scope, 'pointer: the outline fades once the reveal is over', /, 0\)$|transparent/.test(resting), resting);
  if (!firstVisit) await shot('rest-settled');
  check(scope, 'pencil can be pressed', ...Object.values(await hit(pencil)));
  let s = await sideways(page);
  check(scope, 'page does not scroll sideways', s.sw === s.cw, `scrollWidth ${s.sw}, clientWidth ${s.cw}${s.who ? `: ${s.who}` : ''}`);
  check(scope, 'no Publish button while nothing is unpublished', (await page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).count()) === 0);
  const banner = page.locator('#kiln-sandbox-banner');
  if (phone && await banner.count()) {
    check(scope, 'demo banner leaves the pencil alone', apart(await box(banner), await box(pencil)));
    const text = banner.locator('span').first();
    const oneLine = await text.evaluate((el) => el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).lineHeight) * 1.5);
    check(scope, 'demo banner text fits on one line', oneLine);
  }
  const status = page.locator('#kiln-status');
  if (phone) {
    await page.waitForTimeout(2600);   // ~5.5 s after load
    check(scope, 'the status hint has gone away by itself', !(await status.isVisible()));
  }

  // ── the pencil menu: hover opens, the click that follows keeps it ──────────
  if (!phone) {
    const b = await box(pencil);
    await page.mouse.move(b.left + b.width / 2, b.top + b.height / 2, { steps: 4 });
    await page.waitForTimeout(250);
    check(scope, 'hovering the pencil opens the menu', await menu.isVisible());
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(250);
    check(scope, 'clicking the pencil after hovering it leaves the menu open', await menu.isVisible());
    await page.mouse.move(200, 200, { steps: 4 });
    await page.waitForTimeout(700);
    check(scope, 'a pinned menu stays open when the mouse leaves', await menu.isVisible());
    await pencil.click();
    await page.waitForTimeout(200);
    check(scope, 'a second click on the pencil closes it', !(await menu.isVisible()));
    await page.mouse.move(200, 200);
    // keyboard
    await pencil.focus();
    await page.keyboard.press('Enter');
    check(scope, 'Enter on the pencil opens the menu', await menu.isVisible());
    const first = await page.evaluate(() => document.activeElement && document.activeElement.closest('#kiln-fab-menu') ? document.activeElement.textContent.trim() : null);
    await page.keyboard.press('ArrowDown');
    const second = await page.evaluate(() => document.activeElement && document.activeElement.closest('#kiln-fab-menu') ? document.activeElement.textContent.trim() : null);
    check(scope, 'arrow keys move through the menu items', !!first && !!second && first !== second, `${first} -> ${second}`);
    await page.keyboard.press('Escape');
    check(scope, 'Escape closes the menu and returns focus to the pencil', !(await menu.isVisible()) && await pencil.evaluate((el) => document.activeElement === el));
    await pencil.click();
    // A spot with nothing editable under it. (A fixed 300,300 lies on the
    // demo's big heading, and a click there starts editing it, as it should:
    // the heading's later edit then began with the caret where that click was.)
    const blank = await page.evaluate(() => {
      for (let y = 120; y < innerHeight - 120; y += 20) for (let x = 40; x < innerWidth - 300; x += 20) {
        const el = document.elementFromPoint(x, y);
        if (el && !el.closest('[data-cms], [data-cms-repeat], [data-cms-attr], .kiln-field, a, button, input, img, [id^="kiln-"]')) return { x, y };
      }
      return { x: 300, y: 300 };
    });
    await page.mouse.click(blank.x, blank.y);
    await page.waitForTimeout(150);
    check(scope, 'a click outside closes a pinned menu', !(await menu.isVisible()));
  } else {
    await pencil.tap();
    await page.waitForTimeout(350);
    check(scope, 'tapping the pencil opens the menu', await menu.isVisible());
    check(scope, 'demo banner steps aside while the menu is open', !(await banner.isVisible()));
    check(scope, 'pencil can be pressed with the menu open', ...Object.values(await hit(pencil)));
    await pencil.tap();
    await page.waitForTimeout(250);
    check(scope, 'tapping the pencil again closes the menu', !(await menu.isVisible()));
  }

  // ── one edit ───────────────────────────────────────────────────────────────
  await heading.scrollIntoViewIfNeeded();
  // The heading as a person reads it (a line break inside it is a space).
  const read = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();
  const before = await read(heading);
  await press(heading);
  if (firstVisit) {
    const words = await page.evaluate(() => document.querySelector('#kiln-guide .kiln-guide-words')?.textContent || '');
    check(scope, 'a click or tap after that makes guide step 1 say click or tap again', /^(Click|Tap) this and type\.$/.test(words), words);
  }
  const toolbar = page.locator('#kiln-toolbar');
  await toolbar.waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(350);
  const controls = toolbar.locator('button, select, input').filter({ visible: true });
  const n = await controls.count();
  const covered = [];
  for (let i = 0; i < n; i++) {
    const h = await hit(controls.nth(i));
    if (!h.ok) covered.push(`${((await controls.nth(i).getAttribute('title')) || (await controls.nth(i).textContent()) || '?').trim().slice(0, 22)}: ${h.why}`);
  }
  check(scope, `every toolbar control can be pressed (${n})`, n > 0 && covered.length === 0, covered.join('; '));
  if (phone) {
    check(scope, 'demo banner steps aside while the toolbar is open', !(await banner.isVisible()));
    check(scope, 'pencil steps aside while the toolbar is open', !(await pencil.isVisible()));
    if (firstVisit) check(scope, 'the guide steps aside while the toolbar is open', !(await guide.isVisible()));
  }
  if (!firstVisit) await shot('editing');
  await page.keyboard.type(' Hello');
  await press(toolbar.locator('.kiln-tb-save'));
  await page.waitForTimeout(450);
  check(scope, 'the edit is on the page', (await read(heading)) === `${before} Hello`);

  // ── after one edit: Publish is in the open ─────────────────────────────────
  const publish = page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).first();
  const name = (await publish.count()) ? (await publish.textContent()).trim() : '';
  check(scope, 'a control named "Publish…" is visible after one edit', name === 'Publish 1 edit', name || 'none');
  if (name) {
    check(scope, 'Publish can be pressed', ...Object.values(await hit(publish)));
    check(scope, 'Publish can be reached by keyboard', await publish.evaluate((el) => el.tagName === 'BUTTON' && !el.disabled && el.tabIndex >= 0));
  }
  check(scope, 'pencil can be pressed', ...Object.values(await hit(pencil)));
  for (const label of ['Undo', 'Redo']) {
    const pill = page.getByRole('button', { name: new RegExp(`^${label}`) }).filter({ visible: true }).first();
    check(scope, `${label} pill can be pressed`, ...Object.values((await pill.count()) ? await hit(pill) : { ok: false, why: 'not shown' }));
  }
  if (phone) {
    // One row at the bottom: Undo and Redo as icons with their names read out, Publish, the pencil.
    const row = await page.evaluate(() => ['#kiln-undo-btn', '#kiln-redo-btn', '#kiln-publish-quick', '#kiln-fab'].map((q) => {
      const el = document.querySelector(q);
      const r = el && el.getBoundingClientRect();
      return r && r.width ? { q, top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, name: el.getAttribute('aria-label') || '' } : { q, missing: true };
    }));
    const shown = row.filter(r => !r.missing);
    const mid = (r) => (r.top + r.bottom) / 2;
    const oneRow = shown.length === 4 && shown.every(r => Math.abs(mid(r) - mid(shown[3])) <= 4);
    const inOrder = shown.every((r, i) => i === 0 || shown[i - 1].right <= r.left + 0.5) && shown[3].right <= size.width;
    const covered = size.height - Math.min(...shown.map(r => r.top));
    check(scope, 'Undo, Redo, Publish and the pencil are one row at the bottom, side by side on the screen', oneRow && inOrder, JSON.stringify(shown.map(r => [r.q, Math.round(r.left), Math.round(r.top)])));
    check(scope, 'the row covers no more than the pencil\'s own band of the page', covered <= 80, `${Math.round(covered)}px`);
    check(scope, 'Undo and Redo are icons, named for screen readers', row[0].name === 'Undo' && row[1].name === 'Redo' && row[0].width <= 48 && row[1].width <= 48, `${row[0].name} ${Math.round(row[0].width)}px, ${row[1].name} ${Math.round(row[1].width)}px`);
  }
  if (firstVisit) await guide.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (phone && await banner.count()) {
    if (firstVisit && await guide.isVisible()) {
      // The guide's second tip stands over Publish. On a phone that is where the banner sits while Undo, Redo
      // or Publish share the pencil's row, and it lay on the tip's first words. It steps aside for the tip, as
      // it does for a field's toolbar and the menu, and is back when the tip has gone (checked after the guide).
      check(scope, 'the demo banner steps aside while the guide points at Publish', !(await banner.isVisible()));
    } else {
      const bb = await box(banner);
      const others = [pencil, publish, page.locator('#kiln-undo-btn'), page.locator('#kiln-redo-btn')];
      let clear = await banner.isVisible();
      for (const o of others) if (await o.count()) clear = clear && apart(bb, await box(o));
      check(scope, 'demo banner covers none of pencil, Publish, Undo, Redo', clear);
    }
  }
  if (firstVisit) {
    check(scope, 'guide step 2 points at Publish', ((await guide.locator('span').first().textContent().catch(() => '')) || '') === 'Now publish it.');
    if (await guide.count()) {
      const over2 = await overTipWords(guide);
      check(scope, 'guide step 2\'s words can be read: nothing lies on them', over2.length === 0, over2.join(', '));
    }
    if (await guide.count() && name) {
      const g = await box(guide);
      let clear = true;
      for (const o of [publish, pencil, page.locator('#kiln-undo-btn'), page.locator('#kiln-redo-btn')]) clear = clear && apart(g, await box(o));
      check(scope, 'guide step 2 covers none of Publish, pencil, Undo, Redo', clear);
    }
    await shot('guide-2');
  } else {
    await shot('after-edit');
    if (phone) await pencil.tap(); else await pencil.click();
    await page.waitForTimeout(400);
    check(scope, 'the menu opens with the edit pending', await menu.isVisible());
    await shot('menu');
    if (phone) await pencil.tap(); else await pencil.click();
    await page.waitForTimeout(300);
  }

  // ── a block's control bar stays on screen and inside its block ─────────────
  const item = page.locator('[data-cms-repeat="products"] > .kiln-repeat-item, [data-cms-repeat] > .kiln-repeat-item').first();
  if (await item.count()) {
    // Put the block's top a quarter of the way down the screen. Jump there (a
    // site with smooth scrolling would still be moving when we measure) and
    // try again if images loading above it pushed it somewhere else.
    for (let i = 0; i < 6; i++) {
      const off = await item.evaluate((el) => {
        const want = innerHeight * 0.25, top = el.getBoundingClientRect().top;
        if (Math.abs(top - want) > 4) window.scrollTo({ top: window.scrollY + top - want, behavior: 'instant' });
        return Math.abs(top - want);
      });
      if (off <= 4) break;
      await page.waitForTimeout(300);
    }
    const bar = item.locator(':scope > .kiln-item-ctl');
    const vw = size.width;
    const inside = (b) => b.left >= MARGIN - 0.5 && b.right <= vw - MARGIN + 0.5;
    const span = (b) => `x ${Math.round(b.left)} to ${Math.round(b.right)} of ${vw}`;
    if (phone) {
      // Phones: one "more" button per block, and the bar opens on a tap.
      const more = bar.locator('.kiln-ctl-more');
      const next = page.locator('[data-cms-repeat] > .kiln-repeat-item > .kiln-item-ctl').nth(1);
      check(scope, 'a block shows its "more" button', ...Object.values((await more.count()) ? await hit(more) : { ok: false, why: 'no button' }));
      if (await next.count()) check(scope, 'two neighbouring blocks\' controls do not overlap', apart(await box(bar), await box(next)));
      // A finger lands where the button is; it does not scroll the page first.
      const m = await box(more);
      const was = await box(item);
      await page.touchscreen.tap(m.left + m.width / 2, m.top + m.height / 2);
      await page.waitForTimeout(250);
      // The bar opens at the foot of the block. Where that is under Kiln's own buttons along the bottom of
      // the screen, or below it, the page moves just far enough to show it: every button is then pressed below.
      await atRest(page);
      // Its corner is the block's corner. The block itself may move: a site's
      // own :hover lift (the demo's cards rise 4px) holds on a phone after a tap.
      const m2 = await box(more), is = await box(item);
      check(scope, 'the "more" button stays in its corner when the bar opens', Math.abs((m2.right - is.right) - (m.right - was.right)) < 1 && Math.abs((m2.top - is.top) - (m.top - was.top)) < 1,
        `${Math.round(m2.right - is.right)},${Math.round(m2.top - is.top)} from the block's corner, was ${Math.round(m.right - was.right)},${Math.round(m.top - was.top)}`);
      check(scope, 'the opened bar stays inside its block', (await box(bar)).bottom <= is.bottom + 1, `bar ends at ${Math.round((await box(bar)).bottom)}, block at ${Math.round(is.bottom)}`);
    } else {
      // The pointer goes onto the block where it is. (hover() first scrolls a
      // block taller than the screen to the top of it, which on a site with a
      // header pinned there is under that header, where a block's buttons are
      // hidden: see the "real sites" pass.)
      const at = await box(item);
      await page.mouse.move(at.left + at.width / 2, at.top + Math.min(at.height / 2, 120));
      await page.waitForTimeout(350);
    }
    const b = await box(bar), it = await box(item);
    check(scope, 'first block\'s control bar lies inside the viewport, 8 px clear of both edges', inside(b), span(b));
    check(scope, 'the control bar stays inside its own block', b.left >= it.left - 0.5 && b.right <= it.right + 0.5,
      `bar ${Math.round(b.left)}-${Math.round(b.right)}, block ${Math.round(it.left)}-${Math.round(it.right)}`);
    const buttons = bar.locator('button').filter({ visible: true });
    const count = await buttons.count();
    let unreachable = [];
    for (let i = 0; i < count; i++) {
      const h = await hit(buttons.nth(i));
      if (!h.ok) unreachable.push({ more: await buttons.nth(i).evaluate(el => el.classList.contains('kiln-ctl-more')), said: `${(await buttons.nth(i).getAttribute('title')) || `button ${i + 1}`}: ${h.why}` });
    }
    // On a phone the "more" button keeps its corner at the top of the block and the row it opened is at the
    // foot. A block that is taller, with its row, than the room the screen has between the site's own bar and
    // Kiln's buttons along the bottom cannot show both. The row is what was asked for, so every button of it
    // must be pressed all the same; the "more" button may then be above that room, and only there. (It also
    // folds the bar away. So does a tap anywhere else: checked next.)
    let tall = '';
    if (phone && unreachable.some(u => u.more)) {
      const room = await page.evaluate(roomOnScreen);
      const whole = await box(item), corner = await box(bar.locator('.kiln-ctl-more'));
      if (whole.height > room.bottom - room.top && corner.top < room.top) {
        unreachable = unreachable.filter(u => !u.more);
        tall = `the block is ${Math.round(whole.height)} px tall and the screen has ${Math.round(room.bottom - room.top)} px between the site's bar and Kiln's buttons: the row shows, and the "more" button is above that room`;
      }
    }
    check(scope, `every button in the open control bar can be pressed (${count})`, count >= 5 && unreachable.length === 0, [...unreachable.map(u => u.said), tall].filter(Boolean).join('; '));
    if (!firstVisit) await shot('grid');
    else await shot('grid-guided');
    if (phone) {
      await page.touchscreen.tap(4, size.height / 2);   // a tap elsewhere folds it away
      await page.waitForTimeout(200);
      check(scope, 'a tap elsewhere folds the control bar away', (await bar.locator('button').filter({ visible: true }).count()) === 1);
    }
  } else {
    check(scope, 'the page has a repeatable block to check', false, 'no [data-cms-repeat] found');
  }
  s = await sideways(page);
  check(scope, 'page still does not scroll sideways', s.sw === s.cw, `scrollWidth ${s.sw}, clientWidth ${s.cw}${s.who ? `: ${s.who}` : ''}`);

  // ── section dividers keep out of the way ───────────────────────────────────
  {
    const shown = () => page.evaluate(() => [...document.querySelectorAll('.kiln-block-gap')].filter(g => {
      const cs = getComputedStyle(g); return cs.opacity !== '0' && cs.visibility !== 'hidden';
    }).length);
    if (phone) check(scope, 'on a phone at most two "+ Add section" dividers show: the ones around the section last touched', (await shown()) <= 2, `${await shown()} showing`);
    // walk the whole page with edits unpublished: no divider may sit under the Undo / Redo / Publish row, the pencil or the banner
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    let under = 0, where = -1;
    for (let y = 0; y < total; y += 61) {
      await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: 'instant' }), y);
      await page.waitForTimeout(35);
      const n = await page.evaluate(() => {
        const held = ['#kiln-quick', '#kiln-fab', '#kiln-sandbox-banner'].map(q => document.querySelector(q)?.getBoundingClientRect()).filter(r => r && r.width && r.height);
        return [...document.querySelectorAll('.kiln-block-gap')].filter(g => {
          const cs = getComputedStyle(g);
          if (cs.visibility === 'hidden' || (cs.opacity === '0' && !g.matches(':hover'))) return false;
          const r = g.getBoundingClientRect();
          return held.some(h => r.top < h.bottom && r.bottom > h.top);
        }).length;
      });
      if (n > under) { under = n; where = y; }
    }
    check(scope, 'no "+ Add section" divider ever sits under the Undo, Redo and Publish row, the pencil or the banner', under === 0, under ? `${under} at scroll ${where}` : '');
  }

  // ── the publish sheet: see it, drop one edit, publish ──────────────────────
  // a second edit, so there is one to drop
  const para = page.locator('p.kiln-field:not([data-cms-plain])').first();
  const paraBefore = (await para.count()) ? await read(para) : '';
  if (await para.count()) {
    await para.scrollIntoViewIfNeeded();
    await press(para);
    await page.waitForTimeout(300);
    await page.keyboard.type(' Extra');
    await press(page.locator('#kiln-toolbar .kiln-tb-save'));
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(250);
  const sheet = page.locator('#kiln-modal.kiln-pubsheet .kiln-modal-card');
  const go = page.locator('#kiln-pubsheet-go');
  const rows = page.locator('.kiln-ps-item');
  if (name) await press(publish);
  await page.waitForTimeout(500);
  check(scope, 'Publish opens a sheet with one row per edit', (await sheet.count()) === 1 && (await rows.count()) === 2, `${await rows.count()} rows`);
  if (await sheet.count()) {
    const said = await read(sheet);
    check(scope, 'the sheet shows the heading before and after', said.toLowerCase().includes(`before ${before} after ${before} hello`.toLowerCase()), said.slice(0, 140));
    check(scope, 'the sheet has one primary action, named for the edits', (await go.textContent()).trim() === 'Publish 2 edits' && (await sheet.locator('.kiln-btn-publish').count()) === 1, (await go.textContent()).trim());
    const c = await box(sheet);
    check(scope, 'the sheet fits on screen', c.left >= 0 && c.top >= 0 && c.right <= size.width + 0.5 && c.bottom <= size.height + 0.5, `${Math.round(c.left)},${Math.round(c.top)} to ${Math.round(c.right)},${Math.round(c.bottom)}`);
    if (phone) check(scope, 'on a phone the sheet sits along the bottom edge', Math.abs(c.bottom - size.height) <= 1 && Math.abs(c.right - c.left - size.width) <= 1);
    check(scope, 'the sheet\'s Publish can be pressed', ...Object.values(await hit(go)));
    check(scope, 'the sheet\'s Cancel can be pressed', ...Object.values(await hit(sheet.getByRole('button', { name: 'Cancel' }))));
    if (firstVisit) {
      check(scope, 'guide step 2 follows Publish into the sheet', ((await guide.locator('span').first().textContent().catch(() => '')) || '') === 'This is what changes. Publish it.' && await guide.isVisible());
      await page.waitForTimeout(200);
      const g = await box(guide);
      check(scope, 'and covers neither the note nor the buttons', apart(g, await box(page.locator('#kiln-ps-note'))) && apart(g, await box(go)) && apart(g, await box(sheet.getByRole('button', { name: 'Cancel' }))));
      await shot('guide-2-sheet');
    } else await shot('publish-sheet');
    // Escape closes it and loses nothing
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    check(scope, 'Escape closes the sheet and keeps every edit', (await sheet.count()) === 0 && ((await publish.textContent().catch(() => '')) || '').trim() === 'Publish 2 edits');
    await press(publish);
    await page.waitForTimeout(400);
    // drop the second edit
    await press(rows.nth(1).locator('.kiln-ps-drop'));
    await page.waitForTimeout(350);
    check(scope, 'dropping one edit leaves the other', (await rows.count()) === 1 && (await go.textContent()).trim() === 'Publish 1 edit', `${await rows.count()} rows, "${(await go.textContent()).trim()}"`);
    check(scope, 'the dropped edit is off the page', (await read(para)) === paraBefore, (await read(para)).slice(0, 60));
    check(scope, 'the kept edit is still on the page', (await read(heading)) === `${before} Hello`);
    await press(go);
  }
  await page.waitForTimeout(600);
  check(scope, 'the sheet closes on publish', (await sheet.count()) === 0);
  check(scope, 'Publish goes away once there is nothing unpublished', (await page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).count()) === 0);
  const undoBtn = status.locator('.kiln-status-act');
  check(scope, 'the confirmation says it is published and offers Undo', /^Published/.test((await status.innerText().catch(() => '')) || '') && (await undoBtn.count()) === 1 && (await undoBtn.textContent()).trim() === 'Undo',
    ((await status.innerText().catch(() => '')) || '').replace(/\n/g, ' '));
  if (!firstVisit && await undoBtn.count()) {
    check(scope, 'Undo can be pressed', ...Object.values(await hit(undoBtn)));
    await shot('published-undo');
    await press(undoBtn);
    await page.waitForTimeout(450);
    const again = page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).first();
    check(scope, 'Undo brings the edit back as unpublished', (await again.count()) === 1 && (await again.textContent()).trim() === 'Publish 1 edit' && (await read(heading)) === `${before} Hello`,
      ((await status.innerText().catch(() => '')) || '').replace(/\n/g, ' '));
    check(scope, 'Undo says what it did', /^Undone/.test((await status.innerText().catch(() => '')) || ''));
    // and the page keeps the undo across a reload: the edit is not in the saved copy
    await press(again);
    await page.waitForTimeout(400);
    await press(go);
    await page.waitForTimeout(500);
  }
  if (firstVisit) {
    const card = page.locator('#kiln-guide-card');
    await card.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    const text = (await card.count()) ? await read(card) : '';
    check(scope, 'guide step 3 is titled "That was a Git commit"', /^That was a Git commit/.test(text));
    check(scope, 'guide step 3 shows the old and the new text', text.toLowerCase().includes(`before ${before} after ${before} hello`.toLowerCase()),
      (/before .* commit message/i.exec(text) || [''])[0].slice(0, 120));
    check(scope, 'guide step 3 shows the commit message', /Edit [\w./-]+: [\w-]+ \(via Kiln\)/.test(text), (/Edit .*\(via Kiln\)/.exec(text) || [''])[0]);
    const link = card.getByRole('link', { name: 'Put Kiln on my site' });
    check(scope, 'guide step 3 links to the get-started page', (await link.count()) === 1 && (await link.getAttribute('href')) === 'https://kilncms.com/get-started.html');
    if (await card.count()) {
      const c = await box(card);
      check(scope, 'guide step 3 fits on screen', c.left >= 0 && c.top >= 0 && c.right <= size.width && c.bottom <= size.height);
      let clear = apart(c, await box(pencil));
      if (await banner.isVisible()) clear = clear && apart(c, await box(banner));
      if (await status.isVisible()) clear = clear && apart(c, await box(status));
      check(scope, 'guide step 3 covers none of pencil, banner, status', clear);
    }
    await shot('guide-3');
    // Undo with the card still up: it must stop saying a commit happened.
    if (await undoBtn.count()) {
      check(scope, 'Undo can be pressed while guide step 3 is up', ...Object.values(await hit(undoBtn)));
      await press(undoBtn);
      await page.waitForTimeout(450);
      const after = (await card.count()) ? await read(card) : '';
      check(scope, 'after Undo the card says the edit is back, not published', /^Your edit is back, not published/.test(after) && !/That was a Git commit/.test(after), after.slice(0, 80));
      check(scope, 'after Undo the card names the commit an undo makes', /Undo "Edit [\w./-]+: [\w-]+" \(via Kiln\)/.test(after), (/Undo ".*\(via Kiln\)/.exec(after) || [''])[0]);
      const again = page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).first();
      check(scope, 'after Undo the edit is on the page, unpublished', (await again.count()) === 1 && (await again.textContent()).trim() === 'Publish 1 edit' && (await read(heading)) === `${before} Hello`);
      if (await card.count()) {
        const c = await box(card);
        let clear = c.left >= 0 && c.top >= 0 && c.right <= size.width && c.bottom <= size.height && apart(c, await box(pencil));
        if (await banner.isVisible()) clear = clear && apart(c, await box(banner));
        if (await status.isVisible()) clear = clear && apart(c, await box(status));
        if (await again.count()) clear = clear && apart(c, await box(again));
        check(scope, 'after Undo the card fits on screen and covers none of pencil, banner, status, Publish', clear);
      }
      await shot('guide-3-undone');
    }
    const keep = card.getByRole('button', { name: 'Keep exploring' });
    if (await keep.count()) await press(keep);
    await page.waitForTimeout(200);
    check(scope, '"Keep exploring" closes the guide', (await card.count()) === 0 && (await guide.count()) === 0);
    if (phone && await banner.count()) check(scope, 'with the guide gone, the demo banner is back', await banner.isVisible());
    await page.reload({ waitUntil: 'load' });
    await pencil.waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(700);
    check(scope, 'the guide is not shown a second time', (await guide.count()) === 0 && (await page.locator('#kiln-guide-card').count()) === 0);
  }
  // ── Help in the menu ───────────────────────────────────────────────────────
  if (!firstVisit) {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    if (!(await menu.isVisible())) await press(pencil);
    await page.waitForTimeout(300);
    const help = page.locator('#kiln-help');
    // the demo's menu is the full menu of a real site: on a phone its last items are a scroll of the sheet away
    await help.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(150);
    check(scope, 'the menu has Help, and it can be pressed', (await help.isVisible().catch(() => false)) && (await hit(help)).ok);
    await shot('help-in-menu');
    const popup = context.waitForEvent('page', { timeout: 3000 }).catch(() => null);
    if (await help.count()) await press(help);
    const tab = await popup;
    check(scope, 'Help opens the editors\' guide in a new tab', !!tab && (await help.getAttribute('data-href')) === 'https://kilncms.com/editors', tab ? tab.url() : 'no new tab');
    if (tab) { forget(blocked, 'https://kilncms.com/editors'); await tab.close().catch(() => {}); }
  }
  check(scope, 'no script errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  check(scope, 'nothing outside the local server was needed', blocked.length === 0, blocked.slice(0, 3).join(', '));
  await context.close();
}

/**
 * The safety net, in sandbox mode: what a person tries right after a first
 * edit. Lists first: remove, add, reorder and duplicate a block, and after
 * each press Undo and then Redo. Every block of the list must be there to be
 * SEEN each time (a site that fades its blocks in on scroll hides any block
 * that is written to the page as a new element), and the blocks that were on
 * the page must still be the same elements.
 */
async function runSafetyNet(browser, size) {
  const phone = size.width < 600;
  const scope = `${size.width}x${size.height} safety net  `;
  const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone, reducedMotion: 'no-preference' });
  const blocked = [];
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(ORIGIN) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    return refuse(route, blocked);
  });
  await context.addInitScript(() => { try { localStorage.setItem('kiln_guide', '1'); } catch { /* ignore */ } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const boxes = [];   // the browser's own confirm / alert boxes
  page.on('dialog', async (d) => { boxes.push(d.message()); await d.accept().catch(() => {}); });
  const press = (locator) => (phone ? locator.tap() : locator.click());
  const shot = async (step) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${step}-${size.width}.png`) }); };
  const undo = page.locator('#kiln-undo-btn'), redo = page.locator('#kiln-redo-btn');
  const opened = [];   // tabs a click opened
  context.on('page', (p) => { if (p !== page) { opened.push(p.url()); p.close().catch(() => {}); } });
  await page.goto(URL_ARG, { waitUntil: 'load' });
  await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(500);

  // ── lists: Undo and Redo after remove, add, reorder, duplicate ─────────────
  const keys = await page.evaluate(() => [...document.querySelectorAll('[data-cms-repeat]:not([data-kiln-gallery]):not([data-kiln-events])')]
    .filter(l => l.querySelectorAll(':scope > .kiln-repeat-item').length >= 3).map(l => l.getAttribute('data-cms-repeat')).slice(0, 2));
  check(scope, 'the page has a list of three or more blocks to check', keys.length > 0);
  const blocksOf = (key) => `[data-cms-repeat="${key}"] > .kiln-repeat-item`;
  /** Bring every block of a list through the screen, then say what a person can see of each. */
  const look = async (key) => {
    const n = await page.locator(blocksOf(key)).count();
    for (let i = 0; i < n; i += 2) {
      await page.evaluate(([q, at]) => document.querySelectorAll(q)[at]?.scrollIntoView({ block: 'center', behavior: 'instant' }), [blocksOf(key), i]);
      await page.waitForTimeout(70);
    }
    await page.waitForTimeout(950);   // a fade-in has finished
    return page.evaluate((q) => [...document.querySelectorAll(q)].map((el) => {
      const cs = getComputedStyle(el);
      return { seen: cs.opacity === '1' && cs.visibility !== 'hidden' && el.getBoundingClientRect().height > 0,
        mark: el.__uiCheck ?? null, bars: el.querySelectorAll(':scope > .kiln-item-ctl, :scope > .kiln-ctl-cell').length };
    }), blocksOf(key));
  };
  const allSeen = (list) => list.every(b => b.seen);
  const told = (list) => `${list.filter(b => b.seen).length} of ${list.length} can be seen`;
  for (const key of keys) {
    const list = page.locator(`[data-cms-repeat="${key}"]`);
    const second = list.locator(':scope > .kiln-repeat-item').nth(1);
    const start = await look(key);
    check(scope, `list "${key}": every block can be seen to begin with`, allSeen(start), told(start));
    const bar = async (title) => {
      await inReach(page, second);
      if (phone) { await second.locator('.kiln-ctl-more').tap(); await page.waitForTimeout(250); } else { await second.hover(); await page.waitForTimeout(250); }
      await press(second.locator(`button[title="${title}"]`));
      await page.waitForTimeout(400);
    };
    const changes = {
      remove: () => bar('Remove this block'),
      add: async () => { const add = page.locator(`.kiln-repeat-add[data-kiln-add="${key}"]`).first(); await add.scrollIntoViewIfNeeded(); await press(add); await page.waitForTimeout(500); },
      reorder: () => bar('Move down'),
      duplicate: () => bar('Duplicate this block'),
    };
    for (const [what, change] of Object.entries(changes)) {
      // mark the elements that are the list now
      await page.evaluate((q) => document.querySelectorAll(q).forEach((el, i) => { el.__uiCheck = i; }), blocksOf(key));
      const order = (l) => l.map(b => b.mark).join(',');
      const before = await look(key);
      await change();
      const changed = await page.locator(blocksOf(key)).count();
      check(scope, `list "${key}", ${what}: the change is made`, what === 'reorder' ? order(await look(key)) !== order(before) : changed === before.length + (what === 'remove' ? -1 : 1), `${before.length} -> ${changed}`);
      // Undo: with the button, and the second time round with the keyboard (laptop)
      await press(undo);
      await page.waitForTimeout(700);
      let now = await look(key);
      check(scope, `list "${key}", ${what}, Undo: the list is as it was and every block can be seen`, now.length === before.length && allSeen(now) && order(now) === order(before), `${told(now)}; ${order(now)}`);
      check(scope, `list "${key}", ${what}, Undo: every block has its controls, once`, now.every(b => b.bars === 1));
      if (what === 'remove') await shot(`list-undo-remove-${key}`);
      await press(redo);
      await page.waitForTimeout(700);
      now = await look(key);
      check(scope, `list "${key}", ${what}, Redo: the change is back and every block can be seen`, now.length === changed && allSeen(now) && now.every(b => b.bars === 1), told(now));
      if (phone) await press(undo);
      else { await page.mouse.click(3, size.height / 2); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z'); }
      await page.waitForTimeout(700);
      now = await look(key);
      check(scope, `list "${key}", ${what}, Undo ${phone ? 'again' : 'from the keyboard'}: back as it was, every block seen`, now.length === before.length && allSeen(now) && order(now) === order(before), `${told(now)}; ${order(now)}`);
    }
  }
  check(scope, 'with every change undone, nothing is unpublished', (await page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).count()) === 0);

  // ── removing a block: at once, with the editor's own way back ──────────────
  check(scope, 'removing a block never opens the browser\'s own box', boxes.length === 0, (boxes[0] || '').slice(0, 60));
  if (keys.length) {
    const key = keys[keys.length - 1];
    const second = page.locator(`[data-cms-repeat="${key}"] > .kiln-repeat-item`).nth(1);
    await page.evaluate((q) => document.querySelectorAll(q).forEach((el, i) => { el.__uiCheck = i; }), blocksOf(key));
    const before = await look(key);
    // (look() leaves the page wherever the last block it looked at is: the block is brought back within reach each time)
    const reach = async () => {
      await inReach(page, second);
      if (phone) { await second.locator('.kiln-ctl-more').tap(); await page.waitForTimeout(250); } else { await second.hover(); await page.waitForTimeout(250); }
    };
    await reach();
    await press(second.locator('button[title="Remove this block"]'));
    await page.waitForTimeout(400);
    const line = page.locator('#kiln-status');
    const way = line.locator('.kiln-status-act');
    const said = ((await line.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    check(scope, 'the block is gone at once, and the line reads "Removed." with an Undo button', (await page.locator(blocksOf(key)).count()) === before.length - 1
      && /^Removed\. ?Undo$/.test(said) && (await way.count()) === 1 && (await line.isVisible()), said);
    if (await way.count()) {
      check(scope, 'that Undo can be pressed', ...Object.values(await hit(way)));
      await shot('removed-undo');
      await press(way);
      await page.waitForTimeout(700);
      const now = await look(key);
      check(scope, 'it puts the block back where it was, there to be seen', now.length === before.length && allSeen(now) && now.map(b => b.mark).join(',') === before.map(b => b.mark).join(','), told(now));
    }
    // once something else has been changed, that button would undo the wrong thing: the line has gone
    await reach();
    await press(second.locator('button[title="Remove this block"]'));
    await page.waitForTimeout(300);
    await reach();
    await press(second.locator('button[title="Duplicate this block"]'));
    await page.waitForTimeout(300);
    check(scope, 'after another change the "Removed. Undo" line is put away', !(await line.isVisible()) || !/^Removed/.test((await line.innerText()) || ''));
    await press(undo); await page.waitForTimeout(400);
    await press(undo); await page.waitForTimeout(600);
    check(scope, 'and the two Undo presses beside the pencil bring the list back', (await page.locator(blocksOf(key)).count()) === before.length && allSeen(await look(key)));
  }
  // a block that is itself a link (a card that opens its page) is not followed when one of its buttons is pressed
  check(scope, 'pressing a block\'s buttons opened no other page', opened.length === 0 && blocked.length === 0 && page.url() === URL_ARG, [...opened, ...blocked].slice(0, 2).join(', '));

  // ── the rest of the safety net: a draft, the restore offer, Schedule, the menu, History ──
  const words = async (locator) => ((await locator.count()) ? ((await locator.first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim() : '');
  const status = page.locator('#kiln-status');
  const dialog = page.locator('#kiln-modal .kiln-modal-card');
  const pencil = page.locator('#kiln-fab');
  const menu = page.locator('#kiln-fab-menu');
  const toTop = () => page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  const started = async () => { await pencil.waitFor({ state: 'visible', timeout: 15000 }); await page.waitForTimeout(900); };
  const item = async (id) => {
    await toTop();
    if (!(await menu.isVisible())) { await press(pencil); await page.waitForTimeout(350); }
    const b = page.locator(`#${id}`);
    await b.scrollIntoViewIfNeeded().catch(() => {});
    await press(b);
    await page.waitForTimeout(600);
  };
  const putAway = async () => {
    for (let i = 0; i < 3 && await page.locator('#kiln-modal').count(); i++) { await page.locator('#kiln-modal [data-close]').first().click().catch(() => {}); await page.waitForTimeout(200); }
  };
  const heading = page.locator('h1.kiln-field, h2.kiln-field, h3.kiln-field').first();
  const key = await heading.getAttribute('data-cms');
  const read = async () => (await heading.innerText()).replace(/\s+/g, ' ').trim();
  const original = await read();
  const retype = async (text) => {
    await heading.scrollIntoViewIfNeeded();
    await press(heading);
    await page.waitForTimeout(350);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
    await page.keyboard.type(text);
    await press(page.locator('#kiln-toolbar .kiln-tb-save'));
    await page.waitForTimeout(400);
  };
  const publishNow = async () => {
    await toTop();
    await press(page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).first());
    await page.waitForTimeout(450);
    await press(page.locator('#kiln-pubsheet-go'));
    await page.waitForTimeout(600);
  };
  const plain = (text) => !/!|[—–]| - |Cannot read|undefined|null|forbidden|TypeError|failed/i.test(text);

  // names: what the person editing reads is not the developer's name for the field
  await heading.scrollIntoViewIfNeeded();
  const hint = (await heading.getAttribute('title')) || '';
  check(scope, 'the hover hint names the field in words', /^Edit: [A-Z]/.test(hint) && !hint.includes('_') && !hint.includes(key), hint);
  await press(heading);
  await page.waitForTimeout(350);
  if (!phone) {
    const label = page.locator('#kiln-toolbar .kiln-tb-label');
    check(scope, 'the toolbar is labelled in words, and keeps the stored name as its title', !((await label.textContent()) || '').includes('_') && (await label.getAttribute('title')) === key, `${await label.textContent()} / ${await label.getAttribute('title')}`);
  }
  // ✨: says what it is, beside the button
  const spark = page.locator('#kiln-toolbar #kiln-ai');
  if (await spark.count()) {
    await press(spark);
    await page.waitForTimeout(400);
    const note = page.locator('#kiln-ai-menu');
    const said = await words(note);
    check(scope, 'the ✨ button says what it is and where it works', /^Nothing here in the demo\. On a real site, /.test(said) && plain(said) && await note.isVisible(), said.slice(0, 90));
    if (await note.count()) {
      const n = await box(note), s2 = await box(spark);
      if (!phone) check(scope, 'and says it beside the button, on screen', Math.abs(n.left - s2.left) < 40 && Math.abs(n.top - s2.bottom) < 40 && n.right <= size.width && n.bottom <= size.height, `note at ${Math.round(n.left)},${Math.round(n.top)}; button at ${Math.round(s2.left)},${Math.round(s2.bottom)}`);
      await shot('sparkle-note');
      await press(note.getByRole('button', { name: 'Got it' }));
      await page.waitForTimeout(250);
      check(scope, '"Got it" puts the note away and the edit stays open', (await note.count()) === 0 && (await page.locator('#kiln-toolbar').count()) === 1);
    }
  }
  let said = '';
  // the link button: the editor's own dialog, never the browser's box, and the edit stays open under it
  const linkBtn = page.locator('#kiln-toolbar [data-cmd="link"]');
  if (await linkBtn.count()) {
    const picked = await heading.evaluate((el) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walk.nextNode())) if (n.nodeValue.trim().length >= 4) break;
      const at = n.nodeValue.indexOf(n.nodeValue.trim());
      const r = document.createRange();
      r.setStart(n, at); r.setEnd(n, at + 4);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return s.toString();
    });
    const here = () => heading.evaluate((el) => ({ sel: getSelection().toString(), focus: document.activeElement === el, a: el.querySelector('a') ? `${el.querySelector('a').getAttribute('href')}|${el.querySelector('a').textContent}` : '' }));
    const box2 = page.locator('#kiln-link-url');
    await press(linkBtn);
    await page.waitForTimeout(400);
    said = await words(dialog);
    check(scope, 'the link button opens the editor\'s own dialog: one box, "Add link", Cancel', /^(✕ )?Add a link/.test(said) && (await box2.count()) === 1 && (await dialog.getByRole('button', { name: 'Add link' }).count()) === 1
      && (await dialog.getByRole('button', { name: 'Cancel' }).count()) === 1 && (await dialog.getByRole('button', { name: 'Remove link' }).count()) === 0, said.slice(0, 80));
    check(scope, 'and never the browser\'s box', boxes.length === 0, (boxes[0] || '').slice(0, 50));
    check(scope, 'the cursor is in the address box', await box2.evaluate((el) => document.activeElement === el).catch(() => false));
    const c = (await dialog.count()) ? await box(dialog) : null;
    check(scope, 'the link dialog fits on screen', !!c && c.left >= 0 && c.top >= 0 && c.right <= size.width + 0.5 && c.bottom <= size.height + 0.5);
    await shot('link-dialog');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    let now = await here();
    check(scope, 'Escape cancels: the edit is still open, the cursor is back in it and the selection is as it was', (await page.locator('#kiln-modal').count()) === 0 && (await page.locator('#kiln-toolbar').count()) === 1
      && now.focus && now.sel === picked && now.a === '', JSON.stringify(now));
    await press(linkBtn);
    await page.waitForTimeout(350);
    if (await box2.count()) { await box2.fill('/about'); await page.keyboard.press('Enter'); }
    await page.waitForTimeout(350);
    now = await here();
    check(scope, 'an address and Enter make the selected words a link, with the selection kept and the edit open', now.a === `/about|${picked}` && now.focus && now.sel === picked && (await page.locator('#kiln-toolbar').count()) === 1, JSON.stringify(now));
    // the cursor inside that link, nothing selected
    await heading.evaluate((el) => { const a = el.querySelector('a'); if (!a) return; const r = document.createRange(); r.setStart(a.firstChild, 2); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    await press(linkBtn);
    await page.waitForTimeout(350);
    said = await words(dialog);
    check(scope, 'with the cursor in a link the dialog holds its address and offers "Change link" and "Remove link"', /^(✕ )?Change this link/.test(said) && (await box2.inputValue().catch(() => '')) === '/about'
      && (await dialog.getByRole('button', { name: 'Change link' }).count()) === 1 && (await dialog.getByRole('button', { name: 'Remove link' }).count()) === 1, said.slice(0, 80));
    if (phone && await dialog.count()) {
      const lines = await dialog.locator('.kiln-modal-actions button').evaluateAll((bs) => bs.map((b) => { const r = document.createRange(); r.selectNodeContents(b); return new Set([...r.getClientRects()].map(x => Math.round(x.top))).size; }));
      check(scope, 'its three buttons are each on one line', lines.length === 3 && lines.every(n => n === 1), lines.join(','));
    }
    await shot('link-dialog-change');
    if (await dialog.getByRole('button', { name: 'Remove link' }).count()) await press(dialog.getByRole('button', { name: 'Remove link' }));
    await page.waitForTimeout(350);
    now = await here();
    check(scope, '"Remove link" takes the link off and keeps the words', now.a === '' && now.focus && (await read()).includes(picked) && (await page.locator('#kiln-toolbar').count()) === 1, JSON.stringify(now));
  }
  if (await page.locator('#kiln-toolbar .kiln-tb-cancel').count()) await press(page.locator('#kiln-toolbar .kiln-tb-cancel'));
  await page.waitForTimeout(250);

  // Save as draft: kept in this browser, said so, offered back
  await retype('A draft of the heading');
  await item('kiln-draft');
  said = await words(status);
  check(scope, 'Save as draft works in the demo and says where the draft is', /^Draft saved in this browser\./.test(said) && plain(said), said.slice(0, 110));
  check(scope, 'the draft is put aside: nothing is waiting to be published', (await page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).count()) === 0);
  await shot('draft-saved');
  await page.reload({ waitUntil: 'load' });
  await started();
  check(scope, 'the next visit offers the draft back', /^(✕ )?There's a saved draft of this page/.test(await words(dialog)) && (await read()) === original, (await words(dialog)).slice(0, 60));
  if (await dialog.count()) {
    const lay = await dialog.evaluate((card) => {
      const c = card.getBoundingClientRect();
      const bs = [...card.querySelectorAll('.kiln-modal-actions button')].map((b) => {
        const r = b.getBoundingClientRect();
        const t = document.createRange(); t.selectNodeContents(b);
        return { name: b.textContent.trim(), l: r.left, r: r.right, t: r.top, b: r.bottom, lines: new Set([...t.getClientRects()].map(x => Math.round(x.top))).size,
          primary: b.classList.contains('kiln-btn-publish'), inside: r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && r.bottom <= c.bottom + 0.5 };
      });
      const over = bs.some((a, i) => bs.some((o, j) => j > i && !(a.r <= o.l || o.r <= a.l || a.b <= o.t || o.b <= a.t)));
      return { bs, over };
    });
    check(scope, 'the draft\'s choices are each on one line, inside the dialog, none on another', lay.bs.length >= 3 && lay.bs.every(b => b.lines === 1 && b.inside) && !lay.over,
      lay.bs.map(b => `${b.name}:${b.lines}${b.inside ? '' : ' outside'}`).join(', '));
    check(scope, '"Resume draft" is the one plain primary choice, and the last', lay.bs.filter(b => b.primary).map(b => b.name).join() === 'Resume draft' && lay.bs[lay.bs.length - 1].name === 'Resume draft');
  }
  await shot('draft-offered');
  if (await page.locator('#kiln-dr-resume').count()) await press(page.locator('#kiln-dr-resume'));
  await page.waitForTimeout(500);
  check(scope, 'Resume draft puts it on the page, unpublished', (await read()) === 'A draft of the heading' && (await words(page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).first())) === 'Publish 1 edit');

  // "Pick up where you left off?": an edit that was not published is there after a reload
  await page.reload({ waitUntil: 'load' });
  await started();
  said = await words(dialog);
  check(scope, 'after a reload the unpublished edit is offered back', /Pick up where you left off\?/.test(said) && /1 unpublished edit/.test(said), said.slice(0, 120));
  check(scope, 'and it names the part in words', !said.includes(key) && !/\([a-z0-9]+_[a-z0-9_]+\)/.test(said), said.slice(-50));
  await shot('restore-offered');
  if (await page.locator('#kiln-rest-yes').count()) await press(page.locator('#kiln-rest-yes'));
  await page.waitForTimeout(500);
  check(scope, 'Restore edits brings it back, ready to publish', (await read()) === 'A draft of the heading' && (await words(page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).first())) === 'Publish 1 edit');

  // Schedule: what a real site does, and nothing asked of a worker
  await item('kiln-schedule');
  said = await words(dialog);
  check(scope, 'Schedule says what a real site does, in the demo\'s words', /Nothing is scheduled in the demo\. On a real site, /.test(said) && plain(said.replace(/Schedule (this edit|these \d+ edits) Kiln .*? rebuilds\./, '')) && !/these 1 edit/.test(said), said.slice(-150));
  await shot('schedule');
  if (await page.locator('#kiln-sc-go').count()) await press(page.locator('#kiln-sc-go'));
  await page.waitForTimeout(300);
  check(scope, 'pressing Schedule says the edit is still here', /^Nothing is scheduled in the demo\. Your edit is still here/.test(await words(page.locator('#kiln-sc-status'))), await words(page.locator('#kiln-sc-status')));
  await putAway();

  // the menu is the menu of a real site, and each item opens its own dialog and says something plain
  await toTop();
  if (!(await menu.isVisible())) { await press(pencil); await page.waitForTimeout(350); }
  const shown = await page.evaluate(() => [...document.querySelectorAll('#kiln-fab-menu button')].filter(b => b.getClientRects().length).map(b => b.id));
  const wanted = ['kiln-newpost', 'kiln-pagesettings', 'kiln-history', 'kiln-menu', 'kiln-findreplace', 'kiln-invite', 'kiln-theme', 'kiln-suggestions', 'kiln-settings', 'kiln-help', 'kiln-done'];
  check(scope, 'the demo\'s menu has what a real site\'s menu has', wanted.every(id => shown.includes(id)), wanted.filter(id => !shown.includes(id)).join(', '));
  check(scope, 'and leaves out Comments and Sign out', !shown.includes('kiln-comments') && !shown.includes('kiln-signout'));
  {
    const m = await box(menu), p = await box(pencil), done = page.locator('#kiln-done');
    check(scope, 'the open menu lies inside the screen', m.top >= 0 && m.bottom <= size.height + 0.5 && m.left >= 0 && m.right <= size.width + 0.5, `${Math.round(m.top)} to ${Math.round(m.bottom)} of ${size.height}`);
    check(scope, '"Done editing" is in sight without scrolling, and can be pressed', (await done.isVisible()) && (await hit(done)).ok);
    // no item of the menu lies under the pencil where it can be seen (the foot is the pencil's own strip)
    const under = await page.evaluate(() => {
      const f = document.querySelector('#kiln-fab').getBoundingClientRect();
      const foot = document.querySelector('.kiln-fab-foot').getBoundingClientRect();
      return [...document.querySelectorAll('#kiln-fab-menu .kiln-fab-item')].filter(b => b.getClientRects().length).filter((b) => {
        const r = b.getBoundingClientRect();
        const bottom = Math.min(r.bottom, foot.top);
        return r.right > f.left && r.left < f.right && bottom > f.top + 1 && r.top < f.bottom;
      }).map(b => b.textContent.trim());
    });
    check(scope, 'the pencil lies on none of the menu\'s items', under.length === 0, under.join(', '));
    if (!phone) check(scope, 'the menu ends above the pencil', m.bottom <= p.top + 0.5);
    await shot('full-menu');
  }
  if (phone) { await press(pencil); await page.waitForTimeout(250); }
  const acts = { 'kiln-newpost': ['#kiln-np-go', '#kiln-np-said', 'Nothing is created in the demo'], 'kiln-pagesettings': ['#kiln-ps-go', '#kiln-ps-status', 'Nothing is saved in the demo'],
    'kiln-menu': ['#kiln-menu-save', '#kiln-menu-status', 'Nothing is saved in the demo'], 'kiln-findreplace': ['#kiln-fr-scan', '#kiln-fr-status', 'Nothing is replaced in the demo'],
    'kiln-invite': ['#kiln-p-add', '#kiln-people-list', 'Nobody is added in the demo'] };
  for (const [id, [go, where, says]] of Object.entries(acts)) {
    await item(id);
    const opened = (await dialog.count()) === 1;
    for (const [sel, value] of [['#kiln-np-title', 'A new page'], ['#kiln-fr-find', 'shirt'], ['#kiln-fr-repl', 'tee'], ['#kiln-p-email', 'pat@example.com']]) { if (await page.locator(sel).count()) await page.locator(sel).fill(value); }
    if (await page.locator(go).count()) { await page.locator(go).scrollIntoViewIfNeeded().catch(() => {}); await press(page.locator(go)); }
    await page.waitForTimeout(400);
    said = await words(page.locator(where));
    check(scope, `"${id.replace('kiln-', '')}" opens its own dialog and says the demo's sentence where it would act`, opened && said.startsWith(says) && plain(said), said.slice(0, 100));
    await putAway();
  }
  // Theme and Search & jump speak to an editor
  await item('kiln-theme');
  await page.waitForTimeout(500);
  said = await words(dialog.locator('p').first());
  const settings = await page.locator('.kiln-th-name').allTextContents();
  check(scope, 'Theme is said in an editor\'s words, and names its settings without the stylesheet\'s dashes', /^The site’s colors and type sizes\./.test(said) && !/CSS|:root/.test(said)
    && settings.length > 0 && !settings.some(n => /--/.test(n)), `${said.slice(0, 60)} / ${settings.slice(0, 4).join(', ')}`);
  await putAway();
  await item('kiln-palette-btn');
  const names = await page.locator('.kiln-pal-item .kiln-pal-name').allTextContents();
  check(scope, 'Search & jump lists this page\'s parts in words', names.length > 0 && !names.some(n => /_/.test(n)) && !names.includes('hero img'), names.slice(-4).join(' | '));
  await page.locator('.kiln-pal-input').fill('history');
  await page.waitForTimeout(350);
  const found = await page.locator('.kiln-pal-item .kiln-pal-name').allTextContents();
  check(scope, 'typing "history" finds History, not parts that only share its letters', found[0] === 'History & restore' && found.every(n => /history/i.test(n)), found.join(' | '));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await putAway();

  // History: publish twice, and get the first one back
  await retype('First version');
  await publishNow();
  await retype('Second version');
  await publishNow();
  await item('kiln-history');
  const rows = page.locator('#kiln-hist .kiln-hist-row');
  check(scope, 'History lists the demo\'s publishes, newest first, the newest marked live', (await rows.count()) >= 2 && /live now/.test(await words(rows.first())), `${await rows.count()} rows`);
  check(scope, 'each has "Undo this change", and all but the newest "Go back to this"', (await rows.first().locator('[data-act="undo"]').count()) === 1 && (await rows.first().locator('[data-act="restore"]').count()) === 0 && (await rows.nth(1).locator('[data-act="restore"]').count()) === 1);
  await shot('history');
  if (await rows.nth(1).locator('[data-act="restore"]').count()) await press(rows.nth(1).locator('[data-act="restore"]'));
  await page.waitForTimeout(700);
  const bar = page.locator('#kiln-previewbar');
  check(scope, '"Go back to this" shows the earlier version on the page first', (await bar.isVisible().catch(() => false)) && (await read()) === 'First version', `${await read()} / ${(await words(bar)).slice(0, 50)}`);
  await shot('history-preview');
  const barWords = (await words(bar).catch(() => '')).replace(/\s+/g, ' ');
  check(scope, 'the bar says what is left to do, and its buttons are Cancel and Keep', /Nothing is live yet\. Keep it, then press Publish\./.test(barWords) && (await page.locator('#kiln-pv-keep').innerText().catch(() => '')) === 'Keep' && !/—/.test(barWords), barWords.slice(0, 140));
  if (phone && await bar.isVisible().catch(() => false)) {
    const b = await box(bar);
    const line = page.locator('#kiln-status');
    const st = (await line.isVisible().catch(() => false)) ? await box(line) : null;
    check(scope, 'on a phone it is as wide as the screen, clear of the top and of the status line', b.width > size.width - 40 && b.top > 120 && (!st || apart(b, st)), `${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}`);
    check(scope, 'and clear of the pencil', apart(b, await box(pencil)));
  }
  if (await page.locator('#kiln-pv-keep').count()) await press(page.locator('#kiln-pv-keep'));
  await page.waitForTimeout(400);
  await publishNow();
  await page.reload({ waitUntil: 'load' });
  await started();
  check(scope, 'kept and published, the first version is the page again', (await read()) === 'First version' && (await page.locator('#kiln-modal').count()) === 0, await read());
  // one section's clock lists that section's versions
  await heading.scrollIntoViewIfNeeded();
  await press(heading);
  await page.waitForTimeout(350);
  if (await page.locator('#kiln-toolbar [data-cmd="hist"]').count()) {
    await press(page.locator('#kiln-toolbar [data-cmd="hist"]'));
    await page.waitForTimeout(500);
    const list = await words(page.locator('#kiln-fh'));
    check(scope, 'a section\'s clock lists its versions, down to before the first publish', /First version/.test(list) && /Second version/.test(list) && /before your first publish/.test(list), list.slice(0, 120));
  }
  await putAway();

  // phone: a block's opened buttons cover none of the list's words
  if (phone && keys.length) {
    const key2 = keys[keys.length - 1];
    const second = page.locator(`[data-cms-repeat="${key2}"] > .kiln-repeat-item`).nth(1);
    await second.scrollIntoViewIfNeeded();
    await second.locator('.kiln-ctl-more').tap();
    await page.waitForTimeout(350);
    const covered = await page.evaluate((k) => {
      const item = document.querySelectorAll(`[data-cms-repeat="${k}"] > .kiln-repeat-item`)[1];
      const btns = [...item.querySelectorAll('.kiln-item-ctl button')].filter(b => b.getClientRects().length && !b.classList.contains('kiln-ctl-more')).map(b => b.getBoundingClientRect());
      return [...document.querySelectorAll(`[data-cms-repeat="${k}"] [data-cms]`)].filter((f) => {
        const r = f.getBoundingClientRect();
        return btns.some(b => b.right > r.left + 1 && b.left < r.right - 1 && b.bottom > r.top + 1 && b.top < r.bottom - 1);
      }).map(f => (f.textContent || '').trim().slice(0, 24));
    }, key2);
    check(scope, 'a block\'s opened buttons lie on none of the list\'s words', covered.length === 0, covered.join(' | '));
    await shot('row-buttons-open');
    await page.touchscreen.tap(4, size.height / 2);
    await page.waitForTimeout(200);
  }

  // Settings, Top bar: the top of the page is not slid under the bar
  await item('kiln-settings');
  if (await page.locator('input[name="kiln-uimode"][value="bar"]').count()) {
    await page.locator('input[name="kiln-uimode"][value="bar"]').check();
    await press(page.locator('#kiln-set-save'));
    await page.locator('#kiln-topbar').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(900);
    const top = await page.evaluate(() => {
      const barEl = document.querySelector('#kiln-topbar');
      const first = [...document.body.children].find(el => !el.id.startsWith('kiln-') && el.getBoundingClientRect().height > 0);
      return barEl && first ? { y: window.scrollY, bar: barEl.getBoundingClientRect().bottom, first: first.getBoundingClientRect().top } : null;
    });
    check(scope, 'choosing the top bar leaves the top of the page in sight under it', !!top && top.y === 0 && top.first >= top.bar - 1, top ? `scrolled ${top.y}, bar ends ${Math.round(top.bar)}, page starts ${Math.round(top.first)}` : 'no bar');
    await shot('top-bar');
  }

  check(scope, 'no script errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  check(scope, 'nothing outside the local server was needed', blocked.length === 0, blocked.slice(0, 3).join(', '));
  await context.close();
}

/**
 * The demo keeps its way to get Kiln in sight. A first-time visitor publishes:
 * while the card that offers "Put Kiln on my site" is up, the demo's pill does
 * not repeat it; from the moment the card goes ("Keep exploring", and in a
 * second visit by itself) the pill carries the same link, fits beside the
 * pencil with nothing overlapping and nothing cut, opens a new tab, is still
 * there after a reload, and goes with "Start over".
 */
/**
 * Undo must never hide what it restores. The editor used to copy each field's
 * markup as it started, while the site was still animating in, and Undo put
 * that copy back: on a site whose heading slides in, the invisible start of
 * the slide. History's "Undo this change" then published it.
 */
async function runUndoShows(browser, size) {
  const phone = size.width < 600;
  const scope = `${size.width}x${size.height} undo shows  `;
  const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone, reducedMotion: 'no-preference' });
  await context.route('**/*', (route) => {
    const u = route.request().url();
    return (u.startsWith(ORIGIN) || u.startsWith('data:') || u.startsWith('blob:')) ? route.continue() : route.abort();
  });
  await context.addInitScript(() => { try { localStorage.setItem('kiln_guide', '1'); } catch { /* ignore */ } });
  const page = await context.newPage();
  const press = (locator) => (phone ? locator.tap() : locator.click());
  const shot = async (step) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${step}-${size.width}.png`) }); };
  const started = async () => { await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 }); };
  await page.goto(URL_ARG, { waitUntil: 'load' });
  await started();
  // The page's first heading that is a field of its own, with elements inside it if there is one (lines an animation moves).
  const key = await page.evaluate(() => {
    const own = [...document.querySelectorAll('h1[data-cms], h2[data-cms]')].filter(h => !h.closest('[data-cms-repeat]') && h.classList.contains('kiln-field'));
    return (own.find(h => h.children.length) || own[0])?.getAttribute('data-cms') || null;
  });
  check(scope, 'the page has a heading to edit', !!key);
  if (!key) { await context.close(); return; }
  const heading = page.locator(`[data-cms="${key}"]`).first();
  /** What a person can see of the heading: its words, and whether it and everything inside it is fully opaque. */
  const look = () => heading.evaluate((h) => {
    const all = [h, ...h.querySelectorAll('*')];
    const dim = all.filter(e => getComputedStyle(e).opacity !== '1' || getComputedStyle(e).visibility === 'hidden').length;
    return { words: h.innerText.replace(/\s+/g, ' ').trim(), dim, tall: h.getBoundingClientRect().height > 4 };
  });
  const seen = (l, words) => l.dim === 0 && l.tall && l.words === words;
  const told = (l) => `"${l.words}", ${l.dim} not fully opaque`;
  const staged = () => page.evaluate((k) => {
    const at = Object.keys(localStorage).find(n => n.startsWith('kiln_pending:'));
    try { return JSON.parse(localStorage.getItem(at))?.edits?.[k]?.html ?? null; } catch { return null; }
  }, key);
  const published = () => page.evaluate((k) => {
    try { const s = JSON.parse(localStorage.getItem('kiln_sandbox')); return Object.values(s.pages || {}).map(p => p[k]?.html).find(h => typeof h === 'string') ?? null; } catch { return null; }
  }, key);
  const clean = (html) => typeof html === 'string' && !/opacity|transform|translate|style=|is-inview/.test(html);
  const retype = async (text) => {
    await heading.scrollIntoViewIfNeeded();
    await press(heading);
    await page.locator('#kiln-toolbar').waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type(text);
  };
  const keep = async () => { await press(page.locator('#kiln-toolbar .kiln-tb-save')); await page.waitForTimeout(350); };
  const publishNow = async () => {
    await press(page.locator('#kiln-publish-quick'));
    await page.locator('#kiln-pubsheet-go').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(200);
    await press(page.locator('#kiln-pubsheet-go'));
    await page.waitForTimeout(600);
  };
  const history = async () => {
    await press(page.locator('#kiln-fab'));
    await page.waitForTimeout(350);
    await press(page.locator('#kiln-history'));
    await page.locator('#kiln-hist .kiln-hist-row').first().waitFor({ state: 'visible', timeout: 5000 });
  };

  // Edited at once: on a site with an entrance animation the heading is still arriving.
  await retype('Big sale this Saturday.');
  await keep();
  await page.waitForTimeout(1500);   // whatever was animating has finished
  const original = await page.evaluate(async (k) => {
    const html = await (await fetch(location.pathname)).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const h = doc.querySelector(`[data-cms="${k}"]`);
    const copy = document.querySelector(`[data-cms="${k}"]`).cloneNode(false);
    copy.innerHTML = h.innerHTML;
    copy.style.cssText = 'position:absolute;left:-9999px;top:0';
    document.body.appendChild(copy);
    const words = copy.innerText.replace(/\s+/g, ' ').trim();
    copy.remove();
    return words;
  }, key);
  let l = await look();
  check(scope, 'an edit made as the page arrives is kept, and can be seen', seen(l, 'Big sale this Saturday.'), told(l));
  const first = await staged();
  check(scope, 'what Publish would write for it holds the words and nothing a script put on the page', clean(first) && /Big sale this Saturday\./.test(first), String(first).slice(0, 160));
  await press(page.locator('#kiln-undo-btn'));
  await page.waitForTimeout(900);
  l = await look();
  check(scope, 'Undo: the old words are back and can be seen, every element inside fully opaque', seen(l, original), told(l));
  await shot('undo-shows-undone');
  await press(page.locator('#kiln-redo-btn'));
  await page.waitForTimeout(900);
  l = await look();
  check(scope, 'Redo: the new words can be seen', seen(l, 'Big sale this Saturday.'), told(l));
  // "Drop" in the publish sheet
  await press(page.locator('#kiln-publish-quick'));
  await page.locator('#kiln-pubsheet-go').waitFor({ state: 'visible', timeout: 5000 });
  await press(page.locator('.kiln-ps-drop').first());
  await page.waitForTimeout(400);
  if (await page.locator('#kiln-modal').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
  if (await page.locator('#kiln-modal').count()) await press(page.locator('#kiln-modal .kiln-modal-x').first());
  await page.waitForTimeout(500);
  l = await look();
  check(scope, '"Drop" in the publish sheet: the old words can be seen', seen(l, original), told(l));
  // Esc, or Revert where there is no keyboard, in the middle of typing
  await retype('Typed and thrown away');
  if (phone) await press(page.locator('#kiln-toolbar .kiln-tb-cancel')); else await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  l = await look();
  check(scope, `${phone ? 'Revert' : 'Esc'} while typing: the old words can be seen`, seen(l, original), told(l));

  // Published, and after a reload
  await retype('Big sale this Saturday.');
  await keep();
  await publishNow();
  let html = await published();
  check(scope, 'what was published holds no opacity, transform or style', clean(html) && /Big sale/.test(html), String(html).slice(0, 160));
  await page.reload({ waitUntil: 'load' });
  await started();
  await page.waitForTimeout(1800);
  l = await look();
  check(scope, 'after a reload the published words can be seen', seen(l, 'Big sale this Saturday.'), told(l));

  // History: "Undo this change", Keep, Publish, reload
  await history();
  await press(page.locator('#kiln-hist [data-act="undo"]').first());
  await page.locator('#kiln-previewbar').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(900);
  l = await look();
  check(scope, 'History, "Undo this change": the preview shows the old words where they can be seen', seen(l, original), told(l));
  await shot('undo-shows-history-preview');
  await press(page.locator('#kiln-pv-keep'));
  await page.waitForTimeout(400);
  await publishNow();
  html = await published();
  check(scope, 'kept and published, what was written holds no opacity, transform or style', clean(html), String(html).slice(0, 200));
  l = await look();
  check(scope, 'and the heading can be seen', seen(l, original), told(l));
  await page.reload({ waitUntil: 'load' });
  await started();
  await page.waitForTimeout(1800);
  l = await look();
  check(scope, 'and still after a reload', seen(l, original), told(l));
  await shot('undo-shows-history-reloaded');
  // "Go back to this", then Cancel
  await history();
  const older = page.locator('#kiln-hist [data-act="restore"]').first();
  check(scope, 'History has an older publish to go back to', (await older.count()) === 1);
  if (await older.count()) {
    await press(older);
    await page.locator('#kiln-previewbar').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(900);
    l = await look();
    check(scope, 'History, "Go back to this": what it shows can be seen', seen(l, 'Big sale this Saturday.'), told(l));
    await press(page.locator('#kiln-pv-cancel'));
    await page.waitForTimeout(700);
    l = await look();
    check(scope, 'and Cancel puts the page back where it can be seen', seen(l, original), told(l));
  }
  await context.close();
}

/**
 * The rest of what a first-time client met in their first five minutes, on
 * the demo: a change the publish sheet hid, taps that did nothing, a menu the
 * page showed through, a picture store that stayed full, an Undo that ran the
 * page away, buttons that did not ask.
 */
async function runFirstEdits(browser, size) {
  const phone = size.width < 600;
  const scope = `${size.width}x${size.height} first edits `;
  const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone, reducedMotion: 'no-preference' });
  await context.route('**/*', (route) => {
    const u = route.request().url();
    return (u.startsWith(ORIGIN) || u.startsWith('data:') || u.startsWith('blob:')) ? route.continue() : route.abort();
  });
  await context.addInitScript(() => { try { localStorage.setItem('kiln_guide', '1'); } catch { /* ignore */ } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const boxes = [];
  page.on('dialog', async (d) => { boxes.push(d.message()); await d.dismiss().catch(() => {}); });
  const tabs = [];
  context.on('page', (p) => { if (p !== page) { tabs.push(p.url()); p.close().catch(() => {}); } });
  const press = async (locator) => { await locator.scrollIntoViewIfNeeded(); await page.waitForTimeout(300); return phone ? locator.tap() : locator.click(); };
  const shot = async (step) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${step}-${size.width}.png`) }); };
  const started = async () => { await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 }); await page.waitForTimeout(1500); };
  const line = () => page.evaluate(() => { const e = document.getElementById('kiln-status'); return e && !e.hidden && e.getClientRects().length ? e.innerText.replace(/\s+/g, ' ').trim() : ''; });
  const label = () => page.evaluate(() => { const b = document.getElementById('kiln-publish-quick'); return b && !b.hidden ? b.textContent.trim() : ''; });
  await page.goto(URL_ARG, { waitUntil: 'load' });
  await started();

  // A list of three or more blocks whose blocks hold a short field (a price, a name).
  const key = await page.evaluate(() => [...document.querySelectorAll('[data-cms-repeat]:not([data-kiln-gallery]):not([data-kiln-events])')]
    .find(l => l.querySelectorAll(':scope > .kiln-repeat-item').length >= 4 && l.querySelector('.kiln-repeat-item [data-cms]'))?.getAttribute('data-cms-repeat') || null);
  check(scope, 'the page has a list to check', !!key);
  if (!key) { await context.close(); return; }
  const blocks = page.locator(`[data-cms-repeat="${key}"] > .kiln-repeat-item`);
  const bar = async (block, title) => {
    await inReach(page, block);
    await page.waitForTimeout(600);
    if (phone) { await block.locator('.kiln-ctl-more').tap(); await page.waitForTimeout(250); }
    else { const b = await block.boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + Math.min(b.height / 2, 200)); await page.waitForTimeout(250); }
    const btn = block.locator(`button[title="${title}"]`);
    await (phone ? btn.tap() : btn.click());
    await page.waitForTimeout(450);
  };
  const sheet = async () => {
    await press(page.locator('#kiln-publish-quick'));
    await page.locator('#kiln-pubsheet-go').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(250);
    const got = await page.evaluate(() => ({
      title: document.querySelector('#kiln-ps-title')?.textContent || '', go: document.querySelector('#kiln-pubsheet-go')?.textContent || '',
      notes: [...document.querySelectorAll('#kiln-ps-list .kiln-ps-note')].map(n => n.textContent),
      texts: [...document.querySelectorAll('#kiln-ps-list .kiln-ps-line')].map(n => n.innerText.replace(/\s+/g, ' ')),
      pics: document.querySelectorAll('#kiln-ps-list .kiln-ps-pics').length,
    }));
    got.listed = got.notes.length + got.texts.length / 2 + got.pics;
    return got;
  };
  const closeSheet = async () => { if (await page.locator('#kiln-modal [data-close]').count()) await press(page.locator('#kiln-modal [data-close]').first()); await page.waitForTimeout(300); };

  // ── the publish sheet names every change, and Publish counts what it lists ──
  const field = blocks.nth(0).locator('[data-cms]').last();
  const was = (await field.innerText()).trim();
  await press(field);
  await page.locator('#kiln-toolbar').waitFor({ state: 'visible', timeout: 5000 });
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Changed in the list');
  await press(page.locator('#kiln-toolbar .kiln-tb-save'));
  await page.waitForTimeout(350);
  const one = await label();
  await bar(blocks.nth(2), 'Duplicate this block');
  const two = await label();
  let s = await sheet();
  check(scope, 'a field changed in a list and a block added to the same list are both in the sheet', s.notes.some(n => /^Added: /.test(n)) && s.texts.some(t => /^Before/i.test(t) && t.includes(was.slice(0, 12))) && s.texts.some(t => /^After/i.test(t) && /Changed in the list/.test(t)), `${s.notes.join(' | ')} / ${s.texts.join(' | ').slice(0, 160)}`);
  check(scope, 'the number on Publish is the number of things the sheet lists', one === 'Publish 1 edit' && two === 'Publish 2 edits' && s.listed === 2 && /^2 changes/.test(s.title) && s.go === 'Publish 2 edits', `${one} | ${two} | ${s.title} | ${s.go} | ${s.listed} listed`);
  await shot('first-edits-sheet');
  await closeSheet();
  await bar(blocks.nth(4), 'Move down');
  const three = await label();
  await bar(blocks.nth(6), 'Remove this block');
  const four = await label();
  check(scope, '"Removed." is said, with an Undo button', /^Removed\. ?Undo$/.test(await line()), await line());
  await page.waitForTimeout(5000);
  check(scope, 'and is still there five seconds later', /^Removed\./.test(await line()), await line());
  s = await sheet();
  check(scope, 'a move and a removal are each one more, on the button and in the sheet', three === 'Publish 3 edits' && four === 'Publish 4 edits' && s.listed === 4 && /^4 changes/.test(s.title), `${three} | ${four} | ${s.title} | ${s.listed} listed: ${s.notes.join(' | ')}`);
  await closeSheet();
  const y1 = await page.evaluate(() => scrollY);
  await press(page.locator('#kiln-undo-btn'));
  await page.waitForTimeout(1300);
  const y2 = await page.evaluate(() => scrollY);
  const back = await blocks.nth(6).evaluate((b) => { const r = b.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight }; });
  check(scope, 'Undo of the removal shows the block that came back, and moves the page less than a screen to do it', Math.abs(y2 - y1) < size.height && back.bottom > 60 && back.top < back.vh - 60, `scrollY ${y1} -> ${y2}, the block at ${back.top} to ${back.bottom}`);
  check(scope, 'and takes one off the number', (await label()) === 'Publish 3 edits', await label());

  // ── "Start over" asks first ────────────────────────────────────────────────
  await press(page.locator('#kiln-sandbox-reset'));
  await page.waitForTimeout(500);
  let asks = await page.locator('#kiln-modal.kiln-ask').innerText().catch(() => '');
  check(scope, '"Start over" asks first, in the editor\'s own box, and says what would go', /Start the demo over\?/.test(asks) && /your 3 unpublished edits/.test(asks) && /can be brought back/.test(asks) && boxes.length === 0, asks.replace(/\s+/g, ' ').slice(0, 200));
  await shot('first-edits-start-over');
  await press(page.locator('#kiln-modal [data-close]').first());
  await page.waitForTimeout(400);
  check(scope, 'the other button keeps everything', (await label()) === 'Publish 3 edits' && (await page.locator('#kiln-modal').count()) === 0, await label());
  // ── a draft, and "Delete draft" ────────────────────────────────────────────
  await press(page.locator('#kiln-fab'));
  await page.waitForTimeout(350);
  await press(page.locator('#kiln-draft'));
  await page.waitForTimeout(600);
  await page.reload({ waitUntil: 'load' });
  await started();
  if (await page.locator('#kiln-dr-del').count()) {
    await press(page.locator('#kiln-dr-del'));
    await page.waitForTimeout(500);
    asks = await page.locator('#kiln-modal.kiln-ask').innerText().catch(() => '');
    check(scope, '"Delete draft" asks first, and says what the draft holds and what stays', /Delete this draft\?/.test(asks) && /change in it|changes in it/.test(asks) && /stays as it is/.test(asks) && boxes.length === 0, asks.replace(/\s+/g, ' ').slice(0, 200));
    await press(page.locator('#kiln-modal.kiln-ask [data-close]').first());
    await page.waitForTimeout(400);
    const kept = await page.evaluate(() => { try { return Object.keys(JSON.parse(localStorage.getItem('kiln_sandbox')).drafts || {}).length; } catch { return -1; } });
    check(scope, '"Keep the draft" keeps it, and the draft is still offered', kept === 1 && (await page.locator('#kiln-dr-del').count()) === 1, `${kept} draft`);
    await press(page.locator('#kiln-dr-del'));
    await page.waitForTimeout(400);
    await press(page.locator('#kiln-ask-go'));
    await page.waitForTimeout(500);
    const gone = await page.evaluate(() => { try { return Object.keys(JSON.parse(localStorage.getItem('kiln_sandbox')).drafts || {}).length; } catch { return -1; } });
    check(scope, 'and "Delete draft" in the question deletes it', gone === 0 && /Draft deleted/.test(await line()), `${gone} drafts, ${await line()}`);
  } else check(scope, 'a saved draft is offered back, with a way to delete it', false);

  // ── a copy that is not editable says where the editable one is ─────────────
  // Words that are on the page twice: once in a part that can be changed, once in a link to the same place that cannot.
  // (the first such link on the page: in a row that scrolls sideways, that is the one in sight)
  const twin = await page.evaluate(() => {
    const flat = (t) => t.replace(/\s+/g, ' ').trim().toLowerCase();
    const fields = [...document.querySelectorAll('.kiln-repeat-item .kiln-field[data-cms]')].filter(f => f.closest('a[href]'));
    for (const a of document.querySelectorAll('a[href]')) {
      if (a.closest('[data-cms-repeat], [data-cms], [id^="kiln-"], nav, header, footer')) continue;
      for (const f of fields.filter(x => x.closest('a[href]').href === a.href)) {
        const copy = [...a.querySelectorAll('*')].find(e => !e.children.length && flat(e.innerText || '') === flat(f.innerText) && flat(f.innerText).length > 1);
        if (copy) { copy.setAttribute('data-ui-check-copy', '1'); f.setAttribute('data-ui-check-twin', '1'); return true; }
      }
    }
    return false;
  });
  if (twin) {
    tabs.length = 0;
    // from the top of the page: a row the site moves sideways as the page scrolls is at its start there
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(500);
    const before = page.url();
    await press(page.locator('[data-ui-check-copy]'));
    await page.waitForTimeout(600);
    let said = await line();
    check(scope, 'a tap on a copy that is not editable says where the editable one is, and does not follow its link', /^This copy can’t be changed here\. The same words can, in /.test(said) && /Show me$/.test(said) && tabs.length === 0 && page.url() === before, `${said} / ${tabs.length} tabs`);
    await shot('first-edits-copy');
    await press(page.locator('#kiln-status .kiln-status-act'));
    await page.waitForTimeout(1400);
    const at = await page.locator('[data-ui-check-twin]').evaluate((f) => { const r = f.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight }; });
    check(scope, '"Show me" brings the part that can be changed onto the screen', at.top > 0 && at.bottom < at.vh, JSON.stringify(at));
    const photo = page.locator(`[data-cms-repeat="${key}"] > .kiln-repeat-item img:not([data-cms])`).first();
    if (await photo.count()) {
      await press(photo);
      await page.waitForTimeout(600);
      said = await line();
      check(scope, 'a picture nobody marked, in a block whose words are editable, says so', /^This picture isn’t set up to be changed here\./.test(said), said);
    }
  } else check(scope, 'the page shows something twice, once editable and once not (nothing to check here)', true);

  // ── the menu, Search & jump ────────────────────────────────────────────────
  await press(page.locator('#kiln-fab'));
  await page.waitForTimeout(450);
  const menu = await page.evaluate(() => { const m = getComputedStyle(document.querySelector('#kiln-fab-menu')).backgroundColor.match(/[\d.]+/g); return { alpha: m.length > 3 ? Number(m[3]) : 1, who: document.querySelector('.kiln-user')?.textContent.trim() }; });
  check(scope, 'the menu is solid enough to read with no blur behind it', menu.alpha >= 0.97, `alpha ${menu.alpha}`);
  check(scope, 'the demo calls its visitor "You": they hold every tool', menu.who === 'You', menu.who);
  await shot('first-edits-menu');
  await press(page.locator('#kiln-palette-btn'));
  await page.waitForTimeout(500);
  const rowsFor = async (q) => {
    await page.locator('.kiln-pal-input').fill(q);
    await page.waitForTimeout(450);
    return page.evaluate(() => { const o = []; let sec = ''; for (const n of document.querySelectorAll('#kiln-pal-list > *')) { if (n.classList.contains('kiln-pal-sec')) sec = n.textContent; else if (n.classList.contains('kiln-pal-item')) o.push(`${sec}: ${n.innerText.replace(/\s+/g, ' ')}`); } return o; });
  };
  // a word from the last block of the list: far beyond the first words of the list
  const deep = await blocks.last().evaluate((b) => ([...b.querySelectorAll('[data-cms]')].map(f => f.innerText).join(' ').match(/[A-Za-z]{6,}/g) || []).sort((x, y) => y.length - x.length)[0] || '');
  check(scope, 'the last block of the list has a word to look for', !!deep, deep);
  if (deep) {
    const rows = await rowsFor(deep);
    check(scope, 'Search & jump finds a word from the last block of the list, and shows the words around it', rows.some(r => /^On this page: /.test(r) && r.toLowerCase().includes(deep.toLowerCase())), `${deep}: ${rows.join(' | ').slice(0, 160)}`);
  }
  const page2 = await page.evaluate(() => { const a = [...document.querySelectorAll('a[href]')].find(l => !l.closest('[id^="kiln-"]') && new URL(l.href).origin === location.origin && new URL(l.href).pathname !== location.pathname && /\/$|\.html$/.test(new URL(l.href).pathname)); return a ? new URL(a.href).pathname : ''; });
  if (page2) {
    const rows = await rowsFor(page2.replace(/\//g, ' ').trim().split(' ').pop());
    check(scope, 'and a page of the site this page links to', rows.some(r => r.startsWith(`Pages: ${page2}`)), `${page2}: ${rows.join(' | ').slice(0, 160)}`);
  }
  const loose = await rowsFor('headline');
  check(scope, 'no part is listed that does not hold what was typed', loose.filter(r => /^On this page: /.test(r)).every(r => /headline/i.test(r)), loose.join(' | ').slice(0, 200));
  const foot = await page.evaluate(() => (document.querySelector('.kiln-pal-foot')?.getClientRects().length || 0) > 0);
  check(scope, phone ? 'the hints about keys are not shown on a touch screen' : 'the hints about keys are shown where there is a keyboard', foot === !phone);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  if (await page.locator('#kiln-modal').count()) await press(page.locator('#kiln-modal .kiln-modal-x').first());

  // ── "Add event" with an empty form ─────────────────────────────────────────
  await press(page.locator('#kiln-fab'));
  await page.waitForTimeout(350);
  await press(page.locator('#kiln-addsection'));
  await page.waitForTimeout(450);
  await page.locator('input[name="kiln-add-kind"][value="events"]').check();
  await press(page.locator('#kiln-add-go'));
  await page.waitForTimeout(500);
  const where = (await page.locator('#kiln-pickbar').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(scope, phone ? 'choosing a place: no mention of Esc on a touch screen, and a Cancel button' : 'choosing a place: Esc is offered, and a Cancel button', (phone ? !/Esc/.test(where) && /Tap a section/.test(where) : /Esc cancels/.test(where)) && (await page.locator('#kiln-spot-cancel').count()) === 1, where);
  await press(page.locator('#kiln-spot-end'));
  await page.waitForTimeout(800);
  await press(page.locator('.kiln-added .kiln-repeat-add').first());
  await page.waitForTimeout(450);
  await press(page.locator('#kiln-ev-go'));
  await page.waitForTimeout(350);
  const lacks = await page.locator('#kiln-ev-status').innerText().catch(() => '');
  check(scope, '"Add event" with an empty form says what is missing', lacks === 'An event needs a title and a date.' && (await page.locator('#kiln-ev-go').count()) === 1, lacks);
  await page.locator('#kiln-ev-title').fill('Sidewalk sale');
  await page.locator('#kiln-ev-date').fill('2026-10-17');
  await press(page.locator('#kiln-ev-go'));
  await page.waitForTimeout(800);
  const look = await page.evaluate(() => {
    const cs = (n) => (n ? { font: getComputedStyle(n).fontFamily.split(',')[0], size: parseFloat(getComputedStyle(n).fontSize) } : null);
    return { title: cs(document.querySelector('.kiln-added .kiln-added-title')), event: cs(document.querySelector('.kiln-added .kiln-ev-title')),
      site: cs([...document.querySelectorAll('h2, h1')].find(h => !h.closest('.kiln-added, [id^="kiln-"]') && h.getClientRects().length)), body: parseFloat(getComputedStyle(document.body).fontSize) };
  });
  check(scope, 'the added list\'s heading is in the site\'s own heading type, and stands out from the text', !!look.title && !!look.site && look.title.font === look.site.font && look.title.size >= look.body * 1.4 && look.event.size > look.body, JSON.stringify(look));
  await page.locator('.kiln-added').scrollIntoViewIfNeeded();
  await shot('first-edits-events');

  // ── pictures in the demo ───────────────────────────────────────────────────
  const picture = page.locator('img.kiln-field[data-cms-attr="src"]').first();
  if (await picture.count()) {
    const upload = async (file) => {
      const altWas = (await picture.getAttribute('alt')) || '';
      await press(picture);
      await page.waitForTimeout(400);
      await press(page.locator('#kiln-toolbar [data-act="replace"]'));
      await page.waitForTimeout(350);
      const chooser = page.waitForEvent('filechooser', { timeout: 8000 });
      await press(page.locator('#kiln-pick-upload'));
      await (await chooser).setFiles(file);
      for (let i = 0; i < 60; i++) { await page.waitForTimeout(300); if (!/Adding image/.test(await page.evaluate(() => document.getElementById('kiln-status')?.innerText || ''))) break; }
      await page.waitForTimeout(500);
      const said = await page.evaluate(() => document.getElementById('kiln-status')?.innerText.replace(/\s+/g, ' ') || '');
      // a picture that went in is described next, starting from the old picture's words
      const ask = page.locator('#kiln-describe');
      if (await ask.count()) {
        const asked = await page.evaluate(() => document.querySelector('.kiln-describe').innerText.replace(/\s+/g, ' '));
        check(scope, 'a replaced picture is described next, in plain words, starting from the old description',
          /Describe this picture for people who cannot see it\./.test(asked) && !/alt text/i.test(asked) && (await ask.inputValue()) === altWas.trim(), `${asked} / “${await ask.inputValue()}”`);
        await ask.fill('A new picture, described');
        await press(page.locator('#kiln-describe-go'));
        await page.waitForTimeout(300);
        check(scope, 'and the new description is on the picture', (await picture.getAttribute('alt')) === 'A new picture, described', await picture.getAttribute('alt'));
      }
      if (await page.locator('#kiln-toolbar [data-act="done"]').count()) { await press(page.locator('#kiln-toolbar [data-act="done"]')); await page.waitForTimeout(300); }
      return said;
    };
    // A picture that does not shrink: noise, as an uncompressed bitmap. And one that does: two flat colours.
    const bmp = (w, h, fill) => {
      const row = Math.ceil(w * 3 / 4) * 4, buf = Buffer.alloc(54 + row * h);
      buf.write('BM'); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10); buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22);
      buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28); buf.writeUInt32LE(row * h, 34);
      for (let i = 54; i < buf.length; i++) buf[i] = fill(i);
      return buf;
    };
    let seed = 7;
    const noise = { name: 'noise.bmp', mimeType: 'image/bmp', buffer: bmp(2600, 2600, () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16 & 255) };
    const flat = { name: 'flat.bmp', mimeType: 'image/bmp', buffer: bmp(1200, 800, (i) => (i % 3 === 0 ? 180 : 90)) };
    const src0 = await picture.getAttribute('src');
    const pending = () => page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('kiln_pending:')).reduce((n, k) => n + localStorage.getItem(k).length, 0));
    const p0 = await pending();
    const said = await upload(noise);
    if (/^This picture is /.test(said)) {
      check(scope, 'a picture too big for the demo is refused with its size and the limit', /^This picture is [\d.]+ MB once it is made web-sized, and the demo keeps pictures up to 1 MB in this browser\./.test(said), said);
      check(scope, 'and nothing of it is kept: the picture on the page and what is saved are as they were', (await picture.getAttribute('src')) === src0 && (await pending()) === p0, `${await pending()} kept, was ${p0}`);
    } else {
      // on a small screen the web-sized copy is small enough to keep
      check(scope, 'a large picture is made web-sized and kept', /Image added/.test(said) && (await pending()) - p0 < 1.5 * 1024 * 1024, `${said} / ${(await pending()) - p0} more kept`);
    }
    const ok = await upload(flat);
    const kept = (await pending()) - p0;
    check(scope, 'a normal picture goes in after it, and takes little room', /Image added/.test(ok) && kept > 0 && kept < 1.5 * 1024 * 1024, `${ok} / ${kept} kept`);
    await press(page.locator('#kiln-publish-quick'));
    await page.locator('#kiln-pubsheet-go').waitFor({ state: 'visible', timeout: 5000 });
    await press(page.locator('#kiln-pubsheet-go'));
    await page.waitForTimeout(800);
    check(scope, 'and is published', /^Published to your private demo\./.test(await line()), await line());
  }
  check(scope, 'no script errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  check(scope, 'nothing was asked in a browser box', boxes.length === 0, boxes.join(' | ').slice(0, 120));
  await context.close();
}

async function runListsAndLinks(browser, size) {
  const phone = size.width < 600;
  const scope = `${size.width}x${size.height} lists and links`;
  const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone, reducedMotion: 'no-preference' });
  await context.addInitScript(() => { try { localStorage.setItem('kiln_guide', '1'); } catch { /* ignore */ } });
  const front = new URL(URL_ARG).href;
  await context.route('**/*', async (route) => {
    const u = route.request().url();
    if (u === front) {
      // the demo has no rich area of its own: one is added to the page, before the first heading of the second section
      const res = await route.fetch();
      const body = (await res.text()).replace(/(<h2\b[^>]*\bdata-cms="[^"]+"[^>]*>)/, '<div data-cms="lists_rich"><p>Rich area words</p></div>\n$1');
      return route.fulfill({ response: res, body });
    }
    if (u.startsWith(ORIGIN) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // force: a button that says why is dimmed (aria-disabled) but can still be pressed
  const press = (locator) => (phone ? locator.tap({ force: true }) : locator.click({ force: true }));
  await page.goto(URL_ARG, { waitUntil: 'load' });
  await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(600);
  const status = () => page.locator('#kiln-status').textContent().catch(() => '');
  const shot = async (step) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${step}-${size.width}.png`) }); };
  const btn = (cmd) => page.locator(`#kiln-toolbar [data-cmd="${cmd}"]`);
  const open = async (field) => {
    await field.scrollIntoViewIfNeeded();
    // A page that moves things as it scrolls needs a moment, and the part is pressed where it is then
    // (no force: that presses where it was).
    await page.waitForTimeout(900);
    await (phone ? field.tap() : field.click());
    await page.waitForTimeout(350);
    // the cursor at the end of the words, as after typing
    await field.evaluate((el) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n, last = null;
      while ((n = w.nextNode())) last = n;
      const r = document.createRange(); r.setStart(last, last.length); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
  };
  const shut = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(300); };
  const blocks = (field) => field.evaluate((el) => el.querySelectorAll('ul, ol, li, h1, h2, h3, h4, h5, h6, blockquote, p').length);

  // The first paragraph and the first heading that take up room at this width and take formatting: a site may
  // leave a paragraph out on a phone (display: none), keep one as plain text, or still be fading one in.
  const firstShown = (sel) => page.evaluate((q) => [...document.querySelectorAll(q)].findIndex((el) => {
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && !el.hasAttribute('data-cms-plain') && !el.closest('[data-cms-repeat]') && /\w{4}/.test(el.textContent);
  }), sel);
  for (const [name, field] of [['a paragraph', page.locator('p[data-cms]').nth(Math.max(0, await firstShown('p[data-cms]')))], ['a heading', page.locator('h2[data-cms]').nth(Math.max(0, await firstShown('h2[data-cms]')))]]) {
    const was = await field.innerHTML();
    await open(field);
    check(scope, `in ${name} the list buttons are dimmed and their hint says why`, (await btn('insertUnorderedList').getAttribute('aria-disabled')) === 'true'
      && /can’t go in this part/.test((await btn('insertOrderedList').getAttribute('title')) || ''));
    await press(btn('insertUnorderedList'));
    await page.waitForTimeout(250);
    let said = await status();
    check(scope, `in ${name} Bullet list says why and makes no list`, /^A list can’t go in this part of the page\./.test(said) && (await blocks(field)) === 0, said.slice(0, 80));
    await press(btn('insertOrderedList'));
    await page.waitForTimeout(250);
    check(scope, `in ${name} Numbered list makes no list either`, (await blocks(field)) === 0);
    await page.locator('#kiln-toolbar .kiln-style-select').selectOption('fmt:h3');
    await page.waitForTimeout(250);
    said = await status();
    check(scope, `in ${name} the Style menu's Subheading says why and changes nothing`, /can’t be made a heading/.test(said) && (await blocks(field)) === 0 && (await field.innerHTML()).includes(was.trim().slice(0, 12)), said.slice(0, 80));
    await shot(`lists-${name.split(" ")[1]}`);
    await shut();
  }

  const rich = page.locator('[data-cms="lists_rich"]');
  for (const [cmd, tag] of [['insertUnorderedList', 'ul'], ['insertOrderedList', 'ol']]) {
    await open(rich);
    check(scope, `in a rich area the ${tag === 'ul' ? 'Bullet' : 'Numbered'} list button is not dimmed`, (await btn(cmd).getAttribute('aria-disabled')) === null);
    await press(btn(cmd));
    await page.waitForTimeout(250);
    await page.keyboard.type(' and more');
    const html = (await rich.innerHTML()).replace(/&nbsp;/g, ' ');
    check(scope, `in a rich area it makes a list, not inside a paragraph, and the words typed next go at the end of the item`, html === `<${tag}><li>Rich area words and more</li></${tag}>`, html.slice(0, 90));
    await shut();
  }

  const body = page.locator('p[data-cms]').filter({ hasText: /\w{4}/ }).nth(1);
  await open(body);
  for (const [typed, want] of [['muskratandrorke.com', 'https://muskratandrorke.com'], ['www.example.com/page', 'https://www.example.com/page'], ['pat@example.com', 'mailto:pat@example.com'], ['about.html', 'about.html'], ['/about', '/about']]) {
    await body.evaluate((el) => {
      el.querySelectorAll('a').forEach(a => a.replaceWith(...a.childNodes));
      el.normalize();
      const n = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
      const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 4);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await press(btn('link'));
    await page.waitForTimeout(300);
    await page.locator('#kiln-link-url').fill(typed);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const got = await body.evaluate((el) => el.querySelector('a')?.getAttribute('href') ?? '');
    check(scope, `a link typed as "${typed}" goes to ${want}`, got === want, got);
  }
  await shut();
  check(scope, 'no errors on the page', errors.length === 0, errors[0] || '');
  await context.close();
}

async function runKeyboard(browser, size) {
  const phone = size.width < 600;
  const scope = `${size.width}x${size.height} keyboard`;
  const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone, reducedMotion: 'no-preference' });
  await context.addInitScript(() => { try { localStorage.setItem('kiln_guide', '1'); } catch { /* ignore */ } });
  await context.route('**/*', (route) => {
    const u = route.request().url();
    return u.startsWith(ORIGIN) || u.startsWith('data:') || u.startsWith('blob:') ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const shot = async (step) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${step}-${size.width}.png`) }); };
  const key = async (k) => { await page.keyboard.press(k); await page.waitForTimeout(60); };
  /** What has the keyboard: its tag, the editor's marks on it, its role and name. */
  const focused = () => page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return { tag: 'body' };
    return { tag: a.tagName.toLowerCase(), id: a.id, key: a.getAttribute('data-cms'), field: a.classList.contains('kiln-field'), role: a.getAttribute('role'),
      label: a.getAttribute('aria-label'), editing: a.isContentEditable, inToolbar: !!a.closest('#kiln-toolbar'), inDialog: !!a.closest('#kiln-modal'),
      ring: a.matches(':focus-visible') ? getComputedStyle(a).outlineStyle : 'none' };
  });
  /** Tab until `want(focused)` holds, at most `max` presses. */
  const tabTo = async (want, max = 400) => {
    for (let i = 0; i < max; i++) { await page.keyboard.press('Tab'); const f = await focused(); if (want(f)) return f; }
    return null;
  };
  const stored = () => page.evaluate(() => Object.keys(localStorage).map(k => localStorage.getItem(k)).join('\n'));
  try {
    await page.goto(URL_ARG, { waitUntil: 'load' });
    await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(800);

    // ── every editable part reachable and named ──────────────────────────────
    const parts = await page.evaluate(() => {
      const all = [...document.querySelectorAll('.kiln-field[data-cms]')].filter(el => !el.classList.contains('kiln-source-field'));
      const bad = all.filter(el => el.tabIndex !== 0 || !el.getAttribute('aria-label') || el.getAttribute('role') !== 'button');
      return { n: all.length, bad: bad.length, first: bad.slice(0, 3).map(el => el.getAttribute('data-cms')).join(', ') };
    });
    check(scope, 'every editable part is in the tab order, a button with a name', parts.n > 20 && parts.bad === 0, `${parts.n} parts, ${parts.bad} not: ${parts.first}`);
    const head = await tabTo(f => f.field && f.tag === 'h1');
    check(scope, 'Tab reaches the page\'s heading, with a focus ring', !!head && head.ring !== 'none' && head.ring !== '', JSON.stringify(head));
    const said = head ? await page.locator(':focus').ariaSnapshot().catch(() => '') : '';
    check(scope, 'the heading is read as a button that says what it is and what it holds', /button "Edit .+: .+"/.test(said), said.split('\n')[0]);
    await shot('keyboard-heading');

    // ── Enter opens it; Tab to the toolbar and along it; Esc leaves ─────────
    const before = await page.locator(':focus').innerText();
    await key('Enter');
    let f = await focused();
    check(scope, 'Enter opens the heading for typing, the keyboard in it, read as a text box', f.field && f.editing && f.role === 'textbox' && (await page.locator('#kiln-toolbar[role="toolbar"]').count()) === 1, JSON.stringify(f));
    await page.keyboard.type(' typed');
    await key('Tab');
    f = await focused();
    check(scope, 'Tab from the open box goes to its toolbar', f.inToolbar, JSON.stringify(f));
    const names = await page.$$eval('#kiln-toolbar button, #kiln-toolbar select', bs => bs.filter(b => b.getClientRects().length).map(b => b.getAttribute('aria-label') || b.textContent.trim()));
    const tbLabel = await page.locator('#kiln-toolbar').getAttribute('aria-label');
    check(scope, 'the toolbar and every button in it have names in words', /^Text tools: /.test(tbLabel || '') && names.includes('Bold') && names.includes('Italic') && names.includes('Add a link') && names.every(n => n && n.length > 2), `${tbLabel} | ${names.join(', ')}`);
    check(scope, 'Bold says whether it is on', (await page.locator('#kiln-toolbar [data-cmd="bold"]').getAttribute('aria-pressed')) !== null);
    await key('Tab');
    const at0 = (await focused()).label;
    await key('ArrowRight');
    const at1 = await focused();
    check(scope, 'an arrow key moves along the toolbar', at1.inToolbar && (at1.label || at1.tag) !== at0, `${at0} → ${at1.label || at1.tag}`);
    await key('Home');
    await key('Shift+Tab');
    f = await focused();
    check(scope, 'Shift+Tab from the toolbar\'s first control goes back into the box', f.field && f.editing, JSON.stringify(f));
    await key('Escape');
    f = await focused();
    const after = await page.locator('h1.kiln-field').first().innerText();
    check(scope, 'Esc leaves the box, throws the typing away, and the keyboard stays on the heading', f.field && !f.editing && f.role === 'button' && after === before && !(await page.locator('#kiln-toolbar').count()), `${JSON.stringify(f)} "${after}"`);

    // ── an edit kept by Tabbing on: box → toolbar → next part ──────────────
    await key('Enter');
    await key('End');
    await page.keyboard.type(' now');
    await key('Tab');
    const stops = await page.$$eval('#kiln-toolbar button, #kiln-toolbar select, #kiln-toolbar input', bs => bs.filter(b => !b.disabled && b.getClientRects().length).length);
    for (let i = 1; i < stops; i++) await key('Tab');
    await key('Tab');
    f = await focused();
    const kept = await page.locator('h1.kiln-field').first().evaluate(el => ({ words: el.innerText, modified: el.classList.contains('kiln-modified'), editing: el.isContentEditable }));
    check(scope, 'Tab past the toolbar keeps the edit and goes on to the next part', /now$/.test(kept.words) && kept.modified && !kept.editing && !f.inToolbar && f.tag !== 'body' && !(await page.locator('#kiln-toolbar').count()), `${JSON.stringify(kept)} → ${JSON.stringify(f)}`);

    // ── a part inside a list block ──────────────────────────────────────────
    await page.evaluate(() => document.querySelector('[data-cms-repeat] .kiln-field[data-cms]:not(img)')?.focus());
    f = await focused();
    check(scope, 'a part inside a list block is reachable and named', f.field && !!f.label, JSON.stringify(f));
    await key('Enter');
    await key('End');
    await page.keyboard.type(' listed');
    await key('Shift+Tab');   // leaves the box the other way: the edit is kept
    await page.waitForTimeout(200);
    const text = await stored();
    // A site has labels and roles of its own (a product card's aria-label), and those belong in what is saved:
    // only an attribute that is not in the page's own file was put there by the editor.
    const added = await page.evaluate(async (saved) => {
      const own = await (await fetch(location.pathname.endsWith('/') ? `${location.pathname}index.html` : location.pathname)).text();
      const marks = [...saved.replace(/\\"/g, '"').matchAll(/\b(tabindex|role|aria-label|aria-multiline|data-kiln-focus)="[^"]*"/g)].map(m => m[0]);
      return [...new Set(marks.filter(a => !own.includes(a)))];
    }, text);
    check(scope, 'what would be published holds no tabindex, role or label the editor put there', /now/.test(text) && /listed/.test(text) && !/data-kiln-focus/.test(text) && added.length === 0, added.slice(0, 3).join(' '));

    // ── a picture: Space opens its toolbar, Esc closes it ───────────────────
    const pic = await tabTo(x => x.field && x.tag === 'img');
    check(scope, 'Tab reaches an editable picture, named as one', !!pic && /^Change picture: /.test(pic.label || ''), JSON.stringify(pic));
    if (pic) {
      await key(' ');
      f = await focused();
      const ptb = await page.locator('#kiln-toolbar').getAttribute('aria-label').catch(() => null);
      check(scope, 'Space opens the picture\'s toolbar, named, with the keyboard in it', f.inToolbar && /^Picture tools: /.test(ptb || ''), `${ptb} ${JSON.stringify(f)}`);
      await key('Escape');
      f = await focused();
      check(scope, 'Esc closes the picture\'s toolbar and the keyboard is on the picture again', f.tag === 'img' && f.field && !(await page.locator('#kiln-toolbar').count()), JSON.stringify(f));
    }

    // ── the Kiln button and its menu ────────────────────────────────────────
    const fab = await tabTo(x => x.id === 'kiln-fab', 600);
    check(scope, 'Tab reaches the Kiln button', !!fab, JSON.stringify(fab));
    await key('Enter');
    f = await focused();
    check(scope, 'Enter opens the menu with the keyboard on its first item', !(await page.locator('#kiln-fab-menu').isHidden()) && /kiln-fab-item/.test(await page.evaluate(() => document.activeElement.className)), JSON.stringify(f));
    await key('ArrowDown');
    const moved = await focused();
    check(scope, 'an arrow key moves to the next item', moved.id !== f.id, `${f.id} → ${moved.id}`);
    await key('Escape');
    f = await focused();
    check(scope, 'Esc closes the menu and the keyboard is back on the Kiln button', f.id === 'kiln-fab' && await page.locator('#kiln-fab-menu').isHidden(), JSON.stringify(f));
    check(scope, 'the status line is announced', (await page.locator('#kiln-status').getAttribute('role')) === 'status');

    // ── dialogs: named, holding the keyboard, giving it back ───────────────
    const dialog = async (what) => {
      const info = await page.locator('#kiln-modal .kiln-modal-card').evaluate((c) => {
        const by = c.getAttribute('aria-labelledby');
        return { role: c.getAttribute('role'), modal: c.getAttribute('aria-modal'), name: by ? document.getElementById(by)?.textContent.trim() : c.getAttribute('aria-label') };
      }).catch(() => null);
      check(scope, `${what} is a dialog named by its heading, with the keyboard in it`, !!info && info.role === 'dialog' && info.modal === 'true' && !!info.name && (await focused()).inDialog, JSON.stringify(info));
      let out = 0;
      for (let i = 0; i < 25; i++) { await page.keyboard.press('Tab'); if (!(await focused()).inDialog) out++; }
      for (let i = 0; i < 5; i++) { await page.keyboard.press('Shift+Tab'); if (!(await focused()).inDialog) out++; }
      check(scope, `Tab and Shift+Tab stay inside ${what}`, out === 0, `${out} presses left it`);
      return info;
    };
    const pub = await tabTo(x => x.id === 'kiln-publish-quick', 600);
    if (pub) {
      await key('Enter');
      await page.waitForTimeout(300);
      const info = await dialog('the publish sheet');
      await shot('keyboard-publish-sheet');
      await key('Escape');
      f = await focused();
      check(scope, 'Esc closes the publish sheet and gives the keyboard back to Publish', !(await page.locator('#kiln-modal').count()) && f.id === 'kiln-publish-quick', `${info?.name} → ${JSON.stringify(f)}`);
    } else check(scope, 'Tab reaches Publish', false);
    await page.evaluate(() => document.getElementById('kiln-fab').focus());
    await key('Enter');
    const invite = page.locator('#kiln-invite');
    if (await invite.count()) {
      await invite.focus();
      await key('Enter');
      await page.waitForTimeout(400);
      await dialog('People & access');
      await key('Escape');
      f = await focused();
      check(scope, 'Esc closes People & access and the keyboard is on the Kiln button', !(await page.locator('#kiln-modal').count()) && f.id === 'kiln-fab', JSON.stringify(f));
    }
  } finally {
    check(scope, 'no script errors', errors.length === 0, errors.join(' | ').slice(0, 200));
    await context.close();
  }
}

async function runGetKiln(browser, size) {
  const phone = size.width < 600;
  const scope = `${size.width}x${size.height} get Kiln    `;
  const WANT = 'https://kilncms.com/get-started.html';
  const fresh = async () => {
    const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone, reducedMotion: 'no-preference' });
    const asked = [];
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(ORIGIN) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
      return refuse(route, asked);
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(URL_ARG, { waitUntil: 'load' });
    await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(600);
    return { context, page, asked, errors };
  };
  const drive = (page) => {
    const press = (locator) => (phone ? locator.tap() : locator.click());
    const heading = page.locator('h1.kiln-field, h2.kiln-field, h3.kiln-field').first();
    return {
      press,
      edit: async (text) => {
        await heading.scrollIntoViewIfNeeded();
        await press(heading);
        await page.waitForTimeout(350);
        await page.keyboard.type(text);
        await press(page.locator('#kiln-toolbar .kiln-tb-save'));
        await page.waitForTimeout(400);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      },
      publish: async () => {
        await press(page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).first());
        await page.waitForTimeout(450);
        await press(page.locator('#kiln-pubsheet-go'));
        await page.waitForTimeout(700);
      },
      shot: async (step) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${step}-${size.width}.png`) }); },
    };
  };
  /** The pill, its link, and whether they sit clear of everything else of Kiln's. */
  const pillState = (page) => page.evaluate(() => {
    const rect = (q) => { const el = document.querySelector(q); if (!el || !el.getClientRects().length) return null; const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
    const apart = (a, o) => !a || !o || a.r <= o.l || o.r <= a.l || a.b <= o.t || o.b <= a.t;
    const within = (a, o) => !!a && !!o && a.l >= o.l - 0.5 && a.r <= o.r + 0.5 && a.t >= o.t - 0.5 && a.b <= o.b + 0.5;
    const pill = document.querySelector('#kiln-sandbox-banner'), link = document.querySelector('#kiln-sandbox-get');
    const P = rect('#kiln-sandbox-banner'), L = rect('#kiln-sandbox-get'), S = rect('#kiln-sandbox-reset');
    const lines = (el) => { const r = document.createRange(); r.selectNodeContents(el); return new Set([...r.getClientRects()].map(x => Math.round(x.top))).size; };
    return { shown: !!L, text: L ? link.textContent.trim() : '', href: link ? link.getAttribute('href') : '', target: link ? link.getAttribute('target') : '', rel: link ? link.getAttribute('rel') : '',
      onScreen: !!P && P.l >= 0 && P.r <= innerWidth && P.b <= innerHeight && P.t >= 0, cut: !!pill && pill.scrollWidth > pill.clientWidth + 1,
      inPill: within(L, P) && within(S, P), sideBySide: apart(L, S), oneLine: !!L && lines(link) === 1 && lines(document.querySelector('#kiln-sandbox-reset')) === 1,
      clear: apart(P, rect('#kiln-fab')) && apart(P, rect('#kiln-quick')) && apart(P, rect('#kiln-status')), pillText: pill ? pill.innerText.replace(/\s+/g, ' ').trim() : '' };
  });
  const fits = (s) => s.onScreen && !s.cut && s.inPill && s.sideBySide && s.oneLine && s.clear;
  const why = (s) => `"${s.pillText}" onScreen ${s.onScreen} cut ${s.cut} inPill ${s.inPill} sideBySide ${s.sideBySide} oneLine ${s.oneLine} clear ${s.clear}`;

  // ── "Keep exploring", the link, a reload, "Start over" ─────────────────────
  {
    const { context, page, asked, errors } = await fresh();
    const { press, edit, publish, shot } = drive(page);
    let s = await pillState(page);
    check(scope, 'before any publish the pill has no link to Kiln', !s.shown, s.pillText);
    await edit(' Hello');
    await publish();
    const card = page.locator('#kiln-guide-card');
    await card.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    const cardLink = card.getByRole('link', { name: 'Put Kiln on my site' });
    s = await pillState(page);
    check(scope, 'while the card offers "Put Kiln on my site" the pill does not repeat it', (await cardLink.count()) === 1 && !s.shown);
    const keep = card.getByRole('button', { name: 'Keep exploring' });
    if (await keep.count()) await press(keep);
    await page.waitForTimeout(300);
    s = await pillState(page);
    check(scope, 'the moment the card goes, the pill carries the link', (await card.count()) === 0 && s.shown && s.text === 'Put Kiln on my site', s.pillText);
    check(scope, 'it goes where the card\'s button went, in a new tab', s.href === WANT && s.target === '_blank' && /noopener/.test(s.rel || ''), `${s.href} ${s.target}`);
    check(scope, 'the pill fits: on screen, nothing cut, the link and "Start over" side by side on one line each, clear of the pencil and the status line', fits(s), why(s));
    await shot('get-kiln-pill');
    await page.waitForTimeout(10500);   // "Published. Undo" has had its ten seconds
    s = await pillState(page);
    check(scope, 'it is still there when the page has settled', s.shown && fits(s), why(s));
    const link = page.locator('#kiln-sandbox-get');
    check(scope, 'the link can be pressed', ...Object.values((await link.count()) ? await hit(link) : { ok: false, why: 'no link' }));
    const tab = context.waitForEvent('page', { timeout: 3000 }).catch(() => null);
    if (await link.count()) await press(link);
    const opened = await tab;
    check(scope, 'pressing it opens the get-started page in a new tab', !!opened && asked.some(url => url.startsWith(WANT)), asked.slice(-1).join(''));
    if (opened) await opened.close().catch(() => {});
    forget(asked, WANT);
    // with an edit waiting, the pill shares the foot of the screen with Undo, Redo and Publish
    await edit(' Again');
    s = await pillState(page);
    check(scope, 'with an edit waiting it covers none of the pencil, Undo, Redo and Publish', s.shown && fits(s), why(s));
    await shot('get-kiln-pill-with-edit');
    check(scope, '"Start over" can still be pressed', ...Object.values(await hit(page.locator('#kiln-sandbox-reset'))));
    await page.reload({ waitUntil: 'load' });
    await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(800);
    if (await page.locator('#kiln-rest-no').count()) { await press(page.locator('#kiln-rest-no')); await page.waitForTimeout(300); }
    s = await pillState(page);
    check(scope, 'on a later visit the link is there from the start', s.shown && s.href === WANT && fits(s), why(s));
    await press(page.locator('#kiln-sandbox-reset'));
    await page.waitForTimeout(400);
    // it asks first now: the demo has a publish in it, and that is what would go
    const asks = await page.locator('#kiln-modal.kiln-ask').innerText().catch(() => '');
    check(scope, '"Start over" asks first, and names what was published', /Start the demo over\?/.test(asks) && /what you published/.test(asks), asks.replace(/\s+/g, ' ').slice(0, 160));
    if (await page.locator('#kiln-ask-go').count()) await press(page.locator('#kiln-ask-go'));
    await page.waitForTimeout(300);
    await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(800);
    s = await pillState(page);
    check(scope, '"Start over" takes the link away with the rest of the demo\'s state', !s.shown, s.pillText);
    check(scope, 'no script errors', errors.length === 0, errors.join(' | ').slice(0, 200));
    check(scope, 'nothing outside the local server was needed, but the link', asked.length === 0, asked.slice(0, 3).join(', '));
    await context.close();
  }
  // ── the card closes by itself ──────────────────────────────────────────────
  {
    const { context, page, errors } = await fresh();
    const { edit, publish, shot } = drive(page);
    await edit(' Hello');
    await publish();
    const card = page.locator('#kiln-guide-card');
    await card.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    check(scope, 'the card is up after a first publish, and the pill has no link yet', (await card.count()) === 1 && !(await pillState(page)).shown);
    await card.waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(300);
    const s = await pillState(page);
    check(scope, 'when the card closes by itself, the pill carries the link', (await card.count()) === 0 && s.shown && s.text === 'Put Kiln on my site' && s.href === WANT && fits(s), why(s));
    await shot('get-kiln-after-card-closed');
    check(scope, 'no script errors', errors.length === 0, errors.join(' | ').slice(0, 200));
    await context.close();
  }
}

/**
 * The same site as a signed-in invited editor, NOT in sandbox mode. The site's
 * kiln-config.js is swapped for one that names a repo and a worker, and every
 * call to that worker (sign-in state, the GitHub proxy) is answered here.
 */
async function runSignedIn(browser, size, opts = {}) {
  const phone = size.width < 600;
  const scope = `${size.width}x${size.height} ${opts.features ? 'granted     ' : 'signed in   '}`;
  const WORKER = 'https://worker.invalid';
  const REPO = 'acme/site';
  const source = await (await fetch(URL_ARG)).text();
  const file = new URL(URL_ARG).pathname.replace(/^\/+/, '').replace(/(^|\/)$/, '$1index.html');
  const b64 = (text) => Buffer.from(text).toString('base64');
  const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone });
  await context.addInitScript(([repo, seenGuide]) => {
    try {
      localStorage.setItem('kiln_editor', JSON.stringify({ session: 'a'.repeat(64), name: 'Sam', repo, role: 'editor' }));
      if (seenGuide) localStorage.setItem('kiln_guide', '1');
    } catch { /* ignore */ }
  }, [REPO, !!opts.features]);
  const puts = [];
  const blocked = [];
  const gitWrites = [];
  // the repository's files, as "From this site" reads them: the page's own pictures, and things that must not be listed
  const pictures = [...new Set([...source.matchAll(/<img\b[^>]*\ssrc="(\/[^"?#]+\.(?:jpe?g|png|webp|avif|gif))"/gi)].map(m => m[1].slice(1)))];
  const tree = [...pictures.map(path => ({ path, type: 'blob', size: 48 * 1024 })),
    { path: 'img/archive/old-banner.jpg', type: 'blob', size: 300 * 1024 },
    { path: 'assets/uploads/master-abc123.webp', type: 'blob', size: 900000 }, { path: 'docs/price-list.pdf', type: 'blob', size: 1000 },
    { path: 'favicon.png', type: 'blob', size: 500 }, { path: file, type: 'blob', size: source.length }];
  let current = source, sha = 'sha0', commitAnswer = { status: 201, body: { sha: 'upload' } };
  await context.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': ORIGIN }, body: JSON.stringify(body) });
    if (u.origin === ORIGIN && u.pathname.endsWith('kiln-config.js')) {
      return route.fulfill({ contentType: 'text/javascript', body: `window.KILN = { repo: '${REPO}', branch: 'main', worker: '${WORKER}', styles: [] };` });
    }
    if (u.origin === ORIGIN || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    if (u.origin !== WORKER) return refuse(route, blocked);
    const p = decodeURIComponent(u.pathname);
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Kiln-Session', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS' } });
    }
    if (p === '/presence') return json({ ok: true, others: [], online: [], scope: { paths: [''], keys: [], features: opts.features || null, mode: null } });
    if (p === '/healthz') return json({ ok: true, modes: ['html', 'source'], adapters: ['astro'] });
    if (p === `/gh/repos/${REPO}/contents/${file}`) {
      if (req.method() === 'GET') return json({ sha, content: b64(current) });
      const body = JSON.parse(req.postData());
      puts.push(body);
      current = Buffer.from(body.content, 'base64').toString();
      sha = `sha${puts.length}`;
      return json({ commit: { sha: `commit${puts.length}` }, content: {} });
    }
    if (p === `/gh/repos/${REPO}/contents`) return json([{ path: 'index.html', type: 'file' }, { path: 'assets', type: 'dir' }]);
    if (p.startsWith(`/gh/repos/${REPO}/git/`) && req.method() !== 'GET') gitWrites.push(`${req.method()} ${p}`);
    if (p === `/gh/repos/${REPO}/git/trees/main` && req.method() === 'GET') return json({ sha: 'tree', tree, truncated: false });
    if (p === `/gh/repos/${REPO}/git/ref/heads/main`) return json({ object: { sha: 'head' } });
    if (p.startsWith(`/gh/repos/${REPO}/git/refs/`)) return json({ object: { sha: 'upload' } });
    if (p.startsWith(`/gh/repos/${REPO}/git/commits/`)) return json({ tree: { sha: 'tree' } });
    if (p === `/gh/repos/${REPO}/git/blobs`) return json({ sha: 'blob' }, 201);
    if (p === `/gh/repos/${REPO}/git/trees`) return json({ sha: 'tree2' }, 201);
    if (p === `/gh/repos/${REPO}/git/commits`) return json(commitAnswer.body, commitAnswer.status);
    if (p.includes('/deployments')) return json([]);
    if (p.endsWith('/status')) return json({ total_count: 0 });
    return json({ message: 'Not Found' }, 404);
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const press = (locator) => (phone ? locator.tap() : locator.click());
  const shot = async (step) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${step}-${size.width}.png`) }); };
  const status = page.locator('#kiln-status');
  await page.goto(URL_ARG, { waitUntil: 'load' });
  await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(700);
  check(scope, 'not in sandbox mode', await page.evaluate(() => !window.KILN.sandbox));
  check(scope, 'no demo banner on a real site', (await page.locator('#kiln-sandbox-banner').count()) === 0);
  const guide = page.locator('#kiln-guide');
  if (opts.features) check(scope, 'the guide is not shown to an editor who has had it', (await guide.count()) === 0);
  else check(scope, 'an invited editor\'s first session starts the guide at the first heading', /^(Click|Tap) this and type\.$/.test((await guide.locator('span').first().textContent().catch(() => '')) || '')
    && (await page.evaluate(() => localStorage.getItem('kiln_guide'))) === '1');

  // ── the "Make things editable" grant ───────────────────────────────────────
  if (!opts.features) {
    check(scope, 'an editor without the grant is not offered "Make text/images editable"', (await page.locator('#kiln-makeblock, #kiln-addsection').count()) === 0);
  } else {
    page.on('dialog', (d) => d.accept());
    await press(page.locator('#kiln-fab'));
    await page.waitForTimeout(300);
    const make = page.locator('#kiln-makeblock');
    check(scope, 'an editor with the grant sees both tools in the menu', (await make.isVisible().catch(() => false)) && await page.locator('#kiln-addsection').isVisible().catch(() => false));
    await shot('make-editable-granted');
    await press(make);
    await page.waitForTimeout(300);
    check(scope, 'the tool starts: "Click anything to make it editable"', /Click anything to make it editable/.test((await page.locator('#kiln-pickbar').innerText().catch(() => '')) || ''));
    check(scope, 'its bar offers "Make this whole page editable" as well (the "whole page" pass presses it)', ((await page.locator('#kiln-pick-all').innerText().catch(() => '')) || '').trim() === 'Make this whole page editable');
    // something on the page that is not editable yet: plain text outside every field
    const found = await page.evaluate(() => {
      for (const el of document.querySelectorAll('main p, main li, main span, footer p, footer span, footer li')) {
        if (el.closest('[data-cms],[data-cms-repeat],[data-cms-menu],[id^="kiln-"]') || el.querySelector('[data-cms],[data-cms-repeat]')) continue;
        if (el.children.length || (el.textContent || '').trim().length < 8 || !el.getClientRects().length) continue;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        window.__uiCheckSpot = el;
        return true;
      }
      return false;
    });
    await page.waitForTimeout(400);
    const spot = found ? await page.evaluate(() => {
      const el = window.__uiCheckSpot, r = el.getBoundingClientRect();
      const x = r.left + Math.min(r.width / 2, 40), y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return { x, y, text: el.textContent.trim().slice(0, 40), reachable: top === el || el.contains(top) };
    }) : null;
    check(scope, 'the page has plain text that is not editable yet', !!spot);
    if (spot) {
      await page.mouse.click(spot.x, spot.y);
      await page.waitForTimeout(400);
      const mk = page.locator('#kiln-mk-go');
      check(scope, 'clicking it asks how to make it editable', (await mk.count()) === 1, spot.text);
      if (await mk.count()) await press(mk);
      await page.waitForTimeout(700);
      const exit = page.locator('#kiln-pick-exit');
      if (await exit.count()) await press(exit);
      await page.waitForTimeout(300);
      const publish = page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).first();
      check(scope, 'it is staged like any other edit', (await publish.count()) === 1);
      if (await publish.count()) {
        await press(publish);
        await page.waitForTimeout(500);
        const said = ((await page.locator('#kiln-modal .kiln-modal-card').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
        check(scope, 'the publish sheet names it', /Made editable:/.test(said), said.slice(0, 100));
        await press(page.locator('#kiln-pubsheet-go'));
        await page.waitForTimeout(1800);
        const count = (html) => (html.match(/\sdata-cms="/g) || []).length;
        const sent = puts.length ? Buffer.from(puts[puts.length - 1].content, 'base64').toString() : '';
        check(scope, 'publishing sends one page commit with one more editable field', puts.length === 1 && count(sent) === count(source) + 1, `${puts.length} writes, ${count(sent) - count(source)} added`);
      }
    }
    check(scope, 'no script errors', errors.length === 0, errors.join(' | ').slice(0, 200));
    check(scope, 'nothing outside the local server was needed', blocked.length === 0, blocked.slice(0, 3).join(', '));
    await context.close();
    return;
  }

  const heading = page.locator('h1.kiln-field, h2.kiln-field, h3.kiln-field').first();
  const key = await heading.getAttribute('data-cms');
  await heading.scrollIntoViewIfNeeded();
  await press(heading);
  await page.keyboard.type(' Hello');
  await press(page.locator('#kiln-toolbar .kiln-tb-save'));
  await page.waitForTimeout(300);
  const publish = page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).first();
  check(scope, 'a control named "Publish…" is visible after one edit', (await publish.count()) === 1 && (await publish.textContent()).trim() === 'Publish 1 edit');

  // An upload the worker will not take is turned away the moment it is picked…
  const para = page.locator('p.kiln-field:not([data-cms-plain])').first();
  let staged = false;
  if (await para.count()) {
    const pick = async (name, mimeType, bytes) => {
      await para.scrollIntoViewIfNeeded();
      if (!(await page.locator('#kiln-toolbar [data-cmd="doc"]').count())) { await press(para); await page.waitForTimeout(300); }
      const chooser = page.waitForEvent('filechooser');
      await press(page.locator('#kiln-toolbar [data-cmd="doc"]'));
      await (await chooser).setFiles({ name, mimeType, buffer: Buffer.from(bytes) });
      await page.waitForTimeout(350);
    };
    await pick('notes.md', 'text/markdown', '# notes');
    check(scope, 'a file type editors cannot add is refused when picked, in plain words', /^That file type can’t be added here\./.test(await status.innerText()));
    await pick('logo.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    check(scope, 'an SVG is refused when picked, and the reason is given', /^SVG and XML files can run scripts/.test(await status.innerText()));
    // …and one the worker refuses at publish (its bytes are not what its name says) is explained too.
    await pick('Minutes.pdf', 'application/pdf', 'not really a pdf');
    const insert = page.locator('#kiln-doc-go');
    if (await insert.count()) { await press(insert); await page.waitForTimeout(300); }
    if (await page.locator('#kiln-toolbar .kiln-tb-save').count()) await press(page.locator('#kiln-toolbar .kiln-tb-save'));
    await page.waitForTimeout(300);
    staged = true;
    commitAnswer = { status: 415, body: { error: 'That file is named like a PDF, but it holds something else. Check the file and try again.', code: 'file_mismatch', path: 'assets/files/minutes.pdf' } };
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await press(publish);
    await page.waitForTimeout(400);
    await press(page.locator('#kiln-pubsheet-go'));
    await page.waitForTimeout(900);
    const said = await status.innerText();
    check(scope, 'an upload refused at publish shows the reason and the file\'s name', said === 'That file is named like a PDF, but it holds something else. Check the file and try again. (minutes.pdf)', said.slice(0, 120));
    check(scope, 'the refused publish wrote nothing and kept the edits', puts.length === 0 && (await publish.isVisible()));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `upload-refused-${size.width}.png`) });
    commitAnswer = { status: 201, body: { sha: 'upload' } };
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await press(publish);
  await page.waitForTimeout(500);
  const go = page.locator('#kiln-pubsheet-go');
  check(scope, 'Publish opens the sheet first: nothing is sent yet', (await go.count()) === 1 && puts.length === 0, `${puts.length} writes`);
  if (await go.count()) await press(go);
  await page.waitForTimeout(1800);
  check(scope, 'Publish sent one commit for the page', puts.length === 1, `${puts.length} writes`);
  if (puts.length) {
    const message = puts[0].message;
    check(scope, 'the commit message names the file and the field', new RegExp(`^Edit ${file.replace(/[.]/g, '\\.')}: ${key}${staged ? ', [\\w-]+' : ''} \\(via Kiln\\)$`).test(message), message);
    check(scope, 'the commit carries the edit', Buffer.from(puts[0].content, 'base64').toString().includes(' Hello'));
  }
  check(scope, 'Publish goes away once there is nothing unpublished', (await page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).count()) === 0);
  {
    const card = page.locator('#kiln-guide-card');
    const text = (await card.count()) ? (await card.innerText()).replace(/\s+/g, ' ') : '';
    check(scope, 'the guide ends by saying what happened, in an editor\'s words', /^That is published Your change is saved to the site/.test(text) && !/Git|GitHub|Put Kiln on my site/.test(text), text.slice(0, 90));
    const link = card.getByRole('link', { name: 'Read the guide' });
    check(scope, 'it links to the editors\' guide', (await link.count()) === 1 && (await link.getAttribute('href')) === 'https://kilncms.com/editors');
    await shot('editor-guide-3');
  }

  // ── Undo after publishing ──────────────────────────────────────────────────
  const undoBtn = status.locator('.kiln-status-act');
  const said = async () => ((await status.innerText().catch(() => '')) || '').replace(/\n/g, ' ');
  check(scope, 'the confirmation says "Published." with an Undo button', /^Published\./.test(await said()) && (await undoBtn.count()) === 1, await said());
  if (await undoBtn.count()) {
    const before1 = puts.length;
    await press(undoBtn);
    await page.waitForTimeout(1500);
    check(scope, 'Undo sent one more commit', puts.length === before1 + 1, `${puts.length - before1} writes`);
    const undo = puts[before1] || {};
    check(scope, 'the undo commit puts the file back exactly', Buffer.from(undo.content || '', 'base64').toString() === source);
    check(scope, 'the undo commit is written against the published file, without force', undo.sha === `sha${before1}` && undo.force === undefined && /^Undo "Edit .*" \(via Kiln\)$/.test(undo.message || ''), `${undo.sha} ${undo.message}`);
    check(scope, 'Undo says what it did', /^Undone\. The site is back as it was/.test(await said()), await said());
    {
      // The first-session card was still up: it must stop saying the change is published.
      const card = page.locator('#kiln-guide-card');
      const text = (await card.count()) ? (await card.innerText()).replace(/\s+/g, ' ') : '';
      check(scope, 'after Undo the guide says the edit is back, not published, in an editor\'s words', (staged ? /^Your edits are back, not published Undo took that publish back\. Your changes are/ : /^Your edit is back, not published Undo took that publish back\. Your change is/).test(text) && !/That is published|Git|commit/i.test(text), text.slice(0, 90));
      await shot('editor-guide-3-undone');
      if (await card.count()) await press(card.getByRole('button', { name: 'Got it' }));
      await page.waitForTimeout(200);
      check(scope, '"Got it" closes the guide', (await card.count()) === 0 && (await guide.count()) === 0);
    }
    const again = page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).first();
    check(scope, 'the edit is unpublished again, still on the page', (await again.count()) === 1 && (await again.textContent()).trim() === `Publish ${staged ? 2 : 1} edit${staged ? 's' : ''}`
      && (await heading.innerText()).includes('Hello'));
    // publish it again, this time with a note, and let someone else publish before Undo is pressed
    if (await again.count()) {
      await press(again);
      await page.waitForTimeout(400);
      await page.locator('#kiln-ps-note').fill('Say hello <b>properly</b>');
      await press(go);
      await page.waitForTimeout(1800);
      check(scope, 'the note becomes the commit message, as plain text', (puts[puts.length - 1] || {}).message === 'Say hello properly (via Kiln)', (puts[puts.length - 1] || {}).message);
      const before2 = puts.length;
      current += '\n<!-- published by someone else -->';
      sha = 'someone-else';
      if (await undoBtn.count()) await press(undoBtn);
      await page.waitForTimeout(1200);
      const dialog = page.locator('#kiln-modal .kiln-modal-card');
      const text = (await dialog.count()) ? (await dialog.innerText()).replace(/\s+/g, ' ') : '';
      check(scope, 'Undo after someone else published writes nothing', puts.length === before2, `${puts.length - before2} writes`);
      check(scope, 'and explains, offering History', /Someone else has published since/.test(text) && /Nothing was changed/.test(text), text.slice(0, 120));
      await shot('undo-blocked');
      if (await dialog.count()) await press(dialog.getByRole('button', { name: 'Close' }).last());
    }
  }

  // ── "From this site": choose a picture that is already there ───────────────
  const picture = page.locator('img.kiln-field').first();
  if ((await picture.count()) && pictures.length > 1) {
    await picture.scrollIntoViewIfNeeded();
    await press(picture);
    await page.waitForTimeout(350);
    await press(page.locator('#kiln-toolbar [data-act="replace"]'));
    await page.waitForTimeout(300);
    const picker = page.locator('#kiln-modal.kiln-imgpick .kiln-modal-card');
    check(scope, '"Replace image…" offers Upload and From this site', (await picker.getByRole('tab').allTextContents()).join(' | ') === 'Upload | From this site');
    await press(picker.getByRole('tab', { name: 'From this site' }));
    await page.waitForTimeout(700);
    const tiles = picker.locator('.kiln-pick-tile');
    const names = await tiles.locator('.kiln-pick-name').allTextContents();
    check(scope, 'it lists the site\'s pictures and nothing else', (await tiles.count()) === Math.min(24, pictures.length + 1)
      && !names.some(n => /^master-|\.pdf$|^favicon/.test(n)), `${await tiles.count()} of ${pictures.length + 1}`);
    check(scope, 'the pictures on this page come first, under their own label', (await picker.locator('#kiln-pick-grid > *').first().textContent()) === 'On this page'
      && pictures.includes((await picture.getAttribute('src') || '').slice(1)) && names[0] === pictures[0].split('/').pop(), names[0]);
    check(scope, 'each picture has a name and a size', /\.\w+$/.test(names[0] || '') && /48 KB$/.test((await tiles.first().locator('.kiln-pick-meta').textContent()) || ''));
    const c = await box(picker);
    check(scope, 'the chooser fits on screen', c.left >= 0 && c.top >= 0 && c.right <= size.width + 0.5 && c.bottom <= size.height + 0.5);
    await shot('from-this-site');
    // search, then choose a picture other than the one in place
    const now = await picture.getAttribute('src');
    const want = pictures.map(pth => '/' + pth).find(u => u !== now);
    const wantName = want.split('/').pop();
    await picker.locator('#kiln-pick-search').fill(wantName.replace(/\.\w+$/, ''));
    await page.waitForTimeout(250);
    check(scope, 'search narrows the list by name', (await tiles.count()) >= 1 && (await tiles.locator('.kiln-pick-name').allTextContents()).every(n => n.includes(wantName.replace(/\.\w+$/, ''))), `${await tiles.count()} left`);
    const writesBefore = gitWrites.length, putsBefore = puts.length;
    await press(picker.locator('.kiln-pick-tile', { hasText: wantName }).first());
    await page.waitForTimeout(400);
    check(scope, 'choosing a picture puts it on the page and closes the chooser', (await picture.getAttribute('src')) === want && (await picker.count()) === 0, await picture.getAttribute('src'));
    // A picture chosen from the site is described next, as an uploaded one is (describe-picture.js).
    await page.locator('#kiln-describe').waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    check(scope, 'and its description is asked for, with the old one\'s words to start from', (await page.locator('#kiln-describe').count()) === 1);
    if (await page.locator('#kiln-describe').count()) { await press(page.locator('#kiln-describe-go')); await page.waitForTimeout(300); }
    if (await page.locator('#kiln-toolbar [data-act="done"]').count()) await press(page.locator('#kiln-toolbar [data-act="done"]'));
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(300);
    await press(page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).first());
    await page.waitForTimeout(500);
    const pics = page.locator('.kiln-ps-pics img');
    check(scope, 'the publish sheet shows the old and the new picture', (await pics.count()) === 2 && (await pics.nth(1).getAttribute('src') || '').endsWith(want), `${await pics.count()} thumbnails`);
    await press(page.locator('#kiln-pubsheet-go'));
    await page.waitForTimeout(1800);
    const sent = puts.slice(putsBefore);
    check(scope, 'publishing the chosen picture is one page commit', sent.length === 1 && Buffer.from(sent[0].content, 'base64').toString().includes(`src="${want}"`), `${sent.length} writes`);
    check(scope, 'and no new file is committed', gitWrites.length === writesBefore, gitWrites.slice(writesBefore).join(', '));
  }

  // ── a picture uploaded but not yet published survives a closed tab ─────────
  if (!phone && await picture.count()) {
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: 96, height: 64 } });
    await picture.scrollIntoViewIfNeeded();
    await press(picture);
    await page.waitForTimeout(350);
    const chooser = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
    await press(page.locator('#kiln-toolbar [data-act="replace"]'));
    await page.waitForTimeout(300);
    await press(page.locator('#kiln-pick-upload'));
    const fc = await chooser;
    if (fc) await fc.setFiles({ name: 'New sign.png', mimeType: 'image/png', buffer: png });
    await page.waitForTimeout(1800);
    const staged = (await picture.getAttribute('data-kiln-src')) || '';
    check(scope, 'an uploaded picture waits for Publish', /^\/assets\/uploads\/img-/.test(staged), staged);
    if (await page.locator('#kiln-describe').count()) { await press(page.locator('#kiln-describe-go')); await page.waitForTimeout(300); }
    if (await page.locator('#kiln-toolbar [data-act="done"]').count()) await press(page.locator('#kiln-toolbar [data-act="done"]'));
    await page.waitForTimeout(600);
    await page.reload({ waitUntil: 'load' });
    await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(800);
    const offer = page.locator('#kiln-rest-yes');
    check(scope, 'after the tab is closed and reopened, the edits are offered back', (await offer.count()) === 1);
    if (await offer.count()) {
      await press(offer);
      await page.waitForTimeout(800);
      const back = page.locator('img.kiln-field').first();
      check(scope, 'the picture comes back with them, shown from the kept file', (await back.getAttribute('data-kiln-src')) === staged && ((await back.getAttribute('src')) || '').startsWith('blob:'),
        `${await back.getAttribute('data-kiln-src')} ${((await back.getAttribute('src')) || '').slice(0, 24)}`);
      check(scope, 'the picture is drawn, not broken', await back.evaluate((img) => img.complete && img.naturalWidth > 0));
      const writes0 = gitWrites.length, puts0 = puts.length;
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.waitForTimeout(300);
      await press(page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).first());
      await page.waitForTimeout(500);
      await press(page.locator('#kiln-pubsheet-go'));
      await page.waitForTimeout(2200);
      const last = puts.length > puts0 ? Buffer.from(puts[puts.length - 1].content, 'base64').toString() : '';
      check(scope, 'publishing commits the picture\'s file, then the page that uses it', gitWrites.slice(writes0).some(w => /git\/blobs$/.test(w)) && puts.length === puts0 + 1 && last.includes(staged),
        `${gitWrites.length - writes0} file writes, ${puts.length - puts0} page writes`);
    }
  }
  check(scope, 'no script errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  check(scope, 'nothing outside the local server was needed', blocked.length === 0, blocked.slice(0, 3).join(', '));
  await context.close();
}

/**
 * A signed-in invited editor whose sign-in the worker ends (it answers 401 to
 * a session it no longer has). The worker, its sign-in included, is played
 * here: "signing in" hands the page a fresh session and sends it back.
 */
async function runSignInEnded(browser, size) {
  const phone = size.width < 600;
  const scope = `${size.width}x${size.height} sign-in ended`;
  const WORKER = 'https://worker.invalid';
  const REPO = 'acme/site';
  const source = await (await fetch(URL_ARG)).text();
  const file = new URL(URL_ARG).pathname.replace(/^\/+/, '').replace(/(^|\/)$/, '$1index.html');
  const hasEntry = (await fetch(`${ORIGIN}/kiln`).catch(() => ({ ok: false }))).ok;
  const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone });
  await context.addInitScript(([repo]) => {
    try {
      if (sessionStorage.getItem('ui_check_seeded')) return;   // once per tab: a sign-in that is dropped stays dropped
      sessionStorage.setItem('ui_check_seeded', '1');
      localStorage.setItem('kiln_editor', JSON.stringify({ session: 'a'.repeat(64), name: 'Sam', repo, role: 'editor' }));
      localStorage.setItem('kiln_guide', '1');
    } catch { /* ignore */ }
  }, [REPO]);
  const worker = { known: new Set(), answer: 200, puts: [], signIns: [], current: source, sha: 'sha0' };
  const blocked = [];
  await context.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': ORIGIN }, body: JSON.stringify(body) });
    if (u.origin === ORIGIN && u.pathname.endsWith('kiln-config.js')) {
      return route.fulfill({ contentType: 'text/javascript', body: `window.KILN = { repo: '${REPO}', branch: 'main', worker: '${WORKER}', styles: [] };` });
    }
    if (u.origin === ORIGIN || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    if (u.origin !== WORKER) return refuse(route, blocked);
    const p = decodeURIComponent(u.pathname);
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Kiln-Session', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS' } });
    }
    if (p === '/google/login') {
      const fresh = 'b'.repeat(64);
      worker.signIns.push(u.searchParams.get('return_to'));
      worker.known.add(fresh);
      return route.fulfill({ status: 302, headers: { Location: `${ORIGIN}${u.searchParams.get('return_to') || '/'}#${new URLSearchParams({ 'kiln-esession': fresh, 'kiln-name': 'Sam', 'kiln-repo': REPO })}` } });
    }
    if (p === '/healthz') return json({ ok: true, modes: ['html', 'source'], adapters: ['astro'] });
    const signedIn = worker.known.has(req.headers()['x-kiln-session'] || '');
    if (p === '/presence') return signedIn ? json({ ok: true, others: [], online: [], scope: { paths: [''], keys: [], features: null, mode: null } }) : json({ error: 'forbidden' }, 403);
    if (!p.startsWith('/gh/')) return json({ error: 'unauthorized' }, 401);
    if (!signedIn) return json({ error: 'session expired' }, 401);
    if (worker.answer === 500) return json({ error: 'internal error' }, 500);
    if (p === `/gh/repos/${REPO}/contents/${file}`) {
      if (req.method() === 'GET') return json({ sha: worker.sha, content: Buffer.from(worker.current).toString('base64') });
      if (worker.answer === 403) return json({ error: 'outside your editing scope', path: file }, 403);
      const body = JSON.parse(req.postData());
      worker.puts.push(body);
      worker.current = Buffer.from(body.content, 'base64').toString();
      worker.sha = `sha${worker.puts.length}`;
      return json({ commit: { sha: `commit${worker.puts.length}` }, content: {} });
    }
    if (p.includes('/deployments')) return json([]);
    if (p.endsWith('/status')) return json({ total_count: 0 });
    return json({ message: 'Not Found' }, 404);
  });
  const page = await context.newPage();
  const errors = [], leaving = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { leaving.push(d.type()); d.accept(); });
  const press = (locator) => (phone ? locator.tap() : locator.click());
  const shot = async (step) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${step}-${size.width}.png`) }); };
  const stored = () => page.evaluate(() => !!localStorage.getItem('kiln_editor'));
  const words = async (locator) => ((await locator.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  const notice = page.locator('#kiln-notice');
  const dialog = page.locator('#kiln-modal .kiln-modal-card');
  const status = page.locator('#kiln-status');
  const pencil = page.locator('#kiln-fab');
  const started = async () => { await pencil.waitFor({ state: 'visible', timeout: 15000 }); await page.waitForTimeout(700); };

  // ── page load: the worker does not know the stored sign-in ─────────────────
  await page.goto(URL_ARG, { waitUntil: 'load' });
  await notice.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  check(scope, 'page load: the page says the sign-in has ended and how to get back in', (await words(notice.locator('p').first())) === 'Your sign-in to edit this site has ended, so please sign in again with Google.', await words(notice));
  check(scope, 'page load: the sign-in is dropped and the editor draws nothing', !(await stored()) && (await pencil.count()) === 0 && (await page.locator('style[data-kiln]').count()) === 0);
  if (await notice.count()) {
    const n = await box(notice);
    check(scope, 'page load: the sentence is on screen, in the lower half, clear of the top of the page', n.left >= 0 && n.right <= size.width + 0.5 && n.bottom <= size.height + 0.5 && n.top > size.height / 2, `${Math.round(n.left)},${Math.round(n.top)} to ${Math.round(n.right)},${Math.round(n.bottom)}`);
    const s = await sideways(page);
    check(scope, 'page load: the page does not scroll sideways', s.sw === s.cw, `scrollWidth ${s.sw}, clientWidth ${s.cw}`);
    check(scope, 'page load: "Sign in again" can be pressed', ...Object.values(await hit(notice.getByRole('button', { name: 'Sign in again' }))));
    await shot('sign-in-ended-load');
    const dismiss = notice.getByRole('button', { name: 'Dismiss' });
    check(scope, 'page load: the sentence can be put away', ...Object.values(await hit(dismiss)));
    await press(dismiss);
    check(scope, 'page load: once put away, nothing of Kiln is left on the page', (await notice.count()) === 0);
  }
  if (hasEntry) {
    const hops = [];
    const hop = (f) => { if (f === page.mainFrame()) hops.push(new URL(f.url()).pathname); };
    page.on('framenavigated', hop);
    for (let i = 0; i < 2; i++) { await page.goto(`${ORIGIN}/kiln`, { waitUntil: 'load' }); await page.waitForTimeout(500); }
    check(scope, '/kiln shows the sign-in and sends nobody round', hops.every(h => /^\/kiln/.test(h)) && (await page.locator('#kiln-entry').count()) === 1, hops.join(' -> '));
    page.off('framenavigated', hop);
  }

  // ── signed in; the worker ends the sign-in while an edit is unpublished ────
  worker.known.add('a'.repeat(64));
  await page.goto(URL_ARG, { waitUntil: 'load' });
  await page.evaluate((repo) => localStorage.setItem('kiln_editor', JSON.stringify({ session: 'a'.repeat(64), name: 'Sam', repo, role: 'editor' })), REPO);
  await page.reload({ waitUntil: 'load' });
  await started();
  const heading = page.locator('h1.kiln-field, h2.kiln-field, h3.kiln-field').first();
  const publishNow = async () => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await press(page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).first());
    await page.waitForTimeout(500);
    if (await page.locator('#kiln-pubsheet-go').count()) await press(page.locator('#kiln-pubsheet-go'));
    await page.waitForTimeout(1800);
  };
  await heading.scrollIntoViewIfNeeded();
  await press(heading);
  await page.keyboard.type(' Kept words');
  await press(page.locator('#kiln-toolbar .kiln-tb-save'));
  await page.waitForTimeout(300);

  // trouble first: a 500 drops neither the sign-in nor the edit
  worker.answer = 500;
  await publishNow();
  check(scope, 'a 500 at Publish: the status line says nothing was lost and to try again', (await words(status)) === 'Not published: the site had a problem just now. Your edit is still here, so please try again in a moment.', await words(status));
  check(scope, 'a 500 at Publish: still signed in, the edit still on the page, nothing written', (await stored()) && (await words(heading)).includes('Kept words') && worker.puts.length === 0 && (await dialog.count()) === 0);
  // a 403: the edit stays and the text can be copied; signing in again is not offered
  worker.answer = 403;
  await publishNow();
  check(scope, 'a 403 at Publish: a dialog says the sign-in does not allow it, with the reason, and the edit is still there',
    /^✕ This was not published Your sign-in does not allow this change, so nothing was published\. Your edit is still on this page: copy your text to keep it, and ask the site’s owner\. The answer was: outside your editing scope/.test(await words(dialog)), (await words(dialog)).slice(0, 140));
  check(scope, 'a 403 at Publish: "Copy my text" is offered and "Sign in again" is not', (await dialog.locator('#kiln-stop-copy').count()) === 1 && (await dialog.locator('#kiln-stop-go').count()) === 0 && (await stored()));
  await shot('publish-not-allowed');
  if (await dialog.count()) await press(dialog.locator('[data-close]').last());
  worker.answer = 200;

  // the sign-in ends
  worker.known.clear();
  await publishNow();
  check(scope, 'sign-in ended at Publish: a dialog says nothing was published and that the edit is saved',
    (await words(dialog)) === '✕ Your sign-in has ended Nothing was published. Your edit is saved in this browser and will be back on this page when you have signed in again with Google. Not now Sign in again', await words(dialog));
  if (await dialog.count()) {
    const c = await box(dialog);
    check(scope, 'sign-in ended at Publish: the dialog fits on screen', c.left >= 0 && c.top >= 0 && c.right <= size.width + 0.5 && c.bottom <= size.height + 0.5);
  }
  check(scope, 'sign-in ended at Publish: nothing was written and the words are still on the page', worker.puts.length === 0 && (await words(heading)).includes('Kept words'));
  await shot('sign-in-ended-publish');
  if (await dialog.count()) await press(dialog.locator('[data-close]').last());
  await page.waitForTimeout(300);
  check(scope, 'sign-in ended at Publish: the dialog can be put away, and the status line keeps a way back to it', (await dialog.count()) === 0
    && (await words(status)) === 'Not published: your sign-in has ended. Sign in again' && (await page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).count()) === 1);
  if (await status.locator('.kiln-status-act').count()) await press(status.locator('.kiln-status-act'));
  await page.waitForTimeout(300);
  if (await page.locator('#kiln-stop-go').count()) await press(page.locator('#kiln-stop-go'));
  await page.waitForURL((u) => !u.hash.includes('kiln-esession'), { timeout: 15000 }).catch(() => {});
  await started();
  check(scope, 'signing in again comes back to the same page, without the browser asking about leaving', worker.signIns.length === 1 && worker.signIns[0] === new URL(URL_ARG).pathname && leaving.length === 0, `${worker.signIns.join(', ')}; ${leaving.length} prompts`);
  check(scope, 'the edit is back on the page without a question', (await page.locator('#kiln-rest-yes').count()) === 0 && (await words(heading)).includes('Kept words')
    && (await words(status)) === 'You are signed in again, and your edit is back on this page. Publish when ready.', await words(status));
  await shot('signed-in-again');
  await publishNow();
  check(scope, 'Publish then sends the same edit', worker.puts.length === 1 && Buffer.from(worker.puts[0]?.content || '', 'base64').toString().includes('Kept words'), `${worker.puts.length} writes`);
  check(scope, 'no script errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  check(scope, 'nothing outside the local server was needed', blocked.length === 0, blocked.slice(0, 3).join(', '));
  await context.close();
}

/**
 * The worker ends an invited editor's sign-in, and they find out somewhere
 * other than at Publish: opening History, going back to a version, naming one,
 * saving a draft, scheduling, cancelling a schedule, posting a comment or a
 * reply, sending a suggestion, listing the site's pictures, asking the AI,
 * page settings, the site menu, a new page, find and replace, undoing a
 * publish, or doing nothing at all (the editor asks who else is here).
 * Each must show the dialog Publish shows, lose nothing that was typed, and
 * bring back what the saved copy holds after signing in again. A sign-in that
 * ran out by the browser's own clock must be said once on the next page.
 */
async function runSignInEverywhere(browser, size) {
  const phone = size.width < 600;
  const scope = `${size.width}x${size.height} ended elsewhere`;
  const WORKER = 'https://worker.invalid';
  const REPO = 'acme/site';
  const OLD = 'a'.repeat(64), FRESH = 'b'.repeat(64);
  const source = await (await fetch(URL_ARG)).text();
  const file = new URL(URL_ARG).pathname.replace(/^\/+/, '').replace(/(^|\/)$/, '$1index.html');
  // the page as an earlier publish left it: the first heading read differently
  const firstHeading = /<(h[1-3])\b[^>]*\sdata-cms="[^"]+"[^>]*>([\s\S]*?)<\/\1>/.exec(source);
  const older = firstHeading ? source.replace(firstHeading[0], firstHeading[0].replace(firstHeading[2], 'An older headline')) : source;
  const pictures = [...new Set([...source.matchAll(/<img\b[^>]*\ssrc="(\/[^"?#]+\.(?:jpe?g|png|webp|avif|gif))"/gi)].map(m => m[1].slice(1)))];
  const tree = [...pictures.map(path => ({ path, type: 'blob', size: 48 * 1024 })), { path: file, type: 'blob', size: source.length }];
  const TOOLS = ['pagesettings', 'history', 'draft', 'schedule', 'comments', 'ai', 'newpost', 'menu', 'findreplace', 'theme'];
  const day = 24 * 3600 * 1000;
  const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN }).catch(() => {});
  await context.addInitScript(() => { try { localStorage.setItem('kiln_guide', '1'); } catch { /* ignore */ } });
  const worker = {};
  const reset = () => Object.assign(worker, {
    known: new Set([OLD]), mode: null, fail: null, grantSchedule: true, signIns: [], puts: [], current: source, sha: 'sha0', draftBranch: false,
    schedules: [{ id: '1'.repeat(32), at: Date.now() + 3 * day, desc: `${file} (opening hours)`, path: file, by: 'Sam' }], scheduled: [], cancelled: [],
    threads: [{ id: 't1', status: 'open', created: Date.now() - day, anchor: null, messages: [{ by: 'Ana', ts: Date.now() - day, text: 'Is the price still right?' }] }], posted: [],
    suggested: [], tags: [], asked: 0,
  });
  reset();
  const blocked = [];
  await context.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': ORIGIN }, body: JSON.stringify(body) });
    if (u.origin === ORIGIN && u.pathname.endsWith('kiln-config.js')) {
      return route.fulfill({ contentType: 'text/javascript', body: `window.KILN = { repo: '${REPO}', branch: 'main', worker: '${WORKER}', styles: [] };` });
    }
    if (u.origin === ORIGIN || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    if (u.origin !== WORKER) return refuse(route, blocked);
    const p = decodeURIComponent(u.pathname);
    const method = req.method();
    if (method === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Kiln-Session', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' } });
    }
    if (p === '/google/login') {
      worker.signIns.push(u.searchParams.get('return_to'));
      worker.known.add(FRESH);
      return route.fulfill({ status: 302, headers: { Location: `${ORIGIN}${u.searchParams.get('return_to') || '/'}#${new URLSearchParams({ 'kiln-esession': FRESH, 'kiln-name': 'Sam', 'kiln-repo': REPO })}` } });
    }
    if (p === '/healthz') return json({ ok: true, modes: ['html', 'source'], adapters: ['astro'] });
    const signedIn = worker.known.has(req.headers()['x-kiln-session'] || '');
    const body = () => { try { return JSON.parse(req.postData() || '{}'); } catch { return {}; } };
    // what the worker answers to someone it does not know, route by route (worker/index.js)
    const unknown403 = () => json({ error: 'forbidden' }, 403);
    const unknown401 = () => json({ error: 'unauthorized' }, 401);
    if (worker.fail && worker.fail.test(`${method} ${p}`)) return json({ error: 'internal error' }, 500);
    if (p === '/presence') return signedIn ? json({ ok: true, others: [], online: [], scope: { paths: [''], keys: [], features: TOOLS, mode: worker.mode } }) : unknown403();
    if (p === '/schedules') return signedIn ? json({ schedules: worker.schedules }) : unknown403();
    if (p === '/schedule') {
      if (!signedIn) return unknown403();
      if (!worker.grantSchedule) return json({ error: 'your access does not include scheduling', code: 'grant_required', grant: 'schedule' }, 403);
      const b = body();
      worker.scheduled.push(b);
      worker.schedules.push({ id: '2'.repeat(32), at: Date.parse(b.at), desc: b.desc, path: b.path, by: 'Sam' });
      return json({ ok: true, id: '2'.repeat(32), at: Date.parse(b.at) });
    }
    if (p === '/schedule/cancel') {
      if (!signedIn) return unknown403();
      worker.cancelled.push(body().id);
      worker.schedules = worker.schedules.filter(x => x.id !== body().id);
      return json({ ok: true });
    }
    if (p === '/comments/counts') return signedIn ? json({ total: worker.threads.length, counts: { [file]: worker.threads.filter(t => t.status === 'open').length } }) : unknown401();
    if (p === '/comments' && method === 'GET') return signedIn ? json({ threads: worker.threads }) : unknown401();
    if (p === '/comments') {
      if (!signedIn) return unknown401();
      const b = body();
      worker.posted.push(b);
      let thread = worker.threads.find(t => t.id === b.thread);
      if (thread) thread.messages.push({ by: 'Sam', ts: Date.now(), text: b.text });
      else { thread = { id: `t${worker.threads.length + 1}`, status: 'open', created: Date.now(), anchor: b.anchor || null, messages: [{ by: 'Sam', ts: Date.now(), text: b.text }] }; worker.threads.unshift(thread); }
      return json({ thread });
    }
    if (p === '/suggestions' && method === 'GET') return signedIn ? json({ suggestions: [], counts: { open: 0 } }) : unknown401();
    if (p === '/suggestions') {
      if (!signedIn) return unknown401();
      worker.suggested.push(body());
      return json({ suggestion: { id: 's1', status: 'open' } });
    }
    if (p === '/ai/assist') { worker.asked++; return signedIn ? json({ text: 'A brighter headline' }) : unknown401(); }
    if (!p.startsWith('/gh/')) return json({ error: 'not found' }, 404);
    if (!signedIn) return json({ error: 'session expired' }, 401);
    const gh = p.slice(`/gh/repos/${REPO}`.length);
    if (gh === `/contents/${file}`) {
      if (method === 'GET') {
        const ref = u.searchParams.get('ref');
        if (ref === 'kiln-drafts') return json({ message: 'Not Found' }, 404);
        return json({ sha: ref === 'c1' ? 'old' : worker.sha, content: Buffer.from(ref === 'c1' ? older : worker.current).toString('base64') });
      }
      const b = body();
      worker.puts.push(b);
      if (b.branch === 'main') { worker.current = Buffer.from(b.content, 'base64').toString(); worker.sha = `sha${worker.puts.length}`; }
      return json({ commit: { sha: `commit${worker.puts.length}` }, content: {} });
    }
    if (gh === '/contents') return json([{ path: 'index.html', type: 'file' }, { path: 'assets', type: 'dir' }]);
    if (gh === '/commits') {
      const commit = (sha, parent, daysAgo) => ({ sha, parents: [{ sha: parent }], commit: { message: `Edit ${file}: hero_headline (via Kiln)`, author: { name: 'Sam', date: new Date(Date.now() - daysAgo * day).toISOString() } } });
      return json([commit('c2', 'c1', 1), commit('c1', 'c0', 9)]);
    }
    if (gh === '/git/matching-refs/tags/kiln/') return json(worker.tags);
    if (gh === '/git/refs' && method === 'POST') {
      const b = body();
      if (b.ref.startsWith('refs/tags/')) worker.tags.push({ ref: b.ref, object: { sha: b.sha } }); else worker.draftBranch = true;
      return json({ ref: b.ref, object: { sha: b.sha } }, 201);
    }
    if (gh === '/git/ref/heads/main') return json({ object: { sha: 'head' } });
    if (gh === '/git/ref/heads/kiln-drafts') return worker.draftBranch ? json({ object: { sha: 'head' } }) : json({ message: 'Not Found' }, 404);
    if (gh === '/git/trees/main' && method === 'GET') return json({ sha: 'tree', tree, truncated: false });
    if (gh.includes('/deployments')) return json([]);
    if (gh.endsWith('/status')) return json({ total_count: 0 });
    return json({ message: 'Not Found' }, 404);
  });
  const page = await context.newPage();
  const errors = [], leaving = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { leaving.push(d.type()); d.accept(); });
  const press = (locator) => (phone ? locator.tap() : locator.click());
  const shot = async (step) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${step}-${size.width}.png`) }); };
  const words = async (locator) => ((await locator.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  const dialog = page.locator('#kiln-modal .kiln-modal-card');             // whatever panel or dialog is on top
  const told = page.locator('#kiln-modal[data-over] .kiln-modal-card');    // the dialog about the sign-in, over a panel or on its own
  const status = page.locator('#kiln-status');
  const pencil = page.locator('#kiln-fab');
  const heading = page.locator('h1.kiln-field, h2.kiln-field, h3.kiln-field').first();
  const started = async () => { await pencil.waitFor({ state: 'visible', timeout: 15000 }); await page.waitForTimeout(700); };
  /**
   * The editor on the page has finished with the sign-in it found: it started, or it said why not and
   * dropped it. Only then is the browser's storage ours to set (it would otherwise remove what we put there).
   */
  const settled = () => page.locator('#kiln-fab, #kiln-notice').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  /** A fresh page, signed in, with nothing left over from the case before. */
  const fresh = async (opts = {}) => {
    reset();
    Object.assign(worker, opts);
    await page.goto(URL_ARG, { waitUntil: 'load' });
    await settled();
    await page.evaluate(([repo, session]) => {
      for (const k of Object.keys(localStorage)) if (/^kiln_(pending|publishing)/.test(k)) localStorage.removeItem(k);
      sessionStorage.clear();
      localStorage.setItem('kiln_editor', JSON.stringify({ session, name: 'Sam', repo, role: 'editor' }));
    }, [REPO, OLD]);
    await page.reload({ waitUntil: 'load' });
    await started();
    leaving.length = 0;   // "leave this page?" prompts from here on belong to this case
  };
  const end = () => worker.known.clear();
  /** A menu entry, pressed the way the menu presses it (the menu itself is checked elsewhere). */
  const menu = async (id) => { await page.evaluate((i) => document.getElementById(i).click(), id); await page.waitForTimeout(500); };
  const edit = async () => {
    await heading.scrollIntoViewIfNeeded();
    await press(heading);
    await page.keyboard.type(' Kept words');
    await press(page.locator('#kiln-toolbar .kiln-tb-save'));
    await page.waitForTimeout(300);
  };
  const ENDED = '✕ Your sign-in has ended ';
  const BACK = 'when you have signed in again with Google';
  /** The dialog says `text` (after its title), fits on screen, and offers the way back in. */
  const ended = async (name, text, buttons = 'Not now Sign in again') => {
    await told.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const said = (await told.count()) ? await words(told) : `no dialog; on screen: ${await words(dialog)} ${await words(status)}`;
    check(scope, `${name}: the dialog says the sign-in has ended, and what is kept`, said === `${ENDED}${text} ${buttons}`, said.slice(0, 260));
    if (await told.count()) {
      const c = await box(told);
      check(scope, `${name}: the dialog fits on screen`, c.left >= 0 && c.top >= 0 && c.right <= size.width + 0.5 && c.bottom <= size.height + 0.5);
    }
  };
  const notNow = async () => { if (await told.count()) await press(told.locator('[data-close]').last()); await page.waitForTimeout(300); };
  const signInAgain = async () => {
    if (await page.locator('#kiln-stop-go').count()) await press(page.locator('#kiln-stop-go'));
    await page.waitForURL((u) => u.origin === ORIGIN && !u.hash.includes('kiln-esession'), { timeout: 15000 }).catch(() => {});
    await started();
  };
  /** One case: whatever goes wrong inside it is that case's failure, and the next one starts afresh. */
  const scene = async (name, fn) => {
    try { await fn(name); } catch (err) { check(scope, `${name}: ran to the end`, false, String(err.message || err).split('\n')[0].slice(0, 200)); }
  };

  // ── History: the list, an earlier version, a name for one ──────────────────
  await scene('History', async (name) => {
    await fresh();
    end();
    await menu('kiln-history');
    await ended(name, 'Please sign in again with Google to carry on.');
    await shot('ended-history');
    await notNow();
    check(scope, `${name}: put away, the panel is still there and says why it is empty`, (await words(dialog)).includes('Page history') && (await words(page.locator('#kiln-hist-status'))) === 'Your sign-in has ended.', (await words(dialog)).slice(-120));
  });
  await scene('History, going back to a version', async (name) => {
    await fresh();
    await edit();
    await menu('kiln-history');
    await page.locator('#kiln-hist [data-act="restore"]').first().waitFor({ state: 'visible', timeout: 5000 });
    end();
    await press(page.locator('#kiln-hist [data-act="restore"]').first());
    await ended(name, `Your edit is saved in this browser and will be back on this page ${BACK}.`);
    await shot('ended-history-restore');
    await notNow();
    check(scope, `${name}: put away, History is as it was, with its list`, (await page.locator('#kiln-modal #kiln-hist .kiln-hist-row').count()) === 2 && (await words(page.locator('#kiln-hist-status'))) === 'Your sign-in has ended.');
  });
  await scene('History, naming a version', async (name) => {
    await fresh();
    await menu('kiln-history');
    await page.locator('#kiln-hist [data-act="name"]').first().waitFor({ state: 'visible', timeout: 5000 });
    await press(page.locator('#kiln-hist [data-act="name"]').first());
    await page.locator('.kiln-nv-input').fill('Summer menu');
    end();
    await press(page.locator('.kiln-nv-form [data-nv="save"]'));
    await ended(name, `Nothing was saved. The name you typed is saved in this browser and will be back on this page ${BACK}.`);
    await shot('ended-history-name');
    await notNow();
    check(scope, `${name}: put away, the name is still in its box`, (await page.locator('#kiln-modal .kiln-nv-input').inputValue().catch(() => '')) === 'Summer menu');
    await press(page.locator('.kiln-nv-form [data-nv="save"]'));   // pressed again, it says the same, and this time they go
    await told.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await signInAgain();
    await page.locator('#kiln-modal .kiln-nv-input').waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
    check(scope, `${name}: after signing in again History is open with the name in its box`, (await page.locator('#kiln-modal .kiln-nv-input').inputValue().catch(() => '')) === 'Summer menu'
      && (await words(status)) === 'You are signed in again, and the name you typed is back on this page.', await words(status));
    if (await page.locator('.kiln-nv-form [data-nv="save"]').count()) await press(page.locator('.kiln-nv-form [data-nv="save"]'));
    await page.waitForTimeout(600);
    check(scope, `${name}: saving it then names that version`, worker.tags.length === 1 && /^refs\/tags\/kiln\/\d+-summer-menu$/.test(worker.tags[0]?.ref || '') && worker.tags[0]?.object.sha === 'c2', JSON.stringify(worker.tags));
  });

  // ── Save as draft ──────────────────────────────────────────────────────────
  await scene('Save as draft', async (name) => {
    await fresh();
    await edit();
    end();
    await menu('kiln-draft');
    await ended(name, `Nothing was saved. Your edit is saved in this browser and will be back on this page ${BACK}.`);
    await shot('ended-draft');
    await notNow();
    check(scope, `${name}: the words are still on the page, still unpublished, and the status line keeps a way back`, (await words(heading)).includes('Kept words')
      && (await words(status)) === 'Not saved: your sign-in has ended. Sign in again' && worker.puts.length === 0, await words(status));
  });

  // ── Schedule: the time, an ended sign-in told apart from "not allowed", cancel ─
  await scene('Schedule', async (name) => {
    await fresh();
    await edit();
    await menu('kiln-schedule');
    await page.locator('#kiln-sc-list .kiln-inv-row').first().waitFor({ state: 'visible', timeout: 5000 });
    const at = '2031-05-17T09:30';
    await page.locator('#kiln-sc-at').fill(at);
    // trouble first: nothing is lost and nothing is asked about the sign-in
    worker.fail = /^POST \/schedule$/;
    await press(page.locator('#kiln-sc-go'));
    await page.waitForTimeout(600);
    check(scope, `${name}: a 500 says nothing was lost and to try again, in the panel`, (await words(page.locator('#kiln-sc-status'))) === 'Not scheduled: the site had a problem just now. Your edit is still here, so please try again in a moment.', await words(page.locator('#kiln-sc-status')));
    worker.fail = null;
    // signed in, but scheduling is not part of this person's access
    worker.grantSchedule = false;
    await press(page.locator('#kiln-sc-go'));
    await told.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    check(scope, `${name}: a 403 with the sign-in still good says it is not allowed, with the reason, and does not offer to sign in`,
      /^✕ This was not scheduled Your sign-in does not allow this change, so nothing was scheduled\. Your edit is still on this page: copy your text to keep it, and ask the site’s owner\. The answer was: your access does not include scheduling/.test(await words(told))
      && (await told.locator('#kiln-stop-go').count()) === 0, (await words(dialog)).slice(0, 200));
    await shot('schedule-not-allowed');
    await notNow();
    worker.grantSchedule = true;
    // the worker answers 403 here to a sign-in it no longer knows: the editor finds out which it is
    end();
    await press(page.locator('#kiln-sc-go'));
    await ended(name, `Nothing was scheduled. Your edit is saved in this browser and will be back on this page ${BACK}, and so will the time you chose.`);
    await shot('ended-schedule');
    await notNow();
    check(scope, `${name}: put away, the panel is still there with the time`, (await page.locator('#kiln-modal #kiln-sc-at').inputValue().catch(() => '')) === at
      && (await words(page.locator('#kiln-sc-status'))) === 'Not scheduled: your sign-in has ended.', await words(page.locator('#kiln-sc-status')));
    await shot('ended-schedule-put-away');
    await press(page.locator('#kiln-sc-go'));   // pressed again, it says the same, and this time they go
    await told.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await signInAgain();
    await page.locator('#kiln-modal #kiln-sc-at').waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
    check(scope, `${name}: after signing in again the edit is back and the panel is open with the time`, (await words(heading)).includes('Kept words')
      && (await page.locator('#kiln-modal #kiln-sc-at').inputValue().catch(() => '')) === at && leaving.length === 0
      && (await words(status)) === 'You are signed in again, and your edit is back on this page, with the time you chose. Publish when ready.', await words(status));
    await shot('ended-schedule-back');
    if (await page.locator('#kiln-sc-go').count()) await press(page.locator('#kiln-sc-go'));
    await page.waitForTimeout(700);
    check(scope, `${name}: Schedule then sends that edit for that time`, worker.scheduled.length === 1 && worker.scheduled[0].at === new Date(at).toISOString()
      && JSON.stringify(worker.scheduled[0].edits || '').includes('Kept words'), `${worker.scheduled.length} scheduled`);
  });
  await scene('Schedule, cancelling one', async (name) => {
    await fresh();
    await edit();
    await menu('kiln-schedule');
    await page.locator('#kiln-sc-list .kiln-inv-row button').first().waitFor({ state: 'visible', timeout: 5000 });
    end();
    await press(page.locator('#kiln-sc-list .kiln-inv-row button').first());
    // Cancel asks first now ("Yes, cancel it"): the ended sign-in is found when the answer is yes.
    await press(page.locator('#kiln-sc-list [data-yes]').first());
    await ended(name, `Nothing was canceled. Your edit is saved in this browser and will be back on this page ${BACK}.`);
    await notNow();
    check(scope, `${name}: nothing was cancelled, and the list is as it was`, worker.cancelled.length === 0 && (await page.locator('#kiln-modal #kiln-sc-list .kiln-inv-row').count()) === 1);
  });

  // ── Comments: a new one, and a reply ───────────────────────────────────────
  await scene('Comment', async (name) => {
    await fresh();
    await menu('kiln-comments');
    await press(page.locator('#kiln-cmt-new'));
    const spot = await box(heading);
    await page.mouse.click(spot.left + Math.min(40, spot.width / 2), spot.top + spot.height / 2);
    const composer = page.locator('#kiln-cmt-composer');
    await composer.locator('textarea').fill('The price on the third card is out of date.');
    end();
    await press(composer.getByRole('button', { name: 'Post' }));
    await ended(name, `Nothing was posted. Your comment is saved in this browser and will be back on this page ${BACK}.`);
    await shot('ended-comment');
    await notNow();
    check(scope, `${name}: put away, the comment is still in its box, unposted`, (await composer.locator('textarea').inputValue().catch(() => '')) === 'The price on the third card is out of date.' && worker.posted.length === 0
      && (await words(status)) === 'Not posted: your sign-in has ended. Sign in again', await words(status));
    await shot('ended-comment-put-away');
    await press(status.locator('.kiln-status-act'));
    await signInAgain();
    await composer.waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
    check(scope, `${name}: after signing in again the comment is back in its box`, (await composer.locator('textarea').inputValue().catch(() => '')) === 'The price on the third card is out of date.'
      && (await words(status)) === 'You are signed in again, and your comment is back on this page.' && leaving.length === 0, await words(status));
    await shot('ended-comment-back');
    if (await composer.count()) await press(composer.getByRole('button', { name: 'Post' }));
    await page.waitForTimeout(700);
    check(scope, `${name}: Post then sends it, pinned where it was put`, worker.posted.length === 1 && worker.posted[0].text === 'The price on the third card is out of date.' && !!worker.posted[0].anchor, JSON.stringify(worker.posted).slice(0, 160));
  });
  await scene('Comment, a reply', async (name) => {
    await fresh();
    await edit();
    await menu('kiln-comments');
    const reply = page.locator('#kiln-modal .kiln-cmt-reply');
    await reply.locator('input').fill('Yes, until June.');
    end();
    await press(reply.getByRole('button', { name: 'Reply' }));
    await ended(name, `Nothing was posted. Your edit is saved in this browser and will be back on this page ${BACK}, and so will your reply.`);
    await shot('ended-reply');
    await notNow();
    check(scope, `${name}: put away, the reply is still in its box`, (await page.locator('#kiln-modal .kiln-cmt-reply input').inputValue().catch(() => '')) === 'Yes, until June.' && worker.posted.length === 0);
    await press(page.locator('#kiln-modal .kiln-cmt-reply').getByRole('button', { name: 'Reply' }));
    await told.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await signInAgain();
    await page.locator('#kiln-modal .kiln-cmt-reply input').waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(600);
    check(scope, `${name}: after signing in again the edit and the reply are back`, (await words(heading)).includes('Kept words')
      && (await page.locator('#kiln-modal .kiln-cmt-reply input').inputValue().catch(() => '')) === 'Yes, until June.'
      && (await words(status)) === 'You are signed in again, and your edit is back on this page, with your reply. Publish when ready.', await words(status));
  });

  // ── A suggestion, with its note ────────────────────────────────────────────
  await scene('Suggestion', async (name) => {
    await fresh({ mode: 'suggest' });
    await edit();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await press(page.getByRole('button', { name: /^Send|^Suggest/ }).filter({ visible: true }).first());
    await page.locator('#kiln-ps-note').fill('Corrected the opening line');
    end();
    await press(page.locator('#kiln-pubsheet-go'));
    await ended(name, `Nothing was sent. Your edit is saved in this browser and will be back on this page ${BACK}, and so will your note.`);
    await shot('ended-suggestion');
    await signInAgain();
    check(scope, `${name}: after signing in again the edit is back, and the status line says the note is too`, (await words(heading)).includes('Kept words')
      && (await words(status)) === 'You are signed in again, and your edit is back on this page, with your note. Publish when ready.', await words(status));
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await press(page.getByRole('button', { name: /^Send|^Suggest/ }).filter({ visible: true }).first());
    check(scope, `${name}: the note is back in its box`, (await page.locator('#kiln-ps-note').inputValue().catch(() => '')) === 'Corrected the opening line');
    if (await page.locator('#kiln-pubsheet-go').count()) await press(page.locator('#kiln-pubsheet-go'));
    await page.waitForTimeout(800);
    check(scope, `${name}: sending it then carries the edit and the note`, worker.suggested.length === 1 && worker.suggested[0].note === 'Corrected the opening line' && JSON.stringify(worker.suggested[0].edits).includes('Kept words'), JSON.stringify(worker.suggested).slice(0, 160));
  });

  // ── The site's pictures ────────────────────────────────────────────────────
  await scene('Pictures of this site', async (name) => {
    await fresh();
    const picture = page.locator('img[data-cms].kiln-field, img.kiln-field').first();
    await picture.scrollIntoViewIfNeeded();
    await press(picture);
    await press(page.locator('#kiln-toolbar [data-act="replace"]'));
    end();
    await press(page.locator('#kiln-pick-tab-site'));
    await ended(name, 'Please sign in again with Google to carry on.');
    await shot('ended-pictures');
    await notNow();
    check(scope, `${name}: put away, the picker is still there, says why the list is empty, and still offers an upload`, (await words(page.locator('#kiln-modal #kiln-pick-note'))) === 'Your sign-in has ended.'
      && (await page.locator('#kiln-modal #kiln-pick-tab-upload').count()) === 1, await words(page.locator('#kiln-pick-note')));
  });

  // ── AI assist: the words being typed are kept too ──────────────────────────
  await scene('AI assist', async (name) => {
    await fresh();
    await heading.scrollIntoViewIfNeeded();
    await press(heading);
    await page.keyboard.type(' Kept words');
    end();
    await press(page.locator('#kiln-toolbar #kiln-ai'));
    await press(page.locator('#kiln-ai-menu button').first());
    await ended(name, `Your edit is saved in this browser and will be back on this page ${BACK}.`);
    await shot('ended-ai');
    await signInAgain();
    check(scope, `${name}: after signing in again the words that were being typed are back`, (await words(heading)).includes('Kept words')
      && (await words(status)) === 'You are signed in again, and your edit is back on this page. Publish when ready.', await words(status));
  });

  // ── Panels whose boxes the saved copy does not hold: kept on screen, and offered as a copy ─
  await scene('Page settings', async (name) => {
    await fresh();
    await menu('kiln-pagesettings');
    await page.locator('#kiln-ps-title').fill('Muskrat and Rorke, summer');
    end();
    await press(page.locator('#kiln-ps-go'));
    await ended(name, 'Nothing was published. Signing in again with Google loads this page afresh. What you typed here cannot be saved and will need typing again. Copy your text first to be sure of it.', 'Not now Copy my text Sign in again');
    await shot('ended-page-settings');
    if (await page.locator('#kiln-stop-copy').count()) await press(page.locator('#kiln-stop-copy'));
    await page.waitForTimeout(300);
    const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    const shown = await page.locator('#kiln-stop-text').inputValue().catch(() => '');
    check(scope, `${name}: "Copy my text" gives what was typed in the panel`, (copied || shown).includes('Muskrat and Rorke, summer'), (copied || shown).slice(0, 120));
    await notNow();
    check(scope, `${name}: put away, the panel is still there with what was typed`, (await page.locator('#kiln-modal #kiln-ps-title').inputValue().catch(() => '')) === 'Muskrat and Rorke, summer'
      && (await words(page.locator('#kiln-ps-status'))) === 'Not published: your sign-in has ended.', await words(page.locator('#kiln-ps-status')));
    await shot('ended-page-settings-put-away');
  });
  await scene('Site menu', async (name) => {
    await fresh();
    await menu('kiln-menu');
    await press(page.locator('#kiln-menu-add'));
    await page.locator('.kiln-menu-label').last().fill('Stockists');
    end();
    await press(page.locator('#kiln-menu-save'));
    await ended(name, 'Nothing was saved. Signing in again with Google loads this page afresh. What you typed here cannot be saved and will need typing again. Copy your text first to be sure of it.', 'Not now Copy my text Sign in again');
    await shot('ended-site-menu');
    await notNow();
    check(scope, `${name}: put away, the rows are as they were typed`, (await page.locator('#kiln-modal .kiln-menu-label').last().inputValue().catch(() => '')) === 'Stockists'
      && (await words(page.locator('#kiln-menu-status'))) === 'Not saved: your sign-in has ended.', await words(page.locator('#kiln-menu-status')));
  });
  await scene('New page', async (name) => {
    await fresh();
    await menu('kiln-newpost');
    await page.locator('#kiln-np-title').fill('Autumn drop');
    end();
    await press(page.locator('#kiln-np-go'));
    await ended(name, 'Nothing was created. Signing in again with Google loads this page afresh. What you typed here cannot be saved and will need typing again. Copy your text first to be sure of it.', 'Not now Copy my text Sign in again');
    await shot('ended-new-page');
    await notNow();
    check(scope, `${name}: put away, the title is still in its box and Create can be pressed again`, (await page.locator('#kiln-modal #kiln-np-title').inputValue().catch(() => '')) === 'Autumn drop'
      && await page.locator('#kiln-modal #kiln-np-go').isVisible().catch(() => false));
  });
  await scene('Find and replace', async (name) => {
    await fresh();
    await menu('kiln-findreplace');
    await page.locator('#kiln-fr-find').fill('Atlanta');
    await page.locator('#kiln-fr-repl').fill('Decatur');
    end();
    await press(page.locator('#kiln-fr-scan'));
    await ended(name, 'Signing in again with Google loads this page afresh. What you typed here cannot be saved and will need typing again. Copy your text first to be sure of it.', 'Not now Copy my text Sign in again');
    await shot('ended-find-replace');
    await notNow();
    check(scope, `${name}: put away, both boxes are as they were typed`, (await page.locator('#kiln-modal #kiln-fr-find').inputValue().catch(() => '')) === 'Atlanta'
      && (await page.locator('#kiln-modal #kiln-fr-repl').inputValue().catch(() => '')) === 'Decatur');
  });

  // ── Undo, in the ten seconds after a publish ───────────────────────────────
  await scene('Undo after publishing', async (name) => {
    await fresh();
    await edit();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await press(page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).first());
    await page.waitForTimeout(500);
    if (await page.locator('#kiln-pubsheet-go').count()) await press(page.locator('#kiln-pubsheet-go'));
    await status.locator('.kiln-status-act').waitFor({ state: 'visible', timeout: 6000 });
    await page.waitForTimeout(1200);   // the editor's first look at whether the publish is live has been answered
    end();
    await press(status.locator('.kiln-status-act'));
    await ended(name, 'Nothing was undone. Please sign in again with Google to carry on.');
    await shot('ended-undo');
    check(scope, `${name}: the publish itself is as it was`, worker.puts.length === 1);
  });

  // ── Nobody pressed anything: the editor asks who else is here, and is told ─
  await scene('Found out by the editor itself', async (name) => {
    await fresh();
    await edit();
    end();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(900);
    check(scope, `${name}: the status line says so and offers the way back in, with no dialog in the way`, (await words(status)) === 'Your sign-in has ended. Sign in again' && (await dialog.count()) === 0, await words(status));
    await shot('ended-found-out');
    if (await status.locator('.kiln-status-act').count()) await press(status.locator('.kiln-status-act'));
    await ended(name, `Your edit is saved in this browser and will be back on this page ${BACK}.`);
  });

  await scene('A comment half written when the editor finds out', async (name) => {
    await fresh();
    await menu('kiln-comments');
    await press(page.locator('#kiln-cmt-new'));
    const spot = await box(heading);
    await page.mouse.click(spot.left + Math.min(40, spot.width / 2), spot.top + spot.height / 2);
    const composer = page.locator('#kiln-cmt-composer');
    await composer.locator('textarea').fill('Half a thought');
    end();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await status.locator('.kiln-status-act').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    if (await status.locator('.kiln-status-act').count()) await press(status.locator('.kiln-status-act'));
    await ended(name, `Your comment is saved in this browser and will be back on this page ${BACK}.`);
    await signInAgain();
    await composer.waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
    check(scope, `${name}: after signing in again the comment is back in its box, though Post was never pressed`, (await composer.locator('textarea').inputValue().catch(() => '')) === 'Half a thought' && worker.posted.length === 0);
  });

  // ── Publish itself, with a line typed under "What changed?" ────────────────
  await scene('Publish, with a note', async (name) => {
    await fresh();
    await edit();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await press(page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).first());
    await page.locator('#kiln-ps-note').fill('New opening line');
    end();
    await press(page.locator('#kiln-pubsheet-go'));
    await ended(name, `Nothing was published. Your edit is saved in this browser and will be back on this page ${BACK}, and so will your note.`);
    await notNow();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await press(page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).first());
    check(scope, `${name}: put away, the note is back in its box when the sheet is opened again`, (await page.locator('#kiln-ps-note').inputValue().catch(() => '')) === 'New opening line');
    if (await page.locator('#kiln-pubsheet-go').count()) await press(page.locator('#kiln-pubsheet-go'));
    await told.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await signInAgain();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await press(page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).first());
    check(scope, `${name}: after signing in again the edit is back, and the note is in its box`, (await words(heading)).includes('Kept words') && (await page.locator('#kiln-ps-note').inputValue().catch(() => '')) === 'New opening line');
    if (await page.locator('#kiln-pubsheet-go').count()) await press(page.locator('#kiln-pubsheet-go'));
    await page.waitForTimeout(1500);
    check(scope, `${name}: Publish then sends the edit with the note as its message`, worker.puts.length === 1 && worker.puts[0].message === 'New opening line (via Kiln)' && Buffer.from(worker.puts[0].content || '', 'base64').toString().includes('Kept words'), `${worker.puts.length} writes, ${worker.puts[0]?.message}`);
  });

  // ── The sign-in ran out by the browser's own clock ─────────────────────────
  await scene('Run out by the clock', async (name) => {
    reset();
    await page.goto(URL_ARG, { waitUntil: 'load' });
    await settled();
    await page.evaluate(([repo, session]) => {
      sessionStorage.clear();
      localStorage.setItem('kiln_editor', JSON.stringify({ session, name: 'Sam', repo, role: 'editor', exp: Date.now() - 60000 }));
    }, [REPO, OLD]);
    await page.reload({ waitUntil: 'load' });
    const notice = page.locator('#kiln-notice');
    await notice.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    check(scope, `${name}: the next page says the sign-in has ended, in the card the page-load path shows`, (await words(notice.locator('p').first())) === 'Your sign-in to edit this site has ended, so please sign in again with Google.'
      && (await notice.getByRole('button', { name: 'Sign in again' }).count()) === 1, await words(notice));
    check(scope, `${name}: the sign-in is gone and the editor draws nothing`, !(await page.evaluate(() => localStorage.getItem('kiln_editor'))) && (await pencil.count()) === 0 && (await page.locator('style[data-kiln]').count()) === 0);
    await shot('ended-by-clock');
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(900);
    check(scope, `${name}: it is said once: the page after that is the plain site`, (await notice.count()) === 0 && (await pencil.count()) === 0);
  });

  check(scope, 'no script errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  check(scope, 'nothing outside the local server was needed', blocked.length === 0, blocked.slice(0, 3).join(', '));
  await context.close();
}

/**
 * What only shows on a real site: one whose own scripts change its blocks
 * while the page is open, and which keeps a bar at the top of the screen.
 *
 * In sandbox mode: a block's buttons are hidden while the block is under a
 * bar pinned to the top, and a list is published as the page's file has it,
 * with none of the state a script put on its blocks. Then as a signed-in
 * editor, with the worker played here: one changed word in a list changes
 * that word in the page file and nothing else; History shows a way back on
 * the page itself, in no frames; and signing out with an edit waiting asks in
 * the editor's own dialog, never the browser's box.
 */
/** The fake's commit list, newest first, one page of it, the way GitHub pages it (per_page, page). */
function commitsPage(versions, u) {
  const per = Number(u.searchParams.get('per_page')) || 30;
  const pg = Number(u.searchParams.get('page')) || 1;
  return [...versions].reverse().map((v, i, all) => ({ sha: v.sha, parents: all[i + 1] ? [{ sha: all[i + 1].sha }] : [],
    commit: { message: v.message, author: { name: v.by, date: new Date(Date.now() - i * 60000).toISOString() } } })).slice((pg - 1) * per, pg * per);
}

async function runRealSites(browser, size) {
  const phone = size.width < 600;
  const scope = `${size.width}x${size.height} real sites  `;
  const WORKER = 'https://worker.invalid';
  const REPO = 'acme/site';
  const source = await (await fetch(URL_ARG)).text();
  const file = new URL(URL_ARG).pathname.replace(/^\/+/, '').replace(/(^|\/)$/, '$1index.html');
  const b64 = (text) => Buffer.from(text).toString('base64');
  const press = (locator) => (phone ? locator.tap() : locator.click());
  // What a site's scripts do to a block while the page is open, done to every block of a list.
  const scriptState = (page, key) => page.evaluate((k) => {
    const blocks = [...document.querySelectorAll(`[data-cms-repeat="${k}"] > .kiln-repeat-item`)];
    blocks.forEach((b, i) => {
      b.classList.add('is-uicheck-seen');
      b.setAttribute('aria-hidden', 'false');
      b.setAttribute('data-uicheck-state', 'on');
      if (i === 1) b.style.display = 'none';
      else b.style.opacity = '1';
      const field = b.querySelector('[data-cms]');
      if (field) field.classList.add('is-uicheck-seen');
    });
    return blocks.length;
  }, key);
  const STATE = /is-uicheck-seen|data-uicheck-state|display:\s*none/;
  /** The first list whose first block has a text field, and that field's words. */
  const listWithField = (page) => page.evaluate(() => {
    for (const list of document.querySelectorAll('[data-cms-repeat]:not([data-kiln-gallery]):not([data-kiln-events])')) {
      const field = list.querySelector(':scope > .kiln-repeat-item [data-cms]:not(img)');
      if (field && list.querySelectorAll(':scope > .kiln-repeat-item').length >= 2 && field.textContent.trim()) return { key: list.getAttribute('data-cms-repeat'), was: field.textContent };
    }
    return null;
  });
  const typeInto = async (page, key, text) => {
    const field = page.locator(`[data-cms-repeat="${key}"] > .kiln-repeat-item [data-cms]:not(img)`).first();
    await field.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await press(field);
    await page.waitForTimeout(250);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type(text);
    await press(page.locator('#kiln-toolbar .kiln-tb-save'));
    await page.waitForTimeout(300);
  };
  const publish = async (page) => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(200);
    await press(page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).first());
    await page.waitForTimeout(500);
    if (await page.locator('#kiln-pubsheet-go').count()) await press(page.locator('#kiln-pubsheet-go'));
    await page.waitForTimeout(1500);
  };

  // ── sandbox: the bar, and what a list is published as ──────────────────────
  {
    const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone });
    const blocked = [];
    await context.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith(ORIGIN) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
      return refuse(route, blocked);
    });
    await context.addInitScript(() => { try { localStorage.setItem('kiln_guide', '1'); } catch { /* ignore */ } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const shot = async (step) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${step}-${size.width}.png`) }); };
    await page.goto(URL_ARG, { waitUntil: 'load' });
    await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(600);

    // A bar of the site's own, pinned to the top, above the page and below Kiln.
    await page.evaluate(() => {
      const bar = document.createElement('div');
      bar.id = 'uicheck-bar';
      bar.textContent = 'The site’s own bar';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:72px;z-index:60;background:#fff;border-bottom:2px solid #111;font:16px/72px sans-serif;text-align:center';
      document.body.appendChild(bar);
    });
    const block = page.locator('[data-cms-repeat] > .kiln-repeat-item').first();
    check(scope, 'the page has a list to check', (await block.count()) === 1);
    // the block's top corner (where its buttons are) goes to the middle of the bar
    await block.scrollIntoViewIfNeeded();
    await page.evaluate(() => { const b = document.querySelector('[data-cms-repeat] > .kiln-repeat-item'); window.scrollBy(0, b.getBoundingClientRect().top - 30); });
    await page.waitForTimeout(500);
    if (!phone) { const b = await block.boundingBox(); await page.mouse.move(b.x + b.width / 2, 120); await page.waitForTimeout(400); }
    const under = await block.evaluate((b) => {
      const ctl = b.querySelector(':scope > .kiln-item-ctl');
      const r = ctl.getBoundingClientRect(), cs = getComputedStyle(ctl);
      const btn = (ctl.querySelector('button') || ctl).getBoundingClientRect();
      const top = document.elementFromPoint(btn.left + btn.width / 2, Math.min(70, Math.max(2, btn.top + btn.height / 2)));
      return { top: Math.round(r.top), hidden: cs.visibility === 'hidden', onButton: !!(top && top.closest('.kiln-item-ctl')) };
    });
    check(scope, 'a block\'s buttons are hidden while they are under the site\'s bar', under.top < 72 && under.hidden, `buttons at ${under.top}px, ${under.hidden ? 'hidden' : 'showing'}`);
    check(scope, 'and a press there does not reach one of them', !under.onButton);
    await shot('real-under-bar');
    await page.evaluate(() => window.scrollBy(0, -160));
    await page.waitForTimeout(500);
    if (!phone) { const b = await block.boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + 40); await page.waitForTimeout(400); }
    const clear = await block.evaluate((b) => { const ctl = b.querySelector(':scope > .kiln-item-ctl'); const cs = getComputedStyle(ctl); return { top: Math.round(ctl.getBoundingClientRect().top), shows: cs.visibility !== 'hidden' && cs.opacity !== '0' }; });
    check(scope, 'clear of the bar they are back', clear.top >= 72 && clear.shows, `buttons at ${clear.top}px, ${clear.shows ? 'showing' : 'hidden'}`);
    await page.evaluate(() => document.getElementById('uicheck-bar').remove());

    // A list published after the site's scripts have been at its blocks.
    const list = await listWithField(page);
    check(scope, 'the page has a list with a text field in its blocks', !!list);
    if (list) {
      const n = await scriptState(page, list.key);
      await typeInto(page, list.key, 'Changed by ui-check');
      await page.evaluate((k) => { const b = document.querySelectorAll(`[data-cms-repeat="${k}"] > .kiln-repeat-item`)[1]; if (b) b.style.display = 'none'; }, list.key);
      await publish(page);
      const html = await page.evaluate((k) => {
        for (const name of Object.keys(localStorage)) {
          try { const v = JSON.parse(localStorage.getItem(name)); const page = v && v.pages && Object.values(v.pages)[0]; if (page && page[k]) return page[k].html; } catch { /* not it */ }
        }
        return null;
      }, list.key);
      check(scope, 'the demo publishes the list', typeof html === 'string' && html.includes('Changed by ui-check'), html ? '' : 'nothing stored');
      check(scope, `and none of what a script put on its ${n} blocks is in it`, typeof html === 'string' && !STATE.test(html) && !/aria-hidden="false"/.test(html), (String(html).match(STATE) || [''])[0]);
      const inFile = (source.match(/is-inview/g) || []).length;
      check(scope, 'nor the class the site\'s own fade-in adds, unless the file has it', typeof html === 'string' && (inFile > 0 || !/is-inview/.test(html)));
    }
    check(scope, 'no script errors', errors.length === 0, errors.join(' | ').slice(0, 200));
    check(scope, 'nothing outside the local server was needed', blocked.length === 0, blocked.slice(0, 3).join(', '));
    await context.close();
  }

  // ── a signed-in editor on a real site, the worker played here ──────────────
  {
    const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone });
    await context.addInitScript(([repo]) => {
      try {
        if (!sessionStorage.getItem('uicheck_out')) localStorage.setItem('kiln_editor', JSON.stringify({ session: 'a'.repeat(64), name: 'Sam', repo, role: 'editor' }));
        localStorage.setItem('kiln_guide', '1');
      } catch { /* ignore */ }
    }, [REPO]);
    const versions = [{ sha: 'c0'.repeat(20), text: source, message: 'site', by: 'Site Owner' }];   // newest last
    const blocked = [];
    await context.route('**/*', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': ORIGIN }, body: JSON.stringify(body) });
      if (u.origin === ORIGIN && u.pathname.endsWith('kiln-config.js')) {
        return route.fulfill({ contentType: 'text/javascript', body: `window.KILN = { repo: '${REPO}', branch: 'main', worker: '${WORKER}', styles: [] };` });
      }
      if (u.origin === ORIGIN || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
      if (u.origin !== WORKER) return refuse(route, blocked);
      const p = decodeURIComponent(u.pathname);
      const head = versions[versions.length - 1];
      if (req.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Kiln-Session', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS' } });
      }
      if (p === '/presence') return json({ ok: true, others: [], online: [], scope: { paths: [''], keys: [], features: null, mode: null } });
      if (p === '/healthz') return json({ ok: true, modes: ['html', 'source'], adapters: ['astro'] });
      if (p === `/gh/repos/${REPO}/contents/${file}`) {
        if (req.method() === 'GET') {
          const ref = u.searchParams.get('ref');
          const v = versions.find(x => x.sha === ref) || (ref === 'main' ? head : null);
          return v ? json({ sha: `blob-${v.sha}`, content: b64(v.text) }) : json({ message: 'Not Found' }, 404);
        }
        const body = JSON.parse(req.postData());
        const sha = `c${versions.length}`.padEnd(40, 'a');
        versions.push({ sha, text: Buffer.from(body.content, 'base64').toString(), message: body.message, by: 'Sam (via Kiln)' });
        return json({ commit: { sha }, content: {} });
      }
      if (p === `/gh/repos/${REPO}/commits`) {
        return json(commitsPage(versions, u));
      }
      if (p.startsWith(`/gh/repos/${REPO}/git/matching-refs/`)) return json([]);
      if (p === `/gh/repos/${REPO}/contents`) return json([{ path: 'index.html', type: 'file' }, { path: 'assets', type: 'dir' }]);
      if (p === `/gh/repos/${REPO}/git/ref/heads/main`) return json({ object: { sha: head.sha } });
      if (p.includes('/deployments')) return json([]);
      if (p.endsWith('/status')) return json({ total_count: 0 });
      return json({ message: 'Not Found' }, 404);
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const boxes = [];   // the browser's own confirm / prompt boxes
    page.on('dialog', async (d) => { boxes.push(d.message()); await d.accept().catch(() => {}); });
    const shot = async (step) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${step}-${size.width}.png`) }); };
    await page.goto(URL_ARG, { waitUntil: 'load' });
    await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(700);

    // One changed word in a list, after the page has been scrolled through and its blocks marked.
    const list = await listWithField(page);
    if (list) {
      const h = await page.evaluate(() => document.documentElement.scrollHeight);
      for (let y = 0; y < h; y += 600) { await page.evaluate((yy) => window.scrollTo(0, yy), y); await page.waitForTimeout(60); }
      await scriptState(page, list.key);
      await typeInto(page, list.key, 'Changed by ui-check');
      await publish(page);
      const now = versions[versions.length - 1].text;
      check(scope, 'a real site: publishing one changed word in a list writes the page file', versions.length === 2 && now.includes('Changed by ui-check'), `${versions.length - 1} writes`);
      // The list as each file has it, read the way a browser reads it (so that
      // `plain` and `plain=""` are one thing). With the old words put back where
      // the new ones are, the published list must be the list as it was.
      const [was, is] = await page.evaluate(([a, b, k]) => [a, b].map((text) => {
        const list = new DOMParser().parseFromString(text, 'text/html').querySelector(`[data-cms-repeat="${k}"]`);
        return list ? list.innerHTML : null;
      }), [source, now, list.key]);
      const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const undone = String(is).replace('Changed by ui-check', esc(list.was));
      let at = 0; while (at < String(was).length && String(was)[at] === undone[at]) at++;
      check(scope, 'and nothing else in the list changes: no class, style or attribute a script added', was !== null && undone === was,
        undone === was ? '' : `first difference at ${at}: ${JSON.stringify(String(was).slice(Math.max(0, at - 40), at + 60))} became ${JSON.stringify(undone.slice(Math.max(0, at - 40), at + 60))}`);
      // and outside the list not a byte
      const outside = (text) => { const i = text.indexOf(`data-cms-repeat="${list.key}"`); return i === -1 ? null : text.slice(0, i); };
      check(scope, 'and nothing before the list in the file changes at all', outside(source) !== null && outside(source) === outside(now));

      // History: a way back is shown on the page, in no frames.
      await typeInto(page, list.key, 'Changed twice by ui-check');
      await publish(page);
      await press(page.locator('#kiln-fab'));
      await page.waitForTimeout(300);
      const hist = page.locator('#kiln-history');
      if (await hist.isVisible().catch(() => false)) {
        await press(hist);
        await page.waitForTimeout(900);
        const goBack = page.locator('#kiln-modal button', { hasText: 'Go back to this' }).first();
        check(scope, 'History lists the publishes with a way back', (await goBack.count()) === 1);
        if (await goBack.count()) {
          await press(goBack);
          await page.waitForTimeout(1500);
          const bar = page.locator('#kiln-previewbar');
          check(scope, '"Go back to this" shows the earlier version on the page itself', await bar.isVisible().catch(() => false), (await page.locator('#kiln-modal').innerText().catch(() => '')).slice(0, 60));
          check(scope, 'in no frames', (await page.locator('#kiln-modal iframe, iframe.kiln-vrestore-frame').count()) === 0);
          const seen = await page.evaluate((k) => [...document.querySelectorAll(`[data-cms-repeat="${k}"] > .kiln-repeat-item`)].filter(b => getComputedStyle(b).opacity !== '0' && b.getClientRects().length).length, list.key);
          check(scope, 'and the list can be seen in it', seen > 0, `${seen} blocks`);
          await shot('real-history-on-page');
          if (await bar.isVisible().catch(() => false)) await press(page.locator('#kiln-pv-cancel'));
          await page.waitForTimeout(400);
        }
      } else {
        check(scope, 'History is in this editor\'s menu', false);
      }
    }

    // Signing out with an edit waiting.
    if (list) {
      await page.keyboard.press('Escape');
      await typeInto(page, list.key, 'An edit that is waiting');
      await press(page.locator('#kiln-fab'));
      await page.waitForTimeout(300);
      await press(page.locator('#kiln-signout'));
      await page.waitForTimeout(500);
      const ask = page.locator('#kiln-modal.kiln-ask');
      check(scope, 'signing out with an edit waiting asks in the editor\'s own dialog', (await ask.count()) === 1 && /^Sign out and discard your edit\?/.test((await ask.locator('h3').textContent().catch(() => '')) || ''), ((await ask.locator('h3').textContent().catch(() => '')) || '').slice(0, 50));
      check(scope, 'whose buttons say what they do', (await ask.locator('.kiln-modal-actions button').allTextContents()).map(t => t.trim()).join(' | ') === 'Stay signed in | Discard and sign out');
      check(scope, 'never in the browser\'s box', boxes.length === 0, (boxes[0] || '').slice(0, 50));
      await shot('real-sign-out');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      check(scope, 'Escape keeps the sign-in and the edit', !!(await page.evaluate(() => localStorage.getItem('kiln_editor'))) && (await page.locator('.kiln-modified').count()) > 0);
      await press(page.locator('#kiln-fab'));
      await page.waitForTimeout(300);
      await press(page.locator('#kiln-signout'));
      await page.waitForTimeout(400);
      await page.evaluate(() => sessionStorage.setItem('uicheck_out', '1'));
      await press(page.locator('#kiln-ask-go'));
      await page.waitForTimeout(1200);
      check(scope, '"Discard and sign out" signs out', !(await page.evaluate(() => localStorage.getItem('kiln_editor'))));
    }
    check(scope, 'no script errors', errors.length === 0, errors.join(' | ').slice(0, 200));
    check(scope, 'nothing outside the local server was needed', blocked.length === 0, blocked.slice(0, 3).join(', '));
    await context.close();
  }

  // ── History on a page published 45 times: older versions, down to the first ─
  {
    const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone });
    await context.addInitScript(([repo]) => {
      try { localStorage.setItem('kiln_editor', JSON.stringify({ session: 'b'.repeat(64), name: 'Sam', repo, role: 'editor' })); localStorage.setItem('kiln_guide', '1'); } catch { /* ignore */ }
    }, [REPO]);
    // Publish n (1 = the first) gives the first heading the words "Version n".
    // (A heading may hold markup of its own, two lines in spans, say: all of it gives way to the words.)
    const H1 = /(<h1[^>]*data-cms="[^"]+"[^>]*>)([\s\S]*?)(<\/h1>)/;
    const versions = Array.from({ length: 45 }, (_, i) => ({ sha: `v${i + 1}`.padEnd(40, 'f'), text: source.replace(H1, `$1Version ${i + 1}$3`), message: `Publish number ${i + 1} (via Kiln)`, by: 'Sam (via Kiln)' }));
    const asked = [];
    let failPage = 0;   // a page of commits that fails once
    const blocked = [];
    await context.route('**/*', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': ORIGIN }, body: JSON.stringify(body) });
      if (u.origin === ORIGIN && u.pathname.endsWith('kiln-config.js')) {
        return route.fulfill({ contentType: 'text/javascript', body: `window.KILN = { repo: '${REPO}', branch: 'main', worker: '${WORKER}', styles: [] };` });
      }
      if (u.origin === ORIGIN || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
      if (u.origin !== WORKER) return refuse(route, blocked);
      const p = decodeURIComponent(u.pathname);
      const head = versions[versions.length - 1];
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Kiln-Session', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS' } });
      if (p === '/presence') return json({ ok: true, others: [], online: [], scope: { paths: [''], keys: [], features: null, mode: null } });
      if (p === '/healthz') return json({ ok: true, modes: ['html', 'source'], adapters: ['astro'] });
      if (p === `/gh/repos/${REPO}/contents/${file}` && req.method() === 'GET') {
        const ref = u.searchParams.get('ref');
        const v = versions.find(x => x.sha === ref) || (ref === 'main' ? head : null);
        return v ? json({ sha: `blob-${v.sha}`, content: b64(v.text) }) : json({ message: 'Not Found' }, 404);
      }
      if (p === `/gh/repos/${REPO}/commits`) {
        asked.push(u.search);
        if (u.searchParams.get('page') !== '1') await new Promise(r => setTimeout(r, 400));   // older pages take a moment
        if (failPage && u.searchParams.get('page') === String(failPage)) { failPage = 0; return json({ message: 'Server Error' }, 502); }
        return json(commitsPage(versions, u));
      }
      if (p.startsWith(`/gh/repos/${REPO}/git/matching-refs/`)) return json([]);
      if (p === `/gh/repos/${REPO}/contents`) return json([{ path: 'index.html', type: 'file' }, { path: 'assets', type: 'dir' }]);
      if (p === `/gh/repos/${REPO}/git/ref/heads/main`) return json({ object: { sha: head.sha } });
      if (p.includes('/deployments')) return json([]);
      if (p.endsWith('/status')) return json({ total_count: 0 });
      return json({ message: 'Not Found' }, 404);
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const shot = async (step) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${step}-${size.width}.png`) }); };
    await page.goto(URL_ARG, { waitUntil: 'load' });
    await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(700);
    await press(page.locator('#kiln-fab'));
    await page.waitForTimeout(300);
    await press(page.locator('#kiln-history'));
    const rows = page.locator('#kiln-hist .kiln-hist-row');
    await rows.first().waitFor({ state: 'visible', timeout: 5000 });
    const more = page.locator('#kiln-modal .kiln-hist-more button');
    check(scope, 'History of 45 publishes lists the newest 20 first', (await rows.count()) === 20, `${await rows.count()} rows`);
    check(scope, 'with "Show older versions" at the end', (await more.count()) === 1 && (await more.textContent()).trim() === 'Show older versions');
    // A page of older versions that fails says so and can be tried again.
    failPage = 2;
    await more.scrollIntoViewIfNeeded();
    await press(more);
    await page.waitForTimeout(600);
    const note = page.locator('#kiln-modal .kiln-hist-more .kiln-dim');
    check(scope, 'a failed load says so in plain words', /^The older versions could not be read\. .*try again/i.test((await note.textContent().catch(() => '')) || ''), ((await note.textContent().catch(() => '')) || '').slice(0, 80));
    check(scope, 'and can be tried again', (await rows.count()) === 20 && (await more.isEnabled()));
    // Pressed twice quickly: one page is asked for, once.
    const before = asked.length;
    await more.click({ noWaitAfter: true });
    const said = (await more.textContent()).trim();
    await more.click({ force: true, noWaitAfter: true, timeout: 500 }).catch(() => {});
    await page.waitForTimeout(800);
    check(scope, 'while loading the control says so', said === 'Loading older versions…', said);
    check(scope, 'and pressing twice loads one page', asked.length - before === 1 && (await rows.count()) === 40, `${asked.length - before} asks, ${await rows.count()} rows`);
    await press(more);
    await page.waitForTimeout(800);
    check(scope, 'the last page lists the first publish', (await rows.count()) === 45 && /Publish number 1\b/.test(await rows.last().innerText()), `${await rows.count()} rows`);
    const first = page.locator('#kiln-modal .kiln-hist-first');
    check(scope, 'and the control gives way to a quiet line', (await more.count()) === 0 && (await first.textContent().catch(() => '')) === 'This is the first version of this page.');
    check(scope, 'each page was asked for by number, 20 at a time', [...new Set(asked)].join(' ') === [1, 2, 3].map(n => `?path=${encodeURIComponent(file)}&per_page=20&page=${n}`).join(' '), asked.join(' '));
    await rows.last().scrollIntoViewIfNeeded();
    await shot('real-history-older');
    // An old version comes back exactly as a new one does.
    const back = rows.nth(40).locator('button', { hasText: 'Go back to this' });
    await press(back);
    await page.waitForTimeout(1500);
    const bar = page.locator('#kiln-previewbar');
    const h1 = await page.evaluate(() => document.querySelector('h1[data-cms]')?.textContent || '');
    check(scope, '"Go back to this" on an old version shows it on the page', await bar.isVisible().catch(() => false) && h1 === 'Version 5', h1);
    await shot('real-history-older-back');
    check(scope, 'no script errors', errors.length === 0, errors.join(' | ').slice(0, 200));
    check(scope, 'nothing outside the local server was needed', blocked.length === 0, blocked.slice(0, 3).join(', '));
    await context.close();
  }
}

/**
 * A page a generator built ("generated"): a small page of this script's own,
 * as Astro would build it, on a site in source mode, with the worker played
 * here. What is looked at is what the person is asked and offered: a field
 * someone else changed is asked about with both versions and never listed as
 * "not saved"; Search & jump lists the site's real pages and not the sign-in
 * page; a suggest-only and a comment-only editor read what they can do there
 * and are offered nothing that would be refused; and on a phone the bars that
 * wait for an answer lie on nothing else of Kiln's.
 */
async function runGenerated(browser, size) {
  const phone = size.width < 600;
  const scope = `${size.width}x${size.height} generated   `;
  const WORKER = 'https://worker.invalid';
  const REPO = 'acme/site';
  const AT = '/uicheck-generated/';
  const ONE = 'src/content/events/one.md';
  const press = (locator) => (phone ? locator.tap() : locator.click());
  const head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:17px/1.5 system-ui,sans-serif;max-width:40rem;margin:0 auto;padding:0 16px 200px}header{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:12px 0;display:flex;gap:16px}h1{margin:28px 0 8px}</style>';
  const tail = '<script src="/assets/kiln-config.js"></script><script src="/assets/kiln.js" defer></script>';
  const nav = `<header><strong>Remembrance</strong><a href="${AT}">Home</a><a href="${AT}about/">About</a><a href="/kiln.html">Sign in</a></header>`;
  const pages = {
    [AT]: `<!doctype html><html lang="en"><head>${head}<title>Week of Remembrance</title></head><body>${nav}<main>
      <h1 data-kiln-source="src/content/site/home.md#/frontmatter/heading">Week of Remembrance</h1>
      <p data-kiln-source="src/content/site/home.md#/frontmatter/intro">Three gatherings, one week.</p>
      <article><h3 data-kiln-source="${ONE}#/frontmatter/title">Interfaith Worship Service</h3>
      <time data-kiln-source="${ONE}#/frontmatter/start?type=time">18:00</time>
      <p data-kiln-source="${ONE}#/frontmatter/venue">Big Bethel AME</p>
      <a href="${AT}events/one/">Details</a></article></main>${tail}</body></html>`,
    [`${AT}about/`]: `<!doctype html><html lang="en"><head>${head}<title>About the week</title></head><body>${nav}<main><h1>About the week</h1><p>Seven days, open to everyone.</p></main>${tail}</body></html>`,
    [`${AT}events/one/`]: `<!doctype html><html lang="en"><head>${head}<title>Interfaith Worship Service</title></head><body>${nav}<main><h1 data-kiln-source="${ONE}#/frontmatter/title">Interfaith Worship Service</h1></main>${tail}</body></html>`,
  };
  const TREE = ['astro.config.mjs', 'public/kiln.html', 'src/pages/uicheck-generated/index.astro', 'src/pages/uicheck-generated/about.astro', 'src/pages/uicheck-generated/events/[id].astro', 'src/pages/uicheck-generated/pricing.astro', ONE, 'src/content/site/home.md'];

  /** One visit by one person. `who` is the scope the worker gives them; `theirs` what the file says of the title by now. */
  const visit = async (who, fn) => {
    const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone });
    await context.addInitScript(([repo]) => {
      try { localStorage.setItem('kiln_editor', JSON.stringify({ session: 'a'.repeat(64), name: 'Sam', repo, role: 'editor' })); localStorage.setItem('kiln_guide', '1'); } catch { /* ignore */ }
    }, [REPO]);
    const worker = { commits: [], asked: [], build: 'none', theirs: null };
    const blocked = [];
    await context.route('**/*', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': ORIGIN }, body: JSON.stringify(body) });
      if (u.origin === ORIGIN && u.pathname.endsWith('kiln-config.js')) {
        return route.fulfill({ contentType: 'text/javascript', body: `window.KILN = { repo: '${REPO}', branch: 'main', worker: '${WORKER}', mode: 'source', adapter: 'astro', styles: [] };` });
      }
      if (u.origin === ORIGIN && u.pathname.startsWith(AT)) {
        return pages[u.pathname] ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: pages[u.pathname] }) : route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not found</h1>' });
      }
      if (u.origin === ORIGIN && /^\/(sitemap|kiln-no-such-page)/.test(u.pathname)) return route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not found</h1>' });
      if (u.origin === ORIGIN || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
      if (u.origin !== WORKER) return refuse(route, blocked);
      const p = decodeURIComponent(u.pathname);
      if (req.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Kiln-Session', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS' } });
      }
      worker.asked.push(`${req.method()} ${p}`);
      if (p === '/presence') return json({ ok: true, others: [], online: [], scope: { paths: [''], keys: [], features: null, mode: null, ...who } });
      if (p === '/healthz') return json({ ok: true, modes: ['html', 'source'], adapters: ['astro'], sourceWas: true });
      if (p === '/source/commit') {
        const body = JSON.parse(req.postData());
        worker.commits.push(body);
        // The worker's own rule: an edit that says what it read is left out when the file says something else by now.
        const skipped = []; const applied = [];
        for (const e of body.edits) {
          const moved = worker.theirs !== null && e.pointer === '/frontmatter/title' && 'was' in e && e.was !== worker.theirs && e.value !== worker.theirs;
          if (moved) skipped.push({ key: e.key, reason: 'changed since it was read', current: worker.theirs }); else applied.push(e.key);
        }
        if (!applied.length) return json({ error: 'no edits could be applied', skipped }, 422);
        return json({ ok: true, file: body.file, commit: { sha: `c${worker.commits.length}`.padEnd(40, 'a'), parent: 'b'.repeat(40) }, applied, skipped });
      }
      if (p === '/source/revert') return json({ ok: true, file: ONE, commit: { sha: 'd'.repeat(40), parent: 'c'.repeat(40) } });
      if (p.startsWith(`/gh/repos/${REPO}/git/trees/`)) return json({ tree: TREE.map(path => ({ path, type: 'blob' })) });
      if (p.endsWith('/status')) return json(worker.build === 'failure' ? { state: 'failure', total_count: 1 } : { total_count: 0 });
      if (p.includes('/deployments')) return json([]);
      if (p === '/comments' || p === '/comments/counts') return json({ error: 'bad path' }, 400);
      return json({ message: 'Not Found' }, 404);
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const boxes = [];
    page.on('dialog', async (d) => { boxes.push(d.message()); await d.dismiss().catch(() => {}); });
    await page.goto(`${ORIGIN}${AT}`, { waitUntil: 'load' });
    await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(700);
    try { await fn({ page, worker, boxes, shot: async (step) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${step}-${size.width}.png`) }); } }); }
    finally {
      check(scope, `${who.mode || 'publishing'} editor: no script errors, no browser box, nothing outside the local server`, errors.length === 0 && boxes.length === 0 && blocked.length === 0, [...errors, ...boxes, ...blocked].join(' | ').slice(0, 200));
      await context.close();
    }
  };
  const statusLine = (page) => page.evaluate(() => { const el = document.getElementById('kiln-status'); return el && !el.hidden ? el.textContent.trim() : ''; });
  const title = (page) => page.locator(`[data-kiln-source="${ONE}#/frontmatter/title"]`).first();
  const retitle = async (page, text) => {
    await title(page).scrollIntoViewIfNeeded();
    await press(title(page));
    await page.waitForTimeout(250);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type(text);
    await press(page.locator('#kiln-toolbar .kiln-tb-save'));
    await page.waitForTimeout(250);
  };
  const publish = async (page) => {
    await press(page.locator('#kiln-publish-quick'));
    await page.waitForTimeout(450);
    if (await page.locator('#kiln-pubsheet-go').count()) await press(page.locator('#kiln-pubsheet-go'));
    await page.waitForTimeout(1300);
  };
  const dialogWords = (page) => page.locator('#kiln-modal .kiln-modal-body').innerText().catch(() => '');
  const menuWords = async (page) => {
    if (!(await page.locator('#kiln-fab-menu').isVisible().catch(() => false))) { await press(page.locator('#kiln-fab')); await page.waitForTimeout(350); }
    return page.evaluate(() => [...document.querySelectorAll('#kiln-fab-menu button, #kiln-fab-menu .kiln-fab-label')].filter(b => b.getClientRects().length && getComputedStyle(b).display !== 'none' && getComputedStyle(b).visibility !== 'hidden').map(b => b.textContent.trim().replace(/\s+/g, ' ')));
  };

  // ── someone else changed the title: asked, then "Use mine" ─────────────────
  await visit({}, async ({ page, worker, shot }) => {
    worker.theirs = 'The owner renamed this';
    await retitle(page, 'The editor renamed this');
    const venue = page.locator(`[data-kiln-source="${ONE}#/frontmatter/venue"]`);
    await press(venue); await page.waitForTimeout(200);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.type('Ebenezer Baptist');
    await press(page.locator('#kiln-toolbar .kiln-tb-save')); await page.waitForTimeout(200);
    await publish(page);
    const first = worker.commits[0]?.edits || [];
    check(scope, 'each edit says what its field showed when the page was read', first.length === 2 && first[0].was === 'Interfaith Worship Service' && first[1].was === 'Big Bethel AME', JSON.stringify(first.map(e => e.was)));
    const words = await dialogWords(page);
    check(scope, 'a field someone else changed is asked about, with theirs and yours', /Someone else changed this/.test(words) && /Theirs\s+The owner renamed this/.test(words) && /Yours\s+The editor renamed this/.test(words), words.replace(/\s+/g, ' ').slice(0, 160));
    check(scope, 'its two buttons say what they do', (await page.locator('#kiln-which-theirs').innerText().catch(() => '')) === 'Keep theirs' && (await page.locator('#kiln-which-mine').innerText().catch(() => '')) === 'Use mine');
    check(scope, 'it is not listed as "not saved"', (await page.locator('#kiln-srcskip').count()) === 0);
    check(scope, 'the other edit of that publish was saved meanwhile', !(await venue.evaluate(el => el.classList.contains('kiln-modified'))) && (await title(page).evaluate(el => el.classList.contains('kiln-modified'))));
    await shot('generated-theirs-or-mine');
    await press(page.locator('#kiln-which-mine'));
    await page.waitForTimeout(1300);
    const second = worker.commits[1]?.edits || [];
    check(scope, '"Use mine" publishes that edit again, saying what the file holds now', worker.commits.length === 2 && second.length === 1 && second[0].value === 'The editor renamed this' && second[0].was === 'The owner renamed this', JSON.stringify(second));
    check(scope, 'and it is saved: nothing is waiting, and the line says the site is rebuilding', (await page.locator('.kiln-modified').count()) === 0 && /Saved\. The site is rebuilding/.test(await statusLine(page)), await statusLine(page));
  });

  // ── …and "Keep theirs"; then the bars on top of one another ────────────────
  await visit({}, async ({ page, worker, shot }) => {
    worker.theirs = 'The owner renamed this';
    await retitle(page, 'The editor renamed this');
    await publish(page);
    check(scope, 'with only that field edited, nothing is saved until the person answers', worker.commits.length === 1 && (await page.locator('#kiln-which-theirs').count()) === 1 && !/rebuilding|Published/.test(await statusLine(page)), await statusLine(page));
    await press(page.locator('#kiln-which-theirs'));
    await page.waitForTimeout(500);
    check(scope, '"Keep theirs" drops the edit and shows their words', (await title(page).innerText()) === 'The owner renamed this' && (await page.locator('.kiln-modified').count()) === 0 && worker.commits.length === 1, await title(page).innerText());
    check(scope, 'and no Publish is offered for it', !(await page.locator('#kiln-publish-quick').isVisible().catch(() => false)));
    // A publish whose build then fails: the banner, the status line, the Publish row and the pencil.
    worker.theirs = null;
    await retitle(page, 'A title that breaks the build');
    const start = page.locator(`[data-kiln-source="${ONE}#/frontmatter/start?type=time"]`);
    await publish(page);
    worker.build = 'failure';
    await page.locator('#kiln-srcfail').waitFor({ state: 'visible', timeout: 16000 }).catch(() => {});
    await press(start); await page.waitForTimeout(200);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.type('19:00');
    await press(page.locator('#kiln-toolbar .kiln-tb-save')); await page.waitForTimeout(300);
    const at = await page.evaluate(() => {
      const r = (sel) => { const el = document.querySelector(sel); if (!el || el.hidden || !el.getClientRects().length) return null; const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; };
      return { status: r('#kiln-status'), banner: r('#kiln-srcfail'), publish: r('#kiln-publish-quick'), pencil: r('#kiln-fab') };
    });
    const names = Object.keys(at).filter(k => at[k]);
    const on = [];
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) if (!apart(at[names[i]], at[names[j]])) on.push(`${names[i]} on ${names[j]}`);
    check(scope, 'a failed build: the banner, the status line, the Publish button and the pencil are all there', names.length === 4, names.join(', '));
    check(scope, 'and none of them lies on another', on.length === 0, on.join(', '));
    if (phone) check(scope, 'on a phone the banner is as wide as the screen and clear of the top, which is the status line\'s', !!at.banner && at.banner.right - at.banner.left > size.width - 40 && at.banner.top > 120, JSON.stringify(at.banner));
    await shot('generated-failed-build');
  });

  // ── no mouse: Tab, Enter and Esc on the parts a content file holds ─────────
  const focused = (page) => page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return { tag: 'body' };
    return { tag: a.tagName.toLowerCase(), src: a.getAttribute('data-kiln-source'), role: a.getAttribute('role'), label: a.getAttribute('aria-label'),
      editing: a.isContentEditable, inToolbar: !!a.closest('#kiln-toolbar'), toolbar: document.querySelector('#kiln-toolbar')?.getAttribute('aria-label') || null,
      ring: a.matches(':focus-visible') ? getComputedStyle(a).outlineStyle : 'none' };
  });
  const tabTo = async (page, want, max = 60) => {
    for (let i = 0; i < max; i++) { await page.keyboard.press('Tab'); const f = await focused(page); if (want(f)) return f; }
    return null;
  };
  const TITLE = `${ONE}#/frontmatter/title`;
  const VENUE = `${ONE}#/frontmatter/venue`;
  await visit({}, async ({ page, worker, shot }) => {
    await page.evaluate(() => document.activeElement?.blur());
    const at = await tabTo(page, f => f.src === TITLE);
    check(scope, 'keyboard: Tab reaches a title from a content file, as a button named for it, with a ring', !!at && at.role === 'button' && at.label === 'Edit Title: Interfaith Worship Service' && at.ring !== 'none', JSON.stringify(at));
    await shot('generated-keyboard-rest');
    await page.keyboard.press('Enter'); await page.waitForTimeout(250);
    const open = await focused(page);
    check(scope, 'keyboard: Enter opens it for typing, a text box named for the part, with its toolbar named too', open.editing && open.role === 'textbox' && open.label === 'Title' && open.toolbar === 'Text tools: Title', JSON.stringify(open));
    await page.keyboard.press('End'); await page.keyboard.type(' at noon');
    await page.keyboard.press('Tab'); await page.waitForTimeout(80);
    const tool = await focused(page);
    check(scope, 'keyboard: Tab from the box goes to its toolbar', tool.inToolbar, JSON.stringify(tool));
    let next = tool;
    for (let i = 0; i < 6 && next.inToolbar; i++) { await page.keyboard.press('Tab'); await page.waitForTimeout(80); next = await focused(page); }
    check(scope, 'keyboard: Tab from the toolbar\'s last button goes on to the next part, and the edit is kept', !!next.src && next.src !== TITLE && !next.inToolbar
      && await title(page).evaluate(el => el.classList.contains('kiln-modified') && el.getAttribute('role') === 'button' && !el.isContentEditable), JSON.stringify(next));
    const venue = await tabTo(page, f => f.src === VENUE, 10) || await focused(page);
    await page.keyboard.press('Space'); await page.waitForTimeout(200);
    await page.keyboard.press('End'); await page.keyboard.type(' Hall');
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    const back = await focused(page);
    check(scope, 'keyboard: Esc throws the typing away and the keyboard stays on the part', back.src === VENUE && back.role === 'button' && !back.editing && back.label === 'Edit Venue: Big Bethel AME'
      && (await page.locator(`[data-kiln-source="${VENUE}"]`).textContent()) === 'Big Bethel AME' && !(await page.locator('#kiln-toolbar').count()), JSON.stringify({ venue, back }));
    await publish(page);
    const sent = JSON.stringify(worker.commits);
    check(scope, 'keyboard: what is published is the typed words, nothing the editor added for the keyboard', worker.commits.length === 1 && /Interfaith Worship Service at noon/.test(sent) && !/tabindex|aria-|data-kiln-focus|role/.test(sent), sent.slice(0, 200));
  });
  await visit({ mode: 'suggest' }, async ({ page, shot }) => {
    await page.evaluate(() => document.activeElement?.blur());
    const at = await tabTo(page, f => f.src === TITLE);
    check(scope, 'keyboard: a read-only part is reached too, and says why it can\'t be changed', !!at && at.role === 'button' && /^Title: Interfaith Worship Service\. A suggestion can’t be made to this text yet/.test(at.label || '') && at.ring !== 'none', JSON.stringify(at));
    await page.keyboard.press('Enter'); await page.waitForTimeout(250);
    check(scope, 'keyboard: Enter on it puts the same words on the status line as a click, and takes no typing', /A suggestion can’t be made to this text yet/.test(await statusLine(page)) && !(await focused(page)).editing, await statusLine(page));
    await shot('generated-keyboard-locked');
  });

  // ── Search & jump ──────────────────────────────────────────────────────────
  await visit({}, async ({ page, shot }) => {
    await press(page.locator('#kiln-fab')); await page.waitForTimeout(300);
    await press(page.locator('#kiln-palette-btn'));
    await page.locator('#kiln-pal-list .kiln-pal-item').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1800);
    const rows = await page.evaluate(() => { const out = []; let sec = ''; for (const n of document.querySelectorAll('#kiln-pal-list > *')) { if (n.classList.contains('kiln-pal-sec')) sec = n.textContent; else if (n.classList.contains('kiln-pal-item')) out.push(`${sec}: ${n.querySelector('.kiln-pal-name')?.textContent}`); } return out; });
    const listed = rows.filter(r => r.startsWith('Pages: ')).map(r => r.slice(7));
    check(scope, 'Search & jump lists the site\'s real pages, the one behind a parameter route included', JSON.stringify(listed) === JSON.stringify([AT, `${AT}about/`, `${AT}events/one/`]), listed.join(' '));
    check(scope, 'never the sign-in page, a repository path, or a route the built site does not have', !listed.some(p => /kiln|public|pricing|\.astro/.test(p)), listed.join(' '));
    check(scope, 'and the fields that can be edited on this page', rows.some(r => r === 'On this page: Title · One') && rows.some(r => r === 'On this page: Heading · Home'), rows.filter(r => r.startsWith('On this page')).join(' | '));
    await shot('generated-search');
  });

  // ── a suggest-only editor ──────────────────────────────────────────────────
  await visit({ mode: 'suggest' }, async ({ page, worker, shot }) => {
    const line = await statusLine(page);
    check(scope, 'a suggest-only editor reads at once that suggestions cannot be made on this page', /Suggestions can’t be made here yet, because the site builds this page from its content files\.$/.test(line), line);
    const fields = await page.evaluate(() => ({ editable: document.querySelectorAll('[data-kiln-source].kiln-field:not(.kiln-source-locked)').length, readOnly: document.querySelectorAll('[data-kiln-source].kiln-source-locked').length }));
    check(scope, 'no field invites typing; each is read-only', fields.editable === 0 && fields.readOnly === 5, JSON.stringify(fields));
    await press(title(page));
    await page.waitForTimeout(350);
    check(scope, 'a click on one says why, and it takes no typing', /A suggestion can’t be made to this text yet/.test(await statusLine(page)) && !(await title(page).evaluate(el => el.isContentEditable)), await statusLine(page));
    const menu = await menuWords(page);
    check(scope, 'no "Suggest changes" is offered, in the menu or beside the pencil', !menu.some(t => /Suggest|Publish/.test(t)) && !(await page.locator('#kiln-publish-quick').isVisible().catch(() => false)), menu.join(' | '));
    check(scope, 'and the worker was never asked to save anything', worker.commits.length === 0);
    await shot('generated-suggest-only');
  });

  // ── a comment-only editor ──────────────────────────────────────────────────
  await visit({ mode: 'review', features: ['comments'] }, async ({ page, worker, shot }) => {
    const line = await statusLine(page);
    check(scope, 'a comment-only editor reads that comments cannot be left on this page, and nothing about outlines', /Comments can’t be left here yet, because the site builds this page from its content files\.$/.test(line) && !/outlined/.test(line), line);
    const menu = await menuWords(page);
    check(scope, 'the menu offers neither Comments nor Publish, and no heading with nothing under it', !menu.some(t => /Comments|Publish|This page/.test(t)), menu.join(' | '));
    check(scope, 'and no comment is asked of the worker, which would refuse it', !worker.asked.some(a => /\/comments/.test(a)), worker.asked.filter(a => /comments/.test(a)).join(', '));
    await shot('generated-comment-only');
  });
}

/**
 * Formatted text on a generated page ("formatted"): an entry's body that
 * Astro made from Markdown, with a list, a table and code, on a site whose
 * worker takes Markdown back. The person clicks the text and gets the same
 * toolbar as on a plain HTML site, bolds a word, adds a list item, finds the
 * table says why it takes no typing, and Esc puts typing back. What reaches
 * the worker is the file's own Markdown with only those lines changed. The
 * page and the file are the real ones in test/fixtures/astro-formatted.
 */
async function runFormatted(browser, size) {
  const phone = size.width < 600;
  const scope = `${size.width}x${size.height} formatted   `;
  const WORKER = 'https://worker.invalid';
  const REPO = 'acme/site';
  const AT = '/uicheck-formatted/';
  const FILE = 'src/content/posts/spring-fair.md';
  const FIX = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'test', 'fixtures', 'astro-formatted');
  const src = readFileSync(path.join(FIX, 'src', 'content', 'posts', 'spring-fair.md'), 'utf8');
  const body = src.slice(src.indexOf('\n---\n', 4) + 5);
  const built = readFileSync(path.join(FIX, 'built', 'spring-fair.html'), 'utf8');
  const inner = /<body>([\s\S]*)<\/body>/.exec(built)[1];
  const press = (locator) => (phone ? locator.tap() : locator.click());
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Spring fair</title><style>body{font:17px/1.55 system-ui,sans-serif;max-width:40rem;margin:0 auto;padding:0 16px 220px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}pre{overflow:auto}</style></head><body>${inner}<script src="/assets/kiln-config.js"></script><script src="/assets/kiln.js" defer></script></body></html>`;
  const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone });
  await context.addInitScript(([repo]) => {
    try { localStorage.setItem('kiln_editor', JSON.stringify({ session: 'a'.repeat(64), name: 'Sam', repo, role: 'editor' })); localStorage.setItem('kiln_guide', '1'); } catch { /* ignore */ }
  }, [REPO]);
  const worker = { commits: [], reads: 0 };
  const blocked = [];
  await context.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': ORIGIN }, body: JSON.stringify(b) });
    if (u.origin === ORIGIN && u.pathname.endsWith('kiln-config.js')) return route.fulfill({ contentType: 'text/javascript', body: `window.KILN = { repo: '${REPO}', branch: 'main', worker: '${WORKER}', mode: 'source', adapter: 'astro', styles: [] };` });
    if (u.origin === ORIGIN && u.pathname === AT) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    if (u.origin === ORIGIN && u.pathname.startsWith(AT)) return route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not found</h1>' });
    if (u.origin === ORIGIN || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    if (u.origin !== WORKER) return refuse(route, blocked);
    const p = decodeURIComponent(u.pathname);
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Kiln-Session', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS' } });
    if (p === '/presence') return json({ ok: true, others: [], online: [], scope: { paths: [''], keys: [], features: null, mode: null } });
    if (p === '/healthz') return json({ ok: true, modes: ['html', 'source'], adapters: ['astro'], sourceWas: true, sourceMarkdown: true });
    if (p === '/source/read') { worker.reads++; const b = JSON.parse(req.postData()); return b.pointer === '/body' ? json({ value: body, sha: 'f'.repeat(40) }) : json({ error: 'pointer not found in source' }, 404); }
    if (p === '/source/commit') {
      const b = JSON.parse(req.postData());
      worker.commits.push(b);
      return json({ ok: true, file: b.file, commit: { sha: 'c'.repeat(40), parent: 'b'.repeat(40) }, applied: b.edits.map(e => e.key), skipped: [] });
    }
    if (p.startsWith(`/gh/repos/${REPO}/git/trees/`)) return json({ tree: ['astro.config.mjs', FILE].map(x => ({ path: x, type: 'blob' })) });
    if (p.endsWith('/status')) return json({ total_count: 0 });
    if (p.includes('/deployments')) return json([]);
    if (p === '/comments' || p === '/comments/counts') return json({ error: 'bad path' }, 400);
    return json({ message: 'Not Found' }, 404);
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const boxes = [];
  page.on('dialog', async (d) => { boxes.push(d.message()); await d.dismiss().catch(() => {}); });
  const shot = async (step) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${step}-${size.width}.png`) }); };
  const statusLine = () => page.evaluate(() => { const el = document.getElementById('kiln-status'); return el && !el.hidden ? el.textContent.trim() : ''; });
  /** Put the caret in (or select) the words `w` inside the element matching `sel`. */
  const selectWords = (sel, w, collapseToEnd = false) => page.evaluate(([s, word, end]) => {
    const root = document.querySelector(s);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.data.indexOf(word);
      if (at === -1) continue;
      const r = document.createRange();
      r.setStart(n, end ? at + word.length : at);
      r.setEnd(n, at + word.length);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(r);
      return true;
    }
    return false;
  }, [sel, w, collapseToEnd]);
  try {
    await page.goto(`${ORIGIN}${AT}`, { waitUntil: 'load' });
    await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(700);
    const text = page.locator(`[data-kiln-source="${FILE}#/body"]`);
    check(scope, 'the formatted text is offered for editing, not read-only', await text.evaluate(el => el.classList.contains('kiln-source-rich') && !el.classList.contains('kiln-source-locked')));

    // No mouse: Tab reaches the text, Enter opens it with the same toolbar, Tab goes to it, Esc comes back and keeps nothing.
    await page.evaluate(() => document.activeElement?.blur());
    const kf = () => page.evaluate(() => { const a = document.activeElement; return { src: a?.getAttribute('data-kiln-source'), role: a?.getAttribute('role'), label: a?.getAttribute('aria-label'),
      editing: !!a?.isContentEditable, inToolbar: !!a?.closest('#kiln-toolbar'), toolbar: document.querySelector('#kiln-toolbar')?.getAttribute('aria-label') || null }; });
    let kat = null;
    for (let i = 0; i < 60 && kat?.src !== `${FILE}#/body`; i++) { await page.keyboard.press('Tab'); kat = await kf(); }
    check(scope, 'keyboard: Tab reaches the formatted text, as a button named for it', kat?.role === 'button' && /^Edit Text: /.test(kat.label || ''), JSON.stringify(kat));
    const before = await text.innerText();
    await page.keyboard.press('Enter');
    await page.locator('#kiln-toolbar').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    const kopen = await kf();
    check(scope, 'keyboard: Enter opens it for typing, a text box with its text tools named', kopen.editing && kopen.role === 'textbox' && kopen.label === 'Text' && kopen.toolbar === 'Text tools: Text', JSON.stringify(kopen));
    await page.keyboard.type('zz');
    await page.keyboard.press('Tab'); await page.waitForTimeout(80);
    check(scope, 'keyboard: Tab from the text goes to its toolbar', (await kf()).inToolbar);
    await page.keyboard.press('Shift+Tab'); await page.waitForTimeout(80);
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    const kback = await kf();
    check(scope, 'keyboard: Esc puts typing back as it was and the keyboard stays on the text', kback.src === `${FILE}#/body` && kback.role === 'button' && !kback.editing && (await text.innerText()) === before && !(await page.locator('#kiln-toolbar').count()), JSON.stringify(kback));

    // The toolbar is the one a plain HTML site has, without what Markdown cannot hold.
    await press(text.locator('p').first());
    await page.locator('#kiln-toolbar').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(300);
    const buttons = await page.evaluate(() => [...document.querySelectorAll('#kiln-toolbar [data-cmd]')].map(b => b.dataset.cmd));
    check(scope, 'the toolbar has bold, italic, both lists, link and the format menu', ['bold', 'italic', 'insertUnorderedList', 'insertOrderedList', 'link'].every(c => buttons.includes(c)) && await page.locator('#kiln-toolbar .kiln-style-select').count() === 1, buttons.join(' '));
    check(scope, 'and nothing Markdown cannot hold: no underline, no upload, no site styles, no section history', !['underline', 'img', 'doc', 'hist'].some(c => buttons.includes(c)) && await page.locator('#kiln-toolbar optgroup[label="Site styles"]').count() === 0, buttons.join(' '));
    check(scope, 'the file was read once, to match the page to it', worker.reads === 1, `reads ${worker.reads}`);
    const tb = await box(page.locator('#kiln-toolbar'));
    check(scope, 'the toolbar fits the screen', tb.left >= 0 && tb.right <= size.width + 0.5, `${Math.round(tb.left)}–${Math.round(tb.right)}`);
    const table = text.locator('table');
    check(scope, 'the table is kept as the file has it: it takes no typing', await table.evaluate(t => t.getAttribute('contenteditable') === 'false' && /^b\d+$/.test(t.getAttribute('data-kiln-keep') || '')));
    await shot('formatted-toolbar');

    // Bold one word with the toolbar.
    await selectWords(`[data-kiln-source="${FILE}#/body"] p`, 'green');
    await press(page.locator('#kiln-toolbar [data-cmd="bold"]'));
    await page.waitForTimeout(150);
    // A new item at the end of the list: Enter after "Food", then the words.
    await selectWords(`[data-kiln-source="${FILE}#/body"] > ul > li:last-child`, 'Food', true);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Games');
    await page.waitForTimeout(150);
    await press(page.locator('#kiln-toolbar .kiln-tb-save'));
    await page.waitForTimeout(300);
    check(scope, 'Done keeps it on the page as an edit waiting to be published', await text.evaluate(el => el.classList.contains('kiln-modified') && !el.isContentEditable && /Games/.test(el.textContent)));

    // A click on the table says why it takes no typing.
    await press(table.locator('td').first());
    await page.waitForTimeout(250);
    check(scope, 'a click on the table says why it is kept as it is, where a phone can see it', /table/i.test(await statusLine()), await statusLine());

    // Esc puts typing back.
    await press(text.locator('h2'));
    await page.locator('#kiln-toolbar').waitFor({ state: 'visible', timeout: 5000 });
    await selectWords(`[data-kiln-source="${FILE}#/body"] h2`, 'Getting there', true);
    await page.keyboard.type(' quickly');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    check(scope, 'Esc puts back what was typed since the text was opened, and keeps the earlier edit', await text.evaluate(el => !/quickly/.test(el.textContent) && /Games/.test(el.textContent) && !el.isContentEditable));

    // Publish: the file's Markdown, with only those two lines changed.
    await press(page.locator('#kiln-publish-quick'));
    await page.waitForTimeout(450);
    const sheet = await page.locator('.kiln-pubsheet').innerText().catch(() => '');
    await shot('formatted-sheet');
    check(scope, 'the publish sheet names the text and shows its words, not Markdown', /Text/.test(sheet) && /Food\s+Games/.test(sheet) && !/\*\*/.test(sheet), sheet.replace(/\s+/g, ' ').slice(0, 160));
    if (await page.locator('#kiln-pubsheet-go').count()) await press(page.locator('#kiln-pubsheet-go'));
    await page.waitForTimeout(1300);
    const sent = worker.commits[0]?.edits?.[0];
    check(scope, 'one commit to the entry\'s file, its body as Markdown', worker.commits.length === 1 && worker.commits[0].file === FILE && sent?.pointer === '/body' && typeof sent.value === 'string');
    const was = body.split('\n');
    const now = String(sent?.value || '').split('\n');
    const removed = was.filter(l => !now.includes(l));
    const added = now.filter(l => !was.includes(l));
    check(scope, 'only the bolded line and the new item changed, in the file\'s own style', JSON.stringify(removed) === JSON.stringify(['The **spring fair** is on the green, from ten until four. Entry is'])
      && JSON.stringify(added) === JSON.stringify(['The **spring fair** is on the **green**, from ten until four. Entry is', '- Games']), JSON.stringify({ removed, added }).slice(0, 220));
    check(scope, 'the table, the code and the reference link went back byte for byte', ['| 10:00 | Doors open  |', "const open = '10:00';", '[c]: mailto:fair@example.org', 'Take the 12 bus to the church.  '].every(l => now.includes(l)));
    check(scope, 'the edit says the Markdown it was made from, so a change made since is not written over', sent?.was === body);
    await shot('formatted-published');
  } finally {
    check(scope, 'no script errors, no browser box, nothing outside the local server', errors.length === 0 && boxes.length === 0 && blocked.length === 0, [...errors, ...boxes, ...blocked].join(' | ').slice(0, 200));
    await context.close();
  }
}

/**
 * Pictures and link addresses on a generated page ("media"): an Astro entry
 * with a picture Astro's image() checks, a link whose words and address are
 * two fields, a link whose address is a field, and a picture inside the
 * Markdown text, on a site that publishes its schema. The person replaces
 * both pictures and describes one, changes both addresses (and is told why a
 * page address will not do where the site wants a full one), and is told why
 * a title is too long. What reaches the repository: the pictures first, in
 * the folder the entry keeps them in, then the entry naming them. The page,
 * the file and the schema are the real ones in test/fixtures/astro-media.
 */
async function runMedia(browser, size) {
  const phone = size.width < 600;
  const scope = `${size.width}x${size.height} media       `;
  const WORKER = 'https://worker.invalid';
  const REPO = 'acme/site';
  const AT = '/uicheck-media/';
  const FILE = 'src/content/posts/spring-fair.md';
  const FIX = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'test', 'fixtures', 'astro-media');
  const src = readFileSync(path.join(FIX, 'src', 'content', 'posts', 'spring-fair.md'), 'utf8');
  const body = src.slice(src.indexOf('\n---\n', 4) + 5);
  const fm = { '/frontmatter/cover': './images/green.png', '/frontmatter/banner': '/img/hall.png', '/body': body };
  const built = readFileSync(path.join(FIX, 'built', 'spring-fair.html'), 'utf8');
  const inner = /<body>([\s\S]*)<\/body>/.exec(built)[1];
  const assets = {
    '/kiln-schema.json': ['application/json', readFileSync(path.join(FIX, 'built', 'kiln-schema.json'))],
    '/img/hall.png': ['image/png', readFileSync(path.join(FIX, 'public', 'img', 'hall.png'))],
  };
  for (const f of readdirSync(path.join(FIX, 'built', '_astro'))) assets[`/_astro/${f}`] = ['image/webp', readFileSync(path.join(FIX, 'built', '_astro', f))];
  const press = (locator) => (phone ? locator.tap() : locator.click());
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Spring fair</title><style>body{font:17px/1.55 system-ui,sans-serif;max-width:40rem;margin:0 auto;padding:0 16px 220px}img{display:block;width:240px;height:auto;margin:10px 0;background:#eee}a{display:inline-block;margin:6px 12px 6px 0}</style></head><body>${inner}<script src="/assets/kiln-config.js"></script><script src="/assets/kiln.js" defer></script></body></html>`;
  const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone });
  await context.addInitScript(([repo]) => {
    try { localStorage.setItem('kiln_editor', JSON.stringify({ session: 'a'.repeat(64), name: 'Sam', repo, role: 'editor' })); localStorage.setItem('kiln_guide', '1'); } catch { /* ignore */ }
  }, [REPO]);
  const worker = { commits: [], reads: [], order: [], blobs: 0, tree: [] };
  const blocked = [];
  await context.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': ORIGIN }, body: JSON.stringify(b) });
    if (u.origin === ORIGIN && u.pathname.endsWith('kiln-config.js')) return route.fulfill({ contentType: 'text/javascript', body: `window.KILN = { repo: '${REPO}', branch: 'main', worker: '${WORKER}', mode: 'source', adapter: 'astro', styles: [] };` });
    if (u.origin === ORIGIN && u.pathname === AT) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    if (u.origin === ORIGIN && assets[u.pathname]) return route.fulfill({ contentType: assets[u.pathname][0], body: assets[u.pathname][1] });
    if (u.origin === ORIGIN && u.pathname.startsWith(AT)) return route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not found</h1>' });
    if (u.origin === ORIGIN || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    if (u.origin !== WORKER) return refuse(route, blocked);
    const p = decodeURIComponent(u.pathname);
    const m = req.method();
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Kiln-Session', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS' } });
    if (p === '/presence') return json({ ok: true, others: [], online: [], scope: { paths: [''], keys: [], features: null, mode: null } });
    if (p === '/healthz') return json({ ok: true, modes: ['html', 'source'], adapters: ['astro'], sourceWas: true, sourceMarkdown: true, sourceMedia: true });
    if (p === '/source/read') {
      const b = JSON.parse(req.postData());
      worker.reads.push(b.pointer);
      return b.pointer in fm ? json({ value: fm[b.pointer], sha: 'f'.repeat(40) }) : json({ error: 'pointer not found in source' }, 404);
    }
    if (p === '/source/commit') {
      const b = JSON.parse(req.postData());
      worker.order.push('source');
      worker.commits.push(b);
      return json({ ok: true, file: b.file, commit: { sha: 'c'.repeat(40), parent: 'b'.repeat(40) }, applied: b.edits.map(e => e.key), skipped: [] });
    }
    const gh = `/gh/repos/${REPO}`;
    if (p === `${gh}/git/ref/heads/main` && m === 'GET') return json({ object: { sha: 'a'.repeat(40) } });
    if (p.startsWith(`${gh}/git/commits/`) && m === 'GET') return json({ sha: 'a'.repeat(40), tree: { sha: 't'.repeat(40) } });
    if (p === `${gh}/git/blobs` && m === 'POST') { worker.blobs++; return json({ sha: String(worker.blobs).padStart(40, '0') }); }
    if (p === `${gh}/git/trees` && m === 'POST') { worker.tree = JSON.parse(req.postData()).tree.map(t => t.path); return json({ sha: 'e'.repeat(40) }); }
    if (p === `${gh}/git/commits` && m === 'POST') return json({ sha: 'd'.repeat(40) });
    if (p === `${gh}/git/refs/heads/main` && m === 'PATCH') { worker.order.push('pictures'); return json({ object: { sha: 'd'.repeat(40) } }); }
    if (p.startsWith(`${gh}/git/trees/`)) return json({ tree: ['astro.config.mjs', FILE].map(x => ({ path: x, type: 'blob' })) });
    if (p.endsWith('/status')) return json({ total_count: 0 });
    if (p.includes('/deployments')) return json([]);
    if (p === '/comments' || p === '/comments/counts') return json({ error: 'bad path' }, 400);
    return json({ message: 'Not Found' }, 404);
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const boxes = [];
  page.on('dialog', async (d) => { boxes.push(d.message()); await d.dismiss().catch(() => {}); });
  const shot = async (step) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${step}-${size.width}.png`) }); };
  const statusLine = () => page.evaluate(() => { const el = document.getElementById('kiln-status'); return el && !el.hidden ? el.textContent.trim() : ''; });
  // A picture from this device: a small PNG, made here.
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 48;
    const x = c.getContext('2d'); x.fillStyle = '#3a7'; x.fillRect(0, 0, 64, 48); x.fillStyle = '#fd3'; x.fillRect(8, 8, 20, 20);
    const b = await new Promise(r => c.toBlob(r, 'image/png'));
    return [...new Uint8Array(await b.arrayBuffer())];
  });
  const upload = async (name) => {
    const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
    await press(page.locator('#kiln-toolbar [data-act="replace"]'));
    await (await chooser).setFiles({ name, mimeType: 'image/png', buffer: Buffer.from(png) });
    // A replaced picture is described next (describe-picture.js): the question is answered as a person in a hurry would.
    await page.locator('#kiln-describe').waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
    if (await page.locator('#kiln-describe').count()) { await press(page.locator('#kiln-describe-go')); await page.waitForTimeout(300); }
    await page.waitForFunction(() => /Picture added/.test(document.getElementById('kiln-status')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  };
  try {
    await page.goto(`${ORIGIN}${AT}`, { waitUntil: 'load' });
    await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(700);
    const cover = page.locator(`img[data-kiln-source^="${FILE}#/frontmatter/cover"]`);
    check(scope, 'the picture Astro checks is offered for replacing, not read-only', await cover.evaluate(el => el.classList.contains('kiln-field') && !el.classList.contains('kiln-source-locked')));

    // No mouse: Tab reaches the picture, Enter opens its toolbar with the keyboard on it, Esc puts it away and comes back.
    await page.evaluate(() => document.activeElement?.blur());
    const kfocused = () => page.evaluate(() => {
      const a = document.activeElement;
      return { tag: a?.tagName.toLowerCase(), src: a?.getAttribute('data-kiln-source'), role: a?.getAttribute('role'), label: a?.getAttribute('aria-label'), act: a?.getAttribute('data-act'),
        inToolbar: !!a?.closest('#kiln-toolbar'), toolbar: document.querySelector('#kiln-toolbar')?.getAttribute('aria-label') || null, ring: a?.matches(':focus-visible') ? getComputedStyle(a).outlineStyle : 'none' };
    });
    let kat = null;
    for (let i = 0; i < 60 && !(kat?.src || '').startsWith(`${FILE}#/frontmatter/cover`); i++) { await page.keyboard.press('Tab'); kat = await kfocused(); }
    check(scope, 'keyboard: Tab reaches the picture, named as one with its description, with a ring', kat?.role === 'button' && kat.label === 'Change picture: Cover. The green with stalls' && kat.ring !== 'none', JSON.stringify(kat));
    await page.keyboard.press('Enter');
    await page.locator('#kiln-toolbar [data-act="replace"]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(150);
    const kopen = await kfocused();
    check(scope, 'keyboard: Enter opens its toolbar, named, with the keyboard on its first button', kopen.inToolbar && kopen.act === 'replace' && kopen.toolbar === 'Picture tools: Cover', JSON.stringify(kopen));
    await page.keyboard.press('Tab'); await page.keyboard.type('typed and dropped');
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    const kback = await kfocused();
    check(scope, 'keyboard: Esc puts the toolbar away, keeps nothing typed, and the keyboard is back on the picture', !kback.inToolbar && !(await page.locator('#kiln-toolbar').count()) && (kback.src || '').startsWith(`${FILE}#/frontmatter/cover`)
      && await cover.evaluate(el => !el.classList.contains('kiln-modified') && el.getAttribute('alt') === 'The green with stalls'), JSON.stringify(kback));

    // Replace it, and describe it.
    await press(cover);
    await page.locator('#kiln-toolbar [data-act="replace"]').waitFor({ state: 'visible', timeout: 5000 });
    check(scope, 'its toolbar has Replace picture and the description the file holds', await page.locator('#kiln-toolbar [data-act="alt"]').inputValue() === 'The green with stalls');
    check(scope, 'the file was read to find the folder its pictures are kept in', worker.reads.includes('/frontmatter/cover'), worker.reads.join(' '));
    const tb = await box(page.locator('#kiln-toolbar'));
    check(scope, 'the toolbar fits the screen', tb.left >= 0 && tb.right <= size.width + 0.5, `${Math.round(tb.left)}–${Math.round(tb.right)}`);
    await upload('Fête on the green.png');
    check(scope, 'the new picture shows at once, without the old responsive files', await cover.evaluate(el => el.getAttribute('src').startsWith('blob:') && !el.hasAttribute('srcset')), await statusLine());
    await page.locator('#kiln-toolbar [data-act="alt"]').fill('Stalls on the green at noon');
    await shot('media-picture');
    await press(page.locator('#kiln-toolbar [data-act="done"]'));
    await page.waitForTimeout(250);
    check(scope, 'Done keeps the picture and its description as edits waiting to be published', await cover.evaluate(el => el.classList.contains('kiln-modified') && el.getAttribute('alt') === 'Stalls on the green at noon'));

    // A title longer than the site's schema takes is not kept, and that is said.
    const title = page.locator(`h1[data-kiln-source^="${FILE}#/frontmatter/title"]`);
    await press(title);
    await page.keyboard.type(' and a great deal more that goes on for far too long for any page heading at all');
    await press(page.locator('#kiln-toolbar .kiln-tb-save'));
    await page.waitForTimeout(250);
    check(scope, 'a title longer than the site takes is not kept, and the line says the limit', /at most 80 characters/.test(await statusLine()) && await title.innerText() === 'Spring fair', await statusLine());

    // The link: its address beside its words. A page address is not a full one.
    const cta = page.locator('a.cta');
    await press(cta);
    await page.locator('#kiln-toolbar [data-act="href"]').waitFor({ state: 'visible', timeout: 5000 });
    check(scope, 'a link offers its address beside its words', await page.locator('#kiln-toolbar [data-act="href"]').inputValue() === 'https://example.com/book');
    await page.locator('#kiln-toolbar [data-act="href"]').fill('/book');
    await press(page.locator('#kiln-toolbar .kiln-tb-save'));
    await page.waitForTimeout(250);
    check(scope, 'a page address where the site wants a full one is not kept, and that is said', /full web address/.test(await statusLine()) && await cta.getAttribute('href') === 'https://example.com/book', await statusLine());
    await press(cta);
    await page.locator('#kiln-toolbar [data-act="href"]').fill('https://example.com/stalls');
    await press(page.locator('#kiln-toolbar .kiln-tb-save'));
    await page.waitForTimeout(250);
    check(scope, 'a full address is kept, and the link goes there on the page', await cta.getAttribute('href') === 'https://example.com/stalls' && await cta.evaluate(el => el.classList.contains('kiln-modified')));

    // A link whose address is the field: only the address is typed.
    const site = page.locator('a.site');
    await press(site);
    await page.locator('#kiln-toolbar [data-act="href"]').waitFor({ state: 'visible', timeout: 5000 });
    check(scope, 'a link whose address is the field takes no typing in its words', await site.evaluate(el => !el.isContentEditable) && await page.locator('#kiln-toolbar [data-act="href"]').inputValue() === 'https://example.com');
    await page.locator('#kiln-toolbar [data-act="href"]').fill('https://example.org/fair');
    await page.locator('#kiln-toolbar [data-act="href"]').press('Enter');
    await page.waitForTimeout(250);
    check(scope, 'Enter keeps the address', await site.getAttribute('href') === 'https://example.org/fair' && await site.innerText() === 'Our website');

    // A picture inside the text, replaced from within the text.
    const stalls = page.locator('.post-body img[alt="Stalls on the green"]');
    await press(stalls);
    await page.locator('#kiln-toolbar [data-act="replace"]').waitFor({ state: 'visible', timeout: 5000 });
    check(scope, 'a picture in the text opens its own toolbar, with its description', await page.locator('#kiln-toolbar [data-act="alt"]').inputValue() === 'Stalls on the green');
    await upload('stalls.png');
    await press(page.locator('#kiln-toolbar [data-act="done"]'));
    await page.locator('#kiln-toolbar .kiln-tb-save').waitFor({ state: 'visible', timeout: 5000 });
    await press(page.locator('#kiln-toolbar .kiln-tb-save'));
    await page.waitForTimeout(300);
    check(scope, 'Done on the text keeps it as an edit', await page.locator('.post-body').evaluate(el => el.classList.contains('kiln-modified')));

    // Publish: the pictures first, in the entry's own picture folder, then the entry.
    await press(page.locator('#kiln-publish-quick'));
    await page.waitForTimeout(450);
    const sheet = await page.locator('.kiln-pubsheet').innerText().catch(() => '');
    await shot('media-sheet');
    check(scope, 'the publish sheet shows the new picture, its description and both addresses', /New picture: fete-on-the-green-/.test(sheet) && /Picture description/.test(sheet) && (sheet.match(/Link goes to/g) || []).length === 2, sheet.replace(/\s+/g, ' ').slice(0, 200));
    if (await page.locator('#kiln-pubsheet-go').count()) await press(page.locator('#kiln-pubsheet-go'));
    await page.waitForTimeout(1500);
    check(scope, 'the pictures were committed first, then the entry', worker.order.join(' ') === 'pictures source', worker.order.join(' '));
    check(scope, 'both pictures went in the folder the entry keeps its pictures in, as WebP', worker.tree.length === 2 && worker.tree.every(t => /^src\/content\/posts\/images\/(fete-on-the-green|stalls)-[a-z0-9]+\.webp$/.test(t)), worker.tree.join(' '));
    const edits = Object.fromEntries((worker.commits[0]?.edits || []).map(e => [e.pointer, e]));
    const coverFile = worker.tree.find(t => /fete/.test(t)) || '';
    check(scope, 'the cover names its new picture the way the file names pictures', edits['/frontmatter/cover']?.value === `./images/${coverFile.split('/').pop()}` && edits['/frontmatter/cover']?.type === 'image' && edits['/frontmatter/cover']?.was === './images/green.png', JSON.stringify(edits['/frontmatter/cover']));
    check(scope, 'the description and both addresses went as their own fields', edits['/frontmatter/coverAlt']?.value === 'Stalls on the green at noon' && edits['/frontmatter/cta/href']?.value === 'https://example.com/stalls' && edits['/frontmatter/website']?.value === 'https://example.org/fair' && !edits['/frontmatter/title']);
    const was = body.split('\n');
    const now = String(edits['/body']?.value || '').split('\n');
    const removed = was.filter(l => !now.includes(l));
    const added = now.filter(l => !was.includes(l));
    const stallsFile = worker.tree.find(t => /stalls/.test(t)) || '';
    check(scope, 'in the text only the picture\'s line changed, its title kept', JSON.stringify(removed) === JSON.stringify(['![Stalls on the green](./images/green.png "The green at noon")'])
      && JSON.stringify(added) === JSON.stringify([`![Stalls on the green](./images/${stallsFile.split('/').pop()} "The green at noon")`]), JSON.stringify({ removed, added }).slice(0, 220));
    await shot('media-published');
  } finally {
    check(scope, 'no script errors, no browser box, nothing outside the local server', errors.length === 0 && boxes.length === 0 && blocked.length === 0, [...errors, ...boxes, ...blocked].join(' | ').slice(0, 200));
    await context.close();
  }
}

/**
 * Entries on a generated page ("entries"): the list Astro built from a
 * collection, and one entry's own page, on a site whose worker adds, removes,
 * lists and schedules entries. The person moves an entry down, adds one from
 * the collection's schema (told what is missing first; a name that is taken
 * is passed over), removes one after the editor's own question, opens the
 * draft that the list does not show and schedules it, publishes the new
 * order, then on the entry's page goes back to an earlier version from
 * History and changes the description in Page settings. The pages, the files
 * and the schema are the real ones in test/fixtures/astro-entries.
 */
async function runEntries(browser, size) {
  const phone = size.width < 600;
  const scope = `${size.width}x${size.height} entries     `;
  const WORKER = 'https://worker.invalid';
  const REPO = 'acme/site';
  const AT = '/uicheck-entries/';
  const DIR = 'src/content/posts';
  const FIX = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'test', 'fixtures', 'astro-entries');
  const files = Object.fromEntries(readdirSync(path.join(FIX, 'src', 'content', 'posts')).map(f => [`${DIR}/${f}`, readFileSync(path.join(FIX, 'src', 'content', 'posts', f), 'utf8')]));
  const front = (text) => {
    const fm = /^---\n([\s\S]*?)\n---/.exec(text)[1];
    const out = {};
    for (const line of fm.split('\n')) {
      const m = /^([A-Za-z]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      out[m[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : /^\d+$/.test(m[2]) ? Number(m[2]) : m[2];
    }
    return out;
  };
  const schema = readFileSync(path.join(FIX, 'built', 'kiln-schema.json'));
  const pageOf = (name) => {
    const built = readFileSync(path.join(FIX, 'built', name), 'utf8');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${/<head>([\s\S]*?)<\/head>/.exec(built)[1]}<style>body{font:17px/1.55 system-ui,sans-serif;max-width:40rem;margin:0 auto;padding:0 16px 220px}ul.posts{list-style:none;padding:0}ul.posts li{border:1px solid #ddd;border-radius:10px;padding:10px 14px;margin:10px 0}</style></head><body>${/<body>([\s\S]*)<\/body>/.exec(built)[1]}<script src="/assets/kiln-config.js"></script><script src="/assets/kiln.js" defer></script></body></html>`;
  };
  const press = (locator) => (phone ? locator.tap() : locator.click());
  const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone });
  await context.addInitScript(([repo]) => {
    try { localStorage.setItem('kiln_editor', JSON.stringify({ session: 'a'.repeat(64), name: 'Sam', repo, role: 'editor' })); localStorage.setItem('kiln_guide', '1'); } catch { /* ignore */ }
  }, [REPO]);
  const worker = { created: [], removed: [], commits: [], schedules: [], reverts: [], taken: new Set([`${DIR}/autumn-fair-crafts.md`]) };
  const blocked = [];
  await context.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': ORIGIN }, body: JSON.stringify(b) });
    if (u.origin === ORIGIN && u.pathname.endsWith('kiln-config.js')) return route.fulfill({ contentType: 'text/javascript', body: `window.KILN = { repo: '${REPO}', branch: 'main', worker: '${WORKER}', mode: 'source', adapter: 'astro', styles: [] };` });
    if (u.origin === ORIGIN && u.pathname === `${AT}posts/`) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: pageOf('posts.html') });
    if (u.origin === ORIGIN && u.pathname === `${AT}posts/spring-fair/`) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: pageOf('spring-fair.html') });
    if (u.origin === ORIGIN && u.pathname === '/kiln-schema.json') return route.fulfill({ contentType: 'application/json', body: schema });
    if (u.origin === ORIGIN && u.pathname.startsWith(AT)) return route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not found</h1>' });
    if (u.origin === ORIGIN || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    if (u.origin !== WORKER) return refuse(route, blocked);
    const p = decodeURIComponent(u.pathname);
    const m = req.method();
    const body = () => JSON.parse(req.postData() || '{}');
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Kiln-Session', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS' } });
    if (p === '/presence') return json({ ok: true, others: [], online: [], scope: { paths: [''], keys: [], features: ['newpost', 'history', 'schedule', 'pagesettings', 'draft'], mode: null } });
    if (p === '/healthz') return json({ ok: true, modes: ['html', 'source'], adapters: ['astro'], sourceWas: true, sourceMarkdown: true, sourceMedia: true, sourceEntries: true });
    const commit = (n) => ({ sha: String(n).padStart(40, 'c'), parent: 'b'.repeat(40) });
    if (p === '/source/fields') {
      const b = body();
      if (!files[b.file]) return json({ error: 'content file no longer exists' }, 404);
      const text = b.at ? files[b.file].replace('The village spring fair', 'The spring fair') : files[b.file];
      return json({ format: 'yaml', fields: front(text), body: text.split('\n---\n')[1] || '', sha: 'f'.repeat(40) });
    }
    if (p === '/source/read') { const b = body(); return json({ value: String(front(files[b.file] || '')[b.pointer.split('/').pop()] ?? ''), sha: 'f'.repeat(40) }); }
    if (p === '/source/create') {
      const b = body();
      if (worker.taken.has(b.file) || files[b.file]) return json({ error: 'a file with that name is already there' }, 409);
      worker.created.push(b);
      return json({ ok: true, file: b.file, commit: commit(1) });
    }
    if (p === '/source/remove') { worker.removed.push(body().file); return json({ ok: true, file: body().file, commit: commit(2) }); }
    if (p === '/source/history') {
      const b = body();
      if (b.folder) return json({ versions: [] });
      return json({ versions: [
        { sha: 'a1'.padEnd(40, '1'), parent: 'a0'.padEnd(40, '0'), when: '2026-10-05T10:00:00Z', who: 'Sam', what: 'Kiln: update src/content/posts/spring-fair.md' },
        { sha: 'a0'.padEnd(40, '0'), parent: null, when: '2026-09-01T09:00:00Z', who: 'Site Owner', what: 'Add the spring fair' },
      ] });
    }
    if (p === '/source/revert') { worker.reverts.push(body()); return json({ ok: true, file: body().file, commit: commit(3) }); }
    if (p === '/source/commit') { const b = body(); worker.commits.push(b); return json({ ok: true, file: b.file, commit: commit(4 + worker.commits.length), applied: b.edits.map(e => e.key), skipped: [] }); }
    if (p === '/schedule' && m === 'POST') { worker.schedules.push(body()); return json({ ok: true, id: 'e'.repeat(32), at: Date.parse(body().at) }); }
    if (p === '/schedules') return json({ schedules: [] });
    const gh = `/gh/repos/${REPO}`;
    if (p.startsWith(`${gh}/git/trees/`)) return json({ tree: Object.keys(files).map(x => ({ path: x, type: 'blob' })), truncated: false });
    if (p.startsWith(`${gh}/commits/`) && p.endsWith('/status')) return json({ state: 'success', total_count: 1, statuses: [{ state: 'success' }] });
    if (p.includes('/deployments')) return json([]);
    if (p === '/comments' || p === '/comments/counts') return json({ error: 'bad path' }, 400);
    return json({ message: 'Not Found' }, 404);
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const boxes = [];
  page.on('dialog', async (d) => { boxes.push(d.message()); await d.dismiss().catch(() => {}); });
  const shot = async (step) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${step}-${size.width}.png`) }); };
  const statusLine = () => page.evaluate(() => { const el = document.getElementById('kiln-status'); return el && !el.hidden ? el.textContent.trim() : ''; });
  const modalText = () => page.locator('#kiln-modal').innerText().catch(() => '');
  const button = (text) => page.locator('#kiln-modal button', { hasText: text }).first();
  const menuItem = async (id) => { await press(page.locator('#kiln-fab')); await page.waitForTimeout(350); await press(page.locator(`#${id}`)); };
  try {
    await page.goto(`${ORIGIN}${AT}posts/`, { waitUntil: 'load' });
    await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(800);
    const items = page.locator('ul.posts > li');
    check(scope, 'each entry in the list has its own Entry button', await page.locator('ul.posts > li > .kiln-entry-ctl').count() === 2);
    check(scope, 'and the list has a way to add one', await page.locator('.kiln-entry-add').count() === 1);
    const ctl = await box(page.locator('ul.posts > li > .kiln-entry-ctl').first());
    check(scope, 'the Entry button is on screen and big enough to press', ctl.left >= 0 && ctl.right <= size.width && ctl.height >= (phone ? 36 : 20), `${Math.round(ctl.left)}–${Math.round(ctl.right)} × ${Math.round(ctl.height)}`);

    // No mouse: Tab reaches each entry's controls by name; Enter opens the entry's box, whose actions are buttons; Esc comes back.
    await page.evaluate(() => document.activeElement?.blur());
    const kf = () => page.evaluate(() => { const a = document.activeElement; return { cls: a?.className || '', label: a?.getAttribute('aria-label') || a?.textContent.trim(), tag: a?.tagName.toLowerCase() }; });
    let kat = null;
    for (let i = 0; i < 60 && !/kiln-entry-ctl/.test(kat?.cls || ''); i++) { await page.keyboard.press('Tab'); kat = await kf(); }
    check(scope, 'keyboard: Tab reaches an entry\'s button, named for the entry', kat?.tag === 'button' && kat.label === 'Entry: Spring fair', JSON.stringify(kat));
    await page.keyboard.press('Enter');
    await page.locator('#kiln-modal .kiln-entry-acts button').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const acts = await page.evaluate(() => [...document.querySelectorAll('#kiln-modal .kiln-entry-acts button')].map(b => ({ name: (b.getAttribute('aria-label') || b.textContent).trim(), tab: b.tabIndex })));
    check(scope, 'keyboard: Enter opens its box, where move, copy, draft and remove are buttons with names', ['Make it a draft', 'Move down', 'Copy', 'Remove'].every(t => acts.some(a => a.name.includes(t) && a.tab >= 0)), JSON.stringify(acts));
    await page.keyboard.press('Escape'); await page.waitForTimeout(250);
    const kback = await kf();
    check(scope, 'keyboard: Esc closes it and the keyboard is back on the entry\'s button', !(await page.locator('#kiln-modal').count()) && kback.label === 'Entry: Spring fair', JSON.stringify(kback));
    for (let i = 0; i < 60 && !/kiln-entry-add/.test(kat?.cls || ''); i++) { await page.keyboard.press('Tab'); kat = await kf(); }
    check(scope, 'keyboard: and "Add an entry" is reached by name too', /kiln-entry-add/.test(kat?.cls || '') && /^Add an entry to /.test(kat.label), JSON.stringify(kat));

    // Move the first entry down.
    await press(items.nth(0).locator('.kiln-entry-ctl'));
    await page.locator('#kiln-modal .kiln-entry-acts button').first().waitFor({ state: 'visible', timeout: 5000 });
    const panel = await modalText();
    await shot('entries-panel');
    check(scope, 'the entry\'s box says it is on the site and offers what can be done', /On the site\./.test(panel) && ['Make it a draft', 'Move down', 'Copy', 'History', 'Remove'].every(t => panel.includes(t)) && !panel.includes('Move up'), panel.replace(/\s+/g, ' ').slice(0, 160));
    await press(button('Move down'));
    await page.waitForTimeout(400);
    check(scope, 'moving it down shows the new order on the page at once', (await items.nth(0).innerText()).includes('Summer fete') && (await items.nth(1).innerText()).includes('Spring fair'));

    // Add an entry: what is missing is said first; a name that is taken is passed over.
    await press(page.locator('.kiln-entry-add'));
    await page.locator('#kiln-ne-title').waitFor({ state: 'visible', timeout: 5000 });
    check(scope, 'the new-entry box asks for the title and the date the schema requires, and starts it as a draft', await page.locator('#kiln-ne-date').count() === 1 && await page.locator('#kiln-ne-draft').isChecked());
    await page.locator('#kiln-ne-title').fill('Autumn fair: crafts');
    await press(page.locator('#kiln-ne-go'));
    await page.waitForTimeout(250);
    check(scope, 'without a date it says the date is needed, and adds nothing', /Date is needed/.test(await modalText()) && worker.created.length === 0, (await modalText()).replace(/\s+/g, ' ').slice(-80));
    await page.locator('#kiln-ne-date').fill('2026-09-26');
    await shot('entries-new');
    await press(page.locator('#kiln-ne-go'));
    await page.waitForTimeout(900);
    const made = worker.created[0];
    check(scope, 'the entry is made under a name from its title that is not taken, as a draft', made?.file === `${DIR}/autumn-fair-crafts-2.md` && made.fields.title === 'Autumn fair: crafts' && made.fields.date === '2026-09-26' && made.fields.draft === true, JSON.stringify(made));
    check(scope, 'and the line says where to find it', /as a draft/.test(await statusLine()), await statusLine());

    // Remove one, asked in the editor's own box.
    await press(items.nth(0).locator('.kiln-entry-ctl'));
    await button('Remove').waitFor({ state: 'visible', timeout: 5000 });
    await press(button('Remove'));
    await page.waitForTimeout(300);
    const asked = await modalText();
    check(scope, 'removing asks first, in the editor\'s own box, and says History brings it back', /Remove “Summer fete”\?/.test(asked) && /History can bring it back/.test(asked), asked.replace(/\s+/g, ' ').slice(0, 160));
    await press(page.locator('#kiln-modal button', { hasText: /^Remove$/ }));
    await page.waitForTimeout(700);
    check(scope, 'it is removed in one commit, and dimmed on the page until the site has rebuilt', JSON.stringify(worker.removed) === JSON.stringify([`${DIR}/summer-fete.md`]) && await items.nth(0).evaluate(el => el.classList.contains('kiln-entry-removed')));
    check(scope, 'and the entry\'s box is put away', await page.locator('#kiln-modal').count() === 0);

    // The draft the list does not show, from Entries & drafts; scheduled.
    await menuItem('kiln-entries');
    await page.locator('#kiln-el-list .kiln-inv-row').first().waitFor({ state: 'visible', timeout: 5000 });
    const listed = await page.locator('#kiln-el-list').innerText();
    await shot('entries-list');
    check(scope, 'Entries & drafts lists the collection with its draft first', /^Autumn walk\s+Draft/.test(listed.trim()) && /Spring fair/.test(listed), listed.replace(/\s+/g, ' ').slice(0, 120));
    await press(page.locator('#kiln-el-list .kiln-inv-row').first().locator('button'));
    await button('Put it on the site later').waitFor({ state: 'visible', timeout: 5000 });
    check(scope, 'the draft\'s box says it is a draft', /A draft: it is not on the site\./.test(await modalText()));
    await press(button('Put it on the site later'));
    await page.locator('#kiln-es-at').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#kiln-es-at').fill('2026-10-30T09:00');
    await press(page.locator('#kiln-es-go'));
    await page.waitForTimeout(500);
    const sched = worker.schedules[0];
    check(scope, 'scheduling hands the worker the draft mark to take off, at that time', sched?.source?.file === `${DIR}/autumn-walk.md` && sched.source.edits[0].pointer === '/frontmatter/draft' && sched.source.edits[0].value === false && /Scheduled/.test(await modalText()), JSON.stringify(sched).slice(0, 200));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // Publish the new order.
    await press(page.locator('#kiln-publish-quick'));
    await page.waitForTimeout(450);
    const sheet = await page.locator('.kiln-pubsheet').innerText().catch(() => '');
    check(scope, 'the publish sheet says the entries moved, in words', (sheet.match(/Moved in the list\./g) || []).length === 2, sheet.replace(/\s+/g, ' ').slice(0, 160));
    if (await page.locator('#kiln-pubsheet-go').count()) await press(page.locator('#kiln-pubsheet-go'));
    await page.waitForTimeout(1200);
    const orders = Object.fromEntries(worker.commits.map(c => [c.file.split('/').pop(), c.edits.map(e => [e.pointer, e.value])]));
    check(scope, 'one commit per entry, each with its new order', JSON.stringify(orders) === JSON.stringify({ 'spring-fair.md': [['/frontmatter/order', 2]], 'summer-fete.md': [['/frontmatter/order', 1]] }), JSON.stringify(orders));

    // The entry's own page: History and Page settings.
    worker.commits.length = 0;
    await page.goto(`${ORIGIN}${AT}posts/spring-fair/`, { waitUntil: 'load' });
    await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(800);
    check(scope, 'on its own page the entry has its Entry button too', await page.locator('article > .kiln-entry-ctl').count() === 1);
    await menuItem('kiln-history');
    await page.locator('#kiln-sh-list .kiln-hist-row').first().waitFor({ state: 'visible', timeout: 5000 });
    const hist = await page.locator('#kiln-sh-list').innerText();
    await shot('entries-history');
    check(scope, 'History lists the versions of the page\'s file, newest first, with who made them', /now/.test(hist) && /Sam/.test(hist) && /Site Owner/.test(hist), hist.replace(/\s+/g, ' ').slice(0, 160));
    await press(page.locator('#kiln-sh-list .kiln-hist-row').nth(1).locator('button', { hasText: 'Preview' }));
    await page.locator('#kiln-pv .kiln-pv-fields').waitFor({ state: 'visible', timeout: 5000 });
    check(scope, 'Preview shows that version\'s fields and text', /The spring fair, from ten until four/.test(await page.locator('#kiln-pv').innerText()));
    await press(page.locator('#kiln-pv-back'));
    await page.waitForTimeout(300);
    check(scope, 'going back asks first, in the editor\'s own box', /Go back to this version\?/.test(await modalText()));
    await press(page.locator('#kiln-modal button', { hasText: /^Go back to this$/ }));
    await page.waitForTimeout(600);
    check(scope, 'and puts the file back as it was at that version', worker.reverts[0]?.file === `${DIR}/spring-fair.md` && worker.reverts[0]?.toSha === 'a0'.padEnd(40, '0'), JSON.stringify(worker.reverts[0]));

    await menuItem('kiln-pagesettings');
    await page.locator('#kiln-sp-title').waitFor({ state: 'visible', timeout: 5000 });
    check(scope, 'Page settings shows the entry\'s title, description and social picture', await page.locator('#kiln-sp-title').inputValue() === 'Spring fair' && /from ten until four/.test(await page.locator('#kiln-sp-desc').inputValue()) && /social\.png/.test(await page.locator('#kiln-sp-picname').innerText()));
    await page.locator('#kiln-sp-desc').fill('x'.repeat(170));
    await press(page.locator('#kiln-sp-go'));
    await page.waitForTimeout(250);
    check(scope, 'a description longer than the schema takes is not published, and that is said', /at most 160 characters/.test(await page.locator('#kiln-sp-said').innerText()) && worker.commits.length === 0);
    await page.locator('#kiln-sp-desc').fill('The village spring fair, with stalls from ten until four.');
    await shot('entries-settings');
    await press(page.locator('#kiln-sp-go'));
    await page.waitForTimeout(1200);
    const sent = worker.commits[0]?.edits || [];
    check(scope, 'Publish sends the new description, and only that, to the entry\'s file', worker.commits.length === 1 && worker.commits[0].file === `${DIR}/spring-fair.md` && sent.length === 1 && sent[0].pointer === '/frontmatter/description' && sent[0].value === 'The village spring fair, with stalls from ten until four.', JSON.stringify(worker.commits).slice(0, 200));
  } finally {
    check(scope, 'no script errors, no browser box, nothing outside the local server', errors.length === 0 && boxes.length === 0 && blocked.length === 0, [...errors, ...boxes, ...blocked].join(' | ').slice(0, 200));
    await context.close();
  }
}

/**
 * The site owner with an owner session ("owner"): the GitHub token stays on
 * the worker, played here by this script as the owner-sessions contract says.
 * The owner arrives with #kiln-owner=…; the browser keeps a session and no
 * token; nothing is asked of api.github.com, every GitHub call goes to the
 * worker's /gh/ with X-Kiln-Session; an edit is published, People & access
 * opens, Sign out ends the session on the worker. A session the worker has
 * ended says so, while editing and on page load, and "Sign in again" asks
 * the worker to keep the token. An owner signed in the old way is moved
 * over with one /auth/adopt when the worker keeps owner sessions, and keeps
 * working the old way, straight to GitHub, with a worker that does not.
 */
async function runOwner(browser, size) {
  const phone = size.width < 600;
  const scope = `${size.width}x${size.height} owner       `;
  const WORKER = 'https://worker.invalid';
  const GITHUB = 'https://api.github.com';
  const REPO = 'acme/site';
  const S1 = '1'.repeat(64), S2 = '2'.repeat(64), S3 = '3'.repeat(64), S4 = '4'.repeat(64);
  const DAY = 24 * 3600 * 1000;
  const source = await (await fetch(URL_ARG)).text();
  const file = new URL(URL_ARG).pathname.replace(/^\/+/, '').replace(/(^|\/)$/, '$1index.html');
  const words = async (locator) => ((await locator.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();

  /** One browser, with the worker this script plays. `seed`: kiln_admin as stored before the first page. */
  async function open({ seed = null, ownerSessions = true } = {}) {
    const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone });
    await context.addInitScript(([seed]) => {
      try {
        if (sessionStorage.getItem('ui_check_seeded')) return;
        sessionStorage.setItem('ui_check_seeded', '1');
        localStorage.setItem('kiln_guide', '1');
        if (seed) localStorage.setItem('kiln_admin', JSON.stringify(seed));
      } catch { /* ignore */ }
    }, [seed]);
    const w = { known: new Set([S1]), puts: [], github: [], gh: [], bearer: [], adopt: [], logout: [], people: [], logins: [], blocked: [], release: [], current: source, sha: 'sha0' };
    await context.route('**/*', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      const h = req.headers();
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': ORIGIN }, body: JSON.stringify(body) });
      if (u.origin === ORIGIN && u.pathname.endsWith('kiln-config.js')) {
        return route.fulfill({ contentType: 'text/javascript', body: `window.KILN = { repo: '${REPO}', branch: 'main', worker: '${WORKER}', styles: [] };` });
      }
      if (u.origin === ORIGIN || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
      if (req.method() === 'OPTIONS' && (u.origin === WORKER || u.origin === GITHUB)) {
        return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Kiln-Session, Accept', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' } });
      }
      let p = decodeURIComponent(u.pathname);
      if (u.origin === GITHUB) {
        // Every request the page makes to GitHub itself is counted. Only the old way answers it.
        w.github.push(`${req.method()} ${p}`);
        if (ownerSessions || h.authorization !== 'Bearer ghu_old') return json({ message: 'Bad credentials' }, 401);
        p = `/gh${p}`;
      } else if (u.origin === 'https://raw.githubusercontent.com' && /^\/kilncms\/kiln\/release\//.test(p)) {
        // The owner's check for a newer Kiln release: a public file, read with no sign-in.
        w.release.push(h.authorization || h['x-kiln-session'] || '');
        return route.abort();
      } else if (u.origin !== WORKER) return refuse(route, w.blocked);
      else if (h.authorization) w.bearer.push(`${req.method()} ${p}`);   // a GitHub token sent to the worker
      const session = h['x-kiln-session'] || '';
      const signedIn = u.origin === GITHUB || w.known.has(session);
      if (p === '/healthz') return json({ ok: true, modes: ['html', 'source'], adapters: ['astro'], ...(ownerSessions && { ownerSessions: true }) });
      if (p === '/auth/login') {
        w.logins.push(Object.fromEntries(u.searchParams));
        w.known.add(S4);
        return route.fulfill({ status: 302, headers: { Location: `${ORIGIN}${u.searchParams.get('return_to') || '/'}#${new URLSearchParams({ 'kiln-owner': S4, 'kiln-login': 'erik', 'kiln-exp': String(Date.now() + 180 * DAY) })}` } });
      }
      if (p === '/auth/adopt') {
        w.adopt.push(JSON.parse(req.postData() || '{}'));
        if (!ownerSessions) return json({ error: 'Not Found' }, 404);
        w.known.add(S2);
        return json({ ok: true, session: S2, login: 'erik', exp: Date.now() + 180 * DAY });
      }
      if (p === '/auth/logout') { w.logout.push(session); w.known.delete(session); return json({ ok: true }); }
      if (p === '/auth/session' && w.sessionAnswer) return json(w.sessionAnswer.body, w.sessionAnswer.status);
      if (p === '/auth/session') return signedIn ? json({ ok: true, role: 'owner', login: 'erik', repo: REPO, exp: Date.now() + 180 * DAY }) : json({ code: 'signin_ended' }, 401);
      if (!signedIn && !(u.origin === WORKER && h.authorization === 'Bearer ghu_old')) return json({ code: 'signin_ended' }, 401);
      if (p === '/presence') return json({ ok: true, others: [], online: [], scope: null });
      if (p === '/admin/people') { w.people.push(session); return json({ ok: true, googleConfigured: true, people: [] }); }
      if (!p.startsWith('/gh/')) return json({ ok: true, items: [], comments: [], suggestions: [], schedules: [] });
      if (u.origin === WORKER) w.gh.push({ path: p, session });
      if (p === '/gh/user') return json({ login: 'erik' });
      if (p === `/gh/repos/${REPO}/contents/${file}`) {
        if (req.method() === 'GET') return json({ sha: w.sha, content: Buffer.from(w.current).toString('base64') });
        const body = JSON.parse(req.postData());
        w.puts.push(body);
        w.current = Buffer.from(body.content, 'base64').toString();
        w.sha = `sha${w.puts.length}`;
        return json({ commit: { sha: `commit${w.puts.length}` }, content: {} });
      }
      if (p === `/gh/repos/${REPO}/git/ref/heads/main`) return json({ object: { sha: 'head' } });
      if (p.includes('/deployments')) return json([]);
      if (p.endsWith('/status')) return json({ total_count: 0 });
      return json({ message: 'Not Found' }, 404);
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.accept());
    return { context, page, w, errors };
  }
  const press = (page, locator) => (phone ? locator.tap() : locator.click());
  const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('kiln_admin') || 'null'));
  const tokenAnywhere = (page) => page.evaluate(() => {
    const all = [location.href, ...Object.keys(localStorage).map(k => localStorage.getItem(k)), ...Object.keys(sessionStorage).map(k => sessionStorage.getItem(k))].join('\n');
    return /ghu_|kiln-token|"token"/.test(all);
  });
  const started = async (page) => { await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 }); await page.waitForTimeout(700); };
  const menu = async (page, id) => {
    const bar = page.locator(`#${id}`).filter({ visible: true }).first();
    if (!(await bar.count())) { await press(page, page.locator('#kiln-fab')); await page.waitForTimeout(300); }
    await press(page, page.locator(`#${id}`).filter({ visible: true }).first());
  };
  const editAndPublish = async (page, typed) => {
    const heading = page.locator('h1.kiln-field, h2.kiln-field, h3.kiln-field').first();
    await heading.scrollIntoViewIfNeeded();
    await press(page, heading);
    await page.keyboard.type(typed);
    await press(page, page.locator('#kiln-toolbar .kiln-tb-save'));
    await page.waitForTimeout(300);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await press(page, page.getByRole('button', { name: /^Publish/ }).filter({ visible: true }).first());
    await page.waitForTimeout(500);
    if (await page.locator('#kiln-pubsheet-go').count()) await press(page, page.locator('#kiln-pubsheet-go'));
    await page.waitForTimeout(1800);
    return heading;
  };

  // ── a new sign-in: the worker comes back with a session ────────────────────
  {
    const { context, page, w, errors } = await open();
    await page.goto(`${URL_ARG}#${new URLSearchParams({ 'kiln-owner': S1, 'kiln-login': 'erik', 'kiln-exp': String(Date.now() + 180 * DAY) })}`, { waitUntil: 'load' });
    await started(page);
    const kept = await stored(page);
    check(scope, 'the editor starts for the owner signed in with a session', (await page.locator('#kiln-fab').count()) === 1);
    check(scope, 'the browser keeps the session, the name and the repository, and no GitHub token', JSON.stringify(Object.keys(kept || {}).sort()) === '["exp","login","repo","session"]' && kept.session === S1 && kept.repo === REPO && kept.login === 'erik', JSON.stringify(kept));
    check(scope, 'no token in the address, in localStorage or in sessionStorage, and the address is cleaned', !(await tokenAnywhere(page)) && !/kiln-/.test(page.url()), page.url());
    await editAndPublish(page, ' Owner words');
    check(scope, 'an edit is published through the worker', w.puts.length === 1 && Buffer.from(w.puts[0].content, 'base64').toString().includes('Owner words'), `${w.puts.length} writes`);
    await menu(page, 'kiln-invite');
    await page.waitForTimeout(900);
    const list = await words(page.locator('#kiln-people-list'));
    check(scope, 'People & access opens with the session', w.people.length >= 1 && w.people.every(s => s === S1) && /Nobody yet/.test(list), `${w.people.join(',').slice(0, 20)} ${list}`);
    if (await page.locator('#kiln-modal').count()) await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check(scope, 'every GitHub call went to the worker with the session', w.gh.length > 0 && w.gh.every(g => g.session === S1), `${w.gh.length} calls`);
    check(scope, 'nothing was asked of api.github.com, and no GitHub token was sent to the worker', w.github.length === 0 && w.bearer.length === 0, [...w.github, ...w.bearer].slice(0, 3).join(', '));
    await menu(page, 'kiln-signout');
    await page.waitForTimeout(1200);
    check(scope, 'Sign out ends the session on the worker and forgets it here', JSON.stringify(w.logout) === JSON.stringify([S1]) && (await stored(page)) === null && !w.known.has(S1), JSON.stringify(w.logout));

    // signed in again by address; the worker ends the session while an edit is unpublished
    w.known.add(S3);
    await page.goto('about:blank');
    await page.goto(`${URL_ARG}#${new URLSearchParams({ 'kiln-owner': S3, 'kiln-login': 'erik', 'kiln-exp': String(Date.now() + 180 * DAY) })}`, { waitUntil: 'load' });
    await started(page);
    w.known.delete(S3);
    const heading = await editAndPublish(page, ' Kept words');
    const dialog = await words(page.locator('#kiln-modal .kiln-modal-card'));
    const line = await words(page.locator('#kiln-status'));
    check(scope, 'a session the worker ended: Publish says the sign-in has ended, and the edit stays', (/Your sign-in has ended/.test(line) || /sign-in has ended|Sign in again/.test(dialog)) && (await words(heading)).includes('Kept words') && w.puts.length === 1, `${line} | ${dialog.slice(0, 120)}`);
    if (await page.locator('#kiln-modal').count()) await page.keyboard.press('Escape');
    check(scope, 'no script errors', errors.length === 0, errors.join(' | ').slice(0, 200));
    check(scope, 'nothing outside the local server and the worker was needed, but the public release check, which is sent no sign-in', w.blocked.length === 0 && w.github.length === 0 && w.release.every(x => x === ''), w.blocked.slice(0, 3).join(', '));
    await context.close();
  }

  // ── page load with a session the worker no longer has ──────────────────────
  {
    const { context, page, w } = await open({ seed: { session: '9'.repeat(64), login: 'erik', repo: REPO, exp: Date.now() + DAY } });
    await page.goto(URL_ARG, { waitUntil: 'load' });
    const notice = page.locator('#kiln-notice');
    await notice.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    check(scope, 'page load: an ended session says so, as for an editor, and is dropped', (await words(notice.locator('p').first())) === 'Your sign-in to edit this site has ended, so please sign in again with GitHub.' && (await stored(page)) === null && (await page.locator('#kiln-fab').count()) === 0, await words(notice));
    if (await notice.count()) {
      await press(page, notice.getByRole('button', { name: 'Sign in again' }));
      await page.waitForTimeout(400);
      await started(page).catch(() => {});
      const asked = w.logins[0] || {};
      check(scope, '"Sign in again" asks the worker to keep the token, for this repository, and comes back signed in', asked.keep === 'server' && asked.repo === REPO && (await stored(page))?.session === S4 && (await page.locator('#kiln-fab').count()) === 1, JSON.stringify(asked));
    }
    await context.close();
  }

  // ── page load while GitHub is out of the worker's reach, or this address is refused: the session is kept ──
  for (const [status, code] of [[503, 'github_unreachable'], [403, 'owner_origin']]) {
    const { context, page, w } = await open({ seed: { session: S1, login: 'erik', repo: REPO, exp: Date.now() + DAY } });
    w.sessionAnswer = { status, body: { code, error: 'Not now.' } };
    await page.goto(URL_ARG, { waitUntil: 'load' });
    const notice = page.locator('#kiln-notice');
    await notice.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const said = await words(notice);
    check(scope, `page load answered ${status} ${code}: the session is kept and nothing says the sign-in has ended`, (await stored(page))?.session === S1 && !/has ended/.test(said) && said.length > 0, said.slice(0, 120));
    await context.close();
  }

  // ── signed in the old way, and the worker keeps owner sessions ─────────────
  {
    const { context, page, w, errors } = await open({ seed: { token: 'ghu_old', sid: 's1', exp: Date.now() + 8 * 3600 * 1000 } });
    await page.goto(URL_ARG, { waitUntil: 'load' });
    await started(page);
    const kept = await stored(page);
    check(scope, 'the old sign-in is moved over with one /auth/adopt, which is sent the token, the renewal id and the repository', w.adopt.length === 1 && w.adopt[0].token === 'ghu_old' && w.adopt[0].sid === 's1' && w.adopt[0].repo === REPO, JSON.stringify(w.adopt));
    check(scope, 'afterwards the browser keeps the session and no token', kept?.session === S2 && !('token' in (kept || {})) && !('sid' in (kept || {})) && !(await tokenAnywhere(page)), JSON.stringify(kept));
    check(scope, 'after moving over, nothing is asked of api.github.com', w.github.length === 0 && w.gh.length > 0 && w.gh.every(g => g.session === S2), w.github.slice(0, 3).join(', '));
    await page.reload({ waitUntil: 'load' });
    await started(page);
    check(scope, 'the next page asks nothing more of /auth/adopt', w.adopt.length === 1);
    check(scope, 'no script errors (moved over)', errors.length === 0, errors.join(' | ').slice(0, 200));
    await context.close();
  }

  // ── signed in the old way, and the worker keeps no owner sessions ──────────
  {
    const { context, page, w, errors } = await open({ seed: { token: 'ghu_old', sid: 's1', exp: Date.now() + 8 * 3600 * 1000 }, ownerSessions: false });
    await page.goto(URL_ARG, { waitUntil: 'load' });
    await started(page);
    const kept = await stored(page);
    check(scope, 'with an older worker nothing is moved, and the editor works the old way, straight to GitHub', w.adopt.length === 0 && kept?.token === 'ghu_old' && w.github.some(g => g === 'GET /user') && w.gh.length === 0, JSON.stringify({ adopt: w.adopt.length, github: w.github.length }));
    await editAndPublish(page, ' Old way');
    check(scope, 'an edit is published the old way', w.puts.length === 1, `${w.puts.length} writes`);
    check(scope, 'no script errors (the old way)', errors.length === 0, errors.join(' | ').slice(0, 200));
    await context.close();
  }
}

/**
 * "Make this whole page editable": the second button in the bar of
 * make-editable mode, as an invited editor on a real (not sandbox) site. The
 * worker is played here as in runSignedIn, and so is the site's host: once
 * the page's file has been written, the page is served as that file.
 */
async function runWholePage(browser, size) {
  const phone = size.width < 600;
  const scope = `${size.width}x${size.height} whole page  `;
  const WORKER = 'https://worker.invalid';
  const REPO = 'acme/site';
  const GRANTED = ['pagesettings', 'history', 'draft', 'makeeditable'];
  const source = await (await fetch(URL_ARG)).text();
  const pagePath = new URL(URL_ARG).pathname;
  const file = pagePath.replace(/^\/+/, '').replace(/(^|\/)$/, '$1index.html');
  const b64 = (text) => Buffer.from(text).toString('base64');
  const plan = wholePagePass(source);
  check(scope, 'the page this is run on has something a first pass would mark', plan.state === 'ready', plan.state);
  if (plan.state !== 'ready') return;
  const press = (locator) => (phone ? locator.tap() : locator.click());

  const open = async ({ features = null, keys = [], sandbox = false } = {}) => {
    const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone });
    await context.addInitScript(([repo, signedIn]) => {
      try {
        if (signedIn) localStorage.setItem('kiln_editor', JSON.stringify({ session: 'a'.repeat(64), name: 'Sam', repo, role: 'editor' }));
        localStorage.setItem('kiln_guide', '1');
      } catch { /* ignore */ }
    }, [REPO, !sandbox]);
    // `behind`: how many reads of the file, counted from a write, are still answered with the
    // file as it was before it. GitHub does that for a moment after a write, and a fast host has
    // the page out sooner. (The first of them is the editor's own read straight after the write.)
    const w = { puts: [], reads: 0, current: source, sha: 'sha0', boxes: 0, behind: 0, was: null };
    await context.route('**/*', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': ORIGIN }, body: JSON.stringify(body) });
      if (!sandbox && u.origin === ORIGIN && u.pathname.endsWith('kiln-config.js')) {
        return route.fulfill({ contentType: 'text/javascript', body: `window.KILN = { repo: '${REPO}', branch: 'main', worker: '${WORKER}', styles: [] };` });
      }
      // the site as its host serves it: once the page's file has been written, the page is that file
      if (u.origin === ORIGIN && u.pathname === pagePath && req.method() === 'GET' && w.puts.length) {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: w.current });
      }
      if (u.origin === ORIGIN || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
      if (u.origin !== WORKER) return route.abort();
      const p = decodeURIComponent(u.pathname);
      if (req.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Kiln-Session', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS' } });
      }
      if (p === '/presence') return json({ ok: true, others: [], online: [], scope: { paths: [''], keys, features, mode: null } });
      if (p === '/healthz') return json({ ok: true, modes: ['html', 'source'], adapters: ['astro'] });
      if (p === `/gh/repos/${REPO}/contents/${file}`) {
        if (req.method() === 'GET') {
          w.reads++;
          if (w.behind > 0 && w.was) { w.behind--; return json({ sha: w.was.sha, content: b64(w.was.text) }); }
          return json({ sha: w.sha, content: b64(w.current) });
        }
        const body = JSON.parse(req.postData());
        w.puts.push(body);
        w.was = { text: w.current, sha: w.sha };
        w.behind = 3;
        w.current = Buffer.from(body.content, 'base64').toString();
        w.sha = `sha${w.puts.length}`;
        return json({ commit: { sha: `commit${w.puts.length}` }, content: {} });
      }
      if (p.includes('/deployments')) return json([]);
      if (p.endsWith('/status')) return json({ total_count: 0 });
      return json({ message: 'Not Found' }, 404);
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => { w.boxes++; d.accept().catch(() => {}); });
    await page.goto(URL_ARG, { waitUntil: 'load' });
    await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(700);
    return { context, page, w, errors };
  };
  /** The Kiln menu, then "Make text/images editable". False when the tool is not in the menu. */
  const startMode = async (page) => {
    await press(page.locator('#kiln-fab'));
    await page.waitForTimeout(300);
    const make = page.locator('#kiln-makeblock');
    if (!(await make.count())) return false;
    await press(make);
    await page.waitForTimeout(300);
    return true;
  };
  const words = async (page) => ((await page.locator('#kiln-modal .kiln-modal-card').innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  const asks = (page) => page.locator('#kiln-modal.kiln-ask').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  const shot = async (page, step) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${step}-${size.width}.png`) }); };

  // ── with the grant: offered, asked about, one write, and the page loads again ──
  {
    const { context, page, w, errors } = await open({ features: GRANTED });
    const fieldsBefore = await page.evaluate(() => document.querySelectorAll('.kiln-field').length);
    check(scope, 'the tool starts for an editor with the grant', await startMode(page));
    const btn = page.locator('#kiln-pick-all');
    check(scope, 'the bar offers "Make this whole page editable"', (await btn.count()) === 1 && ((await btn.innerText().catch(() => '')) || '').trim() === 'Make this whole page editable');
    if (!(await btn.count())) { await context.close(); return; }
    const bar = await page.locator('#kiln-pickbar').boundingBox();
    const hb = await hit(btn), hd = await hit(page.locator('#kiln-pick-exit'));
    check(scope, 'the bar is on the screen, and both of its buttons can be pressed', !!bar && bar.x >= 0 && bar.x + bar.width <= size.width + 0.5 && hb.ok && hd.ok, `${JSON.stringify(bar)} ${hb.why || ''} ${hd.why || ''}`);
    await shot(page, 'whole-page-bar');
    if (!phone) {
      // from the keyboard: Enter on the button asks, and the keyboard starts on the button that changes nothing
      await btn.focus();
      await page.keyboard.press('Enter');
      await asks(page);
      const on = await page.evaluate(() => (document.activeElement?.textContent || '').trim());
      check(scope, 'Enter on the button asks, and the keyboard starts on "Cancel"', /Make this whole page editable\?/.test(await words(page)) && on === 'Cancel', on);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      check(scope, 'Enter on "Cancel" puts the question away, writes nothing and leaves the bar', (await page.locator('#kiln-modal').count()) === 0 && w.puts.length === 0 && (await btn.count()) === 1);
    }
    await press(btn);
    await asks(page);
    const asked = await words(page);
    check(scope, 'pressing it asks in the editor\'s own dialog, with what it would mark', asked.includes(`Kiln will mark ${markedWords(plan.counts)} on this page.`), asked.slice(0, 200));
    check(scope, 'the question says what is left alone, that visitors see no difference, and how it is saved',
      /leaves tables, buttons and forms alone, and anything that is already marked/.test(asked) && /A visitor sees no difference\./.test(asked)
      && /made plain again/.test(asked) && /saved at once as one change to this page, in your name/.test(asked), asked.slice(-260));
    const go = page.locator('#kiln-ask-go'), cancel = page.locator('#kiln-modal .kiln-modal-actions [data-close]');
    const hg = (await go.count()) ? await hit(go) : { ok: false, why: 'no button' }, hc = (await cancel.count()) ? await hit(cancel) : { ok: false, why: 'no button' };
    check(scope, 'its buttons are "Make them editable" and "Cancel", and both can be pressed',
      ((await go.innerText().catch(() => '')) || '').trim() === 'Make them editable' && ((await cancel.innerText().catch(() => '')) || '').trim() === 'Cancel' && hg.ok && hc.ok, `${hg.why || ''} ${hc.why || ''}`);
    await shot(page, 'whole-page-ask');
    await press(cancel);
    await page.waitForTimeout(300);
    check(scope, '"Cancel" writes nothing', w.puts.length === 0 && (await page.locator('#kiln-modal').count()) === 0);
    await press(btn);
    await asks(page);
    await page.evaluate(() => { window.__uiCheckSamePage = true; });
    await press(go);
    // saved, and then the page loads again by itself once the site serves it with the marks
    let reloaded = false;
    for (let t = 0; t < 60 && !reloaded; t++) {
      await page.waitForTimeout(500);
      reloaded = await page.evaluate(() => document.readyState === 'complete' && !window.__uiCheckSamePage).catch(() => false);
    }
    check(scope, 'the page loads again by itself once the site has the marks', reloaded);
    await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(700);
    const sent = w.puts.length ? Buffer.from(w.puts[0].content, 'base64').toString() : '';
    check(scope, 'confirming makes exactly one write of the page\'s file', w.puts.length === 1, `${w.puts.length} writes`);
    check(scope, 'what is written is the old file with only data-cms marks added', sent !== source && onlyAddsMarks(source, sent) && sent === plan.html, `${sent.length - source.length} characters longer`);
    check(scope, 'the commit says a first pass was marked on this page, against the file as it was read',
      w.puts[0]?.message === `Mark a first pass of what can be edited on ${file}: ${markedWords(plan.counts)} (via Kiln)` && w.puts[0]?.branch === 'main' && w.puts[0]?.sha === 'sha0', `${w.puts[0]?.message} ${w.puts[0]?.sha}`);
    check(scope, 'nothing was asked in a box of the browser\'s', w.boxes === 0, `${w.boxes}`);
    const fieldsAfter = await page.evaluate(() => document.querySelectorAll('.kiln-field').length);
    check(scope, 'after the reload more of the page can be edited', fieldsAfter > fieldsBefore, `${fieldsBefore} → ${fieldsAfter}`);
    // Each part the pass marked is editable now, although the first reads of the file after the
    // write were answered with the file as it was: the editor read it again until it had the marks.
    const keysOf = (text) => new Set([...text.matchAll(/\sdata-cms="([^"]+)"/g)].map(m => m[1]));
    const had = keysOf(source);
    const fresh = [...keysOf(plan.html)].filter(k => !had.has(k));
    const dead = await page.evaluate((keys) => keys.filter(k => { const all = [...document.querySelectorAll(`[data-cms="${k}"]`)]; return !all.length || all.some(n => !n.classList.contains('kiln-field')); }), fresh);
    check(scope, 'every part it marked can be edited after the reload, though the file was first read as it had been', fresh.length > 0 && dead.length === 0 && w.behind === 0, `${fresh.length} new, not editable: ${dead.join(', ') || 'none'}; reads still behind: ${w.behind}`);
    check(scope, 'and nothing is left behind in the browser for the next reload', (await page.evaluate(() => sessionStorage.getItem('kiln_whole_page'))) === null);
    await shot(page, 'whole-page-after');
    // pressed again: nothing more to mark, said in the editor's own dialog, and nothing written
    await startMode(page);
    if (await btn.count()) await press(btn);
    await asks(page);
    check(scope, 'pressed again, it says there is nothing more to mark, and writes nothing', /There is nothing more to mark on this page/.test(await words(page)) && w.puts.length === 1, (await words(page)).slice(0, 120));
    check(scope, 'no script errors', errors.length === 0, errors.join(' | ').slice(0, 200));
    await context.close();
  }
  // ── a part marked by clicking is still waiting for Publish: said, and nothing read or written ──
  {
    const { context, page, w } = await open({ features: GRANTED });
    await startMode(page);
    const found = await page.evaluate(() => {
      for (const el of document.querySelectorAll('main p, main li, main span, footer p, footer span, footer li')) {
        if (el.closest('[data-cms],[data-cms-repeat],[data-cms-menu],[id^="kiln-"]') || el.querySelector('[data-cms],[data-cms-repeat]')) continue;
        if (el.children.length || (el.textContent || '').trim().length < 8 || !el.getClientRects().length) continue;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2 };
      }
      return null;
    });
    if (found) {
      await page.waitForTimeout(400);
      await page.mouse.click(found.x, found.y);
      await page.waitForTimeout(400);
      if (await page.locator('#kiln-mk-go').count()) await press(page.locator('#kiln-mk-go'));
      await page.waitForTimeout(700);
    }
    const waiting = await page.evaluate(() => /Publish to save it/.test(document.getElementById('kiln-status')?.textContent || ''));
    check(scope, 'a part is marked by clicking and waits for Publish', !!found && waiting);
    const reads = w.reads;
    await press(page.locator('#kiln-pick-all'));
    await asks(page);
    const told = await words(page);
    check(scope, 'with that waiting, it says to publish or discard first', /Publish or discard your changes first/.test(told) && /saves the page at once/.test(told), told.slice(0, 160));
    check(scope, 'and it reads and writes nothing', w.puts.length === 0 && w.reads === reads, `${w.puts.length} writes, ${w.reads - reads} reads`);
    await context.close();
  }
  // ── where it is not offered ──
  {
    const { context, page } = await open({ features: null });
    const started = await startMode(page);
    check(scope, 'without the grant there is no bar and no such button', !started && (await page.locator('#kiln-pickbar, #kiln-pick-all').count()) === 0);
    await context.close();
  }
  {
    const { context, page } = await open({ features: GRANTED, keys: ['hero'] });
    const started = await startMode(page);
    check(scope, 'an editor limited to parts of a page gets the bar without the button', started && (await page.locator('#kiln-pickbar').count()) === 1 && (await page.locator('#kiln-pick-all').count()) === 0);
    await context.close();
  }
  {
    const { context, page } = await open({ sandbox: true });
    const started = await startMode(page);
    const bar = ((await page.locator('#kiln-pickbar').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
    check(scope, 'in the demo the bar is as it was, without the button', started && /anything to make it editable/.test(bar) && /Done/.test(bar) && (await page.locator('#kiln-pick-all').count()) === 0, bar.slice(0, 120));
    await context.close();
  }
}

const browser = await chromium.launch();
const guarded = async (label, fn) => {
  if (ONLY && !label.includes(ONLY)) return;
  // What stopped it, and on what: Playwright names the element it was waiting for on a later line.
  try { await fn(); } catch (err) {
    const said = String(err.message || err).split('\n');
    const waiting = said.find(l => /waiting for (locator|getBy|selector)/.test(l));
    check(label, 'ran to the end', false, `${said[0].slice(0, 220)}${waiting ? `; ${waiting.trim().slice(0, 200)}` : ''}`);
  }
};
try {
  for (const size of SIZES) {
    for (const firstVisit of [false, true]) {
      await guarded(`${size.width}x${size.height} ${firstVisit ? 'first visit ' : 'returning   '}`, () => run(browser, size, firstVisit));
    }
  }
  // what a person tries after a first edit: Undo in a list, and the rest of the safety net
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} safety net  `, () => runSafetyNet(browser, size));
  // Undo, Redo, Esc, Drop and History show the heading as it looked, and nothing of an animation is published
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} undo shows  `, () => runUndoShows(browser, size));
  // the rest of what a first-time client met: the publish sheet, taps that did nothing, the menu, pictures, questions
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} first edits `, () => runFirstEdits(browser, size));
  // the demo's own way to get Kiln stays in sight once the card that offered it has gone
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} get Kiln    `, () => runGetKiln(browser, size));
  // lists and block styles only where they fit, the cursor kept after a list, a link typed without https://
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} lists and links`, () => runListsAndLinks(browser, size));
  // no mouse: Tab, Enter, Esc and the arrow keys reach and edit every part, the toolbar, the dialogs and the menu
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} keyboard`, () => runKeyboard(browser, size));
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} signed in   `, () => runSignedIn(browser, size));
  // an invited editor granted "Make things editable" on top of the defaults
  await guarded(`${SIZES[0].width}x${SIZES[0].height} granted     `, () => runSignedIn(browser, SIZES[0], { features: ['pagesettings', 'history', 'draft', 'makeeditable'] }));
  // "Make this whole page editable": offered with the grant, asked about, one write of only marks, and where it is not offered
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} whole page  `, () => runWholePage(browser, size));
  // what only shows on a real site: a bar pinned to the top, blocks its own scripts change, History's way back, the editor's own questions
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} real sites  `, () => runRealSites(browser, size));
  // a page a generator built: a field someone else changed, the site's real pages, and what a suggest-only or comment-only editor is offered
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} generated   `, () => runGenerated(browser, size));
  // formatted text from a content file: the toolbar, a bold word, a new item, a table that takes no typing, the file's own Markdown
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} formatted   `, () => runFormatted(browser, size));
  // pictures and link addresses from a content file: replaced, described, checked against the site's schema, the pictures committed first
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} media       `, () => runMedia(browser, size));
  // entries of a collection: move, add from the schema, remove, a draft scheduled, the new order published, History and Page settings
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} entries     `, () => runEntries(browser, size));
  // the worker ends an invited editor's sign-in
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} sign-in ended`, () => runSignInEnded(browser, size));
  // …and they find out anywhere else in the editor
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} ended elsewhere`, () => runSignInEverywhere(browser, size));
  // the site owner with an owner session: no GitHub token in the browser, everything through the worker, and the old way moved over
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} owner       `, () => runOwner(browser, size));
} finally { await browser.close(); }

console.log(lines.join('\n'));
const total = lines.length;
console.log(`\nui-check: ${total - failed}/${total} checks passed at ${SIZES.map(s => `${s.width}x${s.height}`).join(', ')}${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
