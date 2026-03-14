/** object-prune.js — Remove keys from a plain object via assignment interception. */
export function objectPrune(prop, paths) {
  if (!prop || !paths) return;
  const prunePaths = paths.trim().split(/\s+/);

  const parts = prop.split('.');
  const lastProp = parts[parts.length - 1];
  let obj = window;
  for (let i = 0; i < parts.length - 1; i++) {
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
            target = target?.[p[i]];
          }
          if (target) delete target[p[p.length - 1]];
        }
      }
      Object.defineProperty(obj, lastProp, { configurable: true, writable: true, value });
    },
  });
}
