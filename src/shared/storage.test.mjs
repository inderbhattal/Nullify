import assert from 'node:assert/strict';
import test from 'node:test';

import * as storage from './storage.js';

const {
  getStorage,
  getStorageBulk,
  getStorageBulkOrEmpty,
  getStorageOrDefault,
  getFeatureFlag,
  setStorage,
  isQuotaError,
  StorageQuotaError,
  StorageReadError,
  StorageKeys,
} = storage;

/**
 * Install a fake `chrome.storage.local`. Mirrors Chrome's callback contract:
 * on failure, `chrome.runtime.lastError` is set for the duration of the
 * callback and the result is `undefined`.
 */
function installChrome({ get, set } = {}) {
  const chrome = {
    runtime: { lastError: undefined },
    storage: {
      local: {
        get(keys, callback) { get(chrome, keys, callback); },
        set(items, callback) { set(chrome, items, callback); },
      },
    },
  };
  globalThis.chrome = chrome;
  return chrome;
}

function failingGet(message) {
  return (chrome, keys, callback) => {
    chrome.runtime.lastError = { message };
    callback(undefined);
    chrome.runtime.lastError = undefined;
  };
}

function failingSet(message) {
  return (chrome, items, callback) => {
    chrome.runtime.lastError = { message };
    callback();
    chrome.runtime.lastError = undefined;
  };
}

// --- REVIEW-2026-09 §3.1: a failed read must be distinguishable from empty --
//
// 2026-07 §5.11 made getStorageBulk resolve {} on lastError; every
// read-modify-write downstream then committed "empty" as authoritative. The
// strict readers now reject with StorageReadError; the lenient variants keep
// the old contract for consumers that write nothing.

test('3.1: getStorageBulk rejects with StorageReadError on lastError', async () => {
  installChrome({ get: failingGet('An unexpected error occurred') });
  await assert.rejects(
    getStorageBulk(['a', 'b']),
    (err) =>
      err instanceof StorageReadError &&
      err.name === 'StorageReadError' &&
      err.code === 'READ_FAILED' &&
      err.message === 'An unexpected error occurred',
  );
  // getStorage maps through getStorageBulk and inherits the rejection.
  await assert.rejects(getStorage('anything'), StorageReadError);
});

test('3.1: getStorageBulkOrEmpty resolves {} on lastError', async () => {
  installChrome({ get: failingGet('An unexpected error occurred') });
  assert.deepEqual(await getStorageBulkOrEmpty(['a', 'b']), {});

  installChrome({ get: (chrome, keys, callback) => { callback({ a: 1 }); } });
  assert.deepEqual(await getStorageBulkOrEmpty(['a', 'b']), { a: 1 });
});

test('3.1: getStorageOrDefault resolves the fallback on lastError and for a missing key', async () => {
  installChrome({ get: failingGet('An unexpected error occurred') });
  assert.deepEqual(await getStorageOrDefault('settings', { enabled: true }), { enabled: true });
  assert.equal(await getStorageOrDefault('settings'), null, 'the fallback defaults to null');

  installChrome({ get: (chrome, keys, callback) => { callback({}); } });
  assert.equal(await getStorageOrDefault('missing', 'fallback'), 'fallback');

  installChrome({ get: (chrome, keys, callback) => { callback({ present: 0 }); } });
  assert.equal(await getStorageOrDefault('present', 'fallback'), 0, 'a stored falsy value is not "missing"');
});

test('5.11 (kept): getStorage resolves null for an undefined result without lastError', async () => {
  // Chrome has been observed invoking the callback with `undefined` and NO
  // lastError. That is "empty", not "failed": the TypeError guard stays.
  installChrome({ get: (chrome, keys, callback) => { callback(undefined); } });
  assert.deepEqual(await getStorageBulk(['a']), {});
  assert.equal(await getStorage('anything'), null);
});

test('getFeatureFlag returns the default on a failed read', async () => {
  assert.equal(StorageKeys.FEATURE_FLAGS, 'featureFlags');

  installChrome({ get: failingGet('An unexpected error occurred') });
  assert.equal(await getFeatureFlag('refreshCadenceV2', false), false);
  assert.equal(await getFeatureFlag('refreshCadenceV2', true), true);

  let requested = null;
  installChrome({
    get: (chrome, keys, callback) => {
      requested = keys;
      callback({ featureFlags: { refreshCadenceV2: true, broken: 'yes' } });
    },
  });
  assert.deepEqual(requested, null);
  assert.equal(await getFeatureFlag('refreshCadenceV2', false), true, 'a stored flag wins over the default');
  assert.deepEqual(requested, ['featureFlags']);
  assert.equal(await getFeatureFlag('unset', true), true, 'an absent flag yields the default');
  assert.equal(await getFeatureFlag('broken', false), false, 'a non-boolean value is ignored');
});

test('5.11: getStorageBulk passes through a successful result unchanged', async () => {
  installChrome({
    get: (chrome, keys, callback) => { callback({ a: 1, b: 'two' }); },
  });
  assert.deepEqual(await getStorageBulk(['a', 'b']), { a: 1, b: 'two' });
  assert.equal(await getStorage('a'), 1);
});

test('5.11: getStorage still returns null for a missing key on a successful read', async () => {
  installChrome({ get: (chrome, keys, callback) => { callback({}); } });
  assert.equal(await getStorage('missing'), null);
});

// --- §5.16: quota errors on writes are typed -------------------------------

test('5.16: setStorage rejects with StorageQuotaError on a QUOTA_BYTES failure', async () => {
  installChrome({ set: failingSet('QUOTA_BYTES quota exceeded') });
  await assert.rejects(
    setStorage('key', 'value'),
    (err) =>
      err instanceof StorageQuotaError &&
      err.name === 'StorageQuotaError' &&
      err.code === 'QUOTA_EXCEEDED' &&
      isQuotaError(err),
  );
});

test('5.16: setStorage rejects with the original lastError for non-quota failures', async () => {
  installChrome({ set: failingSet('Some transient IO failure') });
  await assert.rejects(setStorage('key', 'value'), (err) => {
    assert.equal(err.message, 'Some transient IO failure');
    assert.ok(!(err instanceof StorageQuotaError));
    return true;
  });
});

test('5.16: setStorage resolves on success', async () => {
  let written = null;
  installChrome({
    set: (chrome, items, callback) => { written = items; callback(); },
  });
  await setStorage('key', 42);
  assert.deepEqual(written, { key: 42 });
});

test('5.16: isQuotaError recognizes quota shapes and rejects others', () => {
  assert.equal(isQuotaError(new StorageQuotaError('full')), true);
  assert.equal(isQuotaError(Object.assign(new Error('x'), { name: 'QuotaExceededError' })), true);
  assert.equal(isQuotaError({ message: 'QUOTA_BYTES quota exceeded' }), true);
  assert.equal(isQuotaError({ message: 'Quota exceeded while writing' }), true);
  assert.equal(isQuotaError(new Error('network down')), false);
  assert.equal(isQuotaError(null), false);
});

// --- §5.8: dead export removed ---------------------------------------------

test('5.8: the dead (never imported) isHostnameAllowed export is gone', () => {
  assert.equal('isHostnameAllowed' in storage, false);
});
