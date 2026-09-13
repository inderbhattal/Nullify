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

import { loadServiceWorker, samplePackagedSources } from './sw-loader.mjs';

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
