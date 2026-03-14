/**
 * m3u-prune.js
 *
 * Intercepts HLS (.m3u8) playlists and removes lines matching a pattern.
 * Crucial for blocking mid-roll and pre-roll ads in web video players.
 *
 * Args:
 *   1. urlPattern - URL pattern (string or /regex/) to match the m3u8 request.
 *   2. prunePattern - Text or /regex/ to match lines that should be removed.
 */
export function m3uPrune(urlPattern, prunePattern) {
  if (!urlPattern || !prunePattern) return;

  const matchUrl = toMatcher(urlPattern);
  const matchPrune = toMatcher(prunePattern);

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

  // Also patch XHR as many players use it for playlists
  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    const origOpen = xhr.open.bind(xhr);
    let isTarget = false;

    xhr.open = function (method, url, ...rest) {
      isTarget = matchUrl(url);
      return origOpen(method, url, ...rest);
    };

    Object.defineProperty(xhr, 'responseText', {
      get() {
        const text = Object.getOwnPropertyDescriptor(OrigXHR.prototype, 'responseText').get.call(this);
        if (isTarget && text) {
          const lines = text.split('\n');
          const filtered = lines.filter(line => !matchPrune(line));
          return filtered.join('\n');
        }
        return text;
      },
      configurable: true,
    });

    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;
}

function toMatcher(pattern) {
  if (typeof pattern === 'string' && pattern.startsWith('/')) {
    const lastSlash = pattern.lastIndexOf('/');
    const re = new RegExp(pattern.slice(1, lastSlash), pattern.slice(lastSlash + 1));
    return (val) => re.test(val);
  }
  return (val) => val.includes(pattern);
}
