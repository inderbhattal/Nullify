/** adjust-set-timeout.js — Adjust or multiply the delay of matching setTimeout calls. */
export function adjustSetTimeout(pattern, delay, multiplier) {
  const re = pattern ? patternToRegex(pattern) : null;
  const targetDelay = delay !== undefined ? Number(delay) : undefined;
  const mult = multiplier !== undefined ? Number(multiplier) : 0.001;
  const origSetTimeout = window.setTimeout;

  window.setTimeout = function (fn, ms, ...rest) {
    const src = typeof fn === 'function' ? fn.toString() : String(fn);
    if ((!re || re.test(src)) && (targetDelay === undefined || targetDelay === ms)) {
      ms = Math.floor(ms * mult);
    }
    return origSetTimeout.call(this, fn, ms, ...rest);
  };
}

function patternToRegex(p) {
  if (p.startsWith('/') && p.endsWith('/')) return new RegExp(p.slice(1, -1));
  return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}
