/** set-local-storage-item.js — Set a localStorage item to a specific value. */
export function setLocalStorageItem(key, value) {
  if (!key) return;
  try {
    const resolved = resolveStorageValue(value);
    localStorage.setItem(key, resolved);
    // Intercept future writes to this key
    const origSetItem = localStorage.setItem.bind(localStorage);
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
