import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runHelper } from '../src/helper.js';

// Needs macOS and swiftc (the helper is compiled on first use), but no
// simulator and no permissions.
const options = { skip: process.platform !== 'darwin' ? 'macOS only' : false, timeout: 300_000 };

test('status reports permissions and the simulator', options, async () => {
  const status = await runHelper('status');
  assert.equal(typeof status.accessibility, 'boolean');
  assert.equal(typeof status.screenRecording, 'boolean');
  assert.equal(typeof status.screenLocked, 'boolean');
  assert.ok(status.simulator === null || typeof status.simulator.pid === 'number');
});

test('errors carry a code', options, async () => {
  await assert.rejects(runHelper('nonsense'), { code: 'bad_arguments' });
  await assert.rejects(runHelper('capture', { pid: 999_999, out: '/tmp/never.png' }), { code: 'simulator_not_running' });
  await assert.rejects(runHelper('key', { pid: 999_999, steps: [] }), (/** @type {any} */ error) => typeof error.code === 'string');
});
