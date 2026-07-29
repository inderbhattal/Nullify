/**
 * rule-transport.js
 *
 * Encoding contract for the cosmetic-rule bundle as it crosses the extension
 * message bus.
 *
 * `chrome.runtime` messaging is JSON-serialized. A `Uint8Array` handed to
 * `sendResponse` therefore arrives on the far side as a plain object
 * (`{"0":12,"1":34,…}`) whose `.buffer` is `undefined` — so constructing a
 * `DataView` over it throws, and every procedural cosmetic rule is lost. Only
 * JSON-native values may cross the bus, so the binary bundle travels as base64.
 */

// Keep well under the argument-count limit for `String.fromCharCode.apply`.
const ENCODE_CHUNK = 0x8000;

/**
 * Encode the WASM binary rule blob for transport.
 * @param {Uint8Array} bytes
 * @returns {string|null} base64, or null if there is nothing to send
 */
export function encodeBinaryRules(bytes) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length === 0) return null;

  let binary = '';
  for (let i = 0; i < bytes.length; i += ENCODE_CHUNK) {
    const chunk = bytes.subarray
      ? bytes.subarray(i, i + ENCODE_CHUNK)
      : bytes.slice(i, i + ENCODE_CHUNK);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

/**
 * Reverse `encodeBinaryRules`.
 * @returns {Uint8Array|null} null when the payload is absent or malformed
 */
export function decodeBinaryPayload(payload) {
  if (typeof payload !== 'string' || payload === '') return null;
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Decode the binary rule format: three consecutive lists, each a little-endian
 * uint32 count followed by that many NUL-terminated UTF-8 strings. Entries that
 * look like JSON objects are procedural rule plans and are parsed.
 * @param {Uint8Array} buffer
 */
export function decodeBinaryRules(buffer) {
  const rules = { generic: [], domainSpecific: [], exceptions: [] };
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 0;
  const decoder = new TextDecoder();

  const decodeRuleEntry = (text) => {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) return text;
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  };

  const readStringList = () => {
    if (offset + 4 > buffer.byteLength) return [];
    const count = view.getUint32(offset, true);
    offset += 4;
    const list = [];

    for (let i = 0; i < count; i++) {
      if (offset >= buffer.byteLength) break;
      const start = offset;
      while (offset < buffer.byteLength && buffer[offset] !== 0) {
        offset++;
      }
      list.push(decodeRuleEntry(decoder.decode(buffer.slice(start, offset))));
      offset++; // skip NUL
    }
    return list;
  };

  rules.generic = readStringList();
  rules.domainSpecific = readStringList();
  rules.exceptions = readStringList();
  return rules;
}

/**
 * Resolve the rule set a page should apply from a `GET_INIT_DATA` response.
 *
 * The binary payload is an optimization, not a requirement: if it is missing or
 * fails to decode we fall back to the JSON rules rather than losing procedural
 * filtering entirely. The service worker always sends both.
 */
export function resolvePageRules(response) {
  const {
    cosmeticRules,
    cosmeticRulesBinary,
    genericProceduralRules,
  } = response || {};

  let pageRules = null;

  const bytes = decodeBinaryPayload(cosmeticRulesBinary);
  if (bytes) {
    try {
      pageRules = decodeBinaryRules(bytes);
    } catch {
      pageRules = null;
    }
  }

  if (!pageRules) pageRules = cosmeticRules;

  return {
    generic: pageRules?.generic || [],
    domainSpecific: [
      ...(Array.isArray(genericProceduralRules) ? genericProceduralRules : []),
      ...(pageRules?.domainSpecific || []),
    ],
    exceptions: pageRules?.exceptions || [],
  };
}
