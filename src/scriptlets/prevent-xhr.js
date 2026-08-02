import { patternToRegex } from './shared-utils.js';

/**
 * prevent-xhr.js
 * Block or stub XMLHttpRequest calls matching a URL pattern.
 */
export function preventXhr(pattern) {
  if (!pattern) return;

  const re = patternToRegex(pattern);
  if (!re) return;
  const OrigXHR = window.XMLHttpRequest;

  // Proxy preserves identity: static constants (XMLHttpRequest.DONE), the
  // prototype chain and `instanceof` keep working — a bare replacement
  // function dropped the statics and broke `readyState === XMLHttpRequest.DONE`
  // comparisons on every page.
  window.XMLHttpRequest = new Proxy(OrigXHR, {
    construct(target, args) {
      const xhr = Reflect.construct(target, args);
      // Closure state, not an own `__blocked__` property — own properties
      // native XHR lacks are a one-line detector.
      let blocked = false;

      const origOpen = xhr.open.bind(xhr);
      xhr.open = function (method, url, ...rest) {
        blocked = re.test(String(url));
        if (blocked) return; // Fake open — no-op
        return origOpen(method, url, ...rest);
      };

      const origSend = xhr.send.bind(xhr);
      xhr.send = function (...sendArgs) {
        if (!blocked) return origSend(...sendArgs);
        // Resolve as an empty 200 without touching the network. Descriptors
        // stay configurable so a reused instance can be re-armed instead of
        // throwing on redefine.
        setTimeout(() => {
          Object.defineProperty(xhr, 'readyState', { configurable: true, value: OrigXHR.DONE ?? 4 });
          Object.defineProperty(xhr, 'status', { configurable: true, value: 200 });
          Object.defineProperty(xhr, 'responseText', { configurable: true, value: '' });
          Object.defineProperty(xhr, 'response', { configurable: true, value: '' });
          // dispatchEvent invokes the on* IDL handlers too, so listeners of
          // both styles — including onreadystatechange — see completion.
          xhr.dispatchEvent(new Event('readystatechange'));
          xhr.dispatchEvent(new Event('load'));
          xhr.dispatchEvent(new Event('loadend'));
        }, 0);
      };

      return xhr;
    },
  });
}
