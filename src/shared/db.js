/**
 * db.js — IndexedDB wrapper for large rule indexing.
 *
 * Used primarily for cosmetic rules (tens of thousands of domain-specific rules)
 * to avoid loading them all into memory at once.
 */

import { lookupDomains } from './psl.js';
import { StorageQuotaError } from './storage.js';

const DB_NAME = 'NullifyRules';
const DB_VERSION = 4;
const STORE_COSMETIC = 'cosmetic_rules';
const STORE_SCRIPTLET = 'scriptlet_rules';
const STORE_FILTER_SOURCES = 'filter_sources';
const STORE_PAGE_BUNDLES = 'page_bundles';

const ALL_STORES = [STORE_COSMETIC, STORE_SCRIPTLET, STORE_FILTER_SOURCES, STORE_PAGE_BUNDLES];

/**
 * §5.8 — hard cap on the in-memory LRU touches `getPageBundle` records between
 * prunes. Only a hit records one, so the map is already bounded by the rows in
 * the store — which the service worker prunes to its own cap after every put —
 * and it is emptied whenever those rows are pruned or cleared. The cap makes
 * the bound unconditional (a worker can live for hours, and rows can vanish
 * without this class hearing of it). It sits well above the store cap so that
 * it costs no LRU accuracy in practice: past it the least recent touch is
 * dropped, and that row simply ranks by its stored stamp.
 */
export const PAGE_BUNDLE_TOUCH_MAX = 1000;

/**
 * Normalize an IndexedDB transaction/request error into something callers can
 * act on: quota failures map to the shared StorageQuotaError type, and a
 * missing error (possible on commit-time aborts) becomes a real Error.
 */
function normalizeIdbError(error, fallbackMessage) {
  if (!error) return new Error(fallbackMessage);
  if (error.name === 'QuotaExceededError') {
    return new StorageQuotaError(error.message || fallbackMessage, { cause: error });
  }
  return error;
}

/**
 * Wire rejection for both failure paths of a transaction. Per the IndexedDB
 * spec, a transaction that aborts without a failed request — quota exceeded
 * at commit, forced close under storage pressure, internal IO error — fires
 * only `abort`, not `error`. Without an onabort handler the wrapper promise
 * would never settle. A settled promise ignores duplicate reject calls, so
 * coexistence with per-request onerror handlers is safe.
 */
function rejectOnAbortOrError(transaction, reject) {
  transaction.onabort = () =>
    reject(normalizeIdbError(transaction.error, 'IndexedDB transaction aborted'));
  transaction.onerror = (event) =>
    reject(normalizeIdbError(event.target.error, 'IndexedDB transaction error'));
}

export class RulesDB {
  constructor() {
    this.db = null;
    this._openPromise = null;
    this._pendingCosmeticLookups = [];
    // §5.8 — hostname -> Date.now() of the last getPageBundle hit, in touch
    // order. Folded into the stored `updatedAt` by prunePageBundles.
    this._bundleTouched = new Map();
  }

  async open() {
    if (this.db) return this.db;
    // Concurrent open() calls must share one connection: a second physical
    // connection would leak, and its versionchange handler would block
    // upgrades forever. Cache the in-flight open promise.
    if (this._openPromise) return this._openPromise;

    this._openPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion || 0;

        // Schemas for v1-v3 diverged enough (scriptlet key shape, cosmetic
        // bucket layout) that reusing their rows risks stale data. Rebuild
        // the stores on any upgrade path — the next rule-compile pass will
        // repopulate them from the filter sources.
        if (oldVersion > 0 && oldVersion < DB_VERSION) {
          for (const name of ALL_STORES) {
            if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
          }
        }

        if (!db.objectStoreNames.contains(STORE_COSMETIC)) {
          db.createObjectStore(STORE_COSMETIC, { keyPath: 'hostname' });
        }
        if (!db.objectStoreNames.contains(STORE_SCRIPTLET)) {
          const store = db.createObjectStore(STORE_SCRIPTLET, { keyPath: 'id', autoIncrement: true });
          // Index by domain for faster lookup
          store.createIndex('domain', 'domains', { multiEntry: true, unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_FILTER_SOURCES)) {
          db.createObjectStore(STORE_FILTER_SOURCES, { keyPath: 'listId' });
        }
        if (!db.objectStoreNames.contains(STORE_PAGE_BUNDLES)) {
          db.createObjectStore(STORE_PAGE_BUNDLES, { keyPath: 'hostname' });
        }
      };

      request.onsuccess = (event) => {
        const db = event.target.result;
        // If another tab triggers a version upgrade later, Chrome will try
        // to invalidate our open connection. Close it so the upgrade can
        // proceed rather than stalling indefinitely. The handler is bound to
        // ITS OWN connection (`db`), not `this.db` — otherwise a stale
        // handler could close whatever connection happens to be current.
        db.onversionchange = () => {
          try { db.close(); } catch { /* ignore */ }
          if (this.db === db) {
            this.db = null;
            this._openPromise = null;
          }
        };
        this.db = db;
        resolve(db);
      };

      request.onerror = (event) => {
        this._openPromise = null;
        reject(event.target.error);
      };

      // Another tab already has the DB open at the old version and is
      // blocking the upgrade. Reject rather than hang forever.
      request.onblocked = () => {
        this._openPromise = null;
        reject(new Error('IndexedDB upgrade blocked by another tab'));
      };
    });

    return this._openPromise;
  }

  /** Bulk insert scriptlet rules. */
  async putBulkScriptletRules(rules) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_SCRIPTLET], 'readwrite');
      const store = transaction.objectStore(STORE_SCRIPTLET);

      for (const rule of rules) {
        // Generic (domain-less) scriptlets parse to `domains: []`. A multiEntry
        // index emits NO key for an empty array, so they'd never be returned by
        // the `''` generic-bucket query in getScriptletRules. Index them under
        // the empty-string key so generic `##+js(...)` rules are reachable.
        if (!rule.domains || rule.domains.length === 0) {
          store.put({ ...rule, domains: [''] });
        } else {
          store.put(rule);
        }
      }

      transaction.oncomplete = () => resolve();
      rejectOnAbortOrError(transaction, reject);
    });
  }

  /** Get scriptlets matching a domain. */
  async getScriptletRules(hostname) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_SCRIPTLET], 'readonly');
      const store = transaction.objectStore(STORE_SCRIPTLET);
      const index = store.index('domain');
      rejectOnAbortOrError(transaction, reject);

      // Stop ascending at the first public suffix so `co.uk`-indexed rules
      // cannot match every site on that TLD, but still honour an exact key on
      // a curated suffix that is itself a browsable site — `github.io##+js(…)`
      // on `github.io` (§5.11; see `lookupDomains`). Empty string key is the
      // "generic" bucket (rules with no domain).
      const domainsToCheck = ['', ...lookupDomains(hostname)];

      const allRules = [];
      let completed = 0;

      for (const domain of domainsToCheck) {
        const request = index.getAll(domain);
        request.onsuccess = (event) => {
          const rules = event.target.result;
          if (rules) {
            allRules.push(...rules);
          }
          completed++;
          if (completed === domainsToCheck.length) {
            // Deduplicate rules by ID in case they were indexed under multiple parent domains
            const seen = new Set();
            const uniqueRules = allRules.filter(r => {
              if (seen.has(r.id)) return false;
              seen.add(r.id);
              return true;
            });
            resolve(uniqueRules);
          }
        };
        request.onerror = (event) => reject(event.target.error);
      }
    });
  }

  /** Bulk insert domain-specific rules. */
  async putBulkCosmeticRules(rulesMap) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_COSMETIC], 'readwrite');
      const store = transaction.objectStore(STORE_COSMETIC);

      for (const [hostname, selectors] of Object.entries(rulesMap)) {
        store.put({ hostname, selectors });
      }

      transaction.oncomplete = () => resolve();
      rejectOnAbortOrError(transaction, reject);
    });
  }

  /**
   * Get rules for a single domain.
   *
   * Lookups issued in the same synchronous burst — as the service worker's
   * ancestor-domain walk does — are coalesced into ONE readonly transaction,
   * so a concurrent rebuild (clear + repopulate) cannot interleave between
   * two lookups and the combined result is snapshot-consistent.
   */
  async getCosmeticRules(hostname) {
    return new Promise((resolve, reject) => {
      this._pendingCosmeticLookups.push({ hostname, resolve, reject });
      if (this._pendingCosmeticLookups.length === 1) {
        queueMicrotask(() => { this._flushCosmeticLookups(); });
      }
    });
  }

  /** Run all queued cosmetic lookups inside a single readonly transaction. */
  async _flushCosmeticLookups() {
    const batch = this._pendingCosmeticLookups;
    this._pendingCosmeticLookups = [];
    if (batch.length === 0) return;

    const rejectAll = (err) => {
      for (const entry of batch) entry.reject(err);
    };

    let transaction;
    try {
      const db = await this.open();
      transaction = db.transaction([STORE_COSMETIC], 'readonly');
    } catch (err) {
      rejectAll(err);
      return;
    }

    transaction.onabort = () =>
      rejectAll(normalizeIdbError(transaction.error, 'IndexedDB transaction aborted'));
    transaction.onerror = (event) =>
      rejectAll(normalizeIdbError(event.target.error, 'IndexedDB transaction error'));

    const store = transaction.objectStore(STORE_COSMETIC);
    for (const entry of batch) {
      const request = store.get(entry.hostname);
      request.onsuccess = () => entry.resolve(request.result?.selectors || []);
      request.onerror = (event) => {
        // §5.7: per the IndexedDB spec a request `error` event that is not
        // preventDefault()ed propagates to the transaction and ABORTS it. Since
        // §5.15 coalesced the service worker's whole ancestor walk into one
        // transaction, letting it propagate turns a single failed record into
        // "this page gets no cosmetic rules at all" via the rejectAll backstop
        // below. Contain the failure to the entry that owns it and let the rest
        // of the batch commit; onabort/onerror on the transaction stay as the
        // backstop for failures no request handler claims.
        event.preventDefault?.();
        event.stopPropagation?.();
        entry.reject(normalizeIdbError(event.target?.error, 'IndexedDB request error'));
      };
    }
  }

  /** Clear all indexed rules. */
  async clearActiveRules() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_COSMETIC, STORE_SCRIPTLET, STORE_PAGE_BUNDLES], 'readwrite');
      transaction.objectStore(STORE_COSMETIC).clear();
      transaction.objectStore(STORE_SCRIPTLET).clear();
      transaction.objectStore(STORE_PAGE_BUNDLES).clear();

      transaction.oncomplete = () => {
        this._bundleTouched.clear(); // §5.8 — the rows they describe are gone
        resolve();
      };
      rejectOnAbortOrError(transaction, reject);
    });
  }

  /** Backward-compatible alias for clearing the active rule index only. */
  async clear() {
    return this.clearActiveRules();
  }

  /** Replace multiple per-list source bundles. */
  async putBulkFilterSources(sourceMap) {
    const db = await this.open();
    const entries = Array.isArray(sourceMap)
      ? sourceMap
      : Object.entries(sourceMap || {}).map(([listId, data]) => ({ listId, ...data }));

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_FILTER_SOURCES], 'readwrite');
      const store = transaction.objectStore(STORE_FILTER_SOURCES);

      for (const entry of entries) {
        if (!entry?.listId) continue;
        store.put({
          listId: entry.listId,
          cosmetic: entry.cosmetic || { generic: [], domainSpecific: {}, exceptions: {} },
          scriptlets: entry.scriptlets || [],
        });
      }

      transaction.oncomplete = () => resolve();
      rejectOnAbortOrError(transaction, reject);
    });
  }

  /** Returns all stored per-list source bundles. */
  async getAllFilterSources() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_FILTER_SOURCES], 'readonly');
      const store = transaction.objectStore(STORE_FILTER_SOURCES);
      const request = store.getAll();
      rejectOnAbortOrError(transaction, reject);

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = (event) => reject(event.target.error);
    });
  }

  /** Returns true when at least one per-list source bundle is stored. */
  async hasFilterSources() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_FILTER_SOURCES], 'readonly');
      const store = transaction.objectStore(STORE_FILTER_SOURCES);
      const request = store.count();
      rejectOnAbortOrError(transaction, reject);

      request.onsuccess = () => resolve((request.result || 0) > 0);
      request.onerror = (event) => reject(event.target.error);
    });
  }

  /** Persist a compiled page bundle for a hostname. */
  async putPageBundle(hostname, bundle, version = null) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_PAGE_BUNDLES], 'readwrite');
      const store = transaction.objectStore(STORE_PAGE_BUNDLES);
      store.put({ hostname, bundle, version, updatedAt: Date.now() });

      transaction.oncomplete = () => resolve();
      rejectOnAbortOrError(transaction, reject);
    });
  }

  /**
   * Get a compiled page bundle for a hostname.
   *
   * §5.8 — this runs on every page load, so it is strictly a read: a
   * `readonly` transaction does not queue behind the active-index rebuild's
   * write locks, and a cache hit costs no disk write. The LRU stamp goes to
   * memory and reaches the row at the next prune. A record compiled under
   * another rule-data version is a miss and is left where it is: rows are
   * keyed by hostname, so the `putPageBundle` that follows the miss overwrites
   * it, and a stale row nobody revisits is never touched again, which puts it
   * first in line when `prunePageBundles` enforces the cap.
   */
  async getPageBundle(hostname, expectedVersion = null) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_PAGE_BUNDLES], 'readonly');
      const store = transaction.objectStore(STORE_PAGE_BUNDLES);
      const request = store.get(hostname);
      let bundle = null;

      request.onsuccess = () => {
        const record = request.result;
        if (record && expectedVersion && record.version !== expectedVersion) return;
        bundle = record?.bundle || null;
        if (record) this._touchPageBundle(hostname);
      };
      transaction.oncomplete = () => resolve(bundle);
      rejectOnAbortOrError(transaction, reject);
      request.onerror = (event) => reject(event.target.error);
    });
  }

  /**
   * §5.8 — record an LRU hit in memory. Re-inserting keeps the Map in touch
   * order, so at the cap the entry given up is the least recent touch.
   */
  _touchPageBundle(hostname) {
    this._bundleTouched.delete(hostname);
    if (this._bundleTouched.size >= PAGE_BUNDLE_TOUCH_MAX) {
      this._bundleTouched.delete(this._bundleTouched.keys().next().value);
    }
    this._bundleTouched.set(hostname, Date.now());
  }

  /** Clear persisted page bundles without touching the active rule index. */
  async clearPageBundles() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_PAGE_BUNDLES], 'readwrite');
      transaction.objectStore(STORE_PAGE_BUNDLES).clear();

      transaction.oncomplete = () => {
        this._bundleTouched.clear(); // §5.8 — the rows they describe are gone
        resolve();
      };
      rejectOnAbortOrError(transaction, reject);
    });
  }

  /**
   * Remove the least-recently-used page bundles above the provided cap.
   *
   * §5.8 — reads no longer stamp the row, so "recently used" is the stored
   * `updatedAt` merged with the in-memory touches. This is also where those
   * touches become durable: survivors get their merged stamp in the same
   * `readwrite` transaction as the evictions, off the page-load path. Under
   * the cap nothing is ranked, nothing is written and the touches are kept for
   * a pass that needs them.
   */
  async prunePageBundles(maxEntries) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) return 0;

    const db = await this.open();
    const records = await new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_PAGE_BUNDLES], 'readonly');
      const store = transaction.objectStore(STORE_PAGE_BUNDLES);
      const request = store.getAll();
      rejectOnAbortOrError(transaction, reject);

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = (event) => reject(event.target.error);
    });

    if (records.length <= maxEntries) return 0;

    const touched = new Map(this._bundleTouched);
    const lastUsed = (record) => Math.max(record.updatedAt || 0, touched.get(record.hostname) || 0);
    const ranked = [...records].sort((a, b) => lastUsed(a) - lastUsed(b));
    const staleRecords = ranked.slice(0, records.length - maxEntries);
    const survivors = ranked.slice(records.length - maxEntries);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_PAGE_BUNDLES], 'readwrite');
      const store = transaction.objectStore(STORE_PAGE_BUNDLES);

      for (const record of staleRecords) {
        if (record?.hostname) store.delete(record.hostname);
      }

      for (const record of survivors) {
        const touchedAt = touched.get(record.hostname) || 0;
        if (touchedAt <= (record.updatedAt || 0)) continue;
        // `records` is a snapshot from an earlier transaction: a rebuild's
        // clearPageBundles() or another putPageBundle may have committed since
        // (§5.3/§5.4). Stamp the row as it stands now — writing the snapshot
        // back would resurrect a cleared bundle or overwrite a recompiled one
        // under a version key that still matches.
        const request = store.get(record.hostname);
        request.onsuccess = () => {
          const current = request.result;
          if (current && (current.updatedAt || 0) < touchedAt) {
            store.put({ ...current, updatedAt: touchedAt });
          }
        };
      }

      transaction.oncomplete = () => {
        // The stamps are durable: drop the touches this pass consumed. A hit
        // recorded since the snapshot carries a newer stamp and stays.
        for (const [hostname, touchedAt] of touched) {
          if (this._bundleTouched.get(hostname) === touchedAt) this._bundleTouched.delete(hostname);
        }
        resolve(staleRecords.length);
      };
      rejectOnAbortOrError(transaction, reject);
    });
  }
}
