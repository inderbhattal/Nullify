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
 *
 * Options (REVIEW-2026-08 §7.2/§7.3 — the capabilities the three P0s needed):
 *   - `cold: true` holds `globalThis.fetch` open, so stage 0 of
 *     `startInitialization` never completes and `whenCriticalReady()` stays
 *     pending. That is the only way to deliver a message to a worker whose
 *     memory caches are still empty — the state every SW wake starts in, and
 *     the state every pre-existing harness test skipped past. Call the
 *     returned `releaseCold()` to let startup proceed.
 *   - `idb` reuses a previous instance's IndexedDB stub, i.e. reboots a new
 *     worker on the same "disk". Combined with abandoning an instance
 *     mid-rebuild (leave a `db.*` call unsettled), that models MV3
 *     termination in the middle of a destructive index rebuild.
 *   - `packagedSources` serves a `rules/filter-sources.json` payload so the
 *     cosmetic/scriptlet index can actually be built in-harness; without it
 *     every list fetch fails and the index is empty, which makes "the index
 *     went silently dead" unobservable.
 */

import { makeChromeStub } from './chrome-stub.mjs';
import { makeIndexedDBStub } from './idb-stub.mjs';

let instanceCounter = 0;

const NETWORK_DISABLED = 'network disabled in sw-harness';

// The harness cuts the network on purpose, and the worker then correctly
// reports every resulting failure — including a CRITICAL for WASM init. Left
// alone that is ~11 alarming lines per loaded worker, which buries genuine
// output and teaches the reader to skim past the word CRITICAL.
//
// Suppress only the messages the harness itself caused, matched on its own
// sentinel string; anything else reaches the console untouched. Set
// NULLIFY_TEST_VERBOSE=1 to see them.
if (!process.env.NULLIFY_TEST_VERBOSE) {
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      const selfInflicted = args.some((arg) => {
        if (typeof arg === 'string') return arg.includes(NETWORK_DISABLED);
        return arg instanceof Error && arg.message.includes(NETWORK_DISABLED);
      });
      if (!selfInflicted) original(...args);
    };
  }
}

export async function loadServiceWorker({
  stub = null,
  idb = null,
  seed = {},
  awaitReady = false,
  cold = false,
  packagedSources = null,
} = {}) {
  const chromeStub = stub ?? makeChromeStub();

  // Default SETTINGS so initializeDefaults() is a no-op and does not wipe
  // seeded state (it overwrites ALLOWLIST etc. when SETTINGS is absent).
  await chromeStub.storage.local.set({
    settings: { enabled: true, showBadge: true },
    ...seed,
  });

  const idbStub = idb ?? makeIndexedDBStub();
  globalThis.chrome = chromeStub;
  globalThis.indexedDB = idbStub;

  let releaseCold = () => {};
  const coldGate = cold
    ? new Promise((resolve) => { releaseCold = resolve; })
    : null;

  globalThis.fetch = async (url) => {
    // A cold worker is one whose critical startup has not run. Blocking the
    // very first fetch (the WASM asset) freezes startup at stage 0 with every
    // memory cache still empty.
    if (coldGate) await coldGate;
    if (packagedSources && String(url).includes('filter-sources.json')) {
      return { ok: true, json: async () => packagedSources };
    }
    throw new Error(NETWORK_DISABLED);
  };

  const sw = await import(`../../src/background/service-worker.js?instance=${++instanceCounter}`);
  const hooks = sw.__testHooks;

  if (awaitReady) {
    if (cold) releaseCold();
    await hooks.whenCriticalReady();
    await hooks.whenBackgroundSetupDone();
  }

  return { chrome: chromeStub, idb: idbStub, sw, hooks, releaseCold: () => releaseCold() };
}

/** Await `predicate()` becoming truthy across a bounded number of ticks. */
export async function waitFor(predicate, { ticks = 200 } = {}) {
  for (let i = 0; i < ticks; i++) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return !!predicate();
}

/** Let queued microtasks and timers run `ticks` times. */
export async function drainTicks(ticks = 20) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * True once `promise` has settled. Used to assert that a handler is *still
 * waiting* on the readiness gate rather than having answered from empty
 * caches — the §3.1 failure shape.
 */
export function trackSettled(promise) {
  const state = { settled: false, value: undefined, error: undefined };
  promise.then(
    (value) => { state.settled = true; state.value = value; },
    (error) => { state.settled = true; state.error = error; },
  );
  return state;
}

/**
 * A minimal `rules/filter-sources.json` payload: one domain-specific cosmetic
 * rule and one scriptlet for `example.com`, both observable through
 * `db.getCosmeticRules` / `db.getScriptletRules`.
 */
export function samplePackagedSources() {
  return {
    easylist: {
      cosmetic: {
        generic: ['.generic-ad'],
        domainSpecific: { 'example.com': ['.site-ad'] },
        exceptions: {},
        genericExcludedDomains: [],
      },
      scriptlets: [{ name: 'noeval', domains: ['example.com'], args: [] }],
    },
  };
}
