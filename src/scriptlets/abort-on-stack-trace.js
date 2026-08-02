import { patternToRegex } from './shared-utils.js';

/** abort-on-stack-trace.js — Abort when a function is called with a specific stack trace match. */
export function abortOnStackTrace(prop, search) {
  if (!prop || !search) return;
  const re = patternToRegex(search);
  if (!re) return;

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
      // Deliberately silent — logging here leaked the extension's name to any
      // page that wrapped console.log.
      return undefined;
    }
    return original.apply(this, args);
  };
}
