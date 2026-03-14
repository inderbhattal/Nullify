/**
 * prevent-xhr.js
 * Block or stub XMLHttpRequest calls matching a URL pattern.
 */
export function preventXhr(pattern) {
  if (!pattern) return;

  const re = patternToRegex(pattern);
  const OrigXHR = window.XMLHttpRequest;

  function PatchedXHR() {
    const xhr = new OrigXHR();
    const origOpen = xhr.open.bind(xhr);

    xhr.open = function (method, url, ...rest) {
      if (re.test(url)) {
        Object.defineProperty(this, '__blocked__', { value: true });
        // Fake open — no-op
        return;
      }
      return origOpen(method, url, ...rest);
    };

    const origSend = xhr.send.bind(xhr);
    xhr.send = function (...args) {
      if (this.__blocked__) {
        // Fire load event with empty response
        setTimeout(() => {
          Object.defineProperty(this, 'readyState', { value: 4 });
          Object.defineProperty(this, 'status', { value: 200 });
          Object.defineProperty(this, 'responseText', { value: '' });
          this.onload?.();
          this.dispatchEvent?.(new Event('load'));
        }, 0);
        return;
      }
      return origSend(...args);
    };

    return xhr;
  }

  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;
}

function patternToRegex(pattern) {
  if (pattern.startsWith('/') && pattern.endsWith('/')) {
    return new RegExp(pattern.slice(1, -1));
  }
  return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}
