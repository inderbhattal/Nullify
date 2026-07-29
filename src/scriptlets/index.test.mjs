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
