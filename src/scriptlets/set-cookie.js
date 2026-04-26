/** set-cookie.js — Set a cookie to a specific value. */
export function setCookie(name, value, path) {
  if (!name) return;
  const p = path || '/';
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();
  const secure = location.protocol === 'https:' ? 'Secure; SameSite=Lax;' : '';
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value || '')}; path=${p}; expires=${expires}; ${secure}`;
}
