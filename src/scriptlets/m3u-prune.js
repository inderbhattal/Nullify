import { toMatcher } from './shared-utils.js';

/**
 * m3u-prune.js
 *
 * Intercepts HLS (.m3u8) playlists and removes lines matching a pattern.
 * Crucial for blocking mid-roll and pre-roll ads in web video players.
 *
 * Args (uBO order):
 *   1. m3uPattern - Text or /regex/ to match lines that should be removed.
 *   2. urlPattern - URL pattern (string or /regex/); empty = match all.
 */
export function m3uPrune(m3uPattern, urlPattern) {
  if (!m3uPattern) return;

  // An empty urlPattern means every playlist is a candidate (uBO parity).
  const matchUrl = urlPattern ? toMatcher(urlPattern) : () => true;
  const matchPrune = toMatcher(m3uPattern);

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!matchUrl(url)) return origFetch.call(this, input, init);

    const response = await origFetch.call(this, input, init);
    if (!response.ok) return response;

    try {
      const text = await response.clone().text();
      const lines = text.split('\n');
      const filtered = lines.filter(line => !matchPrune(line));

      if (filtered.length !== lines.length) {
        return new Response(filtered.join('\n'), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
    } catch { /* return original */ }

    return response;
  };

  // Also patch XHR as many players use it for playlists.
  // Proxy preserves identity: static constants (XMLHttpRequest.DONE), the
  // prototype chain and `instanceof` keep working — a bare replacement
  // function dropped the statics and broke `readyState === XMLHttpRequest.DONE`
  // comparisons on every page.
  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = new Proxy(OrigXHR, {
    construct(target, args) {
      const xhr = Reflect.construct(target, args);
      const origOpen = xhr.open.bind(xhr);
      let isTarget = false;

      xhr.open = function (method, url, ...rest) {
        isTarget = matchUrl(url);
        return origOpen(method, url, ...rest);
      };

      const textDesc = Object.getOwnPropertyDescriptor(OrigXHR.prototype, 'responseText');
      if (textDesc?.get) {
        Object.defineProperty(xhr, 'responseText', {
          get() {
            const text = textDesc.get.call(this);
            if (isTarget && text) {
              const lines = text.split('\n');
              const filtered = lines.filter(line => !matchPrune(line));
              return filtered.join('\n');
            }
            return text;
          },
          configurable: true,
        });
      }

      return xhr;
    },
  });
}
