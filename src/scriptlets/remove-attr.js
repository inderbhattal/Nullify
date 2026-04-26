/** remove-attr.js — Remove attributes from matching elements. */
export function removeAttr(attr, selector, behavior) {
  if (!attr) return;
  const sel = selector || '[' + attr + ']';

  let rafId = null;
  const removeAll = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      try {
        document.querySelectorAll(sel).forEach((el) => el.removeAttribute(attr));
      } catch {}
    });
  };

  removeAll();
  if (behavior !== 'stay') {
    document.addEventListener('DOMContentLoaded', removeAll);
  } else {
    new MutationObserver(removeAll).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  }
}
