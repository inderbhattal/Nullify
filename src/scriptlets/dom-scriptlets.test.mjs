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
// immediately instead of after the delay, and a missing element rescheduled a
// timer forever. It is now MutationObserver-driven with a hard deadline.

test('tce: uBO 3-arg form — delay is honored, then observer/timers stop', async () => {
  const el = makeElement();
  document.querySelector = (sel) => (sel === '#accept-ads' ? el : null);

  trustedClickElement('#accept-ads', '', '40');

  await new Promise((r) => setTimeout(r, 15));
  assert.equal(el.clicks, 0, 'prior code clicked immediately, treating "" as delay 0');

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(el.clicks, 1, 'click must land once the delay has elapsed');

  const mo = FakeMutationObserver.instances.at(-1);
  assert.equal(mo.disconnected, true, 'observer must disconnect after a successful click');
});

test('tce: waits for the element via MutationObserver, no polling timer', async () => {
  let el = null;
  document.querySelector = () => el;

  trustedClickElement('#late-banner', '', '');
  const mo = FakeMutationObserver.instances.at(-1);
  assert.equal(mo.disconnected, false, 'must keep watching while the element is missing');

  el = makeElement();
  mo.cb([]); // simulate the banner being inserted
  assert.equal(el.clicks, 1);
  assert.equal(mo.disconnected, true);
});

test('tce: extraMatch gates clicking', () => {
  const el = makeElement();
  document.querySelector = () => el;
  document.cookie = 'consent=1';

  trustedClickElement('#a', 'cookie:missing=1', '');
  assert.equal(el.clicks, 0, 'failed cookie condition must not click');

  trustedClickElement('#a', 'cookie:consent=1', '');
  assert.equal(el.clicks, 1, 'satisfied cookie condition must click');
});

test('tce: malformed selector stops cleanly instead of retrying forever', () => {
  document.querySelector = () => { throw new SyntaxError('bad selector'); };

  assert.doesNotThrow(() => trustedClickElement('#a[', '', ''));
  const mo = FakeMutationObserver.instances.at(-1);
  assert.equal(mo.disconnected, true, 'retrying a selector that throws cannot help');
});
