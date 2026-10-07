// The MCP surface: tool definitions and the glue between them.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildApp } from './build.js';
import { describeButtons, deviceNameFromTitle, listDevices, loadDevice } from './devices.js';
import { CiqError, describeError } from './errors.js';
import { stopHelper } from './helper.js';
import { exists, locateJava, locateSdk } from './sdk.js';
import { AppSession, parseTestSummary } from './session.js';
import { PERMISSION_HINT, Simulator } from './simulator.js';
import { describeTexts, findText } from './text.js';

const packageJson = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
export const VERSION = String(packageJson.version);

const INSTRUCTIONS = `Builds, runs, sees and drives Garmin Connect IQ apps in the Connect IQ simulator on macOS. Nothing here needs
the simulator frontmost, moves the pointer (except briefly for long presses), or needs the screen unlocked.

The loop: run_app builds the project, starts the simulator if needed, launches the app and returns the screen. Then act
and observe. Every action returns the new screen as a picture plus the text on it with tap-ready positions, e.g.
"Trains" (247,363).

Prefer, in this order:
- tap_text over tap: say what to press, not where.
- wait_for (text appears, text disappears, or screen stable) over fixed delays, e.g. after a network request.
- run_steps to send a known sequence in one call; run_on_devices to check the same flow on several devices.
- get_logs for System.println output and crashes when the screen is not what you expected.

Coordinates are device screen pixels: (0,0) is the top-left of the watch display, and screenshot pixels are the same
coordinates. Text recognition is good, not perfect: trust the picture over the text when they disagree.

Simulator settings (GPS, battery, connectivity, language...) live in its menus: list_menu, select_menu. Items that open a
dialog are answered with inspect_dialogs, then dialog_action, or dialog_click / dialog_type on its picture (the only route
while the screen is locked). set_position is a shortcut for the GPS fix. simulator_status explains anything that is missing.`;

/** @param {unknown} value */
function text(value) {
  return { type: /** @type {const} */ ('text'), text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) };
}

/** @param {Buffer} png */
function image(png) {
  return { type: /** @type {const} */ ('image'), data: png.toString('base64'), mimeType: 'image/png' };
}

/**
 * A menu tree as indented lines: far shorter than JSON for a hundred items.
 * `[x]` marks a checked item, `(disabled)` one that cannot be chosen now.
 *
 * @param {any[]} items
 * @param {number} [depth]
 * @returns {string[]}
 */
export function formatMenu(items, depth = 0) {
  /** @type {string[]} */
  const lines = [];
  for (const item of items) {
    const mark = item.checked ? '[x] ' : '';
    lines.push(`${'  '.repeat(depth)}${mark}${item.title}${item.enabled === false ? ' (disabled)' : ''}`);
    if (item.items) lines.push(...formatMenu(item.items, depth + 1));
  }
  return lines;
}

/**
 * One line per dialog control: `id role "title" = value [actions]`.
 * @param {any} element
 */
export function formatElement(element) {
  const parts = [element.id, element.role.replace(/^AX/, '')];
  if (element.subrole) parts.push(`(${element.subrole.replace(/^AX/, '')})`);
  if (element.title) parts.push(JSON.stringify(element.title));
  if (element.description) parts.push(`desc=${JSON.stringify(element.description)}`);
  if (element.value !== undefined) parts.push(`= ${JSON.stringify(element.value)}`);
  if (element.settable) parts.push('settable');
  if (element.enabled === false) parts.push('disabled');
  if (element.selected) parts.push('selected');
  if (element.actions?.length) parts.push(`[${element.actions.join(', ')}]`);
  return parts.join(' ');
}

/**
 * Why a menu item must not be chosen through these tools, or undefined.
 *
 * - File > Save Screen Capture opens the system save panel, which cannot be
 *   answered (or even cancelled) by injected input while the screen is locked,
 *   and then blocks the device until the simulator restarts. A survey of the
 *   other menus (October 2026, SDK 9.2) found no other item that opens a file
 *   panel; buttons inside the simulator's windows do, and dialog_click guards those.
 * - File > Edit Persistent Storage > Edit Application.Properties data opens an
 *   editor that reads the SDK Manager's Garmin account token from the keychain
 *   (a macOS prompt) and then wants a Garmin Connect login; the simulator stops
 *   answering until a person deals with both.
 * - The application menu reaches outside the simulator: macOS Services hand
 *   text to other apps, Hide Others hides the person's own windows, and Quit
 *   has stop_simulator.
 * - The Window menu moves and raises the simulator in front of the person's
 *   work; the tools manage its window themselves and never need it in front.
 *
 * @param {string[]} menuPath
 * @returns {CiqError | undefined}
 */
export function menuRefusal(menuPath) {
  const parts = menuPath.map((part) => part.trim().toLowerCase());
  if (parts.join('>') === 'file>save screen capture') {
    return new CiqError('use_screenshot', "'File > Save Screen Capture' opens a save panel that these tools cannot answer.", {
      hint: 'Use the screenshot tool; pass savePath to write the PNG to a file.',
    });
  }
  if (parts.join('>') === 'file>edit persistent storage>edit application.properties data') {
    return new CiqError('needs_person', "'Edit Application.Properties data' needs a person: it asks macOS for the Garmin account token in the keychain, then for a Garmin Connect login, and the simulator freezes until both are answered.", {
      hint: "Change the property's default in the project's resources/properties.xml and run again instead.",
    });
  }
  if (/simulator|connect ?iq/.test(parts[0]) || parts[0] === 'services') {
    return new CiqError('menu_refused', `The '${menuPath[0]}' menu reaches outside the simulator (Services, Hide Others, Quit) and is not available.`, {
      hint: 'Use stop_simulator to quit it.',
    });
  }
  if (parts[0] === 'window') {
    return new CiqError('menu_refused', "The 'Window' menu would move or raise the simulator over the person's own windows; these tools manage its window themselves.");
  }
  return undefined;
}

const deviceIdSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/, 'a device id such as fenix843mm');
const settleSchema = z.number().int().min(0).max(10_000).optional().describe('Milliseconds to wait before the screenshot (default 500).');
const screenshotFlagSchema = z.boolean().optional().describe('Return a screenshot after the action (default true).');

/**
 * @typedef {object} Context
 * @property {() => Promise<import('./sdk.js').Sdk>} sdk
 * @property {() => Promise<Simulator>} simulator
 * @property {() => Promise<AppSession>} session
 * @property {() => Promise<void>} shutdown
 */

/** @returns {Context} */
export function createContext() {
  /** @type {Promise<import('./sdk.js').Sdk> | undefined} */
  let sdkPromise;
  /** @type {Simulator | undefined} */
  let simulator;
  /** @type {AppSession | undefined} */
  let session;
  const sdk = () => {
    sdkPromise ??= locateSdk().catch((error) => {
      sdkPromise = undefined; // retry next time: the user may install an SDK meanwhile
      throw error;
    });
    return sdkPromise;
  };
  return {
    sdk,
    simulator: async () => (simulator ??= new Simulator({ sdk: await sdk() })),
    session: async () => (session ??= new AppSession({ sdk: await sdk(), java: () => locateJava() })),
    shutdown: async () => {
      session?.killNow();
      await simulator?.dispose();
      stopHelper();
    },
  };
}

/**
 * @param {Context} [context]
 * @returns {McpServer}
 */
export function createServer(context = createContext()) {
  const server = new McpServer({ name: 'connectiq-simulator', version: VERSION }, { instructions: INSTRUCTIONS });

  /** Every tool's handler and argument schema, so run_steps can call them directly. */
  /** @type {Map<string, { handler: (args: any) => Promise<{ content: any[], isError?: boolean }>, schema: z.ZodType }>} */
  const handlers = new Map();

  /**
   * Registers a tool whose failures become readable tool errors instead of
   * protocol errors, so the agent can act on them.
   *
   * @param {string} name
   * @param {{ title: string, description: string, inputSchema?: Record<string, z.ZodType>, readOnly?: boolean }} config
   * @param {(args: any) => Promise<{ content: any[], isError?: boolean }>} handler
   */
  const tool = (name, config, handler) => {
    handlers.set(name, { handler, schema: z.object(config.inputSchema ?? {}) });
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.inputSchema ?? {},
        annotations: { readOnlyHint: Boolean(config.readOnly), openWorldHint: false },
      },
      async (/** @type {any} */ args) => {
        try {
          return await handler(args ?? {});
        } catch (error) {
          if (!(error instanceof CiqError)) console.error(`[owl-connectiq-simulator-mcp] ${name} failed:`, error);
          return { isError: true, content: [text({ error: describeError(error) })] };
        }
      },
    );
  };

  /** The device id of the app this server launched, if it is still the one on screen. */
  const expectedDevice = async () => (await context.session()).app?.device;

  /**
   * The screen as tool content: the picture, plus the text on it. If the picture
   * cannot be taken the reason is returned instead: an action that succeeded
   * must not be reported as failed because its screenshot did.
   *
   * @param {{ settleMs?: number, frame?: 'screen' | 'device' | 'window', scale?: number, savePath?: string, text?: boolean }} [options]
   * @returns {Promise<{ meta: Record<string, any>, content: any[], texts: import('./simulator.js').ScreenText[], png?: Buffer }>}
   */
  const shot = async ({ settleMs = 500, frame, scale, savePath, text: readText = true } = {}) => {
    if (settleMs > 0) await sleep(settleMs);
    try {
      const simulator = await context.simulator();
      const result = await simulator.screenshot({ frame, scale, savePath, text: readText, expectedDevice: await expectedDevice() });
      const { png, dialogs, texts, ...meta } = result;
      return {
        meta: {
          ...meta,
          ...(texts ? { text: describeTexts(texts) } : {}),
          ...(dialogs.length ? { dialogs: dialogs.map(({ id, title }) => ({ id, title })) } : {}),
        },
        content: [image(png)],
        texts: texts ?? [],
        png,
      };
    } catch (error) {
      return { meta: { screenshotError: describeError(error) }, content: [], texts: [] };
    }
  };

  /**
   * @param {Record<string, unknown>} result
   * @param {{ screenshot?: boolean, settleMs?: number }} args
   */
  const withShot = async (result, args) => {
    if (args.screenshot === false) return { content: [text(result)] };
    const { meta, content } = await shot({ settleMs: args.settleMs });
    // The picture says the rest; these are what it cannot say, or says less precisely.
    const notes = 'screenshotError' in meta ? meta : { ...(meta.text ? { text: meta.text } : {}), ...(meta.dialogs ? { dialogs: meta.dialogs } : {}) };
    return { content: [text({ ...result, ...notes }), ...content] };
  };

  // ---------------------------------------------------------------- status

  tool(
    'simulator_status',
    {
      title: 'Simulator status',
      description:
        'Reports whether everything is in place: SDK, Java, macOS permissions, whether the simulator is running, which device it shows, ' +
        'open dialogs, and the state of the app launched by run_app. Call this first when another tool fails.',
      readOnly: true,
    },
    async () => {
      /** @type {Record<string, unknown>} */
      const report = { server: VERSION };
      /** @type {string[]} */
      const problems = [];
      try {
        const sdk = await context.sdk();
        report.sdk = { version: sdk.version, home: sdk.home };
      } catch (error) {
        report.sdk = { error: describeError(error) };
        problems.push('Connect IQ SDK not found.');
      }
      try {
        report.java = await locateJava();
      } catch (error) {
        report.java = { error: describeError(error) };
        problems.push('Java not found (needed to build and launch apps).');
      }
      try {
        const simulator = await context.simulator();
        const status = await simulator.status();
        report.permissions = { accessibility: status.accessibility, screenRecording: status.screenRecording };
        report.screenLocked = status.screenLocked;
        if (status.screenLocked) {
          report.note =
            'Screen locked: everything works except reading dialog controls (use the picture from inspect_dialogs with dialog_click and dialog_type). ' +
            'A sleeping display is woken for screenshots; it stays locked.';
        }
        if (!status.accessibility) problems.push(`Accessibility permission missing. ${PERMISSION_HINT}`);
        if (!status.screenRecording) problems.push(`Screen Recording permission missing. ${PERMISSION_HINT}`);
        if (!status.backgroundClicks) problems.push('This macOS release does not support background clicks.');
        if (status.simulator) {
          const windows = /** @type {import('./simulator.js').SimWindow[]} */ (status.simulator.windows);
          const deviceWindow = windows.find((window) => window.kind === 'device');
          /** @type {Record<string, unknown>} */
          const sim = { running: true, pid: status.simulator.pid };
          if (deviceWindow) {
            sim.window = { title: deviceWindow.title, minimized: deviceWindow.minimized };
            try {
              const device = await simulator.deviceFor(deviceWindow, await expectedDevice());
              sim.device = {
                id: device.id,
                name: device.name,
                screen: { width: device.display.width, height: device.display.height, shape: device.display.shape, touch: device.display.touch },
                buttons: describeButtons(device),
              };
            } catch {
              sim.device = deviceNameFromTitle(deviceWindow.title) ?? 'unknown';
            }
          }
          const dialogs = windows.filter((window) => window.kind === 'dialog');
          if (dialogs.length) sim.dialogs = dialogs.map(({ id, title }) => ({ id, title }));
          report.simulator = sim;
        } else {
          report.simulator = { running: false };
        }
      } catch (error) {
        report.simulator = { error: describeError(error) };
        problems.push('The native helper is not working.');
      }
      report.app = (await context.session().catch(() => undefined))?.info() ?? { state: 'idle' };
      report.ready = problems.length === 0;
      if (problems.length) report.problems = problems;
      return { content: [text(report)] };
    },
  );

  tool(
    'start_simulator',
    {
      title: 'Start simulator',
      description: 'Starts the Connect IQ simulator in the background if it is not running. run_app does this for you.',
    },
    async () => {
      const simulator = await context.simulator();
      return { content: [text(await simulator.ensureRunning())] };
    },
  );

  tool(
    'stop_simulator',
    { title: 'Stop simulator', description: 'Quits the Connect IQ simulator (and with it the running app).' },
    async () => {
      const session = await context.session();
      await session.detach();
      const simulator = await context.simulator();
      return { content: [text({ stopped: await simulator.quit() })] };
    },
  );

  // --------------------------------------------------------------- devices

  tool(
    'list_devices',
    {
      title: 'List devices',
      description: 'Lists installed Connect IQ devices (id, name, screen size and shape, touch). Filter with a search string such as "fenix" or "454".',
      inputSchema: { query: z.string().optional().describe('Case-insensitive text matched against id, name and resolution.') },
      readOnly: true,
    },
    async ({ query }) => {
      const sdk = await context.sdk();
      const all = await listDevices(sdk.devicesDir);
      const needle = query?.toLowerCase();
      const devices = needle
        ? all.filter((d) => `${d.id} ${d.name} ${d.width}x${d.height} ${d.shape} ${d.family ?? ''}`.toLowerCase().includes(needle))
        : all;
      return { content: [text({ count: devices.length, devices })] };
    },
  );

  // ------------------------------------------------------------ build / run

  const buildOptions = {
    projectDir: z.string().describe('Absolute path of the Connect IQ project (the directory holding monkey.jungle).'),
    device: deviceIdSchema.describe('Device id to build for, e.g. fenix843mm.'),
    release: z.boolean().optional().describe('Release build (-r): strips debug info and asserts.'),
    typeCheckLevel: z.number().int().min(0).max(3).optional().describe('Type checking: 0 off, 1 gradual, 2 informative, 3 strict.'),
    developerKey: z.string().optional().describe('Path of developer_key.der. Default: CIQ_DEVELOPER_KEY, VS Code settings, common locations.'),
    jungle: z.string().optional().describe('Jungle file, relative to projectDir. Default: monkey.jungle.'),
    output: z.string().optional().describe('Output .prg path, relative to projectDir. Default: bin/<project>-<device>.prg.'),
    extraArgs: z.array(z.string()).optional().describe('Extra monkeyc arguments.'),
  };

  /** @param {any} args @param {{ unitTests?: boolean }} [extra] */
  const build = async (args, extra = {}) => {
    const sdk = await context.sdk();
    await loadDevice(sdk.devicesDir, args.device); // fail early on an unknown device
    return buildApp({ sdk, java: await locateJava(), ...args, ...extra });
  };

  tool(
    'build_app',
    {
      title: 'Build app',
      description: 'Compiles a Connect IQ project for one device and returns compiler errors and warnings with file and line.',
      inputSchema: buildOptions,
    },
    async (args) => {
      const result = await build(args);
      return { isError: !result.success, content: [text(result)] };
    },
  );

  tool(
    'run_app',
    {
      title: 'Run app',
      description:
        'Builds a project (or takes a ready .prg), starts the simulator if needed, launches the app on the given device and returns a ' +
        'screenshot. The app keeps running; its output is collected for get_logs. Running again replaces the app.',
      inputSchema: {
        ...buildOptions,
        projectDir: buildOptions.projectDir.optional(),
        prg: z.string().optional().describe('A compiled .prg to run instead of building projectDir.'),
        waitMs: z.number().int().min(500).max(60_000).optional().describe('How long to let the app start before the screenshot (default 3000).'),
        screenshot: screenshotFlagSchema,
      },
    },
    async (args) => {
      const sdk = await context.sdk();
      const device = await loadDevice(sdk.devicesDir, args.device);
      /** @type {Record<string, unknown>} */
      const report = { device: device.id };
      let prg = args.prg ? path.resolve(args.prg) : undefined;
      if (!prg) {
        if (!args.projectDir) throw new CiqError('bad_arguments', 'Give projectDir (to build and run) or prg (to run a compiled app).');
        const { waitMs: _waitMs, screenshot: _screenshot, prg: _prg, ...buildArgs } = args;
        const built = await build(buildArgs);
        report.build = { success: built.success, durationMs: built.durationMs, warningCount: built.warningCount };
        if (!built.success) return { isError: true, content: [text({ ...report, build: built })] };
        prg = built.prg;
      }
      if (!prg || !(await exists(prg))) throw new CiqError('invalid_prg', `${prg} does not exist.`);
      report.prg = prg;

      const simulator = await context.simulator();
      const session = await context.session();
      const running = await simulator.ensureRunning();
      if (running.started) report.simulatorStarted = true;
      await simulator.exclusive(() => session.start({ prg, device: device.id, simulatorPid: running.pid }));

      // monkeydo exits at once when the launch fails, and stays while the app runs.
      const waitMs = args.waitMs ?? 3000;
      const deadline = Date.now() + Math.max(waitMs, 20_000);
      await session.settle(waitMs);
      session.assertLaunched();
      // The simulator swaps its window when the device changes: wait for the right one.
      while (session.state === 'running' && Date.now() < deadline) {
        const status = await simulator.status();
        const window = status.simulator?.windows?.find((/** @type {any} */ w) => w.kind === 'device');
        const shown = window ? deviceNameFromTitle(window.title) : undefined;
        if (window && (shown === undefined || shown === device.name)) break;
        await session.settle(500);
      }
      session.assertLaunched();
      report.app = session.info();
      const logs = session.logs({ limit: 40 });
      if (logs.lines.length) report.output = logs.lines.map((line) => line.text);
      if (session.state === 'exited') {
        report.note = 'The app has already ended (it exited or crashed during start-up). See output.';
      }
      return withShot(report, { screenshot: args.screenshot, settleMs: 0 });
    },
  );

  tool(
    'stop_app',
    { title: 'Stop app', description: 'Ends the app running in the simulator (File > Kill App). The simulator stays open.' },
    async () => {
      const simulator = await context.simulator();
      const session = await context.session();
      let killed = false;
      if ((await simulator.status()).simulator) {
        try {
          await simulator.selectMenu(['File', 'Kill App']);
          killed = true;
        } catch (error) {
          if (!(error instanceof CiqError) || error.code !== 'menu_item_disabled') throw error;
        }
      }
      await session.settle(1500);
      await session.detach();
      return { content: [text({ killed, app: session.info() })] };
    },
  );

  tool(
    'run_tests',
    {
      title: 'Run unit tests',
      description: 'Builds the project with unit tests enabled, runs its (:test) functions in the simulator and returns the results.',
      inputSchema: {
        ...buildOptions,
        tests: z.array(z.string()).optional().describe('Names of specific tests to run. Default: all.'),
        timeoutMs: z.number().int().min(5000).max(900_000).optional().describe('Give up after this long (default 180000).'),
      },
    },
    async (args) => {
      const { tests, timeoutMs, ...buildArgs } = args;
      const built = await build(buildArgs, { unitTests: true });
      if (!built.success || !built.prg) return { isError: true, content: [text({ build: built })] };
      const simulator = await context.simulator();
      const session = await context.session();
      const running = await simulator.ensureRunning();
      const prg = built.prg;
      await simulator.exclusive(() => session.start({ prg, device: args.device, tests: tests?.length ? tests : true, simulatorPid: running.pid }));
      const state = await session.settle(timeoutMs ?? 180_000);
      session.assertLaunched();
      const lines = session.logs({ limit: 400 }).lines.map((line) => line.text);
      const summary = parseTestSummary(lines.join('\n'));
      if (state !== 'exited') await session.detach();
      return {
        isError: !summary?.success,
        content: [
          text({
            ...(summary ?? { success: false, note: state === 'exited' ? 'No test summary was printed. Does the project have (:test) functions?' : 'Timed out waiting for the tests.' }),
            output: lines,
          }),
        ],
      };
    },
  );

  tool(
    'get_logs',
    {
      title: 'App logs',
      description:
        'Returns what the app printed (System.println), plus errors and crash reports, since run_app. Pass the previous lastSeq as sinceSeq to get only new lines.',
      inputSchema: {
        sinceSeq: z.number().int().min(0).optional().describe('Only lines after this sequence number.'),
        limit: z.number().int().min(1).max(2000).optional().describe('Maximum lines, newest kept (default 200).'),
      },
      readOnly: true,
    },
    async ({ sinceSeq, limit }) => {
      const session = await context.session();
      return { content: [text({ app: session.info(), ...session.logs({ sinceSeq, limit }) })] };
    },
  );

  // ------------------------------------------------------------ see / touch

  tool(
    'screenshot',
    {
      title: 'Screenshot',
      description:
        'Captures the simulated watch. frame "screen" (default) is exactly the display, one image pixel per device pixel, so image coordinates ' +
        'can be passed straight to tap; it also lists the text on screen with tap-ready positions. "device" includes the watch body and ' +
        'buttons; "window" is the whole simulator window.',
      inputSchema: {
        frame: z.enum(['screen', 'device', 'window']).optional(),
        scale: z.number().min(0.25).max(4).optional().describe('Enlarge or reduce the image (default 1). Tap coordinates stay in device pixels.'),
        savePath: z.string().optional().describe('Also save the PNG to this path.'),
        delayMs: z.number().int().min(0).max(30_000).optional().describe('Wait this long first, e.g. for an animation or a network response.'),
      },
      readOnly: true,
    },
    async ({ frame, scale, savePath, delayMs }) => {
      if (delayMs) await sleep(delayMs);
      const simulator = await context.simulator();
      const { png, dialogs, texts, ...meta } = await simulator.screenshot({ frame, scale, savePath, text: true, expectedDevice: await expectedDevice() });
      return {
        content: [
          text({
            ...meta,
            ...(texts ? { text: describeTexts(texts) } : {}),
            ...(dialogs.length ? { dialogs: dialogs.map(({ id, title }) => ({ id, title })) } : {}),
          }),
          image(png),
        ],
      };
    },
  );

  const point = { x: z.number().describe('Device screen pixels from the left edge.'), y: z.number().describe('Device screen pixels from the top edge.') };

  tool(
    'tap',
    {
      title: 'Tap',
      description: 'Taps the touchscreen at a point given in device screen pixels (the same coordinates as a "screen" screenshot).',
      inputSchema: { ...point, screenshot: screenshotFlagSchema, settleMs: settleSchema },
    },
    async (args) => {
      const simulator = await context.simulator();
      await simulator.tap({ x: args.x, y: args.y, expectedDevice: await expectedDevice() });
      return withShot({ tapped: { x: args.x, y: args.y } }, args);
    },
  );

  tool(
    'tap_text',
    {
      title: 'Tap text',
      description:
        'Taps the on-screen text that matches, e.g. "Trains" or "Change Stop". Matching ignores case and common recognition slips; an exact ' +
        'match wins over a partial one. If several places match, pass index (0 = first in reading order).',
      inputSchema: {
        text: z.string().min(1),
        index: z.number().int().min(0).optional().describe('Which match to tap when there are several.'),
        exact: z.boolean().optional().describe('Only whole-text matches.'),
        screenshot: screenshotFlagSchema,
        settleMs: settleSchema,
      },
    },
    async (args) => {
      const simulator = await context.simulator();
      const before = await simulator.screenshot({ text: true, expectedDevice: await expectedDevice() });
      const matches = findText(before.texts ?? [], args.text, { exact: args.exact });
      if (matches.length === 0) {
        throw new CiqError('text_not_found', `No text matching '${args.text}' is on screen.`, {
          hint: 'Use wait_for if it is still loading, or tap with coordinates if it is an icon.',
          details: { visible: describeTexts(before.texts ?? []) },
        });
      }
      if (matches.length > 1 && args.index === undefined) {
        throw new CiqError('text_ambiguous', `'${args.text}' matches ${matches.length} places; pass index.`, {
          details: { matches: matches.map((m, i) => `${i}: ${JSON.stringify(m.text)} (${m.centerX},${m.centerY})`) },
        });
      }
      const match = matches[args.index ?? 0];
      if (!match) throw new CiqError('bad_arguments', `index ${args.index} is out of range: there are ${matches.length} matches.`);
      await simulator.tap({ x: match.centerX, y: match.centerY, expectedDevice: await expectedDevice() });
      return withShot({ tapped: { text: match.text, x: match.centerX, y: match.centerY } }, args);
    },
  );

  tool(
    'wait_for',
    {
      title: 'Wait for the screen',
      description:
        'Waits until a condition holds, then returns the screen: text has appeared, textGone has disappeared, and/or the screen is stable ' +
        '(two identical frames in a row). Use it instead of fixed delays after launching, navigating or a network request. ' +
        'On timeout it returns an error with the current screen.',
      inputSchema: {
        text: z.string().min(1).optional().describe('Wait until this text is on screen.'),
        textGone: z.string().min(1).optional().describe('Wait until this text is no longer on screen, e.g. "Loading".'),
        stable: z.boolean().optional().describe('Wait until the screen stops changing.'),
        timeoutMs: z.number().int().min(100).max(120_000).optional().describe('Default 10000.'),
        intervalMs: z.number().int().min(100).max(5000).optional().describe('Polling interval (default 400).'),
      },
      readOnly: true,
    },
    async (args) => {
      if (!args.text && !args.textGone && !args.stable) throw new CiqError('bad_arguments', 'Give text, textGone and/or stable.');
      const timeoutMs = args.timeoutMs ?? 10_000;
      const started = Date.now();
      /** @type {Buffer | undefined} */
      let previous;
      for (;;) {
        const current = await shot({ settleMs: 0 });
        /** @type {string[]} */
        const unmet = [];
        if ('screenshotError' in current.meta) {
          unmet.push(`no screenshot: ${current.meta.screenshotError.message}`);
        } else {
          if (args.text && findText(current.texts, args.text).length === 0) unmet.push(`text '${args.text}' not visible`);
          if (args.textGone && findText(current.texts, args.textGone).length > 0) unmet.push(`text '${args.textGone}' still visible`);
          if (args.stable && !(previous && current.png && previous.equals(current.png))) unmet.push('screen still changing');
        }
        previous = current.png;
        const waitedMs = Date.now() - started;
        if (unmet.length === 0) return { content: [text({ waitedMs, text: current.meta.text ?? [] }), ...current.content] };
        if (waitedMs >= timeoutMs) {
          return {
            isError: true,
            content: [
              text({ error: { code: 'wait_timeout', message: `Timed out after ${waitedMs} ms: ${unmet.join('; ')}.` }, ...current.meta }),
              ...current.content,
            ],
          };
        }
        await sleep(args.intervalMs ?? 400);
      }
    },
  );

  tool(
    'long_press',
    {
      title: 'Long press',
      description: 'Presses and holds the touchscreen at a point (triggers onHold).',
      inputSchema: {
        ...point,
        durationMs: z.number().int().min(300).max(15_000).optional().describe('How long to hold (default 1200).'),
        screenshot: screenshotFlagSchema,
        settleMs: settleSchema,
      },
    },
    async (args) => {
      const simulator = await context.simulator();
      const holdMs = args.durationMs ?? 1200;
      await simulator.tap({ x: args.x, y: args.y, holdMs, expectedDevice: await expectedDevice() });
      return withShot({ held: { x: args.x, y: args.y, durationMs: holdMs } }, args);
    },
  );

  tool(
    'swipe',
    {
      title: 'Swipe',
      description:
        'Swipes the touchscreen. Give a direction (the way the finger moves: "up" shows the next page, "right" is usually back), or exact from and to points.',
      inputSchema: {
        direction: z.enum(['up', 'down', 'left', 'right']).optional(),
        from: z.object(point).optional(),
        to: z.object(point).optional(),
        durationMs: z.number().int().min(30).max(5000).optional().describe('Default 150; slow swipes are read as drags.'),
        screenshot: screenshotFlagSchema,
        settleMs: settleSchema,
      },
    },
    async (args) => {
      const simulator = await context.simulator();
      await simulator.swipe({ ...args, expectedDevice: await expectedDevice() });
      return withShot({ swiped: args.direction ?? { from: args.from, to: args.to } }, args);
    },
  );

  tool(
    'press_button',
    {
      title: 'Press button',
      description:
        'Presses a physical button. Name it by what it does ("select", "back", "next", "previous", "menu") or by simulator key id ' +
        '("enter", "esc", "up", "down", "start", "lap"...). simulator_status lists the buttons of the current device. ' +
        'Buttons that only act when held (often "menu") are held automatically.',
      inputSchema: {
        button: z.string().min(1),
        hold: z.boolean().optional().describe('Force a long press (or a short one with false).'),
        durationMs: z.number().int().min(20).max(15_000).optional().describe('Press length. Default 80, or 1200 for a hold.'),
        screenshot: screenshotFlagSchema,
        settleMs: settleSchema,
      },
    },
    async (args) => {
      const simulator = await context.simulator();
      const pressed = await simulator.pressButton({ ...args, expectedDevice: await expectedDevice() });
      return withShot({ pressed }, args);
    },
  );

  // ------------------------------------------------------- menus / dialogs

  /**
   * What a dialog looks like after an action, or that it has closed.
   * @param {Simulator} simulator
   * @param {number} windowId
   * @param {Record<string, unknown>} report
   */
  const dialogAfter = async (simulator, windowId, report) => {
    await sleep(250);
    const status = await simulator.status();
    const dialogs = (status.simulator?.windows ?? []).filter((/** @type {any} */ w) => w.kind === 'dialog');
    const openDialogs = dialogs.map((/** @type {any} */ w) => ({ id: w.id, title: w.title }));
    if (!dialogs.some((/** @type {any} */ w) => w.id === windowId)) return { content: [text({ ...report, closed: true, openDialogs })] };
    try {
      return { content: [text({ ...report, closed: false, openDialogs }), image((await simulator.screenshotWindow(windowId)).png)] };
    } catch (error) {
      return { content: [text({ ...report, closed: false, openDialogs, pictureError: describeError(error) })] };
    }
  };

  tool(
    'list_menu',
    {
      title: 'List simulator menus',
      description:
        "Returns the simulator's menu bar as an indented tree (File, Settings, Simulation, ...); [x] marks checked items. " +
        'This is where simulator settings live: connectivity, GPS quality, battery, language, time format, backlight, app storage.',
      inputSchema: { menu: z.string().optional().describe('Only this top-level menu, e.g. "Settings".') },
      readOnly: true,
    },
    async ({ menu }) => {
      const simulator = await context.simulator();
      const { menus } = await simulator.listMenu();
      const render = (/** @type {any[]} */ tree) => ({ content: [text(formatMenu(tree).join('\n'))] });
      if (!menu) return render(menus);
      const wanted = menus.filter((/** @type {any} */ entry) => entry.title.toLowerCase() === menu.toLowerCase());
      if (wanted.length === 0) {
        throw new CiqError('menu_item_not_found', `No menu '${menu}'.`, { details: { available: menus.map((/** @type {any} */ m) => m.title) } });
      }
      return render(wanted);
    },
  );

  tool(
    'select_menu',
    {
      title: 'Select simulator menu item',
      description:
        'Chooses a simulator menu item by path, e.g. ["Settings", "Connection Type", "BLE", "Not Connected"] or ["File", "Reset All App Data"]. ' +
        'If the item opens a dialog it is listed in the result: answer it with inspect_dialogs and dialog_action.',
      inputSchema: {
        path: z.array(z.string().min(1)).min(2).describe('Menu titles from the menu bar down to the item.'),
        screenshot: z.boolean().optional().describe('Return a screenshot afterwards (default false).'),
      },
    },
    async (args) => {
      const refusal = menuRefusal(args.path);
      if (refusal) throw refusal;
      const simulator = await context.simulator();
      const result = await simulator.selectMenu(args.path);
      const dialogs = result.windows.filter((/** @type {any} */ w) => w.kind === 'dialog').map((/** @type {any} */ w) => ({ id: w.id, title: w.title }));
      const report = { selected: args.path, ...(result.checked !== undefined ? { checked: result.checked } : {}), ...(dialogs.length ? { dialogs } : {}) };
      return args.screenshot ? withShot(report, {}) : { content: [text(report)] };
    },
  );

  tool(
    'inspect_dialogs',
    {
      title: 'Inspect simulator dialogs',
      description:
        'Shows the dialogs the simulator has open: a picture of each, and its controls (text fields, buttons, checkboxes) with ids for ' +
        'dialog_action. When controls are not listed (screen locked), use the picture with dialog_click and dialog_type.',
      readOnly: true,
    },
    async () => {
      const simulator = await context.simulator();
      const { windows } = await simulator.inspectDialogs();
      const open = windows.filter((/** @type {any} */ w) => w.kind === 'dialog');
      /** @type {any[]} */
      const dialogs = [];
      /** @type {any[]} */
      const pictures = [];
      for (const dialog of open.slice(0, 4)) {
        /** @type {Record<string, unknown>} */
        const entry = { windowId: dialog.id, title: dialog.title, size: { width: Math.round(dialog.width), height: Math.round(dialog.height) } };
        if (dialog.inspectable) entry.elements = dialog.elements.map(formatElement);
        else entry.controls = 'not readable (screen locked): use the picture with dialog_click and dialog_type';
        try {
          pictures.push(image((await simulator.screenshotWindow(dialog.id)).png));
        } catch (error) {
          entry.pictureError = describeError(error);
        }
        dialogs.push(entry);
      }
      const legend = dialogs.some((d) => d.elements) ? { format: 'id Role "title" = value [actions]' } : {};
      return { content: [text({ dialogs, ...legend }), ...pictures] };
    },
  );

  tool(
    'dialog_action',
    {
      title: 'Act on a dialog control',
      description:
        'Sets the value of a control and/or performs an action on it, using ids from inspect_dialogs. Typical: set a text field with value, ' +
        'then press the OK button with action "AXPress". Needs the screen unlocked; otherwise use dialog_click and dialog_type.',
      inputSchema: {
        windowId: z.number().int().describe('The dialog, from inspect_dialogs.'),
        element: z.string().regex(/^\d+(\.\d+)*$/).describe('Element id from inspect_dialogs, e.g. "1" or "0.3".'),
        role: z.string().optional().describe('The role inspect_dialogs reported; guards against the dialog having changed.'),
        value: z.union([z.string(), z.number(), z.boolean()]).optional().describe('New value (text for text fields, 0/1 for checkboxes).'),
        action: z.string().optional().describe('An action the element listed, usually "AXPress".'),
      },
    },
    async ({ windowId, element, role, value, action }) => {
      if (value === undefined && !action) throw new CiqError('bad_arguments', 'Give a value, an action, or both.');
      const simulator = await context.simulator();
      const result = await simulator.dialogAction({ windowId, element, ...(role ? { expectRole: role } : {}), ...(value !== undefined ? { value } : {}), ...(action ? { action } : {}) });
      const dialogs = result.windows.filter((/** @type {any} */ w) => w.kind === 'dialog').map((/** @type {any} */ w) => ({ id: w.id, title: w.title }));
      const { windows: _windows, ok: _ok, ...rest } = result;
      return { content: [text({ ...rest, openDialogs: dialogs })] };
    },
  );

  tool(
    'dialog_click',
    {
      title: 'Click in a dialog',
      description:
        'Clicks a point in a dialog, in the pixel coordinates of its picture from inspect_dialogs. Works while the screen is locked. ' +
        'Click a text field to focus it before dialog_type. While the screen is locked, a click on a button that opens a system ' +
        'file panel (Load, Open..., Save...) is refused: nothing could answer the panel.',
      inputSchema: {
        windowId: z.number().int().describe('The dialog, from inspect_dialogs.'),
        x: z.number().min(0),
        y: z.number().min(0),
      },
    },
    async ({ windowId, x, y }) => {
      const simulator = await context.simulator();
      await simulator.dialogClick({ windowId, x, y });
      return dialogAfter(simulator, windowId, { clicked: { x, y } });
    },
  );

  tool(
    'dialog_type',
    {
      title: 'Type in a dialog',
      description:
        'Types text into the focused control of a dialog and/or presses a key (enter confirms, escape cancels, tab moves on). ' +
        'Works while the screen is locked.',
      inputSchema: {
        windowId: z.number().int().describe('The dialog, from inspect_dialogs.'),
        text: z.string().max(4000).optional(),
        replace: z.boolean().optional().describe('Select the existing text first so the new text replaces it (default true when text is given).'),
        key: z.enum(['enter', 'escape', 'tab', 'space', 'delete', 'up', 'down', 'left', 'right']).optional().describe('Pressed after the text.'),
      },
    },
    async ({ windowId, text: typed, replace, key }) => {
      const simulator = await context.simulator();
      await simulator.dialogType({ windowId, text: typed, replace: typed !== undefined && replace !== false, key });
      return dialogAfter(simulator, windowId, { ...(typed !== undefined ? { typed } : {}), ...(key ? { key } : {}) });
    },
  );

  tool(
    'set_position',
    {
      title: 'Set GPS position',
      description:
        "Sets the simulator's GPS position (Settings > Set Position). It becomes the last known position (Position.getInfo, " +
        'quality LAST_KNOWN) but sends no location events: the simulator sends those only while it plays back FIT data. ' +
        'An app that only listens for events sees it on its next launch (run_app again).',
      inputSchema: {
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        screenshot: z.boolean().optional().describe('Return a screenshot afterwards (default false).'),
        settleMs: settleSchema,
      },
    },
    async (args) => {
      const simulator = await context.simulator();
      const value = `${args.latitude.toFixed(6)}, ${args.longitude.toFixed(6)}`;
      const dialogsNow = async () =>
        (await simulator.inspectDialogs()).windows.filter((/** @type {any} */ w) => w.kind === 'dialog');
      const before = new Set((await dialogsNow()).map((/** @type {any} */ w) => w.id));
      if (before.size > 0) {
        throw new CiqError('dialog_open', 'The simulator already has a dialog open; answer or cancel it first.', { hint: 'See inspect_dialogs.' });
      }
      await simulator.selectMenu(['Settings', 'Set Position']);
      /** @type {any} */
      let dialog;
      for (let attempt = 0; attempt < 15 && !dialog; attempt += 1) {
        dialog = (await dialogsNow()).find((/** @type {any} */ w) => !before.has(w.id));
        if (!dialog) await sleep(200);
      }
      if (!dialog) throw new CiqError('dialog_not_found', 'The Set Position dialog did not open.', { hint: 'Check inspect_dialogs.' });
      const field = dialog.elements.find((/** @type {any} */ e) => e.role === 'AXTextField');
      const ok = dialog.elements.find((/** @type {any} */ e) => e.role === 'AXButton' && e.title === 'OK');
      if (field && ok) {
        await simulator.dialogAction({ windowId: dialog.id, element: field.id, expectRole: 'AXTextField', value });
        await simulator.dialogAction({ windowId: dialog.id, element: ok.id, expectRole: 'AXButton', action: 'AXPress' });
      } else {
        // Controls are hidden (locked screen): the text field has focus when the
        // dialog opens, so replace its text and confirm with Return.
        await simulator.dialogType({ windowId: dialog.id, text: value, replace: true, key: 'enter' });
      }
      let closed = false;
      for (let attempt = 0; attempt < 12 && !closed; attempt += 1) {
        await sleep(250);
        closed = !(await dialogsNow()).some((/** @type {any} */ w) => w.id === dialog.id);
      }
      if (!closed) {
        throw new CiqError('set_position_failed', 'The Set Position dialog did not accept the position and is still open.', {
          hint: 'See inspect_dialogs; cancel it with dialog_type key "escape".',
        });
      }
      const report = { position: { latitude: args.latitude, longitude: args.longitude } };
      return args.screenshot ? withShot(report, args) : { content: [text(report)] };
    },
  );

  // ------------------------------------------------------------------ flows

  const stepSchema = z.object({
    tool: z.string().describe('Any tool of this server except run_steps and run_on_devices.'),
    args: z.record(z.string(), z.unknown()).optional(),
  });

  /**
   * Runs steps in order through the same handlers and validation as direct calls.
   * @param {{ tool: string, args?: Record<string, unknown> }[]} steps
   * @param {'last' | 'all' | 'none'} pictures
   */
  const runSteps = async (steps, pictures) => {
    /** @type {any[]} */
    const report = [];
    /** @type {any[]} */
    const images = [];
    let failed = false;
    for (const [index, step] of steps.entries()) {
      const entry = handlers.get(step.tool);
      /** @type {{ content: any[], isError?: boolean }} */
      let result;
      if (!entry || step.tool === 'run_steps' || step.tool === 'run_on_devices') {
        result = { isError: true, content: [text({ error: { code: 'bad_arguments', message: `'${step.tool}' cannot be used as a step.` } })] };
      } else {
        const parsed = entry.schema.safeParse(step.args ?? {});
        if (!parsed.success) {
          result = { isError: true, content: [text({ error: { code: 'bad_arguments', message: z.prettifyError(parsed.error) } })] };
        } else {
          // Intermediate pictures cost time and tokens; skip them unless asked for.
          const wantsPicture = pictures === 'all' || (pictures === 'last' && index === steps.length - 1);
          const args = /** @type {any} */ (parsed.data);
          const takesFlag = 'screenshot' in /** @type {any} */ (entry.schema).shape;
          try {
            result = await entry.handler(takesFlag && args.screenshot === undefined && !wantsPicture ? { ...args, screenshot: false } : args);
          } catch (error) {
            result = { isError: true, content: [text({ error: describeError(error) })] };
          }
        }
      }
      const texts = result.content.filter((item) => item.type === 'text').map((item) => {
        try {
          return JSON.parse(item.text);
        } catch {
          return item.text;
        }
      });
      report.push({ step: index + 1, tool: step.tool, ok: !result.isError, result: texts.length === 1 ? texts[0] : texts });
      const stepImages = result.content.filter((item) => item.type === 'image');
      if (pictures === 'all' || result.isError) images.push(...stepImages);
      else if (pictures === 'last') images.splice(0, images.length, ...stepImages.slice(-1));
      if (result.isError) {
        failed = true;
        break;
      }
    }
    return { report, images, failed };
  };

  tool(
    'run_steps',
    {
      title: 'Run a sequence of steps',
      description:
        'Runs several tool calls in order in one request and stops at the first failure, e.g. ' +
        '[{tool:"press_button",args:{button:"menu"}}, {tool:"tap_text",args:{text:"Change Stop"}}, {tool:"wait_for",args:{text:"Nearby"}}]. ' +
        'Returns each step\'s result and, by default, the screen after the last step.',
      inputSchema: {
        steps: z.array(stepSchema).min(1).max(40),
        screenshots: z.enum(['last', 'all', 'none']).optional().describe('Which pictures to return (default "last"). A failing step always returns its picture.'),
      },
    },
    async ({ steps, screenshots }) => {
      const { report, images, failed } = await runSteps(steps, screenshots ?? 'last');
      return {
        isError: failed,
        content: [text({ completed: report.filter((entry) => entry.ok).length, of: steps.length, steps: report }), ...images],
      };
    },
  );

  const { device: _oneDevice, ...buildOptionsWithoutDevice } = buildOptions;

  tool(
    'run_on_devices',
    {
      title: 'Run on several devices',
      description:
        'Builds and launches the project on each device in turn, optionally runs the same steps on each, and returns one screen per device. ' +
        'Use it to check a layout across screen sizes and display types (e.g. an AMOLED and a MIP watch).',
      inputSchema: {
        ...buildOptionsWithoutDevice,
        devices: z.array(deviceIdSchema).min(1).max(12),
        steps: z.array(stepSchema).max(40).optional().describe('Run on each device after launch, before its screenshot.'),
        waitFor: z.string().optional().describe('Text to wait for after launch on each device (up to 15 s) before continuing.'),
      },
    },
    async ({ devices, steps, waitFor, ...buildArgs }) => {
      /** @type {any[]} */
      const content = [];
      /** @type {any[]} */
      const summary = [];
      let failed = false;
      for (const device of devices) {
        /** @type {{ tool: string, args?: Record<string, unknown> }[]} */
        const flow = [{ tool: 'run_app', args: { ...buildArgs, device, screenshot: false } }];
        if (waitFor) flow.push({ tool: 'wait_for', args: { text: waitFor, timeoutMs: 15_000 } });
        flow.push(...(steps ?? []));
        const { report, failed: flowFailed } = await runSteps(flow, 'none');
        const after = await shot({ settleMs: steps?.length || waitFor ? 300 : 1000 });
        const last = report.at(-1);
        summary.push({
          device,
          ok: !flowFailed,
          ...(flowFailed ? { failedStep: last?.tool, error: last?.result?.error ?? last?.result } : {}),
          ...('screenshotError' in after.meta ? after.meta : { text: after.meta.text }),
        });
        content.push(text(`${device}${flowFailed ? ' (failed)' : ''}:`), ...after.content);
        if (flowFailed) failed = true;
      }
      return { isError: failed, content: [text({ devices: summary }), ...content] };
    },
  );

  return server;
}
