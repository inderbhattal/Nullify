/** set-local-storage-item.js — Set (or remove) a localStorage item. */
export function setLocalStorageItem(key, value) {
  if (!key) return;
  try {
    const origSetItem = localStorage.setItem.bind(localStorage);

    // uBO's `$remove$` sentinel deletes the item; writing it literally handed
    // the page the string "$remove$" where it expected the key to be absent.
    if (value === '$remove$') {
      const origRemoveItem = localStorage.removeItem.bind(localStorage);
      origRemoveItem(key);
      // Intercept future writes to this key and keep it removed
      localStorage.setItem = function (k, v) {
        if (k === key) { origRemoveItem(k); return; }
        origSetItem(k, v);
      };
      return;
    }

    const resolved = resolveStorageValue(value);
    origSetItem(key, resolved);
    // Intercept future writes to this key
    localStorage.setItem = function (k, v) {
      if (k === key) { origSetItem(k, resolved); return; }
      origSetItem(k, v);
    };
  } catch {}
}

function resolveStorageValue(val) {
  switch (val) {
    case 'true': return 'true';
    case 'false': return 'false';
    case 'null': return 'null';
    case 'undefined': return 'undefined';
    case '': return '';
    case 'emptyArr': return '[]';
    case 'emptyObj': return '{}';
    default: return String(val);
  }
}
