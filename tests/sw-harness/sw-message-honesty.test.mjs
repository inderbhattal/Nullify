/**
 * Regression tests for REVIEW-2026-08:
 *  §5.2 — CONTENT_BLOCKED put no upper bound on `count`. `Number.isFinite(1e308)`
 *         passes, so one message from a compromised renderer could drive
 *         totalBlockedToday to a nonsense value that was then persisted to
 *         storage and to the session mirror.
 *  §5.3 — CHECK_FILTER_UPDATES answered `{ok:true}` even when every fetch
 *         failed, so "Update All" while offline was a silent no-op and the
 *         options page rendered a `lastUpdateCheck` the SW never wrote.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { loadServiceWorker } from './sw-loader.mjs';

const CONTENT_SENDER = {
  tab: { id: 11, url: 'https://hostile.example/' },
  frameId: 0,
  url: 'https://hostile.example/',
};

test('5.2: a hostile CONTENT_BLOCKED count cannot inflate the daily total', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const res = await chrome.runtime.sendMessage(
    { type: 'CONTENT_BLOCKED', payload: { action: 'hide', count: 1e308 } },
    CONTENT_SENDER,
  );
  assert.equal(res.ok, true);

  const total = hooks.getTotals().totalBlockedToday;
  assert.ok(total > 0 && total <= 1000,
    `count must be clamped to a plausible batch, got ${total}`);
  assert.equal(hooks.tabStats.get(11).blocked, total);

  // …and the clamped value is what reaches storage and the session mirror.
  await hooks.persistTabStats();
  assert.equal(chrome.storage.local._data().totalBlockedToday, total);
  assert.equal(
    chrome.storage.session._data()['nullify:inFlightStats'].totalBlockedToday,
    total,
  );

  hooks.cancelPendingStatsPersistForTest();
});

test('5.2 (didn\'t re-break): an ordinary batch count is still counted in full', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  await chrome.runtime.sendMessage(
    { type: 'CONTENT_BLOCKED', payload: { action: 'hide', count: 17 } },
    CONTENT_SENDER,
  );
  assert.equal(hooks.getTotals().totalBlockedToday, 17);

  // A fractional count is floored, not rejected.
  await chrome.runtime.sendMessage(
    { type: 'CONTENT_BLOCKED', payload: { action: 'hide', count: 2.9 } },
    CONTENT_SENDER,
  );
  assert.equal(hooks.getTotals().totalBlockedToday, 19);

  hooks.cancelPendingStatsPersistForTest();
});

test('5.3: CHECK_FILTER_UPDATES reports failure when every fetch fails', async () => {
  // The harness is permanently offline, which is exactly the scenario.
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });
  const before = chrome.storage.local._data().lastUpdateCheck;

  const res = await chrome.runtime.sendMessage({ type: 'CHECK_FILTER_UPDATES' });

  assert.equal(res.ok, false, '"Update All" while offline must not report success');
  assert.ok(res.error, 'the options page needs something to show');
  assert.deepEqual(res.updatedLists, []);
  assert.equal(chrome.storage.local._data().lastUpdateCheck, before,
    'a check that did nothing must not move the "last checked" timestamp');

  hooks.cancelPendingStatsPersistForTest();
});

test('5.3: a check that is already running says so instead of claiming success', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const [first, second] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'CHECK_FILTER_UPDATES' }),
    chrome.runtime.sendMessage({ type: 'CHECK_FILTER_UPDATES' }),
  ]);

  for (const res of [first, second]) {
    assert.equal(res.ok, false);
    assert.ok(res.error);
  }
  assert.ok(second.inProgress || first.inProgress,
    'the coalesced call must be distinguishable from a real failure');

  hooks.cancelPendingStatsPersistForTest();
});

test('5.3: a successful check names the lists it refreshed', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  // Serve one list; the rest keep failing, which is the partial-success case.
  globalThis.fetch = async (url) => {
    if (String(url).includes('easylist.txt') || String(url).includes('easylist')) {
      return { ok: true, status: 200, text: async () => 'example.com##.ad\n' };
    }
    throw new Error('offline');
  };

  const res = await hooks.checkFilterListUpdates();
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.updatedLists) && res.updatedLists.length > 0,
    'the UI needs the list ids to name what changed');
  assert.equal(typeof chrome.storage.local._data().lastUpdateCheck, 'number',
    'a real update must record the timestamp the options page reads back');

  hooks.cancelPendingStatsPersistForTest();
});
