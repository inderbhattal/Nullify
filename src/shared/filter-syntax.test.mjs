import assert from 'node:assert/strict';
import test from 'node:test';

import { splitDomainList } from './filter-syntax.js';

test('splits includes from ~exclusions', () => {
  assert.deepEqual(splitDomainList('example.com,~mail.example.com'), {
    domains: ['example.com'],
    excludedDomains: ['mail.example.com'],
  });
});

test('a pure-negation list has no positive domains', () => {
  assert.deepEqual(splitDomainList('~a.com,~b.com'), {
    domains: [],
    excludedDomains: ['a.com', 'b.com'],
  });
});

test('plain lists are unaffected', () => {
  assert.deepEqual(splitDomainList('a.com,b.com'), {
    domains: ['a.com', 'b.com'],
    excludedDomains: [],
  });
});

test('empty and malformed input yields empty lists rather than junk entries', () => {
  for (const input of ['', '   ', ',,', undefined, null]) {
    assert.deepEqual(
      splitDomainList(input),
      { domains: [], excludedDomains: [] },
      `input ${JSON.stringify(input)}`,
    );
  }
});

test('a bare ~ contributes nothing', () => {
  assert.deepEqual(splitDomainList('a.com,~'), {
    domains: ['a.com'],
    excludedDomains: [],
  });
});

test('surrounding whitespace is trimmed on both forms', () => {
  assert.deepEqual(splitDomainList(' a.com , ~ b.com '), {
    domains: ['a.com'],
    excludedDomains: ['b.com'],
  });
});

test('wildcard-TLD entries pass through untouched', () => {
  // Expanding `entity.*` against the PSL is separate work; splitting must not
  // mangle them in the meantime.
  assert.deepEqual(splitDomainList('costco.*,~costco.co.uk'), {
    domains: ['costco.*'],
    excludedDomains: ['costco.co.uk'],
  });
});
