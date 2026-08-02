import { toMatcher } from './shared-utils.js';

/**
 * trusted-click-element.js
 *
 * Automatically clicks elements matching the given selectors.
 * Useful for auto-dismissing cookie banners or "Accept" dialogs.
 *
 * Args (uBO order):
 *   1. selectors  - CSS selector(s) to click, in order, separated by `!!`.
 *   2. extraMatch - (Optional) `!!`-separated preconditions, each
 *                   `[!]cookie:pattern` or `[!]localStorage:key`. All must
 *                   hold or the scriptlet does nothing.
 *   3. delay      - (Optional) ms to wait before the first click. Default: 0.
 */

// uBO stops looking after 10 seconds; the old self-rescheduling timer ran for
// the lifetime of the page whenever the element never appeared.
const CLICK_DEADLINE_MS = 10000;

function extraMatchPasses(extraMatch) {
  for (let condition of String(extraMatch).split(/\s*!!\s*/)) {
    condition = condition.trim();
    if (!condition) continue;
    const negated = condition.startsWith('!');
    if (negated) condition = condition.slice(1);
    let matched;
    if (condition.startsWith('cookie:')) {
      const match = toMatcher(condition.slice(7));
      matched = document.cookie.split(';').some((c) => match(c.trim()));
    } else if (condition.startsWith('localStorage:')) {
      let value = null;
      try { value = localStorage.getItem(condition.slice(13)); } catch { /* blocked storage */ }
      matched = value !== null;
    } else {
      // Unknown condition kind: fail closed — clicking when uBO would not is
      // worse than not clicking.
      return false;
    }
    if (matched === negated) return false;
  }
  return true;
}

export function trustedClickElement(selectors, extraMatch = '', delay = '') {
  if (!selectors) return;
  if (extraMatch && !extraMatchPasses(extraMatch)) return;

  const selectorList = String(selectors).split(/\s*!!\s*/).filter(Boolean);
  if (!selectorList.length) return;
  const delayMs = parseInt(delay, 10) || 0;
  const readyAt = Date.now() + delayMs;

  let next = 0; // index of the next selector to click, in order
  let observer = null;
  let pendingId = null;
  let deadlineId = null;

  function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent === null) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function stop() {
    if (deadlineId !== null) clearTimeout(deadlineId);
    if (pendingId !== null) clearTimeout(pendingId);
    observer?.disconnect();
    observer = null;
  }

  function process() {
    if (next >= selectorList.length) {
      stop();
      return;
    }
    const remaining = readyAt - Date.now();
    if (remaining > 0) {
      // Not eligible to click yet — check again once the delay has elapsed.
      if (pendingId === null) {
        pendingId = setTimeout(() => {
          pendingId = null;
          process();
        }, remaining);
      }
      return;
    }
    while (next < selectorList.length) {
      let el = null;
      try {
        el = document.querySelector(selectorList[next]);
      } catch {
        stop(); // malformed selector — retrying cannot help
        return;
      }
      if (!el || !isVisible(el)) return; // wait for a DOM mutation
      try { el.click(); } catch { /* ignore */ }
      next++;
    }
    stop();
  }

  observer = new MutationObserver(process);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  deadlineId = setTimeout(stop, CLICK_DEADLINE_MS + delayMs);
  process();
}
