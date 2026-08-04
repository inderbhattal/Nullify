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

// Error tracking for content script diagnostics
const _errorStats = { errors: 0, lastError: null, proceduralFailures: 0 };

// A procedural rule that keeps throwing is disabled after this many failures
// instead of being allowed to abort the run for every rule after it (§4.11).
const MAX_PROC_RULE_FAILURES = 3;

// How far up from a mutation the observer marks ancestors as cache-dirty, so
// that container-evaluated operators reading downward are re-evaluated (§3.3).
// Bounded: framework cards nest a handful of levels above the mutated node,
// and every extra level costs cache utility for containers that cannot care.
const DIRTY_ANCESTOR_DEPTH = 8;

function _reportError(context, err) {
  _errorStats.errors++;
  _errorStats.lastError = { context, message: err?.message, timestamp: Date.now() };
  console.warn(`[Nullify Cosmetic] ${context}: ${err?.message || err}`);
}

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
 * Returned by `extractFirstOp` when an operator's argument list never closes.
 * Distinct from `null` ("no procedural operator here"), which is a normal
 * outcome — this one means the whole selector must be rejected (§5.20).
 */
const MALFORMED = Symbol('malformed-procedural-selector');

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

        // The argument never closed. Slicing anyway silently drops the last
        // character (`:has-text(Ad` → `arg: "A"`), turning a malformed list
        // line into a *different*, valid rule (§5.20). Fail closed instead.
        if (d > 0) return MALFORMED;

        const arg = selector.slice(argStart, j - 1);
        // Keep `rest` raw — the leading whitespace (or lack of it) is what
        // distinguishes a descendant continuation from a compound one (§4.12).
        const rest = selector.slice(j);
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
      if (d > 0) return MALFORMED; // unterminated `:has(` etc — see above (§5.20)
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
        const rest = selector.slice(j); // raw — see above (§4.12)
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
 * Prefix `:scope` when a selector starts with a combinator, so it becomes a
 * valid querySelector/querySelectorAll argument relative to an element —
 * `querySelectorAll('> .label')` throws, `':scope > .label'` works (§4.11).
 */
function scopeLeadingCombinator(sel) {
  return /^\s*[>+~]/.test(sel) ? `:scope ${sel.trim()}` : sel;
}

/** Strip a leading combinator from a selector fragment. */
function stripLeadingCombinator(sel) {
  return sel.replace(/^\s*[>+~]\s*/, '');
}

/** Compile a regex without letting a filter-list typo throw (§4.11). */
function safeRegex(source, flags) {
  try { return new RegExp(source, flags); } catch { return null; }
}

/**
 * Build a css plan step, recording how the fragment attaches to the element
 * produced by the previous step (§4.12):
 *  - 'compound'   `:upward(1).cls`      — same element, checked with matches()
 *  - 'child'      `:has-text(x) > span` — children, via `:scope > …`
 *  - 'descendant' `:has-text(x) span`   — descendants, via `:scope …`
 *  - 'sibling'    `+`/`~` continuations — unsupported, matches nothing
 * The first step of a plan is an absolute selector; its kind is ignored.
 */
function makeCssStep(rawSelector) {
  const trimmed = rawSelector.trim();
  let kind = 'compound';
  if (trimmed.startsWith('>')) kind = 'child';
  else if (/^[+~]/.test(trimmed)) kind = 'sibling';
  else if (/^\s/.test(rawSelector)) kind = 'descendant';
  return { type: 'css', kind, selector: trimmed };
}

/**
 * Pre-parses a procedural selector into an execution plan (array of operations).
 * This avoids repeated string manipulation during DOM mutation scans.
 * Returns `null` when the selector is malformed — callers must drop the rule
 * rather than run a partial parse of it (§5.20).
 * Exported for tests.
 */
export function parseProceduralPlan(selector) {
  const plan = [];
  let remaining = selector;

  while (remaining && remaining.trim()) {
    const firstOp = extractFirstOp(remaining);
    if (firstOp === MALFORMED) return null;
    if (!firstOp) {
      // Remaining part is plain CSS
      plan.push(makeCssStep(remaining));
      break;
    }

    // Add base CSS if present
    if (firstOp.base) {
      plan.push(makeCssStep(firstOp.base));
    }

    // Add the operator
    plan.push({ type: 'op', op: firstOp.op, arg: firstOp.arg });
    remaining = firstOp.rest;
  }

  return plan;
}

/** Operators whose verdict is a function of the element's text content. */
const TEXT_OPS = new Set(['has-text', 'min-text-length', 'semantic']);
/** The same operators, as they appear nested inside another operator's argument. */
const NESTED_TEXT_OP_REGEX = /:(?:has-text|min-text-length|semantic)\(/;

/**
 * Does any step of this plan read text? A top-level `step.op` check misses
 * `div:has(span:has-text(Ad))`, whose text operator lives in the `:has()`
 * argument — a very common uBO shape — so characterData observation was never
 * enabled for it and in-place text updates went unnoticed (§5.18).
 */
function planReadsText(plan) {
  for (const step of plan || []) {
    if (step?.type !== 'op') continue;
    if (TEXT_OPS.has(step.op)) return true;
    if (typeof step.arg === 'string' && NESTED_TEXT_OP_REGEX.test(step.arg)) return true;
  }
  return false;
}

/**
 * Operators whose verdict depends on the *document* (the URL), not on the
 * element they are handed. Only these may be evaluated against the implicit
 * `document.documentElement` seed of a subject-less (`##:op(…)`) rule (§4.23).
 */
const DOC_SCOPED_OPS = new Set(['matches-path']);

/**
 * May an op-first plan seed `<html>`? Subtree-reading operators (`has-text`,
 * `has`/`if`, `min-text-length`, `semantic`) are trivially true for the whole
 * document, so seeding them turns `##:has-text(Sponsored) span` into "hide
 * every span" and `##:has-text(x):style(display:none)` into a blank page
 * (§4.23). Document-scoped operators are safe and are used by real lists
 * (`##:matches-path(/x/) div.ad`, `##:not(:matches-path(/y/)) .z`), so they
 * are kept rather than rejecting every subject-less rule.
 */
function isDocScopedOp(op, arg) {
  if (DOC_SCOPED_OPS.has(op)) return true;
  if (op === 'not' || op === 'is' || op === 'where') {
    const inner = [...String(arg ?? '').matchAll(/:([\w-]+)\(/g)].map((m) => m[1]);
    return inner.length > 0 && inner.every((name) => DOC_SCOPED_OPS.has(name));
  }
  return false;
}

/**
 * Declarations that would hide or collapse the page when written onto
 * `<html>`/`<head>`/`<body>`. Everything else — including the ~100 upstream
 * anti-adblock rules that *restore* a page (`body:style(overflow:auto)`,
 * `html:style(visibility:visible)`) and `:root:style(--custom-prop: …)` —
 * stays allowed (§4.23).
 */
function isPageBlankingDeclaration(prop, value) {
  const p = prop.toLowerCase();
  const v = value.toLowerCase().replace(/!important/g, '').trim();
  if (p === 'display') return v === 'none';
  if (p === 'visibility') return v === 'hidden' || v === 'collapse';
  if (p === 'content-visibility') return v === 'hidden';
  if (p === 'opacity') return parseFloat(v) === 0;
  if (p === 'height' || p === 'max-height' || p === 'width' || p === 'max-width') {
    return parseFloat(v) === 0;
  }
  return false;
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
    // `op|arg` -> WeakMap(el -> result). Map insertion order *is* the LRU
    // order: `_recordCacheAccess` re-inserts on use (§5.15).
    this._matchCache = new Map();
    this._mruKey = null;            // most recently touched key — see §5.15
    this._cacheAccessLimit = 500;   // Max cache entries before eviction
    // :semantic() verdicts are keyed by text, not element, so they get their
    // own LRU map — mixing booleans into `_matchCache` type-confuses the op
    // WeakMaps and dodges eviction (§5.24).
    this._semanticCache = new Map(); // text prefix -> boolean verdict
    // Synchronous dedupe markers — the rAF flush that stamps ELEMENT_ATTR
    // never runs in hidden tabs, so counters must not depend on it (§5.27).
    this._hiddenElements = new WeakSet();
    this._removedElements = new WeakSet();
    this._hasTextRules = false;     // any rule reads textContent (§5.28)
    this._lastHref = null;          // URL seen by the last procedural run (§5.29)
    // Subtree roots mutated since the last procedural run. A match-cache
    // entry for element `e` is trusted iff none of the last-run's dirty
    // roots equal `e` or contain it. Bumps per scheduled run.
    this._dirtyRoots = new Set();   // Set for automatic deduplication, capped at 1000
    this._lastDirtyRoots = new Set(); // snapshot used by the in-progress run
    this._reportTimer = null;
    this._proceduralDebounce = null;
    this._rafId = null;
    this._cacheSweepInterval = null; // periodic cache sweep timer
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
        // WASM-emitted plans trim the whitespace that distinguishes a
        // descendant continuation from a compound one (§4.12). Re-plan
        // locally whenever a css step follows an op so the continuation
        // kind is recovered from the original selector string.
        const needsReplan = Array.isArray(rule.plan) && rule.plan.some(
          (step, i) => i > 0 && step.type === 'css' && rule.plan[i - 1].type === 'op'
        );
        // A null re-plan means this parser rejected a selector the WASM
        // planner accepted; keep the authoritative plan rather than dropping
        // a rule over a local parity gap (§5.20).
        const replanned = needsReplan ? parseProceduralPlan(selector) : null;
        this._proceduralRules.push(replanned ? { ...rule, plan: replanned } : rule);
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
        const plan = parseProceduralPlan(selector);
        if (!plan || plan.length === 0) {
          // Malformed line — a partial parse would silently become a
          // different, valid rule (§5.20).
          _reportError('Rejected malformed procedural selector', new Error(selector));
          continue;
        }
        this._proceduralRules.push({ selector, plan });
      } else {
        cssSelectors.push(selector);
      }
    }

    this._cssSelectors = cssSelectors;
    this._exceptions = exceptions;

    // Only pay for characterData observation when a rule can read text (§5.28).
    this._hasTextRules = this._proceduralRules.some((rule) => planReadsText(rule.plan));

    // Only inject extra CSS if we have site-specific or user rules AND not in procedural mode.
    if (!proceduralOnly && cssSelectors.length > 0) this._injectCSS(cssSelectors);
    if (!proceduralOnly && exceptions.size > 0) this._injectExceptionCSS([...exceptions]);

    this._detectWatchAttrRules();
    // The observer must be live *before* the first scan: mutations landing
    // while `_applyAllProcedural` walks the document are otherwise never
    // recorded as dirty roots, so their stale verdicts are cached for the
    // element's lifetime (§3.3).
    this._startObserver();
    if (this._proceduralRules.length > 0) this._applyAllProcedural();
    this._startCacheSweep();
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
    // :matches-path verdicts are a function of the URL. Drop them whenever an
    // SPA navigation (pushState/replaceState/popstate) changed it since the
    // previous run — the elements themselves never become dirty (§5.29).
    const href = typeof location !== 'undefined' ? location.href : '';
    if (href !== this._lastHref) {
      this._lastHref = href;
      for (const key of [...this._matchCache.keys()]) {
        if (key.startsWith('matches-path|')) {
          this._matchCache.delete(key);
          if (key === this._mruKey) this._mruKey = null;
        }
      }
    }

    for (const rule of this._proceduralRules) {
      if (rule.disabled) continue;
      // Per-rule isolation: one bad rule must not abort the run — or, during
      // init(), kill the engine before the observer ever starts (§4.11).
      try {
        this._applyProcedural(rule);
      } catch (err) {
        _errorStats.proceduralFailures++;
        rule.failures = (rule.failures || 0) + 1;
        if (rule.failures >= MAX_PROC_RULE_FAILURES) {
          rule.disabled = true;
          _reportError(`Disabled procedural rule after ${rule.failures} failures: ${rule.selector}`, err);
        } else {
          _reportError(`Procedural rule failed: ${rule.selector}`, err);
        }
      }
    }

    // The snapshot has been consumed. Holding it keeps up to 1,000 elements —
    // including detached ones, since a removal makes its former parent a dirty
    // root — alive until the 5-minute sweep (§5.19).
    this._lastDirtyRoots.clear();
  }

  /** Apply a pre-parsed procedural rule. */
  _applyProcedural(rule) {
    const { plan, selector } = rule;
    const first = plan?.[0];
    if (!first) return;

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
        _reportError('Invalid selector', e);
        return;
      }
    } else if (isDocScopedOp(first.op, first.arg)) {
      elements = [document.documentElement];
    } else {
      // Subject-less rule whose first operator reads the seed element. On
      // `<html>` that is trivially true for the whole document, so the rest
      // of the plan runs against the entire page (§4.23).
      _reportError('Rejected subject-less procedural rule', new Error(selector));
      return;
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
      // Continuation semantics depend on how the fragment was attached
      // (§4.12): a compound continuation (`:upward(1).cls`) narrows the
      // current element, while child/descendant ones (`> span`, ` span`)
      // walk into its subtree via :scope.
      try {
        if (step.kind === 'child' || step.kind === 'descendant') {
          for (const child of el.querySelectorAll(`:scope ${step.selector}`)) {
            this._runPlanOnElement(child, nextSteps, fullSelector);
          }
        } else if (step.kind === 'sibling') {
          // Sibling continuations after a procedural op are unsupported —
          // match nothing rather than guess (fail closed).
        } else if (el.matches?.(step.selector)) {
          this._runPlanOnElement(el, nextSteps, fullSelector);
        }
      } catch { /* invalid selector */ }
    }
  }

  /**
   * Apply a single operator to an element.
   * Returns the target element to hide, or null if this element should be
   * skipped (filter did not match).
   */
  _evictCacheIfNeeded() {
    // Map iteration order is insertion order and `_recordCacheAccess`
    // re-inserts on use, so the first key is the least recently used.
    while (this._matchCache.size > this._cacheAccessLimit) {
      const oldestKey = this._matchCache.keys().next().value;
      if (oldestKey === undefined) break;
      if (oldestKey === this._mruKey) this._mruKey = null;
      this._matchCache.delete(oldestKey);
    }
  }

  /**
   * Refresh a key's LRU position. The previous implementation kept a parallel
   * 500-entry array and did `indexOf` + `splice` on every call — 485 ms per
   * 250k lookups, and it is called once per element per operator step, so a
   * 500-candidate × 500-rule run spent over a second in it (§5.15). Map
   * insertion order gives the same LRU for O(1), and because the key is
   * per-*rule* the whole per-element loop collapses to a single reorder.
   */
  _recordCacheAccess(key) {
    if (key === this._mruKey) return; // hoisted: same rule step, next element
    const opCache = this._matchCache.get(key);
    if (opCache !== undefined) {
      this._matchCache.delete(key);
      this._matchCache.set(key, opCache);
    }
    this._mruKey = key;
  }

  _getCachedMatch(el, op, arg, evaluator) {
    const key = `${op}|${arg}`;
    let opCache = this._matchCache.get(key);
    if (!opCache) {
      opCache = new WeakMap();
      this._matchCache.set(key, opCache);
      this._mruKey = key; // freshly inserted: already the newest entry
    } else {
      // Track access for LRU eviction
      this._recordCacheAccess(key);
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

    // Evict if cache grew beyond limit
    this._evictCacheIfNeeded();

    return result;
  }

  /**
   * Record `node` and a bounded chain of its ancestors as cache-dirty (§3.3).
   *
   * `_isInDirtySubtree` only asks whether an element sits *inside* a mutated
   * subtree, but every operator that decides its verdict by reading downward —
   * `has-text`, `min-text-length`, `has`/`if`/`if-not`, `semantic` — is
   * evaluated on the *container*, which is an ancestor of the mutation. A
   * framework card created empty and hydrated later therefore kept its cached
   * "no ad text here" verdict for the element's lifetime.
   *
   * Walking up here rather than testing `el.contains(root)` at lookup time is
   * deliberate: the lookup runs once per element per operator step (the
   * hottest loop in a run, see §5.15) and would pay O(dirty roots) extra DOM
   * calls, while this walk is O(DIRTY_ANCESTOR_DEPTH) once per mutation. It
   * also bounds the invalidation blast radius — `contains` would dirty every
   * ancestor up to <html> on every mutation, discarding cache hits for
   * containers that no operator could care about.
   */
  _markDirty(node) {
    if (!node || node.nodeType !== 1) return;
    this._dirtyRoots.add(node);
    let ancestor = node.parentElement;
    for (let i = 0; i < DIRTY_ANCESTOR_DEPTH && ancestor; i++) {
      this._dirtyRoots.add(ancestor);
      ancestor = ancestor.parentElement;
    }
  }

  _isInDirtySubtree(el) {
    const roots = this._lastDirtyRoots;
    if (!roots || roots.size === 0) return false;
    // `el` is inside a dirty subtree iff one of the roots is `el` itself or an
    // ancestor of it — so walk up and test Set membership instead of scanning
    // every root with `contains()`. Same answer, O(DOM depth) cheap lookups
    // instead of O(roots) DOM calls, which matters because §3.3 records more
    // roots per mutation. The walk terminates at <html> (parentElement null)
    // and works for detached subtrees just as `contains` did.
    for (let node = el; node; node = node.parentElement) {
      if (roots.has(node)) return true;
    }
    return false;
  }

  /**
   * Text-keyed :semantic() verdicts live in their own LRU map so boolean
   * values can never collide with the op cache's WeakMaps, and so they are
   * subject to eviction like everything else (§5.24).
   */
  _getSemanticVerdict(key) {
    if (!this._semanticCache.has(key)) return undefined;
    const verdict = this._semanticCache.get(key);
    // Refresh LRU position (Map iteration order is insertion order)
    this._semanticCache.delete(key);
    this._semanticCache.set(key, verdict);
    return verdict;
  }

  _setSemanticVerdict(key, verdict) {
    this._semanticCache.delete(key);
    this._semanticCache.set(key, verdict);
    if (this._semanticCache.size > this._cacheAccessLimit) {
      const oldest = this._semanticCache.keys().next().value;
      this._semanticCache.delete(oldest);
    }
  }

  /** Check if an element matches a procedural selector plan (used by :has, :not, etc). */
  _matchesProcedural(el, proceduralSelector) {
    const isPreParsed = typeof proceduralSelector === 'object' && proceduralSelector.plan;
    const plan = isPreParsed ? proceduralSelector.plan : parseProceduralPlan(proceduralSelector);
    // A malformed argument (`:not(:has-text(x)`) matches nothing rather than
    // everything — under-blocking is the recoverable direction (§5.20).
    if (!plan) return false;
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
          if (step === plan[0]) {
            // Entry step: the caller anchored the candidate (e.g. the :has()
            // candidate query), so any leading combinator is already applied.
            const sel = stripLeadingCombinator(step.selector);
            try {
              if (res.matches?.(sel)) nextResults.push(res);
              // Only search children for the very first step
              for (const child of res.querySelectorAll(sel)) {
                nextResults.push(child);
              }
            } catch { /* invalid selector */ }
          } else if (step.kind === 'child' || step.kind === 'descendant') {
            try {
              for (const child of res.querySelectorAll(`:scope ${step.selector}`)) {
                nextResults.push(child);
              }
            } catch { /* invalid selector */ }
          } else if (step.kind !== 'sibling') {
            // Compound continuation — same element (§4.12).
            try {
              if (res.matches?.(step.selector)) nextResults.push(res);
            } catch { /* invalid selector */ }
          }
        }
      }
      results = [...new Set(nextResults)];
      if (results.length === 0) return false;
    }

    return results.length > 0;
  }

  /**
   * Does any descendant of `el` satisfy `arg`? Backs `:has()`, `:if()` and
   * (negated) `:if-not()`, so the three cannot drift apart.
   */
  _hasDescendantMatch(el, arg) {
    // Non-procedural argument: native check is enough. Leading combinators
    // (`:has(> .label)`) are rewritten as `:scope > .label` (§4.11).
    if (!isProceduralSelector(arg)) {
      try { return !!el.querySelector(scopeLeadingCombinator(arg)); } catch { return false; }
    }

    // Procedural argument: only candidates matching the leading CSS step can
    // match, so narrow before running the plan.
    const plan = parseProceduralPlan(arg);
    if (!plan) return false; // malformed argument matches nothing (§5.20)
    const first = plan[0];
    let candidates = [];
    try {
      candidates = first?.type === 'css'
        ? el.querySelectorAll(scopeLeadingCombinator(first.selector))
        : el.querySelectorAll('*');
    } catch (err) {
      _reportError('Invalid :has() argument', err);
      return false;
    }

    for (const cand of candidates) {
      if (this._matchesProcedural(cand, { selector: arg, plan })) return true;
    }
    return false;
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
            pattern = safeRegex(arg.slice(1, lastSlash), arg.slice(lastSlash + 1) || 'i');
          } else {
            pattern = safeRegex(escapeRegex(arg), 'i');
          }
          // An invalid regex literal from a list typo must not throw (§4.11).
          return pattern && pattern.test(el.textContent) ? el : null;
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
            const re = safeRegex(val.slice(1, lastSlash), val.slice(lastSlash + 1));
            return re && re.test(computed) ? el : null;
          }
          return computed === val ? el : null;
        }

        case 'matches-path': {
          const path = location.pathname + location.search;
          if (arg.startsWith('/')) {
            const lastSlash = arg.lastIndexOf('/');
            const re = safeRegex(arg.slice(1, lastSlash), arg.slice(lastSlash + 1) || 'i');
            return re && re.test(path) ? el : null;
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
            const re = safeRegex(val.slice(1, lastSlash), val.slice(lastSlash + 1) || 'i');
            return re && re.test(actual) ? el : null;
          }
          return actual === val ? el : null;
        }

        case 'style': {
          // `:style()` writes directly and never reaches the guarded
          // `_hideElement`, so the root-three check has to be repeated here —
          // a `:upward()` chain can walk onto <html> from any subject (§4.23).
          const isRoot = el === document.documentElement ||
                         el === document.head || el === document.body;
          const rules = arg.split(';').map(r => r.trim()).filter(Boolean);
          for (const rule of rules) {
            const colonIdx = rule.indexOf(':');
            if (colonIdx === -1) continue;
            const prop = rule.slice(0, colonIdx).trim();
            const val = rule.slice(colonIdx + 1).trim();
            if (isRoot && isPageBlankingDeclaration(prop, val)) {
              _reportError('Refused page-blanking :style() on document root',
                new Error(`${prop}: ${val}`));
              continue;
            }
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

        // uBO spells the legacy aliases `:if()` and `:if-not()`; they are
        // exactly `:has()` and its negation. Both were tokenized by PROC_OPS
        // but had no case here, so they hit `default` and reported a match
        // unconditionally — hiding every element the base selector touched.
        case 'has':
        case 'if':
          return this._hasDescendantMatch(el, arg) ? el : null;

        case 'if-not':
          return this._hasDescendantMatch(el, arg) ? null : el;

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

          // Use the dedicated verdict cache to avoid redundant messages —
          // never `_matchCache`, whose values are op WeakMaps (§5.24).
          const cacheKey = text.slice(0, 100);
          const cached = this._getSemanticVerdict(cacheKey);
          if (cached !== undefined) return cached ? el : null;

          // Perform async check
          chrome.runtime.sendMessage({
            type: 'CHECK_SEMANTIC_AD',
            payload: { text }
          }).then(res => {
            if (res && res.isAd) {
              this._setSemanticVerdict(cacheKey, true);
              this._removeElement(el, fullSelector);
            } else {
              this._setSemanticVerdict(cacheKey, false);
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
          // Fail closed. An operator the planner emits but this engine does not
          // implement must not be read as "matched" — that turns a parity gap
          // into an over-block that can blank a page. Under-blocking is the
          // recoverable direction.
          _reportError('Unimplemented procedural operator', new Error(op));
          return null;
      }
    });
  }

  /** Apply an XPath expression directly to the document. */
  _applyXPath(expr) {
    // Reject unsafe axes that can traverse beyond the document or access
    // ancestor frames (ancestor, following, preceding, and unanchored //).
    const unsafeAxes = /\b(ancestor|ancestor-or-self|following|following-sibling|preceding|preceding-sibling)::/;
    if (unsafeAxes.test(expr)) {
      _reportError('Blocked unsafe XPath axis', new Error(expr));
      return;
    }
    // Reject expressions starting with // (unanchored descendant search)
    if (/^\/\//.test(expr.trim())) {
      _reportError('Blocked unanchored XPath //', new Error(expr));
      return;
    }
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
      _reportError('Invalid XPath', e);
      _errorStats.proceduralFailures++;
    }
  }

  // ---------------------------------------------------------------------------
  // :watch-attr support — separate attribute observer
  // ---------------------------------------------------------------------------

  _detectWatchAttrRules() {
    const watchedAttrs = new Set();

    for (const rule of this._proceduralRules) {
      // A :watch-attr() step can sit anywhere in the chain, not just first —
      // `[data-x]:watch-attr(data-x):matches-attr(…)` must install the
      // observer too (§4.29).
      const steps = (Array.isArray(rule.plan) ? rule.plan : parseProceduralPlan(rule.selector)) || [];
      const attrs = [];
      for (const step of steps) {
        if (step.type !== 'op' || step.op !== 'watch-attr') continue;
        for (const attr of step.arg.split(',').map((a) => a.trim()).filter(Boolean)) {
          attrs.push(attr);
          watchedAttrs.add(attr);
        }
      }
      if (attrs.length > 0) {
        this._watchAttrRules.push({ attrs, fullSelector: rule.selector });
      }
    }

    if (watchedAttrs.size === 0) return;

    this._attrObserver = new MutationObserver((mutations) => {
      // Record mutated elements as dirty roots so `_getCachedMatch` recomputes
      // them — without this the cache serves the pre-change verdict and
      // :watch-attr() never has any effect (§4.29).
      for (const mutation of mutations) {
        // Ancestors too: `div:has([data-ad-state="active"])` reads the
        // attribute of a descendant (§3.3).
        this._markDirty(mutation.target);
      }
      this._scheduleProceduralRun();
    });
    this._attrObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [...watchedAttrs],
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

    const DIRTY_ROOTS_CAP = 1000;

    this._observer = new MutationObserver((mutations) => {
      let needsProcedural = false;

      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          // Frameworks update text nodes in place, producing no childList
          // mutation — dirty the parent element so text-matching verdicts
          // are recomputed (§5.28), and its ancestors, whose own text
          // verdicts changed with it (§3.3).
          needsProcedural = true;
          this._markDirty(mutation.target?.parentElement);
          continue;
        }
        if (mutation.addedNodes.length > 0) {
          needsProcedural = true;
          // Record the mutation target and a bounded ancestor chain — any
          // descendant of this node is considered cache-dirty until the next
          // procedural run consumes the batch, and so is every container
          // whose subtree now reads differently (§3.3).
          this._markDirty(mutation.target);
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1 /* ELEMENT */) this._dirtyRoots.add(node);
          }
        }
      }

      // Too many dirty roots to track individually. Never discard the
      // invalidation data (§5.25): drop the whole match cache instead so the
      // next run re-evaluates everything, and let the normal debounced run
      // pick it up — a synchronous full scan inside the observer callback
      // would jank the page.
      if (this._dirtyRoots.size >= DIRTY_ROOTS_CAP) {
        this._dirtyRoots.clear();
        this._lastDirtyRoots.clear();
        this._matchCache.clear();
        this._mruKey = null;
        this._scheduleProceduralRun();
        return;
      }

      if (needsProcedural && this._proceduralRules.length > 0) {
        this._scheduleProceduralRun();
      }
    });

    this._observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      // Gated: text-node observation is only worth paying for when a rule
      // can actually read text (§5.28).
      characterData: this._hasTextRules,
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
      // Double-buffer swap: the run reads `_lastDirtyRoots` while new
      // mutations accumulate in `_dirtyRoots`. No allocation, no copy.
      const consumed = this._lastDirtyRoots;
      consumed.clear();
      this._lastDirtyRoots = this._dirtyRoots;
      this._dirtyRoots = consumed;
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
    if (this._cacheSweepInterval) {
      clearInterval(this._cacheSweepInterval);
      this._cacheSweepInterval = null;
    }
    // Drop the strong element references this engine holds (§5.19).
    this._dirtyRoots.clear();
    this._lastDirtyRoots.clear();
    this._hideQueue.clear();
    this._removeQueue.clear();
  }

  /** Periodic cache sweep — removes stale WeakMap entries every 5 minutes. */
  _startCacheSweep() {
    if (this._cacheSweepInterval) return;
    this._cacheSweepInterval = setInterval(() => {
      // WeakMap entries self-release as elements are GC'd. The only strong
      // element references left are the dirty-root snapshots; `_applyAllProcedural`
      // clears the consumed one, so this is a backstop for a page that stopped
      // mutating mid-batch (§5.19).
      this._lastDirtyRoots.clear();
    }, 300000); // 5 minutes
  }

  // ---------------------------------------------------------------------------
  // Element hiding
  // ---------------------------------------------------------------------------

  _hideElement(el, selector = 'unknown') {
    if (!el || this._hiddenElements.has(el) || el.getAttribute?.(ELEMENT_ATTR)) return;
    // Never blanket-hide the page scaffolding — an op-first plan such as
    // `##:has-text(x)` seeds document.documentElement, and hiding it blanks
    // the entire page (§5.26).
    if (el === document.documentElement || el === document.head || el === document.body) return;
    if (this._exceptions.has(el.className) || this._isExcepted(el)) return;

    // Mark synchronously: the rAF flush that stamps ELEMENT_ATTR never runs
    // in hidden tabs, so dedupe must not wait for it (§5.27).
    this._hiddenElements.add(el);
    this._hideQueue.add(el);
    this._hiddenCount++;
    
    const hit = this._selectorHits.get(selector) || { count: 0, action: 'hide' };
    hit.count++;
    this._selectorHits.set(selector, hit);

    this._triggerRaf();
    this._scheduleReport();
  }

  _removeElement(el, selector = 'unknown') {
    if (!el || !el.parentElement || this._removedElements.has(el)) return;
    if (el === document.documentElement || el === document.head || el === document.body) return;
    if (this._exceptions.has(el.className) || this._isExcepted(el)) return;

    // Synchronous dedupe marker — see _hideElement (§5.27).
    this._removedElements.add(el);
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
