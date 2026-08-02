import { patternToRegex } from './shared-utils.js';

/** no-set-timeout-if.js — Suppress setTimeout calls whose handler matches a pattern. */
export function noSetTimeout(pattern, delay) {
  const re = pattern ? patternToRegex(pattern) : null;
  const targetDelay = delay !== undefined ? Number(delay) : undefined;
  const origSetTimeout = window.setTimeout;
  const origClearTimeout = window.clearTimeout;
  let tokenCounter = 0;

  window.setTimeout = function (fn, ms, ...rest) {
    const src = typeof fn === 'function' ? fn.toString() : String(fn);
    if ((!re || re.test(src)) && (targetDelay === undefined || targetDelay === ms)) {
      // A unique string token: never a real timer id, so clearTimeout can
      // recognize and swallow it. No bookkeeping — a Set of every suppressed
      // token grew forever on pages that poll.
      return `__n_stif_${++tokenCounter}`;
    }
    return origSetTimeout.call(this, fn, ms, ...rest);
  };

  window.clearTimeout = function (id) {
    if (typeof id === 'string' && id.startsWith('__n_stif_')) return;
    return origClearTimeout.call(this, id);
  };
}
