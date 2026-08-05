import { RangeParser, functionToString, patternToRegex } from './shared-utils.js';

/**
 * no-set-timeout-if.js — Suppress setTimeout calls whose handler matches a
 * pattern. uBO: `prevent-setTimeout` / `nostif`.
 *
 * @param {string} pattern - Needle for the stringified callback. A leading `!`
 *                           inverts the match.
 * @param {string} delay   - Exact delay, or a uBO range: `2000-5000`, `3200-`,
 *                           `-500`. A leading `!` inverts. Empty means any.
 */
export function noSetTimeout(pattern = '', delay = '') {
  // §5.26: `!needle` used to be escaped into the literal, and a `2000-5000`
  // range went through `Number()` to NaN, so neither form ever matched.
  const needleNot = String(pattern).charAt(0) === '!';
  const re = patternToRegex(needleNot ? String(pattern).slice(1) : pattern);
  if (re === null) return;
  const range = new RangeParser(delay);
  const logOnly = pattern === '' && range.unbound();
  const origSetTimeout = window.setTimeout;
  const origClearTimeout = window.clearTimeout;
  let tokenCounter = 0;

  window.setTimeout = function (fn, ms, ...rest) {
    const src = functionToString(fn);
    if (!logOnly && re.test(src) !== needleNot && range.test(ms)) {
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
