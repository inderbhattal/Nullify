import { isSafeCookieValue } from './set-cookie.js';

/** set-cookie-reload.js — Set cookie and reload the page if cookie wasn't already set. */
export function setCookiePath(name, value, path) {
  if (!name) return;
  // §5.23: uBO's `set-cookie-reload` is `set-cookie` with `reload, 1`, so it
  // carries the same trust boundary. Without this gate it would be a way for
  // an untrusted list to write the arbitrary values `set-cookie` now refuses.
  if (isSafeCookieValue(value ?? '') === false) return;
  const encName = encodeCookiePart(name);
  const encValue = encodeCookiePart(value || '');
  const existing = document.cookie.split(';').find((c) => c.trim().startsWith(encName + '='));
  if (existing) return;

  // Guard scoped per name+value: one global key meant the first such rule on
  // an origin permanently starved every other one in that tab.
  const guardKey = `__nullify_reload_guard__${encName}=${encValue}`;
  try {
    if (sessionStorage.getItem(guardKey)) return;
  } catch { /* storage blocked — fall through, the write-check below still gates the reload */ }

  const p = path || '/';
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();
  const secure = location.protocol === 'https:' ? 'Secure; SameSite=Lax;' : '';
  document.cookie = `${encName}=${encValue}; path=${p}; expires=${expires}; ${secure}`;

  // Only arm the guard and reload after the write actually took — arming it
  // before (or on a rejected write) permanently disabled the scriptlet here.
  const written = document.cookie.split(';').some((c) => c.trim().startsWith(encName + '='));
  if (!written) return;
  try {
    sessionStorage.setItem(guardKey, '1');
  } catch {
    return; // cannot arm the loop guard — reloading would risk a reload loop
  }
  window.location.reload();
}

/**
 * §5.23: encode only when the value contains a character the cookie grammar
 * disallows. Unconditional `encodeURIComponent` mangled already-encoded values
 * (`%5B%22required%22%5D` -> `%255B%2522required%2522%255D`).
 */
function encodeCookiePart(s) {
  return /[^ -:<-[\]-~]/.test(s) ? encodeURIComponent(s) : s;
}
