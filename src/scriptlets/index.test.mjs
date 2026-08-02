import test from 'node:test';
import assert from 'node:assert/strict';

// The scriptlet bundle runs in the page's MAIN world, so `window` is the
// global object and page script can replace any built-in before we dispatch.
globalThis.window = globalThis;

let instance = 0;
/** Fresh module instance — `run` keeps a module-level dedupe Set. */
async function freshRun() {
  const mod = await import(`./index.js?case=${instance++}`);
  return mod.run;
}

test('run(): a page that breaks JSON.stringify cannot stop scriptlets', async () => {
  const run = await freshRun();
  const origStringify = JSON.stringify;
  JSON.stringify = () => { throw new Error('nope'); };

  try {
    assert.doesNotThrow(() => run('set', ['__t_throw', 'true']));
    assert.equal(globalThis.__t_throw, true, 'scriptlet must still have run');
  } finally {
    JSON.stringify = origStringify;
    delete globalThis.__t_throw;
  }
});

test('run(): a page that stubs JSON.stringify cannot collapse dedupe keys', async () => {
  const run = await freshRun();
  const origStringify = JSON.stringify;
  JSON.stringify = () => '';

  try {
    run('set', ['__t_a', 'true']);
    run('set', ['__t_b', 'true']);
    assert.equal(globalThis.__t_a, true, 'first scriptlet must run');
    assert.equal(globalThis.__t_b, true, 'second scriptlet must not be deduped away');
  } finally {
    JSON.stringify = origStringify;
    delete globalThis.__t_a;
    delete globalThis.__t_b;
  }
});

test('run(): identical name+args still runs only once', async () => {
  const run = await freshRun();

  run('set', ['__t_dedupe', 'true']);
  assert.equal(globalThis.__t_dedupe, true);

  delete globalThis.__t_dedupe;
  run('set', ['__t_dedupe', 'true']);
  assert.equal(globalThis.__t_dedupe, undefined, 'repeat call must be deduped');
});

test('run(): differing args are not deduped together', async () => {
  const run = await freshRun();

  run('set', ['__t_x', 'true']);
  run('set', ['__t_y', 'true']);

  try {
    assert.equal(globalThis.__t_x, true);
    assert.equal(globalThis.__t_y, true);
  } finally {
    delete globalThis.__t_x;
    delete globalThis.__t_y;
  }
});

test('run(): a throwing scriptlet does not propagate to the caller', async () => {
  const run = await freshRun();
  // `set` with a proto-pollution path returns early; an arg count mismatch on
  // a DOM scriptlet throws inside the scriptlet body. Neither may escape.
  assert.doesNotThrow(() => run('ra', [undefined, undefined]));
});

test('run(): unknown scriptlet name is a no-op, not a throw', async () => {
  const run = await freshRun();
  assert.doesNotThrow(() => run('definitely-not-a-scriptlet', ['x']));
});

test('run(): unknown names are counted so coverage gaps are observable', async () => {
  const mod = await import(`./index.js?case=${instance++}`);

  mod.run('definitely-not-a-scriptlet', ['x']);
  mod.run('definitely-not-a-scriptlet', ['y']);
  mod.run('also-missing', []);

  const misses = mod.getUnknownScriptlets();
  assert.equal(misses['definitely-not-a-scriptlet'], 2);
  assert.equal(misses['also-missing'], 1);
  assert.equal(misses['set'], undefined, 'implemented names must not be counted');
});

test('registry: uBO aliases resolve to the same implementation as their canonical name', async () => {
  const { REGISTRY } = await import(`./index.js?case=${instance++}`);

  // Each pair is a documented uBO alias. Mapping an alias to a *different*
  // implementation would be worse than leaving it unresolved, so assert
  // identity rather than mere presence.
  const aliases = [
    ['acs', 'abort-current-inline-script'],
    ['abort-current-script', 'abort-current-inline-script'],
    ['nowoif', 'no-window-open-if'],
    ['window.open-defuser', 'prevent-window-open'],
    ['nano-sib', 'adjust-set-interval'],
    ['nano-stb', 'adjust-set-timeout'],
    ['cookie-remover', 'remove-cookie'],
  ];

  for (const [alias, canonical] of aliases) {
    assert.equal(
      REGISTRY.get(alias),
      REGISTRY.get(canonical),
      `${alias} must resolve to ${canonical}`,
    );
  }
});

// ---------------------------------------------------------------------------
// §4.24 (REVIEW-2026-07) — boot-key registration hardening.
// ---------------------------------------------------------------------------

/** Fresh module instance with a boot key staged before evaluation. */
async function loadWithBootKey(key) {
  if (key === undefined) {
    delete globalThis.__nullifyBootKey;
  } else {
    globalThis.__nullifyBootKey = key;
  }
  try {
    await import(`./index.js?bootcase=${instanceTag()}`);
  } finally {
    // Best-effort cleanup; a non-configurable seed can't be deleted.
    try { delete globalThis.__nullifyBootKey; } catch { /* ignore */ }
  }
}

let _bootInstance = 0;
function instanceTag() { return `b${++_bootInstance}`; }

test('4.24: refuses to register under a boot key that does not match the SW shape', async () => {
  const badKeys = [
    '__n_' + 'f'.repeat(31),           // too short
    '__n_' + 'f'.repeat(33),           // too long
    '__n_' + 'F'.repeat(32),           // uppercase hex — SW never emits this
    '__n_' + 'g'.repeat(32),           // non-hex
    '__x_' + 'f'.repeat(32),           // wrong prefix
    'stolen-key',                      // arbitrary page-chosen name
  ];
  for (const key of badKeys) {
    await loadWithBootKey(key);
    assert.equal(
      Object.getOwnPropertyDescriptor(globalThis, key),
      undefined,
      `dispatcher must not be registered under forged key ${JSON.stringify(key)}`
    );
  }
});

test('4.24: registers a frozen single-method registry under a well-shaped key', async () => {
  const key = '__n_' + '0123456789abcdef'.repeat(2);
  await loadWithBootKey(key);

  const desc = Object.getOwnPropertyDescriptor(globalThis, key);
  assert.ok(desc, 'registry must be registered');
  assert.equal(desc.configurable, false);
  assert.equal(desc.enumerable, false);
  assert.equal(desc.writable, false);
  assert.ok(Object.isFrozen(desc.value));
  assert.deepEqual(Reflect.ownKeys(desc.value), ['run']);
  assert.equal(typeof desc.value.run, 'function');
});

test('4.24: does not delete the boot key after registering (SW seeds it non-configurable)', async () => {
  const key = '__n_' + 'abcdef0123456789'.repeat(2);
  globalThis.__nullifyBootKey = key;
  await import(`./index.js?bootcase=${instanceTag()}`);
  assert.equal(
    globalThis.__nullifyBootKey,
    key,
    'bundle must not attempt to delete the seeded boot property'
  );
  delete globalThis.__nullifyBootKey;
});
