import assert from 'node:assert/strict';
import test from 'node:test';

import { BloomFilter, BLOOM_FORMAT, MAX_BLOOM_BITS, MAX_BLOOM_HASHES } from './bloom.js';

// §4.1 — the JS and Rust bloom filters cross-load each other's serialized
// payloads, so their hashes must be bit-identical. These golden vectors are
// the JS half of the cross-engine pair; the identical values are asserted in
// wasm-core/src/lib.rs (`bloom_hash_matches_js_bit_indices`). If either
// engine drifts, its half fails.
const GOLDEN_SIZE = 256 * 1024;
const GOLDEN_INDICES = {
  'example.com': [60198, 41457, 105056, 128235],
  'ads.example.com': [65278, 200453, 245808, 110063],
  'tracker.evil.example': [46029, 30112, 29635, 78086],
  '': [40389, 40388, 40391, 40390],
};

function bitIndices(filter, key) {
  const indices = [];
  for (let seed = 0; seed < filter.hashes; seed++) {
    indices.push(filter._hash(key, seed) % filter.size);
  }
  return indices;
}

test('hash maps golden keys to the shared cross-engine bit indices', () => {
  const filter = new BloomFilter(GOLDEN_SIZE, 4);
  assert.equal(filter._hash('example.com', 0), 1125968678, 'raw 32-bit hash');
  for (const [key, expected] of Object.entries(GOLDEN_INDICES)) {
    assert.deepEqual(bitIndices(filter, key), expected, `indices for ${JSON.stringify(key)}`);
  }
});

test('membership round-trips through add/has', () => {
  const filter = new BloomFilter(GOLDEN_SIZE, 4);
  filter.add('example.com');
  filter.add('');
  assert.equal(filter.has('example.com'), true);
  assert.equal(filter.has(''), true);
  assert.equal(filter.has('definitely-not-added.example'), false);
});

test('serialize tags the payload with the shared format version', () => {
  const filter = new BloomFilter(1024, 4);
  filter.add('example.com');
  const stored = filter.serialize();
  assert.equal(stored.format, BLOOM_FORMAT);
  assert.equal(stored.size, 1024);
  assert.equal(stored.hashes, 4);
});

test('deserialize accepts current and legacy payloads', () => {
  const filter = new BloomFilter(1024, 4);
  filter.add('example.com');

  const current = BloomFilter.deserialize(filter.serialize());
  assert.equal(current.has('example.com'), true);

  // Legacy payloads predate the format field and used the same hash.
  const legacy = filter.serialize();
  delete legacy.format;
  const restored = BloomFilter.deserialize(legacy);
  assert.equal(restored.has('example.com'), true);
});

test('deserialize refuses an unknown format instead of trusting stale bits', () => {
  const filter = new BloomFilter(1024, 4);
  filter.add('example.com');
  const future = filter.serialize();
  future.format = BLOOM_FORMAT + 1;

  const refused = BloomFilter.deserialize(future);
  assert.equal(refused.has('example.com'), false, 'must fall back to an empty filter');
});

// --- §4.8: the JS deserializer must mirror the Rust semantic guards ---------
//
// The JS engine is the live fallback whenever WASM fails to initialize, so a
// payload `deserialize_from_json` (wasm-core/src/lib.rs) refuses must not be
// accepted here. Each case below is a real observed failure of the JS half.

test('4.8: a corrupt hashes:0 payload does not turn the gate into pass-all', () => {
  // The severe one: with `hashes === 0` the loop in has() never runs and every
  // key answers "maybe". The bloom gate silently stops gating — every
  // navigation pays a full IndexedDB lookup, forever, with nothing logged.
  const stored = { format: BLOOM_FORMAT, size: 1024, hashes: 0, data: new Array(32).fill(0) };
  const filter = BloomFilter.deserialize(stored);

  assert.equal(filter.has('anything-at-all.example'), false, 'must not answer maybe for every key');
  assert.ok(filter.hashes > 0, 'hashes must be clamped away from zero');
});

test('4.8: an absurd declared size is refused instead of allocating it', () => {
  // `{size: 2**31}` allocated a 256 MB Uint32Array *successfully*, so the
  // caller's try/catch never fired and the service-worker heap the Rust cap
  // protects took the hit anyway.
  const filter = BloomFilter.deserialize({ format: BLOOM_FORMAT, size: 2 ** 31, hashes: 4, data: [] });

  assert.ok(filter.size <= MAX_BLOOM_BITS, 'size must stay under the shared ceiling');
  assert.ok(filter.bitset.length <= Math.ceil(MAX_BLOOM_BITS / 32));
  assert.equal(filter.has('example.com'), false);
});

test('4.8: size exactly at and just past the shared ceiling', () => {
  const atCap = { format: BLOOM_FORMAT, size: MAX_BLOOM_BITS, hashes: 4, data: [] };
  // Length mismatch refuses it, but the point is the boundary is not "throw".
  assert.ok(BloomFilter.deserialize(atCap) instanceof BloomFilter);
  assert.ok(BloomFilter.deserialize({ ...atCap, size: MAX_BLOOM_BITS + 1 }).size <= MAX_BLOOM_BITS);
});

test('4.8: a data array that does not match the declared size degrades, never throws', () => {
  // Rust: `s.data.len() == s.size.div_ceil(32)`. JS used to call bitset.set()
  // with an oversized array, which throws RangeError — the
  // throw-instead-of-degrade shape the Rust fix removed.
  const short = { format: BLOOM_FORMAT, size: 1024, hashes: 4, data: [1, 2, 3] };
  const long = { format: BLOOM_FORMAT, size: 32, hashes: 4, data: [1, 2, 3, 4, 5] };

  for (const stored of [short, long]) {
    let filter;
    assert.doesNotThrow(() => { filter = BloomFilter.deserialize(stored); });
    assert.equal(filter.has('example.com'), false, 'must degrade to an empty filter');
  }
});

test('4.8: non-integer, negative and zero sizes are refused', () => {
  for (const size of [0, -1, 1.5, NaN, Infinity, '1024', null, undefined]) {
    const filter = BloomFilter.deserialize({ format: BLOOM_FORMAT, size, hashes: 4, data: [] });
    assert.ok(filter.size >= 1, `size ${String(size)} must not survive`);
    assert.equal(filter.has('example.com'), false);
  }
});

test('4.8: a hash count above the Rust u8 ceiling is refused', () => {
  // Rust types `hashes` as u8, so 256 fails serde there. Accepting it here
  // would mean the two engines disagree about what a stored filter is — and
  // has() is O(hashes), so a large value is also a per-lookup stall.
  const stored = { format: BLOOM_FORMAT, size: 1024, hashes: MAX_BLOOM_HASHES + 1, data: new Array(32).fill(0) };
  const filter = BloomFilter.deserialize(stored);
  assert.ok(filter.hashes <= MAX_BLOOM_HASHES);
});

test('4.8: a garbage payload shape degrades instead of throwing', () => {
  for (const stored of [null, undefined, 'nonsense', 42, {}, { format: BLOOM_FORMAT }]) {
    let filter;
    assert.doesNotThrow(() => { filter = BloomFilter.deserialize(stored); }, `for ${String(stored)}`);
    assert.ok(filter instanceof BloomFilter);
    assert.equal(filter.has('example.com'), false);
  }
});

test('4.8: the constructor clamps the same way Rust does', () => {
  assert.equal(new BloomFilter(0, 4).size, 1);
  assert.equal(new BloomFilter(-5, 4).size, 1);
  assert.equal(new BloomFilter(1024, 0).hashes, 1);
  assert.equal(new BloomFilter(2 ** 31, 4).size, MAX_BLOOM_BITS);
  // A clamped filter must still be usable, not a half-built object.
  const clamped = new BloomFilter(1024, 0);
  clamped.add('example.com');
  assert.equal(clamped.has('example.com'), true);
  assert.equal(clamped.has('not-added.example'), false);
});

test('4.8: a valid payload still round-trips unchanged', () => {
  const filter = new BloomFilter(1024, 4);
  filter.add('example.com');
  filter.add('ads.example.com');

  const restored = BloomFilter.deserialize(filter.serialize());
  assert.equal(restored.size, 1024);
  assert.equal(restored.hashes, 4);
  assert.equal(restored.has('example.com'), true);
  assert.equal(restored.has('ads.example.com'), true);
  assert.equal(restored.has('nope.example'), false);
});
