/**
 * bloom.js — High-performance Bloom Filter for domain lookup.
 *
 * A Bloom Filter is a space-efficient probabilistic data structure used to 
 * test whether an element is a member of a set. False positives are possible, 
 * but false negatives are not.
 */

/**
 * Serialization format tag written by both this class and the Rust
 * serializer (`BLOOM_FORMAT` in wasm-core/src/lib.rs — keep in sync).
 *
 * Format 1 means "bit indices come from the 32-bit FNV-1a variant in
 * `_hash` below". Payloads without the field are legacy ones and are
 * accepted — they were produced by the same hash. An unknown format is
 * refused (empty filter fallback) so a future format change triggers a
 * rebuild instead of silently cross-loading incompatible bit patterns.
 */
export const BLOOM_FORMAT = 1;

export class BloomFilter {
  /**
   * @param {number} size - Size of the bitset in bits.
   * @param {number} hashes - Number of hash functions to use.
   */
  constructor(size = 256 * 1024, hashes = 4) {
    this.size = size;
    this.hashes = hashes;
    this.bitset = new Uint32Array(Math.ceil(size / 32));
  }

  /**
   * Create a filter sized appropriately for the expected number of items.
   * Uses ~10 bits per item for ~1% false positive rate.
   */
  static forCapacity(itemCount, hashes = 4) {
    const size = Math.max(64 * 1024, Math.ceil(itemCount * 10 / 32) * 32);
    return new BloomFilter(size, hashes);
  }

  /** Add a key to the filter. */
  add(key) {
    for (let i = 0; i < this.hashes; i++) {
      const hash = this._hash(key, i);
      const index = hash % this.size;
      this.bitset[index >>> 5] |= (1 << (index & 31));
    }
  }

  /** Returns true if the key might be in the set. */
  has(key) {
    for (let i = 0; i < this.hashes; i++) {
      const hash = this._hash(key, i);
      const index = hash % this.size;
      if (!(this.bitset[index >>> 5] & (1 << (index & 31)))) {
        return false;
      }
    }
    return true;
  }

  /** Serialize to a storable object. */
  serialize() {
    return {
      format: BLOOM_FORMAT,
      size: this.size,
      hashes: this.hashes,
      data: Array.from(this.bitset),
    };
  }

  /** Deserialize from a stored object. Legacy payloads (no format field) are
   * accepted; an unknown format degrades to an empty filter so stale bit
   * patterns are rebuilt rather than trusted. */
  static deserialize(stored) {
    if (stored.format !== undefined && stored.format !== BLOOM_FORMAT) {
      return new BloomFilter();
    }
    const filter = new BloomFilter(stored.size, stored.hashes);
    filter.bitset.set(stored.data);
    return filter;
  }

  /** Simple, fast FNV-1a inspired hash.
   *
   * Ported bit-identically to Rust (`calculate_hash` in
   * wasm-core/src/lib.rs) because the two engines cross-load each other's
   * serialized filters; any change here must land there too, and the golden
   * vectors in bloom.test.mjs / the Rust test suite must be regenerated. */
  _hash(key, seed) {
    let hash = 0x811c9dc5 ^ seed;
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return hash >>> 0;
  }
}
