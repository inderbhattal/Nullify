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
  window.addEventListener('beforeunload', removeAll);
}

function patternToRegex(p) {
  if (p.startsWith('/') && p.endsWith('/')) return new RegExp(p.slice(1, -1));
  return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}
