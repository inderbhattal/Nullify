import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

// ---------------------------------------------------------------------------
// manifest.json — extension_pages CSP (§4.13)
// ---------------------------------------------------------------------------

test('extension_pages CSP includes default-src self', () => {
  const manifest = readJson('manifest.json');
  const csp = manifest.content_security_policy?.extension_pages || '';
  // Without default-src, img-src/style-src/frame-src are unrestricted: an
  // injected <style> with attribute selectors can exfiltrate options-page
  // data to a remote host even though script-src blocks script execution.
  assert.match(csp, /(^|;)\s*default-src 'self'/, csp);
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
});

// ---------------------------------------------------------------------------
// rules/system-unbreak.json — gstatic scoping (§5.49)
// ---------------------------------------------------------------------------

test('the gstatic allow is scoped, not a blanket domain allow', () => {
  const rules = readJson('rules/system-unbreak.json');
  const gstaticRules = rules.filter((r) =>
    (r.condition?.urlFilter || '').includes('gstatic.com'));
  assert.ok(gstaticRules.length > 0, 'gstatic unbreak rules must exist');

  for (const rule of gstaticRules) {
    const uf = rule.condition.urlFilter;
    if (uf === '||gstatic.com^') {
      // The blanket form is only acceptable when limited to the resource
      // types sites break without. An unscoped allow at priority 1000
      // permanently defeated EasyPrivacy's gstatic telemetry blocks
      // (csi.gstatic.com, /gen_204).
      const types = rule.condition.resourceTypes || [];
      assert.ok(types.length > 0, '||gstatic.com^ must declare resourceTypes');
      const allowed = new Set(['font', 'stylesheet', 'script']);
      for (const t of types) {
        assert.ok(allowed.has(t), `||gstatic.com^ must not allow resource type ${t}`);
      }
    } else {
      assert.ok(
        uf.includes('/recaptcha/'),
        `unexpected gstatic rule shape: ${uf}`,
      );
    }
  }
});

test('system-unbreak rule ids are unique', () => {
  const rules = readJson('rules/system-unbreak.json');
  const ids = rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ---------------------------------------------------------------------------
// webpack.config.js — splitChunks must exclude content scripts (§5.51)
// ---------------------------------------------------------------------------

test('splitChunks excludes every bundle that cannot load a shared chunk', async () => {
  const { default: config } = await import('../webpack.config.js');
  const chunksFn = config.optimization?.splitChunks?.chunks;
  assert.equal(typeof chunksFn, 'function');

  // No chunk-loading runtime exists in the SW, content scripts, or the
  // MAIN-world scriptlets bundle — a shared chunk would fail at load.
  for (const name of ['service-worker', 'scriptlets-world', 'content', 'youtube-shield']) {
    assert.equal(chunksFn({ name }), false, `${name} must not be split`);
  }
  // Extension pages have a document and can load shared chunks.
  for (const name of ['popup', 'options']) {
    assert.equal(chunksFn({ name }), true, `${name} may share chunks`);
  }
});

// ---------------------------------------------------------------------------
// Workflows — every action pinned to a commit SHA (§5.40)
// ---------------------------------------------------------------------------

test('all workflow actions are pinned to full commit SHAs', () => {
  const workflowDir = path.join(ROOT, '.github', 'workflows');
  for (const file of fs.readdirSync(workflowDir)) {
    if (!/\.ya?ml$/.test(file)) continue;
    const text = fs.readFileSync(path.join(workflowDir, file), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(?:-\s+)?uses:\s*(\S+)/);
      if (!m) continue;
      assert.match(
        m[1],
        /@[0-9a-f]{40}$/,
        `${file}: "${m[1]}" must be pinned to a 40-char commit SHA`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Priority bands: the user allowlist must outrank every shipped rule (§4.5)
// ---------------------------------------------------------------------------

test('no static rule outranks the runtime allowlist unless it is an allow', async () => {
  // The runtime `allowAllRequests` sits at 100000. A static BLOCK at or above
  // that silently overrides "trust this site" — which is how four
  // system-unbreak blocks at 1100 beat the old 500 allowlist and kept
  // datadome.co blocked on allowlisted sites, with no user-level escape.
  const { assertStaticRulePriorityBands } = await import('../scripts/build-rules.mjs');
  assertStaticRulePriorityBands();
});

test('the band assertion rejects a static block that would outrank the allowlist', async () => {
  const {
    assertStaticRulePriorityBands,
    RUNTIME_ALLOWLIST_PRIORITY,
  } = await import('../scripts/build-rules.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nullify-bands-'));
  try {
    fs.writeFileSync(path.join(dir, 'system-unbreak.json'), JSON.stringify([
      {
        id: 1,
        priority: RUNTIME_ALLOWLIST_PRIORITY,
        condition: { urlFilter: '||tracker.example^' },
        action: { type: 'block' },
      },
    ]));
    assert.throws(() => assertStaticRulePriorityBands(dir), /would override the user allowlist/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('system-unbreak priorities stay inside the documented band', async () => {
  const {
    SYSTEM_UNBREAK_PRIORITY,
    SYSTEM_UNBREAK_OVERRIDE_PRIORITY,
  } = await import('../scripts/build-rules.mjs');
  const rules = readJson('rules/system-unbreak.json');
  const baseAllows = rules.filter((r) =>
    r.priority === SYSTEM_UNBREAK_PRIORITY && r.action?.type === 'allow');

  for (const rule of rules) {
    assert.ok(
      rule.priority === SYSTEM_UNBREAK_PRIORITY || rule.priority === SYSTEM_UNBREAK_OVERRIDE_PRIORITY,
      `rule ${rule.id}: priority ${rule.priority} is outside the documented band`,
    );
    if (rule.priority !== SYSTEM_UNBREAK_OVERRIDE_PRIORITY) continue;
    // The override slot exists for exactly one shape: a block that has to beat
    // a co-matching allow in this same file (youtubei/v1/ad_break inside the
    // youtubei/v1/* allow). Anything else there is an unexplained magic number.
    const covered = baseAllows.some((allow) =>
      rule.condition.urlFilter.startsWith((allow.condition.urlFilter || '').replace(/\*+$/, '')));
    assert.ok(
      covered,
      `rule ${rule.id} (${rule.condition.urlFilter}) sits at ${SYSTEM_UNBREAK_OVERRIDE_PRIORITY} but overrides no allow`,
    );
  }
});

// ---------------------------------------------------------------------------
// Any job that runs the JS suite must build the WASM artifact first.
// src/shared/wasm/ is gitignored and service-worker.js imports its glue
// statically, so without it the whole sw-harness suite dies at pretest. This
// was fixed in test.yml and missed in build.yml's verify job, which failed the
// same way on the next release run — artifacts do not carry between jobs, so
// every such job needs its own build step, in the right order.
test('every workflow job that runs the tests builds the WASM artifact first', () => {
  const workflowDir = path.join(ROOT, '.github', 'workflows');
  let jobsChecked = 0;

  for (const file of fs.readdirSync(workflowDir)) {
    if (!/\.ya?ml$/.test(file)) continue;
    const text = fs.readFileSync(path.join(workflowDir, file), 'utf8');

    // Split on two-space-indented job keys; enough structure for this check
    // without taking on a YAML parser.
    for (const job of text.split(/\n {2}(?=[A-Za-z0-9_-]+:\n)/)) {
      const name = (job.match(/^\s*([A-Za-z0-9_-]+):/) || [])[1] ?? '?';
      const testIdx = job.search(/run:\s*npm (?:test|run check)\b/);
      if (testIdx === -1) continue;

      jobsChecked++;
      const wasmIdx = job.search(/run:\s*npm run build:wasm\b/);
      assert.notEqual(wasmIdx, -1,
        `${file} job "${name}" runs the tests without building the WASM artifact`);
      assert.ok(wasmIdx < testIdx,
        `${file} job "${name}" builds the WASM artifact after running the tests`);
    }
  }

  assert.ok(jobsChecked >= 2, `expected to find the test jobs, checked ${jobsChecked}`);
});

// Release workflow: tag names are data, not shell (§5.28)
// ---------------------------------------------------------------------------

test('no workflow interpolates attacker-controllable context into a run: block', () => {
  // `git check-ref-format 'refs/tags/v4.3.0$(id)'` exits 0, so a tag name can
  // carry `$(…)` or `${IFS}` and would execute inside the contents:write job.
  // The fix is an `env:` entry plus a quoted "$TAG".
  const injectable = /\$\{\{\s*(github\.(ref_name|ref|head_ref|event\b)|inputs\.)/;
  const workflowDir = path.join(ROOT, '.github', 'workflows');
  for (const file of fs.readdirSync(workflowDir)) {
    if (!/\.ya?ml$/.test(file)) continue;
    const lines = fs.readFileSync(path.join(workflowDir, file), 'utf8').split('\n');
    let runIndent = null;
    for (const line of lines) {
      if (runIndent !== null) {
        const indent = line.search(/\S/);
        if (line.trim() !== '' && indent <= runIndent) runIndent = null;
      }
      const runMatch = line.match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
      if (runMatch) {
        assert.doesNotMatch(runMatch[2], injectable, `${file}: run: interpolates a tag/ref — pass it via env:`);
        runIndent = runMatch[1].length;
        continue;
      }
      if (runIndent === null) continue;
      assert.doesNotMatch(
        line,
        injectable,
        `${file}: run: block interpolates a tag/ref — pass it via env: and quote "$TAG"`,
      );
    }
  }
});

test('the release build compiles rules offline from committed snapshots', () => {
  // Every tag build used to recompile from eight live upstreams, so the
  // release window was however long it took the first list to rotate.
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8');
  assert.match(workflow, /npm run build:rules/);
  assert.doesNotMatch(
    workflow,
    /^\s*run:.*refresh:lists/m,
    'fetching upstream during a release re-introduces the rotation race',
  );
});

// ---------------------------------------------------------------------------
// WASM web-accessible resource carries a per-session URL (§4.13)
// ---------------------------------------------------------------------------

test('the WASM blob is exposed through a dynamic, per-session URL', () => {
  // exposeYouTubeWasmUrl() publishes this URL into every YouTube page before
  // the allowlist is even known. Without use_dynamic_url it is
  // chrome-extension://<stable-extension-id>/… — a one-line fingerprint.
  const manifest = readJson('manifest.json');
  const entries = manifest.web_accessible_resources || [];
  const wasmEntries = entries.filter((e) =>
    (e.resources || []).some((r) => r.endsWith('nullify_core_bg.wasm')));
  assert.equal(wasmEntries.length, 1, 'the wasm blob must be declared exactly once');
  assert.equal(wasmEntries[0].use_dynamic_url, true);
  assert.deepEqual(wasmEntries[0].matches, ['<all_urls>']);
});

test('all three engines agree on the runtime allowlist band', async () => {
  // Three files have to agree for §4.5 to stay fixed: both allowlist rule
  // builders pick the priority they write on `allowAllRequests`, and the build
  // refuses to ship any static rule at or above it. Nothing else compares
  // them — the last time a band was documented in one file and implemented in
  // another, four system-unbreak blocks quietly outranked the user allowlist
  // and `datadome.co` stayed blocked on sites the user had explicitly trusted.
  const { RUNTIME_ALLOWLIST_PRIORITY } = await import('../scripts/build-rules.mjs');

  const seams = [
    ['src/background/service-worker.js', /const DNR_ALLOWLIST_PRIORITY\s*=\s*([\d_]+)/],
    ['wasm-core/src/lib.rs', /const DNR_ALLOWLIST_PRIORITY:\s*u32\s*=\s*([\d_]+)/],
  ];
  for (const [file, pattern] of seams) {
    const match = fs.readFileSync(path.join(ROOT, file), 'utf8').match(pattern);
    assert.ok(match, `${file} must define DNR_ALLOWLIST_PRIORITY`);
    assert.equal(
      Number(match[1].replace(/_/g, '')),
      RUNTIME_ALLOWLIST_PRIORITY,
      `${file} and scripts/build-rules.mjs RUNTIME_ALLOWLIST_PRIORITY must be the same number`,
    );
  }
});
