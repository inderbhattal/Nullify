import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeHostname, normalizeAllowlist } from './hostname.js';

test('lowercases and trims plain hostnames', () => {
  assert.equal(normalizeHostname('  EXAMPLE.com  '), 'example.com');
});

test('strips scheme, path, query, fragment, port, userinfo', () => {
  assert.equal(normalizeHostname('https://Example.com:8080/foo?q=1#frag'), 'example.com');
  assert.equal(normalizeHostname('http://user:pw@example.com/'), 'example.com');
  assert.equal(normalizeHostname('//example.com/path'), 'example.com');
});

test('strips leading www on multi-label hosts', () => {
  assert.equal(normalizeHostname('www.example.com'), 'example.com');
  assert.equal(normalizeHostname('https://www.example.com/'), 'example.com');
});

test('does not strip www if remainder would be a public suffix', () => {
  // www.co.uk must NOT collapse to "co.uk" — that would allowlist every site
  // on the TLD.
  assert.equal(normalizeHostname('www.co.uk'), 'www.co.uk');
});

test('preserves www when caller opts out', () => {
  assert.equal(normalizeHostname('www.example.com', { stripWww: false }), 'www.example.com');
});

test('handles multi-label ccTLDs without collapsing to suffix', () => {
  assert.equal(normalizeHostname('news.bbc.co.uk'), 'news.bbc.co.uk');
  assert.equal(normalizeHostname('www.bbc.co.uk'), 'bbc.co.uk');
});

test('returns empty string for non-strings, empty input, malformed input', () => {
  assert.equal(normalizeHostname(null), '');
  assert.equal(normalizeHostname(undefined), '');
  assert.equal(normalizeHostname(42), '');
  assert.equal(normalizeHostname(''), '');
  assert.equal(normalizeHostname('   '), '');
});

test('strips trailing and leading dots', () => {
  assert.equal(normalizeHostname('.example.com.'), 'example.com');
  assert.equal(normalizeHostname('...example.com...'), 'example.com');
});

test('preserves IDN ascii (xn--) form', () => {
  // URL parser will leave already-encoded IDN as-is; we must not double-encode
  // or mangle it.
  assert.equal(normalizeHostname('xn--bcher-kva.example'), 'xn--bcher-kva.example');
});

test('lowercases unicode IDN inputs', () => {
  // URL parser converts unicode hostnames to punycode; we accept both as
  // canonicalised by URL.
  const result = normalizeHostname('Bücher.example');
  // Must be ascii-safe and lowercased; exact form depends on URL impl but
  // must not contain raw unicode.
  assert.match(result, /^[a-z0-9.-]+$/);
});

test('handles single-label hosts (intranet, localhost) without stripping www', () => {
  assert.equal(normalizeHostname('localhost'), 'localhost');
  assert.equal(normalizeHostname('www'), 'www'); // bare www is not a hostname; leave alone
});

test('allowlist normalisation: dedup case-insensitive, preserve insertion order', () => {
  const result = normalizeAllowlist([
    'EXAMPLE.com',
    'https://example.com/path',
    'foo.test',
    'www.bar.test',
    'foo.test', // dup
  ]);
  assert.deepEqual(result, ['example.com', 'foo.test', 'bar.test']);
});

test('allowlist normalisation: drops empties, non-strings, garbage', () => {
  const result = normalizeAllowlist([
    '',
    '   ',
    null,
    undefined,
    42,
    'good.test',
  ]);
  assert.deepEqual(result, ['good.test']);
});

test('allowlist normalisation: returns empty array for non-array input', () => {
  assert.deepEqual(normalizeAllowlist(null), []);
  assert.deepEqual(normalizeAllowlist(undefined), []);
  assert.deepEqual(normalizeAllowlist('example.com'), []);
});
