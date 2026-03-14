/**
 * abort-on-property-write.js
 *
 * Throws when a script attempts to WRITE the specified property.
 * Useful for stopping ad-network initialization.
 *
 * uBlock Origin equivalent: aopw / abort-on-property-write
 */
export function abortOnPropertyWrite(prop) {
  if (!prop) return;

  const parts = prop.split('.');
  const lastProp = parts[parts.length - 1];

  let obj = window;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (obj[p] === undefined || obj[p] === null) return;
    obj = obj[p];
  }

  const descriptor = Object.getOwnPropertyDescriptor(obj, lastProp);

  Object.defineProperty(obj, lastProp, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    get: descriptor?.get ?? (() => descriptor?.value),
    set() {
      throw new ReferenceError(`AdBlock: write to ${prop} denied`);
    },
  });
}
