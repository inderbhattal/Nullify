/**
 * Regression tests for REVIEW-2026-08 — the cold-worker suite (§7.2).
 *
 * Every pre-existing harness test awaited `whenCriticalReady()` before doing
 * anything, so nothing ever exercised the state an MV3 worker actually starts
 * in: listeners registered and firing, memory caches still empty. Two P0s
 * lived in exactly that window.
 *
 *  §3.1 — ALLOW_SITE / DISALLOW_SITE composed the new allowlist from
 *         `cachedAllowlist`, which is populated in stage 2 of
 *         `_criticalPromise`. The first message to a woken worker therefore
 *         wrote a one-entry list over the user's entire stored allowlist, and
 *         the options page rendered that as a successful add.
 *  §4.14 — `tabs.onRemoved` (one of the events that wakes a dead worker)
 *         called `persistTabStats()` unconditionally, overwriting the stored
 *         counters *and* the session mirror with a snapshot of empty memory.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { loadServiceWorker, drainTicks, trackSettled, waitFor } from './sw-loader.mjs';

const SEEDED = ['bank.example', 'mail.example', 'work.example'];

// ---------------------------------------------------------------------------
// §3.1 — allowlist writers must compose from storage, not from memory
// ---------------------------------------------------------------------------

test('3.1: allowSite on a cold worker adds to the STORED allowlist, not to an empty cache', async () => {
  const { chrome, hooks, releaseCold } = await loadServiceWorker({
    cold: true,
    seed: { allowlist: [...SEEDED] },
  });

  // Provable precondition: critical startup is still blocked, so
  // refreshMemoryCache() has not run and `cachedAllowlist` is empty. This is
  // the state a worker woken by a popup click is in.
  const ready = trackSettled(hooks.whenCriticalReady());
  await drainTicks(5);
  assert.equal(ready.settled, false, 'the worker must still be cold for this test to mean anything');

  const result = await hooks.allowSite('news.example');

  assert.deepEqual(result, [...SEEDED, 'news.example'],
    'the response must be the full allowlist, not just the added domain');
  assert.deepEqual(chrome.storage.local._data().allowlist, [...SEEDED, 'news.example'],
    'a cold add must never delete the other stored entries');

  const allowRules = [...chrome.declarativeNetRequest._dynamic.values()]
    .filter((r) => r.id >= hooks.DNR_ALLOWLIST_START)
    .map((r) => r.condition.urlFilter);
  assert.deepEqual(allowRules.sort(), ['||bank.example^', '||mail.example^', '||news.example^', '||work.example^']);

  releaseCold();
  await hooks.whenCriticalReady();
  await hooks.whenBackgroundSetupDone();
  assert.deepEqual(chrome.storage.local._data().allowlist, [...SEEDED, 'news.example'],
    'startup reconciliation must not undo the cold add either');
  hooks.cancelPendingStatsPersistForTest();
});

test('3.1: disallowSite on a cold worker removes from storage instead of reporting a no-op', async () => {
  const { chrome, hooks, releaseCold } = await loadServiceWorker({
    cold: true,
    seed: { allowlist: [...SEEDED] },
  });

  const result = await hooks.disallowSite('mail.example');

  assert.deepEqual(result, ['bank.example', 'work.example'],
    'the removal must actually happen — the old code returned {ok:true} with an empty list');
  assert.deepEqual(chrome.storage.local._data().allowlist, ['bank.example', 'work.example']);

  releaseCold();
  await hooks.whenCriticalReady();
  await hooks.whenBackgroundSetupDone();
  hooks.cancelPendingStatsPersistForTest();
});

test('3.1: ALLOW_SITE delivered to a cold worker waits for the readiness gate', async () => {
  const { chrome, hooks, releaseCold } = await loadServiceWorker({
    cold: true,
    seed: { allowlist: [...SEEDED] },
  });

  // First message to a freshly-woken SW, exactly as the options page sends it.
  const pending = chrome.runtime.sendMessage(
    { type: 'ALLOW_SITE', payload: { domain: 'news.example' } },
    { url: 'chrome-extension://nullify-test-id/src/options/options.html' },
  );
  const state = trackSettled(pending);
  await drainTicks(10);

  assert.equal(state.settled, false,
    'allowlist writers belong in the needsCache gate — answering before stage 2 is what §3.1 exploited');

  releaseCold();
  const res = await pending;

  assert.equal(res.ok, true);
  assert.deepEqual(res.allowlist, [...SEEDED, 'news.example']);
  assert.deepEqual(chrome.storage.local._data().allowlist, [...SEEDED, 'news.example']);

  await hooks.whenBackgroundSetupDone();
  hooks.cancelPendingStatsPersistForTest();
});

test('3.1 (didn\'t re-break): a warm ALLOW_SITE still adds exactly one entry', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    awaitReady: true,
    seed: { allowlist: ['existing.example'] },
  });

  const res = await chrome.runtime.sendMessage({ type: 'ALLOW_SITE', payload: { domain: 'new.example' } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.allowlist, ['existing.example', 'new.example']);

  // Re-adding is idempotent and does not duplicate the DNR rule.
  const again = await chrome.runtime.sendMessage({ type: 'ALLOW_SITE', payload: { domain: 'new.example' } });
  assert.deepEqual(again.allowlist, ['existing.example', 'new.example']);
  assert.equal(
    [...chrome.declarativeNetRequest._dynamic.values()].filter((r) => r.id >= hooks.DNR_ALLOWLIST_START).length,
    2,
  );

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §4.14 — no stats write may land before the restore
// ---------------------------------------------------------------------------

// The worker's day stamp is LOCAL (`getCurrentDayStamp` uses getFullYear/
// getMonth/getDate), because a user's "blocked today" should follow their own
// day. This was `new Date().toISOString().slice(0, 10)`, which is UTC — so for
// whatever part of the day a developer's local date differs from UTC, the seed
// looked like yesterday's, the restore discarded it as stale, and the totals
// came back 0 instead of 500. It passed here and in CI because both run UTC.
function localDayStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const TODAY = localDayStamp();

function statsSeed() {
  return {
    tabStats: { 7: { blocked: 42, trackers: 3, url: 'https://a.example/' } },
    totalBlockedToday: 500,
    totalBlockedDate: TODAY,
  };
}

test('4.14: closing a tab on a woken worker cannot zero the stored stats', async () => {
  const chromeStub = (await import('./chrome-stub.mjs')).makeChromeStub();
  await chromeStub.storage.local.set({ settings: { enabled: true, showBadge: true }, ...statsSeed() });

  // Hold every storage READ open: the restore is now provably outstanding
  // while listeners fire, which is the state a woken worker is in.
  const releaseReads = chromeStub.storage.local._holdReads();
  const { chrome, hooks, releaseCold } = await loadServiceWorker({ stub: chromeStub, cold: true });

  // chrome.tabs.onRemoved wakes a terminated worker; the handler used to
  // persist a snapshot of empty memory straight over the stored counters.
  chrome.tabs.onRemoved._fire(99);
  await drainTicks(5);

  releaseReads();
  releaseCold();
  await hooks.whenCriticalReady();
  await hooks.whenBackgroundSetupDone();
  await waitFor(() => hooks.tabStats.has(7));

  assert.equal(chrome.storage.local._data().totalBlockedToday, 500,
    'the day total must survive a tab close on a cold worker');
  assert.deepEqual(chrome.storage.local._data().tabStats[7],
    { blocked: 42, trackers: 3, url: 'https://a.example/' });
  assert.equal(hooks.getTotals().totalBlockedToday, 500);

  const mirror = chrome.storage.session._data()['nullify:inFlightStats'];
  assert.equal(mirror?.totalBlockedToday, 500,
    'the session mirror is the copy the restore prefers — it must not be zeroed either');

  hooks.cancelPendingStatsPersistForTest();
});

test('4.14: a direct persist before the restore waits for it instead of writing zeros', async () => {
  const chromeStub = (await import('./chrome-stub.mjs')).makeChromeStub();
  await chromeStub.storage.local.set({ settings: { enabled: true, showBadge: true }, ...statsSeed() });

  const releaseReads = chromeStub.storage.local._holdReads();
  const { chrome, hooks, releaseCold } = await loadServiceWorker({ stub: chromeStub, cold: true });

  hooks.clearInMemoryStatsForTest();
  const persist = hooks.persistTabStats();
  const state = trackSettled(persist);
  await drainTicks(5);
  assert.equal(state.settled, false, 'persistTabStats must block on the restore, not race it');

  releaseReads();
  await persist;

  assert.equal(chrome.storage.local._data().totalBlockedToday, 500);
  assert.deepEqual(chrome.storage.local._data().tabStats[7],
    { blocked: 42, trackers: 3, url: 'https://a.example/' });

  releaseCold();
  await hooks.whenCriticalReady();
  await hooks.whenBackgroundSetupDone();
  hooks.cancelPendingStatsPersistForTest();
});

test('4.14 (didn\'t re-break): a warm persist still writes current memory', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  hooks.resetTabStats(3, 'https://b.example/');
  hooks.tabStats.get(3).blocked = 9;
  await hooks.persistTabStats();

  assert.equal(chrome.storage.local._data().tabStats[3].blocked, 9);
  assert.equal(chrome.storage.session._data()['nullify:inFlightStats'].tabStats[3].blocked, 9);

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// The seed above is only meaningful if it matches the stamp the worker
// compares against. When it did not, two §4.14 tests failed purely on the
// runner's timezone -- and never in CI, which is UTC. Assert the agreement
// rather than trusting two copies of the same arithmetic to stay in step.
// ---------------------------------------------------------------------------

test('the test day stamp matches the worker day stamp exactly', async () => {
  const { hooks } = await loadServiceWorker({ seed: { settings: { enabled: true } } });

  assert.equal(localDayStamp(), hooks.getCurrentDayStamp(),
    'seed stamp and worker stamp must agree, or every dated-stats test is timezone-dependent');

  // Pin the shape too: local, not UTC. A date whose local and UTC days differ
  // is exactly the case that broke, so build one deliberately.
  const probe = new Date(2026, 0, 1, 0, 30); // 00:30 local on 1 Jan
  assert.equal(hooks.getCurrentDayStamp(probe), '2026-01-01',
    'the worker stamp must follow the local calendar day');
});
