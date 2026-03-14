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

    const response = await origFetch.call(this, input, init);
    if (!response.ok) return response;

    try {
      const text = await response.clone().text();
      if (!findStr || text.includes(findStr)) {
        const modified = findStr
          ? text.split(findStr).join(replaceStr)
          : replaceStr;
        return new Response(modified, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
    } catch { /* leave original response untouched */ }

    return response;
  };
}

/**
 * trusted-replace-xhr-response.js logic (bundled here).
 * Intercepts XMLHttpRequest responses matching a URL pattern.
 */
export function trustedReplaceXhrResponse(urlPattern, findStr, replaceStr = '') {
  if (!urlPattern) return;

  const matchUrl = toMatcher(urlPattern);

  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    const origOpen = xhr.open.bind(xhr);
    let interceptUrl = false;

    xhr.open = function (method, url, ...rest) {
      interceptUrl = matchUrl(url);
      return origOpen(method, url, ...rest);
    };

    if (interceptUrl) {
      Object.defineProperty(xhr, 'responseText', {
        get() {
          const text = Object.getOwnPropertyDescriptor(OrigXHR.prototype, 'responseText').get.call(this);
          if (!findStr || text.includes(findStr)) {
            return findStr ? text.split(findStr).join(replaceStr) : replaceStr;
          }
          return text;
        },
        configurable: true,
      });
    }

    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;
}

function toMatcher(pattern) {
  if (typeof pattern === 'string' && pattern.startsWith('/')) {
    const lastSlash = pattern.lastIndexOf('/');
    const re = new RegExp(pattern.slice(1, lastSlash), pattern.slice(lastSlash + 1));
    return (url) => re.test(url);
  }
  return (url) => url.includes(pattern);
}
