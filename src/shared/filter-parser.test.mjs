import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchAndExpand, parseExpiresHeader, parseLine, parseFilterList, LIST_FETCH_MAX_BYTES } from './filter-parser.js';
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

  await withFetch((url) => {
    if (url.endsWith('root.txt')) return Promise.resolve(textResponse(root, { url }));
    return Promise.resolve(sizedResponse(perInclude, url));
  }, async () => {
    // 16 MB budget / 6 MB each: the third include overruns the SHARED budget.
    // §4.3: an include that fails now fails the list rather than being
    // skipped, so the overrun surfaces as a rejection naming the budget.
    await assert.rejects(
      fetchAndExpand('https://lists.example/root.txt'),
      /budget/,
      'the shared budget must cut off later includes',
    );
  });
});

test('5.9: the budget is not refilled per include — one huge child fails the list', async () => {
  await withFetch((url) => {
    if (url.endsWith('root.txt')) {
      return Promise.resolve(textResponse('!#include huge.txt', { url }));
    }
    return Promise.resolve(sizedResponse(LIST_FETCH_MAX_BYTES + 1, url));
  }, async () => {
    // §4.3: the oversized include fails the whole list (it used to be
    // skipped with a console.warn and the list stored without it).
    await assert.rejects(
      fetchAndExpand('https://lists.example/root.txt'),
      /huge\.txt.*budget/,
    );
  });
});

test('5.9: an http:// include inside an https list is refused, never fetched', async () => {
  const fetched = [];
  await withFetch((url) => {
    fetched.push(url);
    return Promise.resolve(textResponse(
      url.endsWith('root.txt') ? '!#include http://lists.example/sub.txt' : 'evil',
      { url },
    ));
  }, async () => {
    // §4.3: refused means the list is rejected, not expanded with a hole.
    await assert.rejects(
      fetchAndExpand('https://lists.example/root.txt'),
      /insecure include/i,
    );
  });

  assert.deepEqual(fetched, ['https://lists.example/root.txt'],
    'the http include must never reach fetch()');
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

// --- §4.3 (2026-09): an !#include that fails fails the whole list ------------
//
// The build has thrown on a failed sub-file since 2026-08 §5.10; the runtime
// copy kept returning '' for the include, and `fetchAndStoreRemoteFilterSources`
// then stored the surviving fraction over a good list and reported success.

test('4.3: a failed include rejects the whole list', async () => {
  const fetched = [];
  await withFetch((url) => {
    fetched.push(url);
    if (url.endsWith('easylist.txt')) {
      return Promise.resolve(textResponse(
        'example.com##.top-level-rule\n!#include easylist_general_block.txt',
        { url },
      ));
    }
    return Promise.resolve({ ok: false, status: 404, url });
  }, async () => {
    await assert.rejects(
      fetchAndExpand('https://lists.example/easylist.txt'),
      /easylist_general_block\.txt.*HTTP 404/,
      'a 404 on a sub-file must reject, naming the include URL',
    );
  });
  assert.ok(fetched.some((u) => u.endsWith('easylist_general_block.txt')),
    'the include must have been attempted');
});

test('4.3: an insecure include rejects instead of silently vanishing', async () => {
  const fetched = [];
  await withFetch((url) => {
    fetched.push(url);
    return Promise.resolve(textResponse(
      url.endsWith('root.txt') ? '!#include http://lists.example/sub.txt' : 'evil',
      { url },
    ));
  }, async () => {
    await assert.rejects(
      fetchAndExpand('https://lists.example/root.txt'),
      /insecure include/i,
    );
  });
  assert.deepEqual(fetched, ['https://lists.example/root.txt'],
    'the http include must never reach fetch()');
});

test('4.3: an include chain deeper than 5 levels rejects', async () => {
  // Every file includes the next one: root -> d1 -> d2 -> ... — never bottoms
  // out. The depth guard used to return '' and let the truncated list through.
  await withFetch((url) => {
    const level = Number((url.match(/d(\d+)\.txt$/) || [])[1] ?? 0);
    return Promise.resolve(textResponse(`!#include d${level + 1}.txt`, { url }));
  }, async () => {
    await assert.rejects(
      fetchAndExpand('https://lists.example/d0.txt'),
      /depth/i,
    );
  });
});

test('4.3 (didn\'t re-break): a list with no includes still resolves', async () => {
  await withFetch(() => Promise.resolve(textResponse('||ads.example^\n')), async () => {
    const text = await fetchAndExpand('https://lists.example/a.txt');
    assert.equal(text.trim(), '||ads.example^');
  });
});

// --- `! Expires:` header (Track A2a consumes this for per-list cadence) -------

test('parseExpiresHeader: "8 hours" -> 480 minutes', () => {
  const text = '[Adblock Plus 2.0]\n! Title: quick fixes\n! Expires: 8 hours\n! Version: 1\n';
  assert.equal(parseExpiresHeader(text), 480);
});

test('parseExpiresHeader: "4 days" -> 5760 minutes', () => {
  assert.equal(parseExpiresHeader('! Title: EasyList\n! Expires: 4 days (update frequency)\n'), 5760);
});

test('parseExpiresHeader: minutes, singular units, spacing and case', () => {
  assert.equal(parseExpiresHeader('!Expires:90 minutes\n'), 90);
  assert.equal(parseExpiresHeader('!  expires:  1 Day\n'), 1440);
  assert.equal(parseExpiresHeader('! EXPIRES: 1 hour\n'), 60);
});

test('parseExpiresHeader: absent, malformed, or past the 50-line header window -> null', () => {
  assert.equal(parseExpiresHeader('! Title: nothing here\n||ads.example^\n'), null);
  assert.equal(parseExpiresHeader('! Expires: soon\n'), null);
  assert.equal(parseExpiresHeader(''), null);
  assert.equal(parseExpiresHeader(null), null);
  const late = Array(50).fill('! filler').concat('! Expires: 8 hours').join('\n');
  assert.equal(parseExpiresHeader(late), null, 'line 51 is outside the header window');
  const edge = Array(49).fill('! filler').concat('! Expires: 8 hours').join('\n');
  assert.equal(parseExpiresHeader(edge), 480, 'line 50 is inside the header window');
});
