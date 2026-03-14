/**
 * prevent-fetch.js
 * Block or stub fetch() calls matching a URL pattern.
 */
export function preventFetch(pattern, responseType, responseBody) {
  if (!pattern) return;

  const re = patternToRegex(pattern);
  const origFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (re.test(url)) {
      const body = responseBody || '';
      const type = responseType || 'text';
      const resp = new Response(body, {
        status: 200,
        headers: { 'Content-Type': `text/${type}` },
      });
      return Promise.resolve(resp);
    }
    return origFetch(input, init);
  };
}

function patternToRegex(pattern) {
  if (pattern.startsWith('/') && pattern.endsWith('/')) {
    return new RegExp(pattern.slice(1, -1));
  }
  return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}
