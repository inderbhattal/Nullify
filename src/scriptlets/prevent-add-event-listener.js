import { functionToString, getExtraArgs, patternToRegex, proxyApply } from './shared-utils.js';

/**
 * prevent-add-event-listener.js — Block addEventListener calls whose event
 * type and handler both match. uBO: `prevent-addEventListener` / `aeld`.
 *
 * @param {string} type    - Event type. A plain string matches verbatim; `/…/`
 *                           is a real regex.
 * @param {string} pattern - Matched against the stringified handler.
 * @param {...string} args - uBO varargs in `key, value` pairs. `elements`
 *                           restricts the block to matching event targets.
 */
export function preventAddEventListener(type = '', pattern = '', ...args) {
  // §4.17: the type used to be compared with `===`. uBO compiles it with
  // `patternToRegex(type, undefined, true)` — verbatim mode, so a plain string
  // still behaves like equality (`^escaped$`) while `/^(contextmenu|copy)$/`
  // becomes a working regex. 103 corpus rules pass a regex literal and could
  // never fire under string equality; they are the anti-copy-protection rules,
  // and every one of them was inert.
  const reType = patternToRegex(type, undefined, true);
  const rePattern = patternToRegex(pattern);
  if (reType === null || rePattern === null) return;

  // §4.17: 21 rules pass `elements, <selector>` varargs that used to be dropped.
  const extraArgs = getExtraArgs(args, 0);
  const targetSelector = extraArgs.elements;

  const elementMatches = (elem) => {
    if (targetSelector === 'window') return elem === window;
    if (targetSelector === 'document') return elem === document;
    try {
      if (elem && elem.matches && elem.matches(targetSelector)) return true;
      return Array.from(document.querySelectorAll(targetSelector)).includes(elem);
    } catch {
      return false;
    }
  };

  // uBO requires BOTH type and handler to match. An omitted argument compiles
  // to a match-everything regex, so a one-sided rule still works.
  const shouldPrevent = (thisArg, evType, handler) => {
    if (reType.test(evType) === false) return false;
    if (rePattern.test(handler) === false) return false;
    if (targetSelector !== undefined && elementMatches(thisArg) === false) return false;
    return true;
  };

  const proxyFn = (context) => {
    // Both arguments empty is uBO's logging-only mode: never prevent.
    if (type === '' && pattern === '') return context.reflect();
    const { callArgs, thisArg } = context;
    let t = '';
    let h = '';
    try {
      t = String(callArgs[0]);
      const listener = callArgs[1];
      if (typeof listener === 'function') {
        h = functionToString(listener);
      } else if (typeof listener === 'object' && listener !== null) {
        if (typeof listener.handleEvent === 'function') h = functionToString(listener.handleEvent);
      } else {
        h = String(listener);
      }
    } catch { /* exotic argument — match on what we did read */ }
    if (shouldPrevent(thisArg, t, h)) return undefined;
    return context.reflect();
  };

  proxyApply(EventTarget.prototype, 'addEventListener', proxyFn);
  if (Object.hasOwn(document, 'addEventListener')) proxyApply(document, 'addEventListener', proxyFn);
  if (Object.hasOwn(window, 'addEventListener')) proxyApply(window, 'addEventListener', proxyFn);
}
