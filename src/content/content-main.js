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
const WASM_ATTR = 'data-nullify-wasm';
const YOUTUBE_HOSTNAMES = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

// Retained so the observer and its 5-minute interval can be torn down when the
// document goes away — `stopObserver()` previously had no production caller
// because the engine was a local of `main()` (§5.19).
let engine = null;

/**
 * Hand the MAIN-world YouTube shield a URL for the WASM binary, which it
 * cannot build itself (`chrome.runtime.getURL` is not reliably available
 * there).
 *
 * The attribute publishes the extension ID to page script, so it is written
 * only once the page is known *not* to be allowlisted, and only for as long as
 * the shield needs to read it (§4.13). The shield reads it synchronously at
 * document_start and otherwise picks it up through a MutationObserver on
 * `documentElement`; observer callbacks are delivered as microtasks, so by the
 * next macrotask the URL has been captured and the attribute can go.
 */
function exposeYouTubeWasmUrl() {
  if (!YOUTUBE_HOSTNAMES.has(hostname)) return;
  try {
    const root = document.documentElement;
    const getURL = chrome.runtime?.getURL?.bind(chrome.runtime);
    if (!root || typeof getURL !== 'function') return;
    root.setAttribute(WASM_ATTR, getURL('dist/nullify_core_bg.wasm'));
    setTimeout(() => {
      try { root.removeAttribute(WASM_ATTR); } catch { /* document torn down */ }
    }, 0);
  } catch {
    // MAIN-world youtube-shield falls back to its own chrome.runtime path.
  }
}

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

  // The message bus resolves with `{error: …}` rather than rejecting, so a
  // failed GET_INIT_DATA looked exactly like a healthy "nothing to do" reply:
  // no CSS, no procedural rules, no exceptions, and nothing reported (§4.11).
  if (initRes?.error) {
    throw new Error(`GET_INIT_DATA failed: ${initRes.error}`);
  }

  const { isAllowed, cssText, exceptionCss } = initRes || {};

  if (isAllowed === true) return;

  // Only now is the page known not to be allowlisted (§4.13).
  exposeYouTubeWasmUrl();

  injectStyle(FRAME_STYLE_ID, cssText);
  injectStyle(FRAME_EXCEPTION_STYLE_ID, exceptionCss, true);

  // Prefers the base64 binary bundle, falls back to the JSON rules if it is
  // missing or undecodable — never lose procedural filtering over transport.
  const finalRules = resolvePageRules(initRes);

  // Apply cosmetic rules. `semantic` belongs in this list: without it a
  // string-form `div:semantic(x)` rule never constructs the engine (§5.20).
  const PROC_TOKEN_REGEX = /:(?:has-text|upward|matches-css|matches-css-before|matches-css-after|matches-attr|matches-path|has|xpath|min-text-length|watch-attr|remove|if|if-not|nth-ancestor|style|semantic)\(/;
  const isProceduralRule = (r) => typeof r === 'object' || (typeof r === 'string' && PROC_TOKEN_REGEX.test(r));
  const hasProcedural = finalRules?.generic?.some(isProceduralRule) ||
                       finalRules?.domainSpecific?.some(isProceduralRule);
  const hasExceptions = finalRules?.exceptions?.length > 0;
  
  if (!hasProcedural && !hasExceptions) return;

  engine = new CosmeticEngine();
  engine.init(finalRules, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      // Route through the scheduler, not straight at `_applyAllProcedural`:
      // the debounced path swaps the dirty-roots snapshot first, so the re-run
      // sees everything the parser added since init instead of evaluating
      // against a stale (empty) snapshot and caching those verdicts (§3.3).
      engine?._scheduleProceduralRun?.();
    });
  }

  // The observer and its 5-minute sweep interval outlive the page otherwise
  // (§5.19). A bfcache-persisted document can come back, so only tear down
  // when it is really going away.
  window.addEventListener('pagehide', (event) => {
    if (!event?.persisted) engine?.stopObserver?.();
  });
}

// ---- Listen for picker activation from popup ----
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'ACTIVATE_PICKER') {
    // Senders target `{frameId: 0}`; `allowInFrame` is the explicit opt-in for
    // a deliberately frame-scoped activation. Without it the picker refuses to
    // mount in subframes, where a broadcast used to leave one undismissable
    // overlay per iframe (§4.24).
    activatePicker({ allowInFrame: message.allowInFrame === true });
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
