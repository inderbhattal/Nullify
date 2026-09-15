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
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// ---------------------------------------------------------------------------
// REVIEW-2026-09 §3.3 / A1c — release-1 migration. ensureBackgroundSetup skips
// applyUserFilters when USER_FILTERS === USER_FILTERS_APPLIED, and dynamic
// DNR rules persist across updates: a user whose My Filters were compiled by
// the pre-fix compiler keeps its broadened rules until they next edit the
// text. An update boot must clear the APPLIED marker before background setup
// so the stored text is recompiled with the fixed compiler.
// ---------------------------------------------------------------------------

function recordingCompileOverride(calls) {
  return (text) => {
    calls.push(text);
    return { dnrRules: [], cosmeticRules: { generic: [], domainSpecific: {} }, scriptletRules: [] };
  };
}

test('3.3: an update boot recompiles user filters whose APPLIED marker matches', async () => {
  const TEXT = '||ads.example^';
  const { chrome, hooks } = await loadServiceWorker({
    seed: { userFilters: TEXT, userFiltersApplied: TEXT },
  });
  const compiled = [];
  hooks.setCompileUserFiltersOverrideForTest(recordingCompileOverride(compiled));

  // Fired right after load, as Chrome does on an extension update: the
  // handler runs concurrently with startInitialization.
  const installed = chrome.runtime.onInstalled._fireAsync({ reason: 'update' });
  await installed;
  await hooks.whenCriticalReady();
  await hooks.whenBackgroundSetupDone();

  assert.deepEqual(compiled, [TEXT],
    'the stored text must be recompiled exactly once — the equal-marker check used to skip it');
  assert.equal(chrome.storage.local._data().userFiltersApplied, TEXT,
    'APPLIED is re-recorded once the recompile succeeded');
  assert.ok(!hooks.errorReport.critical.some((e) => e.context !== 'WASM initialization'),
    `the update handler and background setup must complete: ${JSON.stringify(hooks.errorReport.critical)}`);

  hooks.setCompileUserFiltersOverrideForTest(null);
  hooks.cancelPendingStatsPersistForTest();
});

test('3.3 (didn\'t re-break): an ordinary wake with a matching APPLIED marker still skips the compile', async () => {
  const TEXT = '||ads.example^';
  const { chrome, hooks } = await loadServiceWorker({
    seed: { userFilters: TEXT, userFiltersApplied: TEXT },
  });
  const compiled = [];
  hooks.setCompileUserFiltersOverrideForTest(recordingCompileOverride(compiled));
  await hooks.whenCriticalReady();
  await hooks.whenBackgroundSetupDone();

  assert.deepEqual(compiled, [], 'no update, equal markers ⇒ nothing to recompile');
  assert.equal(chrome.storage.local._data().userFiltersApplied, TEXT);

  hooks.setCompileUserFiltersOverrideForTest(null);
  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// REVIEW-2026-09 §3.3 surface (A2) — B1 made `compile_user_filters` fail
// closed on options it cannot express and report each dropped line through
// `droppedLines: [{line, reason}]`. The SW used to discard that field, so the
// options page said "Applied 0 network rules" and `skippedRules: []` for a
// paste that was silently thrown away. Dropped lines now ride the existing
// `skippedRules` channel as `{id: null, reason, line}` and count in
// `skippedNetwork` (Track H renders `id: null` entries as the line text).
// ---------------------------------------------------------------------------

const REMOVEPARAM_LINE = '||x^$removeparam=a';

test('3.3: dropped user-filter lines are reported through skippedRules', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  hooks.setCompileUserFiltersOverrideForTest(() => ({
    dnrRules: [],
    cosmeticRules: { generic: [], domainSpecific: {} },
    scriptletRules: [],
    droppedLines: [{ line: REMOVEPARAM_LINE, reason: 'unsupported option: removeparam' }],
  }));

  const res = await chrome.runtime.sendMessage({
    type: 'SET_USER_FILTERS',
    payload: { filters: REMOVEPARAM_LINE },
  });

  assert.equal(res.error, undefined, JSON.stringify(res));
  assert.equal(res.network, 0);
  assert.equal(res.skippedNetwork, 1,
    'a line the compiler dropped is a skipped rule, not a silent no-op');
  assert.ok(Array.isArray(res.skippedRules) && res.skippedRules.length === 1,
    `expected one skippedRules entry, got ${JSON.stringify(res.skippedRules)}`);
  assert.match(res.skippedRules[0].reason, /removeparam/,
    'the reason must name the option that could not be expressed');
  assert.deepEqual(res.skippedRules[0], {
    id: null,
    reason: 'unsupported option: removeparam',
    line: REMOVEPARAM_LINE,
  });
  assert.equal(userRules(chrome).length, 0,
    'the JS fallback must not resurrect the dropped line');

  hooks.setCompileUserFiltersOverrideForTest(null);
  hooks.cancelPendingStatsPersistForTest();
});

test('3.3 (real compiler): a $removeparam line through compile_user_filters yields the entry', async (t) => {
  // The harness cuts the network, so the worker's own WASM init fails; load
  // the artifact from disk (as wasm-parity does) and route the REAL
  // compile_user_filters through the override seam so the whole chain —
  // Rust droppedLines → _applyUserFiltersNow → SET_USER_FILTERS reply — runs.
  const wasmDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/shared/wasm');
  const gluePath = path.join(wasmDir, 'nullify_core.js');
  const bytesPath = path.join(wasmDir, 'nullify_core_bg.wasm');
  if (!fs.existsSync(gluePath) || !fs.existsSync(bytesPath)) {
    t.skip('WASM artifact not built (run `npm run build:wasm`)');
    return;
  }
  const wasm = await import(pathToFileURL(gluePath).href);
  await wasm.default({ module_or_path: fs.readFileSync(bytesPath) });

  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });
  hooks.setCompileUserFiltersOverrideForTest(
    (text, startId) => wasm.compile_user_filters(text, startId)
  );

  const res = await chrome.runtime.sendMessage({
    type: 'SET_USER_FILTERS',
    payload: { filters: '||facebook.com^$removeparam=fbclid\n||ads.example^' },
  });

  assert.equal(res.error, undefined, JSON.stringify(res));
  assert.equal(res.network, 1, 'the expressible line still applies');
  assert.equal(userRules(chrome).length, 1);
  assert.equal(userRules(chrome)[0].condition.urlFilter, '||ads.example^');
  assert.equal(res.skippedNetwork, 1);
  assert.deepEqual(res.skippedRules, [{
    id: null,
    reason: 'unsupported option: removeparam',
    line: '||facebook.com^$removeparam=fbclid',
  }]);

  hooks.setCompileUserFiltersOverrideForTest(null);
  hooks.cancelPendingStatsPersistForTest();
});
