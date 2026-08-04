import {
  collateFetchArguments, generateContent, getExtraArgs, matchObjectProperties,
  parsePropsToMatch, proxyApply,
} from './shared-utils.js';

/**
 * prevent-fetch.js — Stub out fetch() calls matching a propsToMatch expression.
 *
 * uBO signature: `(propsToMatch, responseBody, responseType, ...varargs)`.
 * §4.20: arguments 2 and 3 used to be swapped and neither was interpreted, so
 * `no-fetch-if, doubleclick, length:10, {"type":"cors"}` returned the literal
 * body `{"type":"cors"}` under `Content-Type: text/length:10`. Anti-adblock
 * code that reads `response.type` or `text.length` then concludes a blocker is
 * present — the exact outcome the rule exists to prevent.
 *
 * @param {string} propsToMatch - Whitespace-separated `key:pattern` conditions;
 *                                a bare token is a URL pattern.
 * @param {string} responseBody - uBO directive: `length:N`, `length:min-max`,
 *                                `emptyObj`, `emptyArr`, `emptyStr`, `true`.
 * @param {string} responseType - A response type, or a `{…}` JSON object
 *                                setting type/status/statusText/ok.
 * @param {...string} args      - uBO varargs; `throttle, <ms>` is honoured.
 */
export function preventFetch(propsToMatch = '', responseBody = '', responseType = '', ...args) {
  // uBO's logging-only mode. Nothing to log here, so there is nothing to do.
  if (propsToMatch === '' && responseBody === '') return;

  const propNeedles = parsePropsToMatch(propsToMatch, 'url');
  const extraArgs = getExtraArgs(args, 0);

  // uBO's untrusted allowlist: an untrusted rule may only move the response
  // into a shape the page could legitimately have received.
  const validResponseProps = {
    ok: [false, true],
    status: [403],
    statusText: ['', 'Not Found'],
    type: ['basic', 'cors', 'default', 'error', 'opaque'],
  };
  const responseProps = { statusText: { value: 'OK' } };
  if (/^\{.*\}$/.test(responseType)) {
    try {
      for (const [p, v] of Object.entries(JSON.parse(responseType))) {
        if (validResponseProps[p] === undefined) continue;
        if (validResponseProps[p].includes(v) === false) continue;
        responseProps[p] = { value: v };
      }
    } catch { /* malformed JSON — leave the defaults */ }
  } else if (responseType !== '' && validResponseProps.type.includes(responseType)) {
    responseProps.type = { value: responseType };
  }

  proxyApply(window, 'fetch', (context) => {
    const { callArgs } = context;
    const details = collateFetchArguments(...callArgs);
    const matched = matchObjectProperties(propNeedles, details);
    // uBO requires at least one needle to have actually matched something —
    // unlike prevent-xhr, an empty propsToMatch does not stub every request.
    if (matched === undefined || matched.length === 0) return context.reflect();

    return Promise.resolve(generateContent(responseBody)).then((text) => {
      const response = new Response(text, {
        headers: { 'content-length': String(text.length) },
      });
      try {
        Object.defineProperties(response, {
          url: { value: details.url },
          ...responseProps,
        });
      } catch { /* best effort — a sealed Response still carries the body */ }
      if (extraArgs.throttle) {
        return new Promise((resolve) => {
          setTimeout(() => { resolve(response); }, extraArgs.throttle);
        });
      }
      return response;
    });
  });
}
