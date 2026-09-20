/**
 * Regression tests for REVIEW-2026-09 §5.2 (REMEDIATION A2c) — the privacy DNR
 * rules and the rule-data pass on every cold start.
 *
 * Dynamic rules persist across service-worker lives, but `applyPrivacySettings`
 * rewrote all six of its rule groups on every start: six `updateDynamicRules`
 * calls per wake whatever the settings say, on a profile where nothing had
 * changed since the last one. Under the flag `privacyRulesDiff` the six writers
 * state their desired rules, one `getDynamicRules()` snapshot is taken, and
 * only the ids that actually differ are written — no call at all in steady
 * state. That snapshot is the only thing the diff can trust: when it cannot be
 * read every privacy rule is written unconditionally, because a skipped write
 * would leave a setting the user just toggled unapplied.
 *
 * Unflagged, same finding: `ensureRuleDataReady` is memoized for the worker's
 * life. `onInstalled` and the module-load `startInitialization()` both call it
 * and on a fresh install they interleave — both read an absent bloom filter
 * before either writes one — so the full active-index rebuild ran twice for a
 * single install.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { makeChromeStub } from './chrome-stub.mjs';
import { drainTicks, loadServiceWorker, samplePackagedSources } from './sw-loader.mjs';
import { CHROME_MAJOR_FALLBACK } from '../../src/shared/personas.js';

const FLAG_ON = { featureFlags: { privacyRulesDiff: true } };

const unexpectedCriticals = (hooks) =>
  hooks.errorReport.critical.filter((e) => e.context !== 'WASM initialization');

// The privacy band, id by id (service-worker.js DNR_*_RULES_START).
const HEADER_RULE_IDS = [800_000, 800_001];
const STEALTH_RULE_ID = 810_000;
const HTTPS_RULE_ID = 815_000;
const PERSONA_RULE_ID = 820_000;
const CACHE_RULE_ID = 830_000;
const REFERRER_RULE_ID = 840_000;
// What a default profile ends up with: header stripping, HTTPS upgrade, cache
// protection and referrer control are on unless the user turns them off; the
// stealth and persona rules are removed, never added.
const DEFAULT_LIVE_IDS = [...HEADER_RULE_IDS, HTTPS_RULE_ID, CACHE_RULE_ID, REFERRER_RULE_ID];
const isPrivacyId = (id) => id >= 800_000 && id < 850_000;

/** The privacy rules Chrome is actually holding, in id order. */
function privacyRuleIds(chrome) {
  return [...chrome.declarativeNetRequest._dynamic.keys()].filter(isPrivacyId).sort((a, b) => a - b);
}

/**
 * Log every dynamic-rule call with the ids it carries. The chrome stub's own
 * log keeps only `addRuleCount`, and this whole finding is about *which* ids
 * move and how many calls move them — including the option keys each call
 * passes, which is what "the flag-off path is byte-for-byte today's
 * behaviour" means for a remove-only writer that passes no `addRules` at all.
 */
function probeDynamicRules(chrome) {
  const dnr = chrome.declarativeNetRequest;
  const probe = {
    writes: [],
    order: [], // 'get' | 'update', in call order
    reads: 0,
    clear() { probe.writes.length = 0; probe.order.length = 0; probe.reads = 0; },
    get privacyWrites() {
      return probe.writes.filter(
        (call) => call.remove.some(isPrivacyId) || call.add.some(isPrivacyId));
    },
  };
  const origUpdate = dnr.updateDynamicRules.bind(dnr);
  const origGet = dnr.getDynamicRules.bind(dnr);
  dnr.updateDynamicRules = async (options = {}) => {
    probe.writes.push({
      remove: [...(options.removeRuleIds || [])],
      add: (options.addRules || []).map((rule) => rule.id),
      keys: Object.keys(options).sort(),
    });
    probe.order.push('update');
    return origUpdate(options);
  };
  dnr.getDynamicRules = async () => {
    probe.reads++;
    probe.order.push('get');
    return origGet();
  };
  return probe;
}

const idsOf = (writes) => writes.map(({ remove, add }) => ({ remove, add }));

const countStorage = (chrome, api, keyText) => chrome.calls.filter(
  (call) => call.api === api && String(call.keys).includes(keyText)).length;

// ---------------------------------------------------------------------------
// §5.2 — the privacy-rule diff (flag `privacyRulesDiff`)
// ---------------------------------------------------------------------------

test('5.2: a warm start with unchanged settings issues no updateDynamicRules', async () => {
  const stub = makeChromeStub();
  const first = await loadServiceWorker({ stub, seed: FLAG_ON, awaitReady: true });
  first.hooks.cancelPendingStatsPersistForTest();

  assert.deepEqual(privacyRuleIds(stub), DEFAULT_LIVE_IDS,
    'precondition: the first life wrote the default privacy set');

  // The next wake: a new worker on the same profile. Dynamic rules survive a
  // worker death, so a steady-state wake has nothing to apply.
  const probe = probeDynamicRules(stub);
  const second = await loadServiceWorker({ stub, idb: first.idb, seed: FLAG_ON, awaitReady: true });
  second.hooks.cancelPendingStatsPersistForTest();

  assert.deepEqual(idsOf(probe.privacyWrites), [],
    'a wake that finds every privacy rule already correct must not write one');
  assert.equal(probe.reads, 2,
    'the diff costs one snapshot per start for the whole band (the other read is the allowlist reconcile), not one per rule group');
  assert.deepEqual(privacyRuleIds(stub), DEFAULT_LIVE_IDS, 'and the rules are still in place');
  assert.equal(second.hooks.isFeatureEnabled('privacyRulesDiff'), true, 'the seeded flag must be read');
});

test('5.2: only the rules that actually changed are written', async () => {
  const { chrome, hooks } = await loadServiceWorker({ seed: FLAG_ON, awaitReady: true });
  const probe = probeDynamicRules(chrome);

  // A settings write that changes nothing the privacy rules depend on.
  await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', payload: { showBadge: true } });
  assert.deepEqual(idsOf(probe.privacyWrites), [],
    'an unchanged settings write must not touch DNR');
  assert.deepEqual(probe.order, ['get'], 'one snapshot, no write');

  // One real change: only the persona rule may move, and it is added because
  // Chrome does not hold it yet (no removal needed, nothing else re-sent).
  probe.clear();
  await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', payload: { stealthPersona: 'windows' } });
  assert.deepEqual(idsOf(probe.privacyWrites), [{ remove: [], add: [PERSONA_RULE_ID] }],
    'a persona change writes the persona rule and nothing else');
  assert.deepEqual(privacyRuleIds(chrome), [...HEADER_RULE_IDS, HTTPS_RULE_ID, PERSONA_RULE_ID, CACHE_RULE_ID, REFERRER_RULE_ID].sort((a, b) => a - b));

  // Re-applying the same persona is free; switching it rewrites that one id.
  probe.clear();
  await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', payload: { stealthPersona: 'windows' } });
  assert.deepEqual(idsOf(probe.privacyWrites), [], 'the same persona again is not a change');

  probe.clear();
  await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', payload: { stealthPersona: 'mac' } });
  assert.deepEqual(idsOf(probe.privacyWrites), [{ remove: [PERSONA_RULE_ID], add: [PERSONA_RULE_ID] }],
    'a different persona is a different rule body: remove then add, same call');
  assert.match(chrome.declarativeNetRequest._dynamic.get(PERSONA_RULE_ID).action.requestHeaders[0].value,
    /Macintosh/, 'and the rule Chrome holds is the new one');

  // Turning the persona off removes the rule and adds nothing.
  probe.clear();
  await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', payload: { stealthPersona: 'default' } });
  assert.deepEqual(idsOf(probe.privacyWrites), [{ remove: [PERSONA_RULE_ID], add: [] }]);
  assert.deepEqual(privacyRuleIds(chrome), DEFAULT_LIVE_IDS);

  hooks.cancelPendingStatsPersistForTest();
});

test('5.2: an unreadable getDynamicRules snapshot writes every privacy rule', async () => {
  const { chrome, hooks } = await loadServiceWorker({ seed: FLAG_ON, awaitReady: true });
  const dnr = chrome.declarativeNetRequest;
  const probe = probeDynamicRules(chrome);

  // Only the diff's own snapshot fails — the next read goes through.
  const readThrough = dnr.getDynamicRules;
  let snapshotFailed = false;
  dnr.getDynamicRules = async () => {
    snapshotFailed = true;
    dnr.getDynamicRules = readThrough;
    throw new Error('snapshot unavailable');
  };

  await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', payload: { stealthPersona: 'windows' } });

  assert.equal(snapshotFailed, true,
    'the fault must have landed on the diff snapshot, or this test exercised nothing');
  assert.deepEqual(idsOf(probe.privacyWrites), [{
    // Writer order: header, upgrade-scheme, stealth, persona, cache, referrer.
    remove: [...HEADER_RULE_IDS, HTTPS_RULE_ID, STEALTH_RULE_ID, PERSONA_RULE_ID, CACHE_RULE_ID, REFERRER_RULE_ID],
    add: [...HEADER_RULE_IDS, HTTPS_RULE_ID, PERSONA_RULE_ID, CACHE_RULE_ID, REFERRER_RULE_ID],
  }], 'never skip a write: with no snapshot every privacy rule is written, as before the flag');
  assert.deepEqual(privacyRuleIds(chrome),
    [...HEADER_RULE_IDS, HTTPS_RULE_ID, PERSONA_RULE_ID, CACHE_RULE_ID, REFERRER_RULE_ID].sort((a, b) => a - b),
    'the toggled setting must land even though the snapshot could not be read');

  hooks.cancelPendingStatsPersistForTest();
});

for (const [mode, seed] of [['flag off', {}], ['flag on', FLAG_ON]]) {
  test(`5.2 (didn't re-break): toggling stripTrackingHeaders removes exactly 800000/800001 (${mode})`, async () => {
    const { chrome, hooks } = await loadServiceWorker({ seed, awaitReady: true });
    assert.deepEqual(privacyRuleIds(chrome), DEFAULT_LIVE_IDS,
      'precondition: header stripping is on by default');

    const off = await chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS', payload: { stripTrackingHeaders: false },
    });
    assert.equal(off.ok, true);
    assert.deepEqual(privacyRuleIds(chrome), [HTTPS_RULE_ID, CACHE_RULE_ID, REFERRER_RULE_ID],
      'exactly the two header rules go, and no other privacy rule with them');

    const on = await chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS', payload: { stripTrackingHeaders: true },
    });
    assert.equal(on.ok, true);
    assert.deepEqual(privacyRuleIds(chrome), DEFAULT_LIVE_IDS, 'and they come back');
    assert.equal(
      chrome.declarativeNetRequest._dynamic.get(HEADER_RULE_IDS[0]).action.requestHeaders[0].header,
      'referer', 'the rule that came back is the referer stripper, not a stale body');

    hooks.cancelPendingStatsPersistForTest();
  });
}

test('5.2 (flag off): behaviour is unchanged', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });
  assert.equal(hooks.FEATURE_DEFAULTS.privacyRulesDiff, false,
    'default OFF in the release that introduces it');
  assert.equal(hooks.isFeatureEnabled('privacyRulesDiff'), false);

  const probe = probeDynamicRules(chrome);
  await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', payload: {} });

  assert.deepEqual(probe.writes, [
    { remove: HEADER_RULE_IDS, add: HEADER_RULE_IDS, keys: ['addRules', 'removeRuleIds'] },
    { remove: [HTTPS_RULE_ID], add: [HTTPS_RULE_ID], keys: ['addRules', 'removeRuleIds'] },
    { remove: [STEALTH_RULE_ID], add: [], keys: ['removeRuleIds'] },
    { remove: [PERSONA_RULE_ID], add: [], keys: ['removeRuleIds'] },
    { remove: [CACHE_RULE_ID], add: [CACHE_RULE_ID], keys: ['addRules', 'removeRuleIds'] },
    { remove: [REFERRER_RULE_ID], add: [REFERRER_RULE_ID], keys: ['addRules', 'removeRuleIds'] },
  ], 'six unconditional writes, in writer order, passing the same option keys as before');
  assert.equal(probe.reads, 0, 'and no snapshot read: with the flag off the writes are unconditional');
  assert.deepEqual(privacyRuleIds(chrome), DEFAULT_LIVE_IDS);

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §5.2 — one rule-data pass per worker life (unflagged: it only removes a
// duplicate call)
// ---------------------------------------------------------------------------

test('5.2: a fresh install writes the index-building marker once', async () => {
  // No `awaitReady`: startInitialization() is mid-flight (stage 0, awaiting
  // the WASM asset) when Chrome delivers onInstalled, which is exactly how the
  // two boot paths overlap on a real install.
  const { chrome, hooks } = await loadServiceWorker({ packagedSources: samplePackagedSources() });
  await chrome.runtime.onInstalled._fireAsync({ reason: 'install' });
  await hooks.whenCriticalReady();
  await hooks.whenBackgroundSetupDone();
  hooks.cancelPendingStatsPersistForTest();

  const building = chrome.calls.filter((call) => call.api === 'storage.set'
    && call.entries?.[hooks.RULE_INDEX_STATE_KEY]?.state === 'building');
  assert.equal(building.length, 1,
    `one install must rebuild the active index once; the building marker was written ${building.length}×`);
  assert.equal(countStorage(chrome, 'storage.get', 'ruleDataVersion'), 1,
    'and the rule-data pass behind it must run once, not once per boot path');

  // Deduplicating the pass must not leave the index half-built.
  assert.deepEqual(await hooks.db.getCosmeticRules('example.com'), ['.site-ad'],
    'the one rebuild is a complete rebuild');
  assert.equal(await hooks.isRuleIndexInterrupted(), false, 'and it cleared its marker');
});

test("5.2 (didn't re-break): a rejected rule-data pass is not memoized", async () => {
  // Hold the worker at stage 0 so the fault is armed before the FIRST pass —
  // memoizing a failure would otherwise pin a worker with no rule index for
  // its whole life.
  const { chrome, hooks, releaseCold } = await loadServiceWorker({
    cold: true, packagedSources: samplePackagedSources(),
  });
  let faultFired = false;
  hooks.db.hasFilterSources = async () => {
    faultFired = true;
    delete hooks.db.hasFilterSources;
    throw new Error('rule-data pass failed');
  };

  releaseCold();
  await hooks.whenCriticalReady();
  hooks.cancelPendingStatsPersistForTest();
  assert.equal(faultFired, true, 'the fault must have reached the first pass');
  assert.ok(hooks.errorReport.critical.some((entry) => entry.context === 'Critical startup'),
    'precondition: the rejected pass is the one that failed this boot');

  const afterFailure = countStorage(chrome, 'storage.get', 'ruleDataVersion');
  await hooks.ensureRuleDataReady();
  assert.ok(countStorage(chrome, 'storage.get', 'ruleDataVersion') > afterFailure,
    'a rejected pass must be retried by the next caller, not cached as the answer');
  assert.deepEqual(await hooks.db.getCosmeticRules('example.com'), ['.site-ad'],
    'and the retry is a real pass: it built the index the failed one never reached');

  // That retry is the only re-run — the memo holds again once a pass resolved.
  const afterRetry = countStorage(chrome, 'storage.get', 'ruleDataVersion');
  await hooks.ensureRuleDataReady();
  assert.equal(countStorage(chrome, 'storage.get', 'ruleDataVersion'), afterRetry,
    'a later caller in the same worker life reuses the pass that succeeded');
});

// ---------------------------------------------------------------------------
// §7.9 — applyPrivacySettings was not serialized either, and it is reachable
// from ensureBackgroundSetup and from UPDATE_SETTINGS. Two settings writes in
// flight at once (popup and options, or two quick toggles) let the second run
// take its getDynamicRules() snapshot before the first run's write lands: its
// diff comes out empty, it issues nothing, and the first run's older intent is
// final. Measured on the persona rule, the worst of the six — the options page
// says the persona is off while DNR keeps spoofing a Windows Chrome UA on
// every request for the rest of that worker's life. The flag-off path has the
// weaker ordering-dependent version of the same bug.
// ---------------------------------------------------------------------------

for (const [mode, seed] of [['flag off', {}], ['flag on', FLAG_ON]]) {
  test(`7.9: two concurrent settings writes leave DNR agreeing with the last one (${mode})`, async () => {
    const { chrome, hooks } = await loadServiceWorker({ seed, awaitReady: true });
    const dnr = chrome.declarativeNetRequest;
    assert.equal(dnr._dynamic.has(PERSONA_RULE_ID), false, 'precondition: no persona rule yet');

    // Hold the first write that touches the persona rule, so the second run
    // decides while it is outstanding. Released unconditionally below, so a
    // serialized applier (which parks the second run before it writes) cannot
    // deadlock this test.
    let releaseFirstWrite;
    const firstWriteGate = new Promise((resolve) => { releaseFirstWrite = resolve; });
    let firstWriteHeld = false;
    const origUpdate = dnr.updateDynamicRules.bind(dnr);
    dnr.updateDynamicRules = async (options = {}) => {
      const touchesPersona = (options.removeRuleIds || []).includes(PERSONA_RULE_ID)
        || (options.addRules || []).some((rule) => rule.id === PERSONA_RULE_ID);
      if (touchesPersona && !firstWriteHeld) {
        firstWriteHeld = true;
        await firstWriteGate;
      }
      return origUpdate(options);
    };

    const on = chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS', payload: { stealthPersona: 'windows' },
    });
    await drainTicks(5);
    const off = chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS', payload: { stealthPersona: 'default' },
    });
    await drainTicks(5);
    releaseFirstWrite();
    const [onRes, offRes] = await Promise.all([on, off]);
    await drainTicks(5);

    assert.equal(onRes.ok, true);
    assert.equal(offRes.ok, true);
    assert.equal(firstWriteHeld, true,
      'the first apply must have reached its persona write, or this test exercised nothing');
    assert.equal(chrome.storage.local._data().settings.stealthPersona, 'default',
      'precondition: storage holds the last write the user made');
    assert.equal(dnr._dynamic.has(PERSONA_RULE_ID), false,
      'a persona the user switched off must not keep spoofing the UA for the rest of the worker life');

    hooks.cancelPendingStatsPersistForTest();
  });
}

// ---------------------------------------------------------------------------
// §7.9 — UPDATE_SETTINGS is a partial merge by design (§5.33 removed the
// whole-object writer precisely so two UI surfaces could not clobber each
// other), but the merge itself was a read-modify-write outside any lock, so
// two writes of DIFFERENT keys at once lost one of them: `stealthPersona`
// came back `undefined` — the choice discarded outright, with no error.
// ---------------------------------------------------------------------------

for (const [mode, seed] of [['flag off', {}], ['flag on', FLAG_ON]]) {
  test(`7.9: two settings keys written at once both survive (${mode})`, async () => {
    const { chrome, hooks } = await loadServiceWorker({ seed, awaitReady: true });

    const [resA, resB] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', payload: { stealthPersona: 'windows' } }),
      chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', payload: { cacheProtection: false } }),
    ]);

    assert.equal(resA.ok, true);
    assert.equal(resB.ok, true);
    const stored = chrome.storage.local._data().settings;
    assert.deepEqual([stored.stealthPersona, stored.cacheProtection], ['windows', false],
      `both writes must survive the read-modify-write, got: ${JSON.stringify(stored)}`);
    // And DNR agrees with the settled settings, not with either half of them.
    assert.equal(chrome.declarativeNetRequest._dynamic.has(PERSONA_RULE_ID), true,
      'the persona the user chose must be live');
    assert.equal(chrome.declarativeNetRequest._dynamic.has(CACHE_RULE_ID), false,
      'and the cache rule the user turned off must be gone');
    assert.equal(stored.enabled, true, 'untouched keys must survive both merges');

    hooks.cancelPendingStatsPersistForTest();
  });
}

// ---------------------------------------------------------------------------
// REVIEW-2026-09 §5.9 (A2e) — the persona table was a literal frozen at Chrome
// 122. A `user-agent` and `sec-ch-ua` claiming a two-year-old Chrome is a
// beacon rather than camouflage, and some sites gate on the major. The table
// now comes from src/shared/personas.js, built from the running browser's
// major, and is spelled in that one module for both this surface and the
// MAIN-world persona-spoof scriptlet.
// ---------------------------------------------------------------------------

/**
 * Stub the running browser's major. 151 on purpose: it is neither the old
 * literal (122) nor CHROME_MAJOR_FALLBACK (140), so an assertion on it cannot
 * be satisfied by a reverted table or by detection that has stopped working.
 */
function stubNavigator(value) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  return () => {
    if (had) Object.defineProperty(globalThis, 'navigator', had);
    else delete globalThis.navigator;
  };
}

const navigatorWithMajor = (major) => ({
  userAgentData: { brands: [{ brand: 'Google Chrome', version: String(major) }] },
  userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
});

const personaHeaders = (chrome) => Object.fromEntries(
  chrome.declarativeNetRequest._dynamic.get(PERSONA_RULE_ID)
    .action.requestHeaders.map((h) => [h.header, h.value]));

const setPersona = (chrome, stealthPersona) => chrome.runtime.sendMessage(
  { type: 'UPDATE_SETTINGS', payload: { stealthPersona } });

test('5.9: persona UA strings carry the running major, not a literal', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });
  const restore = stubNavigator(navigatorWithMajor(151));
  try {
    await setPersona(chrome, 'windows');
    const headers = personaHeaders(chrome);

    assert.match(headers['user-agent'], /Chrome\/151\.0\.0\.0 /,
      'the UA must claim the browser the user is actually running');
    assert.doesNotMatch(headers['user-agent'], /Chrome\/122/,
      'and never the literal the table was frozen at');
    assert.equal(headers['sec-ch-ua'],
      '"Chromium";v="151", "Not(A:Brand";v="24", "Google Chrome";v="151"',
      'the client hint has to tell the same story as the UA, or the pair is the beacon');
    assert.equal(headers['sec-ch-ua-platform'], '"Windows"',
      'the persona still claims its operating system');
    assert.match(headers['user-agent'], /Windows NT 10\.0; Win64; x64/);
  } finally {
    restore();
  }
  hooks.cancelPendingStatsPersistForTest();
});

test('5.9: the major is read when the rule is built, not when the worker loads', async () => {
  // Track F's seam note: building the table at module scope would freeze the
  // major at worker-evaluation time and force every consumer to stub
  // `navigator` before import. A browser update mid-worker-life must be picked
  // up by the next apply.
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });
  const restore = stubNavigator(navigatorWithMajor(151));
  try {
    await setPersona(chrome, 'mac');
    assert.match(personaHeaders(chrome)['user-agent'], /Chrome\/151\.0\.0\.0 /);

    // The browser updates under a worker that is already running.
    Object.defineProperty(globalThis, 'navigator', {
      value: navigatorWithMajor(152), configurable: true, writable: true,
    });
    await setPersona(chrome, 'default');
    await setPersona(chrome, 'mac');
    assert.match(personaHeaders(chrome)['user-agent'], /Chrome\/152\.0\.0\.0 /,
      'the next apply must carry the new major');
    assert.match(personaHeaders(chrome)['user-agent'], /Macintosh; Intel Mac OS X 10_15_7/);
  } finally {
    restore();
  }
  hooks.cancelPendingStatsPersistForTest();
});

test('5.9 (didn\'t re-break): an unreadable navigator still yields a usable persona', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });
  // A navigator whose every read throws — the worker evaluates detection at
  // apply time, where a throw would take the whole privacy apply down.
  const hostile = { get userAgentData() { throw new Error('nope'); }, get userAgent() { throw new Error('nope'); } };
  const restore = stubNavigator(hostile);
  try {
    await setPersona(chrome, 'linux');
    const headers = personaHeaders(chrome);
    assert.match(headers['user-agent'], new RegExp(`Chrome/${CHROME_MAJOR_FALLBACK}\\.0\\.0\\.0 `),
      'the documented fallback major, not a crash and not an empty rule');
    assert.equal(headers['sec-ch-ua-platform'], '"Linux"');
    assert.deepEqual(unexpectedCriticals(hooks), [], 'and no fatal error from the apply');
  } finally {
    restore();
  }
  hooks.cancelPendingStatsPersistForTest();
});

test('5.9 (didn\'t re-break): default and unknown personas still remove the rule', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });
  const restore = stubNavigator(navigatorWithMajor(151));
  try {
    await setPersona(chrome, 'windows');
    assert.equal(chrome.declarativeNetRequest._dynamic.has(PERSONA_RULE_ID), true);

    await setPersona(chrome, 'default');
    assert.equal(chrome.declarativeNetRequest._dynamic.has(PERSONA_RULE_ID), false,
      '"default" means no persona rule at all');

    await setPersona(chrome, 'windows');
    await setPersona(chrome, 'not-a-persona');
    assert.equal(chrome.declarativeNetRequest._dynamic.has(PERSONA_RULE_ID), false,
      'an id with no persona must remove the rule, never ship a half-built one');
  } finally {
    restore();
  }
  hooks.cancelPendingStatsPersistForTest();
});
