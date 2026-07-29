import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLine, buildSourceBundleFallback } from './build-rules.mjs';

/**
 * `~domain` exclusions are expressed through the bundle's existing per-domain
 * `exceptions` map rather than a new schema field. Lookup already collects
 * exceptions across the ancestor walk and subtracts them, which is exactly the
 * semantics an exclusion needs — and it means the WASM serializer, IndexedDB
 * schema and content engine need no change.
 */

/** Run lines through the parser and into a source bundle, as the build does. */
function bundleFor(lines) {
  const cosmeticRules = [];
  const scriptletRules = [];

  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed?.type === 'cosmetic') cosmeticRules.push(parsed);
    else if (parsed?.type === 'scriptlet') scriptletRules.push(parsed);
  }

  return buildSourceBundleFallback({
    cosmeticRules,
    cosmeticExceptions: [],
    scriptletRules,
    genericCosmeticExceptionDomains: [],
  });
}

test('a mixed include/exclude rule applies on the include and is excepted on the exclusion', () => {
  const { cosmetic } = bundleFor(['example.com,~mail.example.com##.promo']);

  assert.deepEqual(cosmetic.domainSpecific['example.com'], ['.promo']);
  assert.deepEqual(
    cosmetic.exceptions['mail.example.com'],
    ['.promo'],
    'the excluded subdomain must carry a matching exception',
  );
  assert.equal(
    cosmetic.domainSpecific['~mail.example.com'],
    undefined,
    'the ~ form must never become a positive domain key',
  );
});

test('the exclusion survives the ancestor walk that caused the over-application', () => {
  // Lookup walks mail.example.com -> example.com, so the rule is found via the
  // parent. The exception must be found on the same walk to cancel it.
  const { cosmetic } = bundleFor(['example.com,~mail.example.com##.promo']);

  const appliesVia = Object.keys(cosmetic.domainSpecific);
  const exceptedOn = Object.keys(cosmetic.exceptions);

  assert.ok(appliesVia.includes('example.com'));
  assert.ok(exceptedOn.includes('mail.example.com'));
});

test('a pure-negation rule becomes generic plus an exception, not a dead key', () => {
  // "everywhere except example.com". Previously keyed under the literal
  // '~example.com', which equals no hostname, so it applied nowhere.
  const { cosmetic } = bundleFor(['~example.com##.ad']);

  assert.deepEqual(cosmetic.generic, ['.ad'], 'must apply generically');
  assert.deepEqual(
    cosmetic.exceptions['example.com'],
    ['.ad'],
    'and must be cancelled on the excluded domain',
  );
});

test('multiple exclusions each get their own exception entry', () => {
  const { cosmetic } = bundleFor(['~a.com,~b.com##.ad']);

  assert.deepEqual(cosmetic.generic, ['.ad']);
  assert.deepEqual(cosmetic.exceptions['a.com'], ['.ad']);
  assert.deepEqual(cosmetic.exceptions['b.com'], ['.ad']);
});

test('rules without exclusions are unchanged', () => {
  const { cosmetic } = bundleFor(['example.com##.ad', '##.generic-ad']);

  assert.deepEqual(cosmetic.domainSpecific['example.com'], ['.ad']);
  assert.deepEqual(cosmetic.generic, ['.generic-ad']);
  assert.deepEqual(cosmetic.exceptions, {}, 'no spurious exceptions');
});

test('scriptlet exclusions are carried on the stored rule', () => {
  const { scriptlets } = bundleFor([
    'youtube.com,~music.youtube.com##+js(set, yt.ads, false)',
  ]);

  assert.equal(scriptlets.length, 1);
  assert.deepEqual(scriptlets[0].domains, ['youtube.com']);
  assert.deepEqual(
    scriptlets[0].excludedDomains,
    ['music.youtube.com'],
    'the exclusion must reach the runtime, which filters on it at lookup',
  );
});
