/**
 * Regression tests for REVIEW-2026-07:
 *  §5.3 — active-index rebuilds had no mutual exclusion, and a page-bundle
 *         persist landing after the rebuild's clearPageBundles() poisoned
 *         that hostname's persisted cache indefinitely (the version check
 *         accepts it because remote-list refreshes don't bump the version).
 *  §5.7 — drifted duplicate tables: dead CONFIG entries, shadow consts, and
 *         applyRulesets' re-declared list-id literal.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { makeChromeStub } from './chrome-stub.mjs';
import { drainTicks, loadServiceWorker, samplePackagedSources, waitFor } from './sw-loader.mjs';

const SW_PATH = new URL('../../src/background/service-worker.js', import.meta.url);

test('5.3: a bundle computed during a rebuild is never persisted', async () => {
  const { hooks } = await loadServiceWorker({ awaitReady: true });
  const db = hooks.db;

  // Gate the rebuild open at its first IndexedDB read so it stays in flight
  // while the lookup below runs to completion.
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const origGetAllFilterSources = db.getAllFilterSources.bind(db);
  db.getAllFilterSources = async () => {
    await gate;
    return origGetAllFilterSources();
  };

  const rebuildPromise = hooks.queueActiveIndexRebuild();
  assert.equal(hooks.isActiveIndexRebuildInFlight(), true,
    'the in-flight flag must be up from the moment the rebuild is queued');

  // If the (pre-fix) code still tries to persist the bundle, delay that write
  // until the rebuild has fully finished — the exact interleaving where the
  // stale record lands after clearPageBundles() and survives.
  const origPutPageBundle = db.putPageBundle.bind(db);
  db.putPageBundle = async (...args) => {
    releaseGate();
    await rebuildPromise;
    return origPutPageBundle(...args);
  };

  const lookupPromise = hooks.getCosmeticBundleForPage('racehost.example');
  // New code path: the lookup finishes without persisting; then let the
  // rebuild proceed.
  lookupPromise.then(() => releaseGate());

  await rebuildPromise;
  await lookupPromise;

  db.putPageBundle = origPutPageBundle;
  db.getAllFilterSources = origGetAllFilterSources;

  assert.equal(hooks.isActiveIndexRebuildInFlight(), false);
  const persisted = await db.getPageBundle('racehost.example', hooks.getActiveRuleDataVersion());
  assert.equal(persisted, null,
    'no page bundle may be persisted for a lookup that raced a rebuild');

  hooks.cancelPendingStatsPersistForTest();
});

test('5.3: queued rebuilds are serialized through one chain', async () => {
  const { hooks } = await loadServiceWorker({ awaitReady: true });
  const db = hooks.db;

  let active = 0;
  let maxActive = 0;
  const origClearActiveRules = db.clearActiveRules.bind(db);
  db.clearActiveRules = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    // Yield so an unserialized second rebuild would overlap here.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await origClearActiveRules();
    active--;
    return result;
  };

  await Promise.all([hooks.queueActiveIndexRebuild(), hooks.queueActiveIndexRebuild()]);
  db.clearActiveRules = origClearActiveRules;

  assert.equal(maxActive, 1, 'rebuilds must never overlap');
  assert.equal(hooks.isActiveIndexRebuildInFlight(), false);

  hooks.cancelPendingStatsPersistForTest();
});

test('5.7: duplicate tables are gone — one source of truth per tunable', async () => {
  const source = await readFile(SW_PATH, 'utf8');

  // Dead CONFIG entries removed.
  assert.ok(!source.includes('PROCEDURAL_DEBOUNCE_MS'),
    'CONFIG.PROCEDURAL_DEBOUNCE_MS had no consumer and must be removed');
  assert.ok(!source.includes('CACHE_SWEEP_INTERVAL_MS'),
    'CONFIG.CACHE_SWEEP_INTERVAL_MS had no consumer and must be removed');

  // Shadow consts removed — the live values are the CONFIG entries.
  assert.ok(!/const\s+DOMAIN_RULES_CACHE_MAX\s*=/.test(source),
    'DOMAIN_RULES_CACHE_MAX must live only in CONFIG');
  assert.ok(!/const\s+PAGE_BUNDLE_DB_MAX\s*=/.test(source),
    'PAGE_BUNDLE_DB_MAX must live only in CONFIG');

  // applyRulesets derives from ALL_KNOWN_LIST_IDS instead of re-declaring
  // the list literal.
  assert.ok(!source.includes('allKnownListIds'),
    'applyRulesets must not re-declare the known list ids');
  assert.ok(source.includes('for (const listId of ALL_KNOWN_LIST_IDS)'),
    'applyRulesets must iterate ALL_KNOWN_LIST_IDS');
});

test('5.7: applyRulesets enables every list in ALL_KNOWN_LIST_IDS by default', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const effective = await hooks.applyRulesets();
  for (const listId of hooks.ALL_KNOWN_LIST_IDS) {
    assert.notEqual(effective[listId], undefined, `missing list ${listId}`);
    assert.equal(effective[listId], true, `list ${listId} should be enabled by default`);
  }
  // The DNR stub actually saw the enable calls for the grouped shards.
  assert.ok(chrome.declarativeNetRequest._staticEnabled.has('easylist_2'));

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// REVIEW-2026-09 §3.2 — the JS CSS gate (WASM-down path) must refuse what the
// browser refuses. The SW kept its own hand-copied operator list; `others` was
// missing, so `div:others(.x)` passed `isSafeCssSelector` as "CSS" and was
// emitted. The Rust gate (B1) now refuses any single-colon functional
// pseudo-class a browser does not implement and any `::name` that is only a
// prefix of a known pseudo-element; the SW mirrors both, and reads the one
// shared operator list from src/shared/proc-ops.js (C1a).
//
// WASM never initialises in the harness (fetch is cut), so `buildPageBundle`
// takes the JS path here by construction.
// ---------------------------------------------------------------------------

function cssSelectorsOf(bundle) {
  return bundle.cssText.split('\n').filter(Boolean).map((line) => line.replace(/\s*\{.*$/, ''));
}

test('3.2: the JS CSS gate refuses unknown functional pseudo-classes', async () => {
  const { hooks } = await loadServiceWorker({ awaitReady: true });

  const bundle = hooks.buildPageBundle({
    domainSpecific: ['.good', 'div:others(.x)', 'div:bogus(1)', 'div::before2'],
  });

  assert.deepEqual(cssSelectorsOf(bundle), ['.good'],
    `only .good may reach the page as CSS; got ${JSON.stringify(bundle.cssText)}`);
  for (const refused of ['div:others(.x)', 'div:bogus(1)', 'div::before2']) {
    assert.ok(!bundle.cssText.includes(refused), `${refused} must not be emitted as CSS`);
  }
  // `others` is a uBO operator: it is planned, not dropped.
  assert.deepEqual(bundle.rules.domainSpecific.map((rule) => rule.selector), ['div:others(.x)']);

  hooks.cancelPendingStatsPersistForTest();
});

test('3.2 (didn\'t re-break): native functional pseudo-classes still pass, one rule per selector', async () => {
  const { hooks } = await loadServiceWorker({ awaitReady: true });

  const natives = ['div:has(.x)', 'div:not(:is(.a,.b))', 'li:nth-child(2n+1)', 'p:lang(en)', 'div:NOT(.y)', 'div::BEFORE', 'span::part(x)'];
  const bundle = hooks.buildPageBundle({ domainSpecific: natives });

  assert.deepEqual(cssSelectorsOf(bundle), natives,
    'every native selector must pass the gate, case-insensitively, and each must be its own rule');
  assert.equal(bundle.cssText.split('\n').length, natives.length, 'the JS fallback emits one rule per selector');
  assert.deepEqual(bundle.rules.domainSpecific, []);

  hooks.cancelPendingStatsPersistForTest();
});

test('3.2: the JS planner tokenises the shared operator names case-insensitively and canonicalises aliases', async () => {
  const { hooks } = await loadServiceWorker({ awaitReady: true });

  const bundle = hooks.buildPageBundle({
    domainSpecific: ['div:-abp-has(.x)', 'DIV:Has-Text(ad)', 'div:-abp-contains(promo)', 'div:remove-class(ad)'],
  });

  assert.equal(bundle.cssText, '', 'none of these is CSS');
  const ops = bundle.rules.domainSpecific.map((rule) => rule.plan.filter((step) => step.type === 'op').map((step) => step.op));
  assert.deepEqual(ops, [['has'], ['has-text'], ['has-text'], ['remove-class']],
    'every plan step must carry the canonical uBO name the engine implements');

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// REVIEW-2026-09 §3.2 / A1c — release-1 migration. The rebuild decision and
// every persisted page bundle are keyed on computeBundledRuleDataVersion(), a
// hash of RULE_DATA_SCHEMA_VERSION + the vendored snapshots. When a release
// ships the same snapshots but a fixed compiler, the hash is unchanged and
// every cached cssText still carries what the pre-fix engines emitted. Bumping
// the schema number forces exactly one rebuild on the first start after the
// update and invalidates every persisted bundle.
// ---------------------------------------------------------------------------

test('3.2: a schema bump rebuilds the index on an unchanged packaged bundle', async () => {
  const first = await loadServiceWorker({ awaitReady: true, packagedSources: samplePackagedSources() });
  first.hooks.cancelPendingStatsPersistForTest();

  const stampAfterFirst = first.chrome.storage.local._data().ruleDataVersion;
  assert.match(stampAfterFirst, /^rv\d+-[0-9a-f]+$/, 'precondition: the first boot stamped the rule-data version');
  assert.equal(stampAfterFirst, `rv${first.hooks.RULE_DATA_SCHEMA_VERSION}-${stampAfterFirst.split('-')[1]}`,
    'the stamp carries the module schema number');

  // Cache a page bundle under the current stamp, as a navigation would.
  await first.hooks.getCosmeticBundleForPage('example.com');
  const activeVersion = first.hooks.getActiveRuleDataVersion();
  assert.ok(await first.hooks.db.getPageBundle('example.com', activeVersion),
    'precondition: a bundle was persisted under the current version');

  // The release-0 profile: same snapshot hash, the previous schema number (3).
  const releaseZeroStamp = stampAfterFirst.replace(/^rv\d+-/, 'rv3-');
  await first.chrome.storage.local.set({ ruleDataVersion: releaseZeroStamp });

  let rebuilds = 0;
  const second = await loadServiceWorker({
    stub: first.chrome,
    idb: first.idb,
    packagedSources: samplePackagedSources(),
  });
  const origClear = second.hooks.db.clearActiveRules.bind(second.hooks.db);
  second.hooks.db.clearActiveRules = async () => { rebuilds++; return origClear(); };
  await second.hooks.whenCriticalReady();
  await second.hooks.whenBackgroundSetupDone();
  second.hooks.cancelPendingStatsPersistForTest();

  assert.equal(rebuilds, 1,
    'the first start after the update must rebuild exactly once — the old schema number left the hash unchanged');
  assert.equal(await second.hooks.db.getPageBundle('example.com', releaseZeroStamp), null,
    'every bundle persisted under the release-0 stamp is invalidated');
  assert.equal(second.chrome.storage.local._data().ruleDataVersion, stampAfterFirst,
    'the rebuild re-stamps with the current schema number');
  assert.deepEqual(await second.hooks.db.getCosmeticRules('example.com'), ['.site-ad'],
    'the rebuilt index is complete');
});

// ---------------------------------------------------------------------------
// REVIEW-2026-09 §5.1 / A2b — flag `rulesetDeltaApply`. applyRulesets re-sent
// every static ruleset on every SW start, and when that batch failed (the
// shared static pool stays short for as long as another DNR extension holds
// it) the sequential fallback began by disabling ALL of them — system-unbreak
// included — before re-enabling one at a time: a window of zero network
// blocking on every wake. Under the flag only the difference against
// getEnabledRulesets() is applied: nothing on a steady-state wake, and the
// fallback disables only what the user turned off.
//
// `probeRulesetCalls` is the §5.1 repro stub. It logs every
// updateEnabledRulesets call — including the ones Chrome refuses, which the
// chrome stub's own call log never sees — next to the enabled set as it stood
// when the call was made, and refuses a call the way Chrome does: nothing is
// applied.
// ---------------------------------------------------------------------------

const DELTA_ON = { featureFlags: { rulesetDeltaApply: true } };
const RULE_LIMIT = 'The set of enabled rulesets exceeds the rule count limit.';

// The 16 static rulesets as applyRulesets derives them (ALL_KNOWN_LIST_IDS
// expanded through RULESET_GROUPS), and in RULESET_ENABLE_PRIORITY order.
const RULESETS_IN_LIST_ORDER = [
  'system-unbreak',
  'easylist', 'easylist_2', 'easylist_3', 'easylist_4',
  'easyprivacy', 'easyprivacy_2', 'easyprivacy_3',
  'ubo-filters', 'ubo-filters_2',
  'ubo-unbreak', 'annoyances', 'malware', 'anti-adblock',
  'ubo-cookie-annoyances', 'ubo-quick-fixes',
];
const RULESETS_IN_PRIORITY_ORDER = [
  'system-unbreak', 'ubo-unbreak', 'ubo-quick-fixes',
  'easylist', 'easylist_2', 'easylist_3', 'easylist_4',
  'malware', 'ubo-filters', 'anti-adblock', 'annoyances',
  'ubo-cookie-annoyances', 'ubo-filters_2',
  'easyprivacy', 'easyprivacy_2', 'easyprivacy_3',
];
// "The pool is short": these shards did not fit and still do not.
const UNFIT = ['easyprivacy', 'easyprivacy_2', 'easyprivacy_3'];
const refuseUnfit = (call) => (call.enable.some((id) => UNFIT.includes(id)) ? RULE_LIMIT : null);

function probeRulesetCalls(chrome) {
  const dnr = chrome.declarativeNetRequest;
  const probe = {
    updates: [], // {enable, disable, enabledAtCall}
    order: [],   // 'get' | 'update', in call order
    refuse: () => null,
    clear() { probe.updates.length = 0; probe.order.length = 0; },
  };
  const origUpdate = dnr.updateEnabledRulesets.bind(dnr);
  const origGet = dnr.getEnabledRulesets.bind(dnr);
  dnr.updateEnabledRulesets = async (options = {}) => {
    const call = {
      enable: [...(options.enableRulesetIds || [])],
      disable: [...(options.disableRulesetIds || [])],
      enabledAtCall: [...dnr._staticEnabled],
    };
    probe.updates.push(call);
    probe.order.push('update');
    const reason = probe.refuse(call);
    if (reason) throw new Error(reason);
    return origUpdate(options);
  };
  dnr.getEnabledRulesets = async () => {
    probe.order.push('get');
    return origGet();
  };
  return probe;
}

const shapeOf = (updates) => updates.map(({ enable, disable }) => ({ enable, disable }));
const sorted = (ids) => [...ids].sort();

test('5.1: the sequential fallback never disables an already-enabled ruleset', async () => {
  const { chrome, hooks } = await loadServiceWorker({ seed: DELTA_ON, awaitReady: true });
  const dnr = chrome.declarativeNetRequest;

  for (const id of UNFIT) dnr._staticEnabled.delete(id);
  const enabledBefore = [...dnr._staticEnabled];
  assert.equal(enabledBefore.length, RULESETS_IN_LIST_ORDER.length - UNFIT.length,
    'precondition: every other ruleset is enabled');

  const probe = probeRulesetCalls(chrome);
  probe.refuse = refuseUnfit;
  await hooks.applyRulesets();

  assert.deepEqual(probe.updates.flatMap((call) => call.disable), [],
    'every list is wanted, so no call may disable anything — least of all a ruleset that is already enabled');
  for (const call of probe.updates) {
    assert.deepEqual(enabledBefore.filter((id) => !call.enabledAtCall.includes(id)), [],
      'there must be no moment at which an already-enabled ruleset is off');
  }
  assert.deepEqual(shapeOf(probe.updates), [
    { enable: UNFIT, disable: [] },
    ...UNFIT.map((id) => ({ enable: [id], disable: [] })),
  ], 'the batch carries only the delta; the fallback retries only the delta, one at a time in priority order');
  assert.deepEqual(sorted(dnr._staticEnabled), sorted(enabledBefore),
    'and everything that was enabled before the fallback is enabled after it');
  assert.equal(hooks.isFeatureEnabled('rulesetDeltaApply'), true, 'the seeded flag must be read');

  hooks.cancelPendingStatsPersistForTest();
});

test('5.1: a steady-state wake issues no updateEnabledRulesets call', async () => {
  const first = await loadServiceWorker({ seed: DELTA_ON, awaitReady: true });
  first.hooks.cancelPendingStatsPersistForTest();

  // A fresh profile has nothing enabled: the delta is the whole set, once.
  const firstLife = first.chrome.calls.filter((call) => call.api === 'dnr.updateEnabledRulesets');
  assert.deepEqual(firstLife.map((call) => [call.enableRulesetIds, call.disableRulesetIds]),
    [[RULESETS_IN_LIST_ORDER, []]]);

  // The next wake: a new worker on the same profile. Enabled static rulesets
  // persist across SW lives, so there is nothing to apply.
  const probe = probeRulesetCalls(first.chrome);
  const second = await loadServiceWorker({ stub: first.chrome, idb: first.idb, awaitReady: true });
  second.hooks.cancelPendingStatsPersistForTest();

  assert.deepEqual(shapeOf(probe.updates), [],
    'a wake that finds every wanted ruleset enabled must not call updateEnabledRulesets');
  assert.equal(probe.order[0], 'get', 'the decision is made from one getEnabledRulesets snapshot');
  assert.deepEqual(sorted(first.chrome.declarativeNetRequest._staticEnabled), sorted(RULESETS_IN_LIST_ORDER));

  // Same within one life: re-applying an applied state is free.
  probe.clear();
  const effective = await second.hooks.applyRulesets();
  assert.deepEqual(shapeOf(probe.updates), []);
  for (const listId of second.hooks.ALL_KNOWN_LIST_IDS) {
    assert.equal(effective[listId], true, `list ${listId} stays enabled`);
  }
});

test('5.1: the delta disables exactly what the user turned off — ubo-unbreak included, batch and fallback', async () => {
  const { chrome, hooks } = await loadServiceWorker({ seed: DELTA_ON, awaitReady: true });
  const dnr = chrome.declarativeNetRequest;
  const probe = probeRulesetCalls(chrome);

  // The options-page toggle (SET_RULESET_ENABLED) stores the map and calls
  // applyRulesets; ubo-unbreak is one of the lists that page offers.
  await chrome.storage.local.set({ enabledRulesets: { 'ubo-unbreak': false } });
  let effective = await hooks.applyRulesets();
  assert.deepEqual(shapeOf(probe.updates), [{ enable: [], disable: ['ubo-unbreak'] }]);
  assert.equal(effective['ubo-unbreak'], false, 'the user\'s toggle must land');

  probe.clear();
  await chrome.storage.local.set({ enabledRulesets: {} });
  effective = await hooks.applyRulesets();
  assert.deepEqual(shapeOf(probe.updates), [{ enable: ['ubo-unbreak'], disable: [] }]);
  assert.equal(effective['ubo-unbreak'], true);

  // Fallback path: the pool is short AND the user turns the list off. The
  // only ruleset that may be disabled is the one the user asked for.
  for (const id of UNFIT) dnr._staticEnabled.delete(id);
  const mustStayOn = [...dnr._staticEnabled].filter((id) => id !== 'ubo-unbreak');
  probe.clear();
  probe.refuse = refuseUnfit;
  await chrome.storage.local.set({ enabledRulesets: { 'ubo-unbreak': false } });
  effective = await hooks.applyRulesets();

  assert.deepEqual(shapeOf(probe.updates), [
    { enable: UNFIT, disable: ['ubo-unbreak'] },
    { enable: [], disable: ['ubo-unbreak'] },
    ...UNFIT.map((id) => ({ enable: [id], disable: [] })),
  ]);
  for (const call of probe.updates) {
    assert.deepEqual(mustStayOn.filter((id) => !call.enabledAtCall.includes(id)), [],
      'no wanted ruleset may be off at any point of the fallback');
  }
  assert.equal(effective['ubo-unbreak'], false);
  assert.deepEqual(sorted(dnr._staticEnabled), sorted(mustStayOn));

  hooks.cancelPendingStatsPersistForTest();
});

test('5.1: an unreadable getEnabledRulesets snapshot falls back to the unconditional batch', async () => {
  const { chrome, hooks } = await loadServiceWorker({ seed: DELTA_ON, awaitReady: true });
  const dnr = chrome.declarativeNetRequest;
  const probe = probeRulesetCalls(chrome);

  // Only the first read fails — the snapshot the delta is computed from.
  const readThrough = dnr.getEnabledRulesets;
  let updatesSeenWhenReadFailed = null;
  dnr.getEnabledRulesets = async () => {
    if (updatesSeenWhenReadFailed === null) {
      updatesSeenWhenReadFailed = probe.updates.length;
      throw new Error('snapshot unavailable');
    }
    return readThrough();
  };

  await chrome.storage.local.set({ enabledRulesets: { annoyances: false } });
  const effective = await hooks.applyRulesets();

  assert.deepEqual(shapeOf(probe.updates), [{
    enable: RULESETS_IN_LIST_ORDER.filter((id) => id !== 'annoyances'),
    disable: ['annoyances'],
  }], 'never skip an apply: without a snapshot the whole wanted set is sent, as before the flag');
  assert.equal(effective.annoyances, false, 'the toggle must land even though the snapshot failed');
  assert.equal(updatesSeenWhenReadFailed, 0,
    'the read that failed must be the snapshot taken before the batch, or this test exercised nothing');

  hooks.cancelPendingStatsPersistForTest();
});

for (const [mode, seed] of [['flag off', {}], ['flag on', DELTA_ON]]) {
  test(`5.1 (didn't re-break): a missing ruleset id still does not block the others (${mode})`, async () => {
    const { chrome, hooks } = await loadServiceWorker({ seed, awaitReady: true });
    const dnr = chrome.declarativeNetRequest;

    // A fresh profile whose manifest lost one shard: Chrome rejects any call
    // naming it, so the batch fails for a reason that is not the rule limit.
    dnr._staticEnabled.clear();
    const probe = probeRulesetCalls(chrome);
    probe.refuse = (call) => (call.enable.includes('easylist_4') ? 'Invalid ruleset id: easylist_4.' : null);

    const effective = await hooks.applyRulesets();

    assert.deepEqual(sorted(dnr._staticEnabled),
      sorted(RULESETS_IN_LIST_ORDER.filter((id) => id !== 'easylist_4')),
      'every other ruleset must be enabled by the sequential fallback');
    assert.equal(effective.easylist, 'partial');
    for (const listId of hooks.ALL_KNOWN_LIST_IDS.filter((id) => id !== 'easylist')) {
      assert.equal(effective[listId], true, `list ${listId} must not be blocked by the missing shard`);
    }
    assert.deepEqual(probe.updates.filter((call) => call.enable.length === 1).map((call) => call.enable[0]),
      RULESETS_IN_PRIORITY_ORDER, 'the fallback enables one ruleset at a time, in priority order');

    hooks.cancelPendingStatsPersistForTest();
  });
}

test('5.1 (flag off): behaviour is unchanged', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });
  const dnr = chrome.declarativeNetRequest;
  assert.equal(hooks.FEATURE_DEFAULTS.rulesetDeltaApply, false, 'default OFF in the release that introduces it');
  assert.equal(hooks.isFeatureEnabled('rulesetDeltaApply'), false);

  // Every wake re-sends the whole set, with no snapshot read before it —
  // although every ruleset is already enabled by the boot.
  assert.deepEqual(sorted(dnr._staticEnabled), sorted(RULESETS_IN_LIST_ORDER),
    'precondition: the boot already enabled every ruleset');
  const probe = probeRulesetCalls(chrome);
  await hooks.applyRulesets();
  assert.deepEqual(shapeOf(probe.updates), [{ enable: RULESETS_IN_LIST_ORDER, disable: [] }]);
  assert.deepEqual(probe.order, ['update', 'get', 'get'],
    'the batch is unconditional: the two reads are the log line and the effective map, after it');

  // Batch failure: reset (disable the union, wanted first), then single
  // enables in priority order.
  probe.clear();
  probe.refuse = (call) => (call.enable.length > 1 ? RULE_LIMIT : null);
  await chrome.storage.local.set({ enabledRulesets: { annoyances: false } });
  const wanted = RULESETS_IN_LIST_ORDER.filter((id) => id !== 'annoyances');
  await hooks.applyRulesets();
  assert.deepEqual(shapeOf(probe.updates), [
    { enable: wanted, disable: ['annoyances'] },
    { enable: [], disable: [...wanted, 'annoyances'] },
    ...RULESETS_IN_PRIORITY_ORDER.filter((id) => id !== 'annoyances').map((id) => ({ enable: [id], disable: [] })),
  ]);

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §7.9 — applyRulesets was not serialized. The options page flips a card
// optimistically and leaves the control live, so a list clicked off and
// straight back on runs applyRulesets twice at once. The second run decides
// from a getEnabledRulesets() snapshot it takes itself, and under
// `rulesetDeltaApply` that snapshot can predate the first run's write: the
// delta comes out empty, nothing is sent, and the first run's disable is
// final. Storage, the reply's enabledMap and the options toggle then all say
// ON while the ruleset is OFF in Chrome, until the next worker start.
// The flag-off path has a weaker version of the same bug — two full batches
// whose landing order decides the outcome — which the same fix closes.
// ---------------------------------------------------------------------------

for (const [mode, seed] of [['flag off', {}], ['flag on', DELTA_ON]]) {
  test(`7.9: a list toggled off and straight back on ends up enabled (${mode})`, async () => {
    const { chrome, hooks } = await loadServiceWorker({ seed, awaitReady: true });
    const dnr = chrome.declarativeNetRequest;
    assert.equal(dnr._staticEnabled.has('annoyances'), true, 'precondition: the list starts enabled');

    // Hold the first write so the second toggle makes its decision while the
    // first one is still outstanding. Released unconditionally below, so a
    // serialized applier (which parks the second run before it writes
    // anything) cannot deadlock this test.
    let releaseFirstWrite;
    const firstWriteGate = new Promise((resolve) => { releaseFirstWrite = resolve; });
    let firstWriteHeld = false;
    const origUpdate = dnr.updateEnabledRulesets.bind(dnr);
    dnr.updateEnabledRulesets = async (options = {}) => {
      if (!firstWriteHeld) {
        firstWriteHeld = true;
        await firstWriteGate;
      }
      return origUpdate(options);
    };

    const off = chrome.runtime.sendMessage({
      type: 'SET_RULESET_ENABLED', payload: { rulesetId: 'annoyances', enabled: false },
    });
    await drainTicks(5);
    const on = chrome.runtime.sendMessage({
      type: 'SET_RULESET_ENABLED', payload: { rulesetId: 'annoyances', enabled: true },
    });
    await drainTicks(5);
    releaseFirstWrite();
    const [offRes, onRes] = await Promise.all([off, on]);
    await drainTicks(5);

    assert.equal(offRes.ok, true);
    assert.equal(onRes.ok, true);
    assert.equal(firstWriteHeld, true,
      'the first apply must have reached its write, or this test exercised nothing');
    assert.equal(chrome.storage.local._data().enabledRulesets.annoyances, true,
      'precondition: storage holds the last toggle the user made');
    assert.equal(onRes.enabledMap.annoyances, true,
      'precondition: the options page is told the list is on');
    assert.equal(dnr._staticEnabled.has('annoyances'), true,
      'and Chrome must enforce the toggle the user ended on, not the one they started on');

    hooks.cancelPendingStatsPersistForTest();
  });
}

test('5.1: a steady-state wake with a list turned off still issues no call', async () => {
  // The disable half of the delta: every other §5.1 test runs on the
  // all-lists-enabled profile, where disableRulesetIds is empty and dropping
  // the snapshot filter from `toDisable` changes nothing observable.
  const seed = { ...DELTA_ON, enabledRulesets: { annoyances: false } };
  const first = await loadServiceWorker({ seed, awaitReady: true });
  first.hooks.cancelPendingStatsPersistForTest();

  const wanted = RULESETS_IN_LIST_ORDER.filter((id) => id !== 'annoyances');
  assert.deepEqual(sorted(first.chrome.declarativeNetRequest._staticEnabled), sorted(wanted),
    'precondition: the first life enabled everything except the list the user turned off');

  const probe = probeRulesetCalls(first.chrome);
  const second = await loadServiceWorker({
    stub: first.chrome, idb: first.idb, seed, awaitReady: true,
  });
  second.hooks.cancelPendingStatsPersistForTest();

  assert.deepEqual(shapeOf(probe.updates), [],
    'a list the user turned off is already disabled in Chrome, so no wake may re-disable it');
  assert.deepEqual(sorted(first.chrome.declarativeNetRequest._staticEnabled), sorted(wanted),
    'and the state is unchanged');
});

test('5.1: a failed snapshot AND a failed batch still reset the union', async () => {
  const { chrome, hooks } = await loadServiceWorker({ seed: DELTA_ON, awaitReady: true });
  const dnr = chrome.declarativeNetRequest;
  const probe = probeRulesetCalls(chrome);

  // Only the delta's own snapshot fails, so the run degrades to the pre-flag
  // path — including its fallback, which the "unreadable snapshot" test above
  // never reaches because its batch succeeds.
  const readThrough = dnr.getEnabledRulesets;
  let snapshotFailed = false;
  dnr.getEnabledRulesets = async () => {
    if (snapshotFailed) return readThrough();
    snapshotFailed = true;
    throw new Error('snapshot unavailable');
  };
  probe.refuse = (call) => (call.enable.length > 1 ? RULE_LIMIT : null);

  await chrome.storage.local.set({ enabledRulesets: { annoyances: false } });
  const wanted = RULESETS_IN_LIST_ORDER.filter((id) => id !== 'annoyances');
  const effective = await hooks.applyRulesets();

  assert.equal(snapshotFailed, true,
    'the snapshot must have failed, or this test exercised nothing');
  assert.deepEqual(shapeOf(probe.updates), [
    { enable: wanted, disable: ['annoyances'] },
    { enable: [], disable: [...wanted, 'annoyances'] },
    ...RULESETS_IN_PRIORITY_ORDER.filter((id) => id !== 'annoyances').map((id) => ({ enable: [id], disable: [] })),
  ], 'with no snapshot the fallback is the pre-flag one: reset the union, then enable one at a time');
  assert.equal(effective.annoyances, false, 'and the user\'s toggle still lands');

  hooks.cancelPendingStatsPersistForTest();
});

test('7.9: an apply that fails does not wedge the queue for the worker life', async () => {
  const { chrome, hooks } = await loadServiceWorker({ seed: DELTA_ON, awaitReady: true });

  // §7.4(c) made a StorageReadError here non-fatal and non-rejecting on
  // purpose, so the fault has to be one the apply does NOT absorb: anything
  // that is not a StorageReadError is rethrown, and that is what reaches the
  // chain. A `chrome.storage.local.get` that throws outright is the cheapest.
  const origGet = chrome.storage.local.get;
  let faultFired = false;
  chrome.storage.local.get = (keys, cb) => {
    const list = Array.isArray(keys) ? keys : [keys];
    if (!faultFired && list.includes('enabledRulesets')) {
      faultFired = true;
      throw new Error('storage backend unavailable');
    }
    return origGet(keys, cb);
  };
  await assert.rejects(() => hooks.applyRulesets(), /storage backend unavailable/);
  chrome.storage.local.get = origGet;
  assert.equal(faultFired, true, 'the fault must have landed on the apply, or this test exercised nothing');

  // ...and the queue must still accept work afterwards. A chain that kept the
  // rejection would reject every later apply, so the options toggle would be
  // dead until the worker restarted.
  await chrome.storage.local.set({ enabledRulesets: { annoyances: false } });
  const effective = await hooks.applyRulesets();
  assert.equal(effective.annoyances, false, 'the next apply must still run');
  assert.equal(chrome.declarativeNetRequest._staticEnabled.has('annoyances'), false,
    'and land in Chrome');

  hooks.cancelPendingStatsPersistForTest();
});

test('7.9: a boot and both appliers in flight at once all settle', { timeout: 10_000 }, async () => {
  // Both chains are reachable from ensureBackgroundSetup AND from a message
  // handler. Drive the boot, both message paths and a direct apply at once: a
  // chain that could await itself, or two that could await each other, would
  // hang here rather than fail an assertion, so this test is time-boxed.
  const { chrome, hooks } = await loadServiceWorker({ seed: DELTA_ON });
  const ruleset = chrome.runtime.sendMessage({
    type: 'SET_RULESET_ENABLED', payload: { rulesetId: 'annoyances', enabled: false },
  });
  const settings = chrome.runtime.sendMessage({
    type: 'UPDATE_SETTINGS', payload: { stealthPersona: 'windows' },
  });
  const direct = hooks.applyRulesets();

  await hooks.whenCriticalReady();
  await hooks.whenBackgroundSetupDone();
  const [rulesetRes, settingsRes] = await Promise.all([ruleset, settings, direct]);

  assert.equal(rulesetRes.ok, true, 'the ruleset toggle must answer');
  assert.equal(settingsRes.ok, true, 'the settings write must answer');
  assert.equal(chrome.storage.local._data().enabledRulesets.annoyances, false);
  assert.equal(chrome.storage.local._data().settings.stealthPersona, 'windows');

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §7.9 — SET_RULESET_ENABLED read the whole enabledRulesets map, changed one
// key in its own copy and wrote the map back, all outside any lock. Two
// toggles of DIFFERENT lists at once therefore lost one of them: the later
// write clobbered the earlier one's key and the user's click came back on by
// itself, with no error and nothing to indicate it. The allowlist and
// user-filter writers have done their read-modify-write inside their chained
// op since §4.6/§4.7 (`addAllowlistDomains`, `appendUserFilterLine`); this
// path and UPDATE_SETTINGS were the two that never got it.
// ---------------------------------------------------------------------------

for (const [mode, seed] of [['flag off', {}], ['flag on', DELTA_ON]]) {
  test(`7.9: two lists turned off at once both stay off (${mode})`, async () => {
    const { chrome, hooks } = await loadServiceWorker({ seed, awaitReady: true });
    const dnr = chrome.declarativeNetRequest;
    assert.equal(dnr._staticEnabled.has('annoyances') && dnr._staticEnabled.has('malware'), true,
      'precondition: both lists start enabled');

    const [resA, resB] = await Promise.all([
      chrome.runtime.sendMessage({
        type: 'SET_RULESET_ENABLED', payload: { rulesetId: 'annoyances', enabled: false },
      }),
      chrome.runtime.sendMessage({
        type: 'SET_RULESET_ENABLED', payload: { rulesetId: 'malware', enabled: false },
      }),
    ]);

    assert.equal(resA.ok, true);
    assert.equal(resB.ok, true);
    const stored = chrome.storage.local._data().enabledRulesets;
    assert.deepEqual([stored.annoyances, stored.malware], [false, false],
      `both toggles must survive the read-modify-write, got: ${JSON.stringify(stored)}`);
    assert.equal(dnr._staticEnabled.has('annoyances'), false,
      'and a list the user turned off must actually be off in Chrome');
    assert.equal(dnr._staticEnabled.has('malware'), false);
    // The reply each caller got must not claim a list is on that is off.
    assert.equal(resB.enabledMap.malware, false);

    hooks.cancelPendingStatsPersistForTest();
  });
}

// ---------------------------------------------------------------------------
// REVIEW-2026-09 §5.5 — the navigation handlers re-seeded the memory cache
// unconditionally. REVIEW-2026-07 §5.4 gated the `setCachedDomainRules` inside
// `getCosmeticBundleForPage` on the rebuild generation, precisely so a bundle
// computed against half-cleared stores is never kept; both navigation callers
// then took the returned bundle and cached it anyway, overriding that
// decision. The window is narrow — a lookup that resolves after the rebuild's
// own `domainRulesCache.clear()` — but in it every later page load for that
// hostname is served a bundle built from a half-cleared index, until the next
// rebuild or worker death.
// ---------------------------------------------------------------------------

// Both navigation callers had the ungated write, and they are separate code
// paths: onBeforeNavigate pre-warms, onCommitted injects. Drive each through
// the same window, or deleting only one of the two passes the suite.
const NAVIGATION_CALLERS = [
  ['onBeforeNavigate', (hooks) => hooks.handleBeforeNavigate({
    tabId: 1, frameId: 0, url: 'https://example.com/',
  })],
  ['onCommitted/performEarlyInjection', (hooks) => hooks.performEarlyInjection(
    1, 0, 'https://example.com/',
  )],
];

for (const [caller, navigate] of NAVIGATION_CALLERS) {
  test(`5.5: a navigation during an in-flight rebuild leaves no cache entry (${caller})`, async () => {
    const { hooks } = await loadServiceWorker({
      awaitReady: true, packagedSources: samplePackagedSources(),
    });
    const db = hooks.db;
    assert.equal(hooks.hasCachedDomainRules('example.com'), false, 'precondition: nothing cached');

    // Park the navigation's lookup mid-read, so it resolves AFTER a rebuild
    // has cleared the cache — the exact ordering the gate exists to catch.
    let releaseLookup;
    const lookupGate = new Promise((resolve) => { releaseLookup = resolve; });
    let parked = 0;
    const origGetCosmeticRules = db.getCosmeticRules.bind(db);
    db.getCosmeticRules = async (domain) => {
      parked++;
      await lookupGate;
      return origGetCosmeticRules(domain);
    };

    const navigating = navigate(hooks);
    assert.equal(await waitFor(() => parked > 0), true, 'the lookup must be in flight');

    // A full rebuild runs and completes while the lookup is parked: it bumps
    // the generation and empties domainRulesCache on its way out.
    await hooks.queueActiveIndexRebuild();

    releaseLookup();
    await navigating;
    db.getCosmeticRules = origGetCosmeticRules;

    assert.equal(hooks.hasCachedDomainRules('example.com'), false,
      'a bundle the gated setter refused to keep must not be cached by its caller either');

    hooks.cancelPendingStatsPersistForTest();
  });
}

test("5.5 (didn't re-break): an ordinary navigation still warms the cache and injects", async () => {
  const { chrome, hooks } = await loadServiceWorker({
    awaitReady: true, packagedSources: samplePackagedSources(),
  });

  // onBeforeNavigate pre-warms so GET_INIT_DATA skips IndexedDB. With no
  // rebuild in flight the gated setter inside getCosmeticBundleForPage owns
  // that, and deleting the callers' own writes must not cost the warm-up.
  await hooks.handleBeforeNavigate({ tabId: 1, frameId: 0, url: 'https://example.com/' });
  assert.equal(hooks.hasCachedDomainRules('example.com'), true,
    'a quiet navigation must still leave the bundle cached');

  // And the injection path still gets real rules for the page.
  await hooks.performEarlyInjection(1, 0, 'https://example.com/');
  const injected = chrome.calls.filter((call) => call.api === 'scripting.insertCSS');
  assert.equal(injected.length, 1, 'the early injection must still happen');
  const bundle = await hooks.getCosmeticBundleForPage('example.com');
  assert.match(bundle.cssText || '', /\.site-ad/, 'and it carries this site\'s rules');

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// REVIEW-2026-09 §5.11 (A2f, flag `singleCssInjection`) — the same CSS was
// injected twice into every frame: once by `performEarlyInjection` as a
// user-origin sheet, once by the content script as a `<style>` pair. The SW
// half reports, per frame, whether its own injection actually landed, and
// Track C's content half skips its pair when the answer is strictly `true`.
//
// The whole design rests on never reporting a true that is not real: an
// extension's user-origin sheet is not visible in `document.styleSheets`, so
// the content script cannot check, and `cachedGenericCss` reaches the page
// ONLY through that one insertCSS — a wrong `true` turns "a duplicate sheet"
// into "no cosmetic CSS at all" for that frame. So the record is made only in
// the fulfilled branch of the un-swallowed insertCSS, it is keyed per frame
// rather than per tab (GET_INIT_DATA answers sub-frames too), and it is tied
// to the document it was made for.
// ---------------------------------------------------------------------------

const CSS_FLAG_ON = { featureFlags: { singleCssInjection: true } };
const PAGE_URL = 'https://example.com/';
const FRAME_URL = 'https://example.com/frame';

/** A content-script sender for one frame of one tab. */
function frameSender(tabId, frameId, url) {
  return { url, tab: { id: tabId, url }, frameId };
}

const initData = (chrome, tabId, frameId, url) => chrome.runtime.sendMessage(
  { type: 'GET_INIT_DATA', payload: {} }, frameSender(tabId, frameId, url));

test('5.11: GET_INIT_DATA reports earlyCssApplied only after a successful insertCSS for that frame', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: CSS_FLAG_ON, awaitReady: true, packagedSources: samplePackagedSources(),
  });

  // Before the frame commits, nothing has been injected into it.
  const before = await initData(chrome, 1, 0, PAGE_URL);
  assert.equal(before.earlyCssApplied, false,
    'a frame with no user-origin sheet yet must be told to inject its own');

  await hooks.handleCommitted({ tabId: 1, frameId: 0, url: PAGE_URL });
  assert.equal(chrome.calls.filter((c) => c.api === 'scripting.insertCSS').length, 1,
    'precondition: the early injection happened');

  const after = await initData(chrome, 1, 0, PAGE_URL);
  assert.equal(after.earlyCssApplied, true,
    'once the sheet is in, the content script must not add a second copy');
  assert.match(after.cssText || '', /\.site-ad/,
    'the reply still carries the CSS itself — the content script needs it for the procedural path');

  hooks.cancelPendingStatsPersistForTest();
});

test('5.11: a frame whose insertCSS failed is never reported as applied', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: CSS_FLAG_ON, awaitReady: true, packagedSources: samplePackagedSources(),
  });

  // Chrome rejects for a frame that is gone, a closed tab or a restricted
  // page. The production call swallows that rejection, so a record placed
  // after the swallow would report `true` for a frame with no CSS at all.
  const origInsertCSS = chrome.scripting.insertCSS;
  chrome.scripting.insertCSS = async () => { throw new Error('Frame with ID 0 was removed.'); };

  await hooks.handleCommitted({ tabId: 1, frameId: 0, url: PAGE_URL });
  chrome.scripting.insertCSS = origInsertCSS;

  const res = await initData(chrome, 1, 0, PAGE_URL);
  assert.equal(res.earlyCssApplied, false,
    'a failed injection must report false: this is the one direction that loses CSS instead of duplicating it');

  hooks.cancelPendingStatsPersistForTest();
});

test('5.11: the record is per frame, not per tab', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: CSS_FLAG_ON, awaitReady: true, packagedSources: samplePackagedSources(),
  });

  // The top frame commits; the sub-frame has not been injected into.
  // Deliberately the SAME url in both frames — a same-URL iframe is the case
  // that isolates the KEY: with a per-tab key the sub-frame would match the
  // parent's record and be told a sheet exists that it never received.
  await hooks.handleCommitted({ tabId: 1, frameId: 0, url: PAGE_URL });

  const top = await initData(chrome, 1, 0, PAGE_URL);
  const sub = await initData(chrome, 1, 3, PAGE_URL);
  assert.equal(top.earlyCssApplied, true);
  assert.equal(sub.earlyCssApplied, false,
    'a sub-frame must not inherit its parent\'s injection — the content script runs in all frames');

  // And once the sub-frame commits, it reports for itself.
  await hooks.handleCommitted({ tabId: 1, frameId: 3, url: PAGE_URL });
  assert.equal((await initData(chrome, 1, 3, PAGE_URL)).earlyCssApplied, true);
  // A different tab's frame 0 is still its own frame.
  assert.equal((await initData(chrome, 2, 0, PAGE_URL)).earlyCssApplied, false,
    'another tab must not inherit it either');

  hooks.cancelPendingStatsPersistForTest();
});

test('5.11: a new document in the same frame does not inherit the previous one\'s record', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: CSS_FLAG_ON, awaitReady: true, packagedSources: samplePackagedSources(),
  });

  await hooks.handleCommitted({ tabId: 1, frameId: 0, url: PAGE_URL });
  assert.equal((await initData(chrome, 1, 0, PAGE_URL)).earlyCssApplied, true, 'precondition');

  // The frame navigates. A document_start content script can ask before the
  // worker has processed that frame's onCommitted — both wake the worker and
  // the order is not guaranteed — so the record must not be consumable by a
  // document it was not made for. A user-origin sheet does not survive the
  // navigation, so reporting the old `true` here would leave the new document
  // with no cosmetic CSS at all.
  const next = await initData(chrome, 1, 0, 'https://example.com/other');
  assert.equal(next.earlyCssApplied, false,
    'a record must belong to one document; the next one starts with no sheet');

  // And once that document commits, it gets its own record.
  await hooks.handleCommitted({ tabId: 1, frameId: 0, url: 'https://example.com/other' });
  assert.equal((await initData(chrome, 1, 0, 'https://example.com/other')).earlyCssApplied, true);

  hooks.cancelPendingStatsPersistForTest();
});

test('5.11: closing a tab drops its records and the map stays bounded', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: CSS_FLAG_ON, awaitReady: true, packagedSources: samplePackagedSources(),
  });

  await hooks.handleCommitted({ tabId: 1, frameId: 0, url: PAGE_URL });
  await hooks.handleCommitted({ tabId: 1, frameId: 3, url: FRAME_URL });
  await hooks.handleCommitted({ tabId: 2, frameId: 0, url: PAGE_URL });
  assert.equal(hooks.earlyCssRecordCount(), 3);

  chrome.tabs.onRemoved._fire(1);
  assert.equal(hooks.earlyCssRecordCount(), 1, 'both of the closed tab\'s frames go');
  assert.equal((await initData(chrome, 2, 0, PAGE_URL)).earlyCssApplied, true,
    'and the surviving tab keeps its own');

  // Bounded: a page that creates frames without end cannot grow the map.
  for (let frameId = 100; frameId < 100 + hooks.MAX_EARLY_CSS_FRAMES + 50; frameId++) {
    await hooks.handleCommitted({ tabId: 3, frameId, url: FRAME_URL });
  }
  assert.ok(hooks.earlyCssRecordCount() <= hooks.MAX_EARLY_CSS_FRAMES,
    `the map must stay bounded, got ${hooks.earlyCssRecordCount()}`);
  // Eviction can only ever lose a `true`, which costs a duplicate sheet.
  assert.equal((await initData(chrome, 3, 100, FRAME_URL)).earlyCssApplied, false,
    'an evicted record reports false — duplicate CSS, never missing CSS');

  hooks.cancelPendingStatsPersistForTest();
});

test('5.11 (flag off): the reply is unchanged and the content script still injects', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    awaitReady: true, packagedSources: samplePackagedSources(),
  });
  assert.equal(hooks.FEATURE_DEFAULTS.singleCssInjection, false,
    'default OFF in the release that introduces it');

  await hooks.handleCommitted({ tabId: 1, frameId: 0, url: PAGE_URL });
  assert.equal(chrome.calls.filter((c) => c.api === 'scripting.insertCSS').length, 1,
    'the early injection is unconditional — the flag only changes what is reported');

  const res = await initData(chrome, 1, 0, PAGE_URL);
  assert.equal('earlyCssApplied' in res, false,
    'with the flag off the reply carries no such field, exactly as before');
  assert.match(res.cssText || '', /\.site-ad/, 'and the content script gets the CSS to inject itself');

  hooks.cancelPendingStatsPersistForTest();
});

test('5.11: a reload of the same URL does not inherit the previous document\'s record', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: CSS_FLAG_ON, awaitReady: true, packagedSources: samplePackagedSources(),
  });

  await hooks.handleCommitted({ tabId: 1, frameId: 0, url: PAGE_URL });
  assert.equal((await initData(chrome, 1, 0, PAGE_URL)).earlyCssApplied, true, 'precondition');

  // F5. The URL is identical, so matching the document URL alone cannot tell
  // the new document from the old one — the record has to be dropped when the
  // frame commits, before the new sheet exists. Hold the injection so the
  // question is asked inside exactly that window.
  let releaseInsert;
  const insertGate = new Promise((resolve) => { releaseInsert = resolve; });
  const origInsertCSS = chrome.scripting.insertCSS.bind(chrome.scripting);
  chrome.scripting.insertCSS = async (injection) => {
    await insertGate;
    return origInsertCSS(injection);
  };

  const reloading = hooks.handleCommitted({ tabId: 1, frameId: 0, url: PAGE_URL });
  const duringReload = await initData(chrome, 1, 0, PAGE_URL);
  assert.equal(duringReload.earlyCssApplied, false,
    'a reload has no sheet until its own injection lands; the old document\'s record must already be gone');

  releaseInsert();
  await reloading;
  chrome.scripting.insertCSS = origInsertCSS;
  assert.equal((await initData(chrome, 1, 0, PAGE_URL)).earlyCssApplied, true,
    'and once it lands, the reloaded document reports for itself');

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// REVIEW-2026-09 §5.18 (A2g) — the shield was re-injected into every open
// YouTube tab on every worker wake, even when the registration was unchanged.
// Track F's F2 put that behind `shieldNoReinject` and takes the flag as an
// injected dependency defaulting to `() => false`, so the module ships inert
// until the worker hands it the real reader. This is that wiring: without it
// the flag exists in storage, reads as true through `isFeatureEnabled`, and
// changes nothing at all.
// ---------------------------------------------------------------------------

const SHIELD_FLAG_ON = { featureFlags: { shieldNoReinject: true } };
const shieldInjections = (chrome, from = 0) => chrome.calls.entries
  .slice(from)
  .filter((call) => call.api === 'scripting.executeScript');

for (const [mode, seed, expectReinjection] of [
  ['flag on', SHIELD_FLAG_ON, false],
  ['flag off', {}, true],
]) {
  test(`5.18 (A2g): the worker's own isFeatureEnabled reaches the shield sync (${mode})`, async () => {
    const stub = makeChromeStub();
    stub.tabs._tabs.set(1, { id: 1, url: 'https://www.youtube.com/' });

    const first = await loadServiceWorker({ stub, seed, awaitReady: true });
    first.hooks.cancelPendingStatsPersistForTest();
    assert.ok(shieldInjections(stub).length >= 1,
      'precondition: the first life registers and injects into the open tab');

    // A warm wake on the same profile and the same browser session: same
    // registration, same tab, nothing for the shield to do.
    const before = stub.calls.entries.length;
    const second = await loadServiceWorker({ stub, idb: first.idb, seed, awaitReady: true });
    second.hooks.cancelPendingStatsPersistForTest();

    const reinjected = shieldInjections(stub, before);
    assert.equal(second.hooks.isFeatureEnabled('shieldNoReinject'), Boolean(seed.featureFlags),
      'precondition: the flag reads as seeded');
    if (expectReinjection) {
      assert.ok(reinjected.length >= 1,
        'flag off must stay byte-for-byte what shipped: every wake sweeps the open tabs');
    } else {
      assert.deepEqual(reinjected, [],
        'an unchanged registration must not re-evaluate the bundle in a live page');
    }

    assert.equal(second.hooks.FEATURE_DEFAULTS.shieldNoReinject, false,
      'default OFF in the release that introduces it');
  });
}
