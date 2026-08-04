/**
 * Regression tests for REVIEW-2026-08:
 *  §3.2 — an interrupted active-index rebuild was undetectable. `clearActiveRules()`
 *         empties the cosmetic, scriptlet and page-bundle stores; the OLD bloom
 *         filter, the OLD RULE_DATA_VERSION and the (untouched) filter-sources
 *         store all survive, so the next startup saw a healthy index and never
 *         rebuilt. Network blocking kept working, which is what made 24h of dead
 *         cosmetic filtering invisible.
 *  §5.4 — the rebuild guard on page-bundle persistence was a live in-flight
 *         check, so a lookup that started before a rebuild and resolved after it
 *         still wrote a bundle computed against pre-clear state; and the depth
 *         counter was only decremented in `.finally()`, so a rebuild that never
 *         settled disabled persistence and blocked every later rebuild forever.
 *
 * §7.3 — the harness capability both need: boot a second worker on the same
 * IndexedDB + storage after abandoning the first one mid-rebuild.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { loadServiceWorker, samplePackagedSources, waitFor, drainTicks } from './sw-loader.mjs';

async function bootWithIndex(extra = {}) {
  return await loadServiceWorker({
    awaitReady: true,
    packagedSources: samplePackagedSources(),
    ...extra,
  });
}

test('3.2: a rebuild abandoned after clearActiveRules is repaired on the next boot', async () => {
  const first = await bootWithIndex();
  first.hooks.cancelPendingStatsPersistForTest();

  // Baseline: the index really is populated.
  assert.deepEqual(await first.hooks.db.getCosmeticRules('example.com'), ['.site-ad']);
  assert.ok(
    (await first.hooks.db.getScriptletRules('example.com')).some((r) => r.name === 'noeval'),
    'the packaged list scriptlet must be indexed',
  );
  assert.equal(!!first.chrome.storage.local._data().bloomFilter, true);
  assert.equal(await first.hooks.isRuleIndexInterrupted(), false,
    'a completed rebuild must leave no marker behind');

  // Kill the worker mid-rebuild: hang the first repopulating write, exactly
  // where MV3 termination or a browser quit lands. The promise never settles,
  // so this instance is abandoned rather than unwound.
  let reachedRepopulate = false;
  first.hooks.db.putBulkCosmeticRules = () => {
    reachedRepopulate = true;
    return new Promise(() => { });
  };
  first.hooks.queueActiveIndexRebuild().catch(() => { });
  await waitFor(() => reachedRepopulate);

  // The stores are empty and the OLD bloom + version are still in storage —
  // the exact state that used to look healthy.
  assert.deepEqual(await first.hooks.db.getCosmeticRules('example.com'), []);
  assert.equal(!!first.chrome.storage.local._data().bloomFilter, true);
  assert.equal(await first.hooks.isRuleIndexInterrupted(), true,
    'the dirty marker must be written BEFORE the destructive clear');

  // A fresh worker on the same disk.
  const second = await loadServiceWorker({
    stub: first.chrome,
    idb: first.idb,
    awaitReady: true,
    packagedSources: samplePackagedSources(),
  });
  second.hooks.cancelPendingStatsPersistForTest();

  assert.deepEqual(await second.hooks.db.getCosmeticRules('example.com'), ['.site-ad'],
    'the next startup must detect the interrupted rebuild and repair the index');
  assert.ok(
    (await second.hooks.db.getScriptletRules('example.com')).some((r) => r.name === 'noeval'),
    'scriptlets must come back too, not just cosmetics',
  );
  assert.equal(await second.hooks.isRuleIndexInterrupted(), false,
    'the repair must clear the marker');
  assert.ok(
    second.hooks.errorReport.critical
      .concat(second.hooks.errorReport.warnings)
      .some((e) => String(e.context).includes('interruptedRebuild')),
    'a silently dead index must reach GET_ERROR_REPORT, not just the console',
  );
});

test('3.2: a rebuild that rejects mid-write leaves the marker set for the next boot', async () => {
  const first = await bootWithIndex();
  first.hooks.cancelPendingStatsPersistForTest();

  // The other named failure path: a putBulk* rejection (quota), not a kill.
  first.hooks.db.putBulkScriptletRules = async () => {
    throw new Error('QuotaExceededError');
  };
  await first.hooks.queueActiveIndexRebuild().catch(() => { });

  assert.equal(await first.hooks.isRuleIndexInterrupted(), true);

  const second = await loadServiceWorker({
    stub: first.chrome,
    idb: first.idb,
    awaitReady: true,
    packagedSources: samplePackagedSources(),
  });
  second.hooks.cancelPendingStatsPersistForTest();

  assert.deepEqual(await second.hooks.db.getCosmeticRules('example.com'), ['.site-ad']);
  assert.equal(await second.hooks.isRuleIndexInterrupted(), false);
});

test('3.2 (didn\'t re-break): a clean boot on a healthy index does not rebuild', async () => {
  const first = await bootWithIndex();
  first.hooks.cancelPendingStatsPersistForTest();

  let rebuilds = 0;
  const second = await loadServiceWorker({
    stub: first.chrome,
    idb: first.idb,
    packagedSources: samplePackagedSources(),
  });
  const origClear = second.hooks.db.clearActiveRules.bind(second.hooks.db);
  second.hooks.db.clearActiveRules = async () => { rebuilds++; return origClear(); };
  await second.hooks.whenCriticalReady();
  await second.hooks.whenBackgroundSetupDone();
  second.hooks.cancelPendingStatsPersistForTest();

  assert.equal(rebuilds, 0,
    'no marker and an unchanged rule-data version means the index is trusted as-is');
  assert.deepEqual(await second.hooks.db.getCosmeticRules('example.com'), ['.site-ad']);
});

// ---------------------------------------------------------------------------
// §5.4 — generation compare + stall release
// ---------------------------------------------------------------------------

test('5.4: a lookup that starts before a rebuild and ends after it is never persisted', async () => {
  // A populated index is required: the ancestor walk only touches the store
  // for a hostname the bloom filter answers for.
  const { hooks } = await bootWithIndex();
  const db = hooks.db;

  // Gate the lookup's store read so the whole rebuild can run to completion
  // inside it. On resolution `isActiveIndexRebuildInFlight()` is false again —
  // the live check the old code relied on sees nothing wrong.
  let releaseLookup;
  const lookupGate = new Promise((resolve) => { releaseLookup = resolve; });
  const origGetCosmeticRules = db.getCosmeticRules.bind(db);
  let gatedReads = 0;
  db.getCosmeticRules = async (host) => {
    gatedReads++;
    await lookupGate;
    return origGetCosmeticRules(host);
  };

  const lookup = hooks.getCosmeticBundleForPage('example.com');
  await drainTicks(3);
  assert.ok(gatedReads > 0, 'the lookup must actually be parked inside the store read');

  await hooks.queueActiveIndexRebuild();
  assert.equal(hooks.isActiveIndexRebuildInFlight(), false,
    'the rebuild has fully finished — only a generation compare can catch this');

  releaseLookup();
  await lookup;
  db.getCosmeticRules = origGetCosmeticRules;

  const persisted = await db.getPageBundle('example.com', hooks.getActiveRuleDataVersion());
  assert.equal(persisted, null,
    'a bundle computed against pre-clear state must not be written to IndexedDB');

  // …nor into the memory cache the rebuild just cleared. A memory-cache hit
  // returns before `getPageBundle` is consulted, so that call is the probe.
  let consultedStore = false;
  const origGetPageBundle = db.getPageBundle.bind(db);
  db.getPageBundle = async (...args) => { consultedStore = true; return origGetPageBundle(...args); };
  await hooks.getCosmeticBundleForPage('example.com');
  db.getPageBundle = origGetPageBundle;
  assert.equal(consultedStore, true, 'setCachedDomainRules must be gated on the same signal');

  hooks.cancelPendingStatsPersistForTest();
});

test('5.4 (didn\'t re-break): an uncontended lookup is still persisted and cached', async () => {
  const { hooks } = await loadServiceWorker({ awaitReady: true });

  await hooks.getCosmeticBundleForPage('quiet.example');
  const persisted = await hooks.db.getPageBundle('quiet.example', hooks.getActiveRuleDataVersion());
  assert.notEqual(persisted, null, 'the normal path must still populate the persisted cache');

  let consultedStore = false;
  const origGetPageBundle = hooks.db.getPageBundle.bind(hooks.db);
  hooks.db.getPageBundle = async (...args) => { consultedStore = true; return origGetPageBundle(...args); };
  await hooks.getCosmeticBundleForPage('quiet.example');
  hooks.db.getPageBundle = origGetPageBundle;
  assert.equal(consultedStore, false, 'the memory cache must still serve the second lookup');

  hooks.cancelPendingStatsPersistForTest();
});

test('5.4: a rebuild that never settles is released instead of pinning the counter', async () => {
  const { hooks } = await loadServiceWorker({ awaitReady: true });
  hooks.CONFIG.ACTIVE_INDEX_REBUILD_STALL_MS = 25;

  hooks.db.clearActiveRules = () => new Promise(() => { });
  hooks.queueActiveIndexRebuild().catch(() => { });
  await waitFor(() => hooks.isActiveIndexRebuildInFlight());

  assert.equal(
    await waitFor(() => !hooks.isActiveIndexRebuildInFlight(), { ticks: 400 }),
    true,
    'a hung rebuild must not disable page-bundle persistence forever',
  );
  assert.ok(
    hooks.errorReport.critical.concat(hooks.errorReport.warnings)
      .some((e) => String(e.context).includes('stalled')),
    'the stall must be reported, not swallowed',
  );

  // And the queue is usable again.
  hooks.CONFIG.ACTIVE_INDEX_REBUILD_STALL_MS = 120_000;
  hooks.db.clearActiveRules = async () => { };
  const next = hooks.queueActiveIndexRebuild();
  assert.equal(
    await Promise.race([next.then(() => 'settled', () => 'settled'), drainTicks(60).then(() => 'stuck')]),
    'settled',
    'the serialization chain must not stay blocked behind the stuck rebuild',
  );

  hooks.cancelPendingStatsPersistForTest();
});
