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
  // Fire all independent SW requests in parallel to avoid sequential round-trip delay.
  // A cold SW wake-up can take 300-700ms per message — serializing them causes 1-3s freezes.
  let isAllowedRes, settingsRes, cosmeticRes;
  try {
    [isAllowedRes, settingsRes, cosmeticRes] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'IS_SITE_ALLOWED', payload: { domain: hostname } }),
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }),
      chrome.runtime.sendMessage({ type: 'GET_COSMETIC_RULES', payload: { hostname } }),
    ]);
  } catch {
    // SW not ready — proceed with no rules
  }

  if (isAllowedRes?.allowed === true) return;

  // Inject scriptlets bundle asynchronously — page-intercepting scriptlets are
  // injected by the SW via chrome.scripting.executeScript (MAIN world), which is
  // independent of this bundle. async=false was blocking HTML parsing for ~200ms.
  injectScriptletsBundleIntoMainWorld();

  // Request scriptlet injection from SW (fire-and-forget, non-blocking)
  const scriptlets = [];
  if (settingsRes?.fingerprintProtection !== false) {
    scriptlets.push({ name: 'fingerprint-noise', args: [] });
    scriptlets.push({ name: 'battery-spoof', args: [] });
  }

  const scriptletMessages = [
    chrome.runtime.sendMessage({ type: 'GET_SCRIPTLET_RULES', payload: { hostname } }),
  ];
  if (scriptlets.length > 0) {
    scriptletMessages.push(
      chrome.runtime.sendMessage({ type: 'RUN_SCRIPTLETS', payload: { scriptlets } })
    );
  }
  // Don't await — scriptlet injection is handled by SW in MAIN world independently
  Promise.all(scriptletMessages).catch(() => {});

  // Apply cosmetic rules
  const cosmeticRules = cosmeticRes;
  const hasDomainRules = cosmeticRules?.domainSpecific?.length > 0;
  const hasExceptions = cosmeticRules?.exceptions?.length > 0;
  const hasUserRules = cosmeticRules?.generic?.length > 0;

  if (!hasDomainRules && !hasExceptions && !hasUserRules) return;

  const engine = new CosmeticEngine();
  // proceduralOnly=true since SW already injected static CSS via insertCSS
  engine.init(cosmeticRules, true);

  // Re-apply procedural rules after DOM is fully built
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
