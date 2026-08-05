import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeHostname, normalizeAllowlist, isValidAllowlistDomain } from './hostname.js';

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

// ---------------------------------------------------------------------------
// isValidAllowlistDomain (REVIEW-2026-07 §4.8) — write-side validation.
// ---------------------------------------------------------------------------

test('4.8: rejects bare TLDs and multi-label public suffixes', () => {
  assert.equal(isValidAllowlistDomain('com'), false);
  assert.equal(isValidAllowlistDomain('uk'), false);
  assert.equal(isValidAllowlistDomain('co.uk'), false);
  assert.equal(isValidAllowlistDomain('github.io'), false);
  assert.equal(isValidAllowlistDomain('netlify.app'), false);
});

test('4.8: rejects dotless labels, bad charset, empty labels, oversized input', () => {
  assert.equal(isValidAllowlistDomain('localhost'), false);
  assert.equal(isValidAllowlistDomain('foo bar'), false);
  assert.equal(isValidAllowlistDomain('exa_mple.com'), false);
  assert.equal(isValidAllowlistDomain('Example.com'), false, 'expects normalized (lowercase) input');
  assert.equal(isValidAllowlistDomain('a..b'), false);
  assert.equal(isValidAllowlistDomain('.example.com'), false);
  assert.equal(isValidAllowlistDomain('example.com.'), false);
  assert.equal(isValidAllowlistDomain(`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.example.com`), false);
  assert.equal(isValidAllowlistDomain(`${'a'.repeat(64)}.com`), false);
  assert.equal(isValidAllowlistDomain(''), false);
  assert.equal(isValidAllowlistDomain(null), false);
  assert.equal(isValidAllowlistDomain(42), false);
});

test('4.8: accepts registrable domains, subdomains, and IPv4 literals', () => {
  assert.equal(isValidAllowlistDomain('example.com'), true);
  assert.equal(isValidAllowlistDomain('bbc.co.uk'), true);
  assert.equal(isValidAllowlistDomain('news.bbc.co.uk'), true);
  assert.equal(isValidAllowlistDomain('mysite.netlify.app'), true);
  assert.equal(isValidAllowlistDomain('192.168.1.1'), true);
  assert.equal(isValidAllowlistDomain('xn--bcher-kva.example'), true);
});
