import { toMatcher, toRegex } from './shared-utils.js';

/**
 * trusted-replace-fetch-response.js
 *
 * Intercepts fetch() calls matching a URL pattern and replaces the response
 * body with a transformed version. Defeats anti-adblock checks that fetch
 * a script and inspect its content.
 *
 * Usage:
 *   example.com##+js(trusted-replace-fetch-response, /adsbygoogle/, '', )
 *
 * Args:
 *   1. URL pattern (string or /regex/) to match
 *   2. Text to find in the response body
 *   3. Replacement text (empty string = remove)
 */
const TEXT_LIKE_TYPES = new Set([
  'text/', 'application/javascript', 'application/json', 'application/xml',
  'application/rss+xml', 'application/atom+xml', 'application/xhtml+xml',
]);

function isTextLikeResponse(response) {
  const ct = response.headers.get('content-type') || '';
  for (const type of TEXT_LIKE_TYPES) {
    if (ct.includes(type)) return true;
  }
  return false;
}

export function trustedReplaceFetchResponse(urlPattern, findStr, replaceStr = '') {
  if (!urlPattern) return;

  const matchUrl = toMatcher(urlPattern);
  const origFetch = window.fetch;

  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!matchUrl(url)) return origFetch.call(this, input, init);

    try {
      const response = await origFetch.call(this, input, init);
      if (!response.ok) return response;
      if (!isTextLikeResponse(response)) return response;

      // Avoid buffering huge binary payloads into memory
      const length = parseInt(response.headers.get('content-length') || '0', 10);
      if (length > 5 * 1024 * 1024) return response;

      const text = await response.text();
      const findRe = toRegex(findStr);
      const modified = findRe.test(text) ? text.replace(findRe, replaceStr) : text;

      // When returning a NEW response from text, we MUST strip encoding/length headers
      // because the new payload is raw text, not the original (likely compressed) byte-stream.
      const headers = new Headers(response.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');

      return new Response(modified, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    } catch {
      return origFetch.call(this, input, init);
    }
  };
}

export function trustedReplaceXhrResponse(urlPattern, findStr, replaceStr = '') {
  if (!urlPattern) return;

  const matchUrl = toMatcher(urlPattern);
  const findRe = toRegex(findStr);
  const OrigXHR = window.XMLHttpRequest;
  const interceptedMap = new WeakMap();

  const origOpen = OrigXHR.prototype.open;
  OrigXHR.prototype.open = function (method, url, ...args) {
    if (matchUrl(url)) interceptedMap.set(this, true);
    else interceptedMap.delete(this);
    return origOpen.call(this, method, url, ...args);
  };

  // Proxy preserves identity (`x instanceof XMLHttpRequest`, prototype chain).
  window.XMLHttpRequest = new Proxy(OrigXHR, {
    construct(target, args) {
      const xhr = Reflect.construct(target, args);
      const textDesc = Object.getOwnPropertyDescriptor(OrigXHR.prototype, 'responseText');
      const respDesc = Object.getOwnPropertyDescriptor(OrigXHR.prototype, 'response');

      const wrap = (desc) => ({
        configurable: true,
        get() {
          const val = desc.get.call(this);
          if (interceptedMap.get(this) && typeof val === 'string') {
            return val.replace(findRe, replaceStr);
          }
          return val;
        },
      });

      if (textDesc?.get) Object.defineProperty(xhr, 'responseText', wrap(textDesc));
      if (respDesc?.get) Object.defineProperty(xhr, 'response', wrap(respDesc));

      return xhr;
    },
  });
}

