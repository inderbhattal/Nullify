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
export function spoofCss(selector, prop, value) {
  if (!selector || !prop) return;

  const spoofedValue = value !== undefined ? value : getSpoofValue(prop);

  const matches = (el) => {
    try { return el?.matches?.(selector); } catch { return false; }
  };

  // ---- Spoof DOM properties (offsetHeight, offsetWidth, offsetParent) ----
  const domProps = ['offsetHeight', 'offsetWidth', 'offsetLeft', 'offsetTop'];
  if (domProps.includes(prop)) {
    const numValue = Number(spoofedValue) || 1;
    for (const domProp of [prop]) {
      const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, domProp);
      if (!desc) continue;
      Object.defineProperty(HTMLElement.prototype, domProp, {
        get() {
          if (matches(this)) return numValue;
          return desc.get.call(this);
        },
        configurable: true,
      });
    }
    return;
  }

  if (prop === 'offsetParent') {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
    if (!desc) return;
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      get() {
        if (matches(this)) return document.body;
        return desc.get.call(this);
      },
      configurable: true,
    });
    return;
  }

  // ---- Spoof getComputedStyle ----
  const origGCS = window.getComputedStyle;
  window.getComputedStyle = function (el, pseudo) {
    const result = origGCS.call(this, el, pseudo);
    if (!pseudo && matches(el)) {
      return new Proxy(result, {
        get(target, key) {
          if (key === prop) return spoofedValue;
          if (key === 'getPropertyValue') {
            return (p) => (p === prop ? spoofedValue : target.getPropertyValue(p));
          }
          const val = Reflect.get(target, key);
          return typeof val === 'function' ? val.bind(target) : val;
        },
      });
    }
    return result;
  };
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
