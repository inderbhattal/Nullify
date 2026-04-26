/** set-cookie-reload.js — Set cookie and reload the page if cookie wasn't already set. */
export function setCookiePath(name, value, path) {
  if (!name) return;
  const existing = document.cookie.split(';').find((c) => c.trim().startsWith(encodeURIComponent(name) + '='));
  if (!existing) {
    if (sessionStorage.getItem('__nullify_reload_guard__')) return;
    sessionStorage.setItem('__nullify_reload_guard__', '1');

    const p = path || '/';
    const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();
    const secure = location.protocol === 'https:' ? 'Secure; SameSite=Lax;' : '';
    document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value || '')}; path=${p}; expires=${expires}; ${secure}`;
    window.location.reload();
  }
}
