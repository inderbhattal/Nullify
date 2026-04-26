/** object-prune.js — Remove keys from a plain object via assignment interception. */

function isProtoPollutionKey(key) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

export function objectPrune(prop, paths) {
  if (!prop || !paths) return;
  const prunePaths = paths.trim().split(/\s+/);

  const parts = prop.split('.');
  const lastProp = parts[parts.length - 1];
  if (isProtoPollutionKey(lastProp)) return;

  let obj = window;
  for (let i = 0; i < parts.length - 1; i++) {
    if (isProtoPollutionKey(parts[i])) return;
    obj = obj?.[parts[i]];
    if (!obj) return;
  }

  Object.defineProperty(obj, lastProp, {
    configurable: true,
    enumerable: true,
    set(value) {
      if (value && typeof value === 'object') {
        for (const path of prunePaths) {
          const p = path.split('.');
          let target = value;
          for (let i = 0; i < p.length - 1; i++) {
            if (isProtoPollutionKey(p[i])) { target = null; break; }
            target = target?.[p[i]];
          }
          if (target) {
            const lastKey = p[p.length - 1];
            if (!isProtoPollutionKey(lastKey)) delete target[lastKey];
          }
        }
      }
      Object.defineProperty(obj, lastProp, { configurable: true, writable: true, value });
    },
  });
}
