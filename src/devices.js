// Device definitions, read from the SDK Manager's Devices directory.
//
// Each device has a `compiler.json` (id, name, resolution) and a `simulator.json`
// (where the screen and each button sit on the device picture). Those button
// rectangles are what makes background input possible: a "button press" is a
// click on the picture.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { CiqError } from './errors.js';

/**
 * @typedef {object} Button
 * @property {string} id         simulator key id: enter, up, down, esc, menu, ...
 * @property {string} [behavior] onSelect, onBack, onMenu, nextPage, previousPage
 * @property {boolean} hold      true when the key only fires on a long press
 * @property {number} x          rectangle on the device picture, in pixels
 * @property {number} y
 * @property {number} width
 * @property {number} height
 *
 * @typedef {object} Device
 * @property {string} id
 * @property {string} name
 * @property {string} imagePath
 * @property {{ x: number, y: number, width: number, height: number, shape: string, touch: boolean }} display
 * @property {Button[]} buttons
 * @property {{ maxSwipeDurationMs?: number, minSwipeDistance?: number }} gestures
 */

/** @param {string} file */
async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * @param {string} devicesDir
 * @returns {Promise<{ id: string, name: string, width: number, height: number, shape: string, touch: boolean, family?: string }[]>}
 */
export async function listDevices(devicesDir) {
  /** @type {string[]} */
  let names;
  try {
    names = await readdir(devicesDir);
  } catch {
    throw new CiqError('devices_not_found', `The device directory ${devicesDir} does not exist.`, {
      hint: 'Download devices with the Garmin SDK Manager (Devices tab).',
    });
  }
  const devices = await Promise.all(
    names.sort().map(async (id) => {
      try {
        const [compiler, simulator] = await Promise.all([
          readJson(path.join(devicesDir, id, 'compiler.json')),
          readJson(path.join(devicesDir, id, 'simulator.json')),
        ]);
        return {
          id: String(compiler.deviceId ?? id),
          name: String(compiler.displayName ?? id),
          width: Number(compiler.resolution?.width ?? simulator.display?.location?.width),
          height: Number(compiler.resolution?.height ?? simulator.display?.location?.height),
          shape: String(simulator.display?.shape ?? 'unknown'),
          touch: Boolean(simulator.display?.isTouch),
          ...(compiler.deviceFamily ? { family: String(compiler.deviceFamily) } : {}),
        };
      } catch {
        return undefined; // not a device directory, or a half-downloaded one
      }
    }),
  );
  return devices.filter((device) => device !== undefined);
}

/**
 * @param {string} devicesDir
 * @param {string} id
 * @returns {Promise<Device>}
 */
export async function loadDevice(devicesDir, id) {
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new CiqError('unknown_device', `'${id}' is not a valid device id.`);
  const dir = path.join(devicesDir, id);
  let compiler;
  let simulator;
  try {
    [compiler, simulator] = await Promise.all([readJson(path.join(dir, 'compiler.json')), readJson(path.join(dir, 'simulator.json'))]);
  } catch {
    throw new CiqError('unknown_device', `Device '${id}' is not installed in ${devicesDir}.`, {
      hint: 'Use list_devices to see installed devices, or download it with the Garmin SDK Manager.',
    });
  }
  return parseDevice(id, dir, compiler, simulator);
}

/**
 * @param {string} id
 * @param {string} dir
 * @param {any} compiler
 * @param {any} simulator
 * @returns {Device}
 */
export function parseDevice(id, dir, compiler, simulator) {
  const location = simulator?.display?.location;
  if (!location || !(location.width > 0) || !(location.height > 0)) {
    throw new CiqError('unsupported_device', `Device '${id}' has no display location in simulator.json.`);
  }
  /** @type {Button[]} */
  const buttons = [];
  for (const key of Array.isArray(simulator.keys) ? simulator.keys : []) {
    const rect = key?.location;
    if (typeof key?.id !== 'string' || !rect || !(rect.width > 0) || !(rect.height > 0)) continue;
    buttons.push({
      id: key.id,
      ...(typeof key.behavior === 'string' ? { behavior: key.behavior } : {}),
      hold: key.isHold === true,
      x: Number(rect.x),
      y: Number(rect.y),
      width: Number(rect.width),
      height: Number(rect.height),
    });
  }
  const behaviors = Array.isArray(simulator.display.behaviors) ? simulator.display.behaviors : [];
  const swipe = behaviors.find((/** @type {any} */ b) => typeof b?.maxSwipeDuration === 'number');
  return {
    id,
    name: String(compiler?.displayName ?? id),
    imagePath: path.join(dir, String(simulator.image ?? `${id}.png`)),
    display: {
      x: Number(location.x),
      y: Number(location.y),
      width: Number(location.width),
      height: Number(location.height),
      shape: String(simulator.display.shape ?? 'unknown'),
      touch: Boolean(simulator.display.isTouch),
    },
    buttons,
    gestures: swipe
      ? { maxSwipeDurationMs: swipe.maxSwipeDuration, minSwipeDistance: Math.max(swipe.minSwipeDeltaX ?? 0, swipe.minSwipeDeltaY ?? 0) }
      : {},
  };
}

/** Friendly names for what a button does, mapped to simulator behaviours. */
const BEHAVIOR_ALIASES = new Map([
  ['select', 'onSelect'],
  ['ok', 'onSelect'],
  ['back', 'onBack'],
  ['escape', 'onBack'],
  ['next', 'nextPage'],
  ['nextpage', 'nextPage'],
  ['previous', 'previousPage'],
  ['prev', 'previousPage'],
  ['previouspage', 'previousPage'],
  ['menu', 'onMenu'],
]);

/**
 * Resolves a button by simulator key id ("enter", "esc", "up") or by what it
 * does ("select", "back", "next", "previous", "menu").
 *
 * @param {Device} device
 * @param {string} name
 * @returns {Button}
 */
export function resolveButton(device, name) {
  const wanted = name.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const byId = device.buttons.find((button) => button.id.toLowerCase() === wanted);
  if (byId) return byId;
  const behavior = BEHAVIOR_ALIASES.get(wanted) ?? name.trim();
  const byBehavior = device.buttons.find((button) => button.behavior?.toLowerCase() === behavior.toLowerCase());
  if (byBehavior) return byBehavior;
  throw new CiqError('unknown_button', `${device.name} has no '${name}' button.`, {
    hint: 'Touch-only devices use gestures instead: swipe right is usually "back".',
    details: { available: describeButtons(device) },
  });
}

/** @param {Device} device */
export function describeButtons(device) {
  return device.buttons.map((button) => ({
    id: button.id,
    ...(button.behavior ? { behavior: button.behavior } : {}),
    ...(button.hold ? { hold: true } : {}),
  }));
}

/**
 * The simulator titles its window "CIQ Simulator - <display name> (<version>)".
 * @param {string} title
 * @returns {string | undefined} the display name
 */
export function deviceNameFromTitle(title) {
  const match = /^CIQ Simulator - (.+?)(?: \([^()]*\))?$/.exec(title.trim());
  return match ? match[1] : undefined;
}
