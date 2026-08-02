import { ABORT_MESSAGE } from './shared-utils.js';

/**
 * abort-on-property-read.js
 *
 * Throws a ReferenceError when a script attempts to read the specified
 * property chain. This aborts the offending script, preventing ad-blocker
 * detection and anti-adblock payloads.
 *
 * uBlock Origin equivalent: aopr / abort-on-property-read
 *
 * @param {string} prop - Property path, e.g. "window._sp_" or "Object.defineProperty"
 */

// Getters we installed, so re-application can be detected without sniffing the
// getter's source text (the old `.toString().includes('adblock')` guard was
// dead code — the source said "AdBlock" — and source-sniffing is a tell).
const armedGetters = new WeakSet();

export function abortOnPropertyRead(prop) {
  if (!prop) return;

  const parts = prop.split('.');
  const lastProp = parts[parts.length - 1];

  // Traverse to the parent object of the target property
  let obj = window;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (obj[p] === undefined || obj[p] === null) {
      // Wait for the property to be set then re-apply
      let settled = false;
      const originalDescriptor = Object.getOwnPropertyDescriptor(obj, p);

      Object.defineProperty(obj, p, {
        configurable: true,
        enumerable: true,
        get() {
          return originalDescriptor?.get?.() ?? originalDescriptor?.value;
        },
        set(value) {
          if (originalDescriptor?.set) originalDescriptor.set(value);
          // Always store the incoming value. A bare `var adconfig;` produces a
          // data descriptor with no setter, and dropping the page's assignment
          // on that shape broke the page without ever arming the abort.
          Object.defineProperty(obj, p, {
            configurable: true,
            writable: true,
            value,
          });
          if (!settled) {
            settled = true;
            abortOnPropertyRead(prop);
          }
        },
      });
      return;
    }
    obj = obj[p];
  }

  const descriptor = Object.getOwnPropertyDescriptor(obj, lastProp);
  if (descriptor?.get && armedGetters.has(descriptor.get)) return; // Already patched

  const abortGetter = function () {
    throw new ReferenceError(ABORT_MESSAGE);
  };
  armedGetters.add(abortGetter);

  Object.defineProperty(obj, lastProp, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    get: abortGetter,
    set: descriptor?.set,
  });
}
