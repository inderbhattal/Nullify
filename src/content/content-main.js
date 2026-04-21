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
const FRAME_STYLE_ID = '__nullify_frame_css__';
const FRAME_EXCEPTION_STYLE_ID = '__nullify_exception_css__';

function injectStyle(id, cssText, append = false) {
  if (!cssText) return;

  const existing = document.getElementById(id);
  if (existing) existing.remove();

  const style = document.createElement('style');
  style.id = id;
  style.textContent = cssText;

  const parent = document.head || document.documentElement;
  if (!parent) return;

  if (append) parent.appendChild(style);
  else parent.prepend(style);
}

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
    cssText,
    exceptionCss,
    genericProceduralRules,
  } = initRes || {};

  if (isAllowed === true) return;

  injectStyle(FRAME_STYLE_ID, cssText);
  injectStyle(FRAME_EXCEPTION_STYLE_ID, exceptionCss, true);

  // Use binary rules if available, otherwise fallback to JSON
  const pageRules = cosmeticRulesBinary 
    ? decodeBinaryRules(cosmeticRulesBinary)
    : cosmeticRules;
  const finalRules = {
    generic: pageRules?.generic || [],
    domainSpecific: [
      ...(Array.isArray(genericProceduralRules) ? genericProceduralRules : []),
      ...(pageRules?.domainSpecific || []),
    ],
    exceptions: pageRules?.exceptions || [],
  };

  // Apply cosmetic rules
  const PROC_TOKEN_REGEX = /:(?:has-text|upward|matches-css|matches-css-before|matches-css-after|matches-attr|matches-path|has|xpath|min-text-length|watch-attr|remove|if|if-not|nth-ancestor|style)\(/;
  const isProceduralRule = (r) => typeof r === 'object' || (typeof r === 'string' && PROC_TOKEN_REGEX.test(r));
  const hasProcedural = finalRules?.generic?.some(isProceduralRule) ||
                       finalRules?.domainSpecific?.some(isProceduralRule);
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
