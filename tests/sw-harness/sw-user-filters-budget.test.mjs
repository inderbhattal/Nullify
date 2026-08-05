/**
 * Regression tests for REVIEW-2026-08:
 *  §4.15 — `USER_FILTERS_APPLIED` was written BEFORE the scriptlet store and
 *          `clearPageBundles()`. It is the sole guard that lets startup skip
 *          the re-apply, so an interruption in between left the marker saying
 *          "applied" over stale scriptlets and stale persisted page bundles,
 *          with no retry — ever.
 *  §4.16 — the chunked retry could not tell "this rule is malformed" from "the
 *          ruleset is full", so a large paste degenerated into one
 *          `updateDynamicRules` call per rule, none of which could succeed; and
 *          nothing bounded the rule count or kept ids below the allowlist range.
 *  §5.1  — FORCE_CLEAN_ALL_DYNAMIC_RULES deleted the user-filter rules but left
 *          the marker, so the startup short-circuit meant they never came back.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { loadServiceWorker } from './sw-loader.mjs';

const DNR_USER_RULES_START = 900_000;
const DNR_ALLOWLIST_START = 990_000;

/** A synthetic "WASM compiled successfully" bundle of `count` DNR rules. */
function syntheticCompiled(count, { startId = DNR_USER_RULES_START, extraRules = [] } = {}) {
  const dnrRules = [];
  for (let i = 0; i < count; i++) {
    dnrRules.push({
      id: startId + i,
      priority: 1,
      condition: { urlFilter: `||ad${i}.example^` },
      action: { type: 'block' },
    });
  }
  return {
    dnrRules: dnrRules.concat(extraRules),
    cosmeticRules: { generic: [], domainSpecific: {}, exceptions: [] },
    scriptletRules: [],
  };
}

function userRules(chrome) {
  return [...chrome.declarativeNetRequest._dynamic.values()]
    .filter((r) => r.id >= DNR_USER_RULES_START && r.id < DNR_ALLOWLIST_START);
}

// ---------------------------------------------------------------------------
// §4.15 — the marker certifies state, so it is written last
// ---------------------------------------------------------------------------

test('4.15: USER_FILTERS_APPLIED is written after the scriptlet store and the bundle clear', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  let bundlesClearedAt = -1;
  const origClearPageBundles = hooks.db.clearPageBundles.bind(hooks.db);
  hooks.db.clearPageBundles = async () => {
    bundlesClearedAt = chrome.calls.length;
    return origClearPageBundles();
  };

  chrome.calls.clear();
  await hooks.setAndApplyUserFilters('example.com##.ad\nexample.com##+js(noeval)');
  hooks.db.clearPageBundles = origClearPageBundles;

  const writeIndex = (key) => chrome.calls.entries
    .findIndex((c) => c.api === 'storage.set' && Object.hasOwn(c.entries || {}, key));

  const scriptletsAt = writeIndex('userScriptletRules');
  const markerAt = writeIndex('userFiltersApplied');

  assert.ok(scriptletsAt >= 0 && markerAt >= 0, 'both writes must happen');
  assert.ok(markerAt > scriptletsAt,
    'the marker must be written after the scriptlet store it certifies');
  // `bundlesClearedAt` is the index the next chrome call will occupy, so the
  // marker write landing at that index or later means it came afterwards.
  assert.ok(bundlesClearedAt >= 0 && markerAt >= bundlesClearedAt,
    'the marker must be written after the stale page bundles are cleared');

  hooks.cancelPendingStatsPersistForTest();
});

test('4.15: a failure before the last write leaves the marker unset so startup retries', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  hooks.db.clearPageBundles = async () => { throw new Error('IndexedDB gone'); };

  await assert.rejects(() => hooks.setAndApplyUserFilters('example.com##.ad'));
  assert.equal(chrome.storage.local._data().userFiltersApplied ?? '', '',
    'an interrupted apply must not certify state it never finished writing');

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §4.16 — bound the batch before the write loop; stop on capacity errors
// ---------------------------------------------------------------------------

test('4.16: the compiled rule count is truncated to the dynamic budget', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });
  const budget = hooks.MAX_USER_FILTERS_DNR_RULES;

  hooks.setCompileUserFiltersOverrideForTest(() => syntheticCompiled(budget + 25));
  const counts = await hooks.setAndApplyUserFilters('||whatever^');
  hooks.setCompileUserFiltersOverrideForTest(null);

  assert.equal(counts.network, budget, 'no more than the budget may reach DNR');
  assert.equal(userRules(chrome).length, budget);
  assert.equal(counts.skippedNetwork, 25, 'the drop must be reported, not hidden');
  assert.ok(
    counts.skippedRules.some((s) => /budget/i.test(s.reason)),
    `expected a budget reason, got ${JSON.stringify(counts.skippedRules.slice(0, 3))}`,
  );

  hooks.cancelPendingStatsPersistForTest();
});

test('4.16: rules whose ids reach the allowlist range are refused', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    awaitReady: true,
    seed: { allowlist: ['protected.example'] },
  });

  // Record every id that reaches DNR: the guard is supposed to run BEFORE the
  // write loop, not to rely on Chrome rejecting the collision.
  const offeredIds = [];
  const origUpdate = chrome.declarativeNetRequest.updateDynamicRules.bind(chrome.declarativeNetRequest);
  chrome.declarativeNetRequest.updateDynamicRules = async (args = {}) => {
    for (const rule of args.addRules || []) offeredIds.push(rule.id);
    return origUpdate(args);
  };

  hooks.setCompileUserFiltersOverrideForTest(() => syntheticCompiled(2, {
    extraRules: [
      // Exactly the collision `compile_user_filters` produces past ~90k rules:
      // unreclaimable by the user-filter cleanup, deletable by the allowlist
      // rebuild.
      {
        id: DNR_ALLOWLIST_START,
        priority: 1,
        condition: { urlFilter: '||collide.example^' },
        action: { type: 'block' },
      },
    ],
  }));
  const counts = await hooks.setAndApplyUserFilters('||whatever^');
  hooks.setCompileUserFiltersOverrideForTest(null);
  chrome.declarativeNetRequest.updateDynamicRules = origUpdate;

  assert.equal(counts.network, 2);
  assert.equal(counts.skippedNetwork, 1);
  assert.ok(counts.skippedRules.some((s) => /id range/i.test(s.reason)));
  assert.deepEqual(offeredIds.filter((id) => id >= DNR_ALLOWLIST_START), [],
    'an out-of-range id must be dropped before the write loop, not offered to DNR');

  // The allowlist rule at DNR_ALLOWLIST_START is untouched.
  const atStart = chrome.declarativeNetRequest._dynamic.get(DNR_ALLOWLIST_START);
  assert.equal(atStart.action.type, 'allowAllRequests');
  assert.equal(atStart.condition.urlFilter, '||protected.example^');

  hooks.cancelPendingStatsPersistForTest();
});

test('4.16: a capacity rejection stops the write loop instead of retrying per rule', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const origUpdate = chrome.declarativeNetRequest.updateDynamicRules.bind(chrome.declarativeNetRequest);
  let addCalls = 0;
  chrome.declarativeNetRequest.updateDynamicRules = async (args = {}) => {
    if ((args.addRules || []).length > 0) {
      addCalls++;
      throw new Error('Rule count exceeded. Some rules were not added.');
    }
    return origUpdate(args);
  };

  hooks.setCompileUserFiltersOverrideForTest(() => syntheticCompiled(500));
  const counts = await hooks.setAndApplyUserFilters('||whatever^');
  hooks.setCompileUserFiltersOverrideForTest(null);
  chrome.declarativeNetRequest.updateDynamicRules = origUpdate;

  assert.equal(counts.network, 0);
  assert.equal(addCalls, 1,
    `a quota-shaped rejection must stop the loop (500 rules used to mean 510 calls); saw ${addCalls}`);
  assert.equal(counts.skippedNetwork, 500);
  assert.ok(counts.skippedRules.some((s) => /capacity/i.test(s.reason)));

  hooks.cancelPendingStatsPersistForTest();
});

test('4.16 (didn\'t re-break): a single malformed rule is still isolated by the per-rule retry', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const origUpdate = chrome.declarativeNetRequest.updateDynamicRules.bind(chrome.declarativeNetRequest);
  chrome.declarativeNetRequest.updateDynamicRules = async (args = {}) => {
    if ((args.addRules || []).some((r) => r.id === DNR_USER_RULES_START + 3)) {
      throw new Error('Rule with id 900003 is invalid');
    }
    return origUpdate(args);
  };

  hooks.setCompileUserFiltersOverrideForTest(() => syntheticCompiled(6));
  const counts = await hooks.setAndApplyUserFilters('||whatever^');
  hooks.setCompileUserFiltersOverrideForTest(null);
  chrome.declarativeNetRequest.updateDynamicRules = origUpdate;

  assert.equal(counts.network, 5, 'the five good rules must still apply');
  assert.equal(counts.skippedNetwork, 1);
  assert.equal(userRules(chrome).length, 5);

  hooks.cancelPendingStatsPersistForTest();
});

// §5.1's regression test lived here: FORCE_CLEAN_ALL_DYNAMIC_RULES had to
// clear USER_FILTERS_APPLIED, or the startup short-circuit meant the user's
// filter rules never came back. The handler itself is deleted in this pass
// (§5.33 — no caller in any surface, and unreachable destructive code is how
// that defect survived), so the behaviour it certified no longer exists.
