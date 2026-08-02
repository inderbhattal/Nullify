/** add-class.js — Add CSS classes to matching elements. */
export function addClass(classNames, selector, behavior) {
  if (!classNames || !selector) return;
  // uBO separates multiple class tokens with `|`, not whitespace.
  const classes = String(classNames).split(/\s*\|\s*/).filter(Boolean);
  if (!classes.length) return;
  let rafId = null;
  const apply = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      try {
        document.querySelectorAll(selector).forEach((el) => el.classList.add(...classes));
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
