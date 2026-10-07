// Runs an app in the simulator and keeps its output.
//
// Launching goes through Garmin's own `monkeydo` (the MonkeyDoDeux class in
// monkeybrains.jar): it pushes the .prg, its debug info and settings over the
// simulator's shell port, starts the app, then relays `System.println` output
// and crash reports until the app ends. Reusing it means this server follows
// the SDK's protocol across releases instead of reimplementing it.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { CiqError } from './errors.js';

const MAX_LINES = 5000;
/** How often a running session checks that the simulator is still there. */
export const SIMULATOR_CHECK_MS = 2000;

/** @param {number} pid */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}
const MAX_LINE_LENGTH = 4000;

/** monkeydo messages that mean the launch itself failed. */
const LAUNCH_FAILURES = [
  { pattern: /Unable to connect to simulator|Unable to communicate with (the )?[Ss]imulator/, code: 'simulator_unreachable' },
  { pattern: /not properly signed/, code: 'app_signature_invalid' },
  { pattern: /Unable to launch to provided PRG file/, code: 'app_launch_failed' },
  { pattern: /Invalid PRG file|Unable to find given PRG file|Unable to parser? the app's UUID/, code: 'invalid_prg' },
];

/**
 * @typedef {{ seq: number, time: string, stream: 'stdout' | 'stderr', text: string }} LogLine
 * @typedef {'idle' | 'running' | 'exited'} SessionState
 */

/**
 * @param {string} text
 * @returns {{ passed: number, failed: number, errors: number, success: boolean } | undefined}
 */
export function parseTestSummary(text) {
  const match = /(PASSED|FAILED) \(passed=(\d+), failed=(\d+)\s*, errors=(\d+)\)/.exec(text);
  if (!match) return undefined;
  return { success: match[1] === 'PASSED', passed: Number(match[2]), failed: Number(match[3]), errors: Number(match[4]) };
}

export class AppSession {
  /**
   * @param {{ sdk: import('./sdk.js').Sdk, java: () => Promise<string>, spawnProcess?: typeof spawn,
   *   alive?: (pid: number) => boolean, checkMs?: number }} options
   */
  constructor({ sdk, java, spawnProcess = spawn, alive = processAlive, checkMs = SIMULATOR_CHECK_MS }) {
    this.sdk = sdk;
    this.java = java;
    this.spawnProcess = spawnProcess;
    this.alive = alive;
    this.checkMs = checkMs;
    /** @type {NodeJS.Timeout | undefined} */
    this.watch = undefined;
    /** @type {LogLine[]} */
    this.lines = [];
    this.seq = 0;
    this.dropped = 0;
    /** @type {import('node:child_process').ChildProcess | undefined} */
    this.child = undefined;
    /** @type {SessionState} */
    this.state = 'idle';
    /** @type {{ prg: string, device: string, startedAt: string, tests: boolean } | undefined} */
    this.app = undefined;
    /** @type {{ code: number | null, signal: string | null, at: string } | undefined} */
    this.exit = undefined;
    /** @type {{ code: string, message: string } | undefined} */
    this.failure = undefined;
    this.crashed = false;
    this.simulatorGone = false;
    /** @type {Promise<void>} */
    this.exited = Promise.resolve();
  }

  /**
   * @param {'stdout' | 'stderr'} stream
   * @param {string} text
   */
  record(stream, text) {
    const line = text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH)}… [truncated]` : text;
    this.seq += 1;
    this.lines.push({ seq: this.seq, time: new Date().toISOString(), stream, text: line });
    if (this.lines.length > MAX_LINES) {
      this.lines.shift();
      this.dropped += 1;
    }
    for (const { pattern, code } of LAUNCH_FAILURES) {
      if (pattern.test(text)) this.failure ??= { code, message: text.trim() };
    }
    if (/Encountered an app crash|^Error: .*(Error|Exception)\b|Unhandled Exception/.test(text)) this.crashed = true;
  }

  /**
   * Starts an app (or its unit tests). Any app this session started earlier is
   * detached first.
   *
   * `simulatorPid` is watched while the app runs: when the simulator is quit
   * by hand, monkeydo would otherwise wait on its dead connection until the
   * next launch or the server's exit.
   *
   * @param {{ prg: string, device: string, tests?: boolean | string[], simulatorPid?: number }} options
   */
  async start({ prg, device, tests, simulatorPid }) {
    await this.detach();
    const java = await this.java();
    const args = ['-classpath', this.sdk.jar, 'com.garmin.monkeybrains.monkeydodeux.MonkeyDoDeux', '-f', prg, '-d', device, '-s', this.sdk.shell];
    if (tests) args.push('-t', ...(Array.isArray(tests) ? tests : []));

    this.lines = [];
    this.dropped = 0;
    this.exit = undefined;
    this.failure = undefined;
    this.crashed = false;
    this.simulatorGone = false;
    this.app = { prg, device, startedAt: new Date().toISOString(), tests: Boolean(tests) };
    this.state = 'running';

    // Its own process group, so the java process and the `shell` it spawns can
    // be stopped together.
    const child = this.spawnProcess(java, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    for (const stream of /** @type {const} */ (['stdout', 'stderr'])) {
      let pending = '';
      child[stream]?.setEncoding('utf8');
      child[stream]?.on('data', (/** @type {string} */ chunk) => {
        pending += chunk;
        const parts = pending.split(/\r?\n/);
        pending = parts.pop() ?? '';
        for (const part of parts) if (this.child === child) this.record(stream, part);
      });
      child[stream]?.on('end', () => {
        if (pending && this.child === child) this.record(stream, pending);
        pending = '';
      });
    }
    if (simulatorPid) this.watchSimulator(child, simulatorPid);
    this.exited = new Promise((resolve) => {
      child.once('error', (error) => {
        if (this.child !== child) return resolve();
        this.failure ??= { code: 'monkeydo_failed', message: `Could not run monkeydo: ${error.message}` };
        this.state = 'exited';
        this.exit = { code: null, signal: null, at: new Date().toISOString() };
        resolve();
      });
      child.once('close', (code, signal) => {
        if (this.child === child) {
          this.state = 'exited';
          this.exit = { code, signal, at: new Date().toISOString() };
        }
        resolve();
      });
    });
  }

  /**
   * Ends the session if the simulator goes away under it.
   * @param {import('node:child_process').ChildProcess} child
   * @param {number} pid
   */
  watchSimulator(child, pid) {
    const timer = setInterval(() => {
      if (this.child !== child || this.state !== 'running') {
        clearInterval(timer);
        return;
      }
      if (this.alive(pid)) return;
      clearInterval(timer);
      this.record('stderr', 'The simulator quit; the app session has ended.');
      this.simulatorGone = true;
      void this.detach();
    }, this.checkMs);
    timer.unref();
    this.watch = timer;
  }

  /**
   * Waits until the launch has clearly worked or failed: monkeydo exits early
   * on failure and stays attached while the app runs.
   *
   * @param {number} ms
   * @returns {Promise<SessionState>}
   */
  async settle(ms) {
    await Promise.race([this.exited, sleep(ms)]);
    return this.state;
  }

  /** Throws when the launch failed. */
  assertLaunched() {
    if (this.failure) {
      throw new CiqError(this.failure.code, this.failure.message, {
        hint: this.failure.code === 'simulator_unreachable' ? 'Check simulator_status; restart the simulator if it is hung.' : undefined,
        details: { output: this.tail(20) },
      });
    }
  }

  /** Stops following the app (the app itself keeps running in the simulator). */
  async detach() {
    clearInterval(this.watch);
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const done = this.exited;
    const signal = (/** @type {NodeJS.Signals} */ name) => {
      try {
        if (child.pid) process.kill(-child.pid, name);
      } catch {
        try {
          child.kill(name);
        } catch {
          // already gone
        }
      }
    };
    signal('SIGTERM');
    if ((await Promise.race([done.then(() => 'done'), sleep(3000).then(() => 'timeout')])) === 'timeout') {
      signal('SIGKILL');
      await Promise.race([done, sleep(2000)]);
    }
  }

  /** Synchronous last-resort cleanup for process exit. */
  killNow() {
    const child = this.child;
    if (!child?.pid || child.exitCode !== null) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }

  /** @param {number} count */
  tail(count) {
    return this.lines.slice(-count).map((line) => line.text);
  }

  /**
   * @param {{ sinceSeq?: number, limit?: number }} [options]
   */
  logs({ sinceSeq = 0, limit = 200 } = {}) {
    const fresh = this.lines.filter((line) => line.seq > sinceSeq);
    const lines = fresh.slice(-limit);
    return {
      lines,
      lastSeq: this.seq,
      omitted: fresh.length - lines.length,
      ...(this.dropped ? { droppedFromBuffer: this.dropped } : {}),
    };
  }

  info() {
    return {
      state: this.state,
      ...(this.app ?? {}),
      ...(this.exit ? { exit: this.exit } : {}),
      ...(this.crashed ? { crashed: true } : {}),
      ...(this.simulatorGone ? { simulatorQuit: true } : {}),
      ...(this.failure ? { failure: this.failure } : {}),
      logLines: this.seq,
    };
  }
}
