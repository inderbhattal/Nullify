import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
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
