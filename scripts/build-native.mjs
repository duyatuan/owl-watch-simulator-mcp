#!/usr/bin/env node
// Compiles native/helper.swift. Runs on `npm install` (with --if-possible, so a
// machine without swiftc still installs; the server then explains what to do)
// and on demand with `npm run build:native`.

import { buildHelper } from '../src/helper.js';

const lenient = process.argv.includes('--if-possible');
try {
  if (process.platform !== 'darwin') throw new Error('connectiq-simulator-mcp only supports macOS');
  console.log(`built ${await buildHelper()}`);
} catch (error) {
  console.error(`connectiq-simulator-mcp: ${error.message}${error.hint ? `\n  ${error.hint}` : ''}`);
  process.exit(lenient ? 0 : 1);
}
