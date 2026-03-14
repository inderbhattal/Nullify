/** add-class.js — Add CSS classes to matching elements. */
export function addClass(classNames, selector) {
  if (!classNames || !selector) return;
  const classes = classNames.split(/\s+/);
  const apply = () => {
    try {
      document.querySelectorAll(selector).forEach((el) => el.classList.add(...classes));
    } catch {}
  };
  apply();
  new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: true });
}
