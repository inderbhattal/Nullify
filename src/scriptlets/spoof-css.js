import { maskNative, wrapInstanceGetter } from './shared-utils.js';

/**
 * spoof-css.js
 *
 * Overrides getComputedStyle(), offsetHeight, offsetWidth, offsetParent
 * so that elements matching ad-related CSS selectors appear visible to
 * anti-adblock detection scripts.
 *
 * Usage in filter lists:
 *   example.com##+js(spoof-css, .ad-slot, display, block)
 *   example.com##+js(spoof-css, #adsbox, offsetHeight, 1)
 *
 * Args:
 *   1. CSS selector of target elements (comma-separated)
 *   2. Property to spoof: display | visibility | opacity | offsetHeight |
 *                         offsetWidth | offsetParent | any CSS property name
 *   3. Value to return (default: spoofed to look like a visible element)
 */
const OFFSET_PROPS = ['offsetHeight', 'offsetWidth', 'offsetLeft', 'offsetTop'];

const toCamelCase = (s) => String(s).replace(/-[a-z]/g, (m) => m.charAt(1).toUpperCase());

/**
 * §5.26: uBO's signature is `(selector, ...propertyValuePairs)`. This used to
 * take exactly one pair, so 2 of the 4 shipped rules silently lost every
 * argument past the third.
 */
export function spoofCss(selector, ...args) {
  if (!selector || args.length === 0) return;

  const matches = (el) => {
    try { return el?.matches?.(selector); } catch { return false; }
  };

  // Keyed by camelCase so `zIndex` and `z-index` resolve to the same entry.
  const cssPairs = new Map();

  for (let i = 0; i < args.length; i += 2) {
    const prop = args[i];
    if (typeof prop !== 'string' || prop === '') break;
    const value = args[i + 1] !== undefined ? args[i + 1] : getSpoofValue(prop);

    // ---- Spoof DOM properties (offsetHeight, offsetWidth, …) ----
    if (OFFSET_PROPS.includes(prop)) {
      spoofOffsetProp(prop, Number(value) || 1, matches);
      continue;
    }
    if (prop === 'offsetParent') {
      spoofOffsetParent(matches);
      continue;
    }
    cssPairs.set(toCamelCase(prop), value);
  }

  if (cssPairs.size === 0) return;

  // ---- Spoof getComputedStyle (one wrapper for every pair) ----
  const origGCS = window.getComputedStyle;
  const wrapped = function (el, pseudo) {
    const result = origGCS.call(this, el, pseudo);
    if (pseudo || !matches(el)) return result;
    return new Proxy(result, {
      get(target, key) {
        if (typeof key === 'string' && cssPairs.has(toCamelCase(key))) {
          return cssPairs.get(toCamelCase(key));
        }
        if (key === 'getPropertyValue') {
          return (p) => (cssPairs.has(toCamelCase(p))
            ? cssPairs.get(toCamelCase(p))
            : target.getPropertyValue(p));
        }
        const val = Reflect.get(target, key);
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });
  };
  maskNative(wrapped, origGCS);
  window.getComputedStyle = wrapped;
}

function spoofOffsetProp(prop, numValue, matches) {
  wrapInstanceGetter(HTMLElement.prototype, prop, (real, el) => (
    matches(el) ? numValue : real
  ));
}

function spoofOffsetParent(matches) {
  wrapInstanceGetter(HTMLElement.prototype, 'offsetParent', (real, el) => (
    matches(el) ? document.body : real
  ));
}

function getSpoofValue(prop) {
  const visibleDefaults = {
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    height: '1px',
    width: '1px',
    offsetHeight: '1',
    offsetWidth: '1',
  };
  return visibleDefaults[prop] ?? 'block';
}
