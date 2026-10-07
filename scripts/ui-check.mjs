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
 * outside that server is contacted: every other request is blocked.
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
 * Exits non-zero if any check fails. `--shots <dir>` also saves a screenshot
 * of each step as <step>-<width>.png. `--only <pass>` runs the passes whose
 * name has that word in it ("safety net", "signed in", "ended elsewhere"…).
 *
 * Playwright is not a dependency of this repo. Point PLAYWRIGHT_DIR at any
 * installed copy of the `playwright` package (with its Chromium downloaded).
 * Not part of `npm test` or CI.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

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

async function run(browser, size, firstVisit) {
  const phone = size.width < 600;
  const scope = `${size.width}x${size.height} ${firstVisit ? 'first visit ' : 'returning   '}`;
  const context = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone, reducedMotion: 'no-preference' });
  // Hermetic: only the local server answers.
  const blocked = [];
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(ORIGIN) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    blocked.push(u);
    return route.abort();
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
    if (await guide.count()) check(scope, 'guide step 1 does not cover the heading', apart(await box(guide), await box(heading)));
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
    await page.mouse.click(300, 300);
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
  if (phone && await banner.count()) {
    const bb = await box(banner);
    const others = [pencil, publish, page.locator('#kiln-undo-btn'), page.locator('#kiln-redo-btn')];
    let clear = true;
    for (const o of others) if (await o.count()) clear = clear && apart(bb, await box(o));
    check(scope, 'demo banner covers none of pencil, Publish, Undo, Redo', clear);
  }
  if (firstVisit) {
    await guide.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    check(scope, 'guide step 2 points at Publish', ((await guide.locator('span').first().textContent().catch(() => '')) || '') === 'Now publish it.');
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
      await page.touchscreen.tap(m.left + m.width / 2, m.top + m.height / 2);
      await page.waitForTimeout(250);
      check(scope, 'the "more" button stays in its corner when the bar opens', Math.abs((await box(more)).left - m.left) < 1 && Math.abs((await box(more)).top - m.top) < 1);
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
    let reachable = count >= 5;
    for (let i = 0; i < count; i++) reachable = reachable && (await hit(buttons.nth(i))).ok;
    check(scope, `every button in the open control bar can be pressed (${count})`, reachable);
    if (!firstVisit) await shot('grid');
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
    if (tab) { blocked.length = 0; await tab.close().catch(() => {}); }
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
    blocked.push(u);
    return route.abort();
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
      await second.scrollIntoViewIfNeeded();
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
    await second.scrollIntoViewIfNeeded();
    if (phone) { await second.locator('.kiln-ctl-more').tap(); await page.waitForTimeout(250); } else { await second.hover(); await page.waitForTimeout(250); }
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
    if (phone) { await second.locator('.kiln-ctl-more').tap(); await page.waitForTimeout(250); } else { await second.hover(); await page.waitForTimeout(250); }
    await press(second.locator('button[title="Remove this block"]'));
    await page.waitForTimeout(300);
    if (phone) { await second.locator('.kiln-ctl-more').tap(); await page.waitForTimeout(250); } else { await second.hover(); await page.waitForTimeout(250); }
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
  check(scope, 'Schedule says what a real site does, in the demo\'s words', /Nothing is scheduled in the demo\. On a real site, /.test(said) && plain(said.replace(/Schedule these 1 edit Kiln .*? rebuilds\./, '')), said.slice(-150));
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
  check(scope, 'Theme is said in an editor\'s words, and names its settings without the stylesheet\'s dashes', /^The site’s colours and type sizes\./.test(said) && !/CSS|:root/.test(said)
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
      asked.push(url);
      return route.abort();
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
    asked.length = 0;
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
    if (u.origin !== WORKER) { blocked.push(req.url()); return route.abort(); }
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
    if (u.origin !== WORKER) { blocked.push(req.url()); return route.abort(); }
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
    if (u.origin !== WORKER) { blocked.push(req.url()); return route.abort(); }
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
    await ended(name, `Nothing was cancelled. Your edit is saved in this browser and will be back on this page ${BACK}.`);
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
      blocked.push(u);
      return route.abort();
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
      if (u.origin !== WORKER) { blocked.push(req.url()); return route.abort(); }
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
        return json([...versions].reverse().map((v, i, all) => ({ sha: v.sha, parents: all[i + 1] ? [{ sha: all[i + 1].sha }] : [],
          commit: { message: v.message, author: { name: v.by, date: new Date(Date.now() - i * 60000).toISOString() } } })));
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
}

const browser = await chromium.launch();
const guarded = async (label, fn) => {
  if (ONLY && !label.includes(ONLY)) return;
  try { await fn(); } catch (err) { check(label, 'ran to the end', false, String(err.message || err).split('\n')[0].slice(0, 220)); }
};
try {
  for (const size of SIZES) {
    for (const firstVisit of [false, true]) {
      await guarded(`${size.width}x${size.height} ${firstVisit ? 'first visit ' : 'returning   '}`, () => run(browser, size, firstVisit));
    }
  }
  // what a person tries after a first edit: Undo in a list, and the rest of the safety net
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} safety net  `, () => runSafetyNet(browser, size));
  // the demo's own way to get Kiln stays in sight once the card that offered it has gone
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} get Kiln    `, () => runGetKiln(browser, size));
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} signed in   `, () => runSignedIn(browser, size));
  // an invited editor granted "Make things editable" on top of the defaults
  await guarded(`${SIZES[0].width}x${SIZES[0].height} granted     `, () => runSignedIn(browser, SIZES[0], { features: ['pagesettings', 'history', 'draft', 'makeeditable'] }));
  // what only shows on a real site: a bar pinned to the top, blocks its own scripts change, History's way back, the editor's own questions
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} real sites  `, () => runRealSites(browser, size));
  // the worker ends an invited editor's sign-in
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} sign-in ended`, () => runSignInEnded(browser, size));
  // …and they find out anywhere else in the editor
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} ended elsewhere`, () => runSignInEverywhere(browser, size));
} finally { await browser.close(); }

console.log(lines.join('\n'));
const total = lines.length;
console.log(`\nui-check: ${total - failed}/${total} checks passed at ${SIZES.map(s => `${s.width}x${s.height}`).join(', ')}${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
