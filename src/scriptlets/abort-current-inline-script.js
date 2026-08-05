import { ABORT_MESSAGE, patternToRegex } from './shared-utils.js';

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

  // §4.9: this used to be `new RegExp(search)`. uBO escapes a plain-string
  // needle and treats only `/…/flags` as a regex. Raw construction killed 28
  // corpus rules outright — `l.parentNode.insertBefore(s` is not a valid
  // regex, so the SyntaxError propagated out and the trap was never installed
  // — and silently widened 115 more, where `.` in a literal needle became
  // "any character" and aborted page scripts the filter never targeted.
  const re = search ? patternToRegex(search) : null;

  const parts = prop.split('.');
  const lastProp = parts[parts.length - 1];

  let obj = window;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    const parent = obj[p];
    if (parent === undefined || parent === null) {
      // §4.9: `if (!obj) return` gave up on any chain whose parent had not
      // loaded yet (`Swal.fire`, `ips.controller.register`), so every rule
      // aimed at a late-loading library was a no-op. Defer exactly as
      // abort-on-property-read.js and set-constant.js do: trap the parent and
      // re-arm once the page assigns it.
      deferUntilParentExists(obj, p, () => abortCurrentInlineScript(prop, search));
      return;
    }
    obj = parent;
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

/**
 * Trap a not-yet-existing link in a property chain and run `rearm` once the
 * page assigns it. The incoming value is always stored, including for the bare
 * `var lib;` shape that produces a data descriptor with no setter.
 */
function deferUntilParentExists(obj, p, rearm) {
  let settled = false;
  const originalDescriptor = Object.getOwnPropertyDescriptor(obj, p);
  try {
    Object.defineProperty(obj, p, {
      configurable: true,
      enumerable: true,
      get() {
        return originalDescriptor?.get?.() ?? originalDescriptor?.value;
      },
      set(value) {
        if (originalDescriptor?.set) originalDescriptor.set(value);
        Object.defineProperty(obj, p, { configurable: true, writable: true, value });
        if (settled) return;
        settled = true;
        rearm();
      },
    });
  } catch { /* non-configurable — nothing to defer on */ }
}
