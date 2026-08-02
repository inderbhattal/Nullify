import assert from 'node:assert/strict';
import test from 'node:test';

import { BloomFilter, BLOOM_FORMAT } from './bloom.js';

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
