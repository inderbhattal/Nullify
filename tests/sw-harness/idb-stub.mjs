/**
 * Minimal in-memory IndexedDB fake covering exactly the surface RulesDB
 * (src/shared/db.js) touches: open (upgradeneeded/success/error), transaction
 * with oncomplete/onerror/onabort, object stores with put/get/getAll/delete/
 * clear/count, and a multiEntry index with getAll(key).
 *
 * Request callbacks fire on a microtask; transaction oncomplete fires on a
 * macrotask, so requests issued from other requests' onsuccess handlers (as
 * RulesDB.getPageBundle does) still land before completion.
 *
 * `_setFailure(err)` makes every subsequent transaction() call throw — used
 * to simulate a persistently broken IndexedDB (REVIEW §5.6).
 */

class StoreData {
  constructor(opts) {
    this.keyPath = opts?.keyPath ?? null;
    this.autoIncrement = !!opts?.autoIncrement;
    this.records = new Map();
    this.nextKey = 1;
    this.indexes = new Map(); // name -> { keyPath, multiEntry }
  }
}

export function makeIndexedDBStub() {
  const databases = new Map(); // name -> { version, stores: Map }
  let failure = null;

  function fireSuccess(request, result) {
    queueMicrotask(() => {
      request.result = result;
      request.onsuccess?.({ target: request });
    });
  }

  function makeRequest() {
    return { onsuccess: null, onerror: null, result: undefined, error: null };
  }

  function makeStoreHandle(storeData) {
    return {
      put(value) {
        if (failure) throw failure;
        let key = storeData.keyPath != null ? value?.[storeData.keyPath] : undefined;
        if (key === undefined) {
          if (!storeData.autoIncrement) throw new Error('No key for put()');
          key = storeData.nextKey++;
          if (storeData.keyPath != null) value = { ...value, [storeData.keyPath]: key };
        }
        storeData.records.set(key, structuredClone(value));
        const request = makeRequest();
        fireSuccess(request, key);
        return request;
      },
      get(key) {
        if (failure) throw failure;
        const record = storeData.records.get(key);
        const request = makeRequest();
        fireSuccess(request, record === undefined ? undefined : structuredClone(record));
        return request;
      },
      getAll() {
        if (failure) throw failure;
        const request = makeRequest();
        fireSuccess(request, [...storeData.records.values()].map((r) => structuredClone(r)));
        return request;
      },
      delete(key) {
        if (failure) throw failure;
        storeData.records.delete(key);
        const request = makeRequest();
        fireSuccess(request, undefined);
        return request;
      },
      clear() {
        if (failure) throw failure;
        storeData.records.clear();
        const request = makeRequest();
        fireSuccess(request, undefined);
        return request;
      },
      count() {
        if (failure) throw failure;
        const request = makeRequest();
        fireSuccess(request, storeData.records.size);
        return request;
      },
      createIndex(name, keyPath, opts = {}) {
        storeData.indexes.set(name, { keyPath, multiEntry: !!opts.multiEntry });
        return { name };
      },
      index(name) {
        const def = storeData.indexes.get(name);
        if (!def) throw new Error(`No index ${name}`);
        return {
          getAll(key) {
            if (failure) throw failure;
            const matches = [];
            for (const record of storeData.records.values()) {
              const indexed = record?.[def.keyPath];
              const hit = def.multiEntry && Array.isArray(indexed)
                ? indexed.includes(key)
                : indexed === key;
              if (hit) matches.push(structuredClone(record));
            }
            const request = makeRequest();
            fireSuccess(request, matches);
            return request;
          },
        };
      },
    };
  }

  function makeConnection(dbData) {
    return {
      onversionchange: null,
      close() {},
      transaction(names) {
        if (failure) throw failure;
        const tx = {
          oncomplete: null,
          onerror: null,
          onabort: null,
          error: null,
          objectStore(name) {
            const list = Array.isArray(names) ? names : [names];
            if (!list.includes(name)) throw new Error(`Store ${name} not in transaction scope`);
            const storeData = dbData.stores.get(name);
            if (!storeData) throw new Error(`No object store ${name}`);
            return makeStoreHandle(storeData);
          },
        };
        // Fire oncomplete on a macrotask: after every sync-issued request's
        // microtask AND any requests those handlers issued.
        setTimeout(() => tx.oncomplete?.({ target: tx }), 0);
        return tx;
      },
    };
  }

  return {
    open(name, version = 1) {
      const request = {
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
        result: null,
        error: null,
      };
      queueMicrotask(() => {
        if (failure) {
          request.error = failure;
          request.onerror?.({ target: request });
          return;
        }
        let dbData = databases.get(name);
        const oldVersion = dbData?.version || 0;
        if (!dbData) {
          dbData = { name, version, stores: new Map() };
          databases.set(name, dbData);
        }
        if (version > oldVersion) {
          dbData.version = version;
          const upgradeDb = {
            objectStoreNames: {
              contains: (storeName) => dbData.stores.has(storeName),
            },
            createObjectStore: (storeName, opts) => {
              const storeData = new StoreData(opts);
              dbData.stores.set(storeName, storeData);
              return makeStoreHandle(storeData);
            },
            deleteObjectStore: (storeName) => dbData.stores.delete(storeName),
          };
          request.onupgradeneeded?.({ target: { result: upgradeDb }, oldVersion });
        }
        const connection = makeConnection(dbData);
        request.result = connection;
        request.onsuccess?.({ target: { result: connection } });
      });
      return request;
    },
    deleteDatabase(name) {
      databases.delete(name);
      const request = makeRequest();
      fireSuccess(request, undefined);
      return request;
    },
    // Test-only handles:
    _setFailure(err) { failure = err || null; },
    _databases: databases,
  };
}
