import { initPattern, proxyApply, testPattern } from './shared-utils.js';

/**
 * no-window-open-if.js / prevent-window-open.js — Prevent window.open calls.
 *
 * @param {string} pattern - URL needle. A leading `!` inverts the match:
 *                           "block every popup except the ones matching this".
 * @param {string} delay   - Accepted for uBO compatibility; unused.
 * @param {string} decoy   - Truthy: hand the caller an about:blank window
 *                           instead of null, so page code that dereferences
 *                           the return value does not throw.
 */
export function noWindowOpenIf(pattern, delay, decoy) {
  // §4.18: `!` used to be escaped into the literal, so `!bergblock` blocked
  // only URLs containing the characters `!bergblock` — i.e. nothing. 46 corpus
  // rules use this form, and they are exactly the file-host and shortener
  // rules whose point is "allow our own popup, kill everything else": the
  // inversion shipped the popunder.
  const details = initPattern(pattern === undefined ? '' : pattern, { canNegate: true });
  const origOpen = window.open;
  if (typeof origOpen !== 'function') return;

  proxyApply(window, 'open', (context) => {
    const { callArgs } = context;
    // uBO tests the concatenation of all three arguments, not just the URL:
    // popunder code routinely puts its marker in the window name or features.
    const haystack = `${callArgs[0] ?? ''}${callArgs[1] ?? ''}${callArgs[2] ?? ''}`;
    if (testPattern(details, haystack) === false) return context.reflect();
    return decoy ? Reflect.apply(origOpen, window, ['about:blank']) : null;
  });
}

export function preventWindowOpen(match, decoy) {
  return noWindowOpenIf(match, undefined, decoy);
}
