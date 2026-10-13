import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CiqError } from '../src/errors.js';
import { createServer, formatElement, formatMenu, menuRefusal } from '../src/server.js';

/** A server whose SDK lookup fails, as on a machine without Connect IQ. */
async function connect() {
  const missing = async () => {
    throw new CiqError('sdk_not_found', 'No Connect IQ SDK is installed.', { hint: 'Install one.' });
  };
  const server = createServer({ sdk: missing, simulator: missing, session: missing, shutdown: async () => {} });
  const client = new Client({ name: 'test', version: '0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, server };
}

test('exposes the documented tools with descriptions and schemas', async () => {
  const { client, server } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      'build_app', 'dialog_action', 'dialog_click', 'dialog_type', 'get_logs', 'inspect_dialogs', 'list_devices', 'list_menu', 'long_press', 'press_button',
      'run_app', 'run_on_devices', 'run_steps', 'run_tests', 'screenshot', 'select_menu', 'set_position', 'simulator_status',
      'start_simulator', 'stop_app', 'stop_simulator', 'swipe', 'tap', 'tap_text', 'wait_for',
    ],
  );
  for (const tool of tools) {
    assert.ok((tool.description ?? '').length > 30, `${tool.name} has a description`);
    assert.equal(tool.inputSchema.type, 'object');
  }
  assert.equal(tools.find((tool) => tool.name === 'screenshot')?.annotations?.readOnlyHint, true);
  assert.equal(tools.find((tool) => tool.name === 'tap')?.annotations?.readOnlyHint, false);
  await server.close();
});

test('failures come back as tool errors with a code and a hint', async () => {
  const { client, server } = await connect();
  const result = /** @type {any} */ (await client.callTool({ name: 'list_devices', arguments: {} }));
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), { error: { code: 'sdk_not_found', message: 'No Connect IQ SDK is installed.', hint: 'Install one.' } });
  await server.close();
});

test('invalid arguments are rejected before the tool runs', async () => {
  const { client, server } = await connect();
  const result = /** @type {any} */ (await client.callTool({ name: 'tap', arguments: { x: 'left', y: 1 } }).catch((error) => ({ isError: true, content: [{ text: String(error) }] })));
  assert.equal(result.isError, true);
  await server.close();
});

test('run_steps validates each step, stops at the first failure and reports it', async () => {
  const { client, server } = await connect();
  const call = async (/** @type {any[]} */ steps) => {
    const result = /** @type {any} */ (await client.callTool({ name: 'run_steps', arguments: { steps } }));
    return { isError: result.isError, body: JSON.parse(result.content[0].text) };
  };
  const nested = await call([{ tool: 'run_steps', args: { steps: [] } }]);
  assert.equal(nested.isError, true);
  assert.match(nested.body.steps[0].result.error.message, /cannot be used as a step/);

  const invalid = await call([{ tool: 'tap', args: { x: 'left' } }, { tool: 'get_logs' }]);
  assert.equal(invalid.isError, true);
  assert.equal(invalid.body.completed, 0);
  assert.equal(invalid.body.steps.length, 1, 'stops at the first failure');
  assert.equal(invalid.body.steps[0].result.error.code, 'bad_arguments');

  const failing = await call([{ tool: 'list_devices', args: {} }]);
  assert.equal(failing.body.steps[0].result.error.code, 'sdk_not_found');
  await server.close();
});

test('select_menu refuses the save panel item and points at screenshot', async () => {
  const { client, server } = await connect();
  const result = /** @type {any} */ (await client.callTool({ name: 'select_menu', arguments: { path: ['File', ' save screen capture'] } }));
  assert.equal(result.isError, true);
  const { error } = JSON.parse(result.content[0].text);
  assert.equal(error.code, 'use_screenshot');
  assert.match(error.hint, /savePath/);
  await server.close();
});

test('formatMenu and formatElement are compact', () => {
  const menu = [{ title: 'Settings', enabled: true, items: [{ title: 'Tones', enabled: true, checked: true }, { title: 'Night Mode', enabled: false }] }];
  assert.deepEqual(formatMenu(menu), ['Settings', '  [x] Tones', '  Night Mode (disabled)']);
  assert.equal(formatElement({ id: '0', role: 'AXTextField', value: '50.0', settable: true, actions: ['AXConfirm'] }), '0 TextField = "50.0" settable [AXConfirm]');
  assert.equal(formatElement({ id: '11', role: 'AXButton', title: 'OK', actions: ['AXPress'] }), '11 Button "OK" [AXPress]');
});

test('menuRefusal keeps select_menu inside the simulator', () => {
  assert.equal(menuRefusal(['File', 'Save Screen Capture'])?.code, 'use_screenshot');
  assert.equal(menuRefusal([' file ', 'save screen capture'])?.code, 'use_screenshot');
  assert.equal(menuRefusal(['Connect IQ Device Simulator', 'Services', 'Send to Claude'])?.code, 'menu_refused');
  assert.equal(menuRefusal(['Connect IQ Device Simulator', 'Hide Others'])?.code, 'menu_refused');
  assert.equal(menuRefusal(['Window', 'Bring All to Front'])?.code, 'menu_refused');
  assert.equal(menuRefusal(['File', 'Edit Persistent Storage', 'Edit Application.Properties data'])?.code, 'needs_person');
  assert.equal(menuRefusal(['File', 'Edit Persistent Storage', 'Edit Application.Storage data']), undefined);
  assert.equal(menuRefusal(['File', 'Reset All App Data']), undefined);
  assert.equal(menuRefusal(['Settings', 'Connection Type', 'BLE', 'Not Connected']), undefined);
  assert.equal(menuRefusal(['Simulation', 'Activity Data']), undefined);
});

test('select_menu refuses before touching the simulator', async () => {
  const { client } = await connect();
  const result = await client.callTool({ name: 'select_menu', arguments: { path: ['Window', 'Arrange in Front'] } });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /menu_refused/);
});

/**
 * A server whose simulator either takes the device in a launch or keeps
 * showing the fēnix 8, as a long-running simulator sometimes does. Time is
 * mocked: each settle advances the clock instead of waiting.
 *
 * @param {(simulatorRun: number) => boolean} takesDevice whether the nth simulator started takes the device
 */
async function runAppWorld(takesDevice) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'ciq-run-app-'));
  const dir = path.join(work, 'devices', 'fenix7');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'compiler.json'), JSON.stringify({ deviceId: 'fenix7', displayName: 'fēnix® 7 / quatix® 7', resolution: { width: 260, height: 260 } }));
  await writeFile(path.join(dir, 'simulator.json'), JSON.stringify({ image: 'fenix7.png', display: { shape: 'round', location: { x: 1, y: 1, width: 260, height: 260 } }, keys: [] }));
  const prg = path.join(work, 'app.prg');
  await writeFile(prg, '');

  const log = { starts: 0, quits: 0 };
  let running = true;
  let run = 1;
  let shown = 'fēnix® 8 43mm';
  let state = 'idle';
  const simulator = {
    ensureRunning: async () => {
      const started = !running;
      if (started) run += 1;
      running = true;
      return { started, pid: run };
    },
    exclusive: (/** @type {() => any} */ fn) => fn(),
    status: async () => ({ simulator: running ? { windows: [{ kind: 'device', title: `CIQ Simulator - ${shown} (5.2.0)` }] } : undefined }),
    quit: async () => {
      log.quits += 1;
      running = false;
      return true;
    },
  };
  const session = {
    get state() {
      return state;
    },
    start: async () => {
      log.starts += 1;
      state = 'running';
      if (takesDevice(run)) shown = 'fēnix® 7 / quatix® 7';
    },
    settle: async (/** @type {number} */ ms) => {
      mock.timers.tick(ms);
      return state;
    },
    assertLaunched: () => {},
    detach: async () => {},
    info: () => ({ state }),
    logs: () => ({ lines: [] }),
  };
  const server = createServer({
    sdk: async () => /** @type {any} */ ({ devicesDir: path.join(work, 'devices') }),
    simulator: async () => /** @type {any} */ (simulator),
    session: async () => /** @type {any} */ (session),
    shutdown: async () => {},
  });
  const client = new Client({ name: 'test', version: '0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async () => {
    const result = /** @type {any} */ (await client.callTool({ name: 'run_app', arguments: { prg, device: 'fenix7', screenshot: false } }));
    return { isError: result.isError, body: JSON.parse(result.content[0].text) };
  };
  const close = async () => {
    await server.close();
    await rm(work, { recursive: true, force: true });
  };
  return { call, log, close };
}

test('run_app restarts a simulator that keeps showing the old device', async () => {
  mock.timers.enable({ apis: ['Date'] });
  const world = await runAppWorld((run) => run > 1);
  try {
    const { isError, body } = await world.call();
    assert.equal(isError, undefined);
    assert.match(body.simulatorRestarted, /fēnix® 8 43mm/);
    assert.equal(body.simulatorStarted, true);
    assert.deepEqual(world.log, { starts: 2, quits: 1 });
  } finally {
    mock.timers.reset();
    await world.close();
  }
});

test('run_app does not restart a simulator that takes the device', async () => {
  mock.timers.enable({ apis: ['Date'] });
  const world = await runAppWorld(() => true);
  try {
    const { isError, body } = await world.call();
    assert.equal(isError, undefined);
    assert.equal(body.simulatorRestarted, undefined);
    assert.deepEqual(world.log, { starts: 1, quits: 0 });
  } finally {
    mock.timers.reset();
    await world.close();
  }
});

test('run_app reports device_not_shown rather than the old device', async () => {
  mock.timers.enable({ apis: ['Date'] });
  const world = await runAppWorld(() => false);
  try {
    const { isError, body } = await world.call();
    assert.equal(isError, true);
    assert.equal(body.error.code, 'device_not_shown');
    assert.deepEqual(world.log, { starts: 2, quits: 1 });
  } finally {
    mock.timers.reset();
    await world.close();
  }
});
