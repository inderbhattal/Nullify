/**
 * cosmetic-engine.js
 *
 * Handles element hiding (cosmetic filtering) for the content script.
 *
 * Capabilities:
 *  - Generic + domain-specific CSS injection at document_start
 *  - Exception rules (#@#) — prevents hiding user-allowed elements
 *  - MutationObserver to hide dynamically injected ad elements
 *  - Full procedural filter support:
 *      :has()              native CSS (Chrome 105+)
 *      :has-text(text|/re/) hide elements containing matching text
 *      :upward(n)          traverse n ancestor levels
 *      :upward(sel)        traverse to closest ancestor matching sel
 *      :nth-ancestor(n)    alias for :upward(n)
 *      :matches-css(p: v)  check computed style (supports regex values)
 *      :matches-css-before/:matches-css-after — ::before/::after pseudo
 *      :min-text-length(n) hide elements with at least n chars of text
 *      :xpath(expr)        select elements via XPath expression
 *      :watch-attr(a,b)    re-evaluate when listed attributes change
 *  - Operator chaining: div:has-text(Ad):upward(article) fully supported
 *  - Debounced MutationObserver re-runs (no thrashing)
 *  - Reports hidden element count to background
 */

const STYLE_ID = '__adblock_cosmetic_styles__';
const EXCEPTION_STYLE_ID = '__adblock_exception_styles__';
const ELEMENT_ATTR = '__adblock_hidden__';

// All known procedural operators in specificity order
// (longer names must come before shorter prefixes to avoid partial matches)
const PROC_OPS = [
  'matches-css-before',
  'matches-css-after',
  'matches-css',
  'has-text',
  'nth-ancestor',
  'upward',
  'min-text-length',
  'xpath',
  'watch-attr',
];

// ---------------------------------------------------------------------------
// Selector parsing helpers
// ---------------------------------------------------------------------------

/** Returns true if the selector string contains any procedural operator. */
function isProceduralSelector(selector) {
  for (const op of PROC_OPS) {
    if (selector.includes(':' + op + '(')) return true;
  }
  return false;
}

/**
 * Depth-aware scan for the first procedural operator in a selector string.
 * Skips content inside parentheses (e.g. :not(...), :nth-child(...)).
 *
 * Returns { base, op, arg, rest } or null.
 *   base — CSS selector before the operator
 *   op   — operator name (without leading colon)
 *   arg  — text between the outermost parentheses
 *   rest — everything after the closing parenthesis (for chaining)
 */
function extractFirstOp(selector) {
  let depth = 0;

  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (ch !== ':' || depth !== 0) continue;

    for (const op of PROC_OPS) {
      if (selector.startsWith(op + '(', i + 1)) {
        const base = selector.slice(0, i).trimEnd();
        const argStart = i + 1 + op.length + 1; // skip ':op('

        // Find matching closing paren with depth tracking
        let d = 1, j = argStart;
        while (j < selector.length && d > 0) {
          if (selector[j] === '(') d++;
          else if (selector[j] === ')') d--;
          j++;
        }

        const arg = selector.slice(argStart, j - 1);
        const rest = selector.slice(j).trimStart();
        return { base, op, arg, rest };
      }
    }
  }
  return null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// CosmeticEngine class
// ---------------------------------------------------------------------------

export class CosmeticEngine {
  constructor() {
    this._styleEl = null;
    this._exceptionStyleEl = null;
    this._observer = null;
    this._attrObserver = null;
    this._cssSelectors = [];        // selectors safe for a single CSS block
    this._proceduralRules = [];     // selectors requiring JS evaluation
    this._watchAttrRules = [];      // { baseSelector, attrs, rule }
    this._exceptions = new Set();   // selectors from #@# rules
    this._hiddenCount = 0;
    this._selectorHits = new Map(); // selector -> count
    this._reportTimer = null;
    this._proceduralDebounce = null;
  }

  /**
   * Initialize with rules from the background service worker.
   * @param {{ generic: string[], domainSpecific: string[], exceptions?: string[] }} rules
   */
  init(rules) {
    const exceptions = new Set(rules.exceptions || []);

    // Ingest all selectors, separating procedural from plain CSS
    const allSelectors = [
      ...(rules.generic || []),
      ...(rules.domainSpecific || []),
    ];

    const cssSelectors = [];
    for (const sel of allSelectors) {
      if (!sel || !sel.trim()) continue;
      if (exceptions.has(sel)) continue; // user excepted this selector
      if (isProceduralSelector(sel)) {
        this._proceduralRules.push(sel);
      } else {
        cssSelectors.push(sel);
      }
    }

    this._cssSelectors = cssSelectors;
    this._exceptions = exceptions;

    if (cssSelectors.length > 0) this._injectCSS(cssSelectors);
    if (exceptions.size > 0) this._injectExceptionCSS([...exceptions]);
    if (this._proceduralRules.length > 0) this._applyAllProcedural();

    this._detectWatchAttrRules();
    this._startObserver();
  }

  // ---------------------------------------------------------------------------
  // CSS injection
  // ---------------------------------------------------------------------------

  _injectCSS(selectors) {
    this._styleEl?.remove();

    const css = selectors
      .map((s) =>
        `${s}{display:none!important;visibility:hidden!important;` +
        `opacity:0!important;height:0!important;overflow:hidden!important}`
      )
      .join('\n');

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    (document.head || document.documentElement).prepend(style);
    this._styleEl = style;
  }

  /**
   * Inject a stylesheet that un-hides excepted selectors.
   * Appended AFTER the hide stylesheet so it wins the specificity war.
   */
  _injectExceptionCSS(selectors) {
    this._exceptionStyleEl?.remove();

    const css = selectors
      .map((s) =>
        `${s}{display:revert!important;visibility:revert!important;` +
        `opacity:revert!important;height:revert!important;overflow:revert!important}`
      )
      .join('\n');

    const style = document.createElement('style');
    style.id = EXCEPTION_STYLE_ID;
    style.textContent = css;
    // Append — must come after STYLE_ID to override it
    (document.head || document.documentElement).appendChild(style);
    this._exceptionStyleEl = style;
  }

  // ---------------------------------------------------------------------------
  // Procedural cosmetic filters
  // ---------------------------------------------------------------------------

  _applyAllProcedural() {
    for (const rule of this._proceduralRules) {
      this._applyProcedural(rule);
    }
  }

  /**
   * Apply a single procedural selector rule.
   * Supports full operator chaining, e.g.:
   *   div:has-text(Sponsored):upward(article)
   */
  _applyProcedural(selector) {
    // :xpath() selects elements independently — handle separately
    const firstOp = extractFirstOp(selector);
    if (firstOp?.op === 'xpath' && !firstOp.base) {
      this._applyXPath(firstOp.arg);
      return;
    }

    if (!firstOp) {
      // Plain CSS — shouldn't be here normally, but handle gracefully
      try {
        for (const el of document.querySelectorAll(selector)) this._hideElement(el, selector);
      } catch { /* invalid selector */ }
      return;
    }

    const { base, op, arg, rest } = firstOp;
    let elements;
    try {
      elements = base ? [...document.querySelectorAll(base)] : [document.documentElement];
    } catch { return; }

    for (const el of elements) {
      const result = this._applyOp(el, op, arg);
      if (!result) continue;

      if (rest) {
        // More operators in the chain
        this._applyProceduralOnElement(result, rest, selector);
      } else {
        this._hideElement(result, selector);
      }
    }
  }

  /**
   * Continue applying a chained selector (rest part) starting from a
   * single already-resolved element.
   */
  _applyProceduralOnElement(el, selectorRest, fullSelector) {
    const parsed = extractFirstOp(selectorRest);
    if (!parsed) {
      // Remaining part is a plain CSS sub-selector; match within/against el
      try {
        if (el.matches?.(selectorRest)) {
          this._hideElement(el, fullSelector);
        }
        for (const child of el.querySelectorAll(selectorRest)) {
          this._hideElement(child, fullSelector);
        }
      } catch { /* invalid selector */ }
      return;
    }

    const result = this._applyOp(el, parsed.op, parsed.arg);
    if (!result) return;

    if (parsed.rest) {
      this._applyProceduralOnElement(result, parsed.rest, fullSelector);
    } else {
      this._hideElement(result, fullSelector);
    }
  }

  /**
   * Apply a single operator to an element.
   * Returns the target element to hide, or null if this element should be
   * skipped (filter did not match).
   */
  _applyOp(el, op, arg) {
    switch (op) {
      // ---- :upward(n) / :nth-ancestor(n) / :upward(selector) ----
      case 'upward':
      case 'nth-ancestor': {
        const n = parseInt(arg, 10);
        if (!isNaN(n)) {
          let target = el;
          for (let i = 0; i < n; i++) {
            target = target?.parentElement;
            if (!target) return null;
          }
          return target;
        }
        // Selector form: :upward(article)
        try { return el.closest(arg.trim()) || null; } catch { return null; }
      }

      // ---- :has-text(text) or :has-text(/regex/flags) ----
      case 'has-text': {
        let pattern;
        if (arg.startsWith('/')) {
          const lastSlash = arg.lastIndexOf('/');
          pattern = new RegExp(arg.slice(1, lastSlash), arg.slice(lastSlash + 1) || 'i');
        } else {
          pattern = new RegExp(escapeRegex(arg), 'i');
        }
        return pattern.test(el.textContent) ? el : null;
      }

      // ---- :min-text-length(n) ----
      case 'min-text-length': {
        const n = parseInt(arg, 10);
        return el.textContent.trim().length >= n ? el : null;
      }

      // ---- :matches-css(property: value) ----
      case 'matches-css':
      case 'matches-css-before':
      case 'matches-css-after': {
        const pseudo = op === 'matches-css' ? null
          : op === 'matches-css-before' ? '::before' : '::after';
        const colonIdx = arg.indexOf(':');
        if (colonIdx === -1) return null;
        const prop = arg.slice(0, colonIdx).trim();
        const val = arg.slice(colonIdx + 1).trim();
        const computed = getComputedStyle(el, pseudo).getPropertyValue(prop).trim();
        if (val.startsWith('/')) {
          const lastSlash = val.lastIndexOf('/');
          const re = new RegExp(val.slice(1, lastSlash), val.slice(lastSlash + 1));
          return re.test(computed) ? el : null;
        }
        return computed === val ? el : null;
      }

      // ---- :watch-attr(attr1,attr2) ---- (pass-through; observer handles re-eval) ----
      case 'watch-attr':
        return el;

      default:
        return el;
    }
  }

  /** Apply an XPath expression directly to the document. */
  _applyXPath(expr) {
    try {
      const result = document.evaluate(
        expr, document, null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
      );
      for (let i = 0; i < result.snapshotLength; i++) {
        const node = result.snapshotItem(i);
        if (node?.nodeType === Node.ELEMENT_NODE) this._hideElement(node, `xpath(${expr})`);
      }
    } catch { /* invalid XPath expression */ }
  }

  // ---------------------------------------------------------------------------
  // :watch-attr support — separate attribute observer
  // ---------------------------------------------------------------------------

  _detectWatchAttrRules() {
    const attrMap = new Map(); // attr → Set of selectors to re-evaluate

    for (const rule of this._proceduralRules) {
      const parsed = extractFirstOp(rule);
      if (parsed?.op !== 'watch-attr') continue;

      const attrs = parsed.arg.split(',').map((a) => a.trim()).filter(Boolean);
      const baseSelector = parsed.base;

      for (const attr of attrs) {
        if (!attrMap.has(attr)) attrMap.set(attr, new Set());
        attrMap.get(attr).add(baseSelector || '*');
      }
      this._watchAttrRules.push({ base: parsed.base, attrs, rest: parsed.rest });
    }

    if (attrMap.size === 0) return;

    const allAttrs = [...attrMap.keys()];
    this._attrObserver = new MutationObserver(() => {
      this._scheduleProceduralRun();
    });
    this._attrObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: allAttrs,
      subtree: true,
    });
  }

  // ---------------------------------------------------------------------------
  // MutationObserver — handle dynamically injected ads
  // ---------------------------------------------------------------------------

  _startObserver() {
    if (this._observer) return;
    if (this._cssSelectors.length === 0 && this._proceduralRules.length === 0) return;

    // Build a combined CSS selector for fast matching of added nodes
    const combinedSelector = this._cssSelectors.length > 0
      ? this._cssSelectors.join(',')
      : null;

    this._observer = new MutationObserver((mutations) => {
      let needsProcedural = false;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          if (combinedSelector) {
            try {
              for (const sel of this._cssSelectors) {
                if (node.matches?.(sel)) this._hideElement(node, sel);
                for (const el of node.querySelectorAll(sel)) this._hideElement(el, sel);
              }
            } catch { /* invalid selector */ }
          }

          if (this._proceduralRules.length > 0) needsProcedural = true;
        }
      }

      if (needsProcedural) this._scheduleProceduralRun();
    });

    this._observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  /** Debounced procedural re-run — coalesces rapid DOM mutations. */
  _scheduleProceduralRun() {
    if (this._proceduralDebounce) return;
    this._proceduralDebounce = setTimeout(() => {
      this._proceduralDebounce = null;
      this._applyAllProcedural();
    }, 100);
  }

  stopObserver() {
    this._observer?.disconnect();
    this._observer = null;
    this._attrObserver?.disconnect();
    this._attrObserver = null;
    clearTimeout(this._proceduralDebounce);
    this._proceduralDebounce = null;
  }

  // ---------------------------------------------------------------------------
  // Element hiding
  // ---------------------------------------------------------------------------

  _hideElement(el, selector = 'unknown') {
    if (!el || el.getAttribute(ELEMENT_ATTR)) return;
    if (this._exceptions.has(el.className) || this._isExcepted(el)) return;
    el.setAttribute(ELEMENT_ATTR, '1');
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('visibility', 'hidden', 'important');
    
    this._hiddenCount++;
    this._selectorHits.set(selector, (this._selectorHits.get(selector) || 0) + 1);
    
    this._scheduleReport();
  }

  /** Check if any exception selector matches this element. */
  _isExcepted(el) {
    for (const sel of this._exceptions) {
      try { if (el.matches?.(sel)) return true; } catch { /* invalid selector */ }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Reporting to background
  // ---------------------------------------------------------------------------

  _scheduleReport() {
    if (this._reportTimer) return;
    this._reportTimer = setTimeout(() => {
      this._reportTimer = null;
      if (this._hiddenCount > 0) {
        const hostname = location.hostname.replace(/^www\./, '');
        const total = this._hiddenCount;
        const hits = Array.from(this._selectorHits.entries());
        
        this._hiddenCount = 0;
        this._selectorHits.clear();

        // One message per selector hit for the Logger
        for (const [selector, count] of hits) {
          chrome.runtime.sendMessage({
            type: 'CONTENT_BLOCKED',
            payload: { count, selector, hostname },
          }).catch(() => {});
        }
      }
    }, 500);
  }
}
