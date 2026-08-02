import test from 'node:test';
import assert from 'node:assert/strict';

import { CosmeticEngine, parseProceduralPlan } from './cosmetic-engine.js';

// Report timers fire after tests complete; give them working globals.
globalThis.chrome = { runtime: { sendMessage: () => Promise.resolve({}) } };

/**
 * Minimal stand-in for an Element. `_applyOp` only needs the query methods and
 * identity, so this avoids pulling in a full DOM just to pin operator
 * semantics.
 */
function makeEl({ matchesSelectors = [], descendants = [] } = {}) {
  const el = {
    tagName: 'DIV',
    textContent: '',
    matches: (sel) => matchesSelectors.includes(sel),
    querySelector: (sel) => descendants.find((d) => d.matches(sel)) || null,
    querySelectorAll: (sel) =>
      sel === '*' ? descendants : descendants.filter((d) => d.matches(sel)),
    closest: () => null,
    contains: () => false,
  };
  return el;
}

const engine = () => new CosmeticEngine();

// `:if()` and `:if-not()` are tokenized by PROC_OPS but had no case in
// `_applyOp`, so they fell through to `default: return el` — i.e. they reported
// "matched" unconditionally. `div:if-not(.keep)` then hid every div on the
// page instead of only those lacking `.keep`.

test(':if() matches only when a descendant matches — it is an alias of :has()', () => {
  const e = engine();
  const withSponsor = makeEl({ descendants: [makeEl({ matchesSelectors: ['.sponsor'] })] });
  const without = makeEl({ descendants: [makeEl({ matchesSelectors: ['.content'] })] });

  assert.equal(e._applyOp(withSponsor, 'if', '.sponsor', 'div:if(.sponsor)'), withSponsor);
  assert.equal(e._applyOp(without, 'if', '.sponsor', 'div:if(.sponsor)'), null);
});

test(':if-not() matches only when no descendant matches', () => {
  const e = engine();
  const withKeep = makeEl({ descendants: [makeEl({ matchesSelectors: ['.keep'] })] });
  const without = makeEl({ descendants: [makeEl({ matchesSelectors: ['.other'] })] });

  assert.equal(e._applyOp(withKeep, 'if-not', '.keep', 'div:if-not(.keep)'), null);
  assert.equal(e._applyOp(without, 'if-not', '.keep', 'div:if-not(.keep)'), without);
});

test(':if() and :has() agree on the same input', () => {
  const e = engine();
  const hit = makeEl({ descendants: [makeEl({ matchesSelectors: ['.ad'] })] });
  const miss = makeEl({ descendants: [] });

  assert.equal(!!e._applyOp(hit, 'if', '.ad', 's'), !!e._applyOp(hit, 'has', '.ad', 's'));
  assert.equal(!!e._applyOp(miss, 'if', '.ad', 's'), !!e._applyOp(miss, 'has', '.ad', 's'));
});

test('an unimplemented operator fails closed rather than hiding the element', () => {
  const e = engine();
  const el = makeEl({ descendants: [] });

  // Under-blocking is recoverable; blanking a page is not. Any planner/executor
  // drift must land on the safe side.
  assert.equal(e._applyOp(el, 'not-a-real-operator', 'x', 's'), null);
});

test('mid-chain :xpath() is not silently treated as a match', () => {
  const e = engine();
  const el = makeEl({ descendants: [] });

  // Only a leading :xpath() is supported; mid-chain must not pass through.
  assert.equal(e._applyOp(el, 'xpath', './/div', 'a:has-text(x):xpath(.//div)'), null);
});

test('implemented operators still behave (regression guard)', () => {
  const e = engine();

  const textEl = { ...makeEl(), textContent: 'Sponsored content' };
  assert.equal(e._applyOp(textEl, 'has-text', 'Sponsored', 's'), textEl);

  const otherEl = { ...makeEl(), textContent: 'Real article' };
  assert.equal(e._applyOp(otherEl, 'has-text', 'Sponsored', 's'), null);

  const hit = makeEl({ descendants: [makeEl({ matchesSelectors: ['.ad'] })] });
  assert.equal(e._applyOp(hit, 'has', '.ad', 's'), hit);
});

// ---------------------------------------------------------------------------
// Richer DOM stubs for the engine-level regressions below. These carry the
// members `_hideElement`/`_removeElement`/the observers touch, so full
// procedural runs can execute without a real DOM.
// ---------------------------------------------------------------------------

function domEl(overrides = {}) {
  return {
    tagName: 'DIV',
    nodeType: 1,
    textContent: '',
    className: '',
    parentElement: null,
    matches: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    getAttribute: () => null,
    setAttribute: () => {},
    style: { setProperty: () => {} },
    ...overrides,
  };
}

/** Install document/location/rAF globals. rAF deliberately never flushes —
 *  background-tab semantics, which §5.27 depends on. */
function installDom({ queryResults = {} } = {}) {
  const doc = {
    documentElement: domEl({ tagName: 'HTML' }),
    head: domEl({ tagName: 'HEAD' }),
    body: domEl({ tagName: 'BODY' }),
    querySelectorAll: (sel) => queryResults[sel] || [],
    querySelector: (sel) => (queryResults[sel] || [])[0] || null,
  };
  globalThis.document = doc;
  globalThis.location = { href: 'https://example.test/', pathname: '/', search: '', hostname: 'example.test' };
  globalThis.requestAnimationFrame = () => 1;
  return doc;
}

class StubMutationObserver {
  static lastInstance = null;
  constructor(cb) {
    this.cb = cb;
    this.options = null;
    StubMutationObserver.lastInstance = this;
  }
  observe(_target, options) { this.options = options; }
  disconnect() {}
}

// §4.11 — one bad rule must not kill the run, and a persistently bad rule is
// retired instead of failing forever.

test('a throwing rule is isolated and disabled after repeated failures (§4.11)', () => {
  const e = engine();
  let bombReads = 0;
  const bomb = domEl();
  Object.defineProperty(bomb, 'textContent', {
    get() { bombReads++; throw new Error('boom'); },
  });
  const victim = domEl({ textContent: 'Sponsored' });
  installDom({ queryResults: { '.bomb': [bomb], '.ad': [victim] } });

  e._proceduralRules = [
    { selector: '.bomb:has-text(x)', plan: parseProceduralPlan('.bomb:has-text(x)') },
    { selector: '.ad:has-text(Sponsored)', plan: parseProceduralPlan('.ad:has-text(Sponsored)') },
  ];

  e._applyAllProcedural();
  // Prior code: the exception aborted the loop and the second rule never ran.
  assert.equal(e._hideQueue.has(victim), true);
  assert.equal(e._proceduralRules[0].failures, 1);
  assert.notEqual(e._proceduralRules[0].disabled, true);

  e._applyAllProcedural();
  e._applyAllProcedural();
  assert.equal(e._proceduralRules[0].disabled, true);

  const readsAfterDisable = bombReads;
  e._applyAllProcedural();
  assert.equal(bombReads, readsAfterDisable); // a disabled rule stops running
});

test(':has-text() with an invalid regex literal matches nothing instead of throwing (§4.11)', () => {
  const e = engine();
  const el = { ...makeEl(), textContent: 'anything' };
  assert.doesNotThrow(() => {
    assert.equal(e._applyOp(el, 'has-text', '/[unclosed/', 's'), null);
  });
});

test(':has(> .x) rewrites the leading combinator as :scope (§4.11)', () => {
  const e = engine();
  const label = makeEl({ matchesSelectors: ['.label'] });
  const el = makeEl();
  el.querySelector = (sel) => {
    // Real querySelector throws on a leading combinator.
    if (/^\s*[>+~]/.test(sel)) throw new SyntaxError(`invalid selector: ${sel}`);
    return sel === ':scope > .label' ? label : null;
  };
  assert.equal(e._applyOp(el, 'has', '> .label', 'div:has(> .label)'), el);
});

// §4.12 — combinator semantics after a procedural operator.

test('a child combinator after an op queries :scope children, not matches() (§4.12)', () => {
  const e = engine();
  installDom();
  const span = domEl({ tagName: 'SPAN' });
  const div = domEl({
    textContent: 'Ad',
    querySelectorAll: (sel) => (sel === ':scope > span' ? [span] : []),
  });
  const sel = 'div:has-text(Ad) > span';
  const plan = parseProceduralPlan(sel);
  assert.deepEqual(plan[2], { type: 'css', kind: 'child', selector: '> span' });

  e._runPlanOnElement(div, plan.slice(1), sel);
  // Prior code called div.matches('> span'), swallowed the SyntaxError, and
  // the rule silently matched nothing forever.
  assert.equal(e._hideQueue.has(span), true);
  assert.equal(e._hideQueue.has(div), false);
});

test('a descendant continuation after an op uses a :scope query (§4.12)', () => {
  const e = engine();
  installDom();
  const inner = domEl({ tagName: 'SPAN' });
  const div = domEl({
    textContent: 'Ad',
    querySelectorAll: (sel) => (sel === ':scope span' ? [inner] : []),
  });
  const sel = 'div:has-text(Ad) span';
  const plan = parseProceduralPlan(sel);
  assert.deepEqual(plan[2], { type: 'css', kind: 'descendant', selector: 'span' });

  e._runPlanOnElement(div, plan.slice(1), sel);
  assert.equal(e._hideQueue.has(inner), true);
});

test('a compound continuation narrows the same element, not its descendants (§4.12)', () => {
  const e = engine();
  installDom();
  const decoy = domEl();
  const parent = domEl({
    matches: () => false, // the parent is NOT .product-ad
    querySelectorAll: (sel) => (sel.includes('.product-ad') ? [decoy] : []),
  });
  const span = domEl({ parentElement: parent });
  const sel = 'span.price:upward(1).product-ad';
  const plan = parseProceduralPlan(sel);
  assert.equal(plan[2].kind, 'compound');

  e._runPlanOnElement(span, plan.slice(1), sel);
  // Prior code additionally swept every .product-ad DESCENDANT of the parent.
  assert.equal(e._hideQueue.size, 0);

  const matchingParent = domEl({ matches: (s) => s === '.product-ad' });
  const span2 = domEl({ parentElement: matchingParent });
  e._runPlanOnElement(span2, plan.slice(1), sel);
  assert.equal(e._hideQueue.has(matchingParent), true);
});

// §4.29 — :watch-attr() must actually invalidate and must be found anywhere
// in the chain.

test(':watch-attr() mutations record dirty roots so the cache re-evaluates (§4.29)', () => {
  const e = engine();
  globalThis.MutationObserver = StubMutationObserver;
  installDom();
  const sel = '[data-ad-state]:watch-attr(data-ad-state):matches-attr(data-ad-state=active)';
  e._proceduralRules = [{ selector: sel, plan: parseProceduralPlan(sel) }];
  e._detectWatchAttrRules();

  const observer = StubMutationObserver.lastInstance;
  assert.ok(observer, 'attribute observer installed');
  assert.deepEqual(observer.options.attributeFilter, ['data-ad-state']);

  e._scheduleProceduralRun = () => {}; // keep the test synchronous
  const flipped = domEl();
  observer.cb([{ type: 'attributes', target: flipped }]);
  // Prior code scheduled a run but recorded nothing, so `_getCachedMatch`
  // served the stale pre-change verdict.
  assert.equal(e._dirtyRoots.has(flipped), true);
});

test(':watch-attr() is detected anywhere in the plan chain (§4.29)', () => {
  const e = engine();
  globalThis.MutationObserver = StubMutationObserver;
  StubMutationObserver.lastInstance = null;
  installDom();
  const sel = 'div:has-text(Ads):watch-attr(data-visible)';
  e._proceduralRules = [{ selector: sel, plan: parseProceduralPlan(sel) }];
  e._detectWatchAttrRules();

  // Prior code only recognized :watch-attr as the FIRST operator; chained
  // forms installed no observer at all.
  const observer = StubMutationObserver.lastInstance;
  assert.ok(observer, 'attribute observer installed for chained :watch-attr');
  assert.deepEqual(observer.options.attributeFilter, ['data-visible']);
  assert.equal(e._watchAttrRules.length, 1);
});

// §5.24 — :semantic() verdicts must not share a map with the op WeakMaps.

test(':semantic() verdicts live in a dedicated cache and cannot clobber the op cache (§5.24)', async () => {
  const e = engine();
  globalThis.chrome = { runtime: { sendMessage: () => Promise.resolve({ isAd: true }) } };

  // The element's text equals the operator argument — exactly the collision
  // that used to overwrite the `semantic|sponsored` WeakMap with `true`.
  const el = domEl({ textContent: 'sponsored' });
  assert.equal(e._applyOp(el, 'semantic', 'sponsored', 's'), null);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(e._semanticCache.get('sponsored'), true);
  for (const value of e._matchCache.values()) {
    assert.equal(value instanceof WeakMap, true, 'op cache must only hold WeakMaps');
  }
  // Prior code: opCache was now the boolean `true` and `.has()` threw.
  const el2 = domEl({ textContent: 'sponsored' });
  assert.doesNotThrow(() => e._applyOp(el2, 'semantic', 'sponsored', 's'));
});

test(':semantic() verdict cache participates in eviction (§5.24)', () => {
  const e = engine();
  e._cacheAccessLimit = 3;
  e._setSemanticVerdict('a', true);
  e._setSemanticVerdict('b', false);
  e._setSemanticVerdict('c', true);
  e._setSemanticVerdict('d', true);
  assert.equal(e._semanticCache.size, 3);
  assert.equal(e._getSemanticVerdict('a'), undefined); // oldest evicted
  assert.equal(e._getSemanticVerdict('d'), true);
});

// §5.25 — dirty-roots overflow must not discard invalidation data or run
// synchronously inside the observer callback.

test('dirty-root overflow invalidates the cache and defers the run (§5.25)', () => {
  const e = engine();
  globalThis.MutationObserver = StubMutationObserver;
  installDom();
  e._proceduralRules = [{ selector: 'div:has-text(x)', plan: parseProceduralPlan('div:has-text(x)') }];
  e._startObserver();
  const observer = StubMutationObserver.lastInstance;

  let syncRuns = 0;
  e._applyAllProcedural = () => { syncRuns++; };

  // A hydration burst: the cap's worth of dirty roots plus cached verdicts.
  for (let i = 0; i < 1000; i++) e._dirtyRoots.add({ i });
  e._matchCache.set('has-text|x', new WeakMap());
  e._cacheAccessOrder.push('has-text|x');

  observer.cb([{ type: 'childList', target: domEl(), addedNodes: [domEl()] }]);

  // Prior code ran a full scan synchronously against the PREVIOUS dirty
  // snapshot and then cleared the set — the stale cache survived.
  assert.equal(syncRuns, 0);
  assert.equal(e._matchCache.size, 0);
  assert.equal(e._cacheAccessOrder.length, 0);
  assert.ok(e._proceduralDebounce, 'run deferred to the debounced path');
  e.stopObserver();
});

// §5.26 — an op-first plan seeds document.documentElement.

test('an op-first plan cannot blanket-hide the page scaffolding (§5.26)', () => {
  const e = engine();
  const doc = installDom();
  doc.documentElement.textContent = 'Sponsored appears somewhere on this page';
  const sel = ':has-text(Sponsored)'; // a user's natural first attempt: `##:has-text(Sponsored)`
  e._proceduralRules = [{ selector: sel, plan: parseProceduralPlan(sel) }];

  e._applyAllProcedural();
  // Prior code queued <html> for display:none.
  assert.equal(e._hideQueue.size, 0);
  assert.equal(e._hiddenCount, 0);
});

// §5.27 — dedupe must not depend on the rAF flush (it never runs in hidden tabs).

test('hidden/removed counters do not inflate when the rAF flush never runs (§5.27)', () => {
  const e = engine();
  installDom(); // requestAnimationFrame stub never invokes its callback

  const el = domEl();
  e._hideElement(el, '.ad');
  e._hideElement(el, '.ad');
  // Prior code counted 2: ELEMENT_ATTR is only stamped inside the rAF flush.
  assert.equal(e._hiddenCount, 1);
  assert.equal(e._selectorHits.get('.ad').count, 1);

  const child = domEl({ parentElement: domEl() });
  e._removeElement(child, '.rm');
  e._removeElement(child, '.rm');
  assert.equal(e._hiddenCount, 2);
  assert.equal(e._selectorHits.get('.rm').count, 1);
});

// §5.28 — in-place text updates must be observable, gated on need.

test('characterData observation is enabled iff a text-matching rule exists (§5.28)', () => {
  globalThis.MutationObserver = StubMutationObserver;
  installDom();

  const textEngine = engine();
  textEngine.init({ generic: ['div:has-text(Promoted)'], domainSpecific: [] }, true);
  assert.equal(StubMutationObserver.lastInstance.options.characterData, true);
  textEngine.stopObserver();

  const attrEngine = engine();
  attrEngine.init({ generic: ['div:matches-attr(data-x=1)'], domainSpecific: [] }, true);
  assert.equal(StubMutationObserver.lastInstance.options.characterData, false);
  attrEngine.stopObserver();
});

test('a characterData mutation dirties the parent element and schedules a run (§5.28)', () => {
  const e = engine();
  globalThis.MutationObserver = StubMutationObserver;
  installDom();
  e._proceduralRules = [{ selector: 'div:has-text(Promoted)', plan: parseProceduralPlan('div:has-text(Promoted)') }];
  e._hasTextRules = true;
  e._startObserver();
  const observer = StubMutationObserver.lastInstance;

  const parent = domEl();
  observer.cb([{ type: 'characterData', target: { nodeType: 3, parentElement: parent }, addedNodes: [] }]);
  // Prior code only reacted to addedNodes, so a recycled row whose text
  // became "Promoted" was never re-evaluated.
  assert.equal(e._dirtyRoots.has(parent), true);
  assert.ok(e._proceduralDebounce);
  e.stopObserver();
});

// §5.29 — :matches-path verdicts must not survive SPA navigations.

test(':matches-path verdicts are dropped when the URL changes (§5.29)', () => {
  const e = engine();
  const el = domEl();
  installDom({ queryResults: { div: [el] } });
  globalThis.location = { href: 'https://s.test/', pathname: '/', search: '', hostname: 's.test' };

  const sel = 'div:matches-path(watch)';
  e._proceduralRules = [{ selector: sel, plan: parseProceduralPlan(sel) }];

  e._applyAllProcedural();
  assert.equal(e._hideQueue.size, 0); // '/' does not match — a miss is cached

  // SPA navigation via pushState: no mutation, no dirty root.
  globalThis.location = { href: 'https://s.test/watch?v=1', pathname: '/watch', search: '?v=1', hostname: 's.test' };
  e._applyAllProcedural();
  // Prior code served the cached miss forever without a hard reload.
  assert.equal(e._hideQueue.has(el), true);
});
