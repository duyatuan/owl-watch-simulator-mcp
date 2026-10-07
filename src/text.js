// Working with the text recognised on the watch screen.
//
// Recognition is good but not perfect on small bitmap-like fonts: "O" and "0",
// or "l", "I" and "1", get swapped. Matching therefore compares a folded form
// of both sides, so `tap_text("City Circle")` still finds "Clty Clrcle".

/**
 * @typedef {import('./simulator.js').ScreenText} ScreenText
 * @typedef {ScreenText & { centerX: number, centerY: number }} TextMatch
 */

/** @param {string} value */
export function fold(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[0]/g, 'o')
    .replace(/[1l|!]/g, 'i')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Finds screen text. Exact (folded) matches win over "contains" matches.
 *
 * @param {ScreenText[]} texts
 * @param {string} query
 * @param {{ exact?: boolean }} [options]
 * @returns {TextMatch[]}
 */
export function findText(texts, query, { exact = false } = {}) {
  const wanted = fold(query);
  if (!wanted) return [];
  const withCenter = (/** @type {ScreenText} */ item) => ({
    ...item,
    centerX: Math.round(item.x + item.width / 2),
    centerY: Math.round(item.y + item.height / 2),
  });
  const equal = texts.filter((item) => fold(item.text) === wanted);
  if (equal.length > 0 || exact) return equal.map(withCenter);
  return texts.filter((item) => fold(item.text).includes(wanted)).map(withCenter);
}

/**
 * One short line per piece of text: `"Trains" (247,363)`, where the point is
 * its centre in device pixels, ready for tap.
 *
 * @param {ScreenText[]} texts
 * @returns {string[]}
 */
export function describeTexts(texts) {
  return texts
    .filter((item) => item.confidence >= 0.3 && item.text.trim() !== '')
    .map((item) => `${JSON.stringify(item.text)} (${Math.round(item.x + item.width / 2)},${Math.round(item.y + item.height / 2)})`);
}

/**
 * True for a label that opens a system file panel: "Load", "Open...", "Save Fit
 * Data", "Load File", "Browse…". The simulator's own windows have such buttons
 * (Profiler > Load, FIT/GPX playback, saving FIT data or a log). Plain words
 * that only start the same way, such as the sport "Open Water", do not count.
 *
 * @param {string} label
 */
export function opensFilePanel(label) {
  const words = label.trim().replace(/\s+/g, ' ');
  if (/(\.\.\.|…)$/.test(words) && /^(load|open|save|import|export|browse|choose)\b/i.test(words)) return true;
  if (/^(load|open|save|import|export|browse)$/i.test(words)) return true;
  if (/^save\b/i.test(words)) return true;
  return /^(load|open|import|export|browse|choose)\b.*\b(file|files|data|folder)\b/i.test(words);
}

/**
 * The recognised label a click at (x, y) would press, if it opens a file panel.
 * Recognised boxes hug the text, not the button around it, so a click
 * within `margin` points of a label counts as on it.
 *
 * @param {ScreenText[]} texts positions in the same points as x and y
 * @param {number} x
 * @param {number} y
 * @param {number} [margin]
 * @returns {ScreenText | undefined}
 */
export function filePanelLabelAt(texts, x, y, margin = 14) {
  return texts.find(
    (item) =>
      opensFilePanel(item.text) &&
      x >= item.x - margin &&
      x <= item.x + item.width + margin &&
      y >= item.y - margin / 2 &&
      y <= item.y + item.height + margin / 2,
  );
}
