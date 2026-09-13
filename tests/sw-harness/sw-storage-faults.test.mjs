/**
 * Regression tests for REVIEW-2026-09 §3.1 — reads that feed a write must not
 * degrade to "empty".
 *
 * 2026-07 §5.11 made `getStorageBulk` resolve `{}` whenever a
 * `chrome.storage.local.get` fired its callback with `chrome.runtime.lastError`
 * set. Every allowlist / user-filter / settings / stats read-modify-write then
 * treated that empty result as authoritative and committed it: one transient
 * read fault wiped the user's allowlist (with a success response), the startup
 * reconcile deleted every stored entry AND every DNR allow rule with no user
 * action, the element picker replaced the whole My Filters text with the one
 * picked line, and the stats restore zeroed the day total.
 *
 * Each scenario boots a fresh worker and injects exactly one failing read via
 * the stub's `_failNextRead`. The "(didn't re-break)" cases pin the behaviour
 * the fix must preserve: read-only startup decisions still degrade quietly,
 * and a rejected op leaves the serialized op chain usable.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { makeChromeStub } from './chrome-stub.mjs';
import { loadServiceWorker } from './sw-loader.mjs';

const SEEDED = ['bank.example', 'mail.example', 'work.example'];
const USER_FILTERS_TEXT = '||ads.example^\nexample.com##.ad\n';
const DNR_USER_RULES_START = 900_000;
const DNR_ALLOWLIST_START = 990_000;

function allowRules(chrome) {
  return [...chrome.declarativeNetRequest._dynamic.values()]
    .filter((r) => r.id >= DNR_ALLOWLIST_START && r.action?.type === 'allowAllRequests');
}

function userRules(chrome) {
  return [...chrome.declarativeNetRequest._dynamic.values()]
    .filter((r) => r.id >= DNR_USER_RULES_START && r.id < DNR_ALLOWLIST_START);
}

function warningContexts(hooks) {
  return hooks.errorReport.warnings.map((entry) => entry.context);
}

// The harness cuts the network on purpose, so every worker reports one
// CRITICAL for WASM init. "Background setup must not fail" means: nothing
// critical beyond that self-inflicted entry.
function unexpectedCriticals(hooks) {
  return hooks.errorReport.critical
    .filter((entry) => entry.context !== 'WASM initialization')
    .map((entry) => `${entry.context}: ${entry.message}`);
}

const readsAllowlist = (keys) => keys.includes('allowlist');
// refreshMemoryCache's bulk read: several keys, allowlist among them.
const readsAllowlistBulk = (keys) => keys.length > 1 && keys.includes('allowlist');
const readsSettingsOnly = (keys) => keys.length === 1 && keys[0] === 'settings';

const SHIELD_SCRIPT_ID = 'nullify-youtube-shield';
const SHIELD_MATCHES = ['*://youtube.com/*', '*://www.youtube.com/*', '*://m.youtube.com/*', '*://music.youtube.com/*'];
const SHIELD_APIS = ['scripting.updateContentScripts', 'scripting.registerContentScripts', 'scripting.executeScript'];

function shieldRegistration(chrome) {
  return chrome.scripting._registered.get(SHIELD_SCRIPT_ID);
}

// Same local-day arithmetic as the worker's getCurrentDayStamp (see
// sw-cold-start.test.mjs for why this must not be toISOString()).
function localDayStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

test('3.1: one failed allowlist read makes ALLOW_SITE answer {error} and write nothing', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    awaitReady: true,
    seed: { allowlist: [...SEEDED] },
  });
  assert.equal(allowRules(chrome).length, 3, 'precondition: startup built the three allow rules');

  const fired = chrome.storage.local._failNextRead(readsAllowlist);
  const res = await chrome.runtime.sendMessage({ type: 'ALLOW_SITE', payload: { domain: 'news.example' } });

  assert.equal(fired(), true, 'the fault must have been consumed by the allowlist read');
  assert.ok(res?.error, `a failed read must answer {error}, got ${JSON.stringify(res)}`);
  assert.equal(res.ok, undefined, 'must not report success');
  assert.deepEqual(chrome.storage.local._data().allowlist, SEEDED,
    'the stored allowlist must be untouched — the old code committed ["news.example"] over it');
  assert.equal(allowRules(chrome).length, 3, 'the DNR allow rules must be untouched');

  hooks.cancelPendingStatsPersistForTest();
});

test('3.1 (didn\'t re-break): the op chain survives a rejected op', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    awaitReady: true,
    seed: { allowlist: [...SEEDED] },
  });

  chrome.storage.local._failNextRead(readsAllowlist);
  const failed = await chrome.runtime.sendMessage({ type: 'ALLOW_SITE', payload: { domain: 'news.example' } });
  assert.ok(failed?.error, 'precondition: the first op rejected');

  const res = await chrome.runtime.sendMessage({ type: 'ALLOW_SITE', payload: { domain: 'news.example' } });
  assert.equal(res.ok, true, `the next op must run normally, got ${JSON.stringify(res)}`);
  assert.deepEqual(res.allowlist, [...SEEDED, 'news.example']);
  assert.deepEqual(chrome.storage.local._data().allowlist, [...SEEDED, 'news.example']);
  assert.equal(allowRules(chrome).length, 4);
  assert.equal(hooks.isAllowlistCacheTrusted(), true,
    'a mutation composed from a successful strict read leaves the cache trusted');

  hooks.cancelPendingStatsPersistForTest();
});

test('3.1: a failed bulk read at startup skips the DNR reconcile and reports', async () => {
  // A shield target is allowlisted so the shield assertion below is live: the
  // boot registers the shield with every YouTube pattern excluded (youtube.com
  // covers the www/m/music hosts), and a reconcile from an empty read would
  // empty that exclude list via updateContentScripts.
  const seeded = [...SEEDED, 'youtube.com'];
  const { chrome, hooks } = await loadServiceWorker({
    awaitReady: true,
    seed: { allowlist: [...seeded] },
  });
  assert.equal(allowRules(chrome).length, 4);
  assert.equal(hooks.isHostnameAllowedCached('bank.example'), true);
  assert.deepEqual(shieldRegistration(chrome)?.excludeMatches, SHIELD_MATCHES,
    'precondition: the boot registered the shield with the allowlisted hosts excluded');

  const fired = chrome.storage.local._failNextRead(readsAllowlistBulk);
  const before = chrome.calls.length;
  await hooks.refreshMemoryCache();
  assert.equal(fired(), true, 'the fault must have been consumed by the bulk read');
  const during = chrome.calls.entries.slice(before).map((c) => c.api);

  assert.deepEqual(chrome.storage.local._data().allowlist, seeded,
    'the reconcile must not run against an empty read — the old code wrote [] to storage');
  assert.equal(allowRules(chrome).length, 4,
    'the reconcile must not delete the allow rules — the old code removed all four');
  assert.ok(warningContexts(hooks).includes('refreshMemoryCache:storageRead'),
    `the fault must be reported; warnings were ${JSON.stringify(warningContexts(hooks))}`);

  // The shield registration is deliberately not touched from an untrusted
  // cache: the old code recomputed excludeMatches from the empty list and
  // pushed it with updateContentScripts, re-arming the shield on the
  // allowlisted host.
  for (const api of SHIELD_APIS) {
    assert.ok(!during.includes(api), `${api} must not be called during a degraded refresh`);
  }
  assert.deepEqual(shieldRegistration(chrome)?.excludeMatches, SHIELD_MATCHES,
    'the persisted exclude list must survive the degraded refresh');
  assert.equal(hooks.isHostnameAllowedCached('bank.example'), true,
    'the cache from the last successful read is left in place');

  hooks.cancelPendingStatsPersistForTest();
});

test('3.1: a failed bulk read on a COLD worker leaves the persisted shield registration alone', async () => {
  // Bullseye #2/#4 through the storage door: a previous life (allowlist
  // ['bank.example','youtube.com']) persisted the shield with every YouTube
  // pattern excluded. The next worker starts
  // with an empty `cachedAllowlist`; if its failed boot read were treated as
  // "empty allowlist", the sync would compute excludeMatches: [] and
  // updateContentScripts the persisted registration — re-injecting the shield
  // into the allowlisted tab with no user action.
  const stub = makeChromeStub();
  await stub.scripting.registerContentScripts([{
    id: SHIELD_SCRIPT_ID,
    matches: SHIELD_MATCHES,
    excludeMatches: [...SHIELD_MATCHES],
    js: ['youtube-shield.js'],
    runAt: 'document_start',
    world: 'MAIN',
    allFrames: true,
    persistAcrossSessions: true,
  }]);
  stub.calls.clear();
  const fired = stub.storage.local._failNextRead(readsAllowlistBulk);

  const seeded = ['bank.example', 'youtube.com'];
  const { chrome, hooks } = await loadServiceWorker({
    stub,
    awaitReady: true,
    seed: { allowlist: [...seeded] },
  });
  assert.equal(fired(), true, 'the fault must have been consumed by the boot bulk read');

  const bootApis = chrome.calls.entries.map((c) => c.api);
  for (const api of SHIELD_APIS) {
    assert.ok(!bootApis.includes(api), `${api} must not be called during a degraded boot`);
  }
  assert.deepEqual(shieldRegistration(chrome).excludeMatches, SHIELD_MATCHES,
    'the persisted exclude list must be intact — the old code emptied it');
  assert.deepEqual(chrome.storage.local._data().allowlist, seeded);
  assert.ok(warningContexts(hooks).includes('refreshMemoryCache:storageRead'));
  assert.equal(hooks.isAllowlistCacheTrusted(), false, 'a degraded boot must not mark the cache trusted');
  assert.deepEqual(unexpectedCriticals(hooks), [], 'the boot must continue');

  // Repair: a mutation reads storage strictly, repopulates the cache from the
  // full stored list and resyncs the shield from a trusted cache.
  const res = await chrome.runtime.sendMessage({ type: 'ALLOW_SITE', payload: { domain: 'news.example' } });
  assert.equal(res.ok, true, `expected the mutation to succeed, got ${JSON.stringify(res)}`);
  assert.deepEqual(res.allowlist, [...seeded, 'news.example']);
  assert.equal(hooks.isAllowlistCacheTrusted(), true,
    'a successful mutation must repair the trusted flag for the rest of the SW life');
  assert.deepEqual(shieldRegistration(chrome).excludeMatches, SHIELD_MATCHES);

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// User filters
// ---------------------------------------------------------------------------

test('3.1: a failed userFilters read makes APPEND_USER_FILTER answer {error} and keep the text', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    awaitReady: true,
    seed: { userFilters: USER_FILTERS_TEXT, userFiltersApplied: USER_FILTERS_TEXT },
  });

  const fired = chrome.storage.local._failNextRead((keys) => keys.includes('userFilters'));
  const res = await chrome.runtime.sendMessage({
    type: 'APPEND_USER_FILTER',
    payload: { line: 'site.example##.picked' },
  });

  assert.equal(fired(), true, 'the fault must have been consumed by the userFilters read');
  assert.ok(res?.error, `a failed read must answer {error}, got ${JSON.stringify(res)}`);
  assert.equal(chrome.storage.local._data().userFilters, USER_FILTERS_TEXT,
    'the stored text must be untouched — the old code replaced it with the one picked line');

  // Didn't re-break: the next append lands on the intact text.
  const again = await chrome.runtime.sendMessage({
    type: 'APPEND_USER_FILTER',
    payload: { line: 'site.example##.picked' },
  });
  assert.equal(again.ok, true, `expected the retry to succeed, got ${JSON.stringify(again)}`);
  assert.equal(chrome.storage.local._data().userFilters, `${USER_FILTERS_TEXT}site.example##.picked`);

  hooks.cancelPendingStatsPersistForTest();
});

test('3.1 (didn\'t re-break): a failed USER_FILTERS read at startup neither applies filters nor fails background setup', async () => {
  const stub = makeChromeStub();
  const fired = stub.storage.local._failNextRead(
    (keys) => keys.includes('userFilters') && keys.includes('userFiltersApplied'),
  );
  const { chrome, hooks } = await loadServiceWorker({
    stub,
    awaitReady: true,
    seed: { userFilters: '||ads.example^' },
  });

  assert.equal(fired(), true, 'the fault must have been consumed by the background-setup read');
  assert.equal(userRules(chrome).length, 0,
    'an unknown filter text must not be applied (equal-strings ⇒ skip, as today)');
  assert.equal(chrome.storage.local._data().userFiltersApplied, undefined,
    'nothing may be recorded as applied');
  assert.equal(chrome.storage.local._data().userFilters, '||ads.example^', 'the stored text is untouched');
  assert.deepEqual(unexpectedCriticals(hooks), [],
    'a read-only startup decision must degrade quietly, not fail the whole background setup');

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

test('3.1: a failed stats read is "unknown", not zero', async () => {
  const stub = makeChromeStub();
  const TODAY = localDayStamp();

  // Every read that carries tabStats fails until the stub is restored — the
  // restore is retried on each writer, so a one-shot fault is not enough here.
  const originalGet = stub.storage.local.get;
  stub.storage.local.get = (keys, cb) => {
    if (Array.isArray(keys) && keys.includes('tabStats')) stub.storage.local._failNextRead();
    return originalGet(keys, cb);
  };

  const { chrome, hooks } = await loadServiceWorker({
    stub,
    awaitReady: true,
    seed: { totalBlockedToday: 42, totalBlockedDate: TODAY },
  });
  assert.equal(localDayStamp(), hooks.getCurrentDayStamp(), 'seed stamp must match the worker stamp');

  await hooks.persistTabStats();

  // The loader's own seed write carries totalBlockedToday too (alongside
  // `settings`); only the worker's stats writes are of interest.
  const totalWrites = () => chrome.calls.entries
    .filter((c) => c.api === 'storage.set' && c.entries &&
      'totalBlockedToday' in c.entries && !('settings' in c.entries));
  assert.equal(chrome.storage.local._data().totalBlockedToday, 42,
    'the stored day total must survive — the old code restored "0" and wrote it back');
  assert.deepEqual(totalWrites(), [], 'no stats write may land from an un-restored state');
  assert.ok(warningContexts(hooks).includes('restorePersistedStats:storageRead'),
    `the fault must be reported; warnings were ${JSON.stringify(warningContexts(hooks))}`);
  assert.equal(warningContexts(hooks).filter((c) => c === 'restorePersistedStats:storageRead').length, 1,
    'three failed attempts (module load, stage 2, this persist) must report once, not per attempt');

  // Didn't re-break (§4.14): once reads work again the next writer restores
  // first and then writes the restored value.
  stub.storage.local.get = originalGet;
  await hooks.persistTabStats();

  assert.equal(hooks.getTotals().totalBlockedToday, 42, 'the restore must have run on the next writer');
  assert.equal(chrome.storage.local._data().totalBlockedToday, 42);
  assert.equal(totalWrites().length, 1, 'exactly one stats write, carrying the restored value');
  assert.equal(totalWrites()[0].entries.totalBlockedToday, 42);

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test('3.1: a failed settings read makes UPDATE_SETTINGS answer {error} and keep the object', async () => {
  const SETTINGS = { enabled: true, showBadge: true, blockWebRTC: true };
  const { chrome, hooks } = await loadServiceWorker({
    awaitReady: true,
    seed: { settings: { ...SETTINGS } },
  });

  const fired = chrome.storage.local._failNextRead(readsSettingsOnly);
  const res = await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', payload: { showBadge: false } });

  assert.equal(fired(), true, 'the fault must have been consumed by the settings read');
  assert.ok(res?.error, `a failed read must answer {error}, got ${JSON.stringify(res)}`);
  assert.deepEqual(chrome.storage.local._data().settings, SETTINGS,
    'the stored object must be untouched — the old code replaced it with the delta alone');

  // Didn't re-break: the next partial update merges onto the intact object.
  const again = await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', payload: { showBadge: false } });
  assert.equal(again.ok, true, `expected the retry to succeed, got ${JSON.stringify(again)}`);
  assert.deepEqual(chrome.storage.local._data().settings, { ...SETTINGS, showBadge: false });

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// initializeDefaults — runs on EVERY worker start, not only on install
// ---------------------------------------------------------------------------

test('3.1: a failed SETTINGS read on an ordinary wake does not rewrite defaults', async () => {
  const stub = makeChromeStub();
  // The first single-key SETTINGS read of a boot is initializeDefaults'.
  const fired = stub.storage.local._failNextRead(readsSettingsOnly);
  const { chrome, hooks } = await loadServiceWorker({
    stub,
    seed: { allowlist: [...SEEDED], userFilters: USER_FILTERS_TEXT, userFiltersApplied: USER_FILTERS_TEXT },
  });

  await hooks.whenCriticalReady();
  await hooks.whenBackgroundSetupDone();

  assert.equal(fired(), true, 'the fault must have been consumed during the boot');
  assert.deepEqual(chrome.storage.local._data().allowlist, SEEDED,
    'a failed SETTINGS read must not be read as "fresh profile" — the old code wrote allowlist: []');
  assert.equal(chrome.storage.local._data().userFilters, USER_FILTERS_TEXT);
  assert.equal(allowRules(chrome).length, 3, 'the allow rules must survive the wake');
  assert.ok(warningContexts(hooks).includes('initializeDefaults:storageRead'),
    `the fault must be reported; warnings were ${JSON.stringify(warningContexts(hooks))}`);
  assert.deepEqual(unexpectedCriticals(hooks), [], 'background setup must not fail');

  hooks.cancelPendingStatsPersistForTest();
});

test('3.1: a failed read during install does not write defaults over user state', async () => {
  const stub = makeChromeStub();
  const { chrome, hooks } = await loadServiceWorker({
    stub,
    seed: { allowlist: [...SEEDED], userFilters: USER_FILTERS_TEXT, userFiltersApplied: USER_FILTERS_TEXT },
  });

  // Arm and fire back-to-back: the install handler's initializeDefaults issues
  // its SETTINGS read synchronously, so the fault lands there and not on the
  // concurrent startInitialization path.
  const fired = stub.storage.local._failNextRead(readsSettingsOnly);
  const installed = chrome.runtime.onInstalled._fireAsync({ reason: 'install' });
  assert.equal(fired(), true, 'the install handler must have issued the SETTINGS read');

  await installed;
  await hooks.whenCriticalReady();
  await hooks.whenBackgroundSetupDone();

  assert.deepEqual(chrome.storage.local._data().allowlist, SEEDED,
    'install must not write defaults over user state when the read failed');
  assert.equal(chrome.storage.local._data().userFilters, USER_FILTERS_TEXT);
  assert.equal(allowRules(chrome).length, 3);
  assert.ok(warningContexts(hooks).includes('initializeDefaults:storageRead'));
  assert.deepEqual(unexpectedCriticals(hooks), [], 'the install handler must complete');

  hooks.cancelPendingStatsPersistForTest();
});
