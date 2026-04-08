/**
 * db.js — IndexedDB wrapper for large rule indexing.
 *
 * Used primarily for cosmetic rules (tens of thousands of domain-specific rules)
 * to avoid loading them all into memory at once.
 */

const DB_NAME = 'NullifyRules';
const DB_VERSION = 2; // Incremented version
const STORE_COSMETIC = 'cosmetic_rules';
const STORE_SCRIPTLET = 'scriptlet_rules';

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
        const transaction = event.target.transaction;

        if (!db.objectStoreNames.contains(STORE_COSMETIC)) {
          db.createObjectStore(STORE_COSMETIC, { keyPath: 'hostname' });
        }
        if (!db.objectStoreNames.contains(STORE_SCRIPTLET)) {
          const store = db.createObjectStore(STORE_SCRIPTLET, { keyPath: 'id', autoIncrement: true });
          // Index by domain for faster lookup
          store.createIndex('domain', 'domains', { multiEntry: true, unique: false });
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
  async clear() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_COSMETIC, STORE_SCRIPTLET], 'readwrite');
      transaction.objectStore(STORE_COSMETIC).clear();
      transaction.objectStore(STORE_SCRIPTLET).clear();

      transaction.oncomplete = () => resolve();
      transaction.onerror = (event) => reject(event.target.error);
    });
  }
}
