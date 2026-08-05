/**
 * Regression tests for REVIEW-2026-07:
 *  §4.7 — interrupted rebuildAllowlistState left a permanent matcher/DNR
 *         desync (storage said "allowed", DNR kept blocking); startup must
 *         reconcile unconditionally, and rebuilds must be serialized.
 *  §5.8 — the no-PSL fallback allowlist walk let a `co.uk` entry blanket the
 *         whole TLD when WASM was down.
 *  Plus the ADD_ALLOWLIST_DOMAINS message contract.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { loadServiceWorker } from './sw-loader.mjs';

const DNR_ALLOWLIST_START = 990_000;

function allowlistRules(chrome) {
  return [...chrome.declarativeNetRequest._dynamic.values()]
    .filter((r) => r.id >= DNR_ALLOWLIST_START);
}

test('4.7: startup reconciles DNR allow rules against the stored allowlist', async () => {
  // Stored allowlist is already normalized (so the old normalization-only
  // check would skip the rebuild), but no DNR allow rule exists — the state
  // an SW kill between the storage write and the DNR write leaves behind.
  const { chrome, hooks } = await loadServiceWorker({
    seed: { allowlist: ['example.com'] },
    awaitReady: true,
  });

  const rules = allowlistRules(chrome);
  assert.equal(rules.length, 1, 'startup must rebuild the missing DNR allow rule');
  assert.equal(rules[0].condition.urlFilter, '||example.com^');
  assert.equal(rules[0].action.type, 'allowAllRequests');

  hooks.cancelPendingStatsPersistForTest();
});

test('4.7: concurrent allowlist mutations are serialized (no duplicate-id rejection)', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const [resA, resB] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'ALLOW_SITE', payload: { domain: 'aaa.example' } }),
    chrome.runtime.sendMessage({ type: 'ALLOW_SITE', payload: { domain: 'bbb.example' } }),
  ]);

  assert.equal(resA.ok, true, `first add failed: ${JSON.stringify(resA)}`);
  assert.equal(resB.ok, true, `second add failed: ${JSON.stringify(resB)}`);

  const allowlist = await chrome.runtime.sendMessage({ type: 'GET_ALLOWLIST' });
  assert.deepEqual([...allowlist].sort(), ['aaa.example', 'bbb.example']);

  const rules = allowlistRules(chrome);
  assert.equal(rules.length, 2, 'both domains must have a DNR allow rule');

  hooks.cancelPendingStatsPersistForTest();
});

test('5.8: fallback allowlist walk stops at public suffixes like the WASM matcher', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  // §4.8 (fixed): server-side validation now rejects the bare public suffix
  // at write time, so it never reaches the cached set — the matcher-side
  // PSL stop below stays as defense in depth.
  // §5.33 — SET_ALLOWLIST is deleted (no caller anywhere); ADD_ALLOWLIST_DOMAINS
  // is the live writer and shares `partitionAllowlistInput`, so it exercises the
  // same validation on an empty starting allowlist.
  const res = await chrome.runtime.sendMessage({
    type: 'ADD_ALLOWLIST_DOMAINS',
    payload: { domains: ['co.uk', 'example.com'] },
  });
  assert.equal(res.ok, true);

  // WASM is down in the harness → this exercises the JS fallback walk.
  assert.equal(hooks.isHostnameAllowedCached('foo.co.uk'), false,
    'a co.uk entry must not blanket every site on the TLD');
  assert.equal(hooks.isHostnameAllowedCached('co.uk'), false,
    'matches WASM AllowlistMatcher semantics: public-suffix entries are inert');
  assert.equal(hooks.isHostnameAllowedCached('example.com'), true);
  assert.equal(hooks.isHostnameAllowedCached('sub.example.com'), true);

  hooks.cancelPendingStatsPersistForTest();
});

test('ADD_ALLOWLIST_DOMAINS: normalizes, unions with stored allowlist, rebuilds state', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: { allowlist: ['existing.example'] },
    awaitReady: true,
  });

  const res = await chrome.runtime.sendMessage({
    type: 'ADD_ALLOWLIST_DOMAINS',
    payload: { domains: ['Foo.COM', 'https://bar.org/page', 'foo.com', 'existing.example'] },
  });

  assert.equal(res.ok, true);
  assert.deepEqual(res.allowlist, ['existing.example', 'foo.com', 'bar.org']);

  // Authoritative storage updated…
  assert.deepEqual(
    chrome.storage.local._data().allowlist,
    ['existing.example', 'foo.com', 'bar.org']
  );
  // …memory matcher updated…
  assert.equal(hooks.isHostnameAllowedCached('foo.com'), true);
  // …and DNR rebuilt for all three.
  assert.equal(allowlistRules(chrome).length, 3);

  hooks.cancelPendingStatsPersistForTest();
});

test('ADD_ALLOWLIST_DOMAINS: rejects malformed payloads with {error}', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  for (const payload of [undefined, {}, { domains: 'foo.com' }, { domains: [42] }]) {
    const res = await chrome.runtime.sendMessage({ type: 'ADD_ALLOWLIST_DOMAINS', payload });
    assert.ok(res.error, `expected {error} for payload ${JSON.stringify(payload)}`);
  }
  assert.equal(allowlistRules(chrome).length, 0);

  hooks.cancelPendingStatsPersistForTest();
});

// ---------------------------------------------------------------------------
// §4.8 (REVIEW-2026-07) — write-side allowlist validation. A bare public
// suffix used to become `||co.uk^` + allowAllRequests at priority 500,
// disabling network blocking TLD-wide while the popup kept saying
// "Protected" (the matchers refuse to match at a public suffix).
// ---------------------------------------------------------------------------

test('4.8: the allowlist writer rejects public suffixes server-side and reports them', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const res = await chrome.runtime.sendMessage({
    type: 'ADD_ALLOWLIST_DOMAINS',
    payload: { domains: ['com', 'co.uk', 'example.com', 'foo bar'] },
  });

  assert.equal(res.ok, true);
  assert.deepEqual(res.allowlist, ['example.com']);
  // 'foo bar' survives normalizeHostname (it's a canonicalizer, not a
  // validator) — the charset check must catch it here.
  assert.deepEqual(res.rejected, ['com', 'co.uk', 'foo bar']);

  const rules = allowlistRules(chrome);
  assert.equal(rules.length, 1, 'only the valid domain may get a DNR allow rule');
  assert.equal(rules[0].condition.urlFilter, '||example.com^');
  assert.ok(
    !rules.some((r) => r.condition.urlFilter === '||co.uk^'),
    'a TLD-wide allowAllRequests rule must never reach DNR'
  );
  assert.deepEqual(chrome.storage.local._data().allowlist, ['example.com']);

  hooks.cancelPendingStatsPersistForTest();
});

test('4.8: ALLOW_SITE refuses a bare public suffix with a surfaced error', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  const res = await chrome.runtime.sendMessage({
    type: 'ALLOW_SITE',
    payload: { domain: 'co.uk' },
  });

  assert.equal(res.ok, false);
  assert.ok(res.error, 'UI must receive a reportable error');
  assert.deepEqual(res.rejected, ['co.uk']);
  assert.equal(allowlistRules(chrome).length, 0);

  hooks.cancelPendingStatsPersistForTest();
});

test('4.8: ADD_ALLOWLIST_DOMAINS filters invalid import lines and reports them', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: { allowlist: ['existing.example'] },
    awaitReady: true,
  });

  const res = await chrome.runtime.sendMessage({
    type: 'ADD_ALLOWLIST_DOMAINS',
    payload: { domains: ['good.example', 'com', 'github.io', 'localhost'] },
  });

  assert.equal(res.ok, true);
  assert.deepEqual(res.allowlist, ['existing.example', 'good.example']);
  assert.deepEqual(res.rejected, ['com', 'github.io', 'localhost']);
  assert.deepEqual(chrome.storage.local._data().allowlist, ['existing.example', 'good.example']);

  hooks.cancelPendingStatsPersistForTest();
});

test('4.8: legacy stored public-suffix entries are scrubbed at startup, not resurrected', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    seed: { allowlist: ['co.uk', 'example.com'] },
    awaitReady: true,
  });

  const rules = allowlistRules(chrome);
  assert.equal(rules.length, 1, 'startup rebuild must drop the legacy suffix entry');
  assert.equal(rules[0].condition.urlFilter, '||example.com^');
  assert.deepEqual(chrome.storage.local._data().allowlist, ['example.com']);

  hooks.cancelPendingStatsPersistForTest();
});

test('4.8 related: exact allowlist membership is honored before the PSL stop', async () => {
  const { hooks } = await loadServiceWorker({ awaitReady: true });

  // A curated public suffix that is itself a real, browsable site
  // (netlify.app). Write-side validation refuses to store it, but the shared
  // matcher must honor exact membership if such an entry exists (legacy state,
  // future curated exceptions) — previously `ancestorDomains` refused to
  // yield the hostname itself, making the entry a silent no-op.
  const set = new Set(['netlify.app']);
  assert.equal(hooks.allowlistCoversHostname(set, 'netlify.app'), true,
    'exact membership must match even when the hostname is a public suffix');
  assert.equal(hooks.allowlistCoversHostname(set, 'someone.netlify.app'), false,
    'ancestor walk must still stop at the public suffix — no TLD blanketing');

  hooks.cancelPendingStatsPersistForTest();
});
