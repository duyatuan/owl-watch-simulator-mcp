// High-level control of the Connect IQ simulator: start it, find its window,
// take screenshots, send touches and button presses, drive menus and dialogs.
//
// Coordinates: callers speak in *device screen pixels* (0,0 = top-left of the
// watch's display). This module converts them to points in the simulator
// window, which shows the device picture unscaled under its title bar.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, copyFile, mkdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { deviceNameFromTitle, listDevices, loadDevice, resolveButton } from './devices.js';
import { CiqError } from './errors.js';
import { runHelper } from './helper.js';
import { filePanelLabelAt } from './text.js';

const execFileAsync = promisify(execFile);

/** Ports the simulator's shell server may listen on (it takes the first free one). */
export const SHELL_PORTS = [1234, 1235, 1236, 1237, 1238];

/** How long the simulator needs a key or the screen held before it counts as a hold. */
export const DEFAULT_HOLD_MS = 1200;

/** Presses at least this long are treated as holds (and park the pointer). */
export const HOLD_THRESHOLD_MS = 300;

/**
 * @typedef {import('./devices.js').Device} Device
 * @typedef {{ id: number, title: string, kind: 'device' | 'dialog', inspectable: boolean, minimized: boolean, modal: boolean, x: number, y: number, width: number, height: number }} SimWindow
 * @typedef {{ windowId: number, offsetX: number, offsetY: number, imageWidth: number, imageHeight: number }} Layout
 * @typedef {{ op: 'down' | 'up' | 'move', x: number, y: number } | { op: 'wait', ms: number }} Step
 * @typedef {{ text: string, confidence: number, x: number, y: number, width: number, height: number }} ScreenText
 */

/** @param {number} port */
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (/** @type {boolean} */ open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Screen-pixel steps for a swipe: press, glide, release.
 * @param {{ x: number, y: number }} from
 * @param {{ x: number, y: number }} to
 * @param {number} durationMs
 * @returns {Step[]}
 */
export function swipeSteps(from, to, durationMs) {
  const segments = 8;
  /** @type {Step[]} */
  const steps = [{ op: 'down', ...from }];
  for (let i = 1; i <= segments; i += 1) {
    steps.push({ op: 'wait', ms: durationMs / segments });
    const t = i / segments;
    steps.push({ op: 'move', x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }
  steps.push({ op: 'up', ...to });
  return steps;
}

/**
 * Endpoints of a swipe in a named direction, centred on the screen.
 * "up" means the finger moves up (which shows the next page).
 *
 * @param {{ width: number, height: number }} display
 * @param {'up' | 'down' | 'left' | 'right'} direction
 */
export function swipeEndpoints(display, direction) {
  const cx = Math.round(display.width / 2);
  const cy = Math.round(display.height / 2);
  const dx = Math.round(display.width * 0.3);
  const dy = Math.round(display.height * 0.3);
  switch (direction) {
    case 'up':
      return { from: { x: cx, y: cy + dy }, to: { x: cx, y: cy - dy } };
    case 'down':
      return { from: { x: cx, y: cy - dy }, to: { x: cx, y: cy + dy } };
    case 'left':
      return { from: { x: cx + dx, y: cy }, to: { x: cx - dx, y: cy } };
    // Back gestures must start near the left edge on most devices.
    case 'right':
      return { from: { x: Math.round(display.width * 0.08), y: cy }, to: { x: Math.round(display.width * 0.08) + 2 * dx, y: cy } };
    default:
      throw new CiqError('bad_arguments', `Unknown swipe direction '${direction}'.`);
  }
}

export class Simulator {
  /** @param {{ sdk: import('./sdk.js').Sdk }} options */
  constructor({ sdk }) {
    this.sdk = sdk;
    /** @type {Map<string, Layout>} */
    this.layouts = new Map();
    /** @type {Map<string, Device>} */
    this.devices = new Map();
    /** @type {Map<string, string> | undefined} display name -> device id */
    this.deviceNames = undefined;
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve();
    /** @type {string | undefined} */
    this.tempDir = undefined;
    this.shots = 0;
  }

  /**
   * Runs `task` after every earlier task has finished, so two tool calls can
   * never interleave their mouse events or race a window resize.
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  exclusive(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** @returns {Promise<any>} raw helper status */
  status() {
    return runHelper('status');
  }

  async shellPort() {
    for (const port of SHELL_PORTS) {
      if (await portOpen(port)) return port;
    }
    return undefined;
  }

  /**
   * Starts the simulator if needed, without bringing it to the front.
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ started: boolean, pid: number, port: number }>}
   */
  async ensureRunning({ timeoutMs = 60_000 } = {}) {
    let status = await this.status();
    let started = false;
    if (!status.simulator) {
      try {
        // -g: do not activate. The simulator never needs to be frontmost.
        await execFileAsync('/usr/bin/open', ['-g', '-a', this.sdk.simulatorApp], { timeout: 30_000 });
      } catch (error) {
        throw new CiqError('simulator_start_failed', `Could not launch ${this.sdk.simulatorApp}: ${/** @type {Error} */ (error).message}`);
      }
      started = true;
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (status.simulator) {
        const port = await this.shellPort();
        if (port !== undefined) return { started, pid: status.simulator.pid, port };
      }
      if (Date.now() > deadline) {
        throw new CiqError('simulator_start_timeout', `The simulator did not become ready within ${Math.round(timeoutMs / 1000)} s.`, {
          hint: 'Open it once by hand to dismiss any first-run prompt, then retry.',
        });
      }
      await sleep(400);
      status = await this.status();
    }
  }

  /** Quits the simulator. @returns {Promise<boolean>} whether it was running */
  async quit() {
    const status = await this.status();
    if (!status.simulator) return false;
    const pid = Number(status.simulator.pid);
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return false;
    }
    for (let i = 0; i < 25; i += 1) {
      await sleep(200);
      try {
        process.kill(pid, 0);
      } catch {
        this.layouts.clear();
        return true;
      }
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
    this.layouts.clear();
    return true;
  }

  /**
   * The simulator's state as tools need it: its device window and any dialogs.
   * @returns {Promise<{ status: any, pid: number, window: SimWindow, dialogs: SimWindow[] }>}
   */
  async state() {
    let status = await this.status();
    if (!status.simulator) {
      throw new CiqError('simulator_not_running', 'The Connect IQ simulator is not running.', {
        hint: 'Call run_app (which starts it) or start_simulator.',
      });
    }
    if (status.simulator.hidden) {
      status = { ...status, simulator: { ...status.simulator, ...(await runHelper('window', { action: 'unhide' })) } };
    }
    /** @type {SimWindow[]} */
    const windows = status.simulator.windows;
    const window = windows.find((candidate) => candidate.kind === 'device');
    if (!window) {
      throw new CiqError('window_not_found', 'The simulator has no device window yet.', {
        hint: status.accessibility ? 'Run an app first: the device window opens when an app is launched.' : PERMISSION_HINT,
      });
    }
    return { status, pid: status.simulator.pid, window, dialogs: windows.filter((candidate) => candidate.kind === 'dialog') };
  }

  /**
   * The device the simulator is showing, read from its window title.
   * @param {SimWindow} window
   * @param {string} [expected] device id the caller believes is running
   * @returns {Promise<Device>}
   */
  async deviceFor(window, expected) {
    const name = deviceNameFromTitle(window.title);
    /** @type {string | undefined} */
    let id;
    if (name) {
      if (!this.deviceNames?.has(name)) {
        this.deviceNames = new Map((await listDevices(this.sdk.devicesDir)).map((device) => [device.name, device.id]));
      }
      id = this.deviceNames.get(name);
    }
    // Window titles are only readable with a permission; fall back to what was launched.
    id ??= expected;
    if (!id) {
      throw new CiqError('device_unknown', `Could not tell which device the simulator is showing (window title: '${window.title}').`, {
        hint: 'Launch an app with run_app so the device is known.',
      });
    }
    let device = this.devices.get(id);
    if (!device) {
      device = await loadDevice(this.sdk.devicesDir, id);
      this.devices.set(id, device);
    }
    return device;
  }

  /**
   * Where the device picture sits in the window. Measured once per window and
   * re-measured if the window is replaced (the simulator makes a new one when
   * the device changes).
   *
   * @param {number} pid
   * @param {SimWindow} window
   * @param {Device} device
   * @returns {Promise<{ layout: Layout, window: SimWindow }>}
   */
  async layoutFor(pid, window, device) {
    const key = `${pid}:${window.id}:${device.id}`;
    let current = window;
    if (current.minimized) {
      current = deviceWindowOf(await runHelper('window', { action: 'restore' })) ?? current;
      await sleep(600); // the restore animation
    }
    let layout = this.layouts.get(key);
    if (!layout) {
      const exclude = { x: device.display.x, y: device.display.y, width: device.display.width, height: device.display.height };
      const locate = () => runHelper('locate', { image: device.imagePath, exclude });
      let located = await locate();
      // A window that has only just opened may not have painted the device yet.
      for (let attempt = 0; attempt < 4 && !located.found; attempt += 1) {
        await sleep(500);
        located = await locate();
      }
      if (!located.found) {
        // Otherwise the window was probably resized smaller than the picture:
        // restore a size that shows all of it, then measure again.
        const resized = await this.resize(current, located.imageWidth, located.imageHeight + 80).catch(() => undefined);
        if (resized) {
          current = resized;
          await sleep(300);
          located = await locate();
        }
      }
      if (!located.found) {
        throw new CiqError('layout_unknown', `Could not find the ${device.name} picture in the simulator window.`, {
          hint:
            'The simulator may be showing a different device, or its window was made smaller than the device picture ' +
            '(it cannot be resized for you while the screen is locked). Run the app again with run_app.',
          details: { score: located.score, offsetY: located.offsetY },
        });
      }
      layout = {
        windowId: window.id,
        offsetX: located.offsetX,
        offsetY: located.offsetY,
        imageWidth: located.imageWidth,
        imageHeight: located.imageHeight,
      };
      this.layouts.set(key, layout);
      if (this.layouts.size > 16) this.layouts.delete(this.layouts.keys().next().value ?? key);
    }
    // The simulator clips the picture rather than scaling it, so the window must
    // be at least as large as the picture.
    const neededWidth = layout.offsetX + layout.imageWidth;
    const neededHeight = layout.offsetY + layout.imageHeight;
    const tooSmall = () => current.width < neededWidth || current.height < neededHeight;
    // The simulator sizes a new device window itself, a moment after opening it.
    for (let attempt = 0; attempt < 6 && tooSmall(); attempt += 1) {
      await sleep(400);
      const status = await this.status();
      current = status.simulator?.windows?.find((/** @type {SimWindow} */ candidate) => candidate.id === window.id) ?? current;
    }
    if (tooSmall()) {
      const resized = await this.resize(current, layout.offsetX + layout.imageWidth, layout.offsetY + layout.imageHeight + 30).catch(() => undefined);
      if (!resized) {
        throw new CiqError('window_too_small', 'The simulator window is smaller than the device picture and could not be resized.', {
          hint: 'Unlock the screen and enlarge the simulator window, or restart the simulator.',
        });
      }
      current = resized;
      await sleep(300);
    }
    return { layout, window: current };
  }

  /**
   * @param {SimWindow} window
   * @param {number} minWidth
   * @param {number} minHeight
   */
  async resize(window, minWidth, minHeight) {
    const result = await runHelper('window', {
      action: 'resize',
      width: Math.max(window.width, minWidth),
      height: Math.max(window.height, minHeight),
    });
    return deviceWindowOf(result);
  }

  /**
   * Everything needed to address the screen: device, window and layout.
   * @param {{ expectedDevice?: string }} [options]
   */
  async target({ expectedDevice } = {}) {
    const { status, pid, window, dialogs } = await this.state();
    const device = await this.deviceFor(window, expectedDevice);
    const { layout, window: current } = await this.layoutFor(pid, window, device);
    return { status, pid, window: current, dialogs, device, layout };
  }

  async tempFile() {
    this.tempDir ??= await mkdtemp(path.join(os.tmpdir(), 'connectiq-mcp-'));
    this.shots += 1;
    return path.join(this.tempDir, `shot-${this.shots}.png`);
  }

  async dispose() {
    if (this.tempDir) await rm(this.tempDir, { recursive: true, force: true }).catch(() => undefined);
    this.tempDir = undefined;
  }

  /**
   * @param {{ frame?: 'screen' | 'device' | 'window', scale?: number, savePath?: string, expectedDevice?: string, text?: boolean }} [options]
   * @returns {Promise<{ png: Buffer, width: number, height: number, frame: string, device: string, deviceName: string, savedTo?: string, screenLocked: boolean, dialogs: SimWindow[], texts?: ScreenText[] }>}
   */
  screenshot(options = {}) {
    return this.exclusive(() => this.screenshotNow(options));
  }

  /** @param {{ frame?: 'screen' | 'device' | 'window', scale?: number, savePath?: string, expectedDevice?: string, text?: boolean }} options */
  async screenshotNow({ frame = 'screen', scale = 1, savePath, expectedDevice, text = false }) {
    const { device, layout, dialogs } = await this.target({ expectedDevice });
    const out = await this.tempFile();
    /** @type {Record<string, unknown>} */
    const args = { out, windowId: layout.windowId };
    if (frame === 'screen') {
      args.crop = { x: layout.offsetX + device.display.x, y: layout.offsetY + device.display.y, width: device.display.width, height: device.display.height };
      args.outWidth = Math.round(device.display.width * scale);
      args.outHeight = Math.round(device.display.height * scale);
      if (device.display.shape === 'round') args.mask = 'round';
    } else if (frame === 'device') {
      args.crop = { x: layout.offsetX, y: layout.offsetY, width: layout.imageWidth, height: layout.imageHeight };
      args.outWidth = Math.round(layout.imageWidth * scale);
      args.outHeight = Math.round(layout.imageHeight * scale);
    }
    // Text positions are only meaningful in device pixels, i.e. for the screen.
    const readText = text && frame === 'screen';
    if (readText) args.text = true;
    try {
      // The first recognition in a helper's life loads the model, which is slow.
      const result = await runHelper('capture', args, { timeoutMs: readText ? 120_000 : 20_000 });
      if (result.blank && frame !== 'screen') {
        throw new CiqError('capture_blank', 'The captured window is blank.', { hint: PERMISSION_HINT });
      }
      const png = await readFile(out);
      /** @type {string | undefined} */
      let savedTo;
      if (savePath) {
        savedTo = path.resolve(savePath);
        await mkdir(path.dirname(savedTo), { recursive: true });
        await copyFile(out, savedTo);
      }
      return {
        png,
        width: result.width,
        height: result.height,
        frame,
        device: device.id,
        deviceName: device.name,
        ...(savedTo ? { savedTo } : {}),
        screenLocked: Boolean(result.screenLocked),
        dialogs,
        ...(readText ? { texts: /** @type {ScreenText[]} */ (result.texts ?? []) } : {}),
      };
    } finally {
      await rm(out, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Sends mouse steps given in device screen pixels.
   * @param {(target: { device: Device, layout: Layout }) => { steps: Step[], space: 'screen' | 'device', hold?: boolean }} plan
   * @param {{ expectedDevice?: string }} [options]
   */
  input(plan, { expectedDevice } = {}) {
    return this.exclusive(async () => {
      const { status, device, layout, dialogs } = await this.target({ expectedDevice });
      if (!status.backgroundClicks) {
        throw new CiqError('unsupported_os', 'This macOS release does not support posting clicks to a background window.');
      }
      if (dialogs.length > 0) {
        throw new CiqError('dialog_open', `The simulator is showing a dialog ('${dialogs[0].title}') that blocks input to the device.`, {
          hint: 'Use inspect_dialogs to see it, then dialog_action / dialog_click / dialog_type to answer or cancel it first.',
          details: { dialogs: dialogs.map(({ id, title }) => ({ id, title })) },
        });
      }
      const { steps, space, hold = false } = plan({ device, layout });
      const originX = layout.offsetX + (space === 'screen' ? device.display.x : 0);
      const originY = layout.offsetY + (space === 'screen' ? device.display.y : 0);
      const translated = steps.map((step) => (step.op === 'wait' ? step : { op: step.op, x: originX + step.x, y: originY + step.y }));
      const total = steps.reduce((sum, step) => sum + (step.op === 'wait' ? step.ms : 0), 0);
      // Holds need the real pointer parked on the target (see helper.swift).
      await runHelper('mouse', { windowId: layout.windowId, steps: translated, parkPointer: hold }, { timeoutMs: 20_000 + total });
      return { device };
    });
  }

  /**
   * @param {Device} device
   * @param {number} x
   * @param {number} y
   */
  static checkPoint(device, x, y) {
    if (!(x >= 0 && y >= 0 && x < device.display.width && y < device.display.height)) {
      throw new CiqError('point_outside_screen', `(${x}, ${y}) is outside the ${device.display.width}x${device.display.height} screen of ${device.name}.`);
    }
  }

  /** @param {{ x: number, y: number, holdMs?: number, expectedDevice?: string }} options */
  tap({ x, y, holdMs = 60, expectedDevice }) {
    return this.input(
      ({ device }) => {
        Simulator.checkPoint(device, x, y);
        if (!device.display.touch) throw new CiqError('no_touchscreen', `${device.name} has no touchscreen; use press_button.`);
        return { space: 'screen', hold: holdMs >= HOLD_THRESHOLD_MS, steps: [{ op: 'down', x, y }, { op: 'wait', ms: holdMs }, { op: 'up', x, y }] };
      },
      { expectedDevice },
    );
  }

  /** @param {{ from?: { x: number, y: number }, to?: { x: number, y: number }, direction?: 'up' | 'down' | 'left' | 'right', durationMs?: number, expectedDevice?: string }} options */
  swipe({ from, to, direction, durationMs, expectedDevice }) {
    return this.input(
      ({ device }) => {
        if (!device.display.touch) throw new CiqError('no_touchscreen', `${device.name} has no touchscreen; use press_button.`);
        const ends = from && to ? { from, to } : direction ? swipeEndpoints(device.display, direction) : undefined;
        if (!ends) throw new CiqError('bad_arguments', 'Give either a direction, or both from and to.');
        Simulator.checkPoint(device, ends.from.x, ends.from.y);
        Simulator.checkPoint(device, ends.to.x, ends.to.y);
        // The simulator only recognises a swipe that is quick enough.
        const limit = device.gestures.maxSwipeDurationMs;
        const duration = durationMs ?? Math.min(150, limit ? limit * 0.6 : 150);
        return { space: 'screen', steps: swipeSteps(ends.from, ends.to, duration) };
      },
      { expectedDevice },
    );
  }

  /** @param {{ button: string, hold?: boolean, durationMs?: number, expectedDevice?: string }} options */
  async pressButton({ button, hold, durationMs, expectedDevice }) {
    /** @type {import('./devices.js').Button | undefined} */
    let pressed;
    let held = false;
    await this.input(
      ({ device }) => {
        pressed = resolveButton(device, button);
        held = hold ?? pressed.hold;
        const x = pressed.x + pressed.width / 2;
        const y = pressed.y + pressed.height / 2;
        const ms = durationMs ?? (held ? DEFAULT_HOLD_MS : 80);
        return { space: 'device', hold: held || ms >= HOLD_THRESHOLD_MS, steps: [{ op: 'down', x, y }, { op: 'wait', ms }, { op: 'up', x, y }] };
      },
      { expectedDevice },
    );
    return { button: pressed?.id, behavior: pressed?.behavior, held };
  }

  /**
   * A picture of one simulator window (a dialog), in window points.
   * @param {number} windowId
   * @returns {Promise<{ png: Buffer, width: number, height: number }>}
   */
  screenshotWindow(windowId) {
    return this.exclusive(async () => {
      const out = await this.tempFile();
      try {
        const probe = await runHelper('capture', { out, windowId });
        // Reduce a Retina capture so that picture pixels are the window points dialog_click takes.
        const result =
          probe.scale === 1
            ? probe
            : await runHelper('capture', { out, windowId, outWidth: Math.round(probe.window.width), outHeight: Math.round(probe.window.height) });
        return { png: await readFile(out), width: result.width, height: result.height };
      } finally {
        await rm(out, { force: true }).catch(() => undefined);
      }
    });
  }

  /** @param {{ windowId: number, x: number, y: number }} options window points, as in the dialog's screenshot */
  dialogClick({ windowId, x, y }) {
    return this.exclusive(async () => {
      await this.refuseFilePanel(windowId, x, y);
      return runHelper('mouse', { windowId, steps: [{ op: 'down', x, y }, { op: 'wait', ms: 60 }, { op: 'up', x, y }] });
    });
  }

  /**
   * While the screen is locked, a system file panel can be neither answered
   * nor cancelled, and it blocks the device until the simulator restarts. The
   * menus open none (bar File > Save Screen Capture, refused by select_menu);
   * buttons inside the simulator's windows do: Profiler > Load, FIT/GPX
   * playback, saving FIT data or a log. So a locked click on such a label is
   * refused. Unlocked, a person can answer the panel, and the click goes ahead.
   * Best effort: if the dialog cannot be read, the click is not held up.
   *
   * @param {number} windowId
   * @param {number} x
   * @param {number} y
   */
  async refuseFilePanel(windowId, x, y) {
    const status = await runHelper('status', {}).catch(() => undefined);
    if (!status?.screenLocked) return;
    const out = await this.tempFile();
    /** @type {any} */
    let read;
    try {
      read = await runHelper('capture', { out, windowId, text: true }, { timeoutMs: 60_000 });
    } catch {
      return;
    } finally {
      await rm(out, { force: true }).catch(() => undefined);
    }
    const label = filePanelLabelAt(read.texts ?? [], x, y);
    if (label) {
      throw new CiqError('opens_file_panel', `'${label.text}' opens a system file panel, which cannot be answered while the screen is locked.`, {
        hint: 'Unlock the Mac and use dialog_action, or leave this to a person. The click was not sent.',
        details: { label: label.text, at: { x, y } },
      });
    }
  }

  /**
   * Types into a dialog's focused control.
   * @param {{ windowId: number, text?: string, replace?: boolean, key?: string }} options
   */
  dialogType({ windowId, text, replace, key }) {
    /** @type {Record<string, unknown>[]} */
    const steps = [];
    if (replace) steps.push({ key: 'a', command: true }, { wait: 60 });
    if (text !== undefined && text !== '') steps.push({ text });
    if (key) steps.push({ wait: 60 }, { key });
    if (steps.length === 0) throw new CiqError('bad_arguments', 'Give text, a key, or both.');
    return this.exclusive(() => runHelper('key', { windowId, steps }, { timeoutMs: 30_000 }));
  }

  listMenu() {
    return this.exclusive(() => runHelper('menu-list'));
  }

  /** @param {string[]} menuPath */
  selectMenu(menuPath) {
    return this.exclusive(() => runHelper('menu-press', { path: menuPath }, { timeoutMs: 15_000 }));
  }

  inspectDialogs() {
    return this.exclusive(() => runHelper('ui-dump'));
  }

  /** @param {{ windowId: number, element: string, expectRole?: string, value?: string | number | boolean, action?: string }} options */
  dialogAction(options) {
    return this.exclusive(() => runHelper('ui-action', options, { timeoutMs: 15_000 }));
  }
}

export const PERMISSION_HINT =
  'Grant Accessibility and Screen Recording to the app that launches this MCP server (your terminal, IDE or Claude) in ' +
  'System Settings > Privacy & Security, then restart that app.';

/** @param {{ windows?: SimWindow[] }} result */
function deviceWindowOf(result) {
  return result.windows?.find((candidate) => candidate.kind === 'device');
}
