// Finds the Connect IQ SDK, a Java runtime and the developer key on this machine.

import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CiqError } from './errors.js';

const execFileAsync = promisify(execFile);

/** @param {string} file */
export async function exists(file) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function connectIqDataDir() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Garmin', 'ConnectIQ');
}

/**
 * @typedef {object} Sdk
 * @property {string} home
 * @property {string} bin
 * @property {string} version
 * @property {string} simulatorApp   ConnectIQ.app
 * @property {string} shell          the `shell` binary monkeydo talks through
 * @property {string} jar            monkeybrains.jar
 * @property {string} devicesDir
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Sdk>}
 */
export async function locateSdk(env = process.env) {
  const dataDir = connectIqDataDir();
  /** @type {string | undefined} */
  let home = env.CIQ_SDK_HOME?.trim() || undefined;
  let source = 'CIQ_SDK_HOME';
  if (!home) {
    source = 'the SDK Manager';
    try {
      home = (await readFile(path.join(dataDir, 'current-sdk.cfg'), 'utf8')).trim();
    } catch {
      throw new CiqError('sdk_not_found', 'No Connect IQ SDK is installed (current-sdk.cfg is missing).', {
        hint: 'Install an SDK with the Garmin SDK Manager, or set CIQ_SDK_HOME to an SDK directory.',
      });
    }
  }
  home = home.replace(/\/+$/, '');
  const bin = path.join(home, 'bin');
  const jar = path.join(bin, 'monkeybrains.jar');
  if (!(await exists(jar))) {
    throw new CiqError('sdk_not_found', `The Connect IQ SDK selected by ${source} is incomplete: ${jar} does not exist.`, {
      hint: 'Open the Garmin SDK Manager and select an installed SDK, or fix CIQ_SDK_HOME.',
    });
  }
  let version = 'unknown';
  try {
    version = (await readFile(path.join(bin, 'version.txt'), 'utf8')).trim();
  } catch {
    const match = /connectiq-sdk-[a-z]+-(\d+\.\d+\.\d+)/.exec(home);
    if (match) version = match[1];
  }
  return {
    home,
    bin,
    version,
    simulatorApp: path.join(bin, 'ConnectIQ.app'),
    shell: path.join(bin, 'shell'),
    jar,
    devicesDir: env.CIQ_DEVICES_DIR?.trim() || path.join(dataDir, 'Devices'),
  };
}

/** @param {string} java */
async function javaWorks(java) {
  try {
    // /usr/bin/java exists on every Mac but is a stub that fails without a JDK.
    await execFileAsync(java, ['-version'], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** @type {Promise<string> | undefined} */
let javaPromise;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string>} path of a working `java`
 */
export function locateJava(env = process.env) {
  javaPromise ??= findJava(env).catch((error) => {
    javaPromise = undefined;
    throw error;
  });
  return javaPromise;
}

/** @param {NodeJS.ProcessEnv} env */
async function findJava(env) {
  /** @type {string[]} */
  const candidates = [];
  for (const home of [env.CIQ_JAVA_HOME, env.JAVA_HOME]) {
    if (home?.trim()) candidates.push(path.join(home.trim(), 'bin', 'java'));
  }
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir && dir !== '/usr/bin') candidates.push(path.join(dir, 'java'));
  }
  try {
    const { stdout } = await execFileAsync('/usr/libexec/java_home', [], { timeout: 15_000 });
    if (stdout.trim()) candidates.push(path.join(stdout.trim(), 'bin', 'java'));
  } catch {
    // no system JDK registered
  }
  for (const prefix of ['/opt/homebrew/opt', '/usr/local/opt']) {
    try {
      const names = (await readdir(prefix)).filter((name) => /^openjdk(@\d+)?$/.test(name));
      // Newest first; plain "openjdk" is the current release.
      names.sort((a, b) => Number(b.split('@')[1] ?? 999) - Number(a.split('@')[1] ?? 999));
      for (const name of names) candidates.push(path.join(prefix, name, 'bin', 'java'));
    } catch {
      // no Homebrew here
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    if ((await exists(candidate)) && (await javaWorks(candidate))) return candidate;
  }
  throw new CiqError('java_not_found', 'No working Java runtime was found. The Connect IQ compiler and monkeydo need one.', {
    hint: 'Install a JDK (for example `brew install openjdk@21`) and set JAVA_HOME or CIQ_JAVA_HOME.',
  });
}

/**
 * @param {string} [explicit]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string>}
 */
export async function locateDeveloperKey(explicit, env = process.env) {
  const home = os.homedir();
  const expand = (/** @type {string} */ file) => (file.startsWith('~/') ? path.join(home, file.slice(2)) : file);
  if (explicit) {
    const file = expand(explicit);
    if (await exists(file)) return file;
    throw new CiqError('developer_key_not_found', `The developer key ${file} does not exist.`);
  }
  /** @type {string[]} */
  const candidates = [];
  if (env.CIQ_DEVELOPER_KEY?.trim()) candidates.push(expand(env.CIQ_DEVELOPER_KEY.trim()));
  // The Monkey C extension for VS Code stores the key path in user settings.
  for (const editor of ['Code', 'Code - Insiders', 'Cursor', 'VSCodium']) {
    try {
      const settings = await readFile(path.join(home, 'Library', 'Application Support', editor, 'User', 'settings.json'), 'utf8');
      const match = /"monkeyC\.developerKeyPath"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(settings);
      if (match) candidates.push(expand(JSON.parse(`"${match[1]}"`)));
    } catch {
      // editor not installed or setting absent
    }
  }
  candidates.push(
    path.join(home, '.garmin-keys', 'developer_key.der'),
    path.join(home, '.Garmin', 'ConnectIQ', 'developer_key.der'),
    path.join(connectIqDataDir(), 'developer_key.der'),
    path.join(home, 'developer_key.der'),
  );
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new CiqError('developer_key_not_found', 'No Connect IQ developer key was found.', {
    hint: 'Pass developerKey, or set CIQ_DEVELOPER_KEY to your developer_key.der.',
  });
}
