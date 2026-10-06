#!/usr/bin/env node
/**
 * demo-video — record the first minute of Kiln as a short video anyone can
 * watch: arrive on the demo, click the headline, type three words, see the
 * publish sheet with before and after, publish, "That was a Git commit", Undo.
 *
 *   node scripts/demo-video.mjs --site <folder of the demo site> --out <folder for the videos>
 *   node scripts/demo-video.mjs http://localhost:8774/ --out <folder>      (a site you already serve)
 *
 * Two cuts, each 15 to 25 seconds: a phone (390x844) and a desktop (1280x800).
 * For each it writes
 *
 *   kiln-demo-<cut>.mp4          H.264, under 2.5 MB, starts playing before it has all arrived
 *   kiln-demo-<cut>.webm         VP9
 *   kiln-demo-<cut>-poster.jpg   the first second, for the <video poster>
 *   kiln-demo-<cut>-sheet.jpg    one frame every two seconds, side by side: look at it
 *
 * It is a real recording of the real editor, made with Playwright's own video
 * recording. Two things are drawn by this script because a headless browser
 * shows neither: the mouse pointer on the desktop cut, and a dot where the
 * finger lands on the phone cut. (And one pixel in the bottom left corner is
 * redrawn every frame, which is what keeps the recorder supplied with frames.)
 * Nothing else on screen is staged.
 *
 * --site serves the folder itself on 127.0.0.1 (port 8774, or --port) and
 * hands out dist/kiln.js, dist/kiln-editor.js and dist/kiln-features.js in
 * place of whatever copies the folder holds, so the video always shows the
 * editor built from this checkout. The site must be in try-out mode
 * (`sandbox: true` in its kiln-config.js): nothing is published anywhere, and
 * every request that is not to the local server is blocked.
 *
 * The output folder must be outside this repository: videos are not source.
 *
 * Needs ffmpeg on the PATH (with libx264 and libvpx-vp9), and Playwright with
 * its Chromium. Playwright is not a dependency of this repo: point
 * PLAYWRIGHT_DIR at an installed copy of the `playwright` package. Not part of
 * `npm test` or CI. Exits non-zero if a cut is the wrong length, too large, or
 * has a blank frame.
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, existsSync, readFileSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLAYWRIGHT_DIR = process.env.PLAYWRIGHT_DIR || 'playwright';
const WORDS = ' Zero itchy tags.';          // the three words typed onto the end of the headline
const MAX_MP4 = 2.5 * 1024 * 1024;
// `headingTop` is where the headline is put on screen before it is edited. The
// card that follows a publish sits in the middle of the screen: on the phone
// the headline goes above it, on the desktop below it, so the words that were
// just typed stay in view to the end. The phone gets there with a scroll the
// viewer sees; the desktop cut opens already in place, so its first frame
// shows the whole headline.
const CUTS = {
  phone: { width: 390, height: 844, touch: true, headingTop: 104, scrollOnCamera: true },
  desktop: { width: 1280, height: 800, touch: false, headingTop: 564, scrollOnCamera: false },
};

// ─── arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1]; };
const valued = new Set(['site', 'out', 'port', 'only']);
const URL_ARG = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && valued.has(argv[i - 1].slice(2))));
const SITE = opt('site');
const OUT = opt('out');
const PORT = Number(opt('port') || 8774);
const ONLY = opt('only');
function stop(message, code = 2) { console.error(`demo-video: ${message}`); process.exit(code); }
if ((!URL_ARG && !SITE) || !OUT || (ONLY && !CUTS[ONLY])) {
  stop('usage: node scripts/demo-video.mjs (--site <folder> | <url of a locally served try-out site>) --out <folder> [--only phone|desktop] [--port 8774]');
}
const outDir = path.resolve(OUT);
if (outDir === ROOT || outDir.startsWith(ROOT + path.sep)) stop(`${OUT} is inside this repository. Videos are not source: name a folder outside it.`);
if (SITE && !existsSync(path.join(SITE, 'index.html'))) stop(`${SITE} has no index.html: --site takes the folder the demo site is served from.`);
const ffmpegOk = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
if (ffmpegOk.status !== 0 || !/libx264/.test(ffmpegOk.stdout) || !/libvpx-vp9/.test(ffmpegOk.stdout)) stop('ffmpeg with libx264 and libvpx-vp9 is needed on the PATH.');
let chromium;
try { ({ chromium } = createRequire(import.meta.url)(PLAYWRIGHT_DIR)); } catch (err) {
  stop(`could not load Playwright from ${PLAYWRIGHT_DIR}\n  set PLAYWRIGHT_DIR to an installed "playwright" package directory\n  (${err.message})`);
}

// ─── the site, served from its folder with this checkout's editor ────────────

const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf' };
const BUNDLES = ['kiln.js', 'kiln-editor.js', 'kiln-features.js'];

function serve(folder) {
  const base = path.resolve(folder);
  const server = createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    let file = path.join(base, rel);
    if (file !== base && !file.startsWith(base + path.sep)) { res.writeHead(403).end(); return; }
    // The editor on screen is the one built from this checkout.
    if (BUNDLES.includes(path.basename(file))) file = path.join(ROOT, 'dist', path.basename(file));
    else if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    else if (!existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`;
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', (err) => reject(new Error(err.code === 'EADDRINUSE' ? `port ${PORT} is in use: stop what holds it, or pass --port` : err.message)));
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

// ─── what a headless browser does not draw: the pointer, and the finger ──────

/** Runs in the page before anything else. Kept out of the editor's way: no pointer events, not inside <body>. */
function drawPointer(touch) {
  const NS = 'http://www.w3.org/2000/svg';
  let el = null;
  const make = () => {
    if (el || !document.documentElement) return;
    el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;will-change:transform,opacity;';
    if (touch) {
      el.style.cssText += 'box-sizing:border-box;width:50px;height:50px;margin:-25px 0 0 -25px;border-radius:50%;background:rgba(24,24,36,.38);border:2.5px solid rgba(255,255,255,.95);box-shadow:0 0 0 1.5px rgba(24,24,36,.45),0 3px 12px rgba(0,0,0,.35);opacity:0;transition:opacity .3s ease,width .3s ease,height .3s ease,margin .3s ease;';
    } else {
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('width', '30'); svg.setAttribute('height', '30'); svg.setAttribute('viewBox', '0 0 24 24');
      svg.style.cssText = 'display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));transition:transform .08s ease;transform-origin:4px 3px;';
      const arrow = document.createElementNS(NS, 'path');
      arrow.setAttribute('d', 'M4 3 L4 19.5 L8.6 15.4 L11.6 22 L14.3 20.8 L11.3 14.3 L17.5 14.3 Z');
      arrow.setAttribute('fill', '#111'); arrow.setAttribute('stroke', '#fff'); arrow.setAttribute('stroke-width', '1.4'); arrow.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(arrow);
      el.appendChild(svg);
      el.style.cssText += 'margin:-4px 0 0 -5px;transform:translate(-100px,-100px);';
    }
    document.documentElement.appendChild(el);
  };
  // The recorder is handed a frame only when the page's main thread draws one.
  // A fade that runs off that thread (the card after a publish) would be missed
  // while nothing else moves. One pixel in the corner, redrawn every frame,
  // keeps the frames coming.
  let px = null, beats = 0;
  const beat = () => {
    if (!px && document.documentElement) {
      px = document.createElement('i');
      px.setAttribute('aria-hidden', 'true');
      px.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;z-index:2147483647;pointer-events:none;';
      document.documentElement.appendChild(px);
    }
    if (px) px.style.background = (beats++ & 1) ? '#202028' : '#212028';
    requestAnimationFrame(beat);
  };
  requestAnimationFrame(beat);
  if (touch) {
    // Shown by the script a moment before each tap, so the eye gets there first.
    window.__demoFinger = (x, y) => {
      make();
      el.style.transition = 'none';
      el.style.width = '50px'; el.style.height = '50px'; el.style.margin = '-25px 0 0 -25px';
      el.style.transform = `translate(${x}px,${y}px)`;
      el.style.opacity = '1';
      void el.offsetWidth;
      el.style.transition = '';
    };
    window.__demoLift = () => { if (!el) return; el.style.width = '72px'; el.style.height = '72px'; el.style.margin = '-36px 0 0 -36px'; el.style.opacity = '0'; };
  } else {
    addEventListener('mousemove', (e) => { make(); el.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
    addEventListener('mousedown', () => { if (el) el.firstChild.style.transform = 'scale(.82)'; }, true);
    addEventListener('mouseup', () => { if (el) el.firstChild.style.transform = ''; }, true);
  }
}

// ─── one cut ─────────────────────────────────────────────────────────────────

const sleep = (page, ms) => page.waitForTimeout(ms);
const centre = async (locator) => { const b = await locator.boundingBox(); if (!b) throw new Error('not on screen'); return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b }; };

async function record(browser, name, url, rawDir) {
  const cut = CUTS[name];
  const origin = new URL(url).origin;
  const context = await browser.newContext({
    viewport: { width: cut.width, height: cut.height }, deviceScaleFactor: 1, isMobile: cut.touch, hasTouch: cut.touch,
    reducedMotion: 'no-preference', recordVideo: { dir: rawDir, size: { width: cut.width, height: cut.height } },
  });
  const blocked = [];
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(origin) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    blocked.push(u);
    return route.abort();
  });
  await context.addInitScript(drawPointer, cut.touch);
  const began = Date.now();                       // the recording starts with the page
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const at = () => (Date.now() - began) / 1000;
  const marks = [];
  const mark = (what) => marks.push([what, at()]);

  // The pointer: glides between targets on the desktop, a dot under the finger on the phone.
  let pos = { x: cut.width * 0.62, y: cut.height * 0.42 };
  const glide = async (to, ms = 520) => {
    const steps = Math.max(10, Math.round(ms / 16));
    const from = pos;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, e = t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
      await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
      await sleep(page, ms / steps);
    }
    pos = to;
  };
  const press = async (locator, { lead = 520 } = {}) => {
    const c = await centre(locator);
    if (cut.touch) {
      await page.evaluate(([x, y]) => window.__demoFinger(x, y), [c.x, c.y]);
      await sleep(page, 320);
      await page.touchscreen.tap(c.x, c.y);
      await page.evaluate(() => window.__demoLift());
    } else {
      await glide({ x: c.x, y: c.y }, lead);
      await sleep(page, 140);
      await page.mouse.down();
      await sleep(page, 70);
      await page.mouse.up();
    }
  };

  await page.goto(url, { waitUntil: 'load' });
  await page.locator('#kiln-fab').waitFor({ state: 'visible', timeout: 15000 });
  if (!(await page.evaluate(() => window.KILN && window.KILN.sandbox === true))) throw new Error('the site is not in try-out mode (sandbox: true in its kiln-config.js)');
  const heading = page.locator('h1.kiln-field, h2.kiln-field, h3.kiln-field').first();
  const before = (await heading.innerText()).replace(/\s+/g, ' ').trim();
  await page.evaluate(() => document.fonts && document.fonts.ready);
  // Everything in view has arrived before the cut begins: no half-drawn first frame.
  await page.waitForFunction(() => [...document.images].filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }).every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 }).catch(() => {});
  await page.locator('#kiln-guide').waitFor({ state: 'visible', timeout: 5000 });
  const lift = await heading.evaluate((el, top) => Math.round(el.getBoundingClientRect().top - top), cut.headingTop);
  if (!cut.scrollOnCamera && lift > 0) await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'instant' }), lift);
  if (!cut.touch) await page.mouse.move(pos.x, pos.y);
  await sleep(page, 450);

  // ── arrive ─────────────────────────────────────────────────────────────────
  const start = at();
  mark('arrive');
  await sleep(page, cut.scrollOnCamera ? 1000 : 1400);
  if (cut.scrollOnCamera && lift > 0) {
    // Down to the headline, eased, the way a thumb would.
    const n = 26;
    let done = 0;
    for (let i = 1; i <= n; i++) {
      const t = i / n, e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
      const to = Math.round(lift * e);
      await page.mouse.wheel(0, to - done);
      done = to;
      await sleep(page, 22);
    }
    await sleep(page, 500);
  }

  // ── click the headline, type three words ───────────────────────────────────
  mark('click the headline');
  await press(heading, { lead: 620 });
  await page.locator('#kiln-toolbar').waitFor({ state: 'visible', timeout: 5000 });
  await sleep(page, 550);
  mark('type');
  for (const ch of WORDS) { await page.keyboard.type(ch); await sleep(page, ch === ' ' ? 110 : 62); }
  await sleep(page, 600);
  await press(page.locator('#kiln-toolbar .kiln-tb-save'), { lead: 420 });
  const publish = page.locator('#kiln-publish-quick');
  await publish.waitFor({ state: 'visible', timeout: 5000 });
  await sleep(page, 900);

  // ── the publish sheet: before and after ────────────────────────────────────
  mark('open the publish sheet');
  await press(publish);
  const go = page.locator('#kiln-pubsheet-go');
  await go.waitFor({ state: 'visible', timeout: 5000 });
  await sleep(page, 2600);                        // long enough to read both lines

  // ── publish: "That was a Git commit" ───────────────────────────────────────
  mark('publish');
  await press(go, { lead: 480 });
  const card = page.locator('#kiln-guide-card');
  await card.waitFor({ state: 'visible', timeout: 5000 });
  const said = (await card.locator('h3').innerText()).trim();
  if (said !== 'That was a Git commit') throw new Error(`the card says "${said}"`);
  if (!cut.touch) {                               // off the card it would sit on
    const c = await card.boundingBox();
    await glide({ x: Math.min(cut.width - 60, c.x + c.width + 90), y: c.y + c.height + 6 }, 420);
  }
  await sleep(page, cut.touch ? 3300 : 2900);

  // ── Undo ───────────────────────────────────────────────────────────────────
  mark('undo');
  const undo = page.locator('#kiln-status .kiln-status-act');
  if (!(await undo.count())) throw new Error('the Undo offer was gone before it could be pressed: the pauses add up to more than its ten seconds');
  await press(undo, { lead: 560 });
  await page.waitForFunction(() => /back, not published/.test(document.querySelector('#kiln-guide-card h3')?.textContent || ''), null, { timeout: 5000 });
  if (!cut.touch) await glide({ x: pos.x - 150, y: pos.y - 90 }, 420);   // off the words it would cover
  await sleep(page, 2900);
  mark('end');
  const end = at();

  const after = (await heading.innerText()).replace(/\s+/g, ' ').trim();
  if (after !== `${before}${WORDS}`.replace(/\s+/g, ' ').trim()) throw new Error(`the headline reads "${after}"`);
  if (errors.length) throw new Error(`script errors on the page: ${errors.join(' | ').slice(0, 300)}`);
  if (blocked.length) throw new Error(`the site asked for something outside the local server: ${blocked.slice(0, 3).join(', ')}`);
  const video = page.video();
  const closing = at();
  await context.close();                          // the file is complete once the context is closed
  const raw = await video.path();
  // The recording's clock starts at its first frame, a moment after the page
  // was made. It runs to the close, so the difference is that moment.
  const late = Math.min(1, Math.max(0, closing - seconds(raw)));
  return { raw, start: Math.max(0, start - late), length: end - start, marks: marks.map(([what, t]) => [what, +(t - start).toFixed(1)]) };
}

// ─── encode, and check what came out ─────────────────────────────────────────

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr || '').trim().split('\n').pop()}`);
  return r;
}
const seconds = (file) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim());

function encode(name, shot) {
  const base = path.join(outDir, `kiln-demo-${name}`);
  const trim = ['-ss', shot.start.toFixed(3), '-i', shot.raw, '-t', shot.length.toFixed(3), '-an'];
  // H.264 that every browser and phone plays; smaller steps until it fits.
  let crf = 23;
  for (;;) {
    ffmpeg([...trim, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart', '-r', '25', `${base}.mp4`]);
    if (statSync(`${base}.mp4`).size < MAX_MP4 || crf >= 34) break;
    crf += 2;
  }
  ffmpeg([...trim, '-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-r', '25', `${base}.webm`]);
  ffmpeg(['-ss', '0.8', '-i', `${base}.mp4`, '-frames:v', '1', '-q:v', '3', `${base}-poster.jpg`]);
  // One frame every two seconds (0 s, 2 s, 4 s …), side by side, for a person to look at.
  const frames = Math.floor((Math.round(seconds(`${base}.mp4`) * 25) - 1) / 50) + 1;
  const cols = CUTS[name].touch ? Math.min(frames, 6) : Math.min(frames, 4);
  const w = CUTS[name].touch ? 300 : 480;
  ffmpeg(['-i', `${base}.mp4`, '-vf', `select='not(mod(n,50))',scale=${w}:-2,tile=${cols}x${Math.ceil(frames / cols)}:padding=6:margin=6:color=0x202028`, '-fps_mode', 'vfr', '-frames:v', '1', '-q:v', '3', `${base}-sheet.jpg`]);
  // A blank frame is one with almost no difference between its darkest and lightest parts.
  const stats = spawnSync('ffmpeg', ['-hide_banner', '-i', `${base}.mp4`, '-vf', 'fps=2,signalstats,metadata=print:file=-', '-an', '-f', 'null', '-'], { encoding: 'utf8' }).stdout;
  const low = [...stats.matchAll(/signalstats\.YLOW=(\d+)/g)].map((m) => Number(m[1]));
  const high = [...stats.matchAll(/signalstats\.YHIGH=(\d+)/g)].map((m) => Number(m[1]));
  const blank = high.map((h, i) => h - low[i]).filter((spread) => spread < 12).length;
  return { base, crf, mp4: statSync(`${base}.mp4`).size, webm: statSync(`${base}.webm`).size, poster: statSync(`${base}-poster.jpg`).size, duration: seconds(`${base}.mp4`), sampled: high.length, blank };
}

// ─── main ────────────────────────────────────────────────────────────────────

const server = SITE ? await serve(SITE).catch((err) => stop(err.message)) : null;
mkdirSync(outDir, { recursive: true });
const rawDir = mkdtempSync(path.join(tmpdir(), 'kiln-demo-video-'));
const url = SITE ? `http://127.0.0.1:${PORT}/` : URL_ARG;
const stamp = (() => { try { return readFileSync(path.join(ROOT, 'dist', 'VERSION'), 'utf8').trim(); } catch { return 'unknown'; } })();
let failed = 0;
const browser = await chromium.launch();
try {
  for (const name of Object.keys(CUTS).filter((n) => !ONLY || n === ONLY)) {
    const shot = await record(browser, name, url, rawDir);
    const made = encode(name, shot);
    const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
    console.log(`${name}  ${CUTS[name].width}x${CUTS[name].height}  ${made.duration.toFixed(1)} s  mp4 ${kb(made.mp4)} (crf ${made.crf})  webm ${kb(made.webm)}  poster ${kb(made.poster)}`);
    console.log(`  ${shot.marks.map(([what, t]) => `${t}s ${what}`).join(' · ')}`);
    const wrong = [];
    if (made.duration < 15 || made.duration > 25) wrong.push(`it runs ${made.duration.toFixed(1)} s, outside 15 to 25`);
    if (made.mp4 >= MAX_MP4) wrong.push(`the mp4 is ${kb(made.mp4)}, over 2.5 MB`);
    if (made.blank || !made.sampled) wrong.push(`${made.blank} of ${made.sampled} sampled frames are blank`);
    for (const w of wrong) { failed++; console.log(`  FAIL  ${w}`); }
    if (!wrong.length) console.log(`  ok    ${made.sampled} frames sampled, none blank. Now look at ${path.basename(made.base)}-sheet.jpg`);
  }
} catch (err) {
  failed++;
  console.error(`demo-video: ${err.message}`);
} finally {
  await browser.close();
  if (server) await new Promise((done) => server.close(done));
  rmSync(rawDir, { recursive: true, force: true });
}
console.log(failed ? `\ndemo-video: ${failed} problem${failed === 1 ? '' : 's'}` : `\ndemo-video: wrote the cuts to ${outDir} (editor build ${stamp})`);
process.exit(failed ? 1 : 0);
