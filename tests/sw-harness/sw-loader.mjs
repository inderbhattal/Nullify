/**
 * Loads a fresh service-worker.js instance against an in-memory chrome stub.
 *
 * The service worker registers its listeners and starts initialization at
 * module evaluation, so each test needs its own module instance: we import
 * with a unique query string (Node's ESM cache is keyed on the full URL) and
 * swap `globalThis.chrome` / `globalThis.indexedDB` first.
 *
 * `globalThis.fetch` is replaced with a failing stub: WASM init and remote
 * filter-list fetches then fail fast, which drives the SW down the same JS
 * fallback paths a packed build takes when WASM/network are unavailable —
 * and keeps tests offline.
 *
 * NOTE: the caller must ensure any timers the previous instance armed
 * (stats persist debounce) are cancelled via the test hooks before loading a
 * new instance, or a stale timer may write into the new stub's storage.
 */

import { makeChromeStub } from './chrome-stub.mjs';
import { makeIndexedDBStub } from './idb-stub.mjs';

let instanceCounter = 0;

export async function loadServiceWorker({ stub = null, seed = {}, awaitReady = false } = {}) {
  const chromeStub = stub ?? makeChromeStub();

  // Default SETTINGS so initializeDefaults() is a no-op and does not wipe
  // seeded state (it overwrites ALLOWLIST etc. when SETTINGS is absent).
  await chromeStub.storage.local.set({
    settings: { enabled: true, showBadge: true },
    ...seed,
  });

  const idb = makeIndexedDBStub();
  globalThis.chrome = chromeStub;
  globalThis.indexedDB = idb;
  globalThis.fetch = async () => {
    throw new Error('network disabled in sw-harness');
  };

  const sw = await import(`../../src/background/service-worker.js?instance=${++instanceCounter}`);
  const hooks = sw.__testHooks;

  if (awaitReady) {
    await hooks.whenCriticalReady();
    await hooks.whenBackgroundSetupDone();
  }

  return { chrome: chromeStub, idb, sw, hooks };
}

/** Await `predicate()` becoming truthy across a bounded number of ticks. */
export async function waitFor(predicate, { ticks = 200 } = {}) {
  for (let i = 0; i < ticks; i++) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return !!predicate();
}
