import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Simulator, swipeEndpoints, swipeSteps } from '../src/simulator.js';

const display = { width: 416, height: 416 };

test('swipeSteps presses, glides and releases at the end point', () => {
  const steps = swipeSteps({ x: 10, y: 200 }, { x: 210, y: 200 }, 160);
  assert.deepEqual(steps[0], { op: 'down', x: 10, y: 200 });
  assert.deepEqual(steps.at(-1), { op: 'up', x: 210, y: 200 });
  const waited = steps.reduce((sum, step) => sum + (step.op === 'wait' ? step.ms : 0), 0);
  assert.equal(waited, 160);
  const moves = steps.filter((step) => step.op === 'move');
  assert.equal(moves.length, 8);
  assert.deepEqual(moves.at(-1), { op: 'move', x: 210, y: 200 });
});

test('swipeEndpoints stays on screen and moves the way the finger does', () => {
  for (const direction of /** @type {const} */ (['up', 'down', 'left', 'right'])) {
    const { from, to } = swipeEndpoints(display, direction);
    for (const point of [from, to]) {
      assert.ok(point.x >= 0 && point.x < 416 && point.y >= 0 && point.y < 416, `${direction} in bounds`);
    }
  }
  const up = swipeEndpoints(display, 'up');
  assert.ok(up.to.y < up.from.y);
  const right = swipeEndpoints(display, 'right');
  assert.ok(right.to.x > right.from.x);
  assert.ok(right.from.x < 81, 'back swipe starts near the left edge');
  assert.throws(() => swipeEndpoints(display, /** @type {any} */ ('sideways')), { code: 'bad_arguments' });
});

test('checkPoint rejects points off the screen', () => {
  const device = /** @type {any} */ ({ name: 'Test', display });
  Simulator.checkPoint(device, 0, 0);
  Simulator.checkPoint(device, 415, 415);
  assert.throws(() => Simulator.checkPoint(device, 416, 10), { code: 'point_outside_screen' });
  assert.throws(() => Simulator.checkPoint(device, -1, 10), { code: 'point_outside_screen' });
  assert.throws(() => Simulator.checkPoint(device, Number.NaN, 10), { code: 'point_outside_screen' });
});

test('exclusive runs tasks one at a time, in order, even after a failure', async () => {
  const simulator = new Simulator({ sdk: /** @type {any} */ ({}) });
  /** @type {string[]} */
  const events = [];
  const task = (/** @type {string} */ name, /** @type {number} */ ms, fail = false) => async () => {
    events.push(`start ${name}`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    events.push(`end ${name}`);
    if (fail) throw new Error(name);
    return name;
  };
  const results = await Promise.allSettled([simulator.exclusive(task('a', 30)), simulator.exclusive(task('b', 5, true)), simulator.exclusive(task('c', 1))]);
  assert.deepEqual(events, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
});
