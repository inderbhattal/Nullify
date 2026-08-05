import { getExtraArgs } from './shared-utils.js';
import { readCookie, writeCookie } from './set-cookie.js';

/**
 * trusted-set-cookie.js — Set a cookie to **any** value.
 *
 * §5.22: 951 corpus rules (6.9% of the whole corpus) name this scriptlet and
 * had no implementation. It is NOT an alias of `set-cookie`: the untrusted
 * variant refuses any value outside a fixed safe list, which is exactly the
 * trust boundary between them. It also adds an `offsetExpiresSec` argument in
 * position 3 (pushing `path` to 4) and three time placeholders.
 *
 * uBO signature: `(name, value, offsetExpiresSec, path, ...varargs)`.
 */
export function trustedSetCookie(name = '', value = '', offsetExpiresSec = '', path = '', ...args) {
  if (name === '') return;
  const time = new Date();

  value = String(value)
    .replaceAll('$now$', String(time.getTime()))
    .replaceAll('$currentDate$', time.toUTCString())
    .replaceAll('$currentISODate$', time.toISOString());

  let expires = '';
  if (offsetExpiresSec !== '') {
    if (offsetExpiresSec === '1day') {
      time.setDate(time.getDate() + 1);
    } else if (offsetExpiresSec === '1year') {
      time.setFullYear(time.getFullYear() + 1);
    } else {
      if (/^\d+$/.test(offsetExpiresSec) === false) return;
      time.setSeconds(time.getSeconds() + parseInt(offsetExpiresSec, 10));
    }
    expires = time.toUTCString();
  }

  writeCookie({
    trusted: true, name, value, expires, path, options: getExtraArgs(args, 0),
  });
}

/** uBO's AdGuard-compatibility wrapper: set, then reload when it changed. */
export function trustedSetCookieReload(name, value, offsetExpiresSec, path, ...args) {
  if (!name) return;
  const before = readCookie(name);
  trustedSetCookie(name, value, offsetExpiresSec, path, ...args);
  const after = readCookie(name);
  if (after === undefined || after === before) return;
  try { window.location.reload(); } catch { /* navigation blocked */ }
}
