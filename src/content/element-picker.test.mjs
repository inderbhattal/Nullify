import test from 'node:test';
import assert from 'node:assert/strict';

// element-picker.js reads DOM globals at call time only (its module top level
// just defines constants), so stubs installed here are in place before any
// exported function runs.

class FakeShadowRoot {
  constructor(host) { this.host = host; }
}

/** Minimal element stub carrying what the picker touches. */
function el(overrides = {}) {
  return {
    tagName: 'DIV',
    id: '',
    classList: [],
    textContent: '',
    parentElement: null,
    getAttribute: () => null,
    getRootNode() { return globalThis.document; },
    querySelectorAll: () => [],
    style: { setProperty: () => {} },
    ...overrides,
  };
}

// Mutable per-test document state: selector -> matches at the document level,
// plus the elements returned by a wildcard scan (used for shadow traversal).
const docState = { byLevel: new Map(), all: [] };

/**
 * Node stub with the two behaviours the picker's DOM writes depend on:
 * assigning `innerHTML` re-parses (and therefore *replaces*) the children —
 * which is how §5.16's listener loss happens — while `appendChild` does not.
 */
function makeNode(tag = 'div') {
  return {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    style: {},
    children: [],
    listeners: new Map(),
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(value) { this._html = value; this.children = []; },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); },
    remove() {
      mountedById.delete(this.id);
      const siblings = this.parentNode?.children;
      if (siblings) siblings.splice(siblings.indexOf(this), 1);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
  };
}

// Elements the picker mounted on documentElement, keyed by id.
const mountedById = new Map();
// document-level listeners, keyed by `type` (all of the picker's are capture).
const docListeners = new Map();

globalThis.document = {
  querySelectorAll(sel) {
    if (sel === '*') return docState.all;
    return docState.byLevel.get(sel) || [];
  },
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  getElementById: (id) => mountedById.get(id) || null,
  createElement: (tag) => makeNode(tag),
  documentElement: {
    appendChild(node) { if (node?.id) mountedById.set(node.id, node); return node; },
  },
  addEventListener(type, fn) {
    if (!docListeners.has(type)) docListeners.set(type, new Set());
    docListeners.get(type).add(fn);
  },
  removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
  elementFromPoint: () => null,
};
globalThis.location = { hostname: 'example.test' };
globalThis.CSS = { escape: (s) => s };
globalThis.ShadowRoot = FakeShadowRoot;
globalThis.window = { top: globalThis.window ?? {} };
globalThis.window.top = globalThis.window; // top frame by default

const { generateSelectors, isShadowOnlySelector, savePickerRule, activatePicker, deactivatePicker } =
  await import('./element-picker.js');

/** Dispatch to whatever the picker registered on `document` for `type`. */
function fireDocEvent(type, event) {
  for (const fn of docListeners.get(type) || []) fn(event);
  return event;
}

/** An event stub that records which suppression calls it received. */
function makeEvent(overrides = {}) {
  const e = {
    type: 'keydown',
    key: 'k',
    target: { closest: () => null },
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    stopImmediatePropagation() { this.propagationStopped = true; },
    ...overrides,
  };
  return e;
}

function resetPickerEnv() {
  deactivatePicker();
  mountedById.clear();
  docListeners.clear();
  docState.byLevel = new Map();
  docState.all = [];
  globalThis.window.top = globalThis.window;
}

function makeDialog() {
  const footer = makeNode('div');
  footer.className = 'adblock-picker-footer';
  // The buttons `updatePickerDialog` wires listeners onto.
  footer.children = [makeNode('button'), makeNode('button')];
  footer._html = '<button id="adblock-picker-cancel2">Cancel</button>';
  return {
    footer,
    footerText: () => footer.children.map((c) => c.textContent).join(' '),
    querySelector: (sel) => (sel === '.adblock-picker-footer' ? footer : null),
  };
}

// §5.30 — the picker must not offer (or save) candidates that document-level
// CSS cannot apply because they only exist inside a shadow root.

test('picker offers only host-level candidates for shadow-DOM elements (§5.30)', () => {
  const host = el({ tagName: 'ASIDE', id: 'widget', classList: ['promo-box'] });
  const shadow = new FakeShadowRoot(host);
  const inner = el({
    tagName: 'SPAN',
    id: 'inner-ad',
    classList: ['ad-box', 'ad-label'],
    getRootNode: () => shadow,
  });
  docState.byLevel = new Map([
    ['#widget', [host]],
    ['.promo-box', [host]],
    ['aside', [host]],
  ]);
  docState.all = [];

  const candidates = generateSelectors(inner);
  assert.ok(candidates.length > 0, 'host-level candidates offered');
  assert.ok(candidates.some((c) => c.selector === '#widget'));
  // Prior code went on to offer #inner-ad / .ad-box — selectors a saved
  // document-level rule could never apply.
  for (const c of candidates) {
    assert.ok(
      !c.selector.includes('inner-ad') && !c.selector.includes('ad-box'),
      `shadow-internal candidate offered: ${c.selector}`
    );
  }
});

test('saving a shadow-only selector is refused with an explanation (§5.30)', async () => {
  const sent = [];
  globalThis.chrome = {
    runtime: { sendMessage: (msg) => { sent.push(msg); return Promise.resolve({ ok: true }); } },
  };

  // `.ad-box` matches nothing at the document level, but the shadow-piercing
  // deep query (what the preview shows) finds a hit inside a shadow root.
  const hostEl = el();
  hostEl.shadowRoot = { querySelectorAll: (sel) => (sel === '.ad-box' ? [el()] : []) };
  docState.byLevel = new Map();
  docState.all = [hostEl];
  assert.equal(isShadowOnlySelector('.ad-box'), true);

  const dialog = makeDialog();
  await savePickerRule('example.test##.ad-box', '.ad-box', 'example.test', dialog);

  // Prior code persisted the dead rule and showed "Rule saved".
  assert.equal(sent.length, 0, 'nothing persisted');
  assert.match(dialog.footerText(), /shadow/i);
  assert.ok(!dialog.footer.innerHTML.includes('Rule saved'));
});

// §5.31 — the save path must be a single atomic append, not a
// read-modify-write that races other writers.

test('picker save is a single atomic APPEND_USER_FILTER message (§5.31)', async () => {
  const sent = [];
  globalThis.chrome = {
    runtime: { sendMessage: (msg) => { sent.push(msg); return Promise.resolve({ ok: true }); } },
  };

  const target = el();
  docState.byLevel = new Map([['.ad-banner', [target]]]);
  docState.all = [];

  const dialog = makeDialog();
  await savePickerRule('example.test##.ad-banner', '.ad-banner', 'example.test', dialog);

  // Prior code issued GET_USER_FILTERS + SET_USER_FILTERS — two pickers (or a
  // picker plus an options-page edit) silently dropped one rule.
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: 'APPEND_USER_FILTER',
    payload: { line: 'example.test##.ad-banner' },
  });
  assert.match(dialog.footer.innerHTML, /Rule saved/);
});

test('an APPEND_USER_FILTER error response is surfaced, not shown as success (§5.31)', async () => {
  globalThis.chrome = {
    runtime: { sendMessage: () => Promise.resolve({ error: 'storage write failed' }) },
  };
  docState.byLevel = new Map([['.ad-banner', [el()]]]);
  docState.all = [];

  const dialog = makeDialog();
  await savePickerRule('##.ad-banner', '.ad-banner', 'example.test', dialog);

  assert.match(dialog.footerText(), /storage write failed/);
  assert.ok(!dialog.footer.innerHTML.includes('Rule saved'));
});

// §5.16 — the error path re-parsed the footer, replacing Cancel and Create
// with fresh nodes that carried none of the listeners wired in
// `updatePickerDialog`. The §5.30 refusal above goes through this path, so the
// user read "pick the outer element instead", picked it, clicked Create — and
// nothing happened.

test('showing an error keeps the footer buttons and their listeners (§5.16)', async () => {
  globalThis.chrome = {
    runtime: { sendMessage: () => Promise.resolve({ error: 'nope' }) },
  };
  docState.byLevel = new Map([['.ad-banner', [el()]]]);
  docState.all = [];

  const dialog = makeDialog();
  const buttonsBefore = dialog.footer.children.slice();
  await savePickerRule('##.ad-banner', '.ad-banner', 'example.test', dialog);

  // Prior code (`footer.innerHTML += …`) dropped both buttons on the floor.
  for (const button of buttonsBefore) {
    assert.ok(dialog.footer.children.includes(button), 'footer button survived');
  }
  assert.match(dialog.footerText(), /nope/);
});

test('a second error replaces the first instead of stacking (§5.16)', async () => {
  globalThis.chrome = {
    runtime: { sendMessage: () => Promise.resolve({ error: 'first' }) },
  };
  docState.byLevel = new Map([['.ad-banner', [el()]]]);
  docState.all = [];

  const dialog = makeDialog();
  // The stub's querySelector returns the footer for any selector, which is
  // enough for the de-dupe lookup inside showErrorInDialog.
  dialog.footer.querySelector = (sel) =>
    dialog.footer.children.find((c) => c.className && sel.includes(c.className)) || null;

  await savePickerRule('##.ad-banner', '.ad-banner', 'example.test', dialog);
  globalThis.chrome.runtime.sendMessage = () => Promise.resolve({ error: 'second' });
  await savePickerRule('##.ad-banner', '.ad-banner', 'example.test', dialog);

  const errors = dialog.footer.children.filter((c) => c.className.includes('error'));
  assert.equal(errors.length, 1);
  assert.match(errors[0].textContent, /second/);
});

// §4.24 — ACTIVATE_PICKER is broadcast to every frame; a page with 15 iframes
// got 16 pickers, and ESC (which does not cross frame boundaries) could only
// dismiss the focused one.

test('the picker refuses to mount in a subframe (§4.24)', () => {
  resetPickerEnv();
  globalThis.window.top = { differentFrame: true };

  activatePicker();
  // Prior code mounted a full-viewport overlay in every ad frame and embed.
  assert.equal(mountedById.size, 0, 'nothing mounted in the subframe');
  assert.equal(docListeners.size, 0, 'no capture handlers installed');

  resetPickerEnv();
});

test('an explicitly targeted subframe activation is still honoured (§4.24)', () => {
  resetPickerEnv();
  globalThis.window.top = { differentFrame: true };

  activatePicker({ allowInFrame: true });
  assert.ok(mountedById.size > 0, 'overlay mounted when explicitly targeted');

  resetPickerEnv();
});

test('DEACTIVATE_PICKER tears the picker down completely (§4.24)', () => {
  resetPickerEnv();
  activatePicker();
  assert.ok(mountedById.size > 0);
  assert.ok(docListeners.get('keydown')?.size > 0);

  deactivatePicker();
  assert.equal(mountedById.size, 0, 'overlay, highlight, dialog and styles removed');
  for (const [type, fns] of docListeners) {
    assert.equal(fns.size, 0, `no ${type} listener left behind`);
  }

  resetPickerEnv();
});

// §5.17 — only Escape was intercepted and only `click` was suppressed, so
// typing a selector on YouTube fired the page's k/j/space/f shortcuts and
// every press after the first click reached the page's own handlers.

test('page-bound key events are swallowed while the picker is active (§5.17)', () => {
  resetPickerEnv();
  activatePicker();

  for (const type of ['keydown', 'keypress', 'keyup']) {
    const event = fireDocEvent(type, makeEvent({ type, key: 'k' }));
    assert.equal(event.defaultPrevented, true, `${type} prevented`);
    assert.equal(event.propagationStopped, true, `${type} stopped`);
  }

  resetPickerEnv();
});

test('keys aimed at the picker dialog are left alone so typing works (§5.17)', () => {
  resetPickerEnv();
  activatePicker();

  const inDialog = makeEvent({ type: 'keydown', key: 'a', target: { closest: () => ({}) } });
  fireDocEvent('keydown', inDialog);
  assert.equal(inDialog.defaultPrevented, false);
  assert.equal(inDialog.propagationStopped, false);

  resetPickerEnv();
});

test('Escape still cancels the picker (§5.17 didn\'t re-break)', () => {
  resetPickerEnv();
  activatePicker();
  assert.ok(mountedById.size > 0);

  fireDocEvent('keydown', makeEvent({ type: 'keydown', key: 'Escape' }));
  assert.equal(mountedById.has('__adblock_picker_overlay__'), false);

  resetPickerEnv();
});

test('mousedown and pointerdown are suppressed, not just click (§5.17)', () => {
  resetPickerEnv();
  activatePicker();

  for (const type of ['mousedown', 'pointerdown']) {
    const event = fireDocEvent(type, makeEvent({ type }));
    assert.equal(event.defaultPrevented, true, `${type} prevented`);
    assert.equal(event.propagationStopped, true, `${type} stopped`);
  }

  resetPickerEnv();
});

test('the overlay stays mounted once the dialog opens (§5.17)', () => {
  resetPickerEnv();
  const target = el({ tagName: 'DIV' });
  target.closest = () => null;
  target.getRootNode = () => globalThis.document;
  target.getBoundingClientRect = () => ({ top: 0, left: 0, width: 10, height: 10 });
  globalThis.document.elementFromPoint = () => target;
  activatePicker();

  fireDocEvent('click', makeEvent({ type: 'click', clientX: 5, clientY: 5 }));

  const overlay = mountedById.get('__adblock_picker_overlay__');
  // Prior code removed the overlay here, after which every press landed on
  // the page's own handlers.
  assert.ok(overlay, 'overlay still mounted');
  assert.equal(overlay.style.pointerEvents, 'none', 'but no longer eating dialog clicks');

  resetPickerEnv();
});
