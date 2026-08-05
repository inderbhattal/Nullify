/**
 * Regression tests for REVIEW-2026-07:
 *  §5.1 — performEarlyInjection consulted the allowlist before critical
 *         caches restored, injecting CSS into allowlisted pages on cold start.
 *  §5.2 — restorePersistedStats cleared tabStats and clobbered tabs already
 *         being tracked in memory with the previous session's counts.
 *  §5.6 — webNavigation listeners leaked unhandled rejections and never
 *         reached the error report.
 *  §5.9 — the 1.5s stats-persist debounce lost in-flight counts on SW kill;
 *         they are now mirrored to chrome.storage.session immediately.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { loadServiceWorker, waitFor } from './sw-loader.mjs';

test('5.1: early injection on a cold start waits for the allowlist before injecting', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: {
      allowlist: ['allowed.com'],
      genericCss: '#ad { display: none !important; }',
    },
  });

  // Call IMMEDIATELY — critical startup (which loads the allowlist into
  // memory) is still in flight, exactly like the navigation that wakes a
  // cold service worker.
  await hooks.performEarlyInjection(7, 0, 'https://allowed.com/watch');

  const injects = chrome.calls.entries.filter((c) => c.api === 'scripting.insertCSS');
  assert.equal(injects.length, 0,
    'cosmetic CSS must not be injected into an allowlisted page on cold start');

  // Positive control: a non-allowlisted host does get the generic CSS.
  await hooks.performEarlyInjection(8, 0, 'https://notallowed.com/page');
  const injectsAfter = chrome.calls.entries.filter((c) => c.api === 'scripting.insertCSS');
  assert.equal(injectsAfter.length, 1, 'non-allowlisted pages still get CSS');

  await hooks.whenBackgroundSetupDone();
  hooks.cancelPendingStatsPersistForTest();
});

test('5.2: restorePersistedStats does not clobber tabIds already tracked in memory', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  // The navigation that woke this SW already reset tab 5 and counted blocks.
  hooks.resetTabStats(5, 'https://current-page.example');
  hooks.tabStats.get(5).blocked = 7;

  // The previous session persisted stale counts for tab 5 plus tab 6.
  await chrome.storage.local.set({
    tabStats: {
      5: { blocked: 99, trackers: 12, url: 'https://previous-page.example' },
      6: { blocked: 3, trackers: 1, url: 'https://other.example' },
    },
  });

  await hooks.restorePersistedStats();

  assert.equal(hooks.tabStats.get(5).blocked, 7,
    'in-memory counts for an already-tracked tab must survive the restore');
  assert.equal(hooks.tabStats.get(5).url, 'https://current-page.example');
  assert.equal(hooks.tabStats.get(6).blocked, 3,
    'tabs only present in storage are still restored');

  hooks.cancelPendingStatsPersistForTest();
});

test('5.9: in-flight counters survive an SW kill via chrome.storage.session', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const res = await chrome.runtime.sendMessage(
    { type: 'CONTENT_BLOCKED', payload: { count: 4, hostname: 'x.example' } },
    { tab: { id: 3, url: 'https://x.example/' } }
  );
  assert.equal(res.ok, true);

  // The session mirror is written immediately (no debounce) — give its async
  // storage write a few ticks.
  await waitFor(() => chrome.storage.session._data()['nullify:inFlightStats']);
  const mirrored = chrome.storage.session._data()['nullify:inFlightStats'];
  assert.equal(mirrored.tabStats[3].blocked, 4);
  assert.equal(mirrored.totalBlockedToday, 4);

  // Kill the SW before the 1.5s debounced local write fires: memory gone,
  // storage.local never written, storage.session intact.
  hooks.cancelPendingStatsPersistForTest();
  hooks.clearInMemoryStatsForTest();
  assert.equal(chrome.storage.local._data().tabStats?.[3], undefined,
    'precondition: local storage must not have the counts yet');

  await hooks.restorePersistedStats();

  assert.equal(hooks.tabStats.get(3)?.blocked, 4,
    'counts must be restored from the session mirror');
  assert.equal(hooks.getTotals().totalBlockedToday, 4);

  hooks.cancelPendingStatsPersistForTest();
});

test('5.6: webNavigation listener failures land in the error report, not as unhandled rejections', async () => {
  const { chrome, idb, hooks } = await loadServiceWorker({ awaitReady: true });

  // Persistently broken IndexedDB — every page-bundle lookup now rejects.
  idb._setFailure(new Error('IndexedDB is toast'));

  chrome.webNavigation.onBeforeNavigate._fire({
    url: 'https://fresh-host.example/',
    frameId: 0,
    tabId: 9,
  });
  chrome.webNavigation.onCommitted._fire({
    url: 'https://fresh-host.example/',
    frameId: 0,
    tabId: 9,
  });

  const reported = await waitFor(() =>
    hooks.errorReport.warnings.some((w) => w.context === 'webNavigation'));
  assert.ok(reported, 'listener failure must be routed to reportError("webNavigation", …)');

  // And it is visible through the diagnostics message.
  const report = await chrome.runtime.sendMessage({ type: 'GET_ERROR_REPORT' });
  assert.ok(report.warnings.some((w) => w.context === 'webNavigation'));

  idb._setFailure(null);
  hooks.cancelPendingStatsPersistForTest();
});
