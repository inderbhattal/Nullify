import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchAndExpand, parseLine, parseFilterList, LIST_FETCH_MAX_BYTES } from './filter-parser.js';
import { FILTER_VECTORS } from '../../tests/fixtures/filter-vectors.mjs';
import { parseLine as buildParseLine } from '../../scripts/build-rules.mjs';

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

// --- §4.7: short cosmetic-scope aliases --------------------------------------

const SCOPE_VECTORS = FILTER_VECTORS.filter((v) => v.scopeException);

test('4.7: the runtime parser recognises the short $ghide/$ehide/$shide aliases', () => {
  assert.ok(SCOPE_VECTORS.length >= 6, 'fixture must carry the alias vectors');

  for (const { line, scopeException } of SCOPE_VECTORS) {
    const parsed = parseLine(line);
    assert.ok(parsed, `runtime parser dropped ${JSON.stringify(line)}`);
    assert.equal(parsed.type, 'cosmetic-scope-exception');
    assert.deepEqual(parsed.scopes, scopeException.scopes, `scopes for ${line}`);
    assert.deepEqual(parsed.domains, scopeException.domains, `domains for ${line}`);
  }
});

test('4.7: build and runtime parsers agree on every scope alias, scopes included', () => {
  // The parity suite's canonicalizer reduces this rule type to its kind, so
  // the alias-to-canonical mapping itself is only covered here: `ghide` must
  // become `generichide` in BOTH engines, not merely be recognised by both.
  for (const { line } of SCOPE_VECTORS) {
    assert.deepEqual(parseLine(line), buildParseLine(line), `engines disagree on ${line}`);
  }
});

test('4.7: unbreak-style $ghide lines feed the generic-cosmetic exclusion set', () => {
  // The end the parser serves: `cachedGenericCosmeticExcludedDomains` is
  // derived from this, and a dropped line means generic cosmetics keep being
  // applied on a domain uBO explicitly excepted.
  const { genericCosmeticExceptionDomains } = parseFilterList([
    '@@||example.com^$ghide',
    '@@||other.example^$ehide',
    '@@||third.example^$shide',
  ].join('\n'));

  assert.deepEqual(genericCosmeticExceptionDomains.sort(), ['example.com', 'other.example']);
});

test('4.7: a negated scope option is not a scope exception', () => {
  assert.equal(parseLine('@@||example.com^$~ghide'), null);
});

// --- §5.9: the fetch budget spans the whole !#include tree -------------------

/** A response of `bytes` length that streams in one chunk, without allocating it. */
function sizedResponse(bytes, url) {
  return {
    ok: true,
    url,
    body: {
      getReader() {
        let sent = false;
        return {
          read() {
            if (sent) return Promise.resolve({ done: true });
            sent = true;
            return Promise.resolve({ done: false, value: { byteLength: bytes } });
          },
        };
      },
    },
  };
}

test('5.9: the JS aggregate cap matches the Rust ingestion cap', () => {
  // MAX_FILTER_SOURCE_BYTES in wasm-core/src/lib.rs. A JS cap above it means
  // a list can pass every fetch check and then be dropped wholesale at
  // ingestion with one console line.
  assert.equal(LIST_FETCH_MAX_BYTES, 16 * 1024 * 1024);
});

test('5.9: parallel !#include sub-fetches share ONE byte budget', async () => {
  // Each sub-fetch is 6 MB — under any per-request cap. Four of them are 24 MB,
  // which must not be held at once. The bug: the cap was per call, so N
  // includes could each buy the full budget.
  const perInclude = 6 * 1024 * 1024;
  const root = [
    '!#include a.txt',
    '!#include b.txt',
    '!#include c.txt',
    '!#include d.txt',
  ].join('\n');

  let refused = 0;
  const originalWarn = console.warn;
  console.warn = (...args) => { if (String(args[1] ?? '').includes('.txt')) refused++; };
  try {
    await withFetch((url) => {
      if (url.endsWith('root.txt')) return Promise.resolve(textResponse(root, { url }));
      return Promise.resolve(sizedResponse(perInclude, url));
    }, async () => {
      await fetchAndExpand('https://lists.example/root.txt');
    });
  } finally {
    console.warn = originalWarn;
  }

  // 16 MB budget / 6 MB each: two land, the rest are refused and skipped.
  assert.ok(refused >= 1, 'the shared budget must cut off later includes');
});

test('5.9: the budget is not refilled per include — one huge child fails the list', async () => {
  await withFetch((url) => {
    if (url.endsWith('root.txt')) {
      return Promise.resolve(textResponse('!#include huge.txt', { url }));
    }
    return Promise.resolve(sizedResponse(LIST_FETCH_MAX_BYTES + 1, url));
  }, async () => {
    let warned = '';
    const originalWarn = console.warn;
    console.warn = (...args) => { warned += args.map(String).join(' '); };
    try {
      const text = await fetchAndExpand('https://lists.example/root.txt');
      assert.equal(text.trim(), '', 'the oversized include must contribute nothing');
    } finally {
      console.warn = originalWarn;
    }
    assert.match(warned, /budget/);
  });
});

test('5.9: an http:// include inside an https list is refused, never fetched', async () => {
  const fetched = [];
  let warned = '';
  const originalWarn = console.warn;
  console.warn = (...args) => { warned += args.map(String).join(' '); };
  try {
    await withFetch((url) => {
      fetched.push(url);
      return Promise.resolve(textResponse(
        url.endsWith('root.txt') ? '!#include http://lists.example/sub.txt' : 'evil',
        { url },
      ));
    }, async () => {
      const text = await fetchAndExpand('https://lists.example/root.txt');
      assert.equal(text.trim(), '', 'a plaintext include must expand to nothing');
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(fetched, ['https://lists.example/root.txt'],
    'the http include must never reach fetch()');
  assert.match(warned, /insecure include/i);
});

test('5.9: https includes, absolute and relative, still resolve', async () => {
  await withFetch((url) => {
    if (url.endsWith('root.txt')) {
      return Promise.resolve(textResponse(
        '!#include rel.txt\n!#include https://other.example/abs.txt',
        { url },
      ));
    }
    return Promise.resolve(textResponse(url.includes('rel') ? 'REL' : 'ABS', { url }));
  }, async () => {
    const text = await fetchAndExpand('https://lists.example/root.txt');
    assert.match(text, /REL/);
    assert.match(text, /ABS/);
  });
});
