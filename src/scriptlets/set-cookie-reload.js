/** set-cookie-reload.js — Set cookie and reload the page if cookie wasn't already set. */
export function setCookiePath(name, value, path) {
  if (!name) return;
  const encName = encodeURIComponent(name);
  const encValue = encodeURIComponent(value || '');
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
