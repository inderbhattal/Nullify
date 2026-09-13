/**
 * Regression tests for REVIEW-2026-09 §4.3 — the runtime `!#include` path
 * failed open. The build has refused a list whose sub-file failed since
 * 2026-08 §5.10, but the runtime `fetchAndExpand` — the ONLY channel by which
 * quick-fixes.txt and the uAssets lists reach an installed user between
 * releases — still returned '' for a 404'd include. The service worker then
 * stored the surviving fraction over the previous good source, rebuilt the
 * index from it, and reported `updatedLists: ['easylist']` to the options
 * page ("Updated 1 filter list").
 *
 * The per-list `try/catch` in `fetchAndStoreRemoteFilterSources` already
 * keeps the previous source and leaves the id out of `updatedLists` when the
 * TOP-LEVEL fetch fails; the fix is entirely in the expander, which now
 * throws on a failed include so a sub-file failure takes the same path.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { loadServiceWorker, samplePackagedSources } from './sw-loader.mjs';

const EASYLIST_URL = 'https://easylist.to/easylist/easylist.txt';
const TOP_LEVEL = 'example.com##.top-level-rule\n!#include easylist_general_block.txt\n';

/** Serve easylist.txt; its sub-file answers with `includeStatus`; every other list is offline. */
function fetchStub({ includeStatus }) {
  const fetched = [];
  return {
    fetched,
    fetch: async (url) => {
      const u = String(url);
      fetched.push(u);
      if (u === EASYLIST_URL) {
        return { ok: true, status: 200, url: u, text: async () => TOP_LEVEL };
      }
      if (u.endsWith('easylist_general_block.txt')) {
        if (includeStatus === 200) {
          return { ok: true, status: 200, url: u, text: async () => 'example.com##.included-rule\n' };
        }
        return { ok: false, status: includeStatus, url: u, text: async () => 'Not Found' };
      }
      throw new Error('offline');
    },
  };
}

async function storedEasylistSelectors(db) {
  const sources = await db.getAllFilterSources();
  const easylist = sources.find((s) => s.listId === 'easylist');
  return easylist?.cosmetic?.domainSpecific?.['example.com'] ?? null;
}

test('4.3: a list whose sub-file 404s keeps its stored source and is not reported as updated', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    awaitReady: true,
    packagedSources: samplePackagedSources(),
  });
  const { db } = hooks;

  // Baseline: the packaged easylist source is stored and indexed.
  assert.deepEqual(await storedEasylistSelectors(db), ['.site-ad']);
  assert.deepEqual(await db.getCosmeticRules('example.com'), ['.site-ad']);

  const stub = fetchStub({ includeStatus: 404 });
  globalThis.fetch = stub.fetch;

  const res = await hooks.checkFilterListUpdates();

  assert.ok(stub.fetched.some((u) => u.endsWith('easylist_general_block.txt')),
    'the include must have been attempted (otherwise this scenario tests nothing)');
  assert.ok(!res.updatedLists.includes('easylist'),
    `a list missing a sub-file must not be reported as updated, got ${JSON.stringify(res)}`);
  assert.equal(res.ok, false,
    'with every other list offline, nothing refreshed — the check must say so');
  assert.equal(chrome.storage.local._data().lastUpdateCheck, undefined,
    'no refresh happened, so no timestamp may be written');

  // The previous good source survives, untouched, and so does the index
  // built from it.
  assert.deepEqual(await storedEasylistSelectors(db), ['.site-ad'],
    'the stored source must not be replaced by the truncated top-level file');
  assert.deepEqual(await db.getCosmeticRules('example.com'), ['.site-ad'],
    'the active index must not be rebuilt from a truncated list');

  hooks.cancelPendingStatsPersistForTest();
});

test('4.3 (didn\'t re-break): a list whose sub-file resolves is refreshed and reported', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    awaitReady: true,
    packagedSources: samplePackagedSources(),
  });
  const { db } = hooks;
  assert.deepEqual(await storedEasylistSelectors(db), ['.site-ad']);

  globalThis.fetch = fetchStub({ includeStatus: 200 }).fetch;

  const res = await hooks.checkFilterListUpdates();
  assert.equal(res.ok, true);
  assert.deepEqual(res.updatedLists, ['easylist']);
  assert.equal(typeof chrome.storage.local._data().lastUpdateCheck, 'number');

  // The new source carries both the top-level and the included rule.
  const selectors = await storedEasylistSelectors(db);
  assert.ok(selectors.includes('.top-level-rule') && selectors.includes('.included-rule'),
    `expected both rules in the refreshed source, got ${JSON.stringify(selectors)}`);
  assert.ok(!selectors.includes('.site-ad'), 'the refreshed source replaces the old one');

  hooks.cancelPendingStatsPersistForTest();
});
