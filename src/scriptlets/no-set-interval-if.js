/** no-set-interval-if.js — Suppress setInterval calls matching a pattern. */
export function noSetInterval(pattern, delay) {
  const re = pattern ? patternToRegex(pattern) : null;
  const targetDelay = delay !== undefined ? Number(delay) : undefined;
  const origSetInterval = window.setInterval;
  const origClearInterval = window.clearInterval;
  const noopTokens = new Set();
  let tokenCounter = 0;

  window.setInterval = function (fn, ms, ...rest) {
    const src = typeof fn === 'function' ? fn.toString() : String(fn);
    if ((!re || re.test(src)) && (targetDelay === undefined || targetDelay === ms)) {
      const token = `__n_siif_${++tokenCounter}`;
      noopTokens.add(token);
      return token;
    }
    return origSetInterval.call(this, fn, ms, ...rest);
  };

  window.clearInterval = function (id) {
    if (typeof id === 'string' && id.startsWith('__n_siif_')) {
      noopTokens.delete(id);
      return;
    }
    return origClearInterval.call(this, id);
  };
}

function patternToRegex(p) {
  if (p.startsWith('/') && p.endsWith('/')) return new RegExp(p.slice(1, -1));
  return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}
