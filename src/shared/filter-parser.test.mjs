import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchAndExpand } from './filter-parser.js';

// §5.10 / prior 2.6 — a hung or hostile CDN must not stall the service worker
// indefinitely or feed it an arbitrarily large response. These stub global
// fetch; each test restores it.

function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = original;
    });
}

function textResponse(text, { url = 'https://lists.example/a.txt' } = {}) {
  return {
    ok: true,
    url,
    body: {
      getReader() {
        const chunks = [new TextEncoder().encode(text)];
        return {
          read() {
            const value = chunks.shift();
            return Promise.resolve(value ? { done: false, value } : { done: true });
          },
        };
      },
    },
  };
}

test('5.10: a normal list fetch resolves and expands', async () => {
  await withFetch(() => Promise.resolve(textResponse('||ads.example^\n')), async () => {
    const text = await fetchAndExpand('https://lists.example/a.txt');
    assert.equal(text.trim(), '||ads.example^');
  });
});

test('5.10: a response over the byte cap is rejected, not buffered', async () => {
  // One oversized chunk: the reader must abort before decoding.
  const huge = {
    ok: true,
    url: 'https://lists.example/huge.txt',
    body: {
      getReader() {
        let sent = false;
        return {
          read() {
            if (sent) return Promise.resolve({ done: true });
            sent = true;
            // Lie about the byteLength instead of allocating 25 MB for real.
            return Promise.resolve({ done: false, value: { byteLength: 26 * 1024 * 1024 } });
          },
        };
      },
    },
  };
  await withFetch(() => Promise.resolve(huge), async () => {
    await assert.rejects(
      fetchAndExpand('https://lists.example/huge.txt'),
      /exceeds/,
    );
  });
});

test('5.10: the fetch is passed an abort signal for the timeout', async () => {
  let sawSignal = null;
  await withFetch((url, opts) => {
    sawSignal = opts?.signal;
    return Promise.resolve(textResponse(''));
  }, async () => {
    await fetchAndExpand('https://lists.example/a.txt');
  });
  assert.ok(sawSignal instanceof AbortSignal, 'fetch must receive the timeout AbortSignal');
});

test('5.10: an https fetch that lands on http is refused', async () => {
  await withFetch(
    () => Promise.resolve(textResponse('x', { url: 'http://lists.example/a.txt' })),
    async () => {
      await assert.rejects(
        fetchAndExpand('https://lists.example/a.txt'),
        /Insecure redirect/,
      );
    },
  );
});
