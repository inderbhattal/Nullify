/**
 * set-constant.js
 *
 * Forces a property to always return a specific constant value.
 * Prevents ad scripts from reading or changing detection flags.
 *
 * uBlock Origin equivalent: set-constant / sc
 *
 * @param {string} prop  - Property path (e.g. "adblock.detected")
 * @param {string} value - String representation of the value to set
 *   Special values: "true", "false", "null", "undefined", "noopFunc",
 *                   "trueFunc", "falseFunc", "emptyArray", "emptyObj", ""
 */
function isProtoPollutionKey(key) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

/** Returned by `resolveValue` for values uBO refuses to set. Distinct from a
 *  resolved `undefined`, which is a legitimate value (`set, foo, undefined`). */
const ABORT = Symbol('nullify:set-constant:abort');

export function setConstant(prop, value) {
  if (!prop) return;

  const parts = prop.split('.');
  if (parts.some(isProtoPollutionKey)) return;

  const resolvedValue = resolveValue(value);
  if (resolvedValue === ABORT) return;

  const lastProp = parts[parts.length - 1];

  let obj = window;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (obj[p] === undefined || obj[p] === null) {
      // Defer until parent exists
      let settled = false;
      Object.defineProperty(obj, p, {
        configurable: true,
        enumerable: true,
        get: () => undefined,
        set(v) {
          Object.defineProperty(obj, p, { configurable: true, writable: true, value: v });
          if (!settled) { settled = true; setConstant(prop, value); }
        },
      });
      return;
    }
    obj = obj[p];
  }

  // Match uBO semantics: getter returns constant, setter is a no-op. Keep the
  // property configurable so a later call (or page script redefining with
  // defineProperty) can replace the trap without throwing. The getter pins
  // the value regardless of what page code assigns.
  try {
    Object.defineProperty(obj, lastProp, {
      configurable: true,
      enumerable: true,
      get() { return resolvedValue; },
      set() { /* ignore writes */ },
    });
  } catch {
    // Existing non-configurable descriptor — best effort, skip.
  }
}

function resolveValue(val) {
  switch (val) {
    case 'true': return true;
    case 'false': return false;
    case 'null': return null;
    case 'undefined': return undefined;
    case '': return '';
    case 'noopFunc': return () => {};
    case 'trueFunc': return () => true;
    case 'falseFunc': return () => false;
    // uBO spells these `[]`/`emptyArr` and `{}`/`emptyObj`; the shipped lists
    // use the bracket forms. `emptyArray` is kept for backward compatibility
    // with rules already written against this implementation.
    case '[]':
    case 'emptyArr':
    case 'emptyArray': return [];
    case '{}':
    case 'emptyObj': return {};
    case 'noopPromiseResolve': return () => Promise.resolve();
    case 'noopPromiseReject': return () => Promise.reject();
    default: {
      // uBO accepts only plain integers within ±0x7FFF for untrusted
      // set-constant, and rejects everything else. The old `Number()` fallback
      // both over-accepted (' ' -> 0, '0x10' -> 16, '1e400' -> Infinity) and,
      // on NaN, returned the raw string — so `set, foo, []` pinned the page's
      // property to the two-character string "[]" and broke any caller doing
      // `foo.forEach(...)`. Aborting leaves the page's own value intact, which
      // is always the safer failure.
      if (/^-?\d+$/.test(val)) {
        const num = parseInt(val, 10);
        if (Math.abs(num) <= 0x7FFF) return num;
      }
      return ABORT;
    }
  }
}
