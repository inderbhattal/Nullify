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

  const original = obj[lastProp];

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
          throw new ReferenceError(`AdBlock: inline script accessing ${prop} aborted`);
        }
      }

      return typeof original === 'function' ? original.bind(obj) : original;
    },
    set(v) {
      obj[lastProp] = v;
    },
  });
}
