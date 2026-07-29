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

// Overriding an exception is the entire purpose of $important; the
// anti-circumvention lists depend on it. Priorities were block 1, important 2,
// exception 3 — so an exception always won and $important did nothing.
test('$important ordering matches uBO: important block beats a plain exception', () => {
  const plainBlock = convert('||ads.example.com^');
  const plainAllow = convert('@@||ads.example.com^');
  const importantBlock = convert('||ads.example.com^$important');
  const importantAllow = convert('@@||ads.example.com^$important');

  assert.ok(plainAllow.priority > plainBlock.priority, 'allow beats block');
  assert.ok(importantBlock.priority > plainAllow.priority, 'important block beats allow');
  assert.ok(
    importantAllow.priority > importantBlock.priority,
    'important allow beats important block',
  );

  assert.equal(importantBlock.action.type, 'block');
  assert.equal(importantAllow.action.type, 'allow');
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
    excludedDomains: [],
    selector: '.ad',
    exception: false,
  });
  assert.deepEqual(parseLine('example.com#@#.ad'), {
    type: 'cosmetic',
    domains: ['example.com'],
    excludedDomains: [],
    selector: '.ad',
    exception: true,
  });
  assert.deepEqual(parseLine('example.com##+js(aopr, x)'), {
    type: 'scriptlet',
    domains: ['example.com'],
    excludedDomains: [],
    name: 'aopr',
    args: ['x'],
  });
  assert.equal(parseLine('##.generic-ad').type, 'cosmetic');
});

// The domain-prefix character class excluded `*`, so uBO's wildcard-TLD form
// matched no cosmetic branch, fell through to the network path, and shipped as
// a block rule whose urlFilter was the entire filter line — 3,130 of them in
// the generated artifacts, consuming static-rule budget while matching nothing,
// and losing the cosmetic/scriptlet rule they were supposed to be.
test('wildcard-TLD cosmetic lines classify as cosmetic, not network', () => {
  const cosmetic = parseLine('read.amazon.*##.kw-ads-ftue-container');
  assert.equal(cosmetic.type, 'cosmetic');
  assert.deepEqual(cosmetic.domains, ['read.amazon.*']);
  assert.equal(cosmetic.selector, '.kw-ads-ftue-container');

  const scriptlet = parseLine('pelispedia.*##+js(aopw, document.oncontextmenu)');
  assert.equal(scriptlet.type, 'scriptlet');
  assert.deepEqual(scriptlet.domains, ['pelispedia.*']);
  assert.equal(scriptlet.name, 'aopw');

  const exception = parseLine('costco.*#@#.promo');
  assert.equal(exception.type, 'cosmetic');
  assert.equal(exception.exception, true);
});

test('a filter line containing ## never becomes a network rule', () => {
  // Backstop for the whole class: whatever the domain prefix looks like, a
  // cosmetic line must not reach urlFilter.
  for (const line of ['read.amazon.*##.ad', 'a.b.*##div', '~x.com##.ad']) {
    const parsed = parseLine(line);
    assert.notEqual(parsed.type, 'network', `${line} must not be a network rule`);
  }
});

// Chrome matches urlFilter against the canonicalized (still percent-encoded)
// URL, so decoding produced filters containing literal spaces that can never
// match — 60 dead rules including phishing blocks from the badware list.
test('percent-encoded patterns are not decoded', () => {
  assert.deepEqual(
    convert('||example.com/ad%20frame/'),
    block({ urlFilter: '||example.com/ad%20frame/' }),
  );
});

test('a percent-encoded non-ASCII pattern is kept, not decoded then rejected', () => {
  // Decoding turned this valid ASCII pattern into Cyrillic, which the ASCII
  // guard then dropped.
  assert.deepEqual(
    convert('||example.com/%D0%B0%D0%B4/'),
    block({ urlFilter: '||example.com/%D0%B0%D0%B4/' }),
  );
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

// A DNR condition with no resourceTypes matches every type EXCEPT main_frame.
// Every rule in the URLhaus malware ruleset had no resourceTypes, so navigating
// to a listed malicious URL was not blocked — only subresources from that host
// were. That is the one thing the list exists to stop.
test('security lists cover main_frame so navigations are actually blocked', () => {
  const parsed = parseLine('0011.s3.cubbit.eu');
  const rule = networkFilterToDNR(parsed, { coverDocuments: true });

  assert.ok(rule.condition.resourceTypes, 'must pin resource types explicitly');
  assert.ok(
    rule.condition.resourceTypes.includes('main_frame'),
    'a malicious-URL rule must block the navigation itself',
  );
  assert.ok(rule.condition.resourceTypes.includes('sub_frame'));
  assert.ok(rule.condition.resourceTypes.includes('script'));
});

test('security-list coverage does not override an explicit resource type', () => {
  const parsed = parseLine('||evil.example^$script');
  const rule = networkFilterToDNR(parsed, { coverDocuments: true });

  assert.deepEqual(
    rule.condition.resourceTypes,
    ['script'],
    'an author-specified type must win over the list-wide default',
  );
});

test('ordinary lists are unaffected — no implicit main_frame', () => {
  const rule = networkFilterToDNR(parseLine('||ads.example.com^'));
  assert.equal(
    rule.condition.resourceTypes,
    undefined,
    'ad lists must not start blocking navigations',
  );
});

test('$csp exceptions are skipped, not converted to a network allow', () => {
  // $csp is not translated in either direction. Emitting an allow for the
  // exception form disables all network blocking on the domain.
  for (const line of ['@@||example.com^$csp', '@@||example.com^$csp=script-src']) {
    const parsed = parseLine(line);
    assert.equal(parsed.skip, true, `${line} must be skipped`);
  }
});
