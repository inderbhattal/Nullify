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
export function setConstant(prop, value) {
  if (!prop) return;

  const resolvedValue = resolveValue(value);

  const parts = prop.split('.');
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
    case 'emptyArray': return [];
    case 'emptyObj': return {};
    case 'noopPromiseResolve': return () => Promise.resolve();
    case 'noopPromiseReject': return () => Promise.reject();
    default: {
      const num = Number(val);
      if (!isNaN(num)) return num;
      return val;
    }
  }
}
