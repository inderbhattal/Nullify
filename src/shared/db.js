/**
 * db.js — IndexedDB wrapper for large rule indexing.
 *
 * Used primarily for cosmetic rules (tens of thousands of domain-specific rules)
 * to avoid loading them all into memory at once.
 */

const DB_NAME = 'NullifyRules';
const DB_VERSION = 1;
const STORE_COSMETIC = 'cosmetic_rules';

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
      const transaction = db.transaction([STORE_COSMETIC], 'readwrite');
      const store = transaction.objectStore(STORE_COSMETIC);
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = (event) => reject(event.target.error);
    });
  }
}
