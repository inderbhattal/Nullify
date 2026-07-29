import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLine, networkFilterToDNR } from './build-rules.mjs';

/**
 * Golden-file suite for ABP filter line -> DNR rule conversion.
 *
 * The conversion pipeline had five tests and none of them touched modifier
 * dispatch, the priority scheme, pattern conversion or the regex path — which
 * is how `$ghide` came to emit a blanket network allow and `$badfilter` came to
 * emit an active block. This suite pins the behaviour that is correct so the
 * parity fixes that follow are verifiable rather than hopeful.
 *
 * Rule ids come from a module-level counter, so they are stripped before
 * comparison; only the semantic shape is asserted.
 */

/** Convert a filter line the way the build script does, minus the id. */
function convert(line) {
  const parsed = parseLine(line);
  if (!parsed) return null;
  if (parsed.type !== 'network') return parsed;

  const rule = networkFilterToDNR(parsed);
  if (!rule) return null;

  const { id, ...rest } = rule;
  assert.ok(Number.isInteger(id) && id > 0, `${line}: rule id must be a positive integer`);
  return rest;
}

const block = (condition, priority = 1) => ({ priority, condition, action: { type: 'block' } });

test('pattern anchors survive conversion unchanged', () => {
  assert.deepEqual(convert('||ads.example.com^'), block({ urlFilter: '||ads.example.com^' }));
  assert.deepEqual(convert('|https://ads.example.com'), block({ urlFilter: '|https://ads.example.com' }));
  assert.deepEqual(convert('/banner-'), block({ urlFilter: '/banner-' }));
});

test('resource types map to DNR names, negation to exclusions', () => {
  assert.deepEqual(
    convert('||ads.example.com^$script,image'),
    block({ urlFilter: '||ads.example.com^', resourceTypes: ['script', 'image'] }),
  );
  assert.deepEqual(
    convert('||ads.example.com^$~script'),
    block({ urlFilter: '||ads.example.com^', excludedResourceTypes: ['script'] }),
  );
  assert.deepEqual(
    convert('||ads.example.com^$subdocument'),
    block({ urlFilter: '||ads.example.com^', resourceTypes: ['sub_frame'] }),
  );
});

test('party modifiers map to domainType', () => {
  assert.deepEqual(
    convert('||ads.example.com^$third-party'),
    block({ urlFilter: '||ads.example.com^', domainType: 'thirdParty' }),
  );
  assert.deepEqual(
    convert('||ads.example.com^$first-party'),
    block({ urlFilter: '||ads.example.com^', domainType: 'firstParty' }),
  );
  // `~third-party` means first-party, not "no constraint".
  assert.deepEqual(
    convert('||ads.example.com^$~third-party'),
    block({ urlFilter: '||ads.example.com^', domainType: 'firstParty' }),
  );
});

test('$domain= splits into initiator includes and excludes', () => {
  assert.deepEqual(
    convert('||e.com^$domain=a.com|~b.com'),
    block({
      urlFilter: '||e.com^',
      initiatorDomains: ['a.com'],
      excludedInitiatorDomains: ['b.com'],
    }),
  );
});

test('$removeparam with a value becomes a queryTransform, not a block', () => {
  assert.deepEqual(convert('||example.com^$removeparam=utm_source'), {
    priority: 1,
    condition: { urlFilter: '||example.com^' },
    action: {
      type: 'redirect',
      redirect: { transform: { queryTransform: { removeParams: ['utm_source'] } } },
    },
  });
});

test('exceptions become allow rules that outrank plain blocks', () => {
  const exception = convert('@@||safe.example.com^');
  assert.equal(exception.action.type, 'allow');
  assert.ok(
    exception.priority > block({}).priority,
    'an exception must outrank a plain block',
  );
});

test('regex filters are emitted as regexFilter, not urlFilter', () => {
  assert.deepEqual(
    convert('/banner[0-9]+\\.gif/'),
    block({ regexFilter: 'banner[0-9]+\\.gif' }),
  );
});

test('regex filters using RE2-incompatible syntax are dropped, not shipped', () => {
  // Chrome compiles regexFilter with RE2, which has no lookaround or
  // backreferences. Shipping one makes Chrome reject the rule at load.
  assert.equal(convert('/ads(?!good)/'), null);
  assert.equal(convert('/(a)\\1/'), null);
});

test('bare-TLD patterns are rejected — ||com^ would match every .com host', () => {
  assert.equal(convert('||com^'), null);
  assert.equal(convert('||co.uk^'), null);
});

test('non-ASCII patterns are dropped — DNR urlFilter must be ASCII', () => {
  assert.equal(convert('||пример.рф^'), null);
});

test('cosmetic and scriptlet lines are classified, never converted to network rules', () => {
  assert.deepEqual(parseLine('example.com##.ad'), {
    type: 'cosmetic',
    domains: ['example.com'],
    selector: '.ad',
    exception: false,
  });
  assert.deepEqual(parseLine('example.com#@#.ad'), {
    type: 'cosmetic',
    domains: ['example.com'],
    selector: '.ad',
    exception: true,
  });
  assert.deepEqual(parseLine('example.com##+js(aopr, x)'), {
    type: 'scriptlet',
    domains: ['example.com'],
    name: 'aopr',
    args: ['x'],
  });
  assert.equal(parseLine('##.generic-ad').type, 'cosmetic');
});

test('comments and blank lines are skipped, not converted', () => {
  for (const line of ['! comment', '[Adblock Plus 2.0]', '', '   ']) {
    assert.equal(parseLine(line).skip, true, `${JSON.stringify(line)} must be skipped`);
  }
});

test('$generichide is a cosmetic-scope exception, never a network allow', () => {
  const parsed = parseLine('@@||example.com^$generichide');
  assert.equal(parsed.type, 'cosmetic-scope-exception');
  assert.deepEqual(parsed.domains, ['example.com']);
  assert.deepEqual(parsed.scopes, ['generichide']);
});
