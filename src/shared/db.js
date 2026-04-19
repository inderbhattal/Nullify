/**
 * db.js — IndexedDB wrapper for large rule indexing.
 *
 * Used primarily for cosmetic rules (tens of thousands of domain-specific rules)
 * to avoid loading them all into memory at once.
 */

const DB_NAME = 'NullifyRules';
const DB_VERSION = 4;
const STORE_COSMETIC = 'cosmetic_rules';
const STORE_SCRIPTLET = 'scriptlet_rules';
const STORE_FILTER_SOURCES = 'filter_sources';
const STORE_PAGE_BUNDLES = 'page_bundles';

export class RulesDB {
  constructor() {
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

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
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }

  /** Bulk insert scriptlet rules. */
  async putBulkScriptletRules(rules) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_SCRIPTLET], 'readwrite');
      const store = transaction.objectStore(STORE_SCRIPTLET);
      
      for (const rule of rules) {
        store.put(rule);
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = (event) => reject(event.target.error);
    });
  }

  /** Get scriptlets matching a domain. */
  async getScriptletRules(hostname) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_SCRIPTLET], 'readonly');
      const store = transaction.objectStore(STORE_SCRIPTLET);
      const index = store.index('domain');
      
      const parts = hostname.split('.');
      const domainsToCheck = ['', ...parts.map((_, i) => parts.slice(i).join('.'))];
      
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
      transaction.onerror = (event) => reject(event.target.error);
    });
  }

  /** Get rules for a single domain. */
  async getCosmeticRules(hostname) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_COSMETIC], 'readonly');
      const store = transaction.objectStore(STORE_COSMETIC);
      const request = store.get(hostname);

      request.onsuccess = () => resolve(request.result?.selectors || []);
      request.onerror = (event) => reject(event.target.error);
    });
  }

  /** Clear all indexed rules. */
  async clearActiveRules() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_COSMETIC, STORE_SCRIPTLET, STORE_PAGE_BUNDLES], 'readwrite');
      transaction.objectStore(STORE_COSMETIC).clear();
      transaction.objectStore(STORE_SCRIPTLET).clear();
      transaction.objectStore(STORE_PAGE_BUNDLES).clear();

      transaction.oncomplete = () => resolve();
      transaction.onerror = (event) => reject(event.target.error);
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
      transaction.onerror = (event) => reject(event.target.error);
    });
  }

  /** Returns all stored per-list source bundles. */
  async getAllFilterSources() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_FILTER_SOURCES], 'readonly');
      const store = transaction.objectStore(STORE_FILTER_SOURCES);
      const request = store.getAll();

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

      request.onsuccess = () => resolve((request.result || 0) > 0);
      request.onerror = (event) => reject(event.target.error);
    });
  }

  /** Persist a compiled page bundle for a hostname. */
  async putPageBundle(hostname, bundle) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_PAGE_BUNDLES], 'readwrite');
      const store = transaction.objectStore(STORE_PAGE_BUNDLES);
      store.put({ hostname, bundle, updatedAt: Date.now() });

      transaction.oncomplete = () => resolve();
      transaction.onerror = (event) => reject(event.target.error);
    });
  }

  /** Get a compiled page bundle for a hostname. */
  async getPageBundle(hostname) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_PAGE_BUNDLES], 'readwrite');
      const store = transaction.objectStore(STORE_PAGE_BUNDLES);
      const request = store.get(hostname);
      let bundle = null;

      request.onsuccess = () => {
        const record = request.result;
        bundle = record?.bundle || null;
        if (record) {
          store.put({ ...record, updatedAt: Date.now() });
        }
      };
      transaction.oncomplete = () => resolve(bundle);
      transaction.onerror = (event) => reject(event.target.error);
      request.onerror = (event) => reject(event.target.error);
    });
  }

  /** Clear persisted page bundles without touching the active rule index. */
  async clearPageBundles() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_PAGE_BUNDLES], 'readwrite');
      transaction.objectStore(STORE_PAGE_BUNDLES).clear();

      transaction.oncomplete = () => resolve();
      transaction.onerror = (event) => reject(event.target.error);
    });
  }

  /** Remove the least-recently-used page bundles above the provided cap. */
  async prunePageBundles(maxEntries) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) return 0;

    const db = await this.open();
    const records = await new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_PAGE_BUNDLES], 'readonly');
      const store = transaction.objectStore(STORE_PAGE_BUNDLES);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = (event) => reject(event.target.error);
    });

    if (records.length <= maxEntries) return 0;

    const staleRecords = [...records]
      .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
      .slice(0, records.length - maxEntries);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_PAGE_BUNDLES], 'readwrite');
      const store = transaction.objectStore(STORE_PAGE_BUNDLES);

      for (const record of staleRecords) {
        if (record?.hostname) store.delete(record.hostname);
      }

      transaction.oncomplete = () => resolve(staleRecords.length);
      transaction.onerror = (event) => reject(event.target.error);
    });
  }
}
