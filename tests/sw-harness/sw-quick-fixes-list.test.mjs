/**
 * Regression tests for ingesting uAssets' `quick-fixes.txt` as `ubo-quick-fixes`.
 *
 * uBO's modern YouTube machinery does NOT live in `filters.txt` (which we
 * already ingest as `ubo-filters`). It lives in `quick-fixes.txt`:
 * `json-prune-fetch-response` / `json-prune-xhr-response` on
 * `/youtubei/v1/player`, the `trusted-json-edit-xhr-request` request shaping,
 * and the `trusted-prevent-dom-bypass` counters. Before this list was added the
 * extension shipped none of it, and every assertion below fails on that code.
 *
 * The trust half matters as much as the ingestion half. uBO gates `trusted-*`
 * scriptlets on list provenance — `src/js/storage.js` sets
 * `trustedListPrefixes: 'ublock-'`, so every `ublock-*` list may invoke them.
 * quick-fixes.txt IS a `ublock-*` list and its YouTube rules depend on
 * `trusted-replace-fetch-response`, `trusted-replace-xhr-response` and
 * `trusted-rpnt`. If the id is missing from `TRUSTED_FILTER_LIST_IDS` those
 * rules are silently refused by `filterTrustedScriptlets` and YouTube ads come
 * back with no error anywhere — the exact failure this file pins.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import { loadServiceWorker } from './sw-loader.mjs';

const LIST_ID = 'ubo-quick-fixes';
const SW_SOURCE = fs.readFileSync(
  new URL('../../src/background/service-worker.js', import.meta.url), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(
  new URL('../../manifest.json', import.meta.url), 'utf8'));

test('ubo-quick-fixes is registered for runtime cosmetic/scriptlet refresh', async () => {
  // The vendored snapshot only carries this list's ~28 DNR rules into a
  // release. Everything that actually counters YouTube is cosmetic/scriptlet,
  // and REMOTE_FILTER_LISTS is the ONLY path by which those reach an installed
  // user between releases — quick-fixes.txt declares `! Expires: 8 hours`.
  const { hooks } = await loadServiceWorker({ awaitReady: true });

  assert.ok(
    hooks.ALL_KNOWN_LIST_IDS.includes(LIST_ID),
    'ubo-quick-fixes must be in ALL_KNOWN_LIST_IDS — applyRulesets iterates it, '
    + 'so a list missing here is never enabled');

  assert.match(
    SW_SOURCE,
    /id: 'ubo-quick-fixes', url: 'https:\/\/raw\.githubusercontent\.com\/uBlockOrigin\/uAssets\/master\/filters\/quick-fixes\.txt'/,
    'REMOTE_FILTER_LISTS must fetch quick-fixes.txt at runtime');

  hooks.cancelPendingStatsPersistForTest();
});

test('ubo-quick-fixes may invoke trusted-* scriptlets', async () => {
  const { hooks } = await loadServiceWorker({ awaitReady: true });

  assert.ok(
    hooks.TRUSTED_FILTER_LIST_IDS.has(LIST_ID),
    'ubo-quick-fixes is a ublock-* list (uBO: trustedListPrefixes = "ublock-") '
    + 'and its YouTube rules depend on trusted-* scriptlets');

  // The gate, not just the set: a spec tagged with this list id must survive.
  for (const name of [
    'trusted-replace-fetch-response',
    'trusted-replace-xhr-response',
    'trusted-rpnt',
    'trusted-set',
  ]) {
    const spec = { name, domains: ['www.youtube.com'], args: [], listId: LIST_ID };
    assert.deepEqual(
      hooks.filterTrustedScriptlets([spec], 'list').map((s) => s.name),
      [name],
      `${name} from ${LIST_ID} must not be refused`);
  }

  hooks.cancelPendingStatsPersistForTest();
});

test('ubo-quick-fixes has a manifest ruleset and an explicit enable priority', () => {
  // A manifest ruleset with no RULESET_ENABLE_PRIORITY slot falls to the bottom
  // of the budget fallback and is the first thing dropped on a constrained
  // profile — for a 28-rule list of same-day counter-moves that is exactly
  // backwards. The SW asserts the two agree at module load (fatal), so this
  // test also guards that boot invariant.
  const resource = (MANIFEST.declarative_net_request?.rule_resources || [])
    .find((r) => r.id === LIST_ID);
  assert.ok(resource, 'manifest must declare the ubo-quick-fixes ruleset');
  assert.equal(resource.path, `rules/${LIST_ID}.json`);
  assert.equal(resource.enabled, true, 'the counter-moves are worthless disabled');

  const priorityBlock = /const RULESET_ENABLE_PRIORITY = \[([\s\S]*?)\];/.exec(SW_SOURCE);
  assert.ok(priorityBlock, 'RULESET_ENABLE_PRIORITY must exist');
  const order = [...priorityBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(order.includes(LIST_ID), 'ubo-quick-fixes needs an explicit priority slot');
  assert.ok(
    order.indexOf(LIST_ID) < order.indexOf('easylist'),
    'a 28-rule counter-move list must outrank the 25k-rule bulk lists in the '
    + 'budget fallback');

  assert.match(
    SW_SOURCE,
    /'ubo-quick-fixes': true,/,
    'getDefaultEnabledRulesets must enable it by default');
});
