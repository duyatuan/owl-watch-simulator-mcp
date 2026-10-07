// End-to-end check against a real simulator. Opt in:
//
//   CIQ_MCP_LIVE=1 CIQ_MCP_LIVE_PRG=/path/app.prg CIQ_MCP_LIVE_DEVICE=fenix843mm npm run test:live
//
// It launches the app, takes a screenshot, presses a button and stops the app.

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const prg = process.env.CIQ_MCP_LIVE_PRG;
const device = process.env.CIQ_MCP_LIVE_DEVICE;
const skip = process.env.CIQ_MCP_LIVE !== '1' || !prg || !device ? 'set CIQ_MCP_LIVE=1, CIQ_MCP_LIVE_PRG and CIQ_MCP_LIVE_DEVICE' : false;

test('run, see, press, stop', { skip, timeout: 180_000 }, async () => {
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'index.js');
  const client = new Client({ name: 'live-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry] }));
  /** @param {string} name @param {Record<string, unknown>} [args] */
  const call = async (name, args = {}) => {
    const result = /** @type {any} */ (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }));
    assert.equal(result.isError ?? false, false, `${name}: ${result.content[0]?.text}`);
    return result.content;
  };
  /** @param {any[]} content */
  const png = (content) => Buffer.from(content.find((/** @type {any} */ item) => item.type === 'image').data, 'base64');
  try {
    const status = JSON.parse((await call('simulator_status'))[0].text);
    assert.equal(status.ready, true, JSON.stringify(status.problems));

    const launched = await call('run_app', { prg, device });
    assert.equal(JSON.parse(launched[0].text).app.state, 'running');
    assert.equal(png(launched).subarray(1, 4).toString(), 'PNG');

    const shot = await call('screenshot');
    const meta = JSON.parse(shot[0].text);
    assert.equal(meta.device, device);
    assert.ok(meta.width > 100 && meta.height > 100);

    const pressed = await call('press_button', { button: 'down' });
    assert.equal(png(pressed).subarray(1, 4).toString(), 'PNG');

    const stopped = JSON.parse((await call('stop_app'))[0].text);
    assert.equal(stopped.app.state, 'exited');
  } finally {
    await client.close();
  }
});
