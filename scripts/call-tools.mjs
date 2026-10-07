#!/usr/bin/env node
// Development aid: starts the server and calls tools in sequence over real MCP.
//
//   node scripts/call-tools.mjs [--out DIR] tool '{"json":"args"}' [tool '{...}' ...]
//
// Text results are printed; images are written to DIR (default: a fresh
// folder in the system temp directory, printed at the start) as <n>-<tool>.png.

import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const argv = process.argv.slice(2);
let outDir;
if (argv[0] === '--out') {
  outDir = path.resolve(argv[1]);
  argv.splice(0, 2);
} else {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'call-tools-'));
  console.log(`images go to ${outDir}`);
}
const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const client = new Client({ name: 'call-tools', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'inherit' }));
let failed = false;
try {
  if (argv.length === 0) {
    for (const tool of (await client.listTools()).tools) console.log(`${tool.name}: ${tool.description}\n`);
  }
  for (let i = 0, n = 1; i < argv.length; i += 2, n += 1) {
    const name = argv[i];
    const args = argv[i + 1] ? JSON.parse(argv[i + 1]) : {};
    const started = Date.now();
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
    console.log(`\n=== ${n}. ${name} ${JSON.stringify(args)} (${Date.now() - started} ms)${result.isError ? ' ERROR' : ''}`);
    if (result.isError) failed = true;
    let images = 0;
    for (const item of result.content) {
      if (item.type === 'text') console.log(item.text);
      if (item.type === 'image') {
        images += 1;
        const file = path.join(outDir, `${n}-${name}${images > 1 ? `-${images}` : ''}.png`);
        await writeFile(file, Buffer.from(item.data, 'base64'));
        console.log(`[image ${file}]`);
      }
    }
  }
} finally {
  await client.close();
}
process.exit(failed ? 1 : 0);
