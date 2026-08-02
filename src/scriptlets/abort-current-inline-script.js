import { ABORT_MESSAGE } from './shared-utils.js';

/**
 * abort-current-inline-script.js
 *
 * Aborts the currently executing inline script when it tries to read a
 * specific property that matches an optional search string.
 *
 * uBlock Origin equivalent: acis / abort-current-inline-script
 *
 * @param {string} prop   - Property to intercept (e.g. "Math.random")
 * @param {string} search - Optional text to match in the calling script source
 */
export function abortCurrentInlineScript(prop, search) {
  if (!prop) return;

  const re = search ? new RegExp(search) : null;

  const parts = prop.split('.');
  const lastProp = parts[parts.length - 1];

  let obj = window;
  for (let i = 0; i < parts.length - 1; i++) {
    obj = obj[parts[i]];
    if (!obj) return;
  }

  // Bind once, outside the descriptor. Binding inside the getter returned a
  // fresh function on every read, so `Math.random !== Math.random` — a
  // detection tell that also breaks identity caching in page code.
  const original = obj[lastProp];
  const originalValue = typeof original === 'function' ? original.bind(obj) : original;

  Object.defineProperty(obj, lastProp, {
    configurable: true,
    enumerable: true,
    get() {
      // Check if the current script source matches the search pattern
      const stack = new Error().stack || '';
      const isInline = stack.includes('<anonymous>') || stack.includes('eval');
      const currentScript = document.currentScript;

      if (isInline || (currentScript && currentScript.textContent)) {
        const scriptText = currentScript?.textContent || stack;
        if (!re || re.test(scriptText)) {
          throw new ReferenceError(ABORT_MESSAGE);
        }
      }

      return originalValue;
    },
    set(v) {
      // A plain `obj[lastProp] = v` re-enters this very setter and blows the
      // stack. Redefining as a data property replaces the accessor instead.
      Object.defineProperty(obj, lastProp, { configurable: true, writable: true, value: v });
    },
  });
}
