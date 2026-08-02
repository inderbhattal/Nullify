import assert from 'node:assert/strict';
import test from 'node:test';

import { RulesDB } from './db.js';
import { StorageQuotaError } from './storage.js';

// ---------------------------------------------------------------------------
// Minimal fake IndexedDB.
//
// Timing model: requests dispatch their callbacks on microtasks; transactions
// settle (oncomplete or onabort) on a macrotask (setTimeout), so every request
// issued synchronously — or from another request's success handler — runs
// before the transaction settles, matching real IDB ordering closely enough
// for these tests.
//
// `factory.nextTransactionAbort = err` makes the NEXT transaction fire
// `onabort` (with `transaction.error = err`) instead of `oncomplete`, while
// its requests still succeed — i.e. a commit-time abort (quota, forced
// close), the case §4.14 is about. The ABORT_WITH_NULL_ERROR sentinel aborts
// with `transaction.error = null`, as Chrome does on a forced close.
// ---------------------------------------------------------------------------

const ABORT_WITH_NULL_ERROR = Symbol('abort-with-null-error');

class FakeTransaction {
  constructor(db, abortError) {
    this._db = db;
    this._abortError = abortError;
    this._pending = 0;
    this._settled = false;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    setTimeout(() => this._maybeSettle(), 0);
  }

  objectStore(name) {
    return new FakeObjectStore(this._db._stores.get(name), this);
  }

  _request(compute) {
    const request = { onsuccess: null, onerror: null, result: undefined, transaction: this };
    this._pending++;
    queueMicrotask(() => {
      this._pending--;
      try {
        request.result = compute();
        request.onsuccess?.({ target: request });
      } catch (err) {
        request.onerror?.({ target: { error: err } });
      }
    });
    return request;
  }

  _maybeSettle() {
    if (this._pending > 0) {
      setTimeout(() => this._maybeSettle(), 0);
      return;
    }
    if (this._settled) return;
    this._settled = true;
    if (this._abortError) {
      this.error = this._abortError === ABORT_WITH_NULL_ERROR ? null : this._abortError;
      this.onabort?.({ target: this });
    } else {
      this.oncomplete?.({ target: this });
    }
  }
}

class FakeObjectStore {
  constructor(meta, transaction) {
    this._meta = meta;
    this._transaction = transaction;
  }

  put(value) {
    return this._transaction._request(() => {
      let key = value[this._meta.keyPath];
      if (key === undefined && this._meta.autoIncrement) {
        key = this._meta.nextId++;
        value = { ...value, [this._meta.keyPath]: key };
      }
      this._meta.records.set(key, value);
      return key;
    });
  }

  get(key) {
    return this._transaction._request(() => this._meta.records.get(key));
  }

  getAll() {
    return this._transaction._request(() => [...this._meta.records.values()]);
  }

  count() {
    return this._transaction._request(() => this._meta.records.size);
  }

  delete(key) {
    return this._transaction._request(() => { this._meta.records.delete(key); });
  }

  clear() {
    return this._transaction._request(() => { this._meta.records.clear(); });
  }

  index(name) {
    const keyPath = this._meta.indexes.get(name);
    return {
      getAll: (key) => this._transaction._request(() => {
        const out = [];
        for (const value of this._meta.records.values()) {
          const indexed = value[keyPath];
          if (Array.isArray(indexed) ? indexed.includes(key) : indexed === key) out.push(value);
        }
        return out;
      }),
    };
  }
}

class FakeDB {
  constructor(factory) {
    this._factory = factory;
    this._stores = new Map();
    this.onversionchange = null;
    this.closed = false;
    this.objectStoreNames = { contains: (name) => this._stores.has(name) };
  }

  createObjectStore(name, { keyPath, autoIncrement } = {}) {
    const meta = { keyPath, autoIncrement: !!autoIncrement, nextId: 1, records: new Map(), indexes: new Map() };
    this._stores.set(name, meta);
    return { createIndex: (indexName, indexKeyPath) => { meta.indexes.set(indexName, indexKeyPath); } };
  }

  deleteObjectStore(name) {
    this._stores.delete(name);
  }

  transaction(_names, _mode) {
    this._factory.transactionCount++;
    const abortError = this._factory.nextTransactionAbort;
    this._factory.nextTransactionAbort = null;
    return new FakeTransaction(this, abortError);
  }

  close() {
    this.closed = true;
  }
}

class FakeIDBFactory {
  constructor() {
    this.openCount = 0;
    this.transactionCount = 0;
    this.nextTransactionAbort = null;
  }

  open(_name, _version) {
    this.openCount++;
    const request = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: undefined };
    queueMicrotask(() => {
      const db = new FakeDB(this);
      request.result = db;
      request.onupgradeneeded?.({ target: { result: db }, oldVersion: 0 });
      request.onsuccess?.({ target: { result: db } });
    });
    return request;
  }
}

function installFakeIDB() {
  const factory = new FakeIDBFactory();
  globalThis.indexedDB = factory;
  return factory;
}

/** Race a promise against a timeout so a hung promise fails instead of stalling the runner. */
function settleOrTimeout(promise, ms = 250) {
  return Promise.race([
    promise.then(
      (value) => ({ settled: true, value }),
      (err) => ({ settled: true, err }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ settled: false }), ms)),
  ]);
}

// --- §4.14: commit-time aborts must reject, not hang -----------------------

test('4.14: a transaction abort with no request error rejects every wrapper instead of hanging', async () => {
  const factory = installFakeIDB();
  const db = new RulesDB();
  await db.open();

  const wrappers = {
    putBulkCosmeticRules: () => db.putBulkCosmeticRules({ 'example.com': ['.ad'] }),
    putBulkScriptletRules: () => db.putBulkScriptletRules([{ name: 's', domains: ['example.com'] }]),
    clearActiveRules: () => db.clearActiveRules(),
    putBulkFilterSources: () => db.putBulkFilterSources({ list1: {} }),
    putPageBundle: () => db.putPageBundle('example.com', { css: [] }),
    getPageBundle: () => db.getPageBundle('example.com'),
    clearPageBundles: () => db.clearPageBundles(),
  };

  for (const [name, run] of Object.entries(wrappers)) {
    factory.nextTransactionAbort = new Error(`forced abort in ${name}`);
    const outcome = await settleOrTimeout(run());
    assert.equal(outcome.settled, true, `${name} promise hung after transaction abort`);
    assert.ok(outcome.err, `${name} resolved instead of rejecting on abort`);
    assert.match(String(outcome.err.message), /forced abort/);
  }
});

test('4.14: an abort without a transaction.error still rejects with a real Error', async () => {
  const factory = installFakeIDB();
  const db = new RulesDB();
  await db.open();

  // Chrome can abort with transaction.error === null (e.g. forced close).
  factory.nextTransactionAbort = ABORT_WITH_NULL_ERROR;

  const outcome = await settleOrTimeout(db.clearPageBundles());
  assert.equal(outcome.settled, true, 'promise hung on abort with null error');
  assert.ok(outcome.err instanceof Error);
  assert.match(outcome.err.message, /aborted/);
});

// --- §5.16: quota aborts surface as a typed error --------------------------

test('5.16: a QuotaExceededError abort rejects with StorageQuotaError', async () => {
  const factory = installFakeIDB();
  const db = new RulesDB();
  await db.open();

  const quotaError = Object.assign(new Error('The current transaction exceeded its quota limitations.'), {
    name: 'QuotaExceededError',
  });
  factory.nextTransactionAbort = quotaError;

  await assert.rejects(
    db.putBulkCosmeticRules({ 'example.com': ['.ad'] }),
    (err) => err instanceof StorageQuotaError && err.code === 'QUOTA_EXCEEDED' && err.cause === quotaError,
  );
});

// --- §5.12: single connection, versionchange closes its own ---------------

test('5.12: concurrent open() calls share one in-flight open and one connection', async () => {
  const factory = installFakeIDB();
  const db = new RulesDB();

  const [a, b, c] = await Promise.all([db.open(), db.open(), db.open()]);
  assert.equal(factory.openCount, 1, 'expected a single physical indexedDB.open');
  assert.equal(a, b);
  assert.equal(b, c);
});

test('5.12: the versionchange handler closes its OWN connection, not whatever this.db points at', async () => {
  installFakeIDB();
  const db = new RulesDB();
  const conn = await db.open();

  // Simulate the stale-handler scenario: this.db has since moved on to a
  // different connection. The handler must still close `conn`, and must NOT
  // close the current connection.
  const impostor = { closed: false, close() { this.closed = true; } };
  db.db = impostor;

  conn.onversionchange();
  assert.equal(conn.closed, true, 'own connection was not closed');
  assert.equal(impostor.closed, false, 'handler closed the current connection instead of its own');
});

test('5.12: after a versionchange closes the active connection, open() reconnects fresh', async () => {
  const factory = installFakeIDB();
  const db = new RulesDB();
  const conn = await db.open();

  conn.onversionchange();
  assert.equal(conn.closed, true);
  assert.equal(db.db, null);

  const reopened = await db.open();
  assert.notEqual(reopened, conn);
  assert.equal(factory.openCount, 2);
});

// --- §5.15: cosmetic lookups share one transaction ------------------------

test('5.15: cosmetic lookups issued in one burst share a single readonly transaction', async () => {
  const factory = installFakeIDB();
  const db = new RulesDB();
  await db.putBulkCosmeticRules({
    'example.com': ['.top-ad'],
    'sub.example.com': ['.sub-ad'],
  });

  const before = factory.transactionCount;
  // The service worker's ancestor walk issues these synchronously and awaits
  // them together — exactly the burst that must be snapshot-consistent.
  const [sub, top, missing] = await Promise.all([
    db.getCosmeticRules('sub.example.com'),
    db.getCosmeticRules('example.com'),
    db.getCosmeticRules('nowhere.example.org'),
  ]);

  assert.deepEqual(sub, ['.sub-ad']);
  assert.deepEqual(top, ['.top-ad']);
  assert.deepEqual(missing, []);
  assert.equal(factory.transactionCount - before, 1, 'expected ONE transaction for the whole burst');
});

test('5.15: sequential cosmetic lookups still resolve independently', async () => {
  installFakeIDB();
  const db = new RulesDB();
  await db.putBulkCosmeticRules({ 'example.com': ['.a'] });

  assert.deepEqual(await db.getCosmeticRules('example.com'), ['.a']);
  assert.deepEqual(await db.getCosmeticRules('other.com'), []);
});

// --- happy paths still settle via oncomplete -------------------------------

test('happy path: scriptlet roundtrip including the generic bucket still works', async () => {
  installFakeIDB();
  const db = new RulesDB();
  await db.putBulkScriptletRules([
    { name: 'generic-one', domains: [] },
    { name: 'site-one', domains: ['example.com'] },
    { name: 'other-site', domains: ['other.com'] },
  ]);

  const rules = await db.getScriptletRules('www.example.com');
  const names = rules.map((r) => r.name).sort();
  assert.deepEqual(names, ['generic-one', 'site-one']);
});

test('happy path: page bundle roundtrip and prune still settle', async () => {
  installFakeIDB();
  const db = new RulesDB();
  await db.putPageBundle('a.com', { css: ['.a'] });
  await db.putPageBundle('b.com', { css: ['.b'] });

  const bundle = await db.getPageBundle('a.com');
  assert.deepEqual(bundle, { css: ['.a'] });

  const pruned = await db.prunePageBundles(1);
  assert.equal(pruned, 1);
});
