/**
 * Leaving the page while a save is being sent asks first (src/editor/sending.js).
 *
 * A tester closed the tab while "Save to all pages" was writing its pages. The
 * save was lost and nothing had warned them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { makeSending, asksBeforeLeaving } from '../src/editor/sending.js';

const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
const between = (from, to) => main.slice(main.indexOf(from), main.indexOf(to, main.indexOf(from)));

test('sending: nothing is being sent until a save starts, and nothing once it has ended', () => {
  const sending = makeSending();
  assert.equal(sending.any, false);
  const done = sending.start();
  assert.equal(sending.any, true);
  assert.equal(sending.count, 1);
  done();
  assert.equal(sending.any, false);
  // Ending the same save twice ends it once: the count never goes below nothing.
  done();
  assert.equal(sending.count, 0);
  const again = sending.start();
  assert.equal(sending.count, 1, 'a second end of the first save did not eat the next one');
  again();
  assert.equal(sending.any, false);
});

test('sending: overlapping saves are counted, and the first to finish does not say nothing is being sent', async () => {
  const sending = makeSending();
  let endMenu, endPublish;
  const menu = sending.during(() => new Promise((resolve) => { endMenu = resolve; }));
  const publish = sending.during(() => new Promise((resolve) => { endPublish = resolve; }));
  assert.equal(sending.count, 2);
  endPublish('published');
  assert.equal(await publish, 'published');
  assert.equal(sending.any, true, 'the menu is still being saved');
  endMenu('saved');
  assert.equal(await menu, 'saved');
  assert.equal(sending.any, false);
});

test('sending: a save that fails has ended too, and its failure still reaches whoever asked', async () => {
  const sending = makeSending();
  let fail;
  const lost = sending.during(() => new Promise((_, reject) => { fail = reject; }));
  const kept = sending.during(async () => 'ok');
  assert.equal(sending.any, true);
  fail(new Error('the service did not answer'));
  await assert.rejects(lost, /the service did not answer/);
  assert.equal(await kept, 'ok');
  assert.equal(sending.any, false);
  // One that throws before it sends anything.
  await assert.rejects(sending.during(() => { throw new Error('nothing to save'); }), /nothing to save/);
  assert.equal(sending.count, 0);
});

test('sending: leaving asks while something is being sent or unpublished, and at no other time', () => {
  assert.equal(asksBeforeLeaving({}), false);
  assert.equal(asksBeforeLeaving(), false);
  assert.equal(asksBeforeLeaving({ sending: true }), true, 'the fault: a save on its way, with no edit on the page');
  assert.equal(asksBeforeLeaving({ unpublished: true }), true, 'as before');
  assert.equal(asksBeforeLeaving({ unpublished: true, sending: true }), true);
  // Leaving to sign in again was chosen in a dialog that said what is kept: never asked, as before.
  assert.equal(asksBeforeLeaving({ toSignIn: true, unpublished: true }), false);
  assert.equal(asksBeforeLeaving({ toSignIn: true, sending: true }), false);
});

test('sending: the editor counts the menu save and every publish, and asks from the one place it always asked', () => {
  // One listener in the whole editor, and it decides with asksBeforeLeaving.
  const dir = new URL('../src/editor/', import.meta.url);
  const listeners = readdirSync(dir).filter(f => f.endsWith('.js'))
    .reduce((n, f) => n + (readFileSync(new URL(f, dir), 'utf8').match(/addEventListener\('beforeunload'/g) || []).length, 0);
  assert.equal(listeners, 1);
  const leave = between("window.addEventListener('beforeunload'", '\n  });');
  assert.ok(leave.includes('asksBeforeLeaving({ toSignIn: leavingToSignIn, unpublished, sending: state.sending.any })'));
  assert.match(leave, /const unpublished = !!\(state\.pending\.size \|\| state\.pendingBinaries\.size \|\| state\.pendingStructural\.length\s+\|\| state\.pendingSource\.size\);/);
  // The count is part of `state`, which is made above the line that starts the editor.
  assert.ok(main.indexOf('sending: makeSending(),') > 0 && main.indexOf('sending: makeSending(),') < main.indexOf('\ninit().catch('));
  // The demo sends nothing, so it is not counted.
  assert.ok(between('function whileSending(work) {', '\n}').includes('return cfg.sandbox ? work() : state.sending.during(work);'));
  // A publish: from the call until it has answered or failed.
  assert.ok(between('async function publish(opts = {}) {', '\n}').includes('return whileSending(() => publishNow(opts));'));
  // "Save to all pages": from the press, before any page is read, until the save has answered or failed.
  const save = between("m.querySelector('#kiln-menu-save').onclick", 'const thisPage =');
  assert.ok(save.indexOf('const sent = state.sending.start();') > 0);
  assert.ok(save.indexOf('const sent = state.sending.start();') < save.indexOf('await saveMenuEverywhere({'));
  assert.ok(save.includes('}).finally(sent);'));
  // Nothing is counted in the demo, which returns before the count starts.
  assert.ok(save.indexOf("if (cfg.sandbox) { status.textContent = demoSays('menu'); return; }") < save.indexOf('const sent = state.sending.start();'));
});
