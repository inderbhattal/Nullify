/**
 * Regression tests for REVIEW-2026-09 §4.5 (Track A2a, flag `refreshCadenceV2`):
 * the README's freshness argument for vendoring quick-fixes.txt rested on a
 * 24 h runtime refresh that did not hold — a fresh install waited a full
 * interval for its first refresh, an extension update rolled every
 * runtime-refreshed list back to the release snapshot and left the alarm
 * where it was, and the 24 h interval ignored a list's `! Expires:` header.
 *
 * Every case but the last runs with the flag seeded ON. The last pins the
 * flag-off behaviour byte for byte (the release that introduces the flag
 * ships it OFF; `sw-alarms.test.mjs` runs with it off too).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { makeChromeStub } from './chrome-stub.mjs';
import { loadServiceWorker } from './sw-loader.mjs';

const ALARM_FILTER_UPDATE = 'filter-list-update';
const FLAG_ON = { featureFlags: { refreshCadenceV2: true } };
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY_MINUTES = 1440;

// The D2 stamp: `generatedAt` on every packaged source. The harness's own
// `samplePackagedSources()` carries none (sw-loader.mjs is not Track A's), so
// the payload is built here with the stamp the merge compares against.
const GENERATED_AT = '2026-08-04T22:13:45.731Z';
const PACKAGED_SELECTOR = '.packaged-snapshot';
const RUNTIME_SELECTOR = '.fresh-from-runtime-refresh';

const EASYLIST_URL = 'https://easylist.to/easylist/easylist.txt';
const QUICK_FIXES_URL = 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt';

function packagedSources() {
  return {
    easylist: {
      generatedAt: GENERATED_AT,
      cosmetic: {
        generic: ['.generic-ad'],
        domainSpecific: { 'example.com': [PACKAGED_SELECTOR] },
        exceptions: {},
        genericExcludedDomains: [],
      },
      scriptlets: [],
    },
  };
}

/** Serve `served[url]` as a 200 list body; every other URL is offline. */
function listFetchStub(served) {
  const fetched = [];
  return {
    fetched,
    fetch: async (url) => {
      const u = String(url);
      fetched.push(u);
      if (Object.hasOwn(served, u)) {
        return { ok: true, status: 200, url: u, text: async () => served[u] };
      }
      throw new Error('offline');
    },
  };
}

function filterAlarmCreates(chrome, from = 0) {
  return chrome.calls.entries
    .slice(from)
    .filter((c) => c.api === 'alarms.create' && c.name === ALARM_FILTER_UPDATE);
}

async function storedEasylistSelectors(db) {
  const sources = await db.getAllFilterSources();
  const easylist = sources.find((s) => s.listId === 'easylist');
  return easylist?.cosmetic?.domainSpecific?.['example.com'] ?? null;
}

function metaFor(hooks, { fetchedAt, expiresMinutes = null, schemaVersion = hooks.RULE_DATA_SCHEMA_VERSION }) {
  return { fetchedAt, expiresMinutes, schemaVersion };
}

/**
 * Model an extension update: one worker life stores the packaged snapshot
 * and arms the alarm; a runtime refresh then lands a fresher copy of easylist
 * (written straight to the DB, with the per-list meta the refresh would have
 * recorded); a second life boots on the same disk with a changed bundled
 * rule-data version and receives `onInstalled {reason: 'update'}`.
 */
async function bootThenUpdate({ flagOn, meta }) {
  const stub = makeChromeStub();
  const seed = flagOn ? FLAG_ON : {};
  const first = await loadServiceWorker({
    stub, seed, awaitReady: true, packagedSources: packagedSources(),
  });
  assert.deepEqual(await storedEasylistSelectors(first.hooks.db), [PACKAGED_SELECTOR],
    'precondition: the first life stored the packaged snapshot');
  assert.ok(await stub.alarms.get(ALARM_FILTER_UPDATE),
    'precondition: the first life armed the filter alarm');

  await first.hooks.db.putBulkFilterSources({
    easylist: {
      cosmetic: { generic: [], domainSpecific: { 'example.com': [RUNTIME_SELECTOR] }, exceptions: {} },
      scriptlets: [],
    },
  });
  first.hooks.cancelPendingStatsPersistForTest();
  await stub.storage.local.set({
    filterListsMeta: meta ? { easylist: meta(first.hooks) } : {},
    // The bundled version the previous release wrote; the new bundle hashes
    // differently, so ensureRuleDataReady sees `ruleDataChanged`.
    ruleDataVersion: 'rv3-previous-release',
  });

  // Chrome tears the old worker down before the new one registers; the stub
  // keeps every listener, so drop the first life's or its install handler
  // would run alongside the second's and double every call it makes.
  for (const event of [stub.runtime.onInstalled, stub.runtime.onMessage, stub.alarms.onAlarm]) {
    event._listeners.clear();
  }

  const callsBefore = stub.calls.entries.length;
  const second = await loadServiceWorker({
    stub, idb: first.idb, seed, packagedSources: packagedSources(),
  });
  await stub.runtime.onInstalled._fireAsync({ reason: 'update' });
  await second.hooks.whenCriticalReady();
  await second.hooks.whenBackgroundSetupDone();
  return { chrome: stub, hooks: second.hooks, callsBefore };
}

function unexpectedCriticals(hooks) {
  return hooks.errorReport.critical.filter((e) => e.context !== 'WASM initialization');
}

// ---------------------------------------------------------------------------

test('4.5: a fresh install schedules the first refresh within a minute', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: FLAG_ON, packagedSources: packagedSources(),
  });
  await chrome.runtime.onInstalled._fireAsync({ reason: 'install' });
  await hooks.whenCriticalReady();
  await hooks.whenBackgroundSetupDone();

  assert.equal(chrome.storage.local._data().lastUpdateCheck, undefined,
    'precondition: a fresh profile has never checked');

  const creates = filterAlarmCreates(chrome);
  assert.equal(creates.length, 1, `expected one filter alarm, got ${JSON.stringify(creates)}`);
  assert.equal(creates[0].opts.delayInMinutes, 1,
    'the first refresh must be minutes away, not a full interval');
  assert.equal(creates[0].opts.periodInMinutes, DAY_MINUTES, 'the period is unchanged');
  assert.equal(hooks.isFeatureEnabled('refreshCadenceV2'), true, 'the seeded flag must be read');
  assert.deepEqual(unexpectedCriticals(hooks), []);

  hooks.cancelPendingStatsPersistForTest();
});

test('4.5: an update boot keeps the fresher runtime copy of a list', async () => {
  const { chrome, hooks, callsBefore } = await bootThenUpdate({
    flagOn: true,
    meta: (h) => metaFor(h, { fetchedAt: Date.parse(GENERATED_AT) + HOUR }),
  });

  assert.deepEqual(await storedEasylistSelectors(hooks.db), [RUNTIME_SELECTOR],
    'a runtime copy fetched after the packaged snapshot was built must survive the update');
  assert.deepEqual(await hooks.db.getCosmeticRules('example.com'), [RUNTIME_SELECTOR],
    'the rebuilt index serves the kept copy');
  assert.ok(chrome.storage.local._data().filterListsMeta.easylist,
    'the kept list keeps its meta');

  // Item 2: the install handler re-arms the alarm once so the update boot
  // refreshes within a minute instead of wherever the old alarm sat.
  const creates = filterAlarmCreates(chrome, callsBefore);
  assert.equal(creates.length, 1, `expected the one-shot reschedule, got ${JSON.stringify(creates)}`);
  assert.equal(creates[0].opts.delayInMinutes, 1);
  assert.equal(creates[0].opts.periodInMinutes, DAY_MINUTES);
  assert.deepEqual(unexpectedCriticals(hooks), []);

  hooks.cancelPendingStatsPersistForTest();
});

test('4.5: an update boot replaces a runtime copy older than the packaged snapshot', async () => {
  const { chrome, hooks } = await bootThenUpdate({
    flagOn: true,
    meta: (h) => metaFor(h, { fetchedAt: Date.parse(GENERATED_AT) - HOUR }),
  });

  assert.deepEqual(await storedEasylistSelectors(hooks.db), [PACKAGED_SELECTOR],
    'the packaged snapshot is newer, so it wins');
  assert.deepEqual(await hooks.db.getCosmeticRules('example.com'), [PACKAGED_SELECTOR]);
  assert.equal(chrome.storage.local._data().filterListsMeta.easylist, undefined,
    'meta describing a copy that no longer exists is dropped, so the next refresh fetches it');
  assert.deepEqual(unexpectedCriticals(hooks), []);

  hooks.cancelPendingStatsPersistForTest();
});

test('4.5: an update boot with a schema bump replaces the runtime copy even when it is fresher', async () => {
  const { chrome, hooks } = await bootThenUpdate({
    flagOn: true,
    meta: (h) => metaFor(h, {
      fetchedAt: Date.parse(GENERATED_AT) + HOUR,
      schemaVersion: h.RULE_DATA_SCHEMA_VERSION - 1,
    }),
  });

  assert.deepEqual(await storedEasylistSelectors(hooks.db), [PACKAGED_SELECTOR],
    'a bundle produced by the previous release\'s parser must never survive a schema bump');
  assert.deepEqual(await hooks.db.getCosmeticRules('example.com'), [PACKAGED_SELECTOR]);
  assert.equal(chrome.storage.local._data().filterListsMeta.easylist, undefined);
  assert.deepEqual(unexpectedCriticals(hooks), []);

  hooks.cancelPendingStatsPersistForTest();
});

test('4.5: a list declaring Expires: 7 days is still refetched after 24 h', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: FLAG_ON, awaitReady: true, packagedSources: packagedSources(),
  });
  const now = Date.now();
  await chrome.storage.local.set({
    filterListsMeta: { easylist: metaFor(hooks, { fetchedAt: now - 25 * HOUR, expiresMinutes: 7 * DAY_MINUTES }) },
  });
  const stub = listFetchStub({ [EASYLIST_URL]: '! Expires: 7 days\nexample.com##.refreshed-rule\n' });
  globalThis.fetch = stub.fetch;

  const before = chrome.calls.entries.length;
  await chrome.alarms.onAlarm._fireAsync({ name: ALARM_FILTER_UPDATE });

  assert.ok(stub.fetched.includes(EASYLIST_URL),
    'the declared window clamps to 24 h, and 25 h have passed');
  assert.deepEqual(await storedEasylistSelectors(hooks.db), ['.refreshed-rule']);
  const meta = chrome.storage.local._data().filterListsMeta.easylist;
  assert.ok(meta.fetchedAt >= now, `fetchedAt must be re-stamped, got ${JSON.stringify(meta)}`);
  assert.equal(meta.expiresMinutes, 7 * DAY_MINUTES, 'the header is recorded as declared');
  assert.equal(meta.schemaVersion, hooks.RULE_DATA_SCHEMA_VERSION);
  // Item 4: the period is clamp(min over lists) = 1440, the same as before,
  // so the alarm is left alone.
  assert.deepEqual(filterAlarmCreates(chrome, before), [],
    'an unchanged period must not recreate the alarm');
  assert.equal((await chrome.alarms.get(ALARM_FILTER_UPDATE)).periodInMinutes, DAY_MINUTES);

  hooks.cancelPendingStatsPersistForTest();
});

// The clamp's other half. `Expires: 7 days` above pins the ceiling; without
// these two, dropping the `Math.max(FILTER_EXPIRES_FLOOR_MINUTES, …)` would
// ship green with every list refetched hourly and a 60-minute alarm armed.
test('4.5: a list declaring Expires: 1 hour is not refetched by the alarm before the 2 h floor', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: FLAG_ON, awaitReady: true, packagedSources: packagedSources(),
  });
  const now = Date.now();
  const seeded = metaFor(hooks, { fetchedAt: now - 90 * MINUTE, expiresMinutes: 60 });
  await chrome.storage.local.set({ filterListsMeta: { easylist: seeded } });
  const stub = listFetchStub({ [EASYLIST_URL]: '! Expires: 1 hour\nexample.com##.refreshed-rule\n' });
  globalThis.fetch = stub.fetch;

  await chrome.alarms.onAlarm._fireAsync({ name: ALARM_FILTER_UPDATE });

  assert.ok(!stub.fetched.includes(EASYLIST_URL),
    'declared 1 h and fetched 90 min ago: the 120-minute floor still covers it');
  assert.ok(stub.fetched.includes(QUICK_FIXES_URL),
    'lists without meta are still attempted (otherwise this scenario tests nothing)');
  assert.deepEqual(await storedEasylistSelectors(hooks.db), [PACKAGED_SELECTOR]);
  assert.deepEqual(chrome.storage.local._data().filterListsMeta.easylist, seeded,
    'a skipped list keeps its meta untouched');

  hooks.cancelPendingStatsPersistForTest();
});

test('4.5: a list declaring Expires: 1 hour floors the alarm period at 2 h', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: FLAG_ON, awaitReady: true, packagedSources: packagedSources(),
  });
  const stub = listFetchStub({ [QUICK_FIXES_URL]: '! Expires: 1 hour\nexample.com##.quick-fix\n' });
  globalThis.fetch = stub.fetch;

  const before = chrome.calls.entries.length;
  const res = await chrome.runtime.sendMessage({ type: 'CHECK_FILTER_UPDATES' });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(chrome.storage.local._data().filterListsMeta['ubo-quick-fixes'].expiresMinutes, 60,
    'the header is recorded as declared; the clamp applies when it is consumed');
  const creates = filterAlarmCreates(chrome, before);
  assert.equal(creates.length, 1, `expected one recreate, got ${JSON.stringify(creates)}`);
  assert.deepEqual(creates[0].opts, { delayInMinutes: 120, periodInMinutes: 120 },
    'the period floors at 2 h — never the declared 60');
  assert.equal((await chrome.alarms.get(ALARM_FILTER_UPDATE)).periodInMinutes, 120);

  hooks.cancelPendingStatsPersistForTest();
});

// Decision 3 (PR text): the alarm path may find nothing due. That is not the
// offline failure the warn/`{ok: false}` branch describes — it is a clean
// no-op with nothing fetched, written, re-armed or warned about.
test('4.5: an alarm run with every list inside its window is a clean no-op', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: FLAG_ON, awaitReady: true, packagedSources: packagedSources(),
  });
  const remoteIds = hooks.ALL_KNOWN_LIST_IDS.filter((id) => id !== 'system-unbreak');
  const now = Date.now();
  const meta = Object.fromEntries(remoteIds.map((id) => [
    id, metaFor(hooks, { fetchedAt: now - HOUR, expiresMinutes: 8 * 60 }),
  ]));
  await chrome.storage.local.set({ filterListsMeta: meta });
  const stub = listFetchStub({});
  globalThis.fetch = stub.fetch;

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
  const before = chrome.calls.entries.length;
  let res;
  try {
    await chrome.alarms.onAlarm._fireAsync({ name: ALARM_FILTER_UPDATE });
    // The alarm listener discards the result; make the same call it makes to
    // pin the shape.
    res = await hooks.checkFilterListUpdates({ force: false });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.updatedLists, []);
  assert.equal(res.error, undefined, 'nothing failed');
  assert.deepEqual([...res.skippedFresh].sort(), [...remoteIds].sort(),
    'every remote list was skipped as fresh');
  assert.deepEqual(stub.fetched, [], 'nothing was due, so nothing is fetched');
  assert.equal(chrome.storage.local._data().lastUpdateCheck, undefined,
    'nothing was checked, so no timestamp is written');
  assert.deepEqual(filterAlarmCreates(chrome, before), [], 'no re-arm');
  assert.ok(!warnings.some((w) => w.includes('No filter sources were refreshed')),
    `a no-op must not be reported as an offline failure: ${JSON.stringify(warnings)}`);
  assert.deepEqual(chrome.storage.local._data().filterListsMeta, meta, 'meta untouched');

  hooks.cancelPendingStatsPersistForTest();
});

test('4.5: a list inside its Expires window is not refetched by the alarm', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: FLAG_ON, awaitReady: true, packagedSources: packagedSources(),
  });
  const now = Date.now();
  const seeded = metaFor(hooks, { fetchedAt: now - HOUR, expiresMinutes: 8 * 60 });
  await chrome.storage.local.set({ filterListsMeta: { easylist: seeded } });
  const stub = listFetchStub({ [EASYLIST_URL]: '! Expires: 8 hours\nexample.com##.refreshed-rule\n' });
  globalThis.fetch = stub.fetch;

  await chrome.alarms.onAlarm._fireAsync({ name: ALARM_FILTER_UPDATE });

  assert.ok(!stub.fetched.includes(EASYLIST_URL),
    'fetched an hour ago with 8 h to live — the alarm must leave it alone');
  assert.ok(stub.fetched.includes(QUICK_FIXES_URL),
    'lists without meta are still attempted (otherwise this scenario tests nothing)');
  assert.deepEqual(await storedEasylistSelectors(hooks.db), [PACKAGED_SELECTOR]);
  assert.deepEqual(chrome.storage.local._data().filterListsMeta.easylist, seeded,
    'a skipped list keeps its meta untouched');
  assert.equal(chrome.storage.local._data().lastUpdateCheck, undefined,
    'nothing refreshed (every other list is offline), so no timestamp is written');

  hooks.cancelPendingStatsPersistForTest();
});

test('4.5: CHECK_FILTER_UPDATES forces the fetch', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: FLAG_ON, awaitReady: true, packagedSources: packagedSources(),
  });
  const now = Date.now();
  await chrome.storage.local.set({
    filterListsMeta: { easylist: metaFor(hooks, { fetchedAt: now - HOUR, expiresMinutes: 8 * 60 }) },
  });
  const stub = listFetchStub({
    [EASYLIST_URL]: '! Expires: 4 days\nexample.com##.refreshed-rule\n',
    [QUICK_FIXES_URL]: '! Expires: 8 hours\nexample.com##.quick-fix\n',
  });
  globalThis.fetch = stub.fetch;

  const before = chrome.calls.entries.length;
  const res = await chrome.runtime.sendMessage({ type: 'CHECK_FILTER_UPDATES' });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(stub.fetched.includes(EASYLIST_URL), 'Update All must ignore the Expires window');
  assert.ok(res.updatedLists.includes('easylist') && res.updatedLists.includes('ubo-quick-fixes'),
    `both served lists refresh: ${JSON.stringify(res.updatedLists)}`);
  assert.deepEqual(await storedEasylistSelectors(hooks.db), ['.refreshed-rule']);
  const meta = chrome.storage.local._data().filterListsMeta;
  assert.equal(meta.easylist.expiresMinutes, 4 * DAY_MINUTES);
  assert.equal(meta['ubo-quick-fixes'].expiresMinutes, 8 * 60);

  // Item 4: quick-fixes declares 8 h, so the period drops from 1440 to 480
  // — one recreate, and the re-armed alarm carries the new period.
  const creates = filterAlarmCreates(chrome, before);
  assert.equal(creates.length, 1, `expected one recreate, got ${JSON.stringify(creates)}`);
  assert.deepEqual(creates[0].opts, { delayInMinutes: 8 * 60, periodInMinutes: 8 * 60 });
  assert.equal((await chrome.alarms.get(ALARM_FILTER_UPDATE)).periodInMinutes, 8 * 60);

  // A second forced check with the same headers: same period, no recreate.
  const afterFirst = chrome.calls.entries.length;
  const again = await chrome.runtime.sendMessage({ type: 'CHECK_FILTER_UPDATES' });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.ok(again.updatedLists.includes('easylist'), 'force means force, every time');
  assert.deepEqual(filterAlarmCreates(chrome, afterFirst), [],
    'an unchanged period must not recreate the alarm');

  hooks.cancelPendingStatsPersistForTest();
});

test('4.5 (flag off): behaviour is unchanged', async () => {
  // Fresh profile: the first refresh is a full interval away.
  {
    const { chrome, hooks } = await loadServiceWorker({
      awaitReady: true, packagedSources: packagedSources(),
    });
    const creates = filterAlarmCreates(chrome);
    assert.equal(creates.length, 1);
    assert.deepEqual(creates[0].opts, { delayInMinutes: DAY_MINUTES, periodInMinutes: DAY_MINUTES });
    assert.equal(hooks.isFeatureEnabled('refreshCadenceV2'), false, 'default OFF in this release');

    // The alarm refetches a list inside its window and records no meta.
    const seeded = metaFor(hooks, { fetchedAt: Date.now() - HOUR, expiresMinutes: 8 * 60 });
    await chrome.storage.local.set({ filterListsMeta: { easylist: seeded } });
    const stub = listFetchStub({ [EASYLIST_URL]: '! Expires: 8 hours\nexample.com##.refreshed-rule\n' });
    globalThis.fetch = stub.fetch;
    const before = chrome.calls.entries.length;
    await chrome.alarms.onAlarm._fireAsync({ name: ALARM_FILTER_UPDATE });
    assert.ok(stub.fetched.includes(EASYLIST_URL), 'no Expires window without the flag');
    assert.deepEqual(await storedEasylistSelectors(hooks.db), ['.refreshed-rule']);
    assert.deepEqual(chrome.storage.local._data().filterListsMeta, { easylist: seeded },
      'no per-list meta is written without the flag');
    assert.deepEqual(filterAlarmCreates(chrome, before), []);
    hooks.cancelPendingStatsPersistForTest();
  }

  // Update boot: the packaged snapshot overwrites the fresher runtime copy
  // and the alarm is left where it was.
  {
    const { chrome, hooks, callsBefore } = await bootThenUpdate({
      flagOn: false,
      meta: (h) => metaFor(h, { fetchedAt: Date.parse(GENERATED_AT) + HOUR }),
    });
    assert.deepEqual(await storedEasylistSelectors(hooks.db), [PACKAGED_SELECTOR]);
    assert.deepEqual(filterAlarmCreates(chrome, callsBefore), [],
      'no reschedule on update without the flag');
    assert.deepEqual(unexpectedCriticals(hooks), []);
    hooks.cancelPendingStatsPersistForTest();
  }
});
