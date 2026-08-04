import { getExtraArgs, patternToRegex } from './shared-utils.js';

/**
 * remove-cookie.js — Delete cookies whose name matches a pattern.
 *
 * @param {string} pattern - Name needle; `/…/` is a regex.
 * @param {...string} args - uBO varargs: `domain, <host|/re/>` and
 *                           `when, "scroll keydown"`.
 */
export function removeCookie(pattern, ...args) {
  const re = pattern ? patternToRegex(pattern) : null;
  const extraArgs = getExtraArgs(args, 0);

  let baseHostname = '';
  try { baseHostname = new URL(document.baseURI).hostname; } catch { /* opaque origin */ }

  let targetDomain = extraArgs.domain;
  if (targetDomain && /^\/.+\//.test(targetDomain)) {
    try {
      const match = new RegExp(targetDomain.slice(1, -1)).exec(baseHostname);
      targetDomain = match ? match[0] : undefined;
    } catch { targetDomain = undefined; }
  }

  const removeAll = () => {
    let raw = '';
    try { raw = document.cookie; } catch { return; }
    for (const cookieStr of raw.split(';')) {
      const pos = cookieStr.indexOf('=');
      if (pos === -1) continue;
      const name = cookieStr.slice(0, pos).trim();
      if (re && re.test(name) === false) continue;

      // §5.24: a cookie is deletable only by a Set-Cookie whose domain and
      // path match the ones it was created with. Consent and tracking cookies
      // are overwhelmingly set at the registrable domain, so the single
      // host-only `path=/` delete this used to issue removed none of them.
      // uBO issues six to eight variants; so do we.
      const part1 = `${name}=`;
      const part2a = `; domain=${baseHostname}`;
      const part2b = `; domain=.${baseHostname}`;
      let part2c;
      let part2d;
      if (targetDomain) {
        part2c = `; domain=${targetDomain}`;
        part2d = `; domain=.${targetDomain}`;
      } else {
        const domain = safeDocumentDomain();
        if (domain) {
          if (domain !== baseHostname) part2c = `; domain=.${domain}`;
          if (domain.startsWith('www.')) part2d = `; domain=${domain.replace('www', '')}`;
        }
      }
      const part3 = '; path=/';
      const part4 = '; Max-Age=-1000; expires=Thu, 01 Jan 1970 00:00:00 GMT';

      const variants = [
        part1 + part4,
        part1 + part2a + part4,
        part1 + part2b + part4,
        part1 + part3 + part4,
        part1 + part2a + part3 + part4,
        part1 + part2b + part3 + part4,
      ];
      if (part2c !== undefined) variants.push(part1 + part2c + part3 + part4);
      if (part2d !== undefined) variants.push(part1 + part2d + part3 + part4);
      for (const variant of variants) {
        try { document.cookie = variant; } catch { /* storage blocked */ }
      }
    }
  };

  removeAll();
  // Intentionally never removed: the unload-time sweep catches cookies the
  // page re-set after our initial pass (AdGuard's remove-cookie does the
  // same), and the listener dies with the document — it is not a leak.
  window.addEventListener('beforeunload', removeAll);

  if (typeof extraArgs.when !== 'string') return;
  let throttleTimer;
  const throttled = () => {
    if (throttleTimer !== undefined) return;
    throttleTimer = setTimeout(() => { throttleTimer = undefined; removeAll(); }, 500);
  };
  for (const type of extraArgs.when.split(/\s+/)) {
    if (type !== 'scroll' && type !== 'keydown') continue;
    document.addEventListener(type, throttled, { passive: true });
  }
}

function safeDocumentDomain() {
  try { return document.domain || ''; } catch { return ''; }
}
