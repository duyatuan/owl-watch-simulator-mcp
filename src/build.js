// Compiles a Connect IQ project with the SDK's compiler (monkeyc).

import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { CiqError } from './errors.js';
import { exists, locateDeveloperKey } from './sdk.js';

const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * @typedef {{ severity: 'error' | 'warning', message: string, file?: string, line?: number, column?: number, device?: string }} Diagnostic
 */

/**
 * Parses compiler output. Lines look like
 *   ERROR: fenix843mm: /path/View.mc:12,8: Undefined symbol ...
 *   WARNING: fenix843mm: /path/View.mc:40: ...
 *   ERROR: A device must be specified.
 *
 * @param {string} output
 * @returns {Diagnostic[]}
 */
export function parseDiagnostics(output) {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  for (const raw of output.split(/\r?\n/)) {
    const head = /^(ERROR|WARNING): (.*)$/.exec(raw.trim());
    if (!head) continue;
    const severity = head[1] === 'ERROR' ? 'error' : 'warning';
    const located = /^(?:([A-Za-z0-9_.-]+): )?(.+?\.[A-Za-z0-9]+):(\d+)(?:,(\d+))?: (.*)$/.exec(head[2]);
    if (located) {
      diagnostics.push({
        severity,
        message: located[5],
        file: located[2],
        line: Number(located[3]),
        ...(located[4] ? { column: Number(located[4]) } : {}),
        ...(located[1] ? { device: located[1] } : {}),
      });
    } else {
      diagnostics.push({ severity, message: head[2] });
    }
  }
  return diagnostics;
}

/** @param {string} projectDir */
export async function findJungle(projectDir) {
  const preferred = path.join(projectDir, 'monkey.jungle');
  if (await exists(preferred)) return preferred;
  let names = [];
  try {
    names = (await readdir(projectDir)).filter((name) => name.endsWith('.jungle')).sort();
  } catch {
    throw new CiqError('project_not_found', `The project directory ${projectDir} does not exist.`);
  }
  if (names.length === 0) {
    throw new CiqError('project_not_found', `${projectDir} has no monkey.jungle, so it is not a Connect IQ project.`);
  }
  return path.join(projectDir, names[0]);
}

/**
 * @param {object} options
 * @param {import('./sdk.js').Sdk} options.sdk
 * @param {string} options.java
 * @param {string} options.projectDir
 * @param {string} options.device
 * @param {string} [options.output]
 * @param {string} [options.jungle]
 * @param {string} [options.developerKey]
 * @param {boolean} [options.release]
 * @param {boolean} [options.unitTests]
 * @param {number} [options.typeCheckLevel] 0-3
 * @param {boolean} [options.warnings]
 * @param {string[]} [options.extraArgs]
 * @param {number} [options.timeoutMs]
 */
export async function buildApp(options) {
  const projectDir = path.resolve(options.projectDir);
  const jungle = options.jungle ? path.resolve(projectDir, options.jungle) : await findJungle(projectDir);
  if (!(await exists(jungle))) throw new CiqError('project_not_found', `${jungle} does not exist.`);
  if (!/^[A-Za-z0-9_.-]+$/.test(options.device)) throw new CiqError('unknown_device', `'${options.device}' is not a valid device id.`);
  const key = await locateDeveloperKey(options.developerKey);
  const name = path.basename(projectDir).replace(/[^A-Za-z0-9_.-]+/g, '-') || 'app';
  const output = options.output
    ? path.resolve(projectDir, options.output)
    : path.join(projectDir, 'bin', `${name}-${options.device}${options.unitTests ? '-test' : ''}.prg`);
  await mkdir(path.dirname(output), { recursive: true });

  const args = [
    '-Xms1g',
    '-Dfile.encoding=UTF-8',
    '-Dapple.awt.UIElement=true',
    '-classpath',
    options.sdk.jar,
    'com.garmin.monkeybrains.Monkeybrains',
    '-o',
    output,
    '-f',
    jungle,
    '-y',
    key,
    '-d',
    options.device,
  ];
  if (options.warnings !== false) args.push('-w');
  if (options.release) args.push('-r');
  if (options.unitTests) args.push('-t');
  if (options.typeCheckLevel !== undefined) args.push('-l', String(options.typeCheckLevel));
  if (options.extraArgs) args.push(...options.extraArgs);

  const started = Date.now();
  const { code, output: text, timedOut } = await run(options.java, args, projectDir, options.timeoutMs ?? 300_000);
  if (timedOut) throw new CiqError('build_timeout', 'The compiler did not finish in time.');
  const diagnostics = parseDiagnostics(text);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');
  const success = code === 0 && (await exists(output));
  return {
    success,
    ...(success ? { prg: output } : {}),
    device: options.device,
    durationMs: Date.now() - started,
    errors,
    warningCount: warnings.length,
    warnings: warnings.slice(0, 30),
    // When the build fails without a parseable error, the raw tail is all there is.
    ...(!success && errors.length === 0 ? { output: text.trim().split('\n').slice(-40).join('\n') } : {}),
  };
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} timeoutMs
 * @returns {Promise<{ code: number | null, output: string, timedOut: boolean }>}
 */
function run(command, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const append = (/** @type {Buffer} */ chunk) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString('utf8');
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new CiqError('build_failed', `Could not run the compiler: ${error.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}
