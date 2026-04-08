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

async function main() {
  // Fire a single consolidated request to avoid messaging overhead and SW wake-up contention.
  let initRes;
  try {
    initRes = await chrome.runtime.sendMessage({ type: 'GET_INIT_DATA', payload: { hostname } });
  } catch {
    // SW not ready — proceed with defaults
  }

  const { isAllowed, settings, cosmeticRules, hasScriptlets } = initRes || {};

  if (isAllowed === true) return;

  // Only inject scriptlets bundle if we actually have scriptlets to run or fingerprinting is on.
  // This saves substantial memory and parsing time on "clean" pages.
  if (hasScriptlets || settings?.fingerprintProtection !== false) {
    injectScriptletsBundleIntoMainWorld();
  }

  // Apply cosmetic rules
  const hasProcedural = cosmeticRules?.generic?.some(r => typeof r === 'object') || 
                       cosmeticRules?.domainSpecific?.some(r => typeof r === 'object');
  const hasExceptions = cosmeticRules?.exceptions?.length > 0;
  
  if (!hasProcedural && !hasExceptions) return;

  const engine = new CosmeticEngine();
  engine.init(cosmeticRules, true);

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
 * async=true so it doesn't block HTML parsing.
 */
function injectScriptletsBundleIntoMainWorld() {
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('dist/scriptlets-world.js');
    (document.head || document.documentElement).prepend(script);
    script.addEventListener('load', () => script.remove());
  } catch {
    // Blocked by CSP or other restrictions — skip
  }
}

main().catch(() => {});
