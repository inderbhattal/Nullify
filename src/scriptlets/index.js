/**
 * scriptlets/index.js
 *
 * Registry and executor for all bundled scriptlets.
 * This module runs in the MAIN world of the page.
 *
 * Usage (injected by service worker):
 *   window.__adblockScriptlets.run('abort-on-property-read', ['_sp_'])
 */

import { abortOnPropertyRead } from './abort-on-property-read.js';
import { abortOnPropertyWrite } from './abort-on-property-write.js';
import { setConstant } from './set-constant.js';
import { abortCurrentInlineScript } from './abort-current-inline-script.js';
import { jsonPrune } from './json-prune.js';
import { preventFetch } from './prevent-fetch.js';
import { preventXhr } from './prevent-xhr.js';
import { removeAttr } from './remove-attr.js';
import { addClass } from './add-class.js';
import { removeClass } from './remove-class.js';
import { noeval } from './noeval.js';
import { noSetTimeout } from './no-set-timeout-if.js';
import { noSetInterval } from './no-set-interval-if.js';
import { preventAddEventListener } from './prevent-add-event-listener.js';
import { setCookie } from './set-cookie.js';
import { setCookiePath } from './set-cookie-reload.js';
import { removeCookie } from './remove-cookie.js';
import { disableNewtabLinks } from './disable-newtab-links.js';
import { adjustSetTimeout } from './adjust-set-timeout.js';
import { adjustSetInterval } from './adjust-set-interval.js';
import { noWindowOpenIf } from './no-window-open-if.js';
import { preventWindowOpen } from './prevent-window-open.js';
import { setLocalStorageItem } from './set-local-storage-item.js';
import { setSessionStorageItem } from './set-session-storage-item.js';
import { abortOnStackTrace } from './abort-on-stack-trace.js';
import { noXhrIf } from './no-xhr-if.js';
import { noFetchIf } from './no-fetch-if.js';
import { objectPrune } from './object-prune.js';
import { trustedSetConstant } from './trusted-set-constant.js';
import { spoofCss } from './spoof-css.js';
import { trustedReplaceFetchResponse, trustedReplaceXhrResponse } from './trusted-replace-fetch-response.js';
import { trustedClickElement } from './trusted-click-element.js';
import { m3uPrune } from './m3u-prune.js';
import { hideWindowError } from './hide-window-error.js';
import { fingerprintNoise } from './fingerprint-noise.js';
import { batterySpoof } from './battery-spoof.js';

// ---------------------------------------------------------------------------
// Registry — maps scriptlet name (and aliases) to implementation
// ---------------------------------------------------------------------------
const REGISTRY = new Map([
  // Core property interceptors
  ['abort-on-property-read', abortOnPropertyRead],
  ['aopr', abortOnPropertyRead],
  ['abort-on-property-write', abortOnPropertyWrite],
  ['aopw', abortOnPropertyWrite],
  ['set-constant', setConstant],
  ['sc', setConstant],
  ['set', setConstant], // alias
  ['abort-current-inline-script', abortCurrentInlineScript],
  ['acis', abortCurrentInlineScript],
  ['abort-on-stack-trace', abortOnStackTrace],
  ['aost', abortOnStackTrace],

  // JSON/Object manipulation
  ['json-prune', jsonPrune],
  ['json-prune-fetch-response', jsonPrune],
  ['object-prune', objectPrune],

  // Network interception
  ['prevent-fetch', preventFetch],
  ['no-fetch-if', noFetchIf],
  ['prevent-xhr', preventXhr],
  ['no-xhr-if', noXhrIf],
  ['m3u-prune', m3uPrune],

  // DOM manipulation
  ['remove-attr', removeAttr],
  ['ra', removeAttr],
  ['add-class', addClass],
  ['ac', addClass],
  ['remove-class', removeClass],
  ['rc', removeClass],

  // Timer/Event manipulation
  ['noeval', noeval],
  ['no-eval', noeval],
  ['no-set-timeout-if', noSetTimeout],
  ['nostif', noSetTimeout],
  ['no-set-interval-if', noSetInterval],
  ['nosiif', noSetInterval],
  ['prevent-addEventListener', preventAddEventListener],
  ['aeld', preventAddEventListener], // alias
  ['addeventlistener-logger', preventAddEventListener],
  ['adjust-set-timeout', adjustSetTimeout],
  ['ast', adjustSetTimeout],
  ['adjust-set-interval', adjustSetInterval],
  ['asi', adjustSetInterval],

  // Cookie manipulation
  ['set-cookie', setCookie],
  ['set-cookie-reload', setCookiePath],
  ['remove-cookie', removeCookie],

  // Storage manipulation
  ['set-local-storage-item', setLocalStorageItem],
  ['set-lsi', setLocalStorageItem],
  ['set-session-storage-item', setSessionStorageItem],
  ['set-ssi', setSessionStorageItem],

  // Popup/window blocking
  ['no-window-open-if', noWindowOpenIf],
  ['prevent-window-open', preventWindowOpen],
  ['pwo', preventWindowOpen],
  ['disable-newtab-links', disableNewtabLinks],

  // Trusted (privileged) variants
  ['trusted-set-constant', trustedSetConstant],
  ['tsc', trustedSetConstant],
  ['trusted-set', trustedSetConstant], // alias
  ['trusted-click-element', trustedClickElement],
  ['tce', trustedClickElement],

  // Anti-adblock / CSS spoofing
  ['spoof-css', spoofCss],
  ['trusted-replace-fetch-response', trustedReplaceFetchResponse],
  ['trfr', trustedReplaceFetchResponse],
  ['trusted-replace-xhr-response', trustedReplaceXhrResponse],
  ['trxr', trustedReplaceXhrResponse],
  ['hide-window-error', hideWindowError],
  ['hwe', hideWindowError],
  ['fingerprint-noise', fingerprintNoise],
  ['fpn', fingerprintNoise],
  ['battery-spoof', batterySpoof],
  ['bs', batterySpoof],
]);

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------
const executed = new Set();

function run(name, args = []) {
  const fn = REGISTRY.get(name);
  if (!fn) {
    // Unknown scriptlet — skip silently
    return;
  }

  // Prevent double-execution of the same scriptlet with same args
  const key = `${name}|${JSON.stringify(args)}`;
  if (executed.has(key)) return;
  executed.add(key);

  try {
    fn(...args);
  } catch {
    // Scriptlet errors must not crash the page
  }
}

// ---------------------------------------------------------------------------
// Auto-Shield — Early activation for critical sites
// ---------------------------------------------------------------------------
function activateShields() {
  const isYT = document.documentElement.hasAttribute('data-nullify-yt');
  if (isYT) {
    // 1. Instant variable protection
    run('set-constant', ['yt.config_.ADS_DATA', 'undefined']);
    run('set-constant', ['ytInitialPlayerResponse.adPlacements', 'undefined']);
    run('set-constant', ['playerResponse.adPlacements', 'undefined']);
    
    // 2. High-speed network interception (broadened)
    run('trusted-replace-fetch-response', ['/youtubei/v1/player', '"adPlacements"', '"no_ads"']);
    run('trusted-replace-xhr-response', ['/youtubei/v1/player', '"adPlacements"', '"no_ads"']);
    run('trusted-replace-fetch-response', ['/youtubei/v1/get_watch', '"adPlacements"', '"no_ads"']);
    
    // 2.5. 'Poison' any ad-heartbeat or ad-related metadata requests
    run('prevent-fetch', ['/youtubei/v1/ad_break']);
    run('prevent-xhr', ['/youtubei/v1/ad_break']);
    run('prevent-fetch', ['/youtubei/v1/att/get_attestation']); // also prevents ad-attestation checks
    run('prevent-xhr', ['/youtubei/v1/att/get_attestation']);
    
    // 2.6. Brute-force JSON pruning for ad-related keys
    run('json-prune', ['playerResponse.adPlacements playerResponse.playerAds playerResponse.adSlots adPlacements playerAds adSlots adClientParams']);

    
    // 3. Fail-safe skipper
    run('youtube-ad-skipper', []);

    // 4. Handle SPA Navigations (YouTube doesn't reload page)
    window.addEventListener('yt-navigate-start', () => {
      run('set-constant', ['ytInitialPlayerResponse.adPlacements', 'undefined']);
    });
  }
}

// ---------------------------------------------------------------------------
// Public API — attached to window so MAIN-world injection can call it
// ---------------------------------------------------------------------------
// Use a less predictable property name to make extension detection harder.
const REGISTRY_NAME = '__nu' + Math.random().toString(36).slice(2, 8);
window[REGISTRY_NAME] = { run };

// Activate shields immediately upon bundle execution
activateShields();

// Export the name so it can be used by the injector
export { run, REGISTRY_NAME };
