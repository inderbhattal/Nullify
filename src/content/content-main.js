/**
 * content-main.js
 *
 * Content script entry point — runs at document_start on all pages.
 *
 * Responsibilities:
 *  1. Determine if this page is in the allowlist (skip if so)
 *  2. Ask background for cosmetic rules and apply them via CosmeticEngine
 *  3. Ask background to inject scriptlets for this page (MAIN world injection)
 *  4. Inject the scriptlets-world.js bundle into the page MAIN world
 */

import { CosmeticEngine } from './cosmetic-engine.js';
import { activatePicker, deactivatePicker } from './element-picker.js';

const hostname = location.hostname.replace(/^www\./, '');

/**
 * Fast binary decoder for ruleset data.
 * @param {Uint8Array} buffer
 */
function decodeBinaryRules(buffer) {
  const rules = { generic: [], domainSpecific: [], exceptions: [] };
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 0;

  const readStringList = () => {
    if (offset + 4 > buffer.byteLength) return [];
    const count = view.getUint32(offset, true);
    offset += 4;
    const list = [];
    const decoder = new TextDecoder();
    
    for (let i = 0; i < count; i++) {
      let start = offset;
      while (offset < buffer.byteLength && buffer[offset] !== 0) {
        offset++;
      }
      list.push(decoder.decode(buffer.slice(start, offset)));
      offset++; // skip null
    }
    return list;
  };

  rules.generic = readStringList();
  rules.domainSpecific = readStringList();
  rules.exceptions = readStringList();
  return rules;
}

async function main() {
  // 0. Handle YouTube-specific initialization (always active)
  if (hostname.includes('youtube.com')) {
    try {
      const wasmUrl = chrome.runtime.getURL('dist/nullify_core_bg.wasm');
      document.documentElement.setAttribute('data-nullify-yt', '1');
      document.documentElement.setAttribute('data-nullify-wasm', wasmUrl);
    } catch {
      // Background worker may not be ready yet
    }
  }

  // Fire a single consolidated request to avoid messaging overhead and SW wake-up contention.
  let initRes;
  try {
    initRes = await chrome.runtime.sendMessage({ type: 'GET_INIT_DATA', payload: { hostname } });
  } catch {
    // SW not ready — proceed with defaults
  }

  const { isAllowed, settings, cosmeticRules, cosmeticRulesBinary, hasScriptlets } = initRes || {};

  if (isAllowed === true) return;

  // Use binary rules if available, otherwise fallback to JSON
  const finalRules = cosmeticRulesBinary 
    ? decodeBinaryRules(cosmeticRulesBinary)
    : cosmeticRules;

  // Only inject scriptlets bundle if we actually have scriptlets to run or fingerprinting is on.
  // This saves substantial memory and parsing time on "clean" pages.
  if (hasScriptlets || settings?.fingerprintProtection !== false) {
    injectScriptletsBundleIntoMainWorld();
  }

  // Apply cosmetic rules
  const hasProcedural = finalRules?.generic?.some(r => typeof r === 'object' || (typeof r === 'string' && r.includes(':'))) || 
                       finalRules?.domainSpecific?.some(r => typeof r === 'object' || (typeof r === 'string' && r.includes(':')));
  const hasExceptions = finalRules?.exceptions?.length > 0;
  
  if (!hasProcedural && !hasExceptions) return;

  const engine = new CosmeticEngine();
  engine.init(finalRules, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      engine._applyProceduralRules?.();
    });
  }
}

// ---- Listen for picker activation from popup ----
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'ACTIVATE_PICKER') {
    activatePicker();
  } else if (message.type === 'DEACTIVATE_PICKER') {
    deactivatePicker();
  }
});

/**
 * Inject the scriptlets MAIN-world bundle via a <script> tag.
 */
function injectScriptletsBundleIntoMainWorld() {
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('dist/scriptlets-world.js');
    (document.head || document.documentElement).appendChild(script);
    script.addEventListener('load', () => script.remove());
  } catch {
    // Blocked by CSP or other restrictions — skip
  }
}

main().catch(() => {});
