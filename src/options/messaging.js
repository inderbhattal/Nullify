/**
 * messaging.js — options-page service-worker messaging wrapper.
 *
 * The message bus reports failure in three shapes the raw
 * `chrome.runtime.sendMessage` promise never rejects on:
 *   - `undefined` (no listener / SW gone before responding),
 *   - `{ error: '…' }` (validation failure or the bus's catch-all),
 *   - `{ ok: false }` (handler-level refusal).
 * Every SW call must go through `call()` so all three become rejections the
 * caller can surface, instead of being rendered as success.
 */

/**
 * Raw-text budget for user filters. The numeric value must match
 * MAX_USER_FILTERS_BYTES in the service worker (pinned by a drift test in
 * messaging.test.mjs).
 */
export const MAX_USER_FILTERS_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Byte length of `text` as UTF-8.
 *
 * §5.33 — the three enforcers of this cap do not measure the same thing. The
 * SW compares `raw.length`, i.e. UTF-16 code units; `wasm-core` counts UTF-8
 * bytes; this page counts UTF-8 bytes. UTF-8 length is never below UTF-16
 * length for any string, so checking bytes here is the *strictest* of the
 * three: anything this page accepts, the SW accepts too, and the user gets a
 * clear over-cap message instead of the WASM path throwing (which
 * `compileUserFiltersViaWasm` cannot distinguish from "WASM unavailable").
 * Do not relax this to `text.length` to "match" the SW.
 */
export function utf8ByteLength(text) {
  return new TextEncoder().encode(text ?? '').length;
}

/**
 * Send a message to the service worker and reject on every failure shape.
 * Resolves with the raw response otherwise (object, array, or primitive).
 */
export async function call(type, payload) {
  const message = payload === undefined ? { type } : { type, payload };
  const resp = await chrome.runtime.sendMessage(message);
  if (resp === undefined) {
    throw new Error(`${type}: no response from service worker`);
  }
  if (resp !== null && typeof resp === 'object' && !Array.isArray(resp)) {
    if (resp.error) {
      throw new Error(String(resp.error));
    }
    if (resp.ok === false) {
      throw new Error(`${type} failed`);
    }
  }
  return resp;
}
