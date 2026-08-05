import assert from 'node:assert/strict';
import test from 'node:test';

import * as storage from './storage.js';

const { getStorage, getStorageBulk, setStorage, isQuotaError, StorageQuotaError } = storage;

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

// --- §5.11: lastError / undefined-result handling on reads -----------------

test('5.11: getStorageBulk resolves {} when the read fails with lastError and an undefined result', async () => {
  installChrome({ get: failingGet('An unexpected error occurred') });
  const result = await getStorageBulk(['a', 'b']);
  assert.deepEqual(result, {});
});

test('5.11: getStorage returns null (does not throw) when the underlying read fails', async () => {
  installChrome({ get: failingGet('An unexpected error occurred') });
  // Prior code resolved `undefined` from getStorageBulk, so this line threw
  // `TypeError: Cannot read properties of undefined`.
  assert.equal(await getStorage('anything'), null);
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
