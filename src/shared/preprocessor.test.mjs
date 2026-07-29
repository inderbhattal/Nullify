import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluatePreprocessorCondition } from './filter-syntax.js';

const evaluate = (condition) => evaluatePreprocessorCondition(condition);

test('recognised capabilities are true', () => {
  assert.equal(evaluate('env_chromium'), true);
  assert.equal(evaluate('cap_dnr'), true);
});

test('other platforms are false', () => {
  assert.equal(evaluate('env_firefox'), false);
  assert.equal(evaluate('env_safari'), false);
  assert.equal(evaluate('adguard'), false);
});

// The substring heuristic got both directions wrong: `!env_chromium` CONTAINS
// `env_chromium`, so Firefox-only sections were included on Chrome; and
// `!env_mobile` contains `env_` without `env_chromium`, so desktop-applicable
// sections were excluded. Both forms are live in the lists this project fetches.
test('negation inverts rather than being swallowed by a substring match', () => {
  assert.equal(evaluate('!env_chromium'), false, 'Firefox-only must not apply to us');
  assert.equal(evaluate('!env_firefox'), true);
  assert.equal(evaluate('!env_mobile'), true, 'desktop content must not be dropped');
});

test('capabilities we lack are false, and their negation true', () => {
  // We cannot filter HTML responses under MV3, so those sections must not be
  // pulled in as garbage selectors.
  assert.equal(evaluate('cap_html_filtering'), false);
  assert.equal(evaluate('!cap_html_filtering'), true);
});

test('conjunction and disjunction', () => {
  assert.equal(evaluate('env_chromium && cap_dnr'), true);
  assert.equal(evaluate('env_chromium && env_firefox'), false);
  assert.equal(evaluate('env_firefox || env_chromium'), true);
  assert.equal(evaluate('env_firefox || env_safari'), false);
  assert.equal(evaluate('env_chromium && !cap_html_filtering'), true);
});

test('parentheses group as written', () => {
  assert.equal(evaluate('(env_firefox || env_chromium) && cap_dnr'), true);
  assert.equal(evaluate('env_firefox || (env_chromium && env_safari)'), false);
  assert.equal(evaluate('!(env_firefox || env_safari)'), true);
});

test('unknown tokens are false, so unrecognised sections are not pulled in', () => {
  assert.equal(evaluate('some_future_capability'), false);
  assert.equal(evaluate('!some_future_capability'), true);
});

test('malformed conditions are false rather than throwing', () => {
  for (const bad of ['', '   ', '&&', '(', 'env_chromium &&', '((env_chromium)']) {
    assert.equal(evaluate(bad), false, `${JSON.stringify(bad)} must not throw`);
  }
});

test('whitespace is insignificant', () => {
  assert.equal(evaluate('  env_chromium   &&   cap_dnr  '), true);
  assert.equal(evaluate('!  env_firefox'), true);
});
