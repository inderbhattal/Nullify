/**
 * Regression tests for REVIEW-2026-07:
 *  §5.3 — active-index rebuilds had no mutual exclusion, and a page-bundle
 *         persist landing after the rebuild's clearPageBundles() poisoned
 *         that hostname's persisted cache indefinitely (the version check
 *         accepts it because remote-list refreshes don't bump the version).
 *  §5.7 — drifted duplicate tables: dead CONFIG entries, shadow consts, and
 *         applyRulesets' re-declared list-id literal.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { loadServiceWorker } from './sw-loader.mjs';

const SW_PATH = new URL('../../src/background/service-worker.js', import.meta.url);

test('5.3: a bundle computed during a rebuild is never persisted', async () => {
  const { hooks } = await loadServiceWorker({ awaitReady: true });
  const db = hooks.db;

  // Gate the rebuild open at its first IndexedDB read so it stays in flight
  // while the lookup below runs to completion.
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const origGetAllFilterSources = db.getAllFilterSources.bind(db);
  db.getAllFilterSources = async () => {
    await gate;
    return origGetAllFilterSources();
  };

  const rebuildPromise = hooks.queueActiveIndexRebuild();
  assert.equal(hooks.isActiveIndexRebuildInFlight(), true,
    'the in-flight flag must be up from the moment the rebuild is queued');

  // If the (pre-fix) code still tries to persist the bundle, delay that write
  // until the rebuild has fully finished — the exact interleaving where the
  // stale record lands after clearPageBundles() and survives.
  const origPutPageBundle = db.putPageBundle.bind(db);
  db.putPageBundle = async (...args) => {
    releaseGate();
    await rebuildPromise;
    return origPutPageBundle(...args);
  };

  const lookupPromise = hooks.getCosmeticBundleForPage('racehost.example');
  // New code path: the lookup finishes without persisting; then let the
  // rebuild proceed.
  lookupPromise.then(() => releaseGate());

  await rebuildPromise;
  await lookupPromise;

  db.putPageBundle = origPutPageBundle;
  db.getAllFilterSources = origGetAllFilterSources;

  assert.equal(hooks.isActiveIndexRebuildInFlight(), false);
  const persisted = await db.getPageBundle('racehost.example', hooks.getActiveRuleDataVersion());
  assert.equal(persisted, null,
    'no page bundle may be persisted for a lookup that raced a rebuild');

  hooks.cancelPendingStatsPersistForTest();
});

test('5.3: queued rebuilds are serialized through one chain', async () => {
  const { hooks } = await loadServiceWorker({ awaitReady: true });
  const db = hooks.db;

  let active = 0;
  let maxActive = 0;
  const origClearActiveRules = db.clearActiveRules.bind(db);
  db.clearActiveRules = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    // Yield so an unserialized second rebuild would overlap here.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await origClearActiveRules();
    active--;
    return result;
  };

  await Promise.all([hooks.queueActiveIndexRebuild(), hooks.queueActiveIndexRebuild()]);
  db.clearActiveRules = origClearActiveRules;

  assert.equal(maxActive, 1, 'rebuilds must never overlap');
  assert.equal(hooks.isActiveIndexRebuildInFlight(), false);

  hooks.cancelPendingStatsPersistForTest();
});

test('5.7: duplicate tables are gone — one source of truth per tunable', async () => {
  const source = await readFile(SW_PATH, 'utf8');

  // Dead CONFIG entries removed.
  assert.ok(!source.includes('PROCEDURAL_DEBOUNCE_MS'),
    'CONFIG.PROCEDURAL_DEBOUNCE_MS had no consumer and must be removed');
  assert.ok(!source.includes('CACHE_SWEEP_INTERVAL_MS'),
    'CONFIG.CACHE_SWEEP_INTERVAL_MS had no consumer and must be removed');

  // Shadow consts removed — the live values are the CONFIG entries.
  assert.ok(!/const\s+DOMAIN_RULES_CACHE_MAX\s*=/.test(source),
    'DOMAIN_RULES_CACHE_MAX must live only in CONFIG');
  assert.ok(!/const\s+PAGE_BUNDLE_DB_MAX\s*=/.test(source),
    'PAGE_BUNDLE_DB_MAX must live only in CONFIG');

  // applyRulesets derives from ALL_KNOWN_LIST_IDS instead of re-declaring
  // the list literal.
  assert.ok(!source.includes('allKnownListIds'),
    'applyRulesets must not re-declare the known list ids');
  assert.ok(source.includes('for (const listId of ALL_KNOWN_LIST_IDS)'),
    'applyRulesets must iterate ALL_KNOWN_LIST_IDS');
});

test('5.7: applyRulesets enables every list in ALL_KNOWN_LIST_IDS by default', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const effective = await hooks.applyRulesets();
  for (const listId of hooks.ALL_KNOWN_LIST_IDS) {
    assert.notEqual(effective[listId], undefined, `missing list ${listId}`);
    assert.equal(effective[listId], true, `list ${listId} should be enabled by default`);
  }
  // The DNR stub actually saw the enable calls for the grouped shards.
  assert.ok(chrome.declarativeNetRequest._staticEnabled.has('easylist_2'));

  hooks.cancelPendingStatsPersistForTest();
});
