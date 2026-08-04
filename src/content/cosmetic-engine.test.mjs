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
  // `_startCacheSweep` arms a 5-minute interval. A real one keeps the Node
  // event loop alive forever whenever a test fails before reaching
  // `stopObserver()`, which turns any red test into a hung run. `setTimeout`
  // stays real — the debounce in `_scheduleProceduralRun` depends on it.
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
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
  e._mruKey = 'has-text|x';

  observer.cb([{ type: 'childList', target: domEl(), addedNodes: [domEl()] }]);

  // Prior code ran a full scan synchronously against the PREVIOUS dirty
  // snapshot and then cleared the set — the stale cache survived.
  assert.equal(syncRuns, 0);
  assert.equal(e._matchCache.size, 0);
  assert.equal(e._mruKey, null);
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

// ---------------------------------------------------------------------------
// §3.3 — subtree-reading operators are evaluated on the CONTAINER, which is an
// ANCESTOR of the mutation. `_isInDirtySubtree` only asked whether an element
// sits *inside* a mutated subtree, so a container was invalidated only when the
// insertion happened to be its direct child — the one shape the §5.28 test
// above pins. Anything deeper served the stale verdict for the element's
// lifetime.
// ---------------------------------------------------------------------------

/** container > section > p — the mutation lands two levels below the container. */
function nestedCard() {
  const container = domEl({ tagName: 'DIV' });
  const section = domEl({ tagName: 'SECTION', parentElement: container });
  const p = domEl({ tagName: 'P', parentElement: section });
  container.contains = (x) => x === section || x === p;
  section.contains = (x) => x === p;
  return { container, section, p };
}

test('a mutation two levels down invalidates the container verdict (§3.3)', async () => {
  const e = engine();
  globalThis.MutationObserver = StubMutationObserver;
  const { container, section, p } = nestedCard();
  installDom({ queryResults: { div: [container] } });

  const sel = 'div:has-text(Sponsored)';
  e._proceduralRules = [{ selector: sel, plan: parseProceduralPlan(sel) }];
  e._hasTextRules = true;
  e._startObserver();

  // Run #1: the card was created empty, so the miss is cached.
  e._applyAllProcedural();
  assert.equal(e._hideQueue.size, 0);

  // Hydration fills <p> with the ad label. The observer sees the insertion at
  // <p>; the card is two levels above it.
  const span = domEl({ tagName: 'SPAN', textContent: 'Sponsored', parentElement: p });
  for (const node of [p, section, container]) node.textContent = 'Sponsored';
  StubMutationObserver.lastInstance.cb([{ type: 'childList', target: p, addedNodes: [span] }]);

  // Prior code: dirty roots were [p, span], neither of which contains the
  // card, so the cached "no ad text" verdict was served forever.
  assert.equal(e._dirtyRoots.has(container), true, 'container recorded as dirty');

  await new Promise((resolve) => setTimeout(resolve, 150)); // let the debounce fire
  assert.equal(e._hideQueue.has(container), true);
  e.stopObserver();
});

test('an unrelated subtree mutation does not invalidate a cached verdict (§3.3)', () => {
  const e = engine();
  globalThis.MutationObserver = StubMutationObserver;
  const { container } = nestedCard();
  const elsewhere = domEl({ tagName: 'FOOTER' });
  installDom({ queryResults: { div: [container] } });

  e._proceduralRules = [{ selector: 'div:has-text(x)', plan: parseProceduralPlan('div:has-text(x)') }];
  e._startObserver();
  StubMutationObserver.lastInstance.cb([
    { type: 'childList', target: elsewhere, addedNodes: [domEl({ parentElement: elsewhere })] },
  ]);

  // The invalidation must stay bounded — dirtying every ancestor up to <html>
  // (what a `contains()` test would do) throws away the whole cache each tick.
  assert.equal(e._dirtyRoots.has(container), false);
  e._lastDirtyRoots = e._dirtyRoots;
  assert.equal(e._isInDirtySubtree(container), false);
  e.stopObserver();
});

test('init() starts the observer before the first procedural scan (§3.3)', () => {
  globalThis.MutationObserver = StubMutationObserver;
  StubMutationObserver.lastInstance = null;
  let e;
  const seen = [];
  const el = domEl();
  Object.defineProperty(el, 'textContent', {
    get() { seen.push(e._observer !== null); return 'Ad'; },
  });
  installDom({ queryResults: { div: [el] } });

  e = engine();
  e.init({ generic: ['div:has-text(Ad)'], domainSpecific: [] }, true);

  // Prior code scanned first, so any mutation racing that scan was never
  // recorded as a dirty root and its stale verdict stuck.
  assert.deepEqual(seen, [true]);
  e.stopObserver();
});

// ---------------------------------------------------------------------------
// §4.23 — `:style()` and post-op continuations bypassed the §5.26 root guard.
// ---------------------------------------------------------------------------

test('a subject-less :has-text() rule cannot :style() the document root (§4.23)', () => {
  const e = engine();
  const doc = installDom();
  const written = {};
  doc.documentElement.textContent = 'Buy now — Sponsored content everywhere';
  doc.documentElement.style = { setProperty: (p, v) => { written[p] = v; } };

  const sel = ':has-text(Sponsored):style(display: none !important)';
  e._proceduralRules = [{ selector: sel, plan: parseProceduralPlan(sel) }];
  e._applyAllProcedural();

  // Prior code wrote display:none onto <html> — a blank page from one user
  // filter line. `_hideElement`'s §5.26 guard is never reached by `:style()`.
  assert.deepEqual(written, {});
});

test('a subject-less op cannot sweep the page through a descendant continuation (§4.23)', () => {
  const e = engine();
  const doc = installDom();
  const spans = [domEl({ tagName: 'SPAN' }), domEl({ tagName: 'SPAN' })];
  doc.documentElement.textContent = 'Sponsored';
  doc.documentElement.querySelectorAll = (s) => (s === ':scope span' ? spans : []);

  const sel = ':has-text(Sponsored) span';
  e._proceduralRules = [{ selector: sel, plan: parseProceduralPlan(sel) }];
  e._applyAllProcedural();

  // Prior code hid every span on the page.
  assert.equal(e._hideQueue.size, 0);
});

test('a subject-less :matches-path() rule still applies — it is document-scoped (§4.23)', () => {
  const e = engine();
  const doc = installDom();
  const ad = domEl({ tagName: 'DIV' });
  doc.documentElement.querySelectorAll = (s) => (s === ':scope div.ad' ? [ad] : []);
  globalThis.location = { href: 'https://s.test/watch', pathname: '/watch', search: '', hostname: 's.test' };

  // 7 rules of this exact shape ship in EasyList/uBO today, so the guard must
  // reject subtree-reading seeds, not every subject-less rule.
  const sel = ':matches-path(/watch/) div.ad';
  e._proceduralRules = [{ selector: sel, plan: parseProceduralPlan(sel) }];
  e._applyAllProcedural();

  assert.equal(e._hideQueue.has(ad), true);
});

test(':style() on <body> is refused only when the declaration blanks the page (§4.23)', () => {
  const e = engine();
  const doc = installDom();
  const written = {};
  doc.body.style = { setProperty: (p, v) => { written[p] = v; } };

  // uBO ships ~100 anti-adblock rules that *restore* a scroll-locked page.
  e._applyOp(doc.body, 'style', 'overflow: auto !important', 'body:style(overflow: auto !important)');
  assert.equal(written.overflow, 'auto');

  e._applyOp(doc.body, 'style', 'display: none !important', 'body:style(display: none !important)');
  assert.equal(written.display, undefined);
});

// ---------------------------------------------------------------------------
// §5.15 — `_recordCacheAccess` was the dominant cost of a procedural run:
// indexOf + splice on a 500-entry array, once per element per operator step.
// ---------------------------------------------------------------------------

test('LRU bookkeeping is O(1) per access, not a 500-entry array scan (§5.15)', () => {
  const e = engine();
  for (let k = 0; k < 500; k++) e._matchCache.set(`has-text|arg${k}`, new WeakMap());

  const started = process.hrtime.bigint();
  for (let i = 0; i < 250000; i++) e._recordCacheAccess(`has-text|arg${i % 500}`);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  // Measured on the prior implementation: 432–485 ms. Map insertion order
  // brings it to ~20 ms; the bound leaves an order of magnitude of headroom
  // for a loaded CI box while still failing the array scan.
  assert.ok(ms < 200, `LRU bookkeeping took ${ms.toFixed(1)}ms for 250k accesses`);
});

test('a rule step reorders the LRU once, not once per element (§5.15)', () => {
  const e = engine();
  let reorders = 0;
  const spy = new (class extends Map {
    delete(key) { reorders++; return super.delete(key); }
  })();
  e._matchCache = spy;
  e._matchCache.set('other|x', new WeakMap());

  // One operator step applied across 100 candidates: the cache key is
  // per-rule, so the access only has to be recorded once.
  for (let i = 0; i < 100; i++) {
    e._applyOp(domEl({ textContent: 'Sponsored' }), 'has-text', 'Sponsored', 's');
  }
  assert.ok(reorders <= 1, `expected at most one LRU reorder, saw ${reorders}`);
});

test('cache eviction still drops the least recently used key (§5.15)', () => {
  const e = engine();
  e._cacheAccessLimit = 3;
  const el = domEl({ textContent: 'x' });
  for (const arg of ['a', 'b', 'c']) e._applyOp(el, 'has-text', arg, 's');
  e._applyOp(el, 'has-text', 'a', 's'); // refresh 'a'
  e._applyOp(el, 'has-text', 'd', 's'); // overflows — 'b' is now oldest

  assert.equal(e._matchCache.size, 3);
  assert.equal(e._matchCache.has('has-text|b'), false);
  assert.equal(e._matchCache.has('has-text|a'), true);
  assert.equal(e._matchCache.has('has-text|d'), true);
});

// ---------------------------------------------------------------------------
// §5.18 — the characterData gate never looked inside operator arguments.
// ---------------------------------------------------------------------------

test('a text operator nested in :has() still enables characterData (§5.18)', () => {
  globalThis.MutationObserver = StubMutationObserver;
  installDom();

  const e = engine();
  // Prior code checked only top-level `step.op`, so this very common uBO shape
  // reported `_hasTextRules === false` and the §5.28 fix never applied to it.
  e.init({ generic: ['div:has(span:has-text(Ad))'], domainSpecific: [] }, true);
  assert.equal(e._hasTextRules, true);
  assert.equal(StubMutationObserver.lastInstance.options.characterData, true);
  e.stopObserver();
});

// ---------------------------------------------------------------------------
// §5.19 — dirty-root snapshots pinned up to 1,000 elements, detached ones
// included, until the 5-minute sweep.
// ---------------------------------------------------------------------------

test('the dirty-root snapshot is released once the run consumes it (§5.19)', () => {
  const e = engine();
  installDom();
  e._proceduralRules = [{ selector: 'div:has-text(x)', plan: parseProceduralPlan('div:has-text(x)') }];
  e._lastDirtyRoots = new Set([domEl(), domEl(), domEl()]);

  e._applyAllProcedural();
  // Prior code held the array until `_startCacheSweep` fired, five minutes on.
  assert.equal(e._lastDirtyRoots.size, 0);
});

test('stopObserver() drops every element reference the engine holds (§5.19)', () => {
  const e = engine();
  globalThis.MutationObserver = StubMutationObserver;
  installDom();
  e._proceduralRules = [{ selector: 'div:has-text(x)', plan: parseProceduralPlan('div:has-text(x)') }];
  e._startObserver();
  e._startCacheSweep();
  e._dirtyRoots.add(domEl());
  e._lastDirtyRoots.add(domEl());
  e._hideQueue.add(domEl());

  e.stopObserver();
  assert.equal(e._observer, null);
  assert.equal(e._cacheSweepInterval, null);
  assert.equal(e._dirtyRoots.size, 0);
  assert.equal(e._lastDirtyRoots.size, 0);
  assert.equal(e._hideQueue.size, 0);
});

// ---------------------------------------------------------------------------
// §5.20 — a malformed line became a different, valid rule.
// ---------------------------------------------------------------------------

test('an unterminated operator argument rejects the whole selector (§5.20)', () => {
  // Prior code returned `[{css div}, {op has-text, arg "A"}]` — it silently
  // dropped the last character and matched a rule nobody wrote.
  assert.equal(parseProceduralPlan('div:has-text(Ad'), null);
  assert.equal(parseProceduralPlan('div:has(span:has-text(Ad)'), null);
  assert.equal(parseProceduralPlan('div:upward(2'), null);
});

test('a malformed procedural rule is dropped at ingestion, not half-applied (§5.20)', () => {
  globalThis.MutationObserver = StubMutationObserver;
  installDom();
  const e = engine();
  e.init({ generic: ['div:has-text(Ad', 'div:has-text(Ad)'], domainSpecific: [] }, true);

  assert.equal(e._proceduralRules.length, 1);
  assert.equal(e._proceduralRules[0].selector, 'div:has-text(Ad)');
  e.stopObserver();
});

test('well-formed selectors are unaffected by the malformed-input guard (§5.20)', () => {
  assert.deepEqual(parseProceduralPlan('div:has-text(Ad)'), [
    { type: 'css', kind: 'compound', selector: 'div' },
    { type: 'op', op: 'has-text', arg: 'Ad' },
  ]);
  assert.equal(parseProceduralPlan('div:has-text(Ad) span').length, 3);
  assert.equal(parseProceduralPlan('div:semantic(x)')[1].op, 'semantic');
  assert.equal(parseProceduralPlan(':xpath(//div[contains(text(),"Ad")])')[0].op, 'xpath');
});
