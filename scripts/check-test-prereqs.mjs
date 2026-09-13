/**
 * check-test-prereqs.mjs — run as `pretest`.
 *
 * `src/background/service-worker.js` imports the generated wasm-bindgen glue
 * statically, and `src/shared/wasm/` is a gitignored build product. On a fresh
 * clone `npm test` therefore fails 96 times with ERR_MODULE_NOT_FOUND and no
 * indication of the cause. Checking once, up front, turns that into one line
 * that says what to run.
 *
 * Existence is not enough (§5.16): a *stale* artifact — built before the last
 * edit under wasm-core/ — loads fine and then fails the parity suite in ways
 * that look like product bugs. So this also checks freshness:
 *
 *   1. By content. `src/shared/wasm/.source-hash` records the sha256 of the
 *      wasm-core sources (src/*.rs, sorted, plus Cargo.lock) the artifact was
 *      last known to be built from. Same hash now → fresh, whatever the
 *      mtimes say. A `git checkout`/rebase rewrites every .rs mtime without
 *      changing a byte, and must not demand a multi-minute rebuild.
 *   2. By mtime, when the hash file is absent or disagrees: artifact at least
 *      as new as every source → it was (re)built after the last edit → fresh,
 *      and the current hash is recorded so later runs use content. Otherwise
 *      → stale. `npm run build:wasm` does not write the hash file itself
 *      (package.json is outside this change); the first green run after a
 *      rebuild does.
 *
 * Stale exits 1 unless NULLIFY_ALLOW_STALE_WASM=1, which lets a run proceed
 * (e.g. an mtime-only skew with no hash file yet) without recording anything.
 *
 * Deliberately does NOT build the artifact itself: `npm test` should stay fast
 * and predictable, and a test command that silently invokes a Rust toolchain
 * is a surprise nobody wants mid-loop.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const WASM_DIR = join(repoRoot, 'src/shared/wasm');
const GLUE = join(WASM_DIR, 'nullify_core.js');
const ARTIFACT = join(WASM_DIR, 'nullify_core_bg.wasm');
const HASH_FILE = join(WASM_DIR, '.source-hash');
const CORE_SRC_DIR = join(repoRoot, 'wasm-core/src');
const CARGO_LOCK = join(repoRoot, 'wasm-core/Cargo.lock');

const STALE_MESSAGE =
  '\n  The WASM artifact is STALE (wasm-core source changed since it was built) — run\n\n' +
  '    npm run build:wasm\n\n' +
  '  Freshness is judged by content once src/shared/wasm/.source-hash exists\n' +
  '  (written by the first green run after a build) and by mtimes until then.\n' +
  '  A `git checkout` or rebase rewrites .rs mtimes without changing content,\n' +
  '  so if you know the artifact is current, run once with\n' +
  '  NULLIFY_ALLOW_STALE_WASM=1 to proceed anyway (nothing is recorded).\n\n';

/** The wasm-core inputs the artifact is built from, in a stable order. */
export function wasmSourceFiles() {
  const rs = readdirSync(CORE_SRC_DIR)
    .filter((f) => f.endsWith('.rs'))
    .sort()
    .map((f) => join(CORE_SRC_DIR, f));
  return [...rs, CARGO_LOCK];
}

/** sha256 over the concatenated contents of `files`, in the order given. */
export function hashSources(files) {
  const h = createHash('sha256');
  for (const f of files) h.update(readFileSync(f));
  return h.digest('hex');
}

/**
 * Decide whether `artifact` is current with respect to `sourceFiles`.
 *
 * Pure apart from the hash-file write on a fresh verdict. Returns
 *   { fresh, allowed, reason, hash, message }
 * where `allowed` is true when the run may proceed (fresh, or overridden via
 * env.NULLIFY_ALLOW_STALE_WASM=1) and `message` is set only when stale.
 */
export function checkWasmFreshness({
  sourceFiles = wasmSourceFiles(),
  artifact = ARTIFACT,
  hashFile = HASH_FILE,
  env = process.env,
} = {}) {
  const hash = hashSources(sourceFiles);
  const override = env.NULLIFY_ALLOW_STALE_WASM === '1';
  const verdict = (fresh, reason) => ({
    fresh, reason, hash,
    allowed: fresh || override,
    message: fresh ? null : STALE_MESSAGE,
  });

  const recorded = existsSync(hashFile) ? readFileSync(hashFile, 'utf8').trim() : null;
  if (recorded === hash) return verdict(true, 'hash-match');

  const artifactMtime = statSync(artifact).mtimeMs;
  const newestSource = Math.max(...sourceFiles.map((f) => statSync(f).mtimeMs));
  if (artifactMtime >= newestSource) {
    // Built after the last source edit: record what it was built from so the
    // next checkout/rebase is judged by content, not by rewritten mtimes.
    writeFileSync(hashFile, `${hash}\n`);
    return verdict(true, recorded === null ? 'mtime-fresh' : 'rebuilt');
  }
  return verdict(false, recorded === null ? 'mtime-stale' : 'hash-changed');
}
checkWasmFreshness.hashSources = hashSources;

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  if (!existsSync(GLUE) || !existsSync(ARTIFACT)) {
    process.stderr.write(
      '\n  The WASM artifact is missing, so the service-worker harness cannot load.\n\n' +
      '    npm run build:wasm\n\n' +
      '  It is a build product (gitignored), needed once per clone and again\n' +
      '  after any change under wasm-core/. `npm run setup` does it for you.\n\n',
    );
    process.exit(1);
  }

  const result = checkWasmFreshness();
  if (!result.fresh) {
    process.stderr.write(result.message);
    if (!result.allowed) process.exit(1);
    process.stderr.write('  NULLIFY_ALLOW_STALE_WASM=1 set — continuing with the stale artifact.\n\n');
  }
}
