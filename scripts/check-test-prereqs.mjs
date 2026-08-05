/**
 * check-test-prereqs.mjs — run as `pretest`.
 *
 * `src/background/service-worker.js` imports the generated wasm-bindgen glue
 * statically, and `src/shared/wasm/` is a gitignored build product. On a fresh
 * clone `npm test` therefore fails 96 times with ERR_MODULE_NOT_FOUND and no
 * indication of the cause. Checking once, up front, turns that into one line
 * that says what to run.
 *
 * Deliberately does NOT build the artifact itself: `npm test` should stay fast
 * and predictable, and a test command that silently invokes a Rust toolchain
 * is a surprise nobody wants mid-loop.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const glue = join(repoRoot, 'src/shared/wasm/nullify_core.js');

if (!existsSync(glue)) {
  process.stderr.write(
    '\n  The WASM artifact is missing, so the service-worker harness cannot load.\n\n' +
    '    npm run build:wasm\n\n' +
    '  It is a build product (gitignored), needed once per clone and again\n' +
    '  after any change under wasm-core/. `npm run setup` does it for you.\n\n',
  );
  process.exit(1);
}
