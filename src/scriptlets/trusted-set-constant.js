/**
 * trusted-set-constant.js
 * Like set-constant but allows setting complex values (objects, functions).
 * "Trusted" scriptlets can only be injected via trusted filter lists.
 */

function isProtoPollutionKey(key) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

export function trustedSetConstant(prop, value, _stack) {
  if (!prop) return;

  const parts = prop.split('.');
  if (parts.some(isProtoPollutionKey)) return;

  // Parse value — supports JSON
  let resolvedValue;
  try {
    resolvedValue = JSON.parse(value);
  } catch {
    resolvedValue = value === 'undefined' ? undefined : value;
  }

  const lastProp = parts[parts.length - 1];
  let obj = window;
  for (let i = 0; i < parts.length - 1; i++) {
    obj = obj?.[parts[i]];
    if (!obj) return;
  }

  try {
    Object.defineProperty(obj, lastProp, {
      configurable: false,
      enumerable: true,
      get: () => resolvedValue,
      set: () => {},
    });
  } catch {
    // Existing non-configurable descriptor — best effort, skip.
  }
}
