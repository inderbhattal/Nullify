import { proxyApply, toMatcher, wrapInstanceGetter } from './shared-utils.js';

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

  const pruneResponse = async (context) => {
    const response = await context.reflect();
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

  proxyApply(window, 'fetch', (context) => {
    const input = context.callArgs[0];
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!matchUrl(url)) return context.reflect();
    return pruneResponse(context);
  });

  // Also patch XHR as many players use it for playlists.
  //
  // §4.22: this used to be a `construct` trap that assigned own `open` and
  // `responseText` properties to every instance — a real XHR has no own
  // properties at all, so that was a one-line detector — and dropped
  // `newTarget`, breaking `class Player extends XMLHttpRequest {}`. Everything
  // now lives on the prototype, with per-instance state in a WeakMap.
  const XHR = window.XMLHttpRequest;
  if (typeof XHR !== 'function') return;
  const targets = new WeakMap();

  proxyApply(XHR.prototype, 'open', (context) => {
    const { thisArg, callArgs } = context;
    if (matchUrl(String(callArgs[1] ?? ''))) targets.set(thisArg, true);
    else targets.delete(thisArg);
    return context.reflect();
  });

  wrapInstanceGetter(XHR.prototype, 'responseText', (text, xhr) => {
    if (targets.get(xhr) !== true || !text) return text;
    return text.split('\n').filter((line) => !matchPrune(line)).join('\n');
  });
}
