// The simulator-side flows (finding the device picture, translating input,
// refusing input under a dialog, the locked-screen guards) run against
// test/fixtures/fake-helper.mjs instead of the native helper: no simulator,
// display or permission needed, so this runs anywhere Node does.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const work = await mkdtemp(path.join(os.tmpdir(), 'ciq-flows-'));
const stateFile = path.join(work, 'state.json');
const logFile = path.join(work, 'log.jsonl');
// Before anything imports helper.js: it resolves the helper once per process.
process.env.CIQ_MCP_HELPER = path.join(here, 'fixtures', 'fake-helper.mjs');
process.env.FAKE_HELPER_STATE = stateFile;
process.env.FAKE_HELPER_LOG = logFile;
const { Simulator } = await import('../src/simulator.js');
const { stopHelper } = await import('../src/helper.js');

const devicesDir = path.join(work, 'devices');
const compiler = { deviceId: 'fenix843mm', displayName: 'fēnix® 8 43mm', resolution: { width: 416, height: 416 } };
const simulatorJson = {
  image: 'fenix843mm.png',
  display: { isTouch: true, shape: 'round', location: { x: 96, y: 196, width: 416, height: 416 } },
  keys: [
    { id: 'enter', behavior: 'onSelect', location: { x: 512, y: 222, width: 80, height: 77 } },
    { id: 'menu', behavior: 'onMenu', isHold: true, location: { x: 0, y: 350, width: 55, height: 107 } },
  ],
};
const deviceWindow = { id: 100, kind: 'device', title: 'CIQ Simulator - fēnix® 8 43mm (6.0.3)', x: 0, y: 0, width: 603, height: 900, minimized: false };
const dialog = { id: 200, kind: 'dialog', title: 'Profiler', x: 0, y: 0, width: 1200, height: 600, minimized: false };

/** @param {Record<string, unknown>} world */
const setWorld = (world) => writeFile(stateFile, JSON.stringify({ simulator: { pid: 4242, windows: [deviceWindow] }, ...world }));
const calls = async () =>
  (await readFile(logFile, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const newSimulator = () => new Simulator({ sdk: /** @type {any} */ ({ devicesDir }) });

before(async () => {
  await mkdir(path.join(devicesDir, 'fenix843mm'), { recursive: true });
  await writeFile(path.join(devicesDir, 'fenix843mm', 'compiler.json'), JSON.stringify(compiler));
  await writeFile(path.join(devicesDir, 'fenix843mm', 'simulator.json'), JSON.stringify(simulatorJson));
});
beforeEach(async () => {
  await writeFile(logFile, '');
  await setWorld({});
});
after(async () => {
  stopHelper();
  await rm(work, { recursive: true, force: true });
});

test('a tap lands at the display offset plus the located picture offset', async () => {
  const simulator = newSimulator();
  await simulator.tap({ x: 100, y: 100 });
  const mouse = (await calls()).find((call) => call.command === 'mouse');
  assert.equal(mouse.args.windowId, 100);
  assert.equal(mouse.args.parkPointer, false);
  assert.deepEqual(mouse.args.steps[0], { op: 'down', x: 196, y: 324 });
  assert.deepEqual(mouse.args.steps.at(-1), { op: 'up', x: 196, y: 324 });
});

test('a held button parks the pointer; a short press does not', async () => {
  const simulator = newSimulator();
  assert.deepEqual(await simulator.pressButton({ button: 'menu' }), { button: 'menu', behavior: 'onMenu', held: true });
  assert.deepEqual(await simulator.pressButton({ button: 'select' }), { button: 'enter', behavior: 'onSelect', held: false });
  const [hold, press] = (await calls()).filter((call) => call.command === 'mouse');
  assert.equal(hold.args.parkPointer, true);
  assert.deepEqual(hold.args.steps, [{ op: 'down', x: 27.5, y: 431.5 }, { op: 'wait', ms: 1200 }, { op: 'up', x: 27.5, y: 431.5 }]);
  assert.equal(press.args.parkPointer, false);
  assert.deepEqual(press.args.steps[1], { op: 'wait', ms: 80 });
});

test('the picture is located once per window, and again for a new window', async () => {
  const simulator = newSimulator();
  await simulator.tap({ x: 1, y: 1 });
  await simulator.tap({ x: 2, y: 2 });
  assert.equal((await calls()).filter((call) => call.command === 'locate').length, 1);
  await setWorld({ simulator: { pid: 4242, windows: [{ ...deviceWindow, id: 101 }] } });
  await simulator.tap({ x: 3, y: 3 });
  assert.equal((await calls()).filter((call) => call.command === 'locate').length, 2);
});

test('a picture that is not found at first is retried', async () => {
  await setWorld({ locate: [{ found: false, imageWidth: 603, imageHeight: 800 }, { found: true, offsetX: 0, offsetY: 40, imageWidth: 603, imageHeight: 800 }] });
  await newSimulator().tap({ x: 0, y: 0 });
  const log = await calls();
  assert.equal(log.filter((call) => call.command === 'locate').length, 2);
  assert.deepEqual(log.find((call) => call.command === 'mouse').args.steps[0], { op: 'down', x: 96, y: 236 });
});

test('a picture never found is layout_unknown, after trying a larger window', { timeout: 20_000 }, async () => {
  await setWorld({ locate: [{ found: false, imageWidth: 603, imageHeight: 800, score: 9 }] });
  await assert.rejects(newSimulator().tap({ x: 0, y: 0 }), { code: 'layout_unknown' });
  const log = await calls();
  assert.ok(log.some((call) => call.command === 'window' && call.args.action === 'resize'));
  assert.equal(log.filter((call) => call.command === 'mouse').length, 0);
});

test('a window smaller than the picture is enlarged before input', async () => {
  await setWorld({ simulator: { pid: 4242, windows: [{ ...deviceWindow, height: 500 }] } });
  await newSimulator().tap({ x: 0, y: 0 });
  const resize = (await calls()).find((call) => call.command === 'window' && call.args.action === 'resize');
  assert.deepEqual([resize.args.width, resize.args.height], [603, 28 + 800 + 30]);
});

test('input is refused while a dialog blocks the device', async () => {
  await setWorld({ simulator: { pid: 4242, windows: [dialog, deviceWindow] } });
  await assert.rejects(newSimulator().tap({ x: 10, y: 10 }), (/** @type {any} */ error) => {
    assert.equal(error.code, 'dialog_open');
    assert.deepEqual(error.details.dialogs, [{ id: 200, title: 'Profiler' }]);
    return true;
  });
  assert.equal((await calls()).filter((call) => call.command === 'mouse').length, 0);
});

test('no simulator is simulator_not_running', async () => {
  await setWorld({ simulator: null });
  await assert.rejects(newSimulator().tap({ x: 0, y: 0 }), { code: 'simulator_not_running' });
});

const profilerTexts = { 200: [{ text: 'Load', confidence: 1, x: 1052, y: 550, width: 30, height: 16 }, { text: 'Start', confidence: 1, x: 1138, y: 550, width: 33, height: 16 }] };

test('locked: a dialog click on a file-panel button is refused and not sent', async () => {
  await setWorld({ screenLocked: true, texts: profilerTexts, simulator: { pid: 4242, windows: [dialog, deviceWindow] } });
  await assert.rejects(newSimulator().dialogClick({ windowId: 200, x: 1067, y: 558 }), (/** @type {any} */ error) => {
    assert.equal(error.code, 'opens_file_panel');
    assert.equal(error.details.label, 'Load');
    return true;
  });
  assert.equal((await calls()).filter((call) => call.command === 'mouse').length, 0);
});

test('locked: other dialog clicks go through', async () => {
  await setWorld({ screenLocked: true, texts: profilerTexts, simulator: { pid: 4242, windows: [dialog, deviceWindow] } });
  await newSimulator().dialogClick({ windowId: 200, x: 1154, y: 558 });
  const log = await calls();
  assert.ok(log.some((call) => call.command === 'capture' && call.args.text === true));
  assert.equal(log.filter((call) => call.command === 'mouse').length, 1);
});

test('unlocked: dialog clicks are not read first', async () => {
  await setWorld({ texts: profilerTexts, simulator: { pid: 4242, windows: [dialog, deviceWindow] } });
  await newSimulator().dialogClick({ windowId: 200, x: 1067, y: 558 });
  const log = await calls();
  assert.equal(log.filter((call) => call.command === 'capture').length, 0);
  assert.equal(log.filter((call) => call.command === 'mouse').length, 1);
});

test('locked: a dialog that cannot be read does not hold the click up', async () => {
  await setWorld({ screenLocked: true, fail: { capture: { code: 'capture_failed', message: 'display asleep' } }, simulator: { pid: 4242, windows: [dialog, deviceWindow] } });
  await newSimulator().dialogClick({ windowId: 200, x: 1067, y: 558 });
  assert.equal((await calls()).filter((call) => call.command === 'mouse').length, 1);
});
