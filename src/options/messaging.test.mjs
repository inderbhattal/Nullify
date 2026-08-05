/**
 * Regression tests for the options-page messaging wrapper (§4.16).
 *
 * The service worker reports failure as `undefined`, `{error}`, or
 * `{ok:false}` — none of which reject the raw sendMessage promise. These
 * tests pin the wrapper's handling of every shape, plus the cap logic: the UI
 * measures UTF-8 bytes while the SW measures UTF-16 code units (§5.33), so the
 * invariant that matters is that the UI check is never the weaker of the two.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
// Cap logic (§5.33)
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

test('the UI check is never weaker than a UTF-16 code-unit check', () => {
  // The SW compares `raw.length`; this page compares UTF-8 bytes. UTF-8 length
  // is >= UTF-16 length for every string, so anything the page accepts the SW
  // accepts too — the error direction §5.33 calls safe. If the SW is ever
  // realigned to bytes this invariant still holds (it becomes equality).
  for (const sample of ['', 'abc', '||ads.example.com^', '€', 'ü'.repeat(10), '😀', '𝕏a€', '\u0000\u007f\u0080']) {
    assert.ok(
      utf8ByteLength(sample) >= sample.length,
      `UTF-8 length must not be below UTF-16 length for ${JSON.stringify(sample)}`,
    );
  }
});

test('MAX_USER_FILTERS_BYTES tracks the value declared in the service worker', () => {
  // Read as text rather than importing: importing src/background/ would
  // execute the worker. This fails on drift instead of pinning a literal that
  // silently diverges (§5.33).
  const swPath = new URL('../background/service-worker.js', import.meta.url);
  const source = readFileSync(swPath, 'utf8');
  const match = source.match(/\bMAX_USER_FILTERS_BYTES\s*=\s*([^;\n]+)/);
  assert.ok(match, 'MAX_USER_FILTERS_BYTES declaration not found in service-worker.js');

  // Accepts `2097152` and `2 * 1024 * 1024`. Anything else means the extractor
  // needs updating — deliberately loud rather than silently passing.
  const factors = match[1].split('*').map((part) => part.trim());
  assert.ok(
    factors.every((part) => /^\d+$/.test(part)),
    `Cannot evaluate SW cap expression "${match[1].trim()}" — update this extractor`,
  );
  const swCap = factors.reduce((product, part) => product * Number(part), 1);
  assert.equal(
    MAX_USER_FILTERS_BYTES,
    swCap,
    'options/messaging.js and the service worker disagree on the user-filter cap',
  );
});
