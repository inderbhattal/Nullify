import test from 'node:test';
import assert from 'node:assert/strict';

import { patternToRegex, toMatcher, toRegex } from './shared-utils.js';

// Regression: patternToRegex used to return a `g`-flagged regex for plain
// string patterns. `RegExp.prototype.test` advances `lastIndex` on a global
// regex, so a matcher reused across calls alternated true/false and let every
// second matching request through (prevent-fetch, prevent-xhr,
// hide-window-error all hold one regex for the page lifetime).

test('patternToRegex: plain-string matcher is stable across repeated test() calls', () => {
  const re = patternToRegex('doubleclick');
  const url = 'https://ad.doubleclick.net/pagead';

  for (let i = 0; i < 4; i++) {
    assert.equal(re.test(url), true, `call ${i} should still match`);
  }
});

test('patternToRegex: plain-string matcher does not carry lastIndex state', () => {
  const re = patternToRegex('ads');
  assert.equal(re.global, false, 'plain-string patterns must not be global');

  re.test('https://example.com/ads.js');
  assert.equal(re.lastIndex, 0, 'test() must not advance lastIndex');
});

test('patternToRegex: escapes regex metacharacters in plain strings', () => {
  const re = patternToRegex('a.b+c');
  assert.equal(re.test('a.b+c'), true);
  assert.equal(re.test('axbbc'), false, 'metacharacters must be literal');
});

test('patternToRegex: /regex/flags syntax still parsed, and a global one is reset per call', () => {
  const re = patternToRegex('/ads?/g');
  const url = 'https://example.com/ad';

  // An author-supplied /g regex keeps its flag, but callers must still get a
  // stable answer, so the helper rewinds it.
  for (let i = 0; i < 4; i++) {
    assert.equal(re.test(url), true, `call ${i} should still match`);
  }
});

test('patternToRegex: invalid regex returns null rather than throwing', () => {
  assert.equal(patternToRegex('/[/'), null);
  assert.equal(patternToRegex(undefined), null);
});

test('toMatcher: repeated calls on a /regex/ pattern are stable', () => {
  const match = toMatcher('/gampad/g');
  for (let i = 0; i < 4; i++) {
    assert.equal(match('https://pubads.g.doubleclick.net/gampad/ads'), true, `call ${i}`);
  }
});

test('toRegex: keeps the global flag — it feeds String.replace, not test()', () => {
  assert.equal(toRegex('ad').global, true);
  assert.equal('ad ad ad'.replace(toRegex('ad'), 'x'), 'x x x');
});
