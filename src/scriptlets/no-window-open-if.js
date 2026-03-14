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

function patternToRegex(p) {
  if (p.startsWith('/') && p.endsWith('/')) return new RegExp(p.slice(1, -1));
  return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}
