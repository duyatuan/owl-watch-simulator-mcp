import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeTexts, filePanelLabelAt, findText, fold, opensFilePanel } from '../src/text.js';

const texts = [
  { text: 'TOWN HALL STATION', confidence: 1, x: 80, y: 40, width: 250, height: 30 },
  { text: 'Clty Clrcle', confidence: 0.9, x: 100, y: 130, width: 100, height: 20 },
  { text: 'City Circle A', confidence: 0.9, x: 100, y: 240, width: 110, height: 20 },
  { text: 'Plat 6', confidence: 1, x: 300, y: 130, width: 60, height: 20 },
  { text: '', confidence: 1, x: 0, y: 0, width: 1, height: 1 },
  { text: 'noise', confidence: 0.1, x: 0, y: 0, width: 10, height: 10 },
];

test('fold absorbs the swaps text recognition makes', () => {
  assert.equal(fold('City Circle'), fold('Clty Clrcle'));
  assert.equal(fold('T0WN'), fold('TOWN'));
  assert.equal(fold('  Hold: Change Stop '), 'hoid change stop');
  assert.equal(fold('fēnix®'), 'fenix');
});

test('findText prefers exact matches and reports centres', () => {
  const exact = findText(texts, 'city circle');
  assert.equal(exact.length, 1);
  assert.deepEqual([exact[0].centerX, exact[0].centerY], [150, 140]);
  assert.equal(findText(texts, 'circle').length, 2);
  assert.equal(findText(texts, 'circle', { exact: true }).length, 0);
  assert.equal(findText(texts, 'town hall')[0].text, 'TOWN HALL STATION');
  assert.deepEqual(findText(texts, 'Bondi'), []);
  assert.deepEqual(findText(texts, ' '), []);
});

test('describeTexts drops empty and doubtful items', () => {
  assert.deepEqual(describeTexts(texts), ['"TOWN HALL STATION" (205,55)', '"Clty Clrcle" (150,140)', '"City Circle A" (155,250)', '"Plat 6" (330,140)']);
});

test('opensFilePanel knows the labels that open a system file panel', () => {
  for (const label of ['Load', 'Open...', 'Save', 'Save As…', 'Save Fit Data', 'Load File', 'Open File', 'Browse', 'Export', ' save  log ']) {
    assert.equal(opensFilePanel(label), true, label);
  }
  for (const label of ['Open Water', 'Cancel', 'OK', 'Start', 'Refresh', 'Clear History', 'Loading', 'Downloaded', 'Send']) {
    assert.equal(opensFilePanel(label), false, label);
  }
});

test('filePanelLabelAt finds the label under a click, with a margin for the button', () => {
  // The Profiler window's bottom row: Load and Start buttons, labels only recognised.
  const profiler = [
    { text: 'Load', confidence: 1, x: 1052, y: 550, width: 30, height: 16 },
    { text: 'Start', confidence: 1, x: 1138, y: 550, width: 33, height: 16 },
  ];
  assert.equal(filePanelLabelAt(profiler, 1067, 558)?.text, 'Load');
  assert.equal(filePanelLabelAt(profiler, 1040, 552)?.text, 'Load');
  assert.equal(filePanelLabelAt(profiler, 1154, 558), undefined);
  assert.equal(filePanelLabelAt(profiler, 1067, 500), undefined);
  assert.equal(filePanelLabelAt([], 10, 10), undefined);
});
