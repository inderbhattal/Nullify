/**
 * Regression tests for REVIEW-2026-07:
 *  §4.6 — applyUserFilters recorded success (USER_FILTERS_APPLIED) after a
 *         failed DNR write, so startup skipped re-apply forever; and two
 *         overlapping runs corrupted each other's rule ids.
 *  §5.14 — the JS fallback ran whenever the WASM compiler produced zero
 *          rules, resurrecting rules WASM deliberately dropped.
 *  Plus the APPEND_USER_FILTER message contract.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { loadServiceWorker } from './sw-loader.mjs';

const DNR_USER_RULES_START = 900_000;
const DNR_ALLOWLIST_START = 990_000;

function userRules(chrome) {
  return [...chrome.declarativeNetRequest._dynamic.values()]
    .filter((r) => r.id >= DNR_USER_RULES_START && r.id < DNR_ALLOWLIST_START);
}

test('4.6: failed DNR write returns {error} and does NOT record USER_FILTERS_APPLIED', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const original = chrome.declarativeNetRequest.updateDynamicRules;
  chrome.declarativeNetRequest.updateDynamicRules = async () => {
    throw new Error('rule budget exceeded');
  };

  const res = await chrome.runtime.sendMessage({
    type: 'SET_USER_FILTERS',
    payload: { filters: '||ads.example.com^' },
  });

  assert.ok(res.error, 'UI must be able to surface the failure');
  assert.notEqual(
    chrome.storage.local._data().userFiltersApplied,
    '||ads.example.com^',
    'APPLIED must not claim the new filters are live'
  );
  // The user's intent is still saved, so startup can retry the apply.
  assert.equal(chrome.storage.local._data().userFilters, '||ads.example.com^');

  // Restore DNR and re-apply: success path records APPLIED.
  chrome.declarativeNetRequest.updateDynamicRules = original;
  const retry = await chrome.runtime.sendMessage({
    type: 'SET_USER_FILTERS',
    payload: { filters: '||ads.example.com^' },
  });
  assert.equal(retry.error, undefined);
  assert.equal(retry.network, 1);
  assert.equal(chrome.storage.local._data().userFiltersApplied, '||ads.example.com^');

  hooks.cancelPendingStatsPersistForTest();
});

test('4.6: concurrent SET_USER_FILTERS runs are serialized — last write wins cleanly', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const [resA, resB] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'SET_USER_FILTERS', payload: { filters: '||aaa.example^' } }),
    chrome.runtime.sendMessage({ type: 'SET_USER_FILTERS', payload: { filters: '||bbb.example^' } }),
  ]);

  assert.equal(resA.error, undefined, `first apply failed: ${JSON.stringify(resA)}`);
  assert.equal(resB.error, undefined, `second apply failed: ${JSON.stringify(resB)}`);

  const rules = userRules(chrome);
  assert.equal(rules.length, 1, 'exactly the last apply’s rules must be live');
  assert.equal(rules[0].condition.urlFilter, '||bbb.example^');
  assert.equal(chrome.storage.local._data().userFiltersApplied, '||bbb.example^');

  hooks.cancelPendingStatsPersistForTest();
});

test('5.14: WASM success with zero rules must NOT trigger the JS fallback', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  // Simulate the WASM compiler deliberately dropping the only line (the
  // critical-path guard does exactly this for ||googlevideo.com/videoplayback).
  hooks.setCompileUserFiltersOverrideForTest(() => ({
    dnrRules: [],
    cosmeticRules: { generic: [], domainSpecific: {} },
    scriptletRules: [],
  }));

  const res = await chrome.runtime.sendMessage({
    type: 'SET_USER_FILTERS',
    payload: { filters: '||googlevideo.com/videoplayback' },
  });

  assert.equal(res.error, undefined);
  assert.equal(res.network, 0);
  assert.equal(userRules(chrome).length, 0,
    'the JS fallback must not resurrect a rule WASM deliberately dropped');

  hooks.setCompileUserFiltersOverrideForTest(null);
  hooks.cancelPendingStatsPersistForTest();
});

test('5.14: JS fallback still runs on actual WASM failure/unavailability', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  // WASM never initializes in the harness (fetch is disabled) → the compile
  // path reports failure and the JS fallback must take over.
  const res = await chrome.runtime.sendMessage({
    type: 'SET_USER_FILTERS',
    payload: { filters: '||ads.example.com^$script' },
  });

  assert.equal(res.error, undefined);
  assert.equal(res.network, 1);
  const rules = userRules(chrome);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].condition.resourceTypes, ['script']);

  hooks.cancelPendingStatsPersistForTest();
});

test('APPEND_USER_FILTER: appends atomically and runs the same apply path', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: {
      userFilters: '||first.example^',
      userFiltersApplied: '||first.example^',
    },
    awaitReady: true,
  });

  const res = await chrome.runtime.sendMessage({
    type: 'APPEND_USER_FILTER',
    payload: { line: '||second.example^' },
  });

  assert.equal(res.ok, true);
  assert.equal(res.counts.network, 2);
  assert.equal(
    chrome.storage.local._data().userFilters,
    '||first.example^\n||second.example^'
  );
  assert.equal(
    chrome.storage.local._data().userFiltersApplied,
    '||first.example^\n||second.example^'
  );
  assert.deepEqual(
    userRules(chrome).map((r) => r.condition.urlFilter).sort(),
    ['||first.example^', '||second.example^']
  );

  hooks.cancelPendingStatsPersistForTest();
});

test('APPEND_USER_FILTER: concurrent appends both land (read-modify-write is chained)', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const [resA, resB] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'APPEND_USER_FILTER', payload: { line: '||one.example^' } }),
    chrome.runtime.sendMessage({ type: 'APPEND_USER_FILTER', payload: { line: '||two.example^' } }),
  ]);

  assert.equal(resA.ok, true);
  assert.equal(resB.ok, true);
  const stored = chrome.storage.local._data().userFilters;
  assert.ok(stored.includes('||one.example^') && stored.includes('||two.example^'),
    `both lines must survive, got: ${JSON.stringify(stored)}`);
  assert.equal(userRules(chrome).length, 2);

  hooks.cancelPendingStatsPersistForTest();
});

test('APPEND_USER_FILTER: validates input and enforces the size cap', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  for (const payload of [undefined, {}, { line: 42 }, { line: '   ' }, { line: 'a\nb' }, { line: 'a\rb' }]) {
    const res = await chrome.runtime.sendMessage({ type: 'APPEND_USER_FILTER', payload });
    assert.ok(res.error, `expected {error} for payload ${JSON.stringify(payload)}`);
  }

  // Size cap: current filters already near the 2 MB limit.
  await chrome.storage.local.set({ userFilters: 'a'.repeat(2 * 1024 * 1024 - 2) });
  const res = await chrome.runtime.sendMessage({
    type: 'APPEND_USER_FILTER',
    payload: { line: '||overflow.example^' },
  });
  assert.match(res.error, /byte limit/);
  assert.equal(userRules(chrome).length, 0);

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §4.15 (REVIEW-2026-07) — one bad user-filter line must not kill the entire
// user ruleset. `updateDynamicRules` is all-or-nothing, so a single IDN
// urlFilter or non-RE2 regex used to zero out every user rule.
// ---------------------------------------------------------------------------

test('4.15: a non-ASCII urlFilter is skipped, the remaining rules still apply', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  // Simulate the WASM compiler forwarding patterns verbatim (its real
  // behavior): one IDN rule alongside two valid ones.
  hooks.setCompileUserFiltersOverrideForTest(() => ({
    dnrRules: [
      { id: DNR_USER_RULES_START, priority: 1, condition: { urlFilter: '||good-a.example^' }, action: { type: 'block' } },
      { id: DNR_USER_RULES_START + 1, priority: 1, condition: { urlFilter: '||пример.рф^' }, action: { type: 'block' } },
      { id: DNR_USER_RULES_START + 2, priority: 1, condition: { urlFilter: '||good-b.example^' }, action: { type: 'block' } },
    ],
    cosmeticRules: { generic: [], domainSpecific: {} },
    scriptletRules: [],
  }));

  const res = await chrome.runtime.sendMessage({
    type: 'SET_USER_FILTERS',
    payload: { filters: '||good-a.example^\n||пример.рф^\n||good-b.example^' },
  });

  assert.equal(res.error, undefined, `whole batch must not fail: ${JSON.stringify(res)}`);
  assert.equal(res.network, 2, 'the two valid rules must be applied');
  assert.equal(res.skippedNetwork, 1, 'the bad rule must be reported as skipped');
  assert.match(res.skippedRules[0].reason, /ASCII/i);

  const live = userRules(chrome).map((r) => r.condition.urlFilter).sort();
  assert.deepEqual(live, ['||good-a.example^', '||good-b.example^']);

  hooks.setCompileUserFiltersOverrideForTest(null);
  hooks.cancelPendingStatsPersistForTest();
});

test('4.15: RE2-incompatible regex rules are dropped via isRegexSupported', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  hooks.setCompileUserFiltersOverrideForTest(() => ({
    dnrRules: [
      { id: DNR_USER_RULES_START, priority: 1, condition: { regexFilter: 'ads(?!good)' }, action: { type: 'block' } },
      { id: DNR_USER_RULES_START + 1, priority: 1, condition: { regexFilter: 'ads[0-9]+' }, action: { type: 'block' } },
    ],
    cosmeticRules: { generic: [], domainSpecific: {} },
    scriptletRules: [],
  }));

  const res = await chrome.runtime.sendMessage({
    type: 'SET_USER_FILTERS',
    payload: { filters: '/ads(?!good)/\n/ads[0-9]+/' },
  });

  assert.equal(res.error, undefined);
  assert.equal(res.network, 1);
  assert.equal(res.skippedNetwork, 1);
  assert.match(res.skippedRules[0].reason, /RE2/);
  assert.equal(userRules(chrome).length, 1);

  hooks.setCompileUserFiltersOverrideForTest(null);
  hooks.cancelPendingStatsPersistForTest();
});

test('4.15: without isRegexSupported (packed-API drift), chunk retry isolates the offender', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  // Feature-detection path: the API is absent, so preflight cannot vet the
  // regex — Chrome (the stub) rejects it at add time, and the per-rule retry
  // must confine the damage to that one rule.
  delete chrome.declarativeNetRequest.isRegexSupported;

  hooks.setCompileUserFiltersOverrideForTest(() => ({
    dnrRules: [
      { id: DNR_USER_RULES_START, priority: 1, condition: { urlFilter: '||good-a.example^' }, action: { type: 'block' } },
      { id: DNR_USER_RULES_START + 1, priority: 1, condition: { regexFilter: 'ads(?!good)' }, action: { type: 'block' } },
      { id: DNR_USER_RULES_START + 2, priority: 1, condition: { urlFilter: '||good-b.example^' }, action: { type: 'block' } },
    ],
    cosmeticRules: { generic: [], domainSpecific: {} },
    scriptletRules: [],
  }));

  const res = await chrome.runtime.sendMessage({
    type: 'SET_USER_FILTERS',
    payload: { filters: '||good-a.example^\n/ads(?!good)/\n||good-b.example^' },
  });

  assert.equal(res.error, undefined, `whole batch must not fail: ${JSON.stringify(res)}`);
  assert.equal(res.network, 2);
  assert.equal(res.skippedNetwork, 1);
  assert.equal(userRules(chrome).length, 2);

  hooks.setCompileUserFiltersOverrideForTest(null);
  hooks.cancelPendingStatsPersistForTest();
});
