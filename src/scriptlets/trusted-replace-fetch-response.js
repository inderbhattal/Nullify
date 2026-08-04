import { proxyApply, toMatcher, toRegex, wrapInstanceGetter } from './shared-utils.js';

/**
 * trusted-replace-fetch-response.js
 *
 * Intercepts fetch() calls matching a URL pattern and replaces the response
 * body with a transformed version. Defeats anti-adblock checks that fetch
 * a script and inspect its content.
 *
 * Usage:
 *   example.com##+js(trusted-replace-fetch-response, adPlacements, no_ads, player?)
 *
 * Args (uBO order):
 *   1. pattern      - Text or /regex/ to find in the response body
 *   2. replacement  - Replacement text (empty string = remove)
 *   3. propsToMatch - URL pattern (string or /regex/); empty = match all
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

export function trustedReplaceFetchResponse(pattern, replacement = '', propsToMatch = '') {
  if (!pattern) return;

  // An empty propsToMatch means every fetch is a candidate (uBO parity).
  const matchUrl = propsToMatch ? toMatcher(propsToMatch) : () => true;

  const replace = async (context) => {
    try {
      const response = await context.reflect();
      if (!response.ok) return response;
      if (!isTextLikeResponse(response)) return response;

      // Avoid buffering huge binary payloads into memory
      const length = parseInt(response.headers.get('content-length') || '0', 10);
      if (length > 5 * 1024 * 1024) return response;

      const text = await response.text();
      const findRe = toRegex(pattern);
      const modified = findRe.test(text) ? text.replace(findRe, replacement) : text;

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
      return context.reflect();
    }
  };

  proxyApply(window, 'fetch', (context) => {
    const input = context.callArgs[0];
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!matchUrl(url)) return context.reflect();
    return replace(context);
  });
}

export function trustedReplaceXhrResponse(pattern, replacement = '', propsToMatch = '') {
  if (!pattern) return;

  // An empty propsToMatch means every request is a candidate (uBO parity).
  const matchUrl = propsToMatch ? toMatcher(propsToMatch) : () => true;
  const findRe = toRegex(pattern);
  const XHR = window.XMLHttpRequest;
  if (typeof XHR !== 'function') return;
  const intercepted = new WeakMap();

  // §4.22: interception lives entirely on the prototype now. The previous
  // `construct` trap assigned own `response`/`responseText` accessors to every
  // instance, and `Object.getOwnPropertyNames(new XMLHttpRequest())` is `[]`
  // on a real browser — a one-line detector. It also dropped `newTarget`, so
  // `class PageXHR extends XMLHttpRequest {}` produced instances that were not
  // `instanceof PageXHR`.
  proxyApply(XHR.prototype, 'open', (context) => {
    const { thisArg, callArgs } = context;
    if (matchUrl(String(callArgs[1] ?? ''))) intercepted.set(thisArg, true);
    else intercepted.delete(thisArg);
    return context.reflect();
  });

  const transform = (value, xhr) => {
    if (intercepted.get(xhr) !== true) return value;
    if (typeof value !== 'string') return value;
    return value.replace(findRe, replacement);
  };
  wrapInstanceGetter(XHR.prototype, 'responseText', transform);
  wrapInstanceGetter(XHR.prototype, 'response', transform);
}
