/**
 * Regression tests for REVIEW-2026-07 §4.5: the filter-update alarm was
 * cleared and re-created on every service-worker start, so with the
 * 30-minute stats alarm guaranteeing regular wakes it could never fire.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { makeChromeStub } from './chrome-stub.mjs';
import { loadServiceWorker, samplePackagedSources } from './sw-loader.mjs';

const ALARM_FILTER_UPDATE = 'filter-list-update';
const ALARM_STATS_CLEANUP = 'stats-cleanup';

test('4.5: existing alarms are NOT rescheduled on SW start', async () => {
  const stub = makeChromeStub();
  // Simulate a previous SW life having armed both alarms.
  stub.alarms._alarms.set(ALARM_FILTER_UPDATE, {
    name: ALARM_FILTER_UPDATE,
    delayInMinutes: 1440,
    periodInMinutes: 1440,
  });
  stub.alarms._alarms.set(ALARM_STATS_CLEANUP, {
    name: ALARM_STATS_CLEANUP,
    delayInMinutes: 30,
    periodInMinutes: 30,
  });

  const { chrome, hooks } = await loadServiceWorker({ stub, awaitReady: true });

  const createCalls = chrome.calls.entries.filter((c) => c.api === 'alarms.create');
  assert.deepEqual(
    createCalls.map((c) => c.name),
    [],
    'startup must not clear+recreate alarms that already exist'
  );
  // Both alarms are still armed.
  assert.ok(await chrome.alarms.get(ALARM_FILTER_UPDATE));
  assert.ok(await chrome.alarms.get(ALARM_STATS_CLEANUP));

  hooks.cancelPendingStatsPersistForTest();
});

test('4.5: missing filter alarm is created with delay derived from last check', async () => {
  const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
  const { chrome, hooks } = await loadServiceWorker({
    seed: { lastUpdateCheck: twelveHoursAgo },
    awaitReady: true,
  });

  const createCalls = chrome.calls.entries.filter(
    (c) => c.api === 'alarms.create' && c.name === ALARM_FILTER_UPDATE
  );
  assert.equal(createCalls.length, 1);
  const { delayInMinutes, periodInMinutes } = createCalls[0].opts;
  assert.equal(periodInMinutes, 1440);
  // 24h interval minus ~12h elapsed → ~720 minutes remaining.
  assert.ok(delayInMinutes > 700 && delayInMinutes <= 740,
    `expected catch-up delay ≈720, got ${delayInMinutes}`);

  // Stats alarm created too when missing.
  assert.ok(await chrome.alarms.get(ALARM_STATS_CLEANUP));

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// REMEDIATION-2026-09 §7.9(a) — the alarm listener did no readiness gating at
// all, while the message dispatcher has waited on `_criticalPromise` since
// REVIEW-2026-09 §3.1. An alarm is one of the events that WAKES a terminated
// worker, so the due filter refresh and the boot's own rule-data pass could
// run at once: `mergePackagedSourcesOnUpdate` (stage 1) writes the packaged
// snapshot over every stored list while `fetchAndStoreRemoteFilterSources`
// is writing freshly downloaded ones. Both orders were traced and neither
// loses data — the loser is simply overwritten — but one refresh cycle is
// skipped, and on the update boot that is the cycle that exists to replace
// the snapshot the update just rolled back.
// ---------------------------------------------------------------------------

/** Fetches the worker made, split into remote list downloads and everything else. */
function watchFetches() {
  const seen = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (...args) => {
    seen.push(String(args[0]));
    return inner(...args);
  };
  return {
    get remoteLists() { return seen.filter((url) => url.startsWith('https://')); },
    restore() { globalThis.fetch = inner; },
  };
}

test('7.9: a filter-refresh alarm waits for the critical startup', async () => {
  // `cold` holds startup at stage 0, which is the state an alarm-woken worker
  // is actually in when the alarm is delivered.
  const { chrome, hooks, releaseCold } = await loadServiceWorker({ cold: true });
  const fetches = watchFetches();
  try {
    const alarmDone = chrome.alarms.onAlarm._fireAsync({ name: ALARM_FILTER_UPDATE });
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

    assert.deepEqual(fetches.remoteLists, [],
      'the refresh must not start against a worker whose rule data has not been merged yet');

    releaseCold();
    await hooks.whenCriticalReady();
    await alarmDone;

    assert.ok(fetches.remoteLists.length > 0,
      'and it must still run once the worker is ready — a gated alarm is not a dropped alarm');
  } finally {
    fetches.restore();
  }
  hooks.cancelPendingStatsPersistForTest();
});

test('7.9: the boot\'s packaged merge is never interleaved with an alarm refresh', async () => {
  const { chrome, hooks, releaseCold, idb } = await loadServiceWorker({
    cold: true, packagedSources: samplePackagedSources(),
  });

  // One ordered log of both writers: stage 1's destructive snapshot write and
  // the alarm's downloads. The finding is precisely that these interleave.
  const order = [];
  const db = hooks.db;
  const origPutBulk = db.putBulkFilterSources.bind(db);
  db.putBulkFilterSources = async (sources) => {
    order.push('merge');
    return origPutBulk(sources);
  };
  const inner = globalThis.fetch;
  globalThis.fetch = (...args) => {
    if (String(args[0]).startsWith('https://')) order.push('refresh');
    return inner(...args);
  };

  try {
    const alarmDone = chrome.alarms.onAlarm._fireAsync({ name: ALARM_FILTER_UPDATE });
    releaseCold();
    await hooks.whenCriticalReady();
    await hooks.whenBackgroundSetupDone();
    await alarmDone;

    assert.ok(order.includes('merge'), 'precondition: the boot wrote the packaged snapshot');
    assert.ok(order.includes('refresh'), 'precondition: the alarm ran its refresh');
    const lastMerge = order.lastIndexOf('merge');
    const firstRefresh = order.indexOf('refresh');
    assert.ok(lastMerge < firstRefresh,
      `every packaged write must land before the first download, got ${JSON.stringify(order)}`);
  } finally {
    globalThis.fetch = inner;
    db.putBulkFilterSources = origPutBulk;
  }
  assert.ok(idb, 'the idb stub is returned for two-life reuse');
  hooks.cancelPendingStatsPersistForTest();
});

test('7.9 (didn\'t re-break): a ready worker still runs both alarms, and a failure is reported', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });
  hooks.tabStats.set(99, { blocked: 1, trackers: 0, url: 'https://closed.example/' });

  // stats-cleanup drops tab entries whose tab is gone.
  await chrome.alarms.onAlarm._fireAsync({ name: ALARM_STATS_CLEANUP });
  assert.equal(hooks.tabStats.has(99), false, 'the stats alarm still cleans up');

  // An alarm whose work throws must be reported, not left as an unhandled
  // rejection in a listener nobody awaits. `cleanupTabStats` starts with a
  // tabs.query, so that is the cheapest real failure to inject.
  const origQuery = chrome.tabs.query;
  chrome.tabs.query = async () => { throw new Error('alarm work exploded'); };
  try {
    await chrome.alarms.onAlarm._fireAsync({ name: ALARM_STATS_CLEANUP });
  } finally {
    chrome.tabs.query = origQuery;
  }
  const contexts = [...hooks.errorReport.warnings, ...hooks.errorReport.critical].map((e) => e.context);
  assert.ok(contexts.some((c) => String(c).startsWith('alarm:')),
    `an alarm failure must reach the error report, got ${JSON.stringify(contexts)}`);

  hooks.cancelPendingStatsPersistForTest();
});
