import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { describeButtons, deviceNameFromTitle, listDevices, loadDevice, parseDevice, resolveButton } from '../src/devices.js';

const compiler = { deviceId: 'fenix843mm', displayName: 'fēnix® 8 43mm', resolution: { width: 416, height: 416 }, deviceFamily: 'round-416x416' };
const simulator = {
  image: 'fenix843mm.png',
  display: {
    isTouch: true,
    shape: 'round',
    location: { x: 96, y: 196, width: 416, height: 416 },
    behaviors: [{ gesture: 'swipeRight', id: 'onBack', maxSwipeDuration: 250, minSwipeDeltaX: 83, minSwipeDeltaY: 83 }, { gesture: 'tap', id: 'onSelect' }],
  },
  keys: [
    { id: 'enter', behavior: 'onSelect', location: { x: 512, y: 222, width: 80, height: 77 } },
    { id: 'up', behavior: 'previousPage', location: { x: 0, y: 350, width: 55, height: 107 } },
    { id: 'menu', behavior: 'onMenu', isHold: true, location: { x: 0, y: 350, width: 55, height: 107 } },
    { id: 'down', behavior: 'nextPage', location: { x: 22, y: 486, width: 66, height: 102 } },
    { id: 'esc', behavior: 'onBack', location: { x: 521, y: 495, width: 65, height: 89 } },
    { id: 'broken' },
  ],
};

/** @type {string} */
let dir;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ciq-devices-'));
  await mkdir(path.join(dir, 'fenix843mm'));
  await writeFile(path.join(dir, 'fenix843mm', 'compiler.json'), JSON.stringify(compiler));
  await writeFile(path.join(dir, 'fenix843mm', 'simulator.json'), JSON.stringify(simulator));
  await mkdir(path.join(dir, 'half-downloaded'));
  await writeFile(path.join(dir, 'half-downloaded', 'compiler.json'), '{');
});
after(() => rm(dir, { recursive: true, force: true }));

test('parseDevice reads the display and skips malformed keys', () => {
  const device = parseDevice('fenix843mm', '/devices/fenix843mm', compiler, simulator);
  assert.equal(device.name, 'fēnix® 8 43mm');
  assert.deepEqual(device.display, { x: 96, y: 196, width: 416, height: 416, shape: 'round', touch: true });
  assert.equal(device.imagePath, '/devices/fenix843mm/fenix843mm.png');
  assert.equal(device.buttons.length, 5);
  assert.deepEqual(device.gestures, { maxSwipeDurationMs: 250, minSwipeDistance: 83 });
});

test('parseDevice rejects a device without a display', () => {
  assert.throws(() => parseDevice('x', '/d/x', {}, { display: {} }), { code: 'unsupported_device' });
});

test('resolveButton accepts key ids, behaviours and friendly names', () => {
  const device = parseDevice('fenix843mm', '/d', compiler, simulator);
  assert.equal(resolveButton(device, 'enter').id, 'enter');
  assert.equal(resolveButton(device, 'ESC').id, 'esc');
  assert.equal(resolveButton(device, 'select').id, 'enter');
  assert.equal(resolveButton(device, 'back').id, 'esc');
  assert.equal(resolveButton(device, 'next').id, 'down');
  assert.equal(resolveButton(device, 'previous').id, 'up');
  assert.equal(resolveButton(device, 'onBack').id, 'esc');
  assert.equal(resolveButton(device, 'next page').id, 'down');
  const menu = resolveButton(device, 'menu');
  assert.equal(menu.id, 'menu');
  assert.equal(menu.hold, true);
});

test('resolveButton explains what is available', () => {
  const device = parseDevice('fenix843mm', '/d', compiler, simulator);
  assert.throws(
    () => resolveButton(device, 'lap'),
    (/** @type {any} */ error) => error.code === 'unknown_button' && error.details.available.length === 5,
  );
  assert.deepEqual(describeButtons(device)[2], { id: 'menu', behavior: 'onMenu', hold: true });
});

test('deviceNameFromTitle strips the prefix and the version', () => {
  assert.equal(deviceNameFromTitle('CIQ Simulator - fēnix® 8 43mm (6.0.3)'), 'fēnix® 8 43mm');
  assert.equal(deviceNameFromTitle('CIQ Simulator - Venu® 3'), 'Venu® 3');
  assert.equal(deviceNameFromTitle('CIQ Simulator - Edge® 1040 (Solar) (5.1.0)'), 'Edge® 1040 (Solar)');
  assert.equal(deviceNameFromTitle('Set current position'), undefined);
  assert.equal(deviceNameFromTitle(''), undefined);
});

test('listDevices ignores unreadable directories', async () => {
  const devices = await listDevices(dir);
  assert.deepEqual(devices, [{ id: 'fenix843mm', name: 'fēnix® 8 43mm', width: 416, height: 416, shape: 'round', touch: true, family: 'round-416x416' }]);
  await assert.rejects(listDevices(path.join(dir, 'missing')), { code: 'devices_not_found' });
});

test('loadDevice validates the id and reports a missing device', async () => {
  assert.equal((await loadDevice(dir, 'fenix843mm')).id, 'fenix843mm');
  await assert.rejects(loadDevice(dir, '../etc'), { code: 'unknown_device' });
  await assert.rejects(loadDevice(dir, 'venu3'), { code: 'unknown_device' });
});
