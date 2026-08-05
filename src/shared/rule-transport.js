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
 * Version of the procedural-plan JSON format. Mirrors `PLAN_FORMAT_VERSION` in
 * wasm-core/src/lib.rs, which stamps `planVersion` onto every serialized rule
 * — keep the two in sync.
 *
 * §5.8: Rust started writing the field and nothing on this side ever read it,
 * so the versioning was write-only. A rule whose `plan` was produced by a
 * format this build does not know how to execute must not be handed to the
 * procedural engine as if it were current; the steps would be misread as
 * version-1 steps and the rule would do something other than what its author
 * wrote. Rules written before versioning carry no field and are version 1 by
 * definition — the format was unchanged — which matches the serde default on
 * the Rust side.
 */
export const PLAN_FORMAT_VERSION = 1;

/** Marker for an entry that decoded cleanly but must not be applied. */
const DROP_ENTRY = Symbol('drop-entry');

/**
 * True when a decoded rule is safe to hand to the procedural engine: a plain
 * selector string, or a rule object whose plan format this build understands.
 */
export function isApplicableRule(rule) {
  if (!rule || typeof rule !== 'object') return true;
  return rule.planVersion === undefined || rule.planVersion === PLAN_FORMAT_VERSION;
}

/**
 * Decode the binary rule format: three consecutive lists, each a little-endian
 * uint32 count followed by that many NUL-terminated UTF-8 strings. Entries that
 * look like JSON objects are procedural rule plans and are parsed.
 *
 * Returns null when the payload is not a *complete, exactly-consumed* encoding
 * of that format.
 *
 * §5.8 — this used to return whatever it had accumulated when the bytes ran
 * out, so it was structurally incapable of returning a falsy value and the
 * JSON fallback documented on `resolvePageRules` could never fire for
 * structural damage. A truncated bundle (a partially written IndexedDB row, a
 * clipped copy) therefore decoded as a *silent partial rule set*: exceptions
 * vanished entirely and the half-read tail of a procedural rule was handed to
 * the content script as a literal selector string. Partial is the one outcome
 * with no safe interpretation — under-blocking and a bogus selector at once —
 * so structural damage is now reported and the caller falls back to the JSON
 * rules, which is exactly what the fallback exists for.
 *
 * @param {Uint8Array} buffer
 * @returns {{generic: Array, domainSpecific: Array, exceptions: Array}|null}
 */
export function decodeBinaryRules(buffer) {
  if (!buffer || typeof buffer.byteLength !== 'number') return null;

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 0;
  const decoder = new TextDecoder();
  let damaged = false;

  const decodeRuleEntry = (text) => {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) return text;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A `{`-prefixed entry is a serialized rule object. If it does not parse,
      // the framing is wrong — treating it as a CSS selector would inject the
      // JSON text into the page's selector list.
      damaged = true;
      return DROP_ENTRY;
    }

    // Not damage — a newer (or older) writer. Drop the single rule we cannot
    // execute and keep the rest of the bundle, rather than misreading its plan
    // steps or discarding a whole page's filtering over one rule.
    if (!isApplicableRule(parsed)) return DROP_ENTRY;

    return parsed;
  };

  const readStringList = () => {
    if (offset + 4 > buffer.byteLength) {
      damaged = true;
      return [];
    }
    const count = view.getUint32(offset, true);
    offset += 4;

    // Each entry costs at least its NUL terminator, so a count larger than the
    // bytes remaining is impossible and must not drive a multi-billion
    // iteration loop.
    if (count > buffer.byteLength - offset) {
      damaged = true;
      return [];
    }

    const list = [];
    for (let i = 0; i < count; i++) {
      const start = offset;
      while (offset < buffer.byteLength && buffer[offset] !== 0) {
        offset++;
      }
      if (offset >= buffer.byteLength) {
        // Ran off the end without finding the terminator: the entry is cut off.
        damaged = true;
        return list;
      }
      const entry = decodeRuleEntry(decoder.decode(buffer.subarray(start, offset)));
      if (entry !== DROP_ENTRY) list.push(entry);
      offset++; // skip NUL
    }
    return list;
  };

  const generic = readStringList();
  const domainSpecific = readStringList();
  const exceptions = readStringList();

  // All three counts consumed, and nothing left over: trailing bytes mean the
  // buffer is not what this decoder thinks it is.
  if (damaged || offset !== buffer.byteLength) return null;

  return { generic, domainSpecific, exceptions };
}

/**
 * Resolve the rule set a page should apply from a `GET_INIT_DATA` response.
 *
 * The binary payload is an optimization, not a requirement: if it is missing,
 * fails to decode, or decodes only partially (§5.8) we fall back to the JSON
 * rules rather than applying a truncated rule set. The service worker always
 * sends both.
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
    // The JSON fallback and the generic list carry the same versioned rule
    // objects the binary path does, so they get the same version gate (§5.8).
    domainSpecific: [
      ...(Array.isArray(genericProceduralRules) ? genericProceduralRules : []),
      ...(pageRules?.domainSpecific || []),
    ].filter(isApplicableRule),
    exceptions: pageRules?.exceptions || [],
  };
}
