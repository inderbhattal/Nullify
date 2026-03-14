/** set-cookie-reload.js — Set cookie and reload the page if cookie wasn't already set. */
export function setCookiePath(name, value, path) {
  if (!name) return;
  const existing = document.cookie.split(';').find((c) => c.trim().startsWith(name + '='));
  if (!existing) {
    const p = path || '/';
    const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = `${name}=${value}; path=${p}; expires=${expires}`;
    window.location.reload();
  }
}
