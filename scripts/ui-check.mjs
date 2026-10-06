#!/usr/bin/env node
/**
 * ui-check — drive the editor in a real browser and check the first minute of
 * editing: can a person find what is editable, make an edit, and publish it,
 * with none of Kiln's own interface sitting on top of another part of it.
 *
 *   node scripts/ui-check.mjs http://localhost:8774/ [--shots <dir>]
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
 * Both passes go through the publish sheet (open it, drop one edit, publish)
 * and press Undo; the signed-in pass also has someone else publish in between.
 * Exits non-zero if any check fails. `--shots <dir>` also saves a screenshot
 * of each step as <step>-<width>.png.
 *
 * Playwright is not a dependency of this repo. Point PLAYWRIGHT_DIR at any
 * installed copy of the `playwright` package (with its Chromium downloaded).
 * Not part of `npm test` or CI.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const PLAYWRIGHT_DIR = process.env.PLAYWRIGHT_DIR || '/Users/shmergle/repos/outinglist/node_modules/playwright';
const args = process.argv.slice(2);
const shotsAt = args.indexOf('--shots');
const SHOTS = shotsAt !== -1 ? args[shotsAt + 1] : null;
const URL_ARG = args.find((a, i) => !a.startsWith('--') && (shotsAt === -1 || i !== shotsAt + 1));
if (!URL_ARG) {
  console.error('usage: node scripts/ui-check.mjs <url of a locally served sandbox site> [--shots <dir>]');
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
      await item.hover();
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
    if (await card.count()) await press(card.getByRole('button', { name: 'Got it' }));
    await page.waitForTimeout(200);
    check(scope, '"Got it" closes the guide', (await card.count()) === 0 && (await guide.count()) === 0);
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
  check(scope, 'no script errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  check(scope, 'nothing outside the local server was needed', blocked.length === 0, blocked.slice(0, 3).join(', '));
  await context.close();
}

const browser = await chromium.launch();
const guarded = async (label, fn) => {
  try { await fn(); } catch (err) { check(label, 'ran to the end', false, String(err.message || err).split('\n')[0].slice(0, 220)); }
};
try {
  for (const size of SIZES) {
    for (const firstVisit of [false, true]) {
      await guarded(`${size.width}x${size.height} ${firstVisit ? 'first visit ' : 'returning   '}`, () => run(browser, size, firstVisit));
    }
  }
  for (const size of [SIZES[0], SIZES[1]]) await guarded(`${size.width}x${size.height} signed in   `, () => runSignedIn(browser, size));
  // an invited editor granted "Make things editable" on top of the defaults
  await guarded(`${SIZES[0].width}x${SIZES[0].height} granted     `, () => runSignedIn(browser, SIZES[0], { features: ['pagesettings', 'history', 'draft', 'makeeditable'] }));
} finally { await browser.close(); }

console.log(lines.join('\n'));
const total = lines.length;
console.log(`\nui-check: ${total - failed}/${total} checks passed at ${SIZES.map(s => `${s.width}x${s.height}`).join(', ')}${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
