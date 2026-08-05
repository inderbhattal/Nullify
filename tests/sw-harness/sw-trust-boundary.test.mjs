/**
 * Regression tests for the service-worker trust-boundary / diagnostics pass
 * (REVIEW-2026-08):
 *
 *  §4.11 — the bus catch-all answered `{error}` and called nothing, so a
 *          handler that threw left GET_ERROR_REPORT describing a healthy
 *          extension.
 *  §4.19 — GET_INIT_DATA trusted `payload.hostname`, so any renderer could
 *          read the user's own per-site cosmetic filters for any host and
 *          decide its own allowlist verdict.
 *  §4.24 — the context-menu picker sender carried no `frameId`, so every
 *          iframe on the page built its own undismissable overlay.
 *  §5.5  — the user-filter cap counted UTF-16 code units while the options
 *          page and wasm-core counted UTF-8 bytes.
 *  §5.6  — parseSimpleNetworkRule was a fourth, unhardened filter parser.
 *  §5.20 — the SW's PROC_OPS omitted `semantic`, so on the WASM-down path
 *          `div:semantic(x)` shipped to the page as literal CSS.
 *  §5.22 — the page bundle's unknown-scriptlet counter had no consumer.
 *  §5.25 — `trusted-*` scriptlets had no trust gate anywhere.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { TRUSTED_SCRIPTLETS } from '../../src/scriptlets/index.js';
import { parseLine } from '../../src/shared/filter-parser.js';
import { loadServiceWorker } from './sw-loader.mjs';

/** Sender shape of our content script running in an arbitrary web page. */
function contentScriptSender(tabId = 7, url = 'https://evil.example/page') {
  return { url, tab: { id: tabId, url }, frameId: 0 };
}

const DNR_USER_RULES_START = 900_000;

function userRules(chrome) {
  return [...chrome.declarativeNetRequest._dynamic.values()]
    .filter((r) => r.id >= DNR_USER_RULES_START && r.id < 990_000);
}

// ---------------------------------------------------------------------------
// §4.19 — the hostname comes from the sender, not the payload
// ---------------------------------------------------------------------------

test('4.19: a renderer cannot read another host\'s user cosmetic filters via payload.hostname', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: {
      userCosmeticRules: {
        generic: [],
        domainSpecific: { 'private.example': ['.users-own-secret-selector'] },
        genericExceptions: [],
        domainExceptions: {},
      },
    },
    awaitReady: true,
  });

  const res = await chrome.runtime.sendMessage(
    { type: 'GET_INIT_DATA', payload: { hostname: 'private.example' } },
    contentScriptSender(7, 'https://evil.example/page')
  );

  const leaked = JSON.stringify([res.cssText, res.cosmeticRules, res.exceptionCss]);
  assert.ok(
    !leaked.includes('users-own-secret-selector'),
    'a claimed hostname must not disclose the user\'s filters for that host'
  );

  // The same request from the host that actually owns the rule still gets it.
  const legit = await chrome.runtime.sendMessage(
    { type: 'GET_INIT_DATA', payload: { hostname: 'anything-at-all' } },
    contentScriptSender(8, 'https://private.example/x')
  );
  assert.ok(
    JSON.stringify([legit.cssText, legit.cosmeticRules]).includes('users-own-secret-selector'),
    'the real host must still receive its own rule'
  );

  hooks.cancelPendingStatsPersistForTest();
});

test('4.19: a renderer cannot escape its own allowlist entry by claiming another hostname', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const allowed = await chrome.runtime.sendMessage({
    type: 'ALLOW_SITE', payload: { domain: 'evil.example' } });
  assert.equal(allowed.ok, true);

  // Seed a scriptlet for the real host so "did the gate hold?" is observable
  // as an injection, not just as a boolean.
  await chrome.storage.local.set({
    userScriptletRules: [{ name: 'noeval', domains: ['evil.example'], args: [], excludedDomains: [] }],
  });

  const res = await chrome.runtime.sendMessage(
    { type: 'GET_INIT_DATA', payload: { hostname: 'not-allowlisted.example' } },
    contentScriptSender(7, 'https://evil.example/page')
  );

  assert.equal(res.isAllowed, true,
    'isAllowed must describe the frame that asked, not the hostname it claimed');
  assert.equal(
    chrome.calls.filter((c) => c.api === 'scripting.executeScript').length, 0,
    'an allowlisted frame must not get scriptlets injected by claiming another host'
  );

  hooks.cancelPendingStatsPersistForTest();
});

test('4.19: extension pages and about:blank frames still supply their own hostname', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: {
      userCosmeticRules: {
        generic: [],
        domainSpecific: { 'parent.example': ['.parent-only'] },
        genericExceptions: [],
        domainExceptions: {},
      },
    },
    awaitReady: true,
  });

  // An `about:blank` iframe inherits its parent's origin; `sender.url` yields
  // no hostname, so the content script's computed hostname is all there is.
  const blankFrame = await chrome.runtime.sendMessage(
    { type: 'GET_INIT_DATA', payload: { hostname: 'parent.example' } },
    { url: 'about:blank', tab: { id: 9, url: 'https://parent.example/' }, frameId: 3 }
  );
  assert.ok(
    JSON.stringify([blankFrame.cssText, blankFrame.cosmeticRules]).includes('parent-only'),
    'about:blank subframes must keep working'
  );

  // Extension pages have no sender.tab and are trusted.
  const fromPage = await chrome.runtime.sendMessage(
    { type: 'GET_INIT_DATA', payload: { hostname: 'parent.example' } });
  assert.ok(
    JSON.stringify([fromPage.cssText, fromPage.cosmeticRules]).includes('parent-only'));

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §4.11 — a handler that throws must reach the error report
// ---------------------------------------------------------------------------

test('4.11: the bus catch-all routes handler failures through reportError', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  await chrome.runtime.sendMessage({ type: 'CLEAR_ERROR_REPORT' });

  // No payload — the handler dereferences `payload.rulesetId` and throws.
  const res = await chrome.runtime.sendMessage({ type: 'SET_RULESET_ENABLED' });
  assert.ok(res.error, 'the caller still gets the {error} shape');

  const report = await chrome.runtime.sendMessage({ type: 'GET_ERROR_REPORT' });
  assert.ok(
    report.warnings.some((w) => w.context === 'message:SET_RULESET_ENABLED'),
    `a thrown handler must be visible in GET_ERROR_REPORT, got ${JSON.stringify(report.warnings)}`
  );
  assert.equal(report.lastError?.context, 'message:SET_RULESET_ENABLED');

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §4.24 — the picker is a top-frame overlay
// ---------------------------------------------------------------------------

test('4.24: the context-menu picker targets frame 0 only', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  chrome.contextMenus.onClicked._fire(
    { menuItemId: 'nullify-block-element' }, { id: 42, url: 'https://site.example/' });

  const sends = chrome.calls.filter((c) => c.api === 'tabs.sendMessage');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].message.type, 'ACTIVATE_PICKER');
  assert.deepEqual(sends[0].options, { frameId: 0 },
    'without {frameId: 0} every iframe builds its own undismissable overlay');

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §5.5 — the user-filter cap is a byte budget
// ---------------------------------------------------------------------------

test('5.5: the user-filter cap counts UTF-8 bytes, not UTF-16 code units', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  // 1.1M Cyrillic characters: 1.1M UTF-16 code units (under the 2 MB cap when
  // measured wrongly) but 2.2M UTF-8 bytes (over it). wasm-core measures bytes
  // and throws, and `compileUserFiltersViaWasm` cannot distinguish that throw
  // from "WASM unavailable" — so the naive fallback used to run on the blob.
  const big = 'ф'.repeat(1_100_000);
  assert.ok(big.length < 2 * 1024 * 1024, 'must pass a UTF-16 length check');
  assert.ok(new TextEncoder().encode(big).length > 2 * 1024 * 1024);

  const res = await chrome.runtime.sendMessage({
    type: 'SET_USER_FILTERS', payload: { filters: big } });
  assert.match(res.error || '', /byte limit/);
  assert.equal(chrome.storage.local._data().userFilters ?? '', '',
    'nothing over the cap may be stored');

  const appended = await chrome.runtime.sendMessage({
    type: 'APPEND_USER_FILTER', payload: { line: big } });
  assert.match(appended.error || '', /byte limit/);

  // An ASCII list of the same UTF-16 length is genuinely under the cap.
  const ok = await chrome.runtime.sendMessage({
    type: 'SET_USER_FILTERS', payload: { filters: '! ' + 'a'.repeat(1_100_000) } });
  assert.equal(ok.error, undefined, `a 1.1 MB ASCII list must still be accepted: ${JSON.stringify(ok)}`);

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §5.6 — the fallback network parser fails closed
// ---------------------------------------------------------------------------

test('5.6: parseSimpleNetworkRule refuses every option it cannot express', async () => {
  const { hooks } = await loadServiceWorker({ awaitReady: true });
  const parse = hooks.parseSimpleNetworkRule;

  const mustDrop = [
    // Negates another rule — emitting a block inverts its meaning entirely.
    '||ads.example^$badfilter',
    // Rewrites the URL; as a plain block it took down the whole domain.
    '||ads.example^$removeparam=fbclid',
    // Cosmetic-scope exceptions. As `{action: allow}` these were §3.3's
    // blanket network-allow: one line switching off blocking for a domain.
    '@@||site.example^$ghide',
    '@@||site.example^$generichide',
    '@@||site.example^$elemhide',
    '@@||site.example^$ehide',
    '@@||site.example^$specifichide',
    '@@||site.example^$shide',
    '@@||site.example^$genericblock',
    // Priority modifier — silently downgraded to an ordinary block.
    '||ads.example^$important',
    // Narrowing options: ignoring them broadens a block or, worse, an allow.
    '||ads.example^$third-party',
    '||ads.example^$domain=foo.example',
    '@@||site.example^$domain=foo.example',
    '||ads.example^$~script',
    '||ads.example^$csp=script-src none',
    '||ads.example^$redirect=noopjs',
    // Trailing/empty option tokens.
    '||ads.example^$',
    '||ads.example^$script,',
  ];

  for (const line of mustDrop) {
    assert.equal(parse(line, 900_001), null, `must refuse: ${line}`);
  }

  // What it CAN express still works, at the pinned user-filter bands.
  const block = parse('||ads.example^', 900_001);
  assert.equal(block.action.type, 'block');
  assert.equal(block.priority, hooks.DNR_USER_FILTER_PRIORITY.BLOCK);
  assert.equal(block.condition.urlFilter, '||ads.example^');
  assert.equal(block.condition.resourceTypes, undefined);

  const allow = parse('@@||site.example^', 900_002);
  assert.equal(allow.action.type, 'allow');
  assert.equal(allow.priority, hooks.DNR_USER_FILTER_PRIORITY.ALLOW);

  const typed = parse('||ads.example^$script,image', 900_003);
  assert.deepEqual(typed.condition.resourceTypes, ['script', 'image']);

  // Option matching is case-insensitive and whitespace-tolerant, like uBO's.
  assert.deepEqual(parse('||ads.example^$Script, image', 900_004).condition.resourceTypes,
    ['script', 'image']);
});

test('5.6: the SW\'s cosmetic-scope option set agrees with the shared parser', async () => {
  // `COSMETIC_SCOPE_OPTIONS` in src/shared/filter-parser.js is still module-
  // private, so the SW keeps a copy (see the TODO there). Assert parity
  // behaviourally instead: every option the SW refuses to turn into a network
  // rule must be one the shared parser classifies as a cosmetic-scope
  // exception, and vice versa for a few options that are NOT scope options.
  const { hooks } = await loadServiceWorker({ awaitReady: true });

  for (const option of ['generichide', 'ghide', 'elemhide', 'ehide',
    'specifichide', 'shide', 'genericblock']) {
    assert.equal(
      parseLine(`@@||site.example^$${option}`)?.type, 'cosmetic-scope-exception',
      `the shared parser must treat $${option} as cosmetic scope`);
    assert.equal(
      hooks.parseSimpleNetworkRule(`@@||site.example^$${option}`, 900_001), null,
      `the SW must not turn $${option} into a network rule`);
  }

  // A control: `$script` is a genuine network option in both.
  assert.equal(parseLine('@@||site.example^$script'), null);
  assert.ok(hooks.parseSimpleNetworkRule('@@||site.example^$script', 900_001));

  hooks.cancelPendingStatsPersistForTest();
});

test('5.6: a $ghide user filter produces no DNR allow rule on the WASM-down path', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const res = await chrome.runtime.sendMessage({
    type: 'SET_USER_FILTERS',
    payload: { filters: '@@||site.example^$ghide\n||real-ad.example^' },
  });
  assert.equal(res.error, undefined, JSON.stringify(res));

  const rules = userRules(chrome);
  assert.ok(
    !rules.some((r) => r.action.type === 'allow'),
    `a generic-hide exception must never become a network allow: ${JSON.stringify(rules)}`
  );
  assert.deepEqual(rules.map((r) => r.condition.urlFilter), ['||real-ad.example^'],
    'the ordinary block on the same list still applies');

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §5.20 — `semantic` is a procedural operator here too
// ---------------------------------------------------------------------------

test('5.20: :semantic() is planned as procedural, not emitted as CSS', async () => {
  const { hooks } = await loadServiceWorker({
    seed: {
      userCosmeticRules: {
        generic: [],
        domainSpecific: { 'example.com': ['div.card:semantic(sponsored post)'] },
        genericExceptions: [],
        domainExceptions: {},
      },
    },
    awaitReady: true,
  });

  const bundle = await hooks.getCosmeticBundleForPage('example.com');

  assert.ok(
    !(bundle.cssText || '').includes(':semantic('),
    'a :semantic() selector emitted as plain CSS matches nothing — the rule dies silently'
  );

  const planned = (bundle.rules.domainSpecific || [])
    .find((r) => r.selector === 'div.card:semantic(sponsored post)');
  assert.ok(planned, 'the selector must survive as a procedural rule');
  assert.ok(
    planned.plan.some((step) => step.type === 'op' && step.op === 'semantic'),
    `the plan must carry the semantic op: ${JSON.stringify(planned.plan)}`
  );

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §5.25 — the trust gate
// ---------------------------------------------------------------------------

test('5.25: the worker\'s trusted-scriptlet set matches the registry\'s', async () => {
  const { hooks } = await loadServiceWorker({ awaitReady: true });
  assert.deepEqual(
    [...hooks.TRUSTED_ONLY_SCRIPTLETS].sort(),
    [...TRUSTED_SCRIPTLETS].sort(),
    'the SW mirrors src/scriptlets/index.js rather than importing it; the two must not drift'
  );
});

test('5.25: user filters cannot invoke a trust-gated scriptlet', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: {
      userScriptletRules: [
        // The APPEND_USER_FILTER shape: reachable from any renderer.
        { name: 'trusted-set-constant', domains: ['evil.example'], args: ['window.x', '{"a":1}'], excludedDomains: [] },
        { name: 'tsc', domains: [], args: ['window.y', '2'], excludedDomains: [] },
        { name: 'trusted-replace-fetch-response', domains: ['evil.example'], args: ['a', 'b'], excludedDomains: [] },
        { name: 'rpnt', domains: ['evil.example'], args: ['script', 'a', 'b'], excludedDomains: [] },
        { name: 'noeval', domains: ['evil.example'], args: [], excludedDomains: [] },
      ],
    },
    awaitReady: true,
  });

  const specs = await hooks.getScriptletRulesForPage('evil.example');
  assert.deepEqual(specs.map((s) => s.name), ['noeval'],
    `only untrusted scriptlets may come from user filters: ${JSON.stringify(specs.map((s) => s.name))}`);

  const report = await chrome.runtime.sendMessage({ type: 'GET_ERROR_REPORT' });
  assert.equal(report.scriptlets.refusedUntrustedTotal, 4);
  assert.equal(report.scriptlets.refusedUntrusted['trusted-set-constant'], 1);
  assert.equal(report.scriptlets.refusedUntrusted['rpnt'], 1);

  hooks.cancelPendingStatsPersistForTest();
});

test('5.25: curated list rules keep their trusted scriptlets; unknown list ids do not', async () => {
  const { hooks } = await loadServiceWorker({ awaitReady: true });

  const specs = [
    { name: 'trusted-set-cookie', domains: ['site.example'], args: ['a', 'b'] },
    { name: 'noeval', domains: ['site.example'], args: [] },
  ];

  assert.deepEqual(
    hooks.filterTrustedScriptlets(specs, 'list').map((s) => s.name),
    ['trusted-set-cookie', 'noeval'],
    'uAssets ships 951 trusted-set-cookie rules; the gate must not break them'
  );

  // Every id the worker knows is trusted…
  for (const listId of hooks.TRUSTED_FILTER_LIST_IDS) {
    assert.equal(
      hooks.filterTrustedScriptlets([{ ...specs[0], listId }], 'list').length, 1, listId);
  }
  // …and anything else fails closed, ready for custom subscriptions.
  assert.deepEqual(
    hooks.filterTrustedScriptlets([{ ...specs[0], listId: 'some-third-party-list' }], 'list'),
    []);

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §5.22 — the unknown-scriptlet counter reaches GET_ERROR_REPORT
// ---------------------------------------------------------------------------

test('5.22: unknown scriptlet names reported by the page reach GET_ERROR_REPORT', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  // Evaluate the injected funcs in-process against a stand-in MAIN world.
  globalThis.window = globalThis;
  chrome.scripting._evaluateInjectedFuncs = true;

  const key = hooks.SCRIPTLET_REGISTRY_KEY;
  const dispatched = [];
  Object.defineProperty(globalThis, key, {
    value: Object.freeze({
      run: (name, args) => { dispatched.push([name, args]); },
      // The shape src/scriptlets/index.js must expose for this to carry data.
      getUnknownScriptlets: () => ({ 'trusted-set-cookie': 3, 'rmnt': 1 }),
    }),
    writable: false,
    configurable: false,
    enumerable: false,
  });

  await hooks.injectScriptlets(11, 0, [{ name: 'noeval', args: [] }]);
  assert.deepEqual(dispatched, [['noeval', []]],
    'the registry must still pass verification and receive the specs');

  const report = await chrome.runtime.sendMessage({ type: 'GET_ERROR_REPORT' });
  assert.equal(report.scriptlets.unknown['trusted-set-cookie'], 3);
  assert.equal(report.scriptlets.unknown['rmnt'], 1);
  assert.equal(report.scriptlets.unknownTotal, 4);

  // A second page's misses accumulate rather than replacing the first's.
  await hooks.injectScriptlets(12, 0, [{ name: 'noeval', args: [] }]);
  const second = await chrome.runtime.sendMessage({ type: 'GET_ERROR_REPORT' });
  assert.equal(second.scriptlets.unknownTotal, 8);

  // CLEAR_ERROR_REPORT resets the diagnostic counters too.
  await chrome.runtime.sendMessage({ type: 'CLEAR_ERROR_REPORT' });
  const cleared = await chrome.runtime.sendMessage({ type: 'GET_ERROR_REPORT' });
  assert.deepEqual(cleared.scriptlets.unknown, {});

  chrome.scripting._evaluateInjectedFuncs = false;
  delete globalThis.window;
  hooks.cancelPendingStatsPersistForTest();
});

test('5.22: a bundle without the diagnostics accessor still receives its specs', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  globalThis.window = globalThis;
  chrome.scripting._evaluateInjectedFuncs = true;

  const key = hooks.SCRIPTLET_REGISTRY_KEY;
  const dispatched = [];
  Object.defineProperty(globalThis, key, {
    value: Object.freeze({ run: (name) => { dispatched.push(name); } }),
    writable: false,
    configurable: false,
    enumerable: false,
  });

  await hooks.injectScriptlets(13, 0, [{ name: 'noeval', args: [] }]);
  assert.deepEqual(dispatched, ['noeval'],
    'the readback is optional; a registry without it must not be refused');

  const report = await chrome.runtime.sendMessage({ type: 'GET_ERROR_REPORT' });
  assert.deepEqual(report.scriptlets.unknown, {});

  chrome.scripting._evaluateInjectedFuncs = false;
  delete globalThis.window;
  hooks.cancelPendingStatsPersistForTest();
});

test('5.22: a page-forged registry is still refused despite the relaxed key set', async () => {
  const { hooks } = await loadServiceWorker({ awaitReady: true });
  globalThis.window = globalThis;
  const verify = hooks.verifyScriptletRegistry;

  const makeKey = (c) => '__n_' + c.repeat(32);

  // An extra key outside the allowlist is still a forgery.
  const extraKey = makeKey('1');
  Object.defineProperty(globalThis, extraKey, {
    value: Object.freeze({ run: () => {}, getUnknownScriptlets: () => ({}), extra: 1 }),
    writable: false, configurable: false, enumerable: false,
  });
  assert.equal(verify(extraKey), false);

  // A non-function `getUnknownScriptlets` is refused (no data smuggling).
  const badTypeKey = makeKey('2');
  Object.defineProperty(globalThis, badTypeKey, {
    value: Object.freeze({ run: () => {}, getUnknownScriptlets: 'nope' }),
    writable: false, configurable: false, enumerable: false,
  });
  assert.equal(verify(badTypeKey), false);

  // Missing `run` is refused even if the diagnostics accessor is present.
  const noRunKey = makeKey('3');
  Object.defineProperty(globalThis, noRunKey, {
    value: Object.freeze({ getUnknownScriptlets: () => ({}) }),
    writable: false, configurable: false, enumerable: false,
  });
  assert.equal(verify(noRunKey), false);

  // The two legitimate shapes pass.
  const runOnlyKey = makeKey('4');
  Object.defineProperty(globalThis, runOnlyKey, {
    value: Object.freeze({ run: () => {} }),
    writable: false, configurable: false, enumerable: false,
  });
  assert.equal(verify(runOnlyKey), true);

  const withDiagKey = makeKey('5');
  Object.defineProperty(globalThis, withDiagKey, {
    value: Object.freeze({ run: () => {}, getUnknownScriptlets: () => ({}) }),
    writable: false, configurable: false, enumerable: false,
  });
  assert.equal(verify(withDiagKey), true);

  delete globalThis.window;
  hooks.cancelPendingStatsPersistForTest();
});
