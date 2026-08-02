import { patternToRegex } from './shared-utils.js';

/** no-set-interval-if.js — Suppress setInterval calls matching a pattern. */
export function noSetInterval(pattern, delay) {
  const re = pattern ? patternToRegex(pattern) : null;
  const targetDelay = delay !== undefined ? Number(delay) : undefined;
  const origSetInterval = window.setInterval;
  const origClearInterval = window.clearInterval;
  let tokenCounter = 0;

  window.setInterval = function (fn, ms, ...rest) {
    const src = typeof fn === 'function' ? fn.toString() : String(fn);
    if ((!re || re.test(src)) && (targetDelay === undefined || targetDelay === ms)) {
      // A unique string token: never a real timer id, so clearInterval can
      // recognize and swallow it. No bookkeeping — a Set of every suppressed
      // token grew forever on pages that poll.
      return `__n_siif_${++tokenCounter}`;
    }
    return origSetInterval.call(this, fn, ms, ...rest);
  };

  window.clearInterval = function (id) {
    if (typeof id === 'string' && id.startsWith('__n_siif_')) return;
    return origClearInterval.call(this, id);
  };
}
