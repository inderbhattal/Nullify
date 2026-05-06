import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CORE_FILTER_SOURCE,
  CORE_FILTER_SOURCE_ID,
  COSMETIC_SELECTOR_DENYLIST,
  shouldSkipDomainCosmeticSelector,
  shouldSkipGenericCosmeticForHostname,
} from './core-filter-source.js';

test('CORE_FILTER_SOURCE_ID is the sentinel string', () => {
  assert.equal(CORE_FILTER_SOURCE_ID, '__core');
});

test('shouldSkipDomainCosmeticSelector matches denylist entries case-insensitively on domain', () => {
  assert.equal(
    shouldSkipDomainCosmeticSelector('mail.google.com', '.nH.PS'),
    true
  );
  assert.equal(
    shouldSkipDomainCosmeticSelector('MAIL.GOOGLE.COM', '.nH.PS'),
    true
  );
});

test('shouldSkipDomainCosmeticSelector requires exact selector match', () => {
  // Whitespace gets trimmed.
  assert.equal(
    shouldSkipDomainCosmeticSelector('mail.google.com', '  .nH.PS  '),
    true
  );
  // But the selector text itself is matched literally — not a substring/CSS comparison.
  assert.equal(
    shouldSkipDomainCosmeticSelector('mail.google.com', '.nH'),
    false
  );
});

test('shouldSkipDomainCosmeticSelector returns false for unknown domains', () => {
  assert.equal(
    shouldSkipDomainCosmeticSelector('example.com', '.nH.PS'),
    false
  );
});

test('shouldSkipDomainCosmeticSelector tolerates non-string/empty input', () => {
  assert.equal(shouldSkipDomainCosmeticSelector(null, '.nH.PS'), false);
  assert.equal(shouldSkipDomainCosmeticSelector('mail.google.com', null), false);
  assert.equal(shouldSkipDomainCosmeticSelector('', ''), false);
});

test('shouldSkipGenericCosmeticForHostname matches exact and subdomain', () => {
  const excluded = ['mail.google.com'];
  assert.equal(shouldSkipGenericCosmeticForHostname('mail.google.com', excluded), true);
  assert.equal(shouldSkipGenericCosmeticForHostname('inbox.mail.google.com', excluded), true);
  assert.equal(shouldSkipGenericCosmeticForHostname('mail.example.com', excluded), false);
});

test('shouldSkipGenericCosmeticForHostname does not match prefix without dot boundary', () => {
  // "fakemail.google.com" must NOT be excluded by an entry for "mail.google.com"
  const excluded = ['mail.google.com'];
  assert.equal(shouldSkipGenericCosmeticForHostname('fakemail.google.com', excluded), false);
});

test('shouldSkipGenericCosmeticForHostname tolerates undefined excludedDomains', () => {
  assert.equal(shouldSkipGenericCosmeticForHostname('mail.google.com'), false);
  assert.equal(shouldSkipGenericCosmeticForHostname('mail.google.com', null), false);
});

test('shouldSkipGenericCosmeticForHostname is case-insensitive on hostname', () => {
  assert.equal(
    shouldSkipGenericCosmeticForHostname('MAIL.GOOGLE.COM', ['mail.google.com']),
    true
  );
});

test('CORE_FILTER_SOURCE shape is well-formed', () => {
  assert.ok(CORE_FILTER_SOURCE.cosmetic);
  assert.ok(Array.isArray(CORE_FILTER_SOURCE.cosmetic.generic));
  assert.equal(typeof CORE_FILTER_SOURCE.cosmetic.domainSpecific, 'object');
  assert.ok(Array.isArray(CORE_FILTER_SOURCE.scriptlets));
  // No domain in domainSpecific should appear in the denylist for that domain.
  for (const [domain, selectors] of Object.entries(CORE_FILTER_SOURCE.cosmetic.domainSpecific)) {
    const denied = COSMETIC_SELECTOR_DENYLIST[domain];
    if (!denied) continue;
    for (const sel of selectors) {
      assert.ok(
        !denied.includes(sel),
        `core source ships denied selector ${sel} for ${domain}`
      );
    }
  }
});

test('CORE_FILTER_SOURCE has no procedural selectors leaked as raw CSS', () => {
  // Past regression: ":remove()" / ":has-text()" leaked into raw selector
  // arrays where they would never match. Catch any future leak by name.
  for (const [domain, selectors] of Object.entries(CORE_FILTER_SOURCE.cosmetic.domainSpecific)) {
    for (const sel of selectors) {
      for (const op of [':remove(', ':has-text(', ':matches-css(', ':upward(', ':xpath(']) {
        assert.ok(
          !sel.includes(op),
          `core source for ${domain} has procedural operator ${op} in raw selector: ${sel}`
        );
      }
    }
  }
});
