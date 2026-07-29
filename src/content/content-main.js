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
import { resolvePageRules } from '../shared/rule-transport.js';

const hostname = normalizeHostname(location.hostname);
const FRAME_STYLE_ID = '__nullify_frame_css__';
const FRAME_EXCEPTION_STYLE_ID = '__nullify_exception_css__';
const YOUTUBE_HOSTNAMES = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

function exposeYouTubeWasmUrl() {
  if (!YOUTUBE_HOSTNAMES.has(hostname)) return;
  try {
    const root = document.documentElement;
    const getURL = chrome.runtime?.getURL?.bind(chrome.runtime);
    if (!root || typeof getURL !== 'function') return;
    root.setAttribute('data-nullify-wasm', getURL('dist/nullify_core_bg.wasm'));
  } catch {
    // MAIN-world youtube-shield falls back to its own chrome.runtime path.
  }
}

exposeYouTubeWasmUrl();

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

async function main() {
  // Fire a single consolidated request to avoid messaging overhead and SW wake-up contention.
  let initRes;
  try {
    initRes = await chrome.runtime.sendMessage({ type: 'GET_INIT_DATA', payload: { hostname } });
  } catch {
    // SW not ready — proceed with defaults
  }

  const { isAllowed, cssText, exceptionCss } = initRes || {};

  if (isAllowed === true) return;

  injectStyle(FRAME_STYLE_ID, cssText);
  injectStyle(FRAME_EXCEPTION_STYLE_ID, exceptionCss, true);

  // Prefers the base64 binary bundle, falls back to the JSON rules if it is
  // missing or undecodable — never lose procedural filtering over transport.
  const finalRules = resolvePageRules(initRes);

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

main().catch((err) => {
  // A bare swallow here hid a total loss of procedural cosmetic filtering for
  // a full release: the bundle decode threw on every page and nothing said so.
  // Report and keep going — the page must never break because of us.
  console.error('[Nullify] content script init failed:', err);
  try {
    chrome.runtime.sendMessage({
      type: 'REPORT_CONTENT_ERROR',
      payload: { hostname, message: err?.message || String(err) },
    });
  } catch { /* SW asleep or context invalidated */ }
});
