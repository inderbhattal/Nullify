/**
 * Regression tests for the service-worker security pass:
 *  §2.3 (REVIEW.md) — privileged message types must require an extension-page
 *        sender; `sender.id === chrome.runtime.id` also holds for content
 *        scripts in arbitrary pages and is not a privilege boundary.
 *  §4.13 — CONTENT_BLOCKED payloads are renderer-controlled and must be
 *        validated before they reach stats or the logger broadcast.
 *  §4.24 — boot key seeded non-configurable; strict registry verification.
 *  §4.25 — packed builds have no onRuleMatchedDebug; the SW must expose
 *        `networkStatsAvailable` so the UI can label counters honestly.
 *  §5.4 — GET_TAB_STATS honors payload.tabId only for extension pages.
 *  §5.5 — RUN_SCRIPTLETS / GET_SCRIPTLET_RULES are deleted (dead attack surface).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { makeChromeStub } from './chrome-stub.mjs';
import { loadServiceWorker } from './sw-loader.mjs';

/** Sender shape of our content script running in an arbitrary web page. */
function contentScriptSender(tabId = 7, url = 'https://evil.example/page') {
  return { url, tab: { id: tabId, url }, frameId: 0 };
}

// ---------------------------------------------------------------------------
// §2.3 — privileged-message gate
// ---------------------------------------------------------------------------

const DNR_ALLOWLIST_START = 990_000;

function allowlistRules(chrome) {
  return [...chrome.declarativeNetRequest._dynamic.values()]
    .filter((r) => r.id >= DNR_ALLOWLIST_START);
}

test('2.3: a destructive DNR mutation is refused for a content-script sender', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  // Put a dynamic rule in place so a successful removal would be observable.
  const seedRes = await chrome.runtime.sendMessage({
    type: 'ALLOW_SITE',
    payload: { domain: 'example.com' },
  });
  assert.equal(seedRes.ok, true);
  assert.equal(allowlistRules(chrome).length, 1, 'the allowlist rule must be live');

  const res = await chrome.runtime.sendMessage(
    { type: 'DISALLOW_SITE', payload: { domain: 'example.com' } },
    contentScriptSender()
  );

  assert.ok(res.error, 'content-script sender must be refused');
  assert.equal(allowlistRules(chrome).length, 1,
    'no dynamic rule may be removed by a renderer-reachable message');
  assert.deepEqual(chrome.storage.local._data().allowlist, ['example.com']);

  // Extension pages (popup/options) still can.
  const ok = await chrome.runtime.sendMessage(
    { type: 'DISALLOW_SITE', payload: { domain: 'example.com' } });
  assert.equal(ok.ok, true);
  assert.equal(allowlistRules(chrome).length, 0);

  hooks.cancelPendingStatsPersistForTest();
});

test('2.3: every settings/allowlist/filter writer requires an extension-page sender', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const privileged = [
    { type: 'UPDATE_SETTINGS', payload: { enabled: false } },
    { type: 'GET_SETTINGS' },
    { type: 'ADD_ALLOWLIST_DOMAINS', payload: { domains: ['example.com'] } },
    { type: 'ALLOW_SITE', payload: { domain: 'example.com' } },
    { type: 'DISALLOW_SITE', payload: { domain: 'example.com' } },
    { type: 'GET_ALLOWLIST' },
    { type: 'GET_USER_FILTERS' },
    { type: 'SET_USER_FILTERS', payload: { filters: '||x.example^' } },
    { type: 'SET_RULESET_ENABLED', payload: { rulesetId: 'easylist', enabled: false } },
    { type: 'GET_ENABLED_RULESETS' },
    { type: 'GET_DAILY_BLOCKED_TOTAL' },
    { type: 'CHECK_FILTER_UPDATES' },
    { type: 'GET_ERROR_REPORT' },
    { type: 'CLEAR_ERROR_REPORT' },
  ];

  for (const message of privileged) {
    const res = await chrome.runtime.sendMessage(message, contentScriptSender());
    assert.ok(
      res && res.error && /extension-page sender required/.test(res.error),
      `${message.type} must be refused for content-script senders, got ${JSON.stringify(res)}`
    );
  }

  assert.deepEqual(chrome.storage.local._data().allowlist ?? [], [],
    'no write may have landed');
  assert.equal(chrome.storage.local._data().userFilters ?? '', '');

  hooks.cancelPendingStatsPersistForTest();
});

test('2.3: content-script-reachable types still work from a content-script sender', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });
  const sender = contentScriptSender();

  const init = await chrome.runtime.sendMessage(
    { type: 'GET_INIT_DATA', payload: { hostname: 'evil.example' } }, sender);
  assert.equal(init.error, undefined);
  assert.equal(init.isAllowed, false);

  const blocked = await chrome.runtime.sendMessage(
    { type: 'CONTENT_BLOCKED', payload: { selector: '.ad', action: 'hide', hostname: 'evil.example' } },
    sender);
  assert.equal(blocked.ok, true);

  const append = await chrome.runtime.sendMessage(
    { type: 'APPEND_USER_FILTER', payload: { line: 'evil.example##.ad' } }, sender);
  assert.equal(append.ok, true, `element picker path must stay reachable: ${JSON.stringify(append)}`);

  const reported = await chrome.runtime.sendMessage(
    { type: 'REPORT_CONTENT_ERROR', payload: { hostname: 'evil.example', message: 'boom' } },
    sender);
  assert.equal(reported.ok, true);

  hooks.cancelPendingStatsPersistForTest();
});

test('2.3: unknown message types fail closed for content-script senders', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const res = await chrome.runtime.sendMessage(
    { type: 'SOME_FUTURE_HANDLER' }, contentScriptSender());
  assert.match(res.error, /extension-page sender required/);

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §5.4 — GET_TAB_STATS tabId scoping
// ---------------------------------------------------------------------------

test('5.4: a content script cannot read another tab\'s stats/URL via payload.tabId', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  hooks.tabStats.set(1, { blocked: 42, trackers: 9, url: 'https://secret-bank.example/account' });
  hooks.tabStats.set(7, { blocked: 3, trackers: 1, url: 'https://evil.example/page' });

  const res = await chrome.runtime.sendMessage(
    { type: 'GET_TAB_STATS', payload: { tabId: 1 } },
    contentScriptSender(7)
  );

  assert.equal(res.url, 'https://evil.example/page',
    'content script must only ever see its own tab');
  assert.equal(res.blocked, 3);

  // Extension pages (popup: no sender.tab) still query arbitrary tabs.
  const popupRes = await chrome.runtime.sendMessage(
    { type: 'GET_TAB_STATS', payload: { tabId: 1 } });
  assert.equal(popupRes.blocked, 42);
  assert.equal(popupRes.url, 'https://secret-bank.example/account');

  hooks.clearInMemoryStatsForTest();
  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §4.13 — CONTENT_BLOCKED payload validation
// ---------------------------------------------------------------------------

function loggerEvents(chrome) {
  return chrome.calls.filter((c) =>
    c.api === 'runtime.sendMessage' && c.message?.type === 'LOGGER_EVENT');
}

test('4.13: CONTENT_BLOCKED rejects a markup-bearing action instead of broadcasting it', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const res = await chrome.runtime.sendMessage({
    type: 'CONTENT_BLOCKED',
    payload: { action: '<style>[data-x]{background:url(https://a/leak)}</style>', selector: '.x' },
  }, contentScriptSender());

  assert.ok(res.error, 'invalid action must be refused');
  assert.equal(loggerEvents(chrome).length, 0, 'nothing may reach the logger');
  assert.equal(hooks.tabStats.get(7)?.blocked ?? 0, 0, 'stats must not be counted');

  hooks.cancelPendingStatsPersistForTest();
});

test('4.13: CONTENT_BLOCKED type/length-checks selector and hostname', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const bad = [
    { action: 'hide', selector: { toString: () => '.x' } },
    { action: 'hide', selector: 'x'.repeat(2000) },
    { action: 'hide', selector: '.x', hostname: 42 },
    { action: 'hide', selector: '.x', hostname: 'h'.repeat(300) },
  ];
  for (const payload of bad) {
    const res = await chrome.runtime.sendMessage(
      { type: 'CONTENT_BLOCKED', payload }, contentScriptSender());
    assert.ok(res.error, `expected refusal for ${JSON.stringify(Object.keys(payload))}`);
  }
  assert.equal(loggerEvents(chrome).length, 0);

  // The legitimate shapes still count and broadcast.
  for (const action of ['hide', 'remove', undefined]) {
    const res = await chrome.runtime.sendMessage(
      { type: 'CONTENT_BLOCKED', payload: { action, selector: '.ad', hostname: 'site.example' } },
      contentScriptSender());
    assert.equal(res.ok, true);
  }
  const events = loggerEvents(chrome);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.message.payload.action), ['hide', 'remove', 'hide']);

  hooks.clearInMemoryStatsForTest();
  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §4.25 — packed-build network stats signal
// ---------------------------------------------------------------------------

test('4.25: without onRuleMatchedDebug the SW reports networkStatsAvailable:false', async () => {
  const stub = makeChromeStub();
  delete stub.declarativeNetRequest.onRuleMatchedDebug; // packed CRX reality
  const { chrome, hooks } = await loadServiceWorker({ stub, awaitReady: true });

  const tabStats = await chrome.runtime.sendMessage({ type: 'GET_TAB_STATS', payload: { tabId: 1 } });
  assert.equal(tabStats.networkStatsAvailable, false);

  const daily = await chrome.runtime.sendMessage({ type: 'GET_DAILY_BLOCKED_TOTAL' });
  assert.equal(daily.networkStatsAvailable, false);

  const init = await chrome.runtime.sendMessage(
    { type: 'GET_INIT_DATA', payload: { hostname: 'site.example' } }, contentScriptSender());
  assert.equal(init.networkStatsAvailable, false);

  hooks.cancelPendingStatsPersistForTest();
});

test('4.25: with the debug event present the signal is true and the listener registers', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  assert.equal(chrome.declarativeNetRequest.onRuleMatchedDebug._listeners.size, 1);
  const tabStats = await chrome.runtime.sendMessage({ type: 'GET_TAB_STATS', payload: { tabId: 1 } });
  assert.equal(tabStats.networkStatsAvailable, true);

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §5.5 — dead scriptlet handlers removed
// ---------------------------------------------------------------------------

test('5.5: RUN_SCRIPTLETS and GET_SCRIPTLET_RULES no longer exist', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  // From a renderer they die at the privilege gate (fail closed)…
  for (const type of ['RUN_SCRIPTLETS', 'GET_SCRIPTLET_RULES']) {
    const res = await chrome.runtime.sendMessage(
      { type, payload: { scriptlets: [{ name: 'set-cookie', args: ['a', 'b'] }], hostname: 'x.example' } },
      contentScriptSender());
    assert.ok(res.error, `${type} must not be reachable from a content script`);
    assert.ok(!chrome.calls.filter((c) => c.api === 'scripting.executeScript').length,
      'no injection may result');
  }

  // …and even for extension pages the handler is gone.
  for (const type of ['RUN_SCRIPTLETS', 'GET_SCRIPTLET_RULES']) {
    const res = await chrome.runtime.sendMessage({ type, payload: { hostname: 'x.example' } });
    assert.match(res.error, /Unknown message type/);
  }

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §5.33 — dead handlers removed
// ---------------------------------------------------------------------------

test('5.33: the six caller-less handlers are gone from the bus and the sender policy', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const seedRes = await chrome.runtime.sendMessage({
    type: 'ALLOW_SITE', payload: { domain: 'example.com' } });
  assert.equal(seedRes.ok, true);
  const dynamicBefore = chrome.declarativeNetRequest._dynamic.size;
  await chrome.runtime.sendMessage({
    type: 'SET_USER_FILTERS', payload: { filters: 'evil.example##.ad' } });
  const settingsBefore = JSON.stringify(chrome.storage.local._data().settings);
  const allowlistBefore = [...(chrome.storage.local._data().allowlist || [])];

  const deleted = [
    { type: 'SET_SETTINGS', payload: { enabled: false } },
    { type: 'SET_ALLOWLIST', payload: { domains: ['takeover.example'] } },
    { type: 'GET_COSMETIC_RULES', payload: { hostname: 'evil.example' } },
    { type: 'GET_NOISE', payload: { mean: 0, stdDev: 1 } },
    { type: 'GET_ANONYMIZED_STATS' },
    { type: 'FORCE_CLEAN_ALL_DYNAMIC_RULES' },
  ];

  // The two SENDER_ANY ones (GET_COSMETIC_RULES, GET_NOISE) must now fail
  // closed at the privilege gate, i.e. they are no longer renderer-reachable
  // surface at all…
  for (const message of deleted) {
    const res = await chrome.runtime.sendMessage(message, contentScriptSender());
    assert.match(res.error, /extension-page sender required/,
      `${message.type} must fail closed for a content-script sender`);
  }

  // …and even from an extension page there is no handler left.
  for (const message of deleted) {
    const res = await chrome.runtime.sendMessage(message);
    assert.match(res.error, /Unknown message type/,
      `${message.type} must no longer be handled`);
  }

  // Nothing they used to do may have happened.
  assert.equal(chrome.declarativeNetRequest._dynamic.size, dynamicBefore,
    'FORCE_CLEAN_ALL_DYNAMIC_RULES must not have wiped the dynamic ruleset');
  assert.equal(JSON.stringify(chrome.storage.local._data().settings), settingsBefore);
  assert.deepEqual([...(chrome.storage.local._data().allowlist || [])], allowlistBefore);

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §4.24 — boot-key seeding and registry verification (unit level; the
// executeScript stub does not evaluate funcs, so the MAIN-world helpers are
// exercised directly via test hooks).
// ---------------------------------------------------------------------------

test('4.24: seedBootKey seeds the boot property non-configurable', async () => {
  const { hooks } = await loadServiceWorker({ awaitReady: true });

  const key = '__n_' + 'a'.repeat(32);
  assert.equal(hooks.seedBootKey(key), true);

  const desc = Object.getOwnPropertyDescriptor(globalThis, '__nullifyBootKey');
  assert.ok(desc);
  assert.equal(desc.configurable, false,
    'a polling page must not be able to redefine the boot key in the seed→load gap');
  assert.equal(desc.writable, false);
  assert.equal(desc.enumerable, false);
  assert.equal(desc.value, key);

  hooks.cancelPendingStatsPersistForTest();
});

test('4.24: verifyScriptletRegistry refuses page-controlled registry shapes', async () => {
  const { hooks } = await loadServiceWorker({ awaitReady: true });
  globalThis.window = globalThis;
  const verify = hooks.verifyScriptletRegistry;

  // Missing key.
  assert.equal(verify('__n_' + 'b'.repeat(32)), false);

  // Plain-assignment spy: configurable/writable/enumerable.
  const spyKey = '__n_' + 'c'.repeat(32);
  globalThis[spyKey] = { run: () => {} };
  assert.equal(verify(spyKey), false, 'a configurable spy must be refused');
  delete globalThis[spyKey];

  // Pre-claimed non-configurable but unfrozen object (the §4.24 variant:
  // page claims the key before the bundle loads; bundle refuses to register).
  const claimKey = '__n_' + 'd'.repeat(32);
  Object.defineProperty(globalThis, claimKey, {
    value: { run: () => {}, extra: 1 },
    writable: false, configurable: false, enumerable: false,
  });
  assert.equal(verify(claimKey), false,
    'an unfrozen or extra-keyed registry must never receive scriptlet specs');

  // Accessor spy — a getter can hand out different objects per read.
  const getterKey = '__n_' + 'e'.repeat(32);
  Object.defineProperty(globalThis, getterKey, {
    get: () => Object.freeze({ run: () => {} }),
    configurable: false, enumerable: false,
  });
  assert.equal(verify(getterKey), false, 'accessor descriptors must be refused');

  // The genuine shape the bundle produces passes.
  const goodKey = '__n_' + 'f'.repeat(32);
  Object.defineProperty(globalThis, goodKey, {
    value: Object.freeze({ run: () => {} }),
    writable: false, configurable: false, enumerable: false,
  });
  assert.equal(verify(goodKey), true);

  hooks.cancelPendingStatsPersistForTest();
});
