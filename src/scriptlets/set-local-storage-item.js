import { getExtraArgs, patternToRegex } from './shared-utils.js';
import { SAFE_COOKIE_VALUES } from './set-cookie.js';

/**
 * set-local-storage-item.js / set-session-storage-item.js and their
 * `trusted-` counterparts.
 *
 * §5.22: `trusted-set-local-storage-item` (176 rules) and
 * `trusted-set-session-storage-item` (10 rules) had no implementation. They
 * are not aliases: the untrusted flavours refuse any value outside uBO's safe
 * list, and only the trusted ones expand `$now$` / `$currentDate$` /
 * `$currentISODate$`.
 */

// uBO's untrusted vocabulary: the consent-banner words, plus the empty
// literals and the removal sentinel.
const SAFE_STORAGE_VALUES = [
  '', 'undefined', 'null', '{}', '[]', '""', '$remove$', ...SAFE_COOKIE_VALUES,
];

function isSafeStorageValue(value) {
  const normalized = String(value).toLowerCase();
  const match = /^("?)(.+)\1$/.exec(normalized);
  const unquoted = (match && match[2]) || normalized;
  if (SAFE_STORAGE_VALUES.includes(unquoted)) return true;
  if (/^-?\d+$/.test(unquoted) === false) return false;
  const n = parseInt(unquoted, 10) || 0;
  return n >= -32767 && n <= 32767;
}

/**
 * @param {'local'|'session'} which
 * @param {boolean} trusted
 * @param {string} key
 * @param {string} value
 * @param {object} options - uBO varargs; `reload` (ms) is honoured.
 */
function setStorageItem(which, trusted, key, value, options = {}) {
  if (!key) return;

  // AdGuard compatibility, applied before the value gate as uBO does.
  if (value === 'emptyArr') value = '[]';
  else if (value === 'emptyObj') value = '{}';

  if (trusted) {
    value = String(value)
      .replaceAll('$now$', String(Date.now()))
      .replaceAll('$currentDate$', `${Date()}`)
      .replaceAll('$currentISODate$', new Date().toISOString());
  } else if (isSafeStorageValue(value) === false) {
    return;
  }

  let modified = false;
  try {
    const storage = globalThis[`${which}Storage`];
    if (!storage) return;
    const origSetItem = storage.setItem.bind(storage);
    const origRemoveItem = storage.removeItem.bind(storage);

    // uBO's `$remove$` sentinel deletes the item; writing it literally handed
    // the page the string "$remove$" where it expected the key to be absent.
    if (value === '$remove$') {
      const pattern = patternToRegex(key, undefined, true);
      const toRemove = [];
      for (let i = 0, n = storage.length; i < n; i++) {
        const k = storage.key(i);
        if (pattern.test(k)) toRemove.push(k);
      }
      modified = toRemove.length !== 0;
      for (const k of toRemove) origRemoveItem(k);
      // Keep it removed: page code routinely re-writes the key right after.
      storage.setItem = function (k, v) {
        if (pattern.test(k)) { origRemoveItem(k); return; }
        origSetItem(k, v);
      };
    } else {
      const after = `${value}`;
      modified = storage.getItem(key) !== after;
      origSetItem(key, after);
      // Pin the key against later page writes.
      storage.setItem = function (k, v) {
        if (k === key) { origSetItem(k, after); return; }
        origSetItem(k, v);
      };
    }
  } catch { /* storage blocked by policy */ }

  if (modified && typeof options.reload === 'number') {
    setTimeout(() => {
      try { window.location.reload(); } catch { /* navigation blocked */ }
    }, options.reload);
  }
}

export function setLocalStorageItem(key, value, ...args) {
  setStorageItem('local', false, key, value, getExtraArgs(args, 0));
}

export function setSessionStorageItem(key, value, ...args) {
  setStorageItem('session', false, key, value, getExtraArgs(args, 0));
}

export function trustedSetLocalStorageItem(key, value, ...args) {
  setStorageItem('local', true, key, value, getExtraArgs(args, 0));
}

export function trustedSetSessionStorageItem(key, value, ...args) {
  setStorageItem('session', true, key, value, getExtraArgs(args, 0));
}
