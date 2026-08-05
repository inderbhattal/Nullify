import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;

// --- Minimal DOM scaffolding -----------------------------------------------

class FakeMutationObserver {
  static instances = [];
  constructor(cb) {
    this.cb = cb;
    this.disconnected = false;
    FakeMutationObserver.instances.push(this);
  }
  observe(target, options) { this.options = options; }
  disconnect() { this.disconnected = true; }
}
globalThis.MutationObserver = FakeMutationObserver;
globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };

const windowListeners = [];
globalThis.addEventListener = (type, fn, options) => { windowListeners.push({ type, fn, options }); };

const fireWindowLoad = () => {
  for (const l of windowListeners.splice(0)) {
    if (l.type === 'load') l.fn();
  }
};

globalThis.document = {
  documentElement: {},
  cookie: '',
  addEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
};

/** Route a selector string to a fixed element list, uBO-style. */
function stubQuery(map) {
  document.querySelectorAll = (sel) => map[sel] ?? [];
}

const { removeAttr } = await import('./remove-attr.js');
const { addClass } = await import('./add-class.js');
const { removeClass } = await import('./remove-class.js');
const { trustedClickElement } = await import('./trusted-click-element.js');

function makeElement() {
  const classes = new Set();
  return {
    removedAttrs: [],
    removeAttribute(a) { this.removedAttrs.push(a); },
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      has: (c) => classes.has(c),
    },
    offsetParent: {},
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
    clicks: 0,
    click() { this.clicks++; },
  };
}

// §4.33 — uBO separates multiple tokens with `|`. Splitting on whitespace made
// "onkeydown|onselectstart" one invalid attribute name whose default selector
// `[onkeydown|onselectstart]` throws out of querySelectorAll.

test('remove-attr: splits | token lists and builds a valid selector', () => {
  const el = makeElement();
  const queried = [];
  document.querySelectorAll = (sel) => { queried.push(sel); return [el]; };

  removeAttr('onkeydown|onselectstart', '');

  assert.deepEqual(queried, ['[onkeydown],[onselectstart]'], 'selector must be per-attribute');
  assert.deepEqual(el.removedAttrs, ['onkeydown', 'onselectstart'], 'each attribute removed');
});

test('remove-attr stay: observer uses attributeFilter scoped to the attributes', () => {
  document.querySelectorAll = () => [];
  removeAttr('data-ad|data-track', '', 'stay');

  const mo = FakeMutationObserver.instances.at(-1);
  assert.deepEqual(
    mo.options.attributeFilter, ['data-ad', 'data-track'],
    'unfiltered attribute observation ran a full-document query on every class flip',
  );
});

test('add-class: splits | token lists into individual classes', () => {
  const el = makeElement();
  document.querySelectorAll = () => [el];

  addClass('sponsored-hidden|dismissed', '.banner');

  assert.equal(el.classList.has('sponsored-hidden'), true);
  assert.equal(el.classList.has('dismissed'), true);
  assert.equal(el.classList.has('sponsored-hidden|dismissed'), false, 'no compound token');
});

test('remove-class: splits | token lists into individual classes', () => {
  const el = makeElement();
  el.classList.add('modal-open', 'no-scroll');
  document.querySelectorAll = () => [el];

  removeClass('modal-open|no-scroll', 'body');

  assert.equal(el.classList.has('modal-open'), false);
  assert.equal(el.classList.has('no-scroll'), false);
});

// §5.36 — the class observers were never stored, so nothing could ever
// disconnect them. Without `stay`, they now stop at window load.

test('add-class/remove-class: observer disconnects at load unless "stay"', () => {
  document.querySelectorAll = () => [];

  addClass('x', '.a');
  const defaultMo = FakeMutationObserver.instances.at(-1);
  fireWindowLoad();
  assert.equal(defaultMo.disconnected, true, 'default behavior must stop observing at load');

  removeClass('y', '.b', 'stay');
  const stayMo = FakeMutationObserver.instances.at(-1);
  fireWindowLoad();
  assert.equal(stayMo.disconnected, false, '"stay" must keep enforcing');
});

// §4.34 — trusted-click-element read uBO's 3-argument form (selectors,
// extraMatch, delay) as (selector, delay, interval): the click fired
// immediately instead of after the delay.
//
// §4.26 — the step grammar was invented: it split on `!!`, which appears twice
// in 13,765 corpus rules and never as a separator, while uBO splits on `,`
// (or on `;`/`|` when the argument starts with one) and treats an all-digits
// step as a delay. Every multi-step rule went into querySelector whole and
// threw. It also gated every click on `offsetParent !== null`, which is null
// for any `position: fixed` element.

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('tce: uBO 3-arg form — delay is honored before the click', async () => {
  const el = makeElement();
  stubQuery({ '#accept-ads': [el] });

  trustedClickElement('#accept-ads', '', '40');

  await settle(15);
  assert.equal(el.clicks, 0, 'prior code clicked immediately, treating "" as delay 0');

  await settle(60);
  assert.equal(el.clicks, 1, 'click must land once the delay has elapsed');
});

// §4.26: 6 corpus rules ship a comma list with integer delay steps, e.g.
// `1000, #next-timer-btn > .btn-success, 600, #final-nextbutton`. The prior
// grammar handed the whole string to querySelector, which throws.
test('tce: comma-separated steps click in order, integer steps are delays', async () => {
  const first = makeElement();
  const second = makeElement();
  stubQuery({ '#step-one': [first], '#step-two': [second] });

  trustedClickElement('5, #step-one, 5, #step-two', '', '');

  await settle(60);
  assert.equal(first.clicks, 1, 'first selector step must be clicked');
  assert.equal(second.clicks, 1, 'a multi-step rule must not die in querySelector');
});

test('tce: a leading ; or | overrides the separator so selectors may hold commas', async () => {
  const el = makeElement();
  stubQuery({ 'div[a="x,y"]': [el] });

  trustedClickElement(';div[a="x,y"]', '', '');

  await settle(20);
  assert.equal(el.clicks, 1, 'the alternate separator must not split inside the selector');
});

// §4.26: `el.offsetParent === null` is true for every position:fixed element
// per spec, so the old visibility gate never clicked a fixed consent button —
// which is what essentially every cookie banner uses.
test('tce: a position:fixed button (offsetParent === null) is still clicked', async () => {
  const el = makeElement();
  el.offsetParent = null;
  el.getBoundingClientRect = () => ({ width: 0, height: 0 });
  stubQuery({ '#fixed-consent': [el] });

  trustedClickElement('#fixed-consent', '', '');

  await settle(20);
  assert.equal(el.clicks, 1, 'uBO clicks unconditionally; visibility is opt-in');
});

// §4.26: 25 rules use ` >>> ` to reach into a shadow root — the Usercentrics
// CMP rules, ~105 domains across the corpus.
test('tce: >>> pierces shadow roots', async () => {
  const inner = makeElement();
  const host = { ...makeElement(), shadowRoot: { querySelectorAll: (s) => (s === '#deny' ? [inner] : []) } };
  stubQuery({ '#usercentrics-root': [host] });

  trustedClickElement('#usercentrics-root >>> #deny', '', '');

  await settle(20);
  assert.equal(inner.clicks, 1, 'shadow-piercing selector must resolve');
});

test('tce: xpath: and when-visible: directives resolve', async () => {
  const byXpath = makeElement();
  document.evaluate = () => ({
    resultType: 7,
    snapshotLength: 1,
    snapshotItem: () => byXpath,
  });

  trustedClickElement('xpath://button[@id="ok"]', '', '');
  await settle(20);
  assert.equal(byXpath.clicks, 1, 'xpath: must not go through querySelectorAll');

  const hidden = makeElement();
  hidden.checkVisibility = () => false;
  stubQuery({ '#maybe': [hidden] });
  // The trailing integer step is uBO's per-step lookup timeout; a short one
  // keeps the never-resolving case from holding the event loop for 11 s.
  trustedClickElement('when-visible:#maybe, 20', '', '5');
  await settle(60);
  assert.equal(hidden.clicks, 0, 'when-visible: must filter out invisible elements');
});

// §4.26: `cookie:` used to substring-match the whole document.cookie string
// and `localStorage:key=value` looked up a literal key named "key=value".
// uBO anchors `^key=value` against each enumerated entry.
test('tce: extraMatch anchors ^key=value over enumerated cookies', async () => {
  const el = makeElement();
  stubQuery({ '#a': [el] });
  document.cookie = 'other=nope; consent=1';

  trustedClickElement('#a', 'cookie:missing=1', '');
  await settle(20);
  assert.equal(el.clicks, 0, 'failed cookie condition must not click');

  // A substring match over the raw cookie string would fire on this: the
  // value `nope` contains no `consent=1`, but `onsent=1` is a substring of
  // the joined string. Anchoring per entry is what makes it exact.
  trustedClickElement('#a', 'cookie:onsent=1', '');
  await settle(20);
  assert.equal(el.clicks, 0, 'the needle must be anchored at the start of a key');

  trustedClickElement('#a', 'cookie:consent=1', '');
  await settle(20);
  assert.equal(el.clicks, 1, 'satisfied cookie condition must click');
});

test('tce: extraMatch negation with ! inverts the assertion', async () => {
  const el = makeElement();
  stubQuery({ '#b': [el] });
  document.cookie = 'consent=1';

  trustedClickElement('#b', '!cookie:consent=1', '');
  await settle(20);
  assert.equal(el.clicks, 0, 'a present cookie must fail a negated assertion');

  trustedClickElement('#b', '!cookie:absent=1', '');
  await settle(20);
  assert.equal(el.clicks, 1, 'an absent cookie must satisfy a negated assertion');
});

test('tce: waits for a late element via MutationObserver', async () => {
  let els = [];
  document.querySelectorAll = () => els;

  trustedClickElement('#late-banner', '', '');
  await settle(5);
  const mo = FakeMutationObserver.instances.at(-1);
  assert.equal(mo.disconnected, false, 'must keep watching while the element is missing');

  const el = makeElement();
  els = [el];
  mo.cb([]); // simulate the banner being inserted
  await settle(5);
  assert.equal(el.clicks, 1);
  assert.equal(mo.disconnected, true, 'observer must stop once the step resolves');
});

test('tce: malformed selector does not throw out of the scriptlet', async () => {
  document.querySelectorAll = () => { throw new SyntaxError('bad selector'); };
  assert.doesNotThrow(() => trustedClickElement('#a[, 20', '', ''));
  await settle(60);
});
