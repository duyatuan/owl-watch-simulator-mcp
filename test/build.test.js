import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findJungle, parseDiagnostics } from '../src/build.js';

test('parseDiagnostics reads located and bare messages', () => {
  const output = [
    'WARNING: fenix7: /p/source/View.mc:40: Unable to detect scope for the symbol reference \'foo\'.',
    "ERROR: fenix843mm: /p/source/Metrics.mc:3: missing '}' at '<EOF>'",
    'ERROR: fenix843mm: /p/source/My View.mc:12,8: Undefined symbol ":x" detected.',
    'ERROR: A device must be specified.',
    '1 OUT OF 1 DEVICES BUILT',
    'BUILD FAILED',
  ].join('\n');
  assert.deepEqual(parseDiagnostics(output), [
    { severity: 'warning', message: "Unable to detect scope for the symbol reference 'foo'.", file: '/p/source/View.mc', line: 40, device: 'fenix7' },
    { severity: 'error', message: "missing '}' at '<EOF>'", file: '/p/source/Metrics.mc', line: 3, device: 'fenix843mm' },
    { severity: 'error', message: 'Undefined symbol ":x" detected.', file: '/p/source/My View.mc', line: 12, column: 8, device: 'fenix843mm' },
    { severity: 'error', message: 'A device must be specified.' },
  ]);
  assert.deepEqual(parseDiagnostics('BUILD SUCCESSFUL\n'), []);
});

test('findJungle prefers monkey.jungle and explains a non-project', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ciq-build-'));
  try {
    await assert.rejects(findJungle(dir), { code: 'project_not_found' });
    await writeFile(path.join(dir, 'barrels.jungle'), '');
    assert.equal(await findJungle(dir), path.join(dir, 'barrels.jungle'));
    await writeFile(path.join(dir, 'monkey.jungle'), '');
    assert.equal(await findJungle(dir), path.join(dir, 'monkey.jungle'));
    await assert.rejects(findJungle(path.join(dir, 'nope')), { code: 'project_not_found' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
