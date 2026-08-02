import { patternToRegex } from './shared-utils.js';

/** adjust-set-interval.js — Adjust the delay of matching setInterval calls. */
export function adjustSetInterval(pattern, delay, multiplier) {
  const re = pattern ? patternToRegex(pattern) : null;
  const targetDelay = delay !== undefined ? Number(delay) : undefined;
  const mult = multiplier !== undefined ? Number(multiplier) : 0.001;
  const origSetInterval = window.setInterval;

  window.setInterval = function (fn, ms, ...rest) {
    const src = typeof fn === 'function' ? fn.toString() : String(fn);
    if ((!re || re.test(src)) && (targetDelay === undefined || targetDelay === ms)) {
      ms = Math.floor(ms * mult);
    }
    return origSetInterval.call(this, fn, ms, ...rest);
  };
}
