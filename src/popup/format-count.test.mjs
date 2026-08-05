import assert from 'node:assert/strict';
import test from 'node:test';

import { formatStatCount, COUNT_DISPLAY_CAP } from './format-count.js';

test('a count that fits the tile is shown in full, with no tooltip', () => {
  for (const n of [0, 1, 42, 999, COUNT_DISPLAY_CAP]) {
    const { text, title } = formatStatCount(n);
    assert.equal(text, String(n));
    assert.equal(title, null, `${n} must not need a tooltip`);
  }
});

test('a count past the cap is capped in the label and exact on hover', () => {
  const { text, title } = formatStatCount(COUNT_DISPLAY_CAP + 1);
  assert.equal(text, '1000+');
  assert.match(title, /1,001/, 'the tooltip must carry the exact figure');
});

test('the tooltip groups digits — the exact value is the point of hovering', () => {
  assert.match(formatStatCount(12345).title, /12,345/);
  assert.equal(formatStatCount(12345).text, '1000+');
});

test('the cap is a boundary, not a range: 1000 is shown, 1001 is capped', () => {
  assert.equal(formatStatCount(1000).text, '1000');
  assert.equal(formatStatCount(1000).title, null);
  assert.equal(formatStatCount(1001).text, '1000+');
});

test('junk from the bus renders as 0 rather than NaN or undefined', () => {
  // `dailyTotal?.total` is undefined whenever the worker answers with an
  // unexpected shape; the tile must not read "NaN".
  for (const bad of [undefined, null, NaN, Infinity, -5, '900', {}]) {
    assert.equal(formatStatCount(bad).text, '0', `${String(bad)} must render as 0`);
  }
});

test('a fractional count is truncated, not rounded up past the cap', () => {
  assert.equal(formatStatCount(999.9).text, '999');
  assert.equal(formatStatCount(1000.9).text, '1000');
});
