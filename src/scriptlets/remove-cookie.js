import { patternToRegex } from './shared-utils.js';

/** remove-cookie.js — Delete cookies matching a pattern. */
export function removeCookie(pattern) {
  const re = pattern ? patternToRegex(pattern) : null;

  const removeAll = () => {
    document.cookie.split(';').forEach((cookie) => {
      const name = cookie.split('=')[0].trim();
      if (!re || re.test(name)) {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
      }
    });
  };

  removeAll();
  // Intentionally never removed: the unload-time sweep catches cookies the
  // page re-set after our initial pass (AdGuard's remove-cookie does the
  // same), and the listener dies with the document — it is not a leak.
  window.addEventListener('beforeunload', removeAll);
}
