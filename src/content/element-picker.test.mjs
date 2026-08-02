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

globalThis.document = {
  querySelectorAll(sel) {
    if (sel === '*') return docState.all;
    return docState.byLevel.get(sel) || [];
  },
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  getElementById: () => null,
  createElement: () => ({ className: '', textContent: '', style: {}, remove: () => {} }),
  documentElement: { appendChild: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.location = { hostname: 'example.test' };
globalThis.CSS = { escape: (s) => s };
globalThis.ShadowRoot = FakeShadowRoot;

const { generateSelectors, isShadowOnlySelector, savePickerRule } =
  await import('./element-picker.js');

function makeDialog() {
  const footer = { innerHTML: '' };
  return {
    footer,
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
  assert.match(dialog.footer.innerHTML, /shadow/i);
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

  assert.match(dialog.footer.innerHTML, /storage write failed/);
  assert.ok(!dialog.footer.innerHTML.includes('Rule saved'));
});
