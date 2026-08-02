/**
 * Regression tests for the options-page messaging wrapper (§4.16).
 *
 * The service worker reports failure as `undefined`, `{error}`, or
 * `{ok:false}` — none of which reject the raw sendMessage promise. These
 * tests pin the wrapper's handling of every shape, plus the UTF-8 byte-cap
 * logic (the SW budget is bytes; `String.length` under-counts multi-byte).
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome stub, local to this test. The wrapper only touches
// chrome.runtime.sendMessage.
let sentMessages;
let nextResponse;

globalThis.chrome = {
  runtime: {
    sendMessage: async (message) => {
      sentMessages.push(message);
      if (nextResponse instanceof Error) throw nextResponse;
      return nextResponse;
    },
  },
};

const { call, utf8ByteLength, MAX_USER_FILTERS_BYTES } = await import('./messaging.js');

beforeEach(() => {
  sentMessages = [];
  nextResponse = undefined;
});

test('call() rejects when the response is undefined (no listener / SW gone)', async () => {
  nextResponse = undefined;
  await assert.rejects(call('GET_SETTINGS'), /no response from service worker/);
});

test('call() rejects on the {error} shape with the SW message', async () => {
  nextResponse = { error: 'User filters exceed 2097152 byte limit' };
  await assert.rejects(call('SET_USER_FILTERS', { filters: 'x' }), /exceed 2097152 byte limit/);
});

test('call() rejects on {ok:false}', async () => {
  nextResponse = { ok: false };
  await assert.rejects(call('ALLOW_SITE', { domain: 'bad' }), /ALLOW_SITE failed/);
});

test('call() prefers the error field when {ok:false, error} carries one', async () => {
  nextResponse = { ok: false, error: 'domain rejected' };
  await assert.rejects(call('ALLOW_SITE', { domain: 'bad' }), /domain rejected/);
});

test('call() resolves plain object responses untouched', async () => {
  nextResponse = { ok: true, allowlist: ['example.com'] };
  const resp = await call('ALLOW_SITE', { domain: 'example.com' });
  assert.deepEqual(resp, { ok: true, allowlist: ['example.com'] });
});

test('call() resolves array responses (GET_ALLOWLIST shape) untouched', async () => {
  nextResponse = ['a.com', 'b.com'];
  assert.deepEqual(await call('GET_ALLOWLIST'), ['a.com', 'b.com']);
});

test('call() resolves objects without ok/error (GET_SETTINGS shape)', async () => {
  nextResponse = { showBadge: false };
  assert.deepEqual(await call('GET_SETTINGS'), { showBadge: false });
});

test('call() omits the payload key when payload is undefined', async () => {
  nextResponse = {};
  await call('CHECK_FILTER_UPDATES');
  assert.deepEqual(sentMessages, [{ type: 'CHECK_FILTER_UPDATES' }]);
});

test('call() forwards the payload when given', async () => {
  nextResponse = {};
  await call('UPDATE_SETTINGS', { showBadge: true });
  assert.deepEqual(sentMessages, [{ type: 'UPDATE_SETTINGS', payload: { showBadge: true } }]);
});

test('call() propagates sendMessage rejections (port closed)', async () => {
  nextResponse = new Error('The message port closed before a response was received.');
  await assert.rejects(call('GET_USER_FILTERS'), /message port closed/);
});

// ---------------------------------------------------------------------------
// Byte-cap logic
// ---------------------------------------------------------------------------

test('utf8ByteLength counts ASCII 1:1 and multi-byte per encoded byte', () => {
  assert.equal(utf8ByteLength('abcd'), 4);
  assert.equal(utf8ByteLength('€'), 3); // .length === 1
  assert.equal(utf8ByteLength(''), 0);
  assert.equal(utf8ByteLength(null), 0);
});

test('cap check catches text whose .length is under budget but bytes are over', () => {
  // 700k '€' chars: .length 700_000 (well under 2 MiB) but 2.1M UTF-8 bytes.
  const text = '€'.repeat(700_000);
  assert.ok(text.length < MAX_USER_FILTERS_BYTES);
  assert.ok(utf8ByteLength(text) > MAX_USER_FILTERS_BYTES);
});

test('MAX_USER_FILTERS_BYTES matches the service-worker cap (2 MB)', () => {
  assert.equal(MAX_USER_FILTERS_BYTES, 2 * 1024 * 1024);
});
