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

// uBO's short spellings are used heavily by the lists this project fetches
// (unbreak.txt has a whole $ghide section). They were absent from the
// cosmetic-scope branch, so they fell through to networkFilterToDNR and became
// `allow` at a priority above every block — turning "don't apply generic
// cosmetics here" into "disable ad blocking on this domain entirely".
test('short cosmetic-scope aliases are not network allows', () => {
  for (const alias of ['ghide', 'ehide', 'shide']) {
    const parsed = parseLine(`@@||example.com^$${alias}`);
    assert.equal(
      parsed.type,
      'cosmetic-scope-exception',
      `$${alias} must not produce a network rule`,
    );
    assert.deepEqual(parsed.domains, ['example.com']);
  }
});

test('cosmetic-scope aliases normalise to their canonical scope name', () => {
  // Downstream matching tests for 'generichide'/'elemhide' by name, so an
  // alias that passes through raw would be silently ignored.
  assert.deepEqual(parseLine('@@||example.com^$ghide').scopes, ['generichide']);
  assert.deepEqual(parseLine('@@||example.com^$ehide').scopes, ['elemhide']);
  assert.deepEqual(parseLine('@@||example.com^$shide').scopes, ['specifichide']);
});

// Unknown options were dropped and the remaining rule shipped anyway, which
// makes the emitted rule *broader* than the filter author wrote. Every case
// below was a live block rule before this suite.
test('semantic modifiers we do not implement drop the whole rule', () => {
  const cases = [
    // Cancels a filter elsewhere in the corpus. Ignoring it instates the very
    // rule it was written to remove.
    '||example.com^$badfilter',
    '@@||example.com^$badfilter',
    // Bare $removeparam strips every query parameter. Ignoring it turned a
    // parameter-hygiene rule into a hard block of the domain.
    '||example.com^$removeparam',
    // Carries an exclusion; ignoring it blocks the CDN the author protected.
    '||example.com^$script,denyallow=cdn.example',
    // Conditional on request/response shape; ignoring makes it unconditional.
    '||example.com^$header=via',
    '||example.com^$method=post',
    '||example.com^$replace=/a/b/',
    '||example.com^$to=tracker.example',
    '||example.com^$permissions=geolocation',
    '||example.com^$strict3p',
  ];

  for (const line of cases) {
    const parsed = parseLine(line);
    assert.equal(parsed.skip, true, `${line} must be skipped, not shipped broadened`);
    assert.match(parsed.reason || '', /unsupported-option/, `${line} must say why`);
  }
});

test('an unknown option drops the rule even alongside options we do understand', () => {
  // The dangerous shape: the recognised half looks fine, so the rule shipped.
  const parsed = parseLine('||example.com^$script,third-party,someFutureOption=1');
  assert.equal(parsed.skip, true);
});

test('benign no-op options are still ignorable, keeping the rest of the rule', () => {
  // Ignoring these cannot broaden the rule, so they must not cost us coverage.
  assert.deepEqual(
    convert('||ads.example.com^$script,inline-script'),
    block({ urlFilter: '||ads.example.com^', resourceTypes: ['script'] }),
  );
  assert.deepEqual(
    convert('||ads.example.com^$image,match-case'),
    block({ urlFilter: '||ads.example.com^', resourceTypes: ['image'] }),
  );
});

test('resource-type aliases are recognised rather than dropped', () => {
  const expectType = (line, types) =>
    assert.deepEqual(convert(line), block({ urlFilter: '||e.com^', resourceTypes: types }), line);

  expectType('||e.com^$xhr', ['xmlhttprequest']);
  expectType('||e.com^$css', ['stylesheet']);
  expectType('||e.com^$frame', ['sub_frame']);
  expectType('||e.com^$beacon', ['ping']);
  expectType('||e.com^$object-subrequest', ['object']);
});

test('$csp exceptions are skipped, not converted to a network allow', () => {
  // $csp is not translated in either direction. Emitting an allow for the
  // exception form disables all network blocking on the domain.
  for (const line of ['@@||example.com^$csp', '@@||example.com^$csp=script-src']) {
    const parsed = parseLine(line);
    assert.equal(parsed.skip, true, `${line} must be skipped`);
  }
});
