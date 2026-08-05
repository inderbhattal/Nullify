import { getExtraArgs } from './shared-utils.js';

/**
 * set-cookie.js — Set a cookie to a **safe** value.
 *
 * §5.23: the value gate below is the trust boundary between `set-cookie` and
 * `trusted-set-cookie`. Without it, any subscribed list could write arbitrary
 * cookie values on any site through the untrusted scriptlet. uBO refuses any
 * value outside a fixed vocabulary or the ±32767 integer range.
 */

/** uBO's `getSafeCookieValuesFn` — the consent-banner vocabulary. */
export const SAFE_COOKIE_VALUES = [
  'accept', 'reject',
  'accepted', 'rejected', 'notaccepted',
  'allow', 'disallow', 'deny',
  'allowed', 'denied',
  'approved', 'disapproved',
  'checked', 'unchecked',
  'dismiss', 'dismissed',
  'enable', 'disable',
  'enabled', 'disabled',
  'essential', 'nonessential',
  'forbidden', 'forever',
  'hide', 'hidden',
  'necessary', 'required',
  'ok',
  'on', 'off',
  'true', 't', 'false', 'f',
  'yes', 'y', 'no', 'n',
  'all', 'none', 'functional',
  'granted', 'done',
  'decline', 'declined',
  'closed', 'next', 'mandatory',
  'disagree', 'agree',
];

/** True when `value` is one uBO's untrusted `set-cookie` is allowed to write. */
export function isSafeCookieValue(value) {
  const normalized = String(value).toLowerCase();
  const match = /^("?)(.+)\1$/.exec(normalized);
  const unquoted = (match && match[2]) || normalized;
  if (SAFE_COOKIE_VALUES.includes(unquoted)) return true;
  if (/^-?\d+$/.test(unquoted) === false) return false;
  const n = parseInt(value, 10) || 0;
  return n >= -32767 && n <= 32767;
}

/** The raw value of one cookie, or undefined when it is not set. */
export function readCookie(name) {
  let raw = '';
  try { raw = document.cookie; } catch { return undefined; }
  for (const s of raw.split(/\s*;\s*/)) {
    const pos = s.indexOf('=');
    if (pos === -1) continue;
    if (s.slice(0, pos) !== name) continue;
    return s.slice(pos + 1).trim();
  }
  return undefined;
}

/**
 * The shared writer behind set-cookie / set-cookie-reload / trusted-set-cookie.
 *
 * @param {object}  o
 * @param {boolean} o.trusted   Skip the name-encoding rule and add `Secure`.
 * @param {string}  o.name
 * @param {string}  o.value
 * @param {string}  [o.expires] A pre-formatted UTC date, or ''.
 * @param {string}  [o.path]    '' or '/' (uBO refuses anything else); 'none'
 *                              omits the attribute entirely.
 * @param {object}  [o.options] `domain`, `dontOverwrite`, `reload`.
 * @returns {boolean} whether the cookie now holds `value`.
 */
export function writeCookie({
  trusted = false, name, value, expires = '', path = '', options = {},
}) {
  // https://datatracker.ietf.org/doc/html/rfc2616#section-2.2 — token chars.
  if (trusted === false && /[^!#$%&'*+\-.0-9A-Z[\]^_`a-z|~]/.test(name)) {
    name = encodeURIComponent(name);
  }
  // §5.23: encoding used to be unconditional, which double-encoded values that
  // were already percent-encoded (`%5B%22required%22%5D` became
  // `%255B%2522required%2522%255D`, a string the page never recognises). uBO
  // encodes only when a character outside the cookie-value grammar is present;
  // `"` and `,` get a pass because browsers do not enforce the RFC here.
  if (/[^ -:<-[\]-~]/.test(value)) {
    value = encodeURIComponent(value);
  }

  const before = readCookie(name);
  if (before !== undefined && options.dontOverwrite) return false;
  if (before === value && options.reload) return false;

  const parts = [name, '=', value];
  if (expires !== '') parts.push('; expires=', expires);

  if (path === '') path = '/';
  else if (path === 'none') path = '';
  if (path !== '' && path !== '/') return false;
  if (path === '/') parts.push('; path=/');

  if (trusted) {
    if (options.domain) {
      let domain = options.domain;
      if (/^\/.+\//.test(domain)) {
        try {
          const match = new RegExp(domain.slice(1, -1)).exec(new URL(document.baseURI).hostname);
          domain = match ? match[0] : undefined;
        } catch { domain = undefined; }
      }
      if (domain) parts.push(`; domain=${domain}`);
    }
    parts.push('; Secure');
  } else if (/^__(Host|Secure)-/.test(name)) {
    parts.push('; Secure');
  }

  try {
    document.cookie = parts.join('');
  } catch { /* storage blocked by policy */ }

  return readCookie(name) === value;
}

export function setCookie(name = '', value = '', path = '', ...args) {
  if (name === '') return;
  // §5.23: abort on an unsafe value rather than writing it. 3 of the 156
  // shipped rules carry values uBO refuses, including a raw JSON object.
  if (isSafeCookieValue(value) === false) return;
  writeCookie({
    trusted: false, name, value, expires: '', path, options: getExtraArgs(args, 0),
  });
}
