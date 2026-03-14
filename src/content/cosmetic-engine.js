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

/**
 * Pre-parses a procedural selector into an execution plan (array of operations).
 * This avoids repeated string manipulation during DOM mutation scans.
 */
function parseProceduralPlan(selector) {
  const plan = [];
  let remaining = selector;

  while (remaining) {
    const firstOp = extractFirstOp(remaining);
    if (!firstOp) {
      // Remaining part is plain CSS
      plan.push({ type: 'css', selector: remaining.trim() });
      break;
    }
    
    // Add base CSS if present
    if (firstOp.base) {
      plan.push({ type: 'css', selector: firstOp.base });
    }
    
    // Add the operator
    plan.push({ type: 'op', op: firstOp.op, arg: firstOp.arg });
    remaining = firstOp.rest;
  }
  
  return plan;
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
      
      const isProcedural = isProceduralSelector(sel);
      
      // Fast-path: Chrome supports :has() natively now. 
      // If the selector is ONLY a native CSS :has() and no other Nullify-specific ops,
      // we can treat it as plain CSS.
      if (isProcedural && !sel.includes(':has-text(') && !sel.includes(':upward(') && 
          !sel.includes(':xpath(') && !sel.includes(':matches-css') && 
          !sel.includes(':min-text-length') && !sel.includes(':watch-attr')) {
        cssSelectors.push(sel);
        continue;
      }

      if (isProcedural) {
        this._proceduralRules.push({
          selector: sel,
          plan: parseProceduralPlan(sel)
        });
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

  /** Apply a pre-parsed procedural rule. */
  _applyProcedural(rule) {
    const { plan, selector } = rule;
    const first = plan[0];

    // Handle XPath independent entry point
    if (first.type === 'op' && first.op === 'xpath') {
      this._applyXPath(first.arg);
      return;
    }

    let elements = [];
    let planIdx = 0;

    // Determine initial set of elements
    if (first.type === 'css') {
      try {
        elements = [...document.querySelectorAll(first.selector)];
        planIdx = 1;
      } catch { return; }
    } else {
      elements = [document.documentElement];
    }

    for (const el of elements) {
      this._runPlanOnElement(el, plan.slice(planIdx), selector);
    }
  }

  /** Run the remaining steps of a plan on a specific element. */
  _runPlanOnElement(el, remainingPlan, fullSelector) {
    if (remainingPlan.length === 0) {
      this._hideElement(el, fullSelector);
      return;
    }

    const step = remainingPlan[0];
    const nextSteps = remainingPlan.slice(1);

    if (step.type === 'op') {
      const result = this._applyOp(el, step.op, step.arg);
      if (result) {
        this._runPlanOnElement(result, nextSteps, fullSelector);
      }
    } else if (step.type === 'css') {
      // CSS sub-selector: match within or against el
      try {
        if (el.matches?.(step.selector)) {
          this._runPlanOnElement(el, nextSteps, fullSelector);
        }
        for (const child of el.querySelectorAll(step.selector)) {
          this._runPlanOnElement(child, nextSteps, fullSelector);
        }
      } catch { /* invalid selector */ }
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

    this._observer = new MutationObserver((mutations) => {
      let needsProcedural = false;

      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          needsProcedural = true;
          break;
        }
      }

      if (needsProcedural && this._proceduralRules.length > 0) {
        this._scheduleProceduralRun();
      }
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
