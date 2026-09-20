/**
 * Regression tests for the service-worker security pass:
 * Section numbers collide across the review documents, so each is qualified
 * on first use here and bare afterwards.
 *
 *  REVIEW.md §2.3 — privileged message types must require an extension-page
 *        sender; `sender.id === chrome.runtime.id` also holds for content
 *        scripts in arbitrary pages and is not a privilege boundary.
 *  REVIEW-2026-07 §4.13 — CONTENT_BLOCKED payloads are renderer-controlled and
 *        must be validated before they reach stats or the logger broadcast.
 *  REVIEW-2026-07 §4.24 — boot key seeded non-configurable; strict registry
 *        verification.
 *  REVIEW-2026-07 §4.25 — packed builds have no onRuleMatchedDebug; the SW must
 *        expose `networkStatsAvailable` so the UI can label counters honestly.
 *  REVIEW-2026-07 §5.4 — GET_TAB_STATS honored payload.tabId only for extension
 *        pages; subsumed by REVIEW-2026-09 §5.3, which refuses the renderer at
 *        the gate. (Not the same finding as REVIEW-2026-09 §5.4 below.)
 *  REVIEW-2026-07 §5.5 — RUN_SCRIPTLETS / GET_SCRIPTLET_RULES are deleted (dead
 *        attack surface).
 *  REVIEW-2026-09 §5.3 — IS_SITE_ALLOWED and GET_TAB_STATS were SENDER_ANY with
 *        only extension-page callers, so any renderer could ask whether an
 *        arbitrary hostname was allowlisted.
 *  REVIEW-2026-09 §5.4 — CHECK_SEMANTIC_AD accepted unbounded renderer text and
 *        handed it straight to WASM.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { makeChromeStub } from './chrome-stub.mjs';
import { loadServiceWorker } from './sw-loader.mjs';

const SW_PATH = new URL('../../src/background/service-worker.js', import.meta.url);

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
// §5.3 — IS_SITE_ALLOWED and GET_TAB_STATS are extension-page only
//
// Both were SENDER_ANY while only the popup ever called them (verified by
// grep at HEAD across src/: popup.js:92,133,194 and nothing else). A content
// script on any page could therefore ask IS_SITE_ALLOWED about ANY hostname
// and get a straight yes/no — an allowlist-membership oracle over the user's
// browsing, readable from a compromised renderer. GET_TAB_STATS carried the
// §5.4 guard (payload.tabId honored only for extension pages) to keep the
// same renderer from enumerating tab ids and reading every open tab's URL;
// refusing the renderer at the gate subsumes that guard.
// ---------------------------------------------------------------------------

/**
 * The sender policy as the worker declares it. Read out of the source rather
 * than re-declared here, so this test cannot drift into asserting against its
 * own copy of the table (the sw-dnr-bands.test.mjs convention).
 */
async function senderPolicyFromSource() {
  const source = await readFile(SW_PATH, 'utf8');
  const match = /const MESSAGE_SENDER_POLICY = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(match, 'service-worker.js must define MESSAGE_SENDER_POLICY');
  const table = {};
  for (const [, type, value] of match[1].matchAll(/^\s*(\w+):\s*(SENDER_\w+)/gm)) {
    table[type] = value;
  }
  return table;
}

test('5.3: IS_SITE_ALLOWED and GET_TAB_STATS refuse a content-script sender', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  // The user has allowlisted their bank; a page on evil.example must not be
  // able to learn that, nor read the bank tab's URL.
  await chrome.runtime.sendMessage({ type: 'ALLOW_SITE', payload: { domain: 'secret-bank.example' } });
  hooks.tabStats.set(1, { blocked: 42, trackers: 9, url: 'https://secret-bank.example/account' });
  hooks.tabStats.set(7, { blocked: 3, trackers: 1, url: 'https://evil.example/page' });

  const allowed = await chrome.runtime.sendMessage(
    { type: 'IS_SITE_ALLOWED', payload: { domain: 'secret-bank.example' } },
    contentScriptSender(7));
  assert.match(allowed.error || '', /extension-page sender required/,
    `the allowlist oracle must be closed, got ${JSON.stringify(allowed)}`);
  assert.equal(allowed.allowed, undefined, 'and must not answer the question at all');

  const stats = await chrome.runtime.sendMessage(
    { type: 'GET_TAB_STATS', payload: { tabId: 1 } },
    contentScriptSender(7));
  assert.match(stats.error || '', /extension-page sender required/,
    `tab stats must be closed to renderers, got ${JSON.stringify(stats)}`);
  assert.equal(stats.url, undefined, 'no tab URL may come back, not even its own');

  hooks.clearInMemoryStatsForTest();
  hooks.cancelPendingStatsPersistForTest();
});

test('5.3 (didn\'t re-break): an extension-page sender still gets the answer', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  await chrome.runtime.sendMessage({ type: 'ALLOW_SITE', payload: { domain: 'secret-bank.example' } });
  hooks.tabStats.set(1, { blocked: 42, trackers: 9, url: 'https://secret-bank.example/account' });

  // The popup's three calls (popup.js:92,133,194): no sender.tab, extension
  // origin. It asks about a hostname and a tab id that are not its own.
  const allowed = await chrome.runtime.sendMessage(
    { type: 'IS_SITE_ALLOWED', payload: { domain: 'secret-bank.example' } });
  assert.equal(allowed.allowed, true, 'the popup still reads the allowlist');
  const notAllowed = await chrome.runtime.sendMessage(
    { type: 'IS_SITE_ALLOWED', payload: { domain: 'other.example' } });
  assert.equal(notAllowed.allowed, false, 'and still gets a real answer, not a blanket yes');

  // §5.4 — an extension page may still ask about an arbitrary tab; that is
  // the whole point of the popup's stats panel.
  const stats = await chrome.runtime.sendMessage(
    { type: 'GET_TAB_STATS', payload: { tabId: 1 } });
  assert.equal(stats.blocked, 42);
  assert.equal(stats.url, 'https://secret-bank.example/account');

  hooks.clearInMemoryStatsForTest();
  hooks.cancelPendingStatsPersistForTest();
});

test('5.3: the renderer-reachable set is exactly the content-script critical path', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });
  const policy = await senderPolicyFromSource();

  const reachable = Object.keys(policy).filter((type) => policy[type] === 'SENDER_ANY').sort();
  assert.deepEqual(reachable, [
    'APPEND_USER_FILTER', 'CHECK_SEMANTIC_AD', 'CONTENT_BLOCKED',
    'GET_INIT_DATA', 'REPORT_CONTENT_ERROR',
  ], 'widening the renderer-reachable surface is a decision, not an accident');

  // The table is only a claim; the gate is what enforces it. Every type the
  // table calls reachable must actually pass the gate, and the two this
  // change moved must not.
  for (const type of reachable) {
    const res = await chrome.runtime.sendMessage({ type, payload: {} }, contentScriptSender());
    assert.doesNotMatch(String(res?.error ?? ''), /extension-page sender required/,
      `${type} is declared SENDER_ANY but the gate refused it`);
  }
  for (const type of ['IS_SITE_ALLOWED', 'GET_TAB_STATS']) {
    assert.equal(policy[type], 'SENDER_EXTENSION_PAGE', `${type} must be declared extension-page only`);
    const res = await chrome.runtime.sendMessage({ type, payload: {} }, contentScriptSender());
    assert.match(res.error || '', /extension-page sender required/,
      `${type} is declared extension-page only but the gate let it through`);
  }

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

// ---------------------------------------------------------------------------
// REVIEW-2026-09 §5.4 — CHECK_SEMANTIC_AD is answerable to any renderer and
// passed whatever text it was given straight to `is_semantic_ad`. 64 MB of `x`
// held the worker for ~684 ms and left a permanent linear-memory high-water
// mark behind. The cap has to live HERE, in the handler: wasm-bindgen copies
// the whole string into linear memory BEFORE the export runs, so the Rust-side
// cap (42a7ac3) refuses the scan but cannot prevent the copy or the growth.
//
// The content engine never sends more than 400 characters
// (cosmetic-engine.js:1084 refuses above that), so 1024 UTF-16 units is 2.5x
// the largest legitimate payload and only a bypassed renderer exceeds it.
// ---------------------------------------------------------------------------

const SEMANTIC_TEXT_CAP = 1024;

test('5.4: CHECK_SEMANTIC_AD refuses over-long text without reaching the engine', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const fresh = hooks.scriptletDiagnosticsSnapshot();
  assert.equal(fresh.semanticChecksAttempted, 0, 'precondition: nothing checked yet');
  assert.equal(fresh.semanticChecksRefused, 0);

  // Leading keyword: a text the scanner WOULD call an ad, so "false" is proof
  // it never ran rather than proof the scan found nothing.
  const oversized = `sponsored ${'x'.repeat(2 * 1024 * 1024)}`;
  const res = await chrome.runtime.sendMessage(
    { type: 'CHECK_SEMANTIC_AD', payload: { text: oversized } }, contentScriptSender());

  assert.equal(res.isAd, false, 'an oversized text is refused, not scanned');
  assert.equal(res.error, undefined, 'and refused quietly — this is a renderer-reachable type');
  const after = hooks.scriptletDiagnosticsSnapshot();
  assert.equal(after.semanticChecksAttempted, 0,
    'the text must never reach the engine call: that is where wasm-bindgen copies it into linear memory');
  assert.equal(after.semanticChecksRefused, 1, 'and the refusal must be visible in diagnostics');

  hooks.cancelPendingStatsPersistForTest();
});

test('5.4: the cap is 1024 UTF-16 units, counted the way the Rust side assumes', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const atCap = await chrome.runtime.sendMessage(
    { type: 'CHECK_SEMANTIC_AD', payload: { text: 'x'.repeat(SEMANTIC_TEXT_CAP) } },
    contentScriptSender());
  assert.equal(atCap.isAd, false);
  assert.equal(hooks.scriptletDiagnosticsSnapshot().semanticChecksAttempted, 1,
    'exactly at the cap must still be checked');

  const overCap = await chrome.runtime.sendMessage(
    { type: 'CHECK_SEMANTIC_AD', payload: { text: 'x'.repeat(SEMANTIC_TEXT_CAP + 1) } },
    contentScriptSender());
  assert.equal(overCap.isAd, false);
  assert.equal(hooks.scriptletDiagnosticsSnapshot().semanticChecksAttempted, 1,
    'one unit over the cap must not be');

  // UTF-16 units, not code points: the Rust cap is 4096 BYTES, and 1024 UTF-16
  // units is at most 3072 UTF-8 bytes, so nothing this forwards can be refused
  // there. A 3-byte character per unit is the worst case.
  const worstCase = '\u4e2d'.repeat(SEMANTIC_TEXT_CAP);
  assert.equal(worstCase.length, SEMANTIC_TEXT_CAP, 'one UTF-16 unit each');
  assert.equal(new TextEncoder().encode(worstCase).length, 3 * SEMANTIC_TEXT_CAP,
    'three UTF-8 bytes each — the worst case the Rust 4096-byte cap must still accept');
  const cjk = await chrome.runtime.sendMessage(
    { type: 'CHECK_SEMANTIC_AD', payload: { text: worstCase } }, contentScriptSender());
  assert.equal(cjk.isAd, false);
  assert.equal(hooks.scriptletDiagnosticsSnapshot().semanticChecksAttempted, 2,
    'the worst-case-byte text is still under the cap and must be forwarded');

  hooks.cancelPendingStatsPersistForTest();
});

test("5.4 (didn't re-break): a normal engine payload is still checked", async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  // What cosmetic-engine.js actually sends: at most 400 characters.
  const realistic = 'Sponsored content you might like '.repeat(12).slice(0, 400);
  assert.ok(realistic.length <= 400);
  const res = await chrome.runtime.sendMessage(
    { type: 'CHECK_SEMANTIC_AD', payload: { text: realistic } }, contentScriptSender());

  assert.equal(res.error, undefined);
  assert.equal(res.isAd, false, 'WASM is down in the harness, so the answer is the fallback');
  const snap = hooks.scriptletDiagnosticsSnapshot();
  assert.equal(snap.semanticChecksAttempted, 1, 'a legitimate payload must still reach the engine call');
  assert.equal(snap.semanticChecksRefused, 0, 'and must not be counted as refused');

  // Empty and malformed payloads stay refusals, and must not throw: this type
  // is renderer-reachable, so a missing payload must not become an error log.
  for (const payload of [{}, { text: '' }, { text: 42 }, undefined]) {
    const bad = await chrome.runtime.sendMessage({ type: 'CHECK_SEMANTIC_AD', payload }, contentScriptSender());
    assert.deepEqual(bad, { isAd: false }, `payload ${JSON.stringify(payload)} must be a quiet false`);
  }

  hooks.cancelPendingStatsPersistForTest();
});
