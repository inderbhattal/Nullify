import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.document = { currentScript: null };

const { abortCurrentInlineScript } = await import('./abort-current-inline-script.js');
const { abortOnPropertyRead } = await import('./abort-on-property-read.js');
const { abortOnPropertyWrite } = await import('./abort-on-property-write.js');
const { abortOnStackTrace } = await import('./abort-on-stack-trace.js');
const { noeval } = await import('./noeval.js');

const BRANDING = /AdBlock|Nullify/;

// §4.26 — acis's setter did `obj[lastProp] = v`, re-entering itself. Any page
// script assigning the trapped property (Math.random = seededRng) blew the
// stack and killed the enclosing script.

test('acis: assigning the trapped property does not recurse and stores the value', () => {
  globalThis.__acisRecurse = 1;
  abortCurrentInlineScript('__acisRecurse', 'zzz_never_matches');

  assert.doesNotThrow(() => {
    globalThis.__acisRecurse = 123; // prior code: RangeError, max call stack
  });
  assert.equal(globalThis.__acisRecurse, 123, 'the page assignment must stick');
});

// §4.26 (related) — binding inside the getter returned a fresh function per
// read, so trapped functions failed identity checks (a detection tell).

test('acis: repeated reads of a trapped function are identical', () => {
  globalThis.__acisIdent = function () { return 7; };
  abortCurrentInlineScript('__acisIdent', 'zzz_never_matches');

  assert.equal(globalThis.__acisIdent, globalThis.__acisIdent, 'no per-read bind allocation');
  assert.equal(globalThis.__acisIdent(), 7);
});

test('acis: still aborts a matching inline read, with an unbranded message', () => {
  globalThis.__acisAbort = 1;
  document.currentScript = { textContent: 'if (__acisAbort) { showAds(); }' };
  try {
    abortCurrentInlineScript('__acisAbort', 'showAds');
    assert.throws(
      () => globalThis.__acisAbort,
      (err) => err instanceof ReferenceError && !BRANDING.test(err.message),
      'must throw, and the message must not fingerprint the extension',
    );
  } finally {
    document.currentScript = null;
  }
});

// §4.27 — with a parent that exists as a plain data property holding undefined
// (`var adconfig;`), neither setter branch stored the page's assignment: the
// page broke AND the abort never armed.

test('aopr: deferred-parent setter stores the assignment and then arms the abort', () => {
  globalThis.__aoprParent = undefined; // same shape as top-level `var adconfig;`
  abortOnPropertyRead('__aoprParent.detected');

  globalThis.__aoprParent = { init: () => 42 };
  assert.equal(typeof globalThis.__aoprParent, 'object', 'assignment must not be discarded');
  assert.equal(globalThis.__aoprParent.init(), 42, 'page code must keep working');
  assert.throws(
    () => globalThis.__aoprParent.detected,
    ReferenceError,
    'the intended abort must arm on the stored object',
  );
});

// §5.34 — thrown messages carried literal branding ("AdBlock: …"), giving
// anti-adblock code a one-line detector. All aborts now throw a random
// per-load token.

test('aopr/aopw: abort messages carry no branding literals', () => {
  abortOnPropertyRead('__aoprPlain');
  assert.throws(
    () => globalThis.__aoprPlain,
    (err) => err instanceof ReferenceError && !BRANDING.test(err.message),
  );

  globalThis.__aopwPlain = 1;
  abortOnPropertyWrite('__aopwPlain');
  assert.throws(
    () => { globalThis.__aopwPlain = 2; },
    (err) => err instanceof ReferenceError && !BRANDING.test(err.message),
  );
});

test('noeval: throws an unbranded EvalError', () => {
  const origEval = globalThis.eval;
  try {
    noeval();
    assert.throws(
      () => window.eval('1 + 1'),
      (err) => err instanceof EvalError && !BRANDING.test(err.message),
    );
  } finally {
    globalThis.eval = origEval;
  }
});

// §5.34 — aost logged "[Nullify] Silently aborted …" through console.log,
// leaking the extension name to any page that wrapped console.log.

test('aost: aborts silently — nothing written to console', () => {
  globalThis.__aostTarget = { fire: () => 'ran' };
  abortOnStackTrace('__aostTarget.fire', 'abort-scriptlets'); // matches this file in the stack

  const origLog = console.log;
  const logged = [];
  console.log = (...args) => { logged.push(args); };
  try {
    assert.equal(globalThis.__aostTarget.fire(), undefined, 'matching stack must abort the call');
  } finally {
    console.log = origLog;
  }
  assert.deepEqual(logged, [], 'the abort must not log anything');
});

// §5.34 — the re-application guard sniffed getter source for 'adblock' (dead
// code once the literal was removed). It now recognizes its own getter, so
// re-running the same rule must not stack or throw.

test('aopr: re-applying the same rule is a no-op, and the abort still works', () => {
  abortOnPropertyRead('__aoprTwice');
  const desc = Object.getOwnPropertyDescriptor(globalThis, '__aoprTwice');
  abortOnPropertyRead('__aoprTwice');
  assert.equal(
    Object.getOwnPropertyDescriptor(globalThis, '__aoprTwice').get,
    desc.get,
    'second application must detect the armed getter and bail',
  );
  assert.throws(() => globalThis.__aoprTwice, ReferenceError);
});
