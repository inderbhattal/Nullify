/** remove-attr.js — Remove attributes from matching elements. */
export function removeAttr(attrs, selector, behavior) {
  if (!attrs) return;
  // uBO separates multiple attributes with `|` — splitting on whitespace made
  // "onkeydown|onselectstart" a single (invalid) attribute name.
  const attrList = String(attrs).split(/\s*\|\s*/).filter(Boolean);
  if (!attrList.length) return;
  const sel = selector || attrList.map((a) => `[${a}]`).join(',');

  let rafId = null;
  const removeAll = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      try {
        document.querySelectorAll(sel).forEach((el) => {
          for (const a of attrList) el.removeAttribute(a);
        });
      } catch {}
    });
  };

  removeAll();
  if (behavior !== 'stay') {
    document.addEventListener('DOMContentLoaded', removeAll);
  } else {
    // `stay` keeps enforcing for the page's lifetime, so the observer is
    // intentionally never disconnected. attributeFilter keeps it from running
    // a full-document querySelectorAll on every unrelated class/style flip.
    new MutationObserver(removeAll).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: attrList,
    });
  }
}
