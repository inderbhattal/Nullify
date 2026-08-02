import { toMatcher } from './shared-utils.js';

/**
 * prevent-fetch.js
 * Block or stub fetch() calls matching a propsToMatch expression.
 *
 * propsToMatch is uBO's form: whitespace-separated conditions, each either a
 * bare URL pattern or `key:pattern` (e.g. `method:HEAD url:doubleclick`).
 * All conditions must hold for the request to be stubbed.
 */
export function preventFetch(pattern, responseType, responseBody) {
  if (!pattern) return;

  const conditions = parsePropsToMatch(pattern);
  if (!conditions.length) return;
  const origFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (conditions.every((cond) => cond(url, input, init))) {
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

// Request/init fields addressable via `key:pattern`. Restricting to this set
// keeps URL-ish tokens ("https://…", "example.com:8080/ads") as URL patterns.
const KNOWN_PROPS = new Set([
  'url', 'method', 'mode', 'credentials', 'cache', 'redirect',
  'referrer', 'referrerPolicy', 'integrity', 'keepalive', 'body',
]);

function parsePropsToMatch(pattern) {
  const conditions = [];
  for (const token of String(pattern).trim().split(/\s+/)) {
    if (!token) continue;
    const colon = token.indexOf(':');
    const key = colon > 0 ? token.slice(0, colon) : '';
    if (KNOWN_PROPS.has(key)) {
      const match = toMatcher(token.slice(colon + 1));
      if (key === 'url') {
        conditions.push((url) => match(url));
      } else if (key === 'method') {
        conditions.push((url, input, init) => match(init?.method || input?.method || 'GET'));
      } else {
        // Any other Request/init field, stringified.
        conditions.push((url, input, init) => match(String(init?.[key] ?? input?.[key] ?? '')));
      }
      continue;
    }
    const match = toMatcher(token);
    conditions.push((url) => match(url));
  }
  return conditions;
}
