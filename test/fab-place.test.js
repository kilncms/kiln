import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fabSpot, isHiddenBox, headerBand } from '../src/editor/fab-place.js';

const screen = { w: 1440, h: 900 };

test('a hidden button (empty box at 0,0) is not a position to clamp and save', () => {
  assert.equal(isHiddenBox({ left: 0, top: 0, width: 0, height: 0 }), true);
  assert.equal(isHiddenBox({ left: 1300, top: 800, width: 120, height: 48 }), false);
});

test('the old clamp of an empty box (8,8) sends the button back to its corner', () => {
  assert.equal(fabSpot({ x: 8, y: 8 }, screen), null);
});

test('no spot in the header band: the top of the screen is the site\'s', () => {
  assert.equal(fabSpot({ x: 700, y: headerBand(900) - 1 }, screen), null);
  assert.deepEqual(fabSpot({ x: 700, y: headerBand(900) }, screen), { x: 700, y: 180 });
});

test('a spot lower down stays where the person put it', () => {
  assert.deepEqual(fabSpot({ x: 40, y: 600 }, screen), { x: 40, y: 600 });
});

test('saved on a bigger screen: it keeps its distance from the bottom-right edges', () => {
  assert.deepEqual(fabSpot({ x: 1800, y: 1000, w: 1920, h: 1080 }, { w: 1280, h: 720 }), { x: 1160, y: 640 });
});

test('off screen after a resize: brought back inside, never above the band', () => {
  assert.deepEqual(fabSpot({ x: 2000, y: 2000 }, screen), { x: 1384, y: 844 });
  assert.equal(fabSpot({ x: 'a', y: 3 }, screen), null);
  assert.equal(fabSpot(null, screen), null);
});
