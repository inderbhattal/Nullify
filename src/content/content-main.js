/**
 * content-main.js
 *
 * Content script entry point — runs at document_start on all pages.
 *
 * Responsibilities:
 *  1. Determine if this page is in the allowlist (skip if so)
 *  2. Ask background for cosmetic rules and apply them via CosmeticEngine
 *  3. Let the background own MAIN-world scriptlet injection
 */

import { CosmeticEngine } from './cosmetic-engine.js';
import { activatePicker, deactivatePicker } from './element-picker.js';
import { normalizeHostname } from '../shared/hostname.js';

const hostname = normalizeHostname(location.hostname);

/**
 * Fast binary decoder for ruleset data.
 * @param {Uint8Array} buffer
 */
function decodeBinaryRules(buffer) {
  const rules = { generic: [], domainSpecific: [], exceptions: [] };
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 0;
  const decoder = new TextDecoder();

  const decodeRuleEntry = (text) => {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) return text;
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  };

  const readStringList = () => {
    if (offset + 4 > buffer.byteLength) return [];
    const count = view.getUint32(offset, true);
    offset += 4;
    const list = [];
    
    for (let i = 0; i < count; i++) {
      let start = offset;
      while (offset < buffer.byteLength && buffer[offset] !== 0) {
        offset++;
      }
      list.push(decodeRuleEntry(decoder.decode(buffer.slice(start, offset))));
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
  // 0. Provide the WASM URL fallback to the MAIN-world YouTube shield.
  const isYouTube = hostname.includes('youtube.com');
  if (isYouTube) {
    try {
      const wasmUrl = chrome.runtime.getURL('dist/nullify_core_bg.wasm');
      document.documentElement.setAttribute('data-nullify-wasm', wasmUrl);
    } catch {
      // Ignore if runtime URL resolution is unavailable here
    }
  }

  // Fire a single consolidated request to avoid messaging overhead and SW wake-up contention.
  let initRes;
  try {
    initRes = await chrome.runtime.sendMessage({ type: 'GET_INIT_DATA', payload: { hostname } });
  } catch {
    // SW not ready — proceed with defaults
  }

  const {
    isAllowed,
    cosmeticRules,
    cosmeticRulesBinary,
  } = initRes || {};

  if (isAllowed === true) return;

  // Use binary rules if available, otherwise fallback to JSON
  const finalRules = cosmeticRulesBinary 
    ? decodeBinaryRules(cosmeticRulesBinary)
    : cosmeticRules;

  // Apply cosmetic rules
  const hasProcedural = finalRules?.generic?.some(r => typeof r === 'object' || (typeof r === 'string' && r.includes(':'))) || 
                       finalRules?.domainSpecific?.some(r => typeof r === 'object' || (typeof r === 'string' && r.includes(':')));
  const hasExceptions = finalRules?.exceptions?.length > 0;
  
  if (!hasProcedural && !hasExceptions) return;

  const engine = new CosmeticEngine();
  engine.init(finalRules, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      engine._applyAllProcedural?.();
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

main().catch(() => {});
