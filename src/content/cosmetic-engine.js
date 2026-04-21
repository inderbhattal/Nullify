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
  'remove',
  'style',
  'matches-path',
  'matches-attr',
  'if-not',
  'if',
  'semantic',
];

// ---------------------------------------------------------------------------
// Selector parsing helpers
// ---------------------------------------------------------------------------

/** Returns true if the selector string contains any procedural operator. */
function isProceduralSelector(selector) {
  // Simple check first
  for (const op of PROC_OPS) {
    if (selector.includes(':' + op + '(')) return true;
  }
  return false;
}

/**
 * Depth-aware scan for the first procedural operator in a selector string.
 * This version properly handles nested parentheses (e.g. :has(...:has-text(...)))
 * by recursively checking the content of standard CSS pseudo-classes.
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

  // If no top-level procedural operator was found, check if there's one 
  // nested inside a native pseudo-class like :has(), :not(), :is(), :where().
  // We look for :name( ... ) and then recursively check the inside.
  const nativePseudos = [':has(', ':not(', ':is(', ':where('];
  for (const pseudo of nativePseudos) {
    const idx = selector.indexOf(pseudo);
    if (idx !== -1) {
      // Find the content of this pseudo-class
      let d = 1, j = idx + pseudo.length;
      while (j < selector.length && d > 0) {
        if (selector[j] === '(') d++;
        else if (selector[j] === ')') d--;
        j++;
      }
      const inner = selector.slice(idx + pseudo.length, j - 1);
      if (isProceduralSelector(inner)) {
        // We found a nested procedural operator.
        // To handle this, we treat the entire pseudo-class as part of the 'base'
        // for the NEXT procedural operator, OR if there's no more top-level ops,
        // we must treat the entire selector as procedural.
        //
        // However, the easiest way to trigger the procedural engine for 
        // nested cases is to return a special 'wrap' operator or just 
        // ensure isProceduralSelector returns true (which it does).
        //
        // The real issue is that extractFirstOp is used by parseProceduralPlan 
        // which expects to split the string. If we have:
        // div:has(span:has-text(Foo))
        // there is NO top-level procedural operator.
        
        // Let's implement a 'pseudo' operator that handles native pseudo-classes 
        // containing procedural logic.
        const base = selector.slice(0, idx).trimEnd();
        const op = pseudo.slice(1, -1); // 'has', 'not', etc.
        const arg = inner;
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
    this._selectorHits = new Map(); // selector -> { count, action }
    this._hideQueue = new Set();    // elements pending hide
    this._removeQueue = new Set();  // elements pending physical removal
    this._matchCache = new Map();   // selector -> WeakMap(el -> bool)
    // Subtree roots mutated since the last procedural run. A match-cache
    // entry for element `e` is trusted iff none of the last-run's dirty
    // roots equal `e` or contain it. Bumps per scheduled run.
    this._dirtyRoots = [];          // accumulating during observation
    this._lastDirtyRoots = [];      // snapshot used by the in-progress run
    this._reportTimer = null;
    this._proceduralDebounce = null;
    this._rafId = null;
  }

  /**
   * Initialize with rules from the background service worker.
   * @param {{ generic: (string|object)[], domainSpecific: (string|object)[], exceptions?: string[] }} rules
   * @param {boolean} proceduralOnly If true, skip injecting static CSS (handled by SW)
   */
  init(rules, proceduralOnly = false) {
    const exceptions = new Set(rules.exceptions || []);

    // Ingest all selectors (now mostly domain-specific + user rules)
    const allRules = [
      ...(rules.generic || []),
      ...(rules.domainSpecific || []),
    ];

    const cssSelectors = [];
    for (const rule of allRules) {
      if (!rule) continue;
      
      const isPreParsed = typeof rule === 'object' && rule.plan;
      const selector = isPreParsed ? rule.selector : rule;
      
      if (!selector || !selector.trim()) continue;
      if (exceptions.has(selector)) continue; // user excepted this selector
      
      if (isPreParsed) {
        this._proceduralRules.push(rule);
        continue;
      }

      const isProcedural = isProceduralSelector(selector);
      
      // Fast-path: Chrome supports :has(), :not(), :is(), :where() natively now. 
      // We only use the JS procedural engine if it contains custom Nullify operators.
      const hasCustomOp = selector.includes(':has-text(') || selector.includes(':upward(') || 
                         selector.includes(':xpath(') || selector.includes(':matches-css') || 
                         selector.includes(':min-text-length') || selector.includes(':watch-attr') ||
                         selector.includes(':nth-ancestor(') || selector.includes(':matches-path(') ||
                         selector.includes(':matches-attr(') || selector.includes(':remove(') ||
                         selector.includes(':style(') || selector.includes(':if(') ||
                         selector.includes(':if-not(');

      if (!hasCustomOp) {
        cssSelectors.push(selector);
        continue;
      }

      if (isProcedural) {
        this._proceduralRules.push({
          selector: selector,
          plan: parseProceduralPlan(selector)
        });
      } else {
        cssSelectors.push(selector);
      }
    }

    this._cssSelectors = cssSelectors;
    this._exceptions = exceptions;

    // Only inject extra CSS if we have site-specific or user rules AND not in procedural mode.
    if (!proceduralOnly && cssSelectors.length > 0) this._injectCSS(cssSelectors);
    if (!proceduralOnly && exceptions.size > 0) this._injectExceptionCSS([...exceptions]);
    
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
      } catch (e) {
        console.warn('[Nullify] Invalid selector in cosmetic rule:', first.selector, e.message);
        return;
      }
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
      // Don't hide if the rule ended with a style application
      if (fullSelector.includes(':style(')) return;
      
      this._hideElement(el, fullSelector);
      return;
    }

    const step = remainingPlan[0];
    const nextSteps = remainingPlan.slice(1);

    if (step.type === 'op') {
      const result = this._applyOp(el, step.op, step.arg, fullSelector);
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
  _getCachedMatch(el, op, arg, evaluator) {
    const key = `${op}|${arg}`;
    let opCache = this._matchCache.get(key);
    if (!opCache) {
      opCache = new WeakMap();
      this._matchCache.set(key, opCache);
    }

    // Only trust the cached value when `el` is not inside a subtree that
    // was mutated this tick. `_lastDirtyRoots` is the snapshot captured
    // when this procedural run was scheduled.
    const dirty = this._isInDirtySubtree(el);
    if (!dirty && opCache.has(el)) {
      return opCache.get(el);
    }

    const result = evaluator();
    opCache.set(el, result);
    return result;
  }

  _isInDirtySubtree(el) {
    const roots = this._lastDirtyRoots;
    if (!roots || roots.length === 0) return false;
    for (const root of roots) {
      if (root === el) return true;
      // `contains` handles disconnected-subtree case; Element.contains is
      // safe even when `root` was removed between mutation and lookup.
      if (root.contains && root.contains(el)) return true;
    }
    return false;
  }

  /** Check if an element matches a procedural selector plan (used by :has, :not, etc). */
  _matchesProcedural(el, proceduralSelector) {
    const isPreParsed = typeof proceduralSelector === 'object' && proceduralSelector.plan;
    const plan = isPreParsed ? proceduralSelector.plan : parseProceduralPlan(proceduralSelector);
    if (plan.length === 0) return true;

    // Fast-path: check if any descendant matches the plan starting with its first step
    let results = [el];

    for (const step of plan) {
      const nextResults = [];
      for (const res of results) {
        if (step.type === 'op') {
          const r = this._applyOp(res, step.op, step.arg, proceduralSelector);
          if (r) nextResults.push(r);
        } else if (step.type === 'css') {
          if (res.matches?.(step.selector)) nextResults.push(res);
          // Only search children for the very first step if it's a CSS selector
          if (step === plan[0]) {
            for (const child of res.querySelectorAll(step.selector)) {
              nextResults.push(child);
            }
          }
        }
      }
      results = [...new Set(nextResults)];
      if (results.length === 0) return false;
    }

    return results.length > 0;
  }

  _applyOp(el, op, arg, fullSelector) {
    return this._getCachedMatch(el, op, arg, () => {
      switch (op) {
        // ... (previous cases)
        // (Note: I'm replacing the whole _applyOp switch block for safety)
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
          try { return el.closest(arg.trim()) || null; } catch { return null; }
        }

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

        case 'min-text-length': {
          const n = parseInt(arg, 10);
          return el.textContent.trim().length >= n ? el : null;
        }

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

        case 'matches-path': {
          const path = location.pathname + location.search;
          if (arg.startsWith('/')) {
            const lastSlash = arg.lastIndexOf('/');
            const re = new RegExp(arg.slice(1, lastSlash), arg.slice(lastSlash + 1) || 'i');
            return re.test(path) ? el : null;
          }
          return path.includes(arg) ? el : null;
        }

        case 'matches-attr': {
          const match = arg.match(/^([\w-]+)="?(.+?)"?$/);
          if (!match) return null;
          const [, attr, val] = match;
          const actual = el.getAttribute(attr);
          if (actual === null) return null;
          if (val.startsWith('/')) {
            const lastSlash = val.lastIndexOf('/');
            const re = new RegExp(val.slice(1, lastSlash), val.slice(lastSlash + 1) || 'i');
            return re.test(actual) ? el : null;
          }
          return actual === val ? el : null;
        }

        case 'style': {
          const rules = arg.split(';').map(r => r.trim()).filter(Boolean);
          for (const rule of rules) {
            const colonIdx = rule.indexOf(':');
            if (colonIdx === -1) continue;
            const prop = rule.slice(0, colonIdx).trim();
            const val = rule.slice(colonIdx + 1).trim();
            el.style.setProperty(
              prop, 
              val.replace(/!important/g, '').trim(), 
              val.includes('!important') ? 'important' : ''
            );
          }
          return el;
        }

        case 'watch-attr':
          return el;

        case 'remove':
          this._removeElement(el, fullSelector);
          return null;

        case 'has': {
          // If the argument is not procedural, we can use a fast native check
          if (!isProceduralSelector(arg)) {
            try { return el.querySelector(arg) ? el : null; } catch { return null; }
          }
          // For procedural :has(), we only need to check candidates that match the first CSS part
          const plan = parseProceduralPlan(arg);
          const first = plan[0];
          let candidates = [];
          if (first?.type === 'css') {
            candidates = el.querySelectorAll(first.selector);
          } else {
            // No base CSS selector, must check all (rare for :has)
            candidates = el.querySelectorAll('*');
          }
          
          for (const cand of candidates) {
            if (this._matchesProcedural(cand, { selector: arg, plan })) return el;
          }
          return null;
        }

        case 'semantic': {
          // Skip semantic classification on article bodies — the WASM
          // matcher trips on legitimate text like "sponsored content"
          // appearing in editorial copy. Restrict to ad-shaped
          // containers (small widgets, iframes, aside elements).
          const tag = el.tagName;
          const isArticleContext =
            !!el.closest('article, main, [role="article"], [role="main"]');
          const text = el.textContent || '';
          const tooLarge = text.length > 400;
          if (
            isArticleContext ||
            tooLarge ||
            tag === 'ARTICLE' ||
            tag === 'MAIN' ||
            tag === 'P' ||
            tag === 'H1' ||
            tag === 'H2' ||
            tag === 'H3'
          ) {
            return null;
          }
          if (!text || text.length < 3) return null;

          // Use cache to avoid redundant messages
          const cacheKey = `semantic|${text.slice(0, 100)}`;
          const cached = this._matchCache.get(cacheKey);
          if (cached !== undefined) return cached ? el : null;

          // Perform async check
          chrome.runtime.sendMessage({
            type: 'CHECK_SEMANTIC_AD',
            payload: { text }
          }).then(res => {
            if (res && res.isAd) {
              this._matchCache.set(cacheKey, true);
              this._removeElement(el, fullSelector);
            } else {
              this._matchCache.set(cacheKey, false);
            }
          }).catch(() => {});

          return null; // Return null initially, will hide later if detected
        }

        case 'not':
          return !this._matchesProcedural(el, arg) ? el : null;

        case 'is':
        case 'where':
          return this._matchesProcedural(el, arg) ? el : null;

        default:
          return el;
      }
    });
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
    } catch (e) {
      console.warn('[Nullify] Invalid XPath expression in cosmetic rule:', expr, e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // :watch-attr support — separate attribute observer
  // ---------------------------------------------------------------------------

  _detectWatchAttrRules() {
    const attrMap = new Map(); // attr → Set of selectors to re-evaluate

    for (const rule of this._proceduralRules) {
      const parsed = extractFirstOp(rule.selector);
      if (parsed?.op !== 'watch-attr') continue;

      const attrs = parsed.arg.split(',').map((a) => a.trim()).filter(Boolean);
      const baseSelector = parsed.base;

      for (const attr of attrs) {
        if (!attrMap.has(attr)) attrMap.set(attr, new Set());
        attrMap.get(attr).add(baseSelector || '*');
      }
      this._watchAttrRules.push({ base: parsed.base, attrs, rest: parsed.rest, fullSelector: rule.selector });
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
    
    // Only start MutationObserver if we have procedural rules or watch-attr rules.
    // Static CSS rules injected via SW already work for dynamic elements natively.
    if (this._proceduralRules.length === 0 && this._watchAttrRules.length === 0) return;

    this._observer = new MutationObserver((mutations) => {
      let needsProcedural = false;

      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          needsProcedural = true;
          // Record the mutation target — any descendant of this node is
          // considered cache-dirty until the next procedural run consumes
          // the batch.
          if (mutation.target) this._dirtyRoots.push(mutation.target);
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1 /* ELEMENT */) this._dirtyRoots.push(node);
          }
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
      // Swap the dirty-roots buffer for this run instead of wiping the
      // whole match cache. _getCachedMatch consults _lastDirtyRoots to
      // invalidate only entries whose element lives inside a mutated
      // subtree — cache hits for unaffected elements survive.
      this._lastDirtyRoots = this._dirtyRoots;
      this._dirtyRoots = [];
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
    
    this._hideQueue.add(el);
    this._hiddenCount++;
    
    const hit = this._selectorHits.get(selector) || { count: 0, action: 'hide' };
    hit.count++;
    this._selectorHits.set(selector, hit);

    this._triggerRaf();
    this._scheduleReport();
  }

  _removeElement(el, selector = 'unknown') {
    if (!el || !el.parentElement) return;
    if (this._exceptions.has(el.className) || this._isExcepted(el)) return;

    this._removeQueue.add(el);
    this._hiddenCount++;
    
    const hit = this._selectorHits.get(selector) || { count: 0, action: 'remove' };
    hit.count++;
    this._selectorHits.set(selector, hit);

    this._triggerRaf();
    this._scheduleReport();
  }

  _triggerRaf() {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      
      // Process hiding
      for (const target of this._hideQueue) {
        target.setAttribute(ELEMENT_ATTR, '1');
        target.style.setProperty('display', 'none', 'important');
        target.style.setProperty('visibility', 'hidden', 'important');
      }
      this._hideQueue.clear();

      // Process removal
      for (const target of this._removeQueue) {
        target.remove();
      }
      this._removeQueue.clear();
    });
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
        for (const [selector, hit] of hits) {
          chrome.runtime.sendMessage({
            type: 'CONTENT_BLOCKED',
            payload: { count: hit.count, action: hit.action, selector, hostname },
          }).catch(() => {});
        }
      }
    }, 500);
  }
}
