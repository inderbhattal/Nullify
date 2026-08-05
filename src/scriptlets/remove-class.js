/** remove-class.js — Remove CSS classes from matching elements. */
export function removeClass(classNames, selector, behavior) {
  if (!classNames) return;
  // uBO separates multiple class tokens with `|`, not whitespace.
  const classes = String(classNames).split(/\s*\|\s*/).filter(Boolean);
  if (!classes.length) return;
  // §5.26: the default selector used only the first token, so
  // `rc, ad-shown|ad-active` never touched an element carrying only the
  // second class. uBO builds one selector per token, prefixed by the
  // (possibly empty) explicit selector, and joins them with a comma.
  const sel = classes.map((c) => `${selector || ''}.${cssEscape(c)}`).join(',');
  let rafId = null;
  const apply = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      try {
        document.querySelectorAll(sel).forEach((el) => el.classList.remove(...classes));
      } catch {}
    });
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  if (behavior !== 'stay') {
    // uBO parity: without `stay`, stop observing once the page has loaded —
    // an undisconnectable observer otherwise runs for the tab's lifetime.
    window.addEventListener('load', () => {
      apply();
      observer.disconnect();
    }, { once: true });
  }
}

/** `CSS.escape` where available; the identifier grammar otherwise. */
function cssEscape(token) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(token);
  return token.replace(/[^\w-]/g, (c) => `\\${c}`);
}
