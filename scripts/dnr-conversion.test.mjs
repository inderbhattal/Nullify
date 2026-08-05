import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseLine,
  networkFilterToDNR,
  parseFilterList,
  applyBadfilterSuppression,
  buildDNRRules,
  splitPatternAndOptions,
  estimateRegexNfaCost,
  MAX_REGEX_NFA_COST,
} from './build-rules.mjs';

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

// ABP filters are case-insensitive unless $match-case, and the emitted rule
// states that explicitly rather than relying on Chrome's version-dependent
// default (§5.46) — hence the field on every expected condition.
const block = (condition, priority = 1) => ({
  priority,
  condition: { isUrlFilterCaseSensitive: false, ...condition },
  action: { type: 'block' },
});

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
    condition: { urlFilter: '||example.com^', isUrlFilterCaseSensitive: false },
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
  // $match-case is no longer merely ignorable — it is honoured (§5.46).
  assert.deepEqual(
    convert('||ads.example.com^$image,match-case'),
    block({
      urlFilter: '||ads.example.com^',
      resourceTypes: ['image'],
      isUrlFilterCaseSensitive: true,
    }),
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

// ---------------------------------------------------------------------------
// $badfilter two-pass suppression (prior review 4.1)
// ---------------------------------------------------------------------------

test('$badfilter cancels its base rule instead of being dropped as unsupported', () => {
  const text = [
    '||ads.example.com^$script',
    '||ads.example.com^$script,badfilter',
    '||keep.example.com^',
  ].join('\n');

  const parsed = parseFilterList(text);
  const patterns = parsed.networkRules.map((r) => r.pattern);
  assert.deepEqual(patterns, ['||keep.example.com^'], 'the badfiltered base rule must be suppressed');

  const suppressed = parsed.skippedRecords.filter((r) => r.reason.startsWith('badfilter-suppressed'));
  assert.equal(suppressed.length, 1, 'the suppression must be recorded in the skip log');
});

test('$badfilter matching is canonical: option order and domain order do not matter', () => {
  const text = [
    '||a.example^$script,domain=b.com|c.com',
    '||a.example^$domain=c.com|b.com,script,badfilter',
  ].join('\n');

  const parsed = parseFilterList(text);
  assert.deepEqual(parsed.networkRules, [], 'reordered options must still match');
});

test('$badfilter does not cancel rules whose options differ', () => {
  const text = [
    '||a.example^$script',
    '||a.example^$image,badfilter',
  ].join('\n');

  const parsed = parseFilterList(text);
  assert.equal(parsed.networkRules.length, 1, 'a badfilter for a different form must not match');
  assert.equal(parsed.networkRules[0].pattern, '||a.example^');
});

test('a $badfilter rule itself never converts to a DNR rule', () => {
  const parsed = parseLine('||example.com^$badfilter');
  assert.equal(parsed.type, 'network', 'badfilter parses as a network directive');
  assert.equal(networkFilterToDNR(parsed), null, 'but must never ship');
});

// ---------------------------------------------------------------------------
// $popup (§4.22)
// ---------------------------------------------------------------------------

test('$popup converts only for ||domain^-anchored patterns', () => {
  assert.deepEqual(
    convert('||popupads.example^$popup'),
    block({ urlFilter: '||popupads.example^', resourceTypes: ['main_frame'] }),
  );

  // Broad patterns would block ordinary navigations (a full-page
  // ERR_BLOCKED_BY_CLIENT on a legitimate link click), where ABP $popup
  // matches only script-opened popup windows.
  for (const line of ['/r.php?u=https$popup', '.com/smartpop/$popup', '/?usid=*&utid=$popup']) {
    const parsed = parseLine(line);
    assert.equal(parsed.skip, true, `${line} must be skipped`);
    assert.match(parsed.reason || '', /popup/, `${line} must say why`);
  }
});

// ---------------------------------------------------------------------------
// redirect= / redirect-rule= (§5.42)
// ---------------------------------------------------------------------------

test('redirect-rule= is skipped — uBO applies it only when another filter blocks', () => {
  const parsed = parseLine('||ads.example.com^$image,redirect-rule=1x1.gif');
  assert.equal(parsed.skip, true);
  assert.match(parsed.reason || '', /redirect-rule/);
});

test('$redirect= outranks a co-matching plain block but not an allow', () => {
  const redirect = convert('||ads.example.com^$image,redirect=1x1.gif');
  const plainBlock = convert('||ads.example.com^');
  const allow = convert('@@||ads.example.com^');

  assert.equal(redirect.action.type, 'redirect');
  // At EQUAL priority DNR resolves allow > block > redirect, so a co-matching
  // EasyList block would defeat the stub and hard-block where uBO serves a
  // working placeholder.
  assert.ok(redirect.priority > plainBlock.priority, 'redirect must beat a plain block');
  assert.ok(allow.priority > redirect.priority, 'an exception must still beat the redirect');
});

test('$removeparam stays in the block band so a co-matching block wins the tie', () => {
  const removeparam = convert('||example.com^$removeparam=utm_source');
  const plainBlock = convert('||example.com^');
  assert.equal(removeparam.priority, plainBlock.priority);
});

// ---------------------------------------------------------------------------
// Case sensitivity (§5.46)
// ---------------------------------------------------------------------------

test('rules are case-insensitive by default, case-sensitive only with $match-case', () => {
  assert.equal(
    convert('||example.com/adframe.$script').condition.isUrlFilterCaseSensitive,
    false,
    'ABP filters are case-insensitive absent $match-case',
  );
  assert.equal(
    convert('||example.com/AdFrame.$script,match-case').condition.isUrlFilterCaseSensitive,
    true,
    '$match-case must be honoured',
  );
  assert.equal(
    convert('/banner[0-9]+\\.gif/').condition.isUrlFilterCaseSensitive,
    false,
    'regex rules get the explicit flag too',
  );
});

// ---------------------------------------------------------------------------
// Regex filters ending in `$/` (§5.45)
// ---------------------------------------------------------------------------

test('a regex filter ending in an anchor keeps its $ — not split as options', () => {
  assert.deepEqual(
    convert('/banner[0-9]+\\.gif$/'),
    block({ regexFilter: 'banner[0-9]+\\.gif$' }),
  );
});

test('options after a regex literal are still recognised', () => {
  assert.deepEqual(
    convert('/banner[0-9]+/$script'),
    block({ regexFilter: 'banner[0-9]+', resourceTypes: ['script'] }),
  );
});

test('a path-anchored (non-regex) pattern still splits options at $', () => {
  assert.deepEqual(
    convert('/banner-$image'),
    block({ urlFilter: '/banner-', resourceTypes: ['image'] }),
  );
});

// ---------------------------------------------------------------------------
// RE2 cost estimator (§5.44)
// ---------------------------------------------------------------------------

test('patterns containing .* survive the RE2 cost estimate', () => {
  // RE2 compiles `.` to one byte-range instruction and never backtracks; the
  // old estimator costed it at 256 alternatives ×10 for the star, so any
  // pattern containing `.*` blew the budget and ~100 valid rules were dropped.
  assert.notEqual(convert('/^https?:.*\\/adframe\\/banner/'), null);
  assert.notEqual(convert('/ads[0-9a-z]+\\.example\\.com/'), null);
});

test('regex source length is bounded by the compiled budget, not by 256 chars', () => {
  // Prior review 4.4 asked for the source-length cap to be raised to 256 on
  // the theory that 256 characters fit Chrome's 2KB RE2 budget. Chrome
  // disagrees: it refused an 79-character pattern at ruleset load, because the
  // budget is spent on compiled instructions across BOTH the forward and
  // reverse programs, and a literal character costs one instruction each.
  // The source-length cap is now a backstop; the instruction budget is the
  // limit that actually decides, and it binds first.
  assert.notEqual(convert(`/${'a'.repeat(60)}/`), null, 'a short literal regex still fits');
  assert.equal(convert(`/${'a'.repeat(200)}/`), null, 'a 200-char literal exceeds the compiled budget');
  assert.equal(convert(`/${'a'.repeat(300)}/`), null, 'and so does anything past the source cap');
});

test('bounded quantifier unrolling is still costed', () => {
  // RE2 really does unroll bounded repetition, so this guard must survive
  // the recalibration.
  assert.equal(convert(`/[0-9a-z]{100}[0-9a-z]{100}[0-9a-z]{100}/`), null);
});

// ---------------------------------------------------------------------------
// Wildcard $domain= entries (§5.43)
// ---------------------------------------------------------------------------

test('wildcard-only $domain= drops the rule — gmx.* is invalid DNR', () => {
  assert.equal(convert('||ads.example^$domain=gmx.*'), null);
});

test('wildcard $domain= entries are pruned when concrete domains remain', () => {
  assert.deepEqual(
    convert('||ads.example^$domain=gmx.*|real.example'),
    block({ urlFilter: '||ads.example^', initiatorDomains: ['real.example'] }),
  );
});

test('a wildcard $domain= EXCLUSION drops the rule rather than over-applying it', () => {
  assert.equal(convert('||ads.example^$domain=~gmx.*'), null);
});

// ---------------------------------------------------------------------------
// Dedup key (§5.41)
// ---------------------------------------------------------------------------

test('dedup keeps rules that differ only in action payload or priority', () => {
  const rules = [
    parseLine('||y.example^$removeparam=utm_source'),
    parseLine('||y.example^$removeparam=utm_medium'),
    parseLine('||z.example^'),
    parseLine('||z.example^$important'),
    parseLine('||z.example^'), // true duplicate — must still dedup
  ];
  const { dnrRules, droppedRecords } = buildDNRRules(rules);

  assert.equal(dnrRules.length, 4, 'both removeparams and both priorities must survive');
  assert.equal(
    droppedRecords.filter((r) => r.reason.startsWith('dedup')).length,
    1,
    'the true duplicate is still removed',
  );
});

// ---------------------------------------------------------------------------
// TLD guard operates on the whole host, not the first label (§4.3)
// ---------------------------------------------------------------------------

test('the bare-TLD guard rejects a TLD-only host, not a subdomain that shares a TLD name', () => {
  // The guard captured only up to the first dot, so every pattern whose first
  // SUBDOMAIN label collided with a TLD name was dropped as "anchors on TLD":
  // 1,907 valid filters on a live corpus, 35 of them `@@` exceptions (16 in
  // unbreak.txt, so EasyPrivacy's block shipped while its escape was deleted).
  for (const line of [
    '||app.adjust.com^',
    '||app.link/_r?',
    '||app.clickfunnels.com/cf.js',
    '||cc.naver.com/cc',
    '||tv.example.org^',
    '||dev.example.co.uk^',
    '||in.com/common/script_catch.js',
  ]) {
    assert.ok(convert(line), `${line} must survive the TLD guard`);
  }

  const exception = convert('@@||dev.visualwebsiteoptimizer.com^');
  assert.deepEqual(exception, {
    priority: 3,
    condition: { urlFilter: '||dev.visualwebsiteoptimizer.com^', isUrlFilterCaseSensitive: false },
    action: { type: 'allow' },
  });
});

test('a genuinely bare TLD anchor is still rejected', () => {
  // The guard exists because ||com^ matches every .com host.
  for (const line of ['||com^', '||xyz^', '||co.', '||tv^', '||com/path/ads.js']) {
    assert.equal(convert(line), null, `${line} must still be dropped`);
  }
});

test('an unscoped multi-label public suffix is rejected, a $domain=-scoped one is kept', () => {
  // ||co.uk^ is as broad as ||com^ — but the corpus ships several deliberate
  // narrow rules on public suffixes (||cloudfront.net^$domain=…,
  // ||pages.dev^$script,domain=…), and dropping those costs real coverage.
  assert.equal(convert('||co.uk^'), null);
  assert.equal(convert('||com.br^'), null);
  assert.deepEqual(
    convert('||cloudfront.net^$domain=a.example|b.example'),
    block({ urlFilter: '||cloudfront.net^', initiatorDomains: ['a.example', 'b.example'] }),
  );
  assert.ok(convert('||cloudfront.net/ads/banner.js'), 'a path-scoped rule is not a suffix anchor');
});

// ---------------------------------------------------------------------------
// $badfilter is resolved corpus-wide, not per list (§4.4)
// ---------------------------------------------------------------------------

test('parseFilterList reports the list\'s own $badfilter keys for a corpus-wide pass', () => {
  const unbreak = parseFilterList('||sumo.com^$third-party,badfilter\n||keep.example^\n');
  assert.equal(unbreak.badfilterKeys.size, 1);
  assert.equal(unbreak.networkRules.length, 1, 'the badfilter directive itself never ships');
});

test('a $badfilter in one list cancels a matching rule in another list', () => {
  // unbreak.txt ships 204 badfilters, NONE of which match a rule in
  // unbreak.txt itself while 34 exactly match live EasyList/EasyPrivacy rules.
  // Per-list scope therefore delivered ~0% of the feature to its only real
  // consumer, and `||sumo.com^` kept breaking sites.
  const unbreak = parseFilterList('||sumo.com^$third-party,badfilter\n');
  const privacy = parseFilterList('||sumo.com^$third-party\n||other.example^\n');

  // Phase 1 leaves the victim alive — its own list carries no badfilter.
  assert.equal(privacy.networkRules.length, 2);

  const corpusKeys = new Set([...unbreak.badfilterKeys]);
  const { rules, suppressed } = applyBadfilterSuppression(privacy.networkRules, corpusKeys);
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0].pattern, '||sumo.com^');
  assert.deepEqual(rules.map((r) => r.pattern), ['||other.example^']);
});

test('per-list $badfilter suppression still applies with no corpus keys supplied', () => {
  const parsed = parseFilterList('||ads.example^\n||ads.example^$badfilter\n||keep.example^\n');
  assert.deepEqual(parsed.networkRules.map((r) => r.pattern), ['||keep.example^']);
  assert.equal(
    parsed.skippedRecords.filter((r) => r.reason.startsWith('badfilter-suppressed')).length,
    1,
  );
});

test('a corpus-wide badfilter still requires an exact canonical match', () => {
  // uBO's subset-$domain= narrowing cannot be expressed by exact matching, and
  // guessing would cancel rules the author never targeted.
  const bad = parseFilterList('||ads.example^$third-party,badfilter\n');
  const victim = parseFilterList('||ads.example^\n');
  const { suppressed } = applyBadfilterSuppression(
    victim.networkRules,
    new Set([...bad.badfilterKeys]),
  );
  assert.equal(suppressed.length, 0);
});

// ---------------------------------------------------------------------------
// $domain= values are validated against the DNR schema (§5.29)
// ---------------------------------------------------------------------------

test('$domain= entries are lowercased, punycoded, and empty entries dropped', () => {
  // Chrome rejects the whole rule at ruleset indexing if any entry is
  // uppercase, non-ASCII or empty — `$domain=foo.com|` used to emit
  // ["foo.com", ""] and cost the entire filter.
  assert.deepEqual(
    convert('||ads.example^$domain=foo.com|'),
    block({ urlFilter: '||ads.example^', initiatorDomains: ['foo.com'] }),
  );
  assert.deepEqual(
    convert('||ads.example^$domain=Example.COM'),
    block({ urlFilter: '||ads.example^', initiatorDomains: ['example.com'] }),
  );
  assert.deepEqual(
    convert('||ads.example^$domain=bücher.de'),
    block({ urlFilter: '||ads.example^', initiatorDomains: ['xn--bcher-kva.de'] }),
  );
  assert.deepEqual(
    convert('||ads.example^$domain=~Example.COM'),
    block({ urlFilter: '||ads.example^', excludedInitiatorDomains: ['example.com'] }),
  );
});

test('a $domain= list that normalises to nothing drops the rule instead of shipping it unscoped', () => {
  // Mirrors the wildcard-domain handling: losing every positive entry would
  // widen the rule from "on these sites" to "everywhere".
  assert.equal(convert('||ads.example^$domain=|'), null);
  assert.equal(convert('||ads.example^$domain=ex ample.com'), null);
});

test('an unencodable ~exclusion drops the rule rather than over-applying it', () => {
  assert.equal(convert('||ads.example^$domain=~ex ample.com'), null);
});

// ---------------------------------------------------------------------------
// $removeparam forms we cannot express (§5.30)
// ---------------------------------------------------------------------------

test('$removeparam=~keep is skipped, not shipped stripping a param called "~keep"', () => {
  const parsed = parseLine('||ads.example^$removeparam=~keep');
  assert.equal(parsed.skip, true);
  assert.match(parsed.reason || '', /removeparam-negation/);
});

test('$removeparam=/regex/ is skipped, not shipped stripping a param called "/regex/"', () => {
  const parsed = parseLine('||content.example/api*&ad=$xhr,removeparam=/^ad/,domain=a.example');
  assert.equal(parsed.skip, true);
  assert.match(parsed.reason || '', /removeparam-regex/);
});

test('$removeparam with no value is skipped rather than falling through to a hard block', () => {
  const parsed = parseLine('||ads.example^$removeparam=');
  assert.equal(parsed.skip, true);
  assert.match(parsed.reason || '', /removeparam-all/);
});

test('a literal $removeparam=name still becomes a queryTransform', () => {
  assert.deepEqual(convert('||ads.example^$removeparam=utm_source'), {
    priority: 1,
    condition: { urlFilter: '||ads.example^', isUrlFilterCaseSensitive: false },
    action: {
      type: 'redirect',
      redirect: { transform: { queryTransform: { removeParams: ['utm_source'] } } },
    },
  });
});


// ---------------------------------------------------------------------------
// Chrome refuses a regexFilter whose compiled RE2 program exceeds 2KB, and
// says so only in chrome://extensions. Both defects below shipped rules that
// were silently dropped at ruleset load.
// ---------------------------------------------------------------------------

test('the options separator is found before the regex delimiter, not after', () => {
  // A plain path pattern that both starts and ends with `/`, because its
  // `replace=` value is slash-delimited. Treating it as a regex literal put
  // the whole option string into regexFilter.
  assert.deepEqual(
    splitPatternAndOptions(String.raw`/theme/002/js/application.js?2.0|$script,1p,replace=/video\.maxPop/0/`),
    ['/theme/002/js/application.js?2.0|', String.raw`script,1p,replace=/video\.maxPop/0/`],
  );

  // `$` inside the pattern is an anchor; the separator is the later one whose
  // tail actually parses as an option list.
  assert.deepEqual(
    splitPatternAndOptions(String.raw`/\/_static\/[a-z0-9]{12}\.js\?nonce=\d+$/$script,1p,match-case`),
    [String.raw`/\/_static\/[a-z0-9]{12}\.js\?nonce=\d+$/`, 'script,1p,match-case'],
  );

  // A bare regex literal ending in an anchor has no options at all: the only
  // `$` present is followed by `/`, which is not an option name.
  assert.deepEqual(
    splitPatternAndOptions(String.raw`/banner[0-9]+\.gif$/`),
    [String.raw`/banner[0-9]+\.gif$/`, ''],
  );

  assert.deepEqual(splitPatternAndOptions('||example.com^$third-party'), ['||example.com^', 'third-party']);
  assert.deepEqual(splitPatternAndOptions('||example.com^'), ['||example.com^', '']);
});

test('a rule whose options are slash-delimited never lands in regexFilter', () => {
  for (const line of [
    String.raw`/theme/002/js/application.js?2.0|$script,1p,replace=/video\.maxPop/0/`,
    String.raw`/_static/delivery.js?nonce=$script,1p,header=server:/^openresty\//`,
  ]) {
    const parsed = parseLine(line);
    if (parsed?.skip || parsed === null) continue; // dropped for an unsupported modifier is fine
    const rule = networkFilterToDNR(parsed);
    if (!rule) continue;
    const rf = rule.condition.regexFilter ?? '';
    for (const marker of ['$script,', ',replace=', ',header=']) {
      assert.ok(!rf.includes(marker), `option text leaked into regexFilter: ${rf}`);
    }
  }
});

test('the RE2 budget rejects the patterns Chrome rejected', () => {
  // Every one of these was refused at ruleset load with "exceeded the 2KB
  // memory limit". The cheapest scored 104, which is why the budget sits below
  // that. Cost is dominated by bounded repeats of a class, and by `.` — which
  // under UTF-8 is a multi-byte alternation, not one byte range.
  const refusedByChrome = [
    String.raw`(https?:\/\/)104\.154\..{100,}`,
    String.raw`^https?:\/\/[0-9a-f]{50,}\.s3\.amazonaws\.com\/[0-9a-f]{10}$`,
    String.raw`^https:\/\/st\.pussyspace\.(?:com|net)\/upload\/cat\.image\/[_3a-z]{2,16}\.jpg$`,
    String.raw`^https:\/\/cdn\.jsdelivr\.net\/npm\/[-a-z_]{4,22}@latest\/dist\/script\.min\.js$`,
    String.raw`(https?:\/\/)\w{30,}\.me\/\w{30,}\.`,
  ];
  for (const pattern of refusedByChrome) {
    assert.ok(
      estimateRegexNfaCost(pattern) > MAX_REGEX_NFA_COST,
      `should be over budget: ${pattern} scored ${estimateRegexNfaCost(pattern)}`,
    );
  }
});

test('ordinary regex filters stay within the RE2 budget', () => {
  for (const pattern of [
    String.raw`^https?:\/\/ads\.example\.com\/banner\.gif$`,
    String.raw`\/pagead\/[0-9]{3}\.js`,
    String.raw`^https:\/\/cdn\.example\.net\/[a-f0-9]{8}\.js$`,
  ]) {
    assert.ok(
      estimateRegexNfaCost(pattern) <= MAX_REGEX_NFA_COST,
      `should fit: ${pattern} scored ${estimateRegexNfaCost(pattern)}`,
    );
  }
});

test('a bounded repeat of a class is costed by its upper bound', () => {
  // `{n,}` unrolls n times in RE2; costing it as 1 is what admitted `.{100,}`.
  const one = estimateRegexNfaCost(String.raw`[0-9a-f]`);
  const fifty = estimateRegexNfaCost(String.raw`[0-9a-f]{50,}`);
  assert.ok(fifty >= one * 40, `expected ~50x growth, got ${one} -> ${fifty}`);
  assert.ok(estimateRegexNfaCost('.') > 1, 'dot spans multi-byte sequences under UTF-8');
});
