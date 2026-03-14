/** set-session-storage-item.js — Set a sessionStorage item. */
export function setSessionStorageItem(key, value) {
  if (!key) return;
  try {
    sessionStorage.setItem(key, String(value));
  } catch {}
}
