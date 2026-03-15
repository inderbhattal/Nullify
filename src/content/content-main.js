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
  // Check if this site is allowed (blocking disabled)
  let isAllowed = false;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'IS_SITE_ALLOWED',
      payload: { domain: hostname },
    });
    isAllowed = res?.allowed === true;
  } catch {
    // SW not ready yet — proceed anyway
  }

  if (isAllowed) return;

  // ---- Inject scriptlets bundle into MAIN world ASAP ----
  // This ensures window.__adblockScriptlets is defined before the SW
  // injects specific scriptlet calls.
  injectScriptletsBundleIntoMainWorld();

  // ---- Request scriptlets for this page ----
  // SW handles actual injection via chrome.scripting.executeScript(MAIN world)
  try {
    const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    const scriptlets = [];
    
    if (settings.fingerprintProtection !== false) {
      scriptlets.push({ name: 'fingerprint-noise', args: [] });
      scriptlets.push({ name: 'battery-spoof', args: [] });
    }

    await chrome.runtime.sendMessage({
      type: 'GET_SCRIPTLET_RULES',
      payload: { hostname },
    });

    // If we have additional privacy scriptlets, run them
    if (scriptlets.length > 0) {
      await chrome.runtime.sendMessage({
        type: 'RUN_SCRIPTLETS',
        payload: { scriptlets }
      });
    }
  } catch {
    // SW might not be ready
  }

  // ---- Request cosmetic rules and apply ----
  let cosmeticRules = null;
  try {
    cosmeticRules = await chrome.runtime.sendMessage({
      type: 'GET_COSMETIC_RULES',
      payload: { hostname },
    });
  } catch {
    // SW not ready
  }

  // Skip engine initialization if there are no site-specific rules or exceptions.
  // Note: Generic rules are now handled by the SW via insertCSS.
  const hasDomainRules = cosmeticRules?.domainSpecific && cosmeticRules.domainSpecific.length > 0;
  const hasExceptions = cosmeticRules?.exceptions && cosmeticRules.exceptions.length > 0;
  const hasUserRules = cosmeticRules?.generic && cosmeticRules.generic.length > 0;

  if (!hasDomainRules && !hasExceptions && !hasUserRules) {
    console.log('[AdBlock] No site-specific cosmetic rules, skipping engine init.');
    return;
  }

  const engine = new CosmeticEngine();
  engine.init(cosmeticRules);

  // ---- Apply again after DOM is ready (for early-injected scripts) ----
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
 * This is the fastest approach — runs synchronously before page JS.
 */
function injectScriptletsBundleIntoMainWorld() {
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('dist/scriptlets-world.js');
    // Must be synchronous to intercept page scripts
    script.async = false;
    (document.head || document.documentElement).prepend(script);
    // Remove after execution to avoid detection
    script.addEventListener('load', () => script.remove());
  } catch {
    // Blocked by CSP or other restrictions — skip
  }
}

main().catch(() => {});
