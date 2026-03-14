/** abort-on-stack-trace.js — Abort when a function is called with a specific stack trace match. */
export function abortOnStackTrace(prop, search) {
  if (!prop || !search) return;
  const re = patternToRegex(search);

  const parts = prop.split('.');
  const lastProp = parts[parts.length - 1];
  let obj = window;
  for (let i = 0; i < parts.length - 1; i++) {
    obj = obj?.[parts[i]];
    if (!obj) return;
  }

  const original = obj[lastProp];
  if (typeof original !== 'function') return;

  obj[lastProp] = function (...args) {
    const stack = new Error().stack || '';
    if (re.test(stack)) {
      throw new ReferenceError(`AdBlock: ${prop} aborted (stack trace match)`);
    }
    return original.apply(this, args);
  };
}

function patternToRegex(p) {
  if (p.startsWith('/') && p.endsWith('/')) return new RegExp(p.slice(1, -1));
  return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}
