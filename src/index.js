#!/usr/bin/env node
// Entry point: an MCP server on stdio, plus `--doctor` for a human-readable check.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { describeError } from './errors.js';
import { runHelper, stopHelper } from './helper.js';
import { locateDeveloperKey, locateJava, locateSdk } from './sdk.js';
import { createContext, createServer, VERSION } from './server.js';
import { PERMISSION_HINT } from './simulator.js';

const argv = process.argv.slice(2);

if (argv.includes('--version') || argv.includes('-v')) {
  console.log(VERSION);
} else if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`owl-connectiq-simulator-mcp ${VERSION}

Usage:
  owl-connectiq-simulator-mcp            run the MCP server on stdio
  owl-connectiq-simulator-mcp --doctor   check SDK, Java, developer key, helper and permissions

Environment:
  CIQ_SDK_HOME        Connect IQ SDK directory (default: the SDK Manager's current SDK)
  CIQ_JAVA_HOME       JDK to use (default: JAVA_HOME, PATH, /usr/libexec/java_home, Homebrew)
  CIQ_DEVELOPER_KEY   developer_key.der (default: VS Code setting, common locations)
  CIQ_DEVICES_DIR     device definitions (default: the SDK Manager's Devices directory)`);
} else if (argv.includes('--doctor')) {
  process.exitCode = (await doctor()) ? 0 : 1;
  stopHelper();
} else {
  await serve();
}

async function serve() {
  if (process.platform !== 'darwin') {
    console.error('owl-connectiq-simulator-mcp only supports macOS.');
    process.exit(1);
  }
  const context = createContext();
  const server = createServer(context);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await context.shutdown().catch(() => undefined);
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
  // The client closing our stdin is the normal way an MCP server is stopped.
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  // A bug in one tool call must not take the whole server down mid-session.
  process.on('uncaughtException', (error) => console.error('[owl-connectiq-simulator-mcp] uncaught exception:', error));
  process.on('unhandledRejection', (error) => console.error('[owl-connectiq-simulator-mcp] unhandled rejection:', error));
  await server.connect(new StdioServerTransport());
  // Start the helper now so its text recognition model is loaded by first use.
  runHelper('version').catch(() => undefined);
}

async function doctor() {
  let healthy = true;
  /** @param {string} label @param {() => Promise<string>} check @param {boolean} [required] */
  const step = async (label, check, required = true) => {
    try {
      console.log(`ok    ${label}: ${await check()}`);
    } catch (error) {
      const { message, hint } = describeError(error);
      console.log(`${required ? 'FAIL ' : 'warn '} ${label}: ${message}${hint ? `\n      ${hint}` : ''}`);
      if (required) healthy = false;
    }
  };
  await step('Connect IQ SDK', async () => {
    const sdk = await locateSdk();
    return `${sdk.version} at ${sdk.home}`;
  });
  await step('Java', () => locateJava());
  await step('Developer key', () => locateDeveloperKey(), false);
  /** @type {any} */
  let status;
  await step('Native helper', async () => {
    status = await runHelper('status');
    return `version ${status.helperVersion}`;
  });
  if (status) {
    const permission = (/** @type {boolean} */ granted) => async () => {
      if (!granted) throw Object.assign(new Error(`not granted. ${PERMISSION_HINT}`));
      return 'granted';
    };
    await step('Accessibility permission', permission(status.accessibility));
    await step('Screen Recording permission', permission(status.screenRecording));
    await step('Background input', async () => {
      if (!status.backgroundClicks) throw new Error('not supported by this macOS release');
      return 'supported';
    });
    console.log(`info  Simulator: ${status.simulator ? `running (pid ${status.simulator.pid})` : 'not running'}`);
    console.log(`info  Screen: ${status.screenLocked ? 'locked' : 'unlocked'}`);
  }
  console.log(healthy ? '\nReady.' : '\nNot ready: fix the FAIL lines above.');
  return healthy;
}
