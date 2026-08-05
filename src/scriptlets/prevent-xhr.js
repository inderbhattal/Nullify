import {
  generateContent, matchObjectProperties, parsePropsToMatch, proxyApply,
} from './shared-utils.js';

/**
 * prevent-xhr.js — Stub out XMLHttpRequest calls matching a propsToMatch
 * expression. uBO: `prevent-xhr` / `no-xhr-if`.
 *
 * @param {string} propsToMatch - Whitespace-separated `key:pattern` conditions
 *                                over `method`/`url`; a bare token is a URL
 *                                pattern.
 * @param {string} directive    - Response-body directive: `length:N`,
 *                                `length:min-max`, `emptyObj`, `emptyArr`,
 *                                `emptyStr`, `true`.
 */
export function preventXhr(propsToMatch = '', directive = '') {
  if (typeof propsToMatch !== 'string') return;
  if (propsToMatch === '' && directive === '') return;

  // §4.27: the whole argument used to be treated as one URL pattern, so the
  // 8 rules using `method:HEAD` / `url:googlesyndication` matched only URLs
  // containing that literal substring — never. The parser is now the same one
  // prevent-fetch and json-prune-*-response use, exactly as uBO shares it.
  const propNeedles = parsePropsToMatch(propsToMatch, 'url');

  // Per-instance state lives in a WeakMap, never on the instance. §4.22: the
  // previous wrapper assigned own `open`/`send` properties, and
  // `Object.getOwnPropertyNames(new XMLHttpRequest()).length !== 0` is a
  // one-line detector — a real instance has none.
  const xhrInstances = new WeakMap();
  const XHR = window.XMLHttpRequest;
  if (typeof XHR !== 'function') return;

  const safeDispatch = (xhr, type) => {
    try { xhr.dispatchEvent(new Event(type)); } catch { /* detached document */ }
  };

  proxyApply(XHR.prototype, 'open', (context) => {
    const { thisArg, callArgs } = context;
    xhrInstances.delete(thisArg);
    const [method, url, ...rest] = callArgs;
    const haystack = { method, url: String(url ?? '') };
    if (matchObjectProperties(propNeedles, haystack)) {
      xhrInstances.set(thisArg, {
        url: haystack.url,
        // `open(m, u)` and `open(m, u, true)` are async; only an explicit
        // falsy third argument makes the request synchronous.
        defer: rest.length === 0 || Boolean(rest[0]),
        props: {
          response: { value: '' },
          responseText: { value: '' },
          responseXML: { value: null },
        },
      });
    }
    // §4.22: uBO always reflects the real `open`. Skipping it left readyState
    // at 0, which makes the spec require `setRequestHeader()` to throw
    // InvalidStateError — so page code of the routine shape
    // `open(); setRequestHeader(); send()` threw a DOMException inside its own
    // script instead of receiving the intended empty-200 stub.
    return context.reflect();
  });

  proxyApply(XHR.prototype, 'send', (context) => {
    const { thisArg } = context;
    const details = xhrInstances.get(thisArg);
    if (details === undefined) return context.reflect();

    switch (thisArg.responseType) {
      case 'arraybuffer':
        details.props.response.value = new ArrayBuffer(0);
        break;
      case 'blob':
        details.props.response.value = new Blob([]);
        break;
      case 'document': {
        const doc = new globalThis.DOMParser().parseFromString('', 'text/html');
        details.props.response.value = doc;
        details.props.responseXML.value = doc;
        break;
      }
      case 'json':
        details.props.response.value = {};
        details.props.responseText.value = '{}';
        break;
      default: {
        // §4.27: 11 rules pass a directive that used to have no parameter to
        // land in at all, so every blocked request returned ''.
        if (directive === '') break;
        const text = generateContent(directive);
        details.props.response.value = text;
        details.props.responseText.value = text;
        break;
      }
    }

    if (details.defer === false) {
      defineAll(thisArg, {
        readyState: { value: 4 },
        responseURL: { value: details.url },
        status: { value: 200 },
        statusText: { value: 'OK' },
      });
      defineAll(thisArg, details.props);
      return undefined;
    }

    // Walk the readyState ladder asynchronously, as a real request does:
    // page code that keys off `readyState === 2` or `3` still sees them.
    Promise.resolve().then(() => {
      defineAll(thisArg, {
        readyState: { value: 1 },
        responseURL: { value: details.url },
      });
      safeDispatch(thisArg, 'readystatechange');
      defineAll(thisArg, {
        readyState: { value: 2 },
        status: { value: 200 },
        statusText: { value: 'OK' },
      });
      safeDispatch(thisArg, 'readystatechange');
      defineAll(thisArg, { readyState: { value: 3 } });
      defineAll(thisArg, details.props);
      safeDispatch(thisArg, 'readystatechange');
      defineAll(thisArg, { readyState: { value: 4 } });
      safeDispatch(thisArg, 'readystatechange');
      safeDispatch(thisArg, 'load');
      safeDispatch(thisArg, 'loadend');
    });
    return undefined;
  });
}

/**
 * Shadow read-only IDL getters on one instance.
 *
 * Descriptors stay configurable so a reused instance can be re-armed for a
 * second request instead of throwing on redefine.
 */
function defineAll(xhr, props) {
  for (const [key, desc] of Object.entries(props)) {
    try {
      Object.defineProperty(xhr, key, { configurable: true, ...desc });
    } catch { /* frozen instance — best effort */ }
  }
}
