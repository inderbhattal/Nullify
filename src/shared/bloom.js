/**
 * bloom.js — High-performance Bloom Filter for domain lookup.
 *
 * A Bloom Filter is a space-efficient probabilistic data structure used to 
 * test whether an element is a member of a set. False positives are possible, 
 * but false negatives are not.
 */

export class BloomFilter {
  /**
   * @param {number} size - Size of the bitset in bits.
   * @param {number} hashes - Number of hash functions to use.
   */
  constructor(size = 1024 * 1024, hashes = 4) {
    this.size = size;
    this.hashes = hashes;
    this.bitset = new Uint32Array(Math.ceil(size / 32));
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

  /** Serialize to a base64 string for storage. */
  serialize() {
    const bytes = new Uint8Array(this.bitset.buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /** Deserialize from a base64 string. */
  static deserialize(base64, size = 1024 * 1024, hashes = 4) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const filter = new BloomFilter(size, hashes);
    filter.bitset.set(new Uint32Array(bytes.buffer));
    return filter;
  }

  /** Simple, fast FNV-1a inspired hash. */
  _hash(key, seed) {
    let hash = 0x811c9dc5 ^ seed;
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return hash >>> 0;
  }
}
