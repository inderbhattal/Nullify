import { patternToRegex } from './shared-utils.js';

/** no-window-open-if.js / prevent-window-open.js — Prevent window.open calls. */
export function noWindowOpenIf(pattern, delay, decoy) {
  const re = pattern ? patternToRegex(pattern) : null;
  const origOpen = window.open.bind(window);

  window.open = function (url, ...rest) {
    if (!re || (url && re.test(url))) {
      return decoy ? origOpen('about:blank') : null;
    }
    return origOpen(url, ...rest);
  };
}

export function preventWindowOpen(match, decoy) {
  return noWindowOpenIf(match, undefined, decoy);
}
