/**
 * Regression tests for REVIEW-2026-07 §4.5: the filter-update alarm was
 * cleared and re-created on every service-worker start, so with the
 * 30-minute stats alarm guaranteeing regular wakes it could never fire.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { makeChromeStub } from './chrome-stub.mjs';
import { loadServiceWorker } from './sw-loader.mjs';

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
