/** remove-class.js — Remove CSS classes from matching elements. */
export function removeClass(classNames, selector) {
  if (!classNames) return;
  const classes = classNames.split(/\s+/);
  const sel = selector || '.' + classes[0];
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
  new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: true });
}
