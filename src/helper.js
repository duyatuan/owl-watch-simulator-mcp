// Locates, builds and runs the native helper (native/helper.swift).

import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, rename, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CiqError } from './errors.js';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const helperSource = path.join(packageRoot, 'native', 'helper.swift');

/** @param {string} file */
async function mtime(file) {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Compiles the helper. Tries the package directory first and falls back to the
 * user cache when the package is installed somewhere read-only.
 *
 * @returns {Promise<string>} path of the compiled helper
 */
export async function buildHelper() {
  if (process.platform !== 'darwin') {
    throw new CiqError('unsupported_platform', 'connectiq-simulator-mcp only supports macOS.');
  }
  const targets = [
    path.join(packageRoot, 'native', 'bin'),
    path.join(os.homedir(), 'Library', 'Caches', 'connectiq-simulator-mcp'),
  ];
  /** @type {unknown} */
  let lastError;
  for (const dir of targets) {
    const output = path.join(dir, 'ciq-sim-helper');
    const staging = `${output}.${process.pid}.tmp`;
    try {
      await mkdir(dir, { recursive: true });
      await execFileAsync('xcrun', ['swiftc', '-O', helperSource, '-o', staging], { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
      await rename(staging, output); // atomic: a concurrent reader never sees half a binary
      return output;
    } catch (error) {
      lastError = error;
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code !== 'EACCES' && code !== 'EROFS' && code !== 'EPERM') break;
    }
  }
  const detail = /** @type {{ stderr?: string, message?: string }} */ (lastError);
  throw new CiqError('helper_build_failed', `Could not compile the native helper: ${(detail?.stderr || detail?.message || '').trim().slice(0, 2000)}`, {
    hint: 'The helper is compiled with swiftc. Install the Xcode Command Line Tools: xcode-select --install',
  });
}

/** @type {Promise<string> | undefined} */
let helperPromise;

/** @returns {Promise<string>} path of an up-to-date helper, building it if needed */
export function helperPath() {
  helperPromise ??= resolveHelper().catch((error) => {
    helperPromise = undefined;
    throw error;
  });
  return helperPromise;
}

async function resolveHelper() {
  if (process.env.CIQ_MCP_HELPER?.trim()) return process.env.CIQ_MCP_HELPER.trim();
  const sourceTime = await mtime(helperSource);
  for (const candidate of [
    path.join(packageRoot, 'native', 'bin', 'ciq-sim-helper'),
    path.join(os.homedir(), 'Library', 'Caches', 'connectiq-simulator-mcp', 'ciq-sim-helper'),
  ]) {
    const builtTime = await mtime(candidate);
    if (builtTime !== undefined && (sourceTime === undefined || builtTime >= sourceTime)) return candidate;
  }
  return buildHelper();
}

/** What to do about the helper errors a caller can fix. */
const HINTS = /** @type {Record<string, string>} */ ({
  dialog_not_inspectable: 'Use the picture from inspect_dialogs with dialog_click and dialog_type instead.',
  window_minimized: 'Restore the simulator window (click it in the Dock) and try again.',
  simulator_not_running: 'Call run_app (which starts it) or start_simulator.',
});

/**
 * The helper running in `serve` mode: one long-lived process answering JSON
 * requests, so the text recognition model is loaded once, not on every call.
 */
class HelperProcess {
  constructor() {
    /** @type {import('node:child_process').ChildProcess | undefined} */
    this.child = undefined;
    /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }>} */
    this.pending = new Map();
    this.nextId = 1;
  }

  /** @param {string} helper */
  start(helper) {
    const child = spawn(helper, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    // Never keep the host process alive just because the helper is idle: a
    // request in flight holds the event loop open through its timer.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) /** @type {any} */ (stream)?.unref?.();
    child.stdin?.on('error', () => undefined); // EPIPE if it died; the exit handler reports it
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    createInterface({ input: /** @type {import('node:stream').Readable} */ (child.stdout) }).on('line', (line) => {
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        return;
      }
      const request = this.pending.get(reply?.id);
      if (!request) return;
      this.pending.delete(reply.id);
      clearTimeout(request.timer);
      request.resolve(reply);
    });
    const gone = (/** @type {string} */ why) => {
      if (this.child === child) this.child = undefined;
      for (const [id, request] of this.pending) {
        this.pending.delete(id);
        clearTimeout(request.timer);
        request.reject(new CiqError('helper_restarted', `The native helper stopped (${why}). ${stderr.trim().slice(-500)}`.trim()));
      }
    };
    child.once('error', (error) => gone(error.message));
    child.once('exit', (code, signal) => gone(signal ?? `exit ${code}`));
  }

  /**
   * @param {string} helper
   * @param {string} command
   * @param {Record<string, unknown>} args
   * @param {number} timeoutMs
   * @returns {Promise<any>}
   */
  request(helper, command, args, timeoutMs) {
    if (!this.child || this.child.exitCode !== null || this.child.killed) this.start(helper);
    const child = /** @type {import('node:child_process').ChildProcess} */ (this.child);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A helper that stopped answering is not trusted with the next request.
        child.kill('SIGKILL');
        reject(
          new CiqError('helper_timeout', `The simulator did not answer '${command}' within ${Math.round(timeoutMs / 1000)} s.`, {
            hint: 'The simulator may be hung or showing a dialog that blocks it. Check simulator_status, or stop and start the simulator.',
          }),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin?.write(`${JSON.stringify({ id, command, args })}\n`);
    });
  }

  stop() {
    this.child?.kill('SIGKILL');
    this.child = undefined;
  }
}

const helperProcess = new HelperProcess();

/** Stops the long-lived helper (it also exits by itself when this process does). */
export function stopHelper() {
  helperProcess.stop();
}

/**
 * Runs one helper command.
 *
 * @param {string} command
 * @param {Record<string, unknown>} [args]
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<any>} the helper's result object
 */
export async function runHelper(command, args = {}, options = {}) {
  const helper = await helperPath();
  const timeoutMs = options.timeoutMs ?? 20_000;
  let result;
  for (let attempt = 0; ; attempt += 1) {
    try {
      result = await helperProcess.request(helper, command, args, timeoutMs);
      break;
    } catch (error) {
      // The helper died under another request, or its binary vanished: start
      // a fresh one once before giving up.
      if (!(error instanceof CiqError) || error.code !== 'helper_restarted' || attempt >= 1) {
        if (error instanceof CiqError && error.code === 'helper_restarted') helperPromise = undefined;
        throw error;
      }
    }
  }
  if (result?.ok === true) return result;
  const { code = 'helper_failed', message = 'unknown helper error', ...details } = result?.error ?? {};
  const hint = HINTS[String(code)];
  throw new CiqError(String(code), String(message), { ...(hint ? { hint } : {}), ...(Object.keys(details).length ? { details } : {}) });
}
