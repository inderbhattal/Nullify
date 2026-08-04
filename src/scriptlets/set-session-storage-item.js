/**
 * set-session-storage-item.js — sessionStorage flavour.
 *
 * The implementation lives with its localStorage twin so the value gate,
 * `$remove$` handling and key pinning cannot drift between them.
 */
export { setSessionStorageItem, trustedSetSessionStorageItem } from './set-local-storage-item.js';
