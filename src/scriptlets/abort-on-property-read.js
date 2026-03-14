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
          else if (!originalDescriptor) {
            Object.defineProperty(obj, p, {
              configurable: true,
              writable: true,
              value,
            });
          }
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
  if (descriptor?.get?.toString().includes('adblock')) return; // Already patched

  Object.defineProperty(obj, lastProp, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    get() {
      throw new ReferenceError(`AdBlock: access to ${prop} denied`);
    },
    set: descriptor?.set,
  });
}
