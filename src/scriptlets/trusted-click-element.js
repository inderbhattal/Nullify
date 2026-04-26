/**
 * trusted-click-element.js
 *
 * Automatically clicks an element matching a selector.
 * Useful for auto-dismissing cookie banners or "Accept" dialogs.
 *
 * Args:
 *   1. selector - CSS selector of the element to click.
 *   2. delay    - (Optional) Delay in ms before the first attempt. Default: 0.
 *   3. interval - (Optional) If > 0, repeat the attempt every N ms. Default: 0.
 *   4. max      - (Optional) Maximum number of attempts. Default: 1.
 */
export function trustedClickElement(selector, delay = 0, interval = 0, max = 1) {
  if (!selector) return;

  const d = parseInt(delay, 10) || 0;
  const i = parseInt(interval, 10) || 0;
  const m = parseInt(max, 10) || 1;

  let count = 0;

  function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent === null) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function attempt() {
    try {
      const el = document.querySelector(selector);
      if (el && isVisible(el)) {
        el.click();
        count++;
      }
    } catch { /* ignore */ }

    if (count < m && i > 0) {
      setTimeout(attempt, i);
    }
  }

  setTimeout(attempt, d);
}
