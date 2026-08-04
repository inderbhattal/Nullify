import { RangeParser, functionToString, patternToRegex } from './shared-utils.js';

/**
 * no-set-interval-if.js — Suppress setInterval calls matching a pattern.
 * uBO: `prevent-setInterval` / `nosiif`. Argument semantics match
 * no-set-timeout-if: `!needle` inverts, and the delay accepts uBO ranges.
 */
export function noSetInterval(pattern = '', delay = '') {
  const needleNot = String(pattern).charAt(0) === '!';
  const re = patternToRegex(needleNot ? String(pattern).slice(1) : pattern);
  if (re === null) return;
  const range = new RangeParser(delay);
  const logOnly = pattern === '' && range.unbound();
  const origSetInterval = window.setInterval;
  const origClearInterval = window.clearInterval;
  let tokenCounter = 0;

  window.setInterval = function (fn, ms, ...rest) {
    const src = functionToString(fn);
    if (!logOnly && re.test(src) !== needleNot && range.test(ms)) {
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
