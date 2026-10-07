#!/usr/bin/env node
// A stand-in for native/helper.swift in `serve` mode, for unit tests of the
// simulator-side logic without a simulator, a display or any permission.
//
// Each request is answered from the JSON state file named by FAKE_HELPER_STATE,
// read afresh every time so a test can change the world between calls, and
// appended to FAKE_HELPER_LOG as one JSON line so the test can see what was sent.

import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.argv[2] !== 'serve') {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code: 'bad_arguments', message: 'fake helper: serve only' } })}\n`);
  process.exit(1);
}

const state = () => JSON.parse(readFileSync(String(process.env.FAKE_HELPER_STATE), 'utf8'));

/** @param {string} command @param {any} args */
function answer(command, args) {
  const world = state();
  const simulator = world.simulator ?? null;
  const fail = world.fail?.[command];
  if (fail) return { ok: false, error: fail };
  switch (command) {
    case 'status':
      return { ok: true, accessibility: true, screenRecording: true, backgroundClicks: true, screenLocked: Boolean(world.screenLocked), simulator };
    case 'locate': {
      const queue = world.locate ?? [{ found: true, offsetX: 0, offsetY: 28, imageWidth: 603, imageHeight: 800, score: 1 }];
      // The nth locate since the log was last cleared gets the nth answer.
      const count = readFileSync(String(process.env.FAKE_HELPER_LOG), 'utf8').split('\n').filter((l) => l.includes('"command":"locate"')).length;
      return { ok: true, ...queue[Math.min(count - 1, queue.length - 1)] };
    }
    case 'mouse':
      return { ok: true, events: args.steps.length };
    case 'capture':
      return { ok: true, path: args.out, width: 1, height: 1, scale: 1, screenLocked: Boolean(world.screenLocked), texts: world.texts?.[args.windowId] ?? [] };
    case 'window':
      return { ok: true, windows: (simulator?.windows ?? []).map((w) => (w.kind === 'device' && args.action === 'resize' ? { ...w, width: args.width, height: args.height } : w)) };
    case 'menu-press':
      return { ok: true, windows: simulator?.windows ?? [] };
    default:
      return { ok: false, error: { code: 'bad_arguments', message: `fake helper: no '${command}'` } };
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, command, args } = JSON.parse(line);
  appendFileSync(String(process.env.FAKE_HELPER_LOG), `${JSON.stringify({ command, args })}\n`);
  const reply = answer(command, args ?? {});
  process.stdout.write(`${JSON.stringify({ id, ...reply })}\n`);
});
