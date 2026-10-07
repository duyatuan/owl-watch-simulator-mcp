import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { AppSession, parseTestSummary } from '../src/session.js';

const sdk = /** @type {any} */ ({ jar: '/sdk/bin/monkeybrains.jar', shell: '/sdk/bin/shell' });

/**
 * A session whose "monkeydo" is a small Node script.
 * @param {string} script
 */
function sessionRunning(script) {
  /** @type {string[][]} */
  const calls = [];
  const session = new AppSession({
    sdk,
    java: async () => 'java',
    spawnProcess: /** @type {any} */ ((/** @type {string} */ _command, /** @type {string[]} */ args, /** @type {any} */ options) => {
      calls.push(args);
      return spawn(process.execPath, ['-e', script], options);
    }),
  });
  return { session, calls };
}

test('parseTestSummary', () => {
  assert.deepEqual(parseTestSummary('RESULTS\nfoo PASS\nPASSED (passed=3, failed=0 , errors=0)'), { success: true, passed: 3, failed: 0, errors: 0 });
  assert.deepEqual(parseTestSummary('FAILED (passed=1, failed=2 , errors=1)'), { success: false, passed: 1, failed: 2, errors: 1 });
  assert.deepEqual(parseTestSummary('Ran 2 tests\n\nFAILED (passed=1, failed=1, errors=0)'), { success: false, passed: 1, failed: 1, errors: 0 });
  assert.equal(parseTestSummary('nothing'), undefined);
});

test('collects output line by line and records the exit', async () => {
  const { session, calls } = sessionRunning("process.stdout.write('one\\ntw'); setTimeout(() => { process.stdout.write('o\\nthree'); console.error('oops'); }, 50);");
  await session.start({ prg: '/app.prg', device: 'fenix7' });
  assert.equal(session.state, 'running');
  assert.equal(await session.settle(5000), 'exited');
  assert.deepEqual(calls[0].slice(2), ['com.garmin.monkeybrains.monkeydodeux.MonkeyDoDeux', '-f', '/app.prg', '-d', 'fenix7', '-s', '/sdk/bin/shell']);
  const { lines, lastSeq } = session.logs();
  assert.deepEqual(lines.filter((l) => l.stream === 'stdout').map((l) => l.text), ['one', 'two', 'three']);
  assert.deepEqual(lines.filter((l) => l.stream === 'stderr').map((l) => l.text), ['oops']);
  assert.equal(lastSeq, 4);
  assert.equal(session.info().exit?.code, 0);
  assert.deepEqual(session.logs({ sinceSeq: lastSeq }).lines, []);
  assert.equal(session.logs({ limit: 1 }).omitted, 3);
  session.assertLaunched();
});

test('passes test names and recognises launch failures and crashes', async () => {
  const { session, calls } = sessionRunning("console.log('Unable to connect to simulator.'); process.exit(1)");
  await session.start({ prg: '/app.prg', device: 'fenix7', tests: ['testA', 'testB'] });
  await session.settle(5000);
  assert.deepEqual(calls[0].slice(-3), ['-t', 'testA', 'testB']);
  assert.throws(() => session.assertLaunched(), { code: 'simulator_unreachable' });

  const crash = sessionRunning("console.log('Error: Unexpected Type Error'); console.log('Encountered an app crash.')");
  await crash.session.start({ prg: '/app.prg', device: 'fenix7' });
  await crash.session.settle(5000);
  assert.equal(crash.session.info().crashed, true);
  crash.session.assertLaunched(); // a crash is the app's failure, not the launch's
});

test('a missing java binary is reported, not thrown', async () => {
  const session = new AppSession({ sdk, java: async () => '/nonexistent/java' });
  await session.start({ prg: '/app.prg', device: 'fenix7' });
  await session.settle(5000);
  assert.throws(() => session.assertLaunched(), { code: 'monkeydo_failed' });
});

test('detach stops a running process, and a new start replaces the old one', async () => {
  const { session } = sessionRunning("console.log('up'); setInterval(() => {}, 1000)");
  await session.start({ prg: '/a.prg', device: 'fenix7' });
  assert.equal(await session.settle(300), 'running');
  const first = session.child;
  await session.start({ prg: '/b.prg', device: 'fenix7' });
  assert.notEqual(first?.signalCode ?? first?.exitCode, null);
  assert.equal(session.info().prg, '/b.prg');
  assert.equal(session.state, 'running');
  await session.detach();
  assert.equal(session.state, 'exited');
});

test('the log buffer is bounded', () => {
  const { session } = sessionRunning('');
  for (let i = 0; i < 5100; i += 1) session.record('stdout', `line ${i}`);
  const logs = session.logs({ limit: 2000 });
  assert.equal(logs.lines.length, 2000);
  assert.equal(logs.droppedFromBuffer, 100);
  assert.equal(logs.lines.at(-1)?.text, 'line 5099');
  session.record('stdout', 'x'.repeat(10_000));
  assert.ok((session.logs({ limit: 1 }).lines[0].text.length ?? 0) < 4100);
});

test('ends the session when the simulator quits under it', async () => {
  let simulatorUp = true;
  const session = new AppSession({
    sdk,
    java: async () => 'java',
    alive: (pid) => pid === 4242 && simulatorUp,
    checkMs: 20,
    spawnProcess: /** @type {any} */ ((/** @type {string} */ _c, /** @type {string[]} */ _a, /** @type {any} */ options) =>
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options)),
  });
  await session.start({ prg: '/app.prg', device: 'fenix7', simulatorPid: 4242 });
  assert.equal(await session.settle(100), 'running');
  simulatorUp = false;
  assert.equal(await session.settle(5000), 'exited');
  assert.equal(session.info().simulatorQuit, true);
  assert.match(session.tail(1)[0], /simulator quit/);
});

test('a session without a simulator pid is not watched', async () => {
  const session = new AppSession({
    sdk,
    java: async () => 'java',
    alive: () => false,
    checkMs: 20,
    spawnProcess: /** @type {any} */ ((/** @type {string} */ _c, /** @type {string[]} */ _a, /** @type {any} */ options) =>
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options)),
  });
  await session.start({ prg: '/app.prg', device: 'fenix7' });
  assert.equal(await session.settle(150), 'running');
  await session.detach();
  assert.equal(session.state, 'exited');
});
