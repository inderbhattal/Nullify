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

/**
 * Upper bound on a filter's bit count: 128 Mbit, i.e. a 16 MB bitset. Mirrors
 * `MAX_BLOOM_BITS` in wasm-core/src/lib.rs — keep in sync.
 */
export const MAX_BLOOM_BITS = 1 << 27;

/**
 * Upper bound on the hash count. The Rust struct types `hashes` as `u8`, so a
 * payload declaring more than 255 fails serde deserialization there and must
 * be refused here too, or the two engines disagree about what a stored filter
 * means. It also bounds the per-lookup work: `has()` is O(hashes).
 */
export const MAX_BLOOM_HASHES = 255;

const DEFAULT_SIZE = 256 * 1024;
const DEFAULT_HASHES = 4;

/** `size.clamp(1, MAX_BLOOM_BITS)` from the Rust constructor. */
function clampSize(size) {
  const n = Math.trunc(Number(size));
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(n, 1), MAX_BLOOM_BITS);
}

/** `hashes.max(1)` from the Rust constructor, plus the implicit u8 ceiling. */
function clampHashes(hashes) {
  const n = Math.trunc(Number(hashes));
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(n, 1), MAX_BLOOM_HASHES);
}

export class BloomFilter {
  /**
   * @param {number} size - Size of the bitset in bits.
   * @param {number} hashes - Number of hash functions to use.
   *
   * Both arguments are clamped, exactly as the Rust constructor clamps them
   * (§4.8). `size = 0` makes `hash % size` NaN so every bit test misses;
   * `hashes = 0` makes the loop in `has()` never run, so it returns `true`
   * unconditionally — a bloom gate that answers "maybe" for every key, which
   * costs a full IndexedDB lookup on every navigation and reports nothing. An
   * absurd `size` allocates hundreds of megabytes inside a service worker
   * whose heap is small.
   */
  constructor(size = DEFAULT_SIZE, hashes = DEFAULT_HASHES) {
    this.size = clampSize(size);
    this.hashes = clampHashes(hashes);
    this.bitset = new Uint32Array(Math.ceil(this.size / 32));
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

  /**
   * Deserialize from a stored object. Legacy payloads (no format field) are
   * accepted; anything that fails validation degrades to an empty filter so
   * stale or corrupt bit patterns are rebuilt rather than trusted.
   *
   * §4.8 — this mirrors `deserialize_from_json` in wasm-core/src/lib.rs
   * clause for clause. The JS engine is the live fallback whenever WASM fails
   * to initialize, so a payload the Rust side refuses must not be accepted
   * here. Every guard below is load-bearing against a real observed failure:
   *
   *   - `size` unbounded → `{size: 2**31}` allocated a 256 MB Uint32Array
   *     without throwing, so the surrounding try/catch never fired.
   *   - `hashes: 0` → `has()` returned `true` for EVERY key, silently turning
   *     the bloom gate into pass-all forever.
   *   - `data` shorter/longer than the declared size → `bitset.set` threw a
   *     RangeError, the throw-instead-of-degrade shape Rust already removed.
   */
  static deserialize(stored) {
    if (!stored || typeof stored !== 'object') return new BloomFilter();

    const { format, size, hashes, data } = stored;
    if (format !== undefined && format !== BLOOM_FORMAT) return new BloomFilter();
    if (!Number.isInteger(size) || size <= 0 || size > MAX_BLOOM_BITS) return new BloomFilter();
    if (!Number.isInteger(hashes) || hashes <= 0 || hashes > MAX_BLOOM_HASHES) {
      return new BloomFilter();
    }
    if (!Array.isArray(data) && !ArrayBuffer.isView(data)) return new BloomFilter();
    if (data.length !== Math.ceil(size / 32)) return new BloomFilter();

    const filter = new BloomFilter(size, hashes);
    filter.bitset.set(data);
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
