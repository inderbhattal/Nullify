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
    } catch (e) {
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

function toRegex(s) {
  if (s instanceof RegExp) return s;
  if (s.startsWith('/') && s.lastIndexOf('/') > 0) {
    const lastSlash = s.lastIndexOf('/');
    return new RegExp(s.slice(1, lastSlash), s.slice(lastSlash + 1));
  }
  return new RegExp(escapeRegex(s), 'g');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


function toMatcher(pattern) {
  if (typeof pattern === 'string' && pattern.startsWith('/')) {
    const lastSlash = pattern.lastIndexOf('/');
    const re = new RegExp(pattern.slice(1, lastSlash), pattern.slice(lastSlash + 1));
    return (url) => re.test(url);
  }
  return (url) => url.includes(pattern);
}
