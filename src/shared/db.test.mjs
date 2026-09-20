import assert from 'node:assert/strict';
import test from 'node:test';

import { RulesDB } from './db.js';
import { StorageQuotaError } from './storage.js';
import { makeIndexedDBStub } from '../../tests/sw-harness/idb-stub.mjs';

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
  constructor(db, abortError, abortImmediately = false) {
    this._db = db;
    this._abortError = abortError;
    this._pending = 0;
    this._settled = false;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    if (abortImmediately && abortError) {
      // Abort before any request settles — a forced close or IO error taking
      // the transaction down with reads still in flight. Nothing resolves.
      queueMicrotask(() => this._abort(abortError));
    }
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
        // Real IndexedDB semantics (§5.7): the `error` event bubbles to the
        // transaction and ABORTS it unless the handler calls preventDefault().
        // Modelling that is the whole point — without it the fake cannot show
        // that one failed get takes its siblings down with it.
        const event = {
          target: { error: err },
          defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true; },
          stopPropagation() {},
        };
        request.onerror?.(event);
        if (!event.defaultPrevented) this._abort(err);
      }
    });
    return request;
  }

  /** Abort mid-flight, as an unhandled request error does. */
  _abort(err) {
    if (this._settled) return;
    this._settled = true;
    this.error = err;
    this.onabort?.({ target: this });
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
    return this._transaction._request(() => {
      const failure = this._meta.failingKeys.get(key);
      if (failure) throw failure;
      return this._meta.records.get(key);
    });
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
    const meta = {
      keyPath,
      autoIncrement: !!autoIncrement,
      nextId: 1,
      records: new Map(),
      indexes: new Map(),
      // key -> Error: that key's `get` fails, as a corrupt or unreadable
      // record does in real IndexedDB.
      failingKeys: new Map(),
    };
    this._stores.set(name, meta);
    return { createIndex: (indexName, indexKeyPath) => { meta.indexes.set(indexName, indexKeyPath); } };
  }

  deleteObjectStore(name) {
    this._stores.delete(name);
  }

  transaction(_names, _mode) {
    this._factory.transactionCount++;
    const abortError = this._factory.nextTransactionAbort;
    const immediate = this._factory.nextTransactionAbortImmediate;
    this._factory.nextTransactionAbort = null;
    this._factory.nextTransactionAbortImmediate = false;
    return new FakeTransaction(this, abortError, immediate);
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
    this.nextTransactionAbortImmediate = false;
    this.lastDb = null;
  }

  /** Make `store.get(key)` fail for one key, as a corrupt record does. */
  failKey(storeName, key, error) {
    this.lastDb._stores.get(storeName).failingKeys.set(key, error);
  }

  open(_name, _version) {
    this.openCount++;
    const request = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: undefined };
    queueMicrotask(() => {
      const db = new FakeDB(this);
      this.lastDb = db;
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

// --- §5.7: one failed lookup must not poison the coalesced batch -----------

test('5.7: one failing get in a coalesced batch leaves every sibling resolving', async () => {
  // §5.15 put the service worker's whole ancestor walk in ONE transaction. A
  // request error that is not preventDefault()ed aborts that transaction, so
  // the rejectAll backstop rejected every sibling too and the page got no
  // cosmetic rules at all — a single-record failure escalated to a total
  // cosmetic outage for the page.
  const factory = installFakeIDB();
  const db = new RulesDB();
  await db.putBulkCosmeticRules({
    'sub.example.com': ['.sub-ad'],
    'example.com': ['.top-ad'],
    'other.example.com': ['.other-ad'],
  });
  factory.failKey('cosmetic_rules', 'example.com', new Error('unreadable record'));

  const results = await Promise.allSettled([
    db.getCosmeticRules('sub.example.com'),
    db.getCosmeticRules('example.com'),
    db.getCosmeticRules('other.example.com'),
  ]);

  assert.equal(results[0].status, 'fulfilled', 'sibling before the failure must still resolve');
  assert.deepEqual(results[0].value, ['.sub-ad']);
  assert.equal(results[1].status, 'rejected', 'the failing lookup itself must reject');
  assert.match(String(results[1].reason?.message), /unreadable record/);
  assert.equal(results[2].status, 'fulfilled', 'sibling after the failure must still resolve');
  assert.deepEqual(results[2].value, ['.other-ad']);
});

test('5.7: the transaction-level backstop still rejects the whole batch on abort', async () => {
  // Containing per-request errors must not disarm onabort/onerror: an abort no
  // request can be blamed for — forced close, IO error — has to settle every
  // waiter, or the whole batch hangs forever.
  const factory = installFakeIDB();
  const db = new RulesDB();
  await db.open();

  factory.nextTransactionAbort = new Error('forced mid-flight abort');
  factory.nextTransactionAbortImmediate = true;
  const results = await Promise.allSettled([
    db.getCosmeticRules('a.example.com'),
    db.getCosmeticRules('b.example.com'),
  ]);

  for (const result of results) {
    assert.equal(result.status, 'rejected', 'an unattributable abort must reject the whole batch');
    assert.match(String(result.reason?.message), /forced mid-flight abort/);
  }
});

// --- §5.11: site-scoped lookups honour exact membership --------------------

test('5.11: a rule keyed at a curated public suffix applies on that host', async () => {
  // `github.io` is both a public suffix and a real browsable site. The PSL walk
  // yielded nothing for it, so `github.io##+js(...)` could never fire — the
  // exact-membership fix reached the allowlist and stopped there.
  installFakeIDB();
  const db = new RulesDB();
  await db.putBulkScriptletRules([
    { id: 1, name: 'suffix-scoped', domains: ['github.io'] },
    { id: 2, name: 'generic-one', domains: [] },
  ]);

  const onSuffix = await db.getScriptletRules('github.io');
  assert.deepEqual(onSuffix.map((r) => r.name).sort(), ['generic-one', 'suffix-scoped']);
});

test('5.11: exact membership does not grant inheritance to subdomains', async () => {
  // The deliberate boundary: `user.github.io` must NOT pick up `github.io`
  // rules, or the fix re-opens the blanket-the-whole-suffix hole the PSL stop
  // exists to close.
  installFakeIDB();
  const db = new RulesDB();
  await db.putBulkScriptletRules([
    { id: 1, name: 'suffix-scoped', domains: ['github.io'] },
    { id: 2, name: 'site-scoped', domains: ['user.github.io'] },
  ]);

  const onSubdomain = await db.getScriptletRules('user.github.io');
  assert.deepEqual(onSubdomain.map((r) => r.name), ['site-scoped']);
});

test('5.11: an unnormalized hostname cannot walk past the public suffix', async () => {
  // `bbc.co.uk.` used to walk to `uk.` and `WWW.EXAMPLE.COM` to `COM`, because
  // neither spelling is in the suffix set. A rule indexed at a TLD would then
  // have matched every site under it.
  installFakeIDB();
  const db = new RulesDB();
  await db.putBulkScriptletRules([
    { id: 1, name: 'tld-blanket', domains: ['uk'] },
    { id: 2, name: 'com-blanket', domains: ['com'] },
    { id: 3, name: 'legit', domains: ['bbc.co.uk'] },
    { id: 4, name: 'legit-com', domains: ['example.com'] },
  ]);

  const trailingDot = await db.getScriptletRules('bbc.co.uk.');
  assert.deepEqual(trailingDot.map((r) => r.name), ['legit'],
    'trailing-dot hostname must not reach a TLD-keyed rule');

  const upperCase = await db.getScriptletRules('WWW.EXAMPLE.COM');
  assert.deepEqual(upperCase.map((r) => r.name), ['legit-com'],
    'upper-case hostname must normalize, not walk to COM');
});

// --- §5.8 (REVIEW-2026-09): page-bundle reads are read-only ---------------
//
// These run on the SW harness's IndexedDB stub rather than the fake above: it
// logs the mode of every transaction() call and exposes the stored rows.

function installIdbStub() {
  const idb = makeIndexedDBStub();
  globalThis.indexedDB = idb;
  return idb;
}

/** The live `hostname -> record` Map behind the page_bundles store. */
function pageBundleRows(idb) {
  return idb._databases.get('NullifyRules').stores.get('page_bundles').records;
}

/** Pin Date.now() so LRU stamps are exact; restored when the test ends. */
function installClock(t, start) {
  const realNow = Date.now;
  let now = start;
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  return { set(value) { now = value; } };
}

test('5.8: getPageBundle opens a readonly transaction and writes nothing', async (t) => {
  // getPageBundle runs on every page load. As a `readwrite` transaction it
  // queued behind the active-index rebuild's write locks, and its LRU stamp
  // turned every cache hit into a disk write.
  const clock = installClock(t, 1_000);
  const idb = installIdbStub();
  const db = new RulesDB();
  await db.putPageBundle('a.com', { css: ['.a'] }, 'v1');
  const rowAsStored = structuredClone(pageBundleRows(idb).get('a.com'));
  assert.equal(rowAsStored.updatedAt, 1_000, 'precondition: the put stamped the row');

  clock.set(2_000);
  const mark = idb._transactions.length;
  assert.deepEqual(await db.getPageBundle('a.com', 'v1'), { css: ['.a'] });

  assert.deepEqual(idb._transactions.slice(mark), [{ store: 'page_bundles', mode: 'readonly' }],
    'a cache hit must open exactly one transaction, and only for reading');
  assert.deepEqual(pageBundleRows(idb).get('a.com'), rowAsStored,
    'a cache hit must not rewrite the row — the LRU stamp included');
});

test('5.8: a version mismatch is a miss that leaves the row for putPageBundle to overwrite', async (t) => {
  // The read path used to delete the stale record — a write, and one more
  // reason the transaction was `readwrite`. Rows are keyed by hostname, so the
  // put that follows a miss replaces the stale record in place.
  const clock = installClock(t, 1_000);
  const idb = installIdbStub();
  const db = new RulesDB();
  await db.putPageBundle('a.com', { css: ['.old'] }, 'v1');

  clock.set(2_000);
  const mark = idb._transactions.length;
  assert.equal(await db.getPageBundle('a.com', 'v2'), null);
  assert.deepEqual(idb._transactions.slice(mark), [{ store: 'page_bundles', mode: 'readonly' }]);
  assert.deepEqual(pageBundleRows(idb).get('a.com'),
    { hostname: 'a.com', bundle: { css: ['.old'] }, version: 'v1', updatedAt: 1_000 },
    'the read path must neither delete nor restamp the stale row');

  clock.set(3_000);
  await db.putPageBundle('a.com', { css: ['.new'] }, 'v2');
  assert.deepEqual([...pageBundleRows(idb).keys()], ['a.com'],
    'the put replaces the stale row, it does not add a second one');
  assert.deepEqual(await db.getPageBundle('a.com', 'v2'), { css: ['.new'] });
});

test('5.8: stale-version rows count against the prune cap and are evicted first', async (t) => {
  // Nothing deletes a stale row eagerly any more, so the cap has to hold for
  // them too. A version miss is not an LRU hit: the row's stamp only ages, and
  // the prune takes it before any row of the current version — even when the
  // stale hostnames are the ones asked for most recently.
  const clock = installClock(t, 1_000);
  const idb = installIdbStub();
  const db = new RulesDB();
  await db.putPageBundle('stale-1.com', { css: [] }, 'v1');
  clock.set(2_000);
  await db.putPageBundle('stale-2.com', { css: [] }, 'v1');
  clock.set(3_000);
  await db.putPageBundle('fresh-1.com', { css: [] }, 'v2');
  clock.set(4_000);
  await db.putPageBundle('fresh-2.com', { css: [] }, 'v2');

  clock.set(5_000);
  assert.equal(await db.getPageBundle('stale-1.com', 'v2'), null);
  assert.equal(await db.getPageBundle('stale-2.com', 'v2'), null);

  clock.set(6_000);
  assert.equal(await db.prunePageBundles(2), 2);
  assert.deepEqual([...pageBundleRows(idb).keys()].sort(), ['fresh-1.com', 'fresh-2.com']);
});

test('5.8 (didn\'t re-break): getPageBundle still returns null for a stale version', async () => {
  // What the read path answers is unchanged — only what it does to the store.
  installIdbStub();
  const db = new RulesDB();
  await db.putPageBundle('a.com', { css: ['.a'] }, 'v1');
  await db.putPageBundle('b.com', { css: ['.b'] }, 'v1');

  assert.deepEqual(await db.getPageBundle('a.com', 'v1'), { css: ['.a'] }, 'the matching version is a hit');
  assert.deepEqual(await db.getPageBundle('a.com'), { css: ['.a'] }, 'no expected version accepts any row');
  assert.equal(await db.getPageBundle('nowhere.com', 'v1'), null, 'an unknown hostname is a miss');
  assert.equal(await db.getPageBundle('b.com', 'v2'), null, 'a bundle stored under another version is a miss');
});

test('5.8: prunePageBundles evicts by in-memory touch order', async (t) => {
  // The hit no longer stamps the row, so the prune has to rank by the stored
  // `updatedAt` merged with the in-memory touches — otherwise the bundle that
  // was served a moment ago is the first one evicted.
  const clock = installClock(t, 1_000);
  const idb = installIdbStub();
  const db = new RulesDB();
  await db.putPageBundle('a.com', { css: ['.a'] });
  clock.set(2_000);
  await db.putPageBundle('b.com', { css: ['.b'] });
  clock.set(3_000);
  await db.putPageBundle('c.com', { css: ['.c'] });

  clock.set(4_000);
  await db.getPageBundle('a.com'); // oldest on disk, most recently used
  assert.equal(pageBundleRows(idb).get('a.com').updatedAt, 1_000,
    'precondition: the hit exists in memory only');

  clock.set(5_000);
  assert.equal(await db.prunePageBundles(2), 1);
  assert.deepEqual([...pageBundleRows(idb).keys()].sort(), ['a.com', 'c.com'],
    'b.com is the least recently USED row; a.com was served after it was stored');

  // The prune is also where the touches become durable: the survivor gets
  // its merged stamp, written as the moment of the hit, and the map empties.
  assert.equal(pageBundleRows(idb).get('a.com').updatedAt, 4_000);
  assert.equal(pageBundleRows(idb).get('c.com').updatedAt, 3_000, 'an untouched survivor keeps its stamp');
  assert.equal(db._bundleTouched.size, 0, 'flushed touches are dropped');

  // A new worker life starts with no touches, so only the flushed stamp can
  // keep a.com ahead of c.com now.
  const nextLife = new RulesDB();
  clock.set(6_000);
  await nextLife.putPageBundle('d.com', { css: ['.d'] });
  assert.equal(await nextLife.prunePageBundles(2), 1);
  assert.deepEqual([...pageBundleRows(idb).keys()].sort(), ['a.com', 'd.com']);
});

test('5.8: a prune under the cap writes nothing and keeps the touches for a later pass', async (t) => {
  const clock = installClock(t, 1_000);
  const idb = installIdbStub();
  const db = new RulesDB();
  await db.putPageBundle('a.com', { css: ['.a'] });
  clock.set(2_000);
  await db.putPageBundle('b.com', { css: ['.b'] });
  clock.set(3_000);
  await db.getPageBundle('a.com');

  const mark = idb._transactions.length;
  assert.equal(await db.prunePageBundles(2), 0);
  assert.deepEqual(idb._transactions.slice(mark), [{ store: 'page_bundles', mode: 'readonly' }],
    'nothing to evict: the prune must not take a write lock either');

  // The touch has to survive that no-op, or the next real prune evicts the
  // row that was just served.
  clock.set(4_000);
  await db.putPageBundle('c.com', { css: ['.c'] });
  assert.equal(await db.prunePageBundles(2), 1);
  assert.deepEqual([...pageBundleRows(idb).keys()].sort(), ['a.com', 'c.com']);
});

test('5.8: the stamp write-back cannot resurrect or clobber a row that changed under the prune', async (t) => {
  // The prune ranks from a readonly snapshot and writes in a second
  // transaction. A rebuild's clearPageBundles() — or another putPageBundle —
  // can commit in between, and writing the snapshot's copy back would then
  // resurrect a bundle compiled against the old index (or overwrite the new
  // one) under a version key that still matches. The stamp must be applied to
  // the row as it stands inside the write transaction.
  const clock = installClock(t, 0);
  const idb = installIdbStub();
  const db = new RulesDB();
  for (const [index, hostname] of ['a.com', 'b.com', 'c.com', 'd.com'].entries()) {
    clock.set(1_000 * (index + 1));
    await db.putPageBundle(hostname, { css: [hostname] }, 'v1');
  }
  clock.set(5_000);
  await db.getPageBundle('a.com', 'v1');
  await db.getPageBundle('b.com', 'v1');

  // Between the snapshot and the write transaction: a.com is cleared and
  // b.com is recompiled.
  const recompiled = { hostname: 'b.com', bundle: { css: ['.recompiled'] }, version: 'v1', updatedAt: 6_000 };
  const conn = await db.open();
  const openTransaction = conn.transaction.bind(conn);
  conn.transaction = (names, mode) => {
    if (mode === 'readwrite') {
      conn.transaction = openTransaction;
      pageBundleRows(idb).delete('a.com');
      pageBundleRows(idb).set('b.com', structuredClone(recompiled));
    }
    return openTransaction(names, mode);
  };

  clock.set(7_000);
  assert.equal(await db.prunePageBundles(3), 1, 'c.com is evicted: a.com and b.com were touched, d.com is newer');
  assert.equal(conn.transaction, openTransaction, 'precondition: the interleaving ran');

  assert.equal(pageBundleRows(idb).has('a.com'), false, 'a row cleared under the prune must stay cleared');
  assert.deepEqual(pageBundleRows(idb).get('b.com'), recompiled,
    'a row recompiled under the prune keeps its new bundle and its newer stamp');
});

test('5.8: clearing the page bundles drops the touches that described them', async () => {
  installIdbStub();
  const db = new RulesDB();

  for (const clear of ['clearPageBundles', 'clearActiveRules']) {
    await db.putPageBundle('a.com', { css: ['.a'] });
    await db.getPageBundle('a.com');
    assert.equal(db._bundleTouched.has('a.com'), true, 'precondition: the hit was recorded');

    await db[clear]();
    assert.equal(db._bundleTouched.size, 0, `${clear} left touches for rows that no longer exist`);
  }
});

test('5.8: the touch map is capped and drops the least recent touch first', async (t) => {
  // A worker can live for hours and the prune only runs after a put, so the
  // map needs a bound of its own. Seed it to the cap, then record real hits.
  const { PAGE_BUNDLE_TOUCH_MAX } = await import('./db.js');
  assert.ok(Number.isInteger(PAGE_BUNDLE_TOUCH_MAX) && PAGE_BUNDLE_TOUCH_MAX > 0,
    'db.js must export the touch cap');

  const clock = installClock(t, 1_000);
  installIdbStub();
  const db = new RulesDB();
  await db.putPageBundle('seed-5.com', { css: [] });
  await db.putPageBundle('new.com', { css: [] });
  for (let i = 0; i < PAGE_BUNDLE_TOUCH_MAX; i++) db._bundleTouched.set(`seed-${i}.com`, i);

  // A repeat hit at the cap costs nobody their touch: it moves to the back of
  // the queue instead of taking a new slot.
  clock.set(2_000);
  await db.getPageBundle('seed-5.com');
  assert.equal(db._bundleTouched.size, PAGE_BUNDLE_TOUCH_MAX, 'a repeat hit must not evict anything');
  assert.equal(db._bundleTouched.get('seed-5.com'), 2_000);
  assert.equal([...db._bundleTouched.keys()].at(-1), 'seed-5.com', 'a repeat hit becomes the most recent touch');

  // A new hostname at the cap gives up the least recent touch, seed-0.com.
  clock.set(3_000);
  await db.getPageBundle('new.com');
  assert.equal(db._bundleTouched.size, PAGE_BUNDLE_TOUCH_MAX, 'the map must not grow past the cap');
  assert.equal(db._bundleTouched.get('new.com'), 3_000);
  assert.equal(db._bundleTouched.has('seed-0.com'), false, 'the least recent touch is the one dropped');
  assert.equal(db._bundleTouched.has('seed-1.com'), true, 'and only that one');
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
