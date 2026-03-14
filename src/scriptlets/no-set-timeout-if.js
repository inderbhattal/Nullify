/** no-set-timeout-if.js — Suppress setTimeout calls whose handler matches a pattern. */
export function noSetTimeout(pattern, delay) {
  const re = pattern ? patternToRegex(pattern) : null;
  const targetDelay = delay !== undefined ? Number(delay) : undefined;
  const origSetTimeout = window.setTimeout;

  window.setTimeout = function (fn, ms, ...rest) {
    const src = typeof fn === 'function' ? fn.toString() : String(fn);
    if ((!re || re.test(src)) && (targetDelay === undefined || targetDelay === ms)) {
      return 0;
    }
    return origSetTimeout.call(this, fn, ms, ...rest);
  };
}

function patternToRegex(p) {
  if (p.startsWith('/') && p.endsWith('/')) return new RegExp(p.slice(1, -1));
  return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}
