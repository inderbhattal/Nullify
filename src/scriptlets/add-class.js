/** add-class.js — Add CSS classes to matching elements. */
export function addClass(classNames, selector) {
  if (!classNames || !selector) return;
  const classes = classNames.split(/\s+/);
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
  new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: true });
}
