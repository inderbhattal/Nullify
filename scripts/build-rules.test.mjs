import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLine, networkFilterToDNR, buildSourceBundleFallback } from './build-rules.mjs';
import { shouldSkipGenericCosmeticForHostname } from '../src/shared/core-filter-source.js';

test('drops legacy global fragment image redirects that overmatch DNR sprite URLs', () => {
  const parsed = parseLine('*.svg#$image,redirect-rule=1x1.gif');
  assert.equal(parsed?.type, 'network');
  assert.equal(networkFilterToDNR(parsed), null);
});

test('keeps narrower fragment image redirects that are scoped to a specific host path', () => {
  const parsed = parseLine('||example.com/assets/*.svg#$image,redirect-rule=1x1.gif');
  assert.equal(parsed?.type, 'network');

  const dnr = networkFilterToDNR(parsed);
  assert.ok(dnr);
  assert.equal(dnr.action.type, 'redirect');
  assert.equal(dnr.condition.urlFilter, '||example.com/assets/*.svg#');
  assert.deepEqual(dnr.condition.resourceTypes, ['image']);
});

test('drops denied Gmail cosmetic selectors during source bundle generation', () => {
  const parsed = {
    cosmeticRules: [
      {
        type: 'cosmetic',
        domains: ['mail.google.com'],
        selector: '.nH.PS',
        exception: false,
      },
      {
        type: 'cosmetic',
        domains: ['mail.google.com'],
        selector: '.aeF > .nH > .nH[role="main"] > .aKB',
        exception: false,
      },
      {
        type: 'cosmetic',
        domains: ['mail.google.com'],
        selector: 'a[href^="http://li.blogtrottr.com/click?"]',
        exception: false,
      },
    ],
    cosmeticExceptions: [],
    genericCosmeticExceptionDomains: ['mail.google.com'],
    scriptletRules: [],
  };

  const bundle = buildSourceBundleFallback(parsed);
  assert.deepEqual(bundle.cosmetic.domainSpecific['mail.google.com'], [
    'a[href^="http://li.blogtrottr.com/click?"]',
  ]);
  assert.deepEqual(bundle.cosmetic.genericExcludedDomains, ['mail.google.com']);
});

test('parses EasyList generichide as generated generic cosmetic exclusion', () => {
  const parsed = parseLine('@@||mail.google.com^$generichide');
  assert.equal(parsed?.type, 'cosmetic-scope-exception');
  assert.deepEqual(parsed.domains, ['mail.google.com']);
  assert.deepEqual(parsed.scopes, ['generichide']);
});

test('parses domain-scoped generichide exceptions without URL pattern', () => {
  const parsed = parseLine('@@$generichide,domain=androidpolice.com|~excluded.example|xda-developers.com');
  assert.equal(parsed?.type, 'cosmetic-scope-exception');
  assert.deepEqual(parsed.domains, ['androidpolice.com', 'xda-developers.com']);
});

test('skips generic cosmetic CSS using generated excluded domains', () => {
  const excludedDomains = ['mail.google.com'];
  assert.equal(shouldSkipGenericCosmeticForHostname('mail.google.com', excludedDomains), true);
  assert.equal(shouldSkipGenericCosmeticForHostname('inbox.mail.google.com', excludedDomains), true);
  assert.equal(shouldSkipGenericCosmeticForHostname('mail.example.com', excludedDomains), false);
  assert.equal(shouldSkipGenericCosmeticForHostname('mail.google.com'), false);
});
