/**
 * trusted-set-constant.js
 * Like set-constant but allows setting complex values (objects, functions).
 * "Trusted" scriptlets can only be injected via trusted filter lists.
 */
export function trustedSetConstant(prop, value, stack) {
  if (!prop) return;

  // Parse value — supports JSON
  let resolvedValue;
  try {
    resolvedValue = JSON.parse(value);
  } catch {
    resolvedValue = value === 'undefined' ? undefined : value;
  }

  const parts = prop.split('.');
  const lastProp = parts[parts.length - 1];
  let obj = window;
  for (let i = 0; i < parts.length - 1; i++) {
    obj = obj?.[parts[i]];
    if (!obj) return;
  }

  Object.defineProperty(obj, lastProp, {
    configurable: false,
    enumerable: true,
    get: () => resolvedValue,
    set: () => {},
  });
}
